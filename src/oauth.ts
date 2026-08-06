/**
 * OAuth 2.1 layer for the Motion MCP worker.
 *
 * LOCAL FILE — not upstream. This is the fork's entire auth layer, per the
 * architectural rule in CLAUDE.local.md: auth lives in its own file that
 * wraps the MCP handler, and worker.ts is never touched. wrangler.toml's
 * `main` points here; this module re-exports the Durable Object class and
 * wraps `MotionMCPAgent.serve("/mcp")` in Cloudflare's workers-oauth-provider.
 *
 * What the provider handles itself: RFC 8414 + RFC 9728 metadata discovery,
 * Dynamic Client Registration (RFC 7591) at /register, token issue/refresh/
 * revocation at /token (S256 PKCE required for public clients, refresh
 * rotation on use), bearer-token validation in front of /mcp. Tokens and
 * client secrets are stored hashed in the OAUTH_KV namespace.
 *
 * What this file owns: the /authorize consent screen. Single user by design —
 * no user database, no roles. Consent is gated by a password compared in
 * constant time against MOTION_MCP_SECRET, which is no longer part of any
 * URL. The old secret-in-path route is gone: this module replaces worker.ts
 * as the entry point, and no path-secret check exists anywhere in it.
 */

import {
  OAuthProvider,
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { MotionMCPAgent } from "./worker";

// The Durable Object class must be exported from the wrangler entry module
// for the [durable_objects] binding to resolve.
export { MotionMCPAgent };

interface Env {
  MOTION_API_KEY: string;
  MOTION_MCP_SECRET: string;
  MOTION_MCP_TOOLS?: string;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** base64url without padding; input is an ASCII query string. */
function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  return atob(b64 + "=".repeat(pad));
}

/**
 * Constant-time password check. Both values are SHA-256 hashed first so the
 * compared buffers are equal length; the comparison then runs over every
 * byte regardless of where a mismatch occurs.
 */
async function passwordMatches(supplied: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(supplied)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) {
    diff |= (av[i] ?? 0) ^ (bv[i] ?? 0);
  }
  return diff === 0;
}

function healthResponse(): Response {
  return new Response(
    JSON.stringify({ status: "ok", server: "motion-mcp-server" }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// ---------------------------------------------------------------------------
// Consent screen
// ---------------------------------------------------------------------------

function consentPage(opts: {
  clientName: string;
  redirectUri: string;
  encodedQuery: string;
  errorMessage?: string;
}): Response {
  const error = opts.errorMessage
    ? `<p class="error">${escapeHtml(opts.errorMessage)}</p>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Motion MCP — authorize</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 26rem;
         margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.15rem; }
  .box { border: 1px solid #ddd; border-radius: 8px; padding: 1.25rem; }
  .meta { font-size: 0.85rem; color: #555; word-break: break-all; }
  input[type=password] { width: 100%; padding: 0.5rem; margin: 0.75rem 0;
         border: 1px solid #bbb; border-radius: 6px; box-sizing: border-box; }
  button { padding: 0.5rem 1.25rem; border: 0; border-radius: 6px;
         background: #1a1a1a; color: #fff; cursor: pointer; }
  .error { color: #b00020; font-size: 0.9rem; }
</style>
</head>
<body>
<div class="box">
  <h1>Authorize Motion MCP access</h1>
  <p class="meta">Client: <strong>${escapeHtml(opts.clientName)}</strong><br>
  Redirects to: ${escapeHtml(opts.redirectUri)}</p>
  ${error}
  <form method="post" action="/authorize">
    <input type="hidden" name="oauth_query" value="${escapeHtml(opts.encodedQuery)}">
    <label for="password">Consent password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" autofocus>
    <button type="submit">Approve</button>
  </form>
</div>
</body>
</html>`;
  return new Response(html, {
    status: opts.errorMessage ? 401 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** Render an AuthorizationError per the library's redirect rules. */
function authErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) {
    // Unknown client or unvalidated redirect URI — render locally, never redirect.
    return new Response(error.description, { status: 400 });
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Both GET (initial render) and POST (consent submission) re-run the
  // library's full request validation from the original query string, so
  // completeAuthorization never sees parameters the library did not vet.
  let rawQuery: string;
  let suppliedPassword: string | null = null;

  if (request.method === "POST") {
    const form = await request.formData();
    const encodedQuery = form.get("oauth_query");
    const password = form.get("password");
    if (typeof encodedQuery !== "string" || encodedQuery.length === 0) {
      return new Response("Malformed consent submission", { status: 400 });
    }
    try {
      rawQuery = b64urlDecode(encodedQuery);
    } catch {
      return new Response("Malformed consent submission", { status: 400 });
    }
    suppliedPassword = typeof password === "string" ? password : "";
  } else if (request.method === "GET") {
    rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  } else {
    return new Response("Method not allowed", { status: 405 });
  }

  const replay = new Request(`${url.origin}/authorize?${rawQuery}`, { method: "GET" });

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(replay);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return authErrorResponse(error);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    return new Response("Unknown OAuth client", { status: 400 });
  }
  const clientName = client.clientName || oauthRequest.clientId;
  const encodedQuery = b64urlEncode(rawQuery);

  if (request.method === "GET") {
    return consentPage({
      clientName,
      redirectUri: oauthRequest.redirectUri,
      encodedQuery,
    });
  }

  // POST: verify consent password before granting anything.
  const ok = await passwordMatches(suppliedPassword ?? "", env.MOTION_MCP_SECRET);
  if (!ok) {
    return consentPage({
      clientName,
      redirectUri: oauthRequest.redirectUri,
      encodedQuery,
      errorMessage: "Wrong password. Nothing was authorized.",
    });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: "barton",
    metadata: { clientName },
    scope: oauthRequest.scope,
    props: { userId: "barton" },
  });

  return Response.redirect(redirectTo, 302);
}

// ---------------------------------------------------------------------------
// Default handler — everything the provider does not own
// ---------------------------------------------------------------------------

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check, byte-compatible with the pre-OAuth worker (/health Check 9).
    if (url.pathname === "/" || url.pathname === "/health") {
      return healthResponse();
    }

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Provider — the exported worker
// ---------------------------------------------------------------------------

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  // MotionMCPAgent.serve returns an ExportedHandler-shaped object; the
  // provider validates the bearer token, then forwards the request with the
  // path intact, so serve("/mcp") matches exactly as it did pre-OAuth.
  apiHandler: MotionMCPAgent.serve("/mcp") as ExportedHandler<Env> &
    Pick<Required<ExportedHandler<Env>>, "fetch">,
  defaultHandler: defaultHandler as ExportedHandler<Env>,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
