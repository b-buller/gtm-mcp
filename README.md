# gtm-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Google Tag Manager**. Gives an LLM (Claude Desktop, opencode, Cursor, …) a set of tools to read and manage GTM accounts, containers, workspaces, tags, triggers, variables, versions, and more.

It is **discovery-driven**: the tools are generated at runtime from Google's live [GTM API v2 discovery document](https://tagmanager.googleapis.com/$discovery/rest?version=v2). There is no hand-written per-endpoint code, so the tool surface tracks the real API — paths, verbs, query params, request bodies, and OAuth scopes all come straight from Google.

## How it works

Every GTM resource becomes one tool named `gtm_<resource>` (e.g. `gtm_accounts`, `gtm_containers`, `gtm_workspaces`, `gtm_tags`, `gtm_triggers`, `gtm_variables`, `gtm_versions`, …). Each takes an `operation` argument (`list`, `get`, `create`, `update`, `delete`, `publish`, …) plus the path ids for the level you target:

```
gtm_tags { operation: "list",  accountId, containerId, workspaceId }
gtm_tags { operation: "get",   accountId, containerId, workspaceId, tagId }
gtm_tags { operation: "create",accountId, containerId, workspaceId, body: { …Tag JSON… } }
```

GTM nests `accounts > containers > workspaces > {tags, triggers, variables, …}`. Use the `list` operations top-down to discover ids you don't have.

## Requirements

- Node.js **18+** (uses the built-in global `fetch`)
- A Google account with access to the Tag Manager containers you want to manage

## Install

```bash
git clone <your-repo-url> gtm-mcp
cd gtm-mcp
npm install
```

## Authentication

You need a Google OAuth access token with Tag Manager scopes. Two modes — pick one.

### Mode 1 — Static access token (quickest)

Paste a short-lived token (valid ~1 hour). Good for trying it out.

```bash
export GTM_ACCESS_TOKEN="ya29...."
```

The fastest way to mint one: [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) → select the Tag Manager scopes → *Exchange authorization code for tokens* → copy the **access token**.

### Mode 2 — Refresh token (durable, recommended)

Set these three and the server auto-refreshes the access token as needed:

```bash
export GOOGLE_CLIENT_ID="xxxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="xxxx"
export GOOGLE_REFRESH_TOKEN="1//xxxx"
```

To mint a refresh token:

1. In [Google Cloud Console](https://console.cloud.google.com/) create an **OAuth 2.0 Client ID** (type: *Desktop app* or *Web*) and enable the **Tag Manager API**.
2. In the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground): gear icon → *Use your own OAuth credentials* → paste client id/secret.
3. Authorize the Tag Manager scopes you need, then *Exchange authorization code for tokens* and copy the **refresh token**.

### Scopes

Grant only what you need:

| Access | Scope |
|--------|-------|
| Read   | `https://www.googleapis.com/auth/tagmanager.readonly` |
| Edit   | `https://www.googleapis.com/auth/tagmanager.edit.containers` |
| Publish| `https://www.googleapis.com/auth/tagmanager.publish` |
| Delete | `https://www.googleapis.com/auth/tagmanager.delete.containers` |

## Guardrails (safety)

Defaults are **read-only**. Mutations are opt-in via environment variables, and destructive/irreversible operations additionally require `confirm: true` on the individual tool call.

| Env var | Enables | Default |
|---------|---------|---------|
| `GTM_MCP_ENABLE_WRITES=true`  | create / update | off |
| `GTM_MCP_ENABLE_DELETES=true` | delete | off |
| `GTM_MCP_ENABLE_PUBLISH=true` | publish container versions | off |

`delete`, `publish`, and high-impact verbs (`combine`, `move_tag_id`, `set_latest`, `undelete`, `reauthorize`, `resolve_conflict`) always require `confirm: true` even when their category is enabled.

## Use it with an MCP client

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "gtm": {
      "command": "node",
      "args": ["/absolute/path/to/gtm-mcp/src/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "xxxx.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "xxxx",
        "GOOGLE_REFRESH_TOKEN": "1//xxxx",
        "GTM_MCP_ENABLE_WRITES": "true"
      }
    }
  }
}
```

### opencode

`opencode.json` / `opencode.jsonc`:

```json
{
  "mcp": {
    "gtm": {
      "type": "local",
      "command": ["node", "/absolute/path/to/gtm-mcp/src/index.js"],
      "environment": {
        "GOOGLE_CLIENT_ID": "xxxx.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "xxxx",
        "GOOGLE_REFRESH_TOKEN": "1//xxxx"
      },
      "enabled": true
    }
  }
}
```

## Programmatic use

The engine is dependency-free and transport-agnostic. Import it and supply your own token resolver:

```js
import { buildTools, callTool } from 'gtm-mcp';

const getAccessToken = async (email) => "ya29...."; // however you store tokens

const tools = await buildTools();
const result = await callTool(getAccessToken, 'gtm_accounts', { operation: 'list' }, {
  enableWrites: true,
});
```

`getAccessToken(email)` receives the per-call `email` (or the configured default) so you can key tokens per connected account if you want multi-account support.

## Development

```bash
npm test        # offline unit tests (fetch + token provider are stubbed)
npm start       # run the stdio server
```

## License

[MIT](./LICENSE)
