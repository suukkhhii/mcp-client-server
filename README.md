# ServiceNow MCP Bridge (stdio -> HTTP)

Production-ready local MCP bridge for VS Code/Copilot.

- Exposes an MCP server over stdio locally.
- Connects to ServiceNow MCP over HTTP.
- Uses OAuth client credentials.
- Proxies:
  - `initialize`
  - `tools/list`
  - `tools/call`

## 1) Prerequisites

- Node.js 20+
- npm 10+
- ServiceNow OAuth client credentials with access to your MCP server endpoint

## 2) Install

```bash
npm install
```

## 3) Configure environment

Copy `.env.example` to `.env` and set real values:

```bash
cp .env.example .env
```

Required:

- `SN_INSTANCE_URL`
- `SN_MCP_URL`
- `SN_AUTH_MODE` (`oauth` or `basic`, default `oauth`)

If `SN_AUTH_MODE=oauth`:

- `SN_OAUTH_TOKEN_URL`
- `SN_CLIENT_ID`
- `SN_CLIENT_SECRET`

If `SN_AUTH_MODE=basic`:

- `SN_BASIC_USERNAME`
- `SN_BASIC_PASSWORD`

Optional:

- `SN_OAUTH_SCOPE`
- `LOG_LEVEL` (default: `info`)
- `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (for corporate proxy networks)

## 4) Build

```bash
npm run build
```

## 5) Run bridge (stdio MCP server)

Development mode:

```bash
npm run dev
```

Production mode:

```bash
npm run build
npm run start
```

## 6) Smoke test

This verifies:

1. OAuth token retrieval
2. `initialize` call to ServiceNow MCP
3. `tools/list` and tool name output

```bash
npm run test:smoke
```

For temporary connectivity-only checks (if your instance allows basic auth):

- set `SN_AUTH_MODE=basic`
- set `SN_BASIC_USERNAME` and `SN_BASIC_PASSWORD`
- run `npm run test:smoke`

## 7) VS Code Copilot Chat MCP config

Add the local bridge as an MCP server in your VS Code settings.

Example `settings.json`:

```json
{
  "chat.mcp.servers": {
    "servicenow-local-bridge": {
      "command": "node",
      "args": [
        "${workspaceFolder}/dist/index.js"
      ],
      "env": {
        "SN_INSTANCE_URL": "https://your-instance.service-now.com",
        "SN_MCP_URL": "https://your-instance.service-now.com/sncapps/mcp-server/mcp/sn_mcp_server_default",
        "SN_OAUTH_TOKEN_URL": "https://your-instance.service-now.com/oauth_token.do",
        "SN_CLIENT_ID": "<your-client-id>",
        "SN_CLIENT_SECRET": "<your-client-secret>",
        "SN_OAUTH_SCOPE": ""
      }
    }
  }
}
```

Then reload VS Code and select `servicenow-local-bridge` in Copilot Chat MCP server selection.

> If your VS Code version uses a different MCP settings key, keep the same server object and move it to the MCP setting key expected by your build.

## 8) Security and operational notes

- No secrets are hardcoded.
- `.env` is ignored by git.
- Logs redact `client_secret`, bearer auth header, and token fields.
- Startup fails fast when required env vars are missing/invalid.
- OAuth token refresh uses a 60-second pre-expiry buffer.
- On MCP HTTP `401`, the bridge refreshes token and retries once.
- MCP payload shape fallback is included to adapt to endpoint-specific request expectations.

## 9) If you are behind a corporate proxy

Set in `.env`:

- `HTTPS_PROXY` (recommended for HTTPS endpoints)
- `HTTP_PROXY` (optional)
- `NO_PROXY` (optional bypass list)

Example:

```dotenv
HTTPS_PROXY=http://proxy.company.local:8080
HTTP_PROXY=http://proxy.company.local:8080
NO_PROXY=localhost,127.0.0.1
```

For local loopback proxies (like `localhost:9000`):

```dotenv
HTTPS_PROXY=http://localhost:9000
HTTP_PROXY=http://localhost:9000
NO_PROXY=localhost,127.0.0.1
```

### 9.1) PowerShell session proxy commands (Windows)

Use these commands when running tests manually in a terminal session:

```powershell
$env:NODE_USE_ENV_PROXY = "1"
$env:NODE_OPTIONS = "--use-env-proxy"
$env:HTTP_PROXY = "http://localhost:9000"
$env:HTTPS_PROXY = "http://localhost:9000"
$env:NO_PROXY = "localhost,127.0.0.1"
```

Then run:

```powershell
npm run test:smoke
```

### 9.2) Verify proxy listener

```powershell
Test-NetConnection localhost -Port 9000
```

Expected:

- `TcpTestSucceeded : True`

### 9.3) Git over proxy (if push/pull fails)

Configure Git for the current repository:

```powershell
git config http.proxy "http://localhost:9000"
git config https.proxy "http://localhost:9000"
```

Push example:

```powershell
git push -u origin main
```

Clear Git proxy config later if not needed:

```powershell
git config --unset http.proxy
git config --unset https.proxy
```

### 9.4) Proxy troubleshooting checklist

1. Confirm proxy process is running on expected port.
2. Confirm `HTTPS_PROXY` is set (most ServiceNow calls are HTTPS).
3. Confirm `NO_PROXY` includes only local bypass hosts.
4. Re-run `npm run test:smoke` and verify token acquisition succeeds.
5. If `git push` fails with DNS/host resolution, set Git proxy as above.

## 10) Using MCPorter from terminal

This project can be used with MCPorter CLI directly.

### 10.1) MCPorter config in this repo

Use workspace-root `.mcp.json` for MCPorter:

- server name: `servicenow-local-bridge`
- command: `node`
- args: absolute path to `dist/index.js`

Note:

- MCPorter does not resolve VS Code placeholders like `${workspaceFolder}`.
- Keep real credentials in environment variables (or `.env` loaded into shell before running).

### 10.2) Typical PowerShell session setup

```powershell
$env:NODE_USE_ENV_PROXY = "1"
$env:NODE_OPTIONS = "--use-env-proxy"

$env:SN_INSTANCE_URL = "https://your-instance.service-now.com"
$env:SN_MCP_URL = "https://your-instance.service-now.com/sncapps/mcp-server/mcp/sn_mcp_server_default"
$env:SN_OAUTH_TOKEN_URL = "https://your-instance.service-now.com/oauth_token.do"
$env:SN_CLIENT_ID = "<your-client-id>"
$env:SN_CLIENT_SECRET = "<your-client-secret>"
$env:SN_AUTH_MODE = "oauth"

$env:HTTPS_PROXY = "http://localhost:9000"
$env:HTTP_PROXY = "http://localhost:9000"
$env:NO_PROXY = "localhost,127.0.0.1"
```

### 10.3) List tools

```powershell
npx --yes mcporter --config ".\.mcp.json" list servicenow-local-bridge --schema --timeout 120000
```

### 10.4) Call tools

Fetch one incident:

```powershell
npx --yes mcporter --config ".\.mcp.json" call servicenow-local-bridge.look_up_incident_records limit=1
```

Summarize a specific incident:

```powershell
$env:MCPORTER_CALL_TIMEOUT = "180000"
npx --yes mcporter --config ".\.mcp.json" call servicenow-local-bridge.incident_summarization incidentNumber=INC1234567 --timeout 180000
```

Why larger timeout?

- `incident_summarization` can take longer in ServiceNow, so increase call timeout to avoid false failures.

## 11) Natural-language prompt router (auto tool selection)

If you want prompts like:

- `please help me with incident details INC12345`

you can use the built-in prompt router script.

### 11.1) Run with a prompt

```powershell
npm run prompt -- "please help me with incident details INC1639945"
```

Behavior:

- If an incident number like `INC12345` is found, router calls:
  - `incident_summarization`
- If no incident number is found, router calls:
  - `look_up_incident_records` (default `limit=5`)
  - and applies simple status/priority parsing from prompt text.

Examples:

```powershell
npm run prompt -- "show top 3 high priority open incidents"
npm run prompt -- "please help me with incident details INC1639945"
```

### 11.2) Requirements

- Environment variables must be set in current shell (same as MCPorter commands).
- `.mcp.json` must point to your local `dist/index.js`.

### 11.3) Performance optimizations in prompt mode

Prompt mode now includes local latency optimizations:

- In-memory response cache:
  - lookup results TTL default: `60s`
  - summarization results TTL default: `10m`
  - persisted to `.cache/prompt-cache.json` so repeated `npm run prompt` calls can reuse warm results
- Timing metrics in response envelope:
  - `metrics.totalMs`, `metrics.routeMs`, `metrics.toolCallMs`
  - `metrics.cacheHit`, `metrics.fallbackUsed`
- Slow summarization warning when soft threshold is exceeded.
- Summarization fallback:
  - if `incident_summarization` fails, router falls back to `look_up_incident_records` for the same incident.

Optional environment overrides:

```dotenv
PROMPT_CACHE_LOOKUP_TTL_MS=60000
PROMPT_CACHE_SUMMARY_TTL_MS=600000
PROMPT_SUMMARY_SOFT_TIMEOUT_MS=30000
```

## 12) Separated Agent Logic (router + orchestrator)

Prompt handling logic is separated from MCP bridge code under:

- `src/agent/config`
- `src/agent/router`
- `src/agent/orchestrator`
- `src/agent/types`

Design:

1. Router maps prompt -> tool selection + args + confidence
2. Orchestrator executes MCPorter call
3. Response is normalized into an envelope with insights and warnings

Run:

```powershell
npm run prompt -- "please help me with incident details INC1639945"
```

Output:

- JSON envelope containing selected intent, tool invocation details, normalized result, and insight bullets.