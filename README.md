![NPM Version](https://img.shields.io/npm/v/motionmcp)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# Motion MCP Server

[Motion](https://www.usemotion.com/) is an AI-powered calendar and task management app that auto-schedules your work. This MCP server bridges Motion's API with LLMs like Claude and ChatGPT via the [Model Context Protocol](https://modelcontextprotocol.io/docs/), so you can manage tasks, search projects, check your schedule, and more — all through natural conversation. It works on desktop, web, and mobile.

## Preview

<a href="sample.png"><img src="sample.png" alt="Motion MCP Server Preview" width="400" /></a>

*Click the image above to view full size*

## Getting Started

**Prerequisites:** Node.js 20+ and a [Motion API key](https://app.usemotion.com/settings/api).

### Local Setup (npx)

For desktop MCP clients — Claude Desktop, Claude Code, Cursor, and similar.

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "motion": {
      "command": "npx",
      "args": ["motionmcp"],
      "env": {
        "MOTION_API_KEY": "your_api_key"
      }
    }
  }
}
```

Test from the command line:

```bash
MOTION_API_KEY=your_api_key npx motionmcp
```

> **Tip:** `npx` always runs the latest published version — no install needed.

### Remote Setup (Cloudflare Workers)

> **Note (this fork):** the shared-secret auth documented below is upstream's design. This fork replaces it with OAuth 2.1 — see [Fork notes](#fork-notes) at the bottom.

For mobile and web clients — Claude mobile/web, ChatGPT mobile/web, or any HTTP MCP client.

#### One-click deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/devondragon/MotionMCP)

After deploy, set your secrets in the Cloudflare dashboard (Workers > your worker > Settings > Variables):
- `MOTION_API_KEY` — your Motion API key
- `MOTION_MCP_SECRET` — a random string (generate with `openssl rand -hex 16`)

#### Manual deploy

```bash
# Set secrets
npx wrangler secret put MOTION_API_KEY
npx wrangler secret put MOTION_MCP_SECRET   # use: openssl rand -hex 16

# Deploy
npm run worker:deploy
```

Your MCP URL will be:
```
https://motion-mcp-server.YOUR_SUBDOMAIN.workers.dev/mcp/YOUR_SECRET
```

Use exactly that address. The secret goes at the end of the path and nothing follows it. The server speaks MCP Streamable HTTP on that single endpoint; do not append `/sse` or any other sub-path.

Clients that can send headers can keep the secret out of the URL instead: point them at `https://motion-mcp-server.YOUR_SUBDOMAIN.workers.dev/mcp` and send `Authorization: Bearer YOUR_SECRET`.

#### Connecting from Claude

1. Go to [claude.ai](https://claude.ai) > Settings > Connectors
2. Add your MCP URL
3. The server syncs automatically to the Claude mobile app

For Claude Code, use the Streamable HTTP transport:

```bash
claude mcp add --transport http motion https://motion-mcp-server.YOUR_SUBDOMAIN.workers.dev/mcp --header "Authorization: Bearer YOUR_SECRET"
```

In Claude Desktop, add the same URL as a remote server of type `http` (not `sse`).

#### Connecting from ChatGPT

1. Go to ChatGPT Settings > Connectors
2. Add your MCP URL

> **Security:** The secret in the URL prevents casual discovery. Treat the full URL like a password — don't share it publicly.

> **Transport:** Only Streamable HTTP is served. The older HTTP+SSE transport (a `GET` stream plus a `/message` endpoint) was retired in the move to a stateless server; a client configured with transport type `sse` must be switched to `http`.

Tool configuration works the same as the local server. Set `MOTION_MCP_TOOLS` in `wrangler.toml` under `[vars]`, or override via `wrangler secret put MOTION_MCP_TOOLS`.

For local Worker development, see [DEVELOPER.md](./DEVELOPER.md).

### API Key

The server reads your Motion API key from the `MOTION_API_KEY` environment variable.

**Inline (npx):**
```bash
MOTION_API_KEY=your-key npx motionmcp
```

**`.env` file (when running from source via npm):**
```bash
MOTION_API_KEY=your-key
```

> When using `npx`, prefer the inline environment variable since `npx` won't read a local `.env` file.

## Tool Configuration

All 10 tools are enabled by default. If you run multiple MCP servers and want to reduce tool selection noise, you can limit which tools are exposed via the `MOTION_MCP_TOOLS` environment variable:

| Level | Tools | Description |
|---|---|---|
| **minimal** | 3 | Tasks, projects, workspaces only |
| **essential** | 8 | Adds users, search, comments, schedules, statuses |
| **complete** (default) | 10 | Full API access including custom fields and recurring tasks |
| **custom** | varies | Pick exactly the tools you need |

Custom example:
```bash
MOTION_MCP_TOOLS=custom:motion_tasks,motion_projects,motion_search npx motionmcp
```

## Tools Reference

### motion_tasks
**Operations:** `create`, `list`, `list_all_uncompleted`, `get`, `update`, `delete`, `move`, `unassign`

The primary tool for task management. Supports all Motion API parameters including `name`, `description`, `priority`, `dueDate`, `duration`, `labels`, `assigneeId`, and `autoScheduled`. You can reference workspaces and projects by name — the server resolves them automatically.

`list_all_uncompleted` spans every workspace in one call (it ignores `workspaceId`/`workspaceName`) and honors the `dueDate` and `priority` filters, so "what's due this week across all my workspaces?" resolves directly. On `list`, `dueDate` is an inclusive on-or-before-day bound that includes overdue tasks (so `dueDate: "today"` answers "what's due today?"), and `completedAfter` / `completedBefore` bound by completion date in your account's time zone for "what did I get done this week?". Dates are interpreted in your Motion account's time zone, and list responses lead with a header naming that zone and today's local date.

```json
{
  "operation": "create",
  "name": "Complete API integration",
  "workspaceName": "Development",
  "projectName": "Release Cycle Q2",
  "dueDate": "2025-06-15T09:00:00Z",
  "priority": "HIGH",
  "labels": ["api", "release"]
}
```

### motion_projects
**Operations:** `create`, `list`, `get`

Manage Motion projects. Workspace and project names are fuzzy-matched, and the server auto-selects your "Personal" workspace if none is specified.

```json
{"operation": "create", "name": "New Project", "workspaceName": "Personal"}
```

### motion_workspaces
**Operations:** `list`, `get`

List and inspect workspaces.

### motion_users
**Operations:** `list`, `current`

List users in a workspace or get the current authenticated user.

### motion_search
**Operations:** `content`

Search tasks and projects by query across a workspace.

```json
{"operation": "content", "query": "API integration", "workspaceName": "Development"}
```

### motion_comments
**Operations:** `list`, `create`

Read and add comments on tasks and projects.

```json
{"operation": "create", "taskId": "task_123", "content": "Updated the API endpoints as discussed"}
```

### motion_schedules
**Operations:** `list`

Retrieve user schedules, showing each day's working hours (start-end per day) and time zones. These are recurring working-hour templates only — they do not expose actual calendar events or meetings, so they cannot by themselves show a true free/busy picture; combine with tasks' `scheduledStart`/`scheduledEnd` to see what Motion has auto-booked.

### motion_custom_fields
**Operations:** `list`, `create`, `delete`, `add_to_project`, `remove_from_project`, `add_to_task`, `remove_from_task`

Define and manage custom fields across workspaces, projects, and tasks.

```json
{
  "operation": "create",
  "name": "Sprint",
  "type": "DROPDOWN",
  "options": ["Sprint 1", "Sprint 2", "Sprint 3"],
  "workspaceName": "Development"
}
```

### motion_recurring_tasks
**Operations:** `list`, `create`, `delete`

Manage recurring task templates.

```json
{
  "operation": "create",
  "name": "Weekly Team Standup",
  "recurrence": "WEEKLY",
  "projectName": "Team Meetings",
  "daysOfWeek": ["MONDAY", "WEDNESDAY", "FRIDAY"],
  "duration": 30
}
```

### motion_statuses
**Operations:** `list`

List available statuses for a workspace.

## Advanced Configuration

**Minimal setup (3 tools only):**
```json
{
  "mcpServers": {
    "motion": {
      "command": "npx",
      "args": ["motionmcp"],
      "env": {
        "MOTION_API_KEY": "your_api_key",
        "MOTION_MCP_TOOLS": "minimal"
      }
    }
  }
}
```

**Custom tools selection:**
```json
{
  "mcpServers": {
    "motion": {
      "command": "npx",
      "args": ["motionmcp"],
      "env": {
        "MOTION_API_KEY": "your_api_key",
        "MOTION_MCP_TOOLS": "custom:motion_tasks,motion_projects,motion_search"
      }
    }
  }
}
```

**Using your local workspace (npm):**
```json
{
  "mcpServers": {
    "motion": {
      "command": "npm",
      "args": ["run", "mcp:dev"],
      "cwd": "/absolute/path/to/your/MotionMCP",
      "env": {
        "MOTION_API_KEY": "your_api_key"
      }
    }
  }
}
```

See the full developer setup in [DEVELOPER.md](./DEVELOPER.md).

## Debugging

- Logs output to `stderr` in JSON format
- Check for missing keys, workspace/project names, and permissions
- Use `motion_workspaces` (list) and `motion_projects` (list) to validate IDs

```json
{
  "level": "info",
  "msg": "Task created successfully",
  "method": "createTask",
  "taskId": "task_789",
  "workspace": "Development"
}
```

## License

Apache-2.0 License

---

For more information, see the full [Motion API docs](https://docs.usemotion.com/) or [Model Context Protocol docs](https://modelcontextprotocol.io/docs/).
## Fork notes

**Base:** upstream devondragon/MotionMCP tag `v2.10.0` (commit `d075c1b`, 24 Sep 2026), adopted Nov 2026. Earlier base: `c79dea5f` (2.8.0). Do not auto-update. Upstream releases are reviewed and adopted deliberately, never auto-merged.

**Divergences from upstream:**

1. **OAuth 2.1 replaces upstream's shared-secret auth.** The whole auth layer is one added file, `src/oauth.ts`, the Wrangler entry point. It wraps upstream's stateless MCP handler (`mcpTransport` in `worker.ts`) with [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): Dynamic Client Registration at `/register`, a single-user consent screen at `/authorize` gated by the `MOTION_MCP_SECRET` password, token issue and refresh at `/token` (S256 PKCE, refresh rotation), tokens stored hashed in KV (`OAUTH_KV`). The MCP endpoint is plain `/mcp` behind bearer auth; upstream's `/mcp/SECRET` path and static Bearer secret are not reachable, because `worker.ts`'s default export is not the entry point. Motivation: a secret in a URL is shown by any client that renders connector details (one exposure, Aug 2026), and a static secret never expires.
   - **Sign-in lifetime:** `refreshTokenTTL` is 180 days (library default 30, counted from sign-in and never extended by refresh), and dynamically registered clients do not expire (library default 90 days). Changed Nov 2026 so connectors stop asking to sign in again every month. Applies to sign-ins made after the change.
2. **Tool tier:** `MOTION_MCP_TOOLS = "complete"` (all 10 tools); upstream's `wrangler.toml` defaults to `essential`.
3. **Observability:** `[observability]` enabled with `head_sampling_rate = 1`, so every request is logged and a write's outcome can be checked after a client disconnect.
4. **Recurring-task create follows what Motion's API accepts, and a 400 carries Motion's own reason** (Nov 2026). `POST /recurring-tasks` rejects `projectId` ("property projectId should not exist") and a 24-hour `idealTime` (it wants `h:mm am|pm`, minutes 00 or 30), although Motion's docs and the upstream tool schema say otherwise. The handler no longer forwards `projectId` and says so in the response, converts a 24-hour `idealTime`, and rejects a value Motion cannot accept before calling the API. Separately, `buildUserMessage` appends Motion's `message` (string or array) to 400 and 422 errors for every tool. Not in upstream as of v2.10.0; a candidate to offer upstream.
5. **Durable Object retirement was staged, and is now complete** (Nov 2026). Upstream's v2.10.0 `wrangler.toml` deletes the `MotionMCPAgent` class (migration tag `v2`). This fork first deployed v2.10.0 without that migration (18 Nov 2026, versions `57701983` and `3e4b4547`), keeping the binding and a stub class so a rollback to the pre-upgrade version stayed possible. The class, its `MCP_OBJECT` binding and the stub were deleted in a separate deploy on 21 Nov 2026 (Deploy B, version `44d96414`, from commit `5808968`), which adds the `v2` migration. That version is a rollback floor: Cloudflare refuses a rollback across a Durable Object class deletion, so no earlier version can be restored.

Divergences retired by this upgrade, now in upstream: the timestamp fix (fork `566d4cb`, upstream `451ddb6`), streamable-HTTP transport, AJV removal from the Worker path, and the `new_sqlite_classes` migration.

