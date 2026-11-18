/**
 * FORK: tests for src/oauth.ts, the Wrangler entry point (divergence 1).
 *
 * Runs inside workerd with the wrangler.toml bindings, including a local
 * OAUTH_KV. Walks the full flow a Claude connector uses: discovery, Dynamic
 * Client Registration, the password-gated consent screen, the PKCE code
 * exchange, a refresh, and an authorized MCP tools/list. Also pins that no
 * upstream shared-secret route is reachable through this entry point, and the
 * sign-in lifetime settings that stop monthly re-authentication.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import oauthWorker from "../../src/oauth";

const PASSWORD = "test-worker-secret";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const ORIGIN = "https://example.com";
const DAY = 24 * 60 * 60;

const JSON_RPC_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function call(request: Request, overrideEnv: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await (oauthWorker as unknown as ExportedHandler<Record<string, unknown>>).fetch!(
    request as Request<unknown, IncomingRequestCfProperties>,
    { ...(env as unknown as Record<string, unknown>), ...overrideEnv },
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function readJsonRpc(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)));
  }
  return [JSON.parse(text)];
}

async function register(): Promise<{ clientId: string; body: Record<string, unknown> }> {
  const response = await call(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as Record<string, unknown>;
  return { clientId: body.client_id as string, body };
}

function authorizeQuery(clientId: string, challenge: string): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
  }).toString();
}

function consentForm(page: string): string {
  const match = page.match(/name="oauth_query" value="([^"]+)"/);
  expect(match).not.toBeNull();
  return match![1]!;
}

async function signIn(): Promise<{ clientId: string; tokens: Record<string, unknown> }> {
  const { clientId } = await register();
  const { verifier, challenge } = await pkcePair();
  const page = await call(new Request(`${ORIGIN}/authorize?${authorizeQuery(clientId, challenge)}`));
  expect(page.status).toBe(200);
  const form = new FormData();
  form.set("oauth_query", consentForm(await page.text()));
  form.set("password", PASSWORD);
  const approved = await call(new Request(`${ORIGIN}/authorize`, { method: "POST", body: form }));
  expect(approved.status).toBe(302);
  const redirect = new URL(approved.headers.get("Location")!);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
  expect(redirect.searchParams.get("state")).toBe("state-123");
  const code = redirect.searchParams.get("code")!;
  const tokenResponse = await call(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
  );
  expect(tokenResponse.status).toBe(200);
  return { clientId, tokens: (await tokenResponse.json()) as Record<string, unknown> };
}

async function listTools(accessToken: string): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { ...JSON_RPC_HEADERS, Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
  );
}

describe("oauth entry point", () => {
  it("serves the health check without authentication", async () => {
    for (const path of ["/", "/health"]) {
      const response = await call(new Request(`${ORIGIN}${path}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", server: "motion-mcp-server" });
    }
  });

  it("publishes OAuth discovery metadata", async () => {
    const response = await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(response.status).toBe(200);
    const meta = (await response.json()) as Record<string, unknown>;
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/register`);
  });

  it("rejects /mcp without a token, with a bearer challenge", async () => {
    const response = await call(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: JSON_RPC_HEADERS, body: "{}" })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate") ?? "").toMatch(/Bearer/);
  });

  it("does not accept upstream's shared secret as a Bearer token", async () => {
    const response = await listTools(PASSWORD);
    expect(response.status).toBe(401);
  });

  it("does not serve upstream's secret-in-path route", async () => {
    const response = await call(
      new Request(`${ORIGIN}/mcp/${PASSWORD}`, {
        method: "POST",
        headers: JSON_RPC_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    expect([401, 404]).toContain(response.status);
  });

  it("refuses consent with the wrong password and grants nothing", async () => {
    const { clientId } = await register();
    const { challenge } = await pkcePair();
    const page = await call(new Request(`${ORIGIN}/authorize?${authorizeQuery(clientId, challenge)}`));
    const form = new FormData();
    form.set("oauth_query", consentForm(await page.text()));
    form.set("password", "wrong");
    const response = await call(new Request(`${ORIGIN}/authorize`, { method: "POST", body: form }));
    expect(response.status).toBe(401);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("completes sign-in and serves the complete 10-tool tier to the token holder", async () => {
    const { tokens } = await signIn();
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");

    // vitest.config.mts pins upstream's tier for upstream's tests; production
    // (wrangler.toml [vars]) is complete, which is what this asserts.
    const response = await call(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { ...JSON_RPC_HEADERS, Authorization: `Bearer ${tokens.access_token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      { MOTION_MCP_TOOLS: "complete" }
    );
    expect(response.status).toBe(200);
    const [message] = await readJsonRpc(response);
    const names = ((message?.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();
    expect(names).toEqual([
      "motion_comments",
      "motion_custom_fields",
      "motion_projects",
      "motion_recurring_tasks",
      "motion_schedules",
      "motion_search",
      "motion_statuses",
      "motion_tasks",
      "motion_users",
      "motion_workspaces",
    ]);
  });

  it("keeps a sign-in for 180 days, and refresh keeps working", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { clientId, tokens } = await signIn();
    const [userId, grantId] = (tokens.refresh_token as string).split(":");
    const grant = (await (env as unknown as { OAUTH_KV: KVNamespace }).OAUTH_KV.get(
      `grant:${userId}:${grantId}`,
      { type: "json" }
    )) as { expiresAt?: number };
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + 180 * DAY);
    expect(grant.expiresAt).toBeLessThanOrEqual(before + 180 * DAY + 60);

    const refreshed = await call(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token as string,
          client_id: clientId,
        }).toString(),
      })
    );
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Record<string, unknown>;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await listTools(next.access_token as string)).status).toBe(200);
  });

  it("registers clients that do not expire", async () => {
    const { body } = await register();
    expect(body.client_secret_expires_at ?? 0).toBe(0);
  });
});
