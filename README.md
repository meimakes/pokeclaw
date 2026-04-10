# pokeclaw

An MCP server (SSE transport) that lets any MCP client spawn and control [Codex CLI](https://github.com/openai/codex) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions on the host machine.

## Features

### Session management
- **session_start** — Spawn a Codex or Claude Code session in any directory
- **session_send** — Send messages to a running session's stdin
- **session_output** — Read buffered output with offset-based pagination (includes session status)
- **session_wait** — Block until a session produces new output or exits
- **session_list** — List all active sessions with status
- **session_kill** — Terminate a session (SIGTERM, then SIGKILL after 5s)

### Filesystem access
- **read_file** — Read file contents (with line offset/limit pagination)
- **list_directory** — Browse directories (recursive up to depth 3)

### Infrastructure
- Real-time streaming output via `--output-format stream-json`
- Ring buffer (last 10,000 lines) per session
- Auto-kill sessions after configurable idle timeout (default 30 min)
- Bearer token authentication on all endpoints
- Filesystem sandboxed to `WORKSPACE_DIR` and active session directories
- Env var whitelisting for child processes (AUTH_TOKEN never leaks)
- Per-IP rate limiting and SSE connection caps
- Graceful shutdown with SIGTERM/SIGINT handling

## Deploy to Fly.io

If you'd rather run pokeclaw in the cloud instead of locally, you can deploy to [Fly.io](https://fly.io) in a few minutes.

### Prerequisites

- A [Fly.io account](https://fly.io/app/sign-up) (free tier works)
- [`flyctl` CLI](https://fly.io/docs/flyctl/install/) installed

### Quick start

```bash
# Clone and enter the repo
git clone https://github.com/meimakes/pokeclaw.git
cd pokeclaw

# Launch on Fly (creates the app + a persistent volume for /workspace)
fly launch --copy-config --yes

# Set your auth token (clients use this to connect)
fly secrets set AUTH_TOKEN=<pick-a-secret>

# Forward API keys for the agents you plan to use
# If using API keys instead of OAuth, forward them to child processes
fly secrets set CHILD_ENV_OPENAI_API_KEY=<your-openai-key>      # optional, for Codex
fly secrets set CHILD_ENV_ANTHROPIC_API_KEY=<your-anthropic-key> # optional, for Claude Code

# Deploy
fly deploy
```

Your server will be available at `https://<app-name>.fly.dev`. Point your MCP client at:

```json
{
  "mcpServers": {
    "coding-agent": {
      "url": "https://<app-name>.fly.dev/sse",
      "headers": {
        "Authorization": "Bearer <your-AUTH_TOKEN>"
      }
    }
  }
}
```

### Notes

- **Persistent storage**: The `fly.toml` mounts a volume at `/workspace` so session data survives restarts. Fly creates the volume automatically on first deploy.
- **Region**: Defaults to `sjc` (San Jose). Change `primary_region` in `fly.toml` or pass `--region` to `fly launch`.
- **Scaling**: This is a stateful, single-instance service. The config uses `auto_stop_machines = "suspend"` to save costs when idle, and `auto_start_machines = true` to wake on incoming requests.
- **Agent CLIs**: The Dockerfile installs both `@anthropic-ai/claude-code` and `@openai/codex` globally. Sessions use `CHILD_ENV_*` secrets as API keys — `AUTH_TOKEN` is never forwarded to child processes.

## Local Setup

### Prerequisites

- Node.js 20+
- [`codex` CLI](https://github.com/openai/codex) installed globally (for Codex sessions): `npm install -g @openai/codex`
- [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code/getting-started) installed globally (for Claude Code sessions): `npm install -g @anthropic-ai/claude-code`

Only the agent(s) you plan to use need to be installed. Both require OAuth login (`claude login` / `codex login`).

### Build

```bash
git clone https://github.com/meimakes/pokeclaw.git
cd pokeclaw
npm install
npm run build
```

### Configuration

Set environment variables (or copy `.env.example` to `.env`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_TOKEN` | Yes | — | Bearer token for client authentication |
| `PORT` | No | `3500` | HTTP server port |
| `WORKSPACE_DIR` | No | `cwd()` | Base directory for sessions; filesystem tools are sandboxed here |
| `IDLE_TIMEOUT` | No | `1800000` | Session idle timeout in ms (30 min) |
| `MAX_SSE_CONNECTIONS` | No | `50` | Max concurrent SSE connections |
| `SSE_IDLE_TIMEOUT` | No | `300000` | Idle SSE connection eviction timeout in ms (5 min) |
| `RATE_LIMIT_RPM` | No | `120` | Max requests per minute per IP on POST /messages |
| `CHILD_ENV_*` | No | — | Extra env vars forwarded to child processes (prefix stripped) |

### Running

```bash
# Production
AUTH_TOKEN=my-secret npm start

# Development (with hot reload via tsx)
AUTH_TOKEN=my-secret npm run dev
```

### MCP Client Configuration

Add to your MCP client config:

```json
{
  "mcpServers": {
    "coding-agent": {
      "url": "http://localhost:3500/sse",
      "headers": {
        "Authorization": "Bearer my-secret"
      }
    }
  }
}
```

## Tools

### session_start

Spawn a new coding agent session.

```json
{
  "agent": "codex",
  "cwd": "/path/to/project",
  "task": "Fix the failing tests in src/utils.ts"
}
```

- **codex**: Launches `codex --yolo exec '<task>'` with PTY. Auto-runs `git init` if needed.
- **claude-code**: Launches `claude --print --verbose --output-format stream-json --dangerously-skip-permissions '<task>'`.

Returns session info including `initialOutput` captured during the first 1.5s of startup.

### session_send

Send a message to a running session's stdin (Codex PTY sessions only; no-op for Claude Code `--print` sessions).

```json
{
  "sessionId": "uuid-here",
  "message": "Now also add tests for the edge cases"
}
```

### session_output

Get buffered output from a session. Response includes `status` and `exitCode`.

```json
{
  "sessionId": "uuid-here",
  "since": 150
}
```

### session_wait

Block until a session produces new output or exits. Useful for avoiding blind polling.

```json
{
  "sessionId": "uuid-here",
  "since": 150,
  "timeoutMs": 60000
}
```

### session_list

List all sessions with their current status.

### session_kill

Kill a session by ID. Sends SIGTERM, then SIGKILL after 5 seconds.

### read_file

Read a file on the host. Path must be inside `WORKSPACE_DIR` or an active session's working directory.

```json
{
  "path": "/workspace/project/src/index.ts",
  "maxLines": 100,
  "offset": 0
}
```

### list_directory

List files and directories. Same path restrictions as `read_file`.

```json
{
  "path": "/workspace/project/src",
  "recursive": true
}
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sse` | Yes | SSE connection for MCP transport |
| POST | `/messages` | Yes | JSON-RPC message handling (rate limited) |
| GET | `/health` | No* | Health check (*session count requires auth) |

## Security

- **Authentication**: Bearer token required on all MCP endpoints
- **Filesystem sandboxing**: `read_file` and `list_directory` are restricted to `WORKSPACE_DIR` and active session working directories. Symlinks are resolved before access checks to prevent escapes.
- **Env var isolation**: Only whitelisted environment variables are forwarded to child processes. `AUTH_TOKEN` and other server credentials are never exposed. Use `CHILD_ENV_*` prefix to forward additional variables.
- **Rate limiting**: Per-IP request throttling on `/messages` (configurable via `RATE_LIMIT_RPM`)
- **Connection limits**: Max SSE connections capped (configurable via `MAX_SSE_CONNECTIONS`), with automatic eviction of idle connections
- **Session cwd validation**: Relative paths are validated against `WORKSPACE_DIR` to prevent traversal attacks
- **Graceful shutdown**: SIGTERM/SIGINT handlers clean up all child processes

### Known limitation: session process isolation

The MCP server's own filesystem tools (`read_file`, `list_directory`) are sandboxed to `WORKSPACE_DIR` and active session directories. However, **spawned coding agents (Claude Code, Codex) have full shell access** and can read or write anywhere the host OS user can. A system prompt instructs the agent to stay within its session directory, but this is a soft boundary — a malicious or manipulated prompt could escape it.

This is not a remote code execution risk from outside the server (all endpoints require authentication), but it means a rogue task could access files outside its working directory on the host.

**Recommended mitigations for production:**
- Run the server inside a container (Docker) with a read-only root filesystem and only the workspace mounted
- On Linux, use namespaces or `unshare` to restrict the child process's filesystem view
- On macOS, use `sandbox-exec` profiles to confine child processes
- Limit the host user's filesystem permissions to the minimum needed

## Running as a persistent service (macOS)

Claude Code sessions require access to the macOS login keychain for OAuth credentials. This means the server process **must run within a GUI login session** — if started via SSH or a background script that later disconnects, keychain access is lost and Claude Code sessions will fail with "Not logged in."

The recommended approach is a **LaunchAgent** (not a LaunchDaemon):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.pokeclaw.main</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/path/to/pokeclaw/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/pokeclaw</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AUTH_TOKEN</key>
        <string>your-secret-token</string>
        <key>PORT</key>
        <string>3500</string>
        <key>WORKSPACE_DIR</key>
        <string>/path/to/workspace</string>
        <key>HOME</key>
        <string>/Users/youruser</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/pokeclaw.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/pokeclaw.log</string>
    <key>ThrottleInterval</key>
    <integer>15</integer>
</dict>
</plist>
```

Save to `~/Library/LaunchAgents/dev.pokeclaw.main.plist`, then:

```bash
launchctl load ~/Library/LaunchAgents/dev.pokeclaw.main.plist
```

LaunchAgents run in the Aqua (GUI) session, which keeps keychain access alive across reboots. `KeepAlive` restarts the server if it crashes.

**Important:** Ensure `PATH` includes the directory containing the `claude` binary. Child processes inherit the PATH from this config, and Claude Code must be findable for `session_start` to work.

## Architecture

- **Transport**: SSE (Server-Sent Events) via `@modelcontextprotocol/sdk`
- **Codex sessions**: Managed via `node-pty` for proper terminal emulation
- **Claude Code sessions**: Managed via `child_process.spawn` with `--print --verbose --output-format stream-json`
- **Output**: Structured stream-json events parsed into readable log lines (tool calls, results, cost)
- **Buffering**: Ring buffer of 10,000 lines per session with offset-based reading
- **Cleanup**: Stale sessions killed after idle timeout; idle SSE connections evicted

## Troubleshooting

### Claude Code sessions fail with "Not logged in"

Claude Code stores OAuth credentials in the macOS login keychain. If the server process doesn't have access to the GUI security session, keychain reads fail silently and Claude Code reports "Not logged in."

**Common causes:**
- Server started via SSH and the SSH session has since disconnected
- Server started with `nohup` from a remote shell (process gets orphaned to launchd without GUI context)

**Fix:** Restart the server from a local terminal or use a LaunchAgent (see [Running as a persistent service](#running-as-a-persistent-service-macos)).

### `node-pty` fails to install

`node-pty` is a native module that requires a C++ compiler. If it fails during `npm install`:

- **macOS**: Install Xcode command-line tools: `xcode-select --install`
- **Linux**: Install build essentials: `apt-get install build-essential`

If you only need Claude Code sessions (not Codex), `node-pty` is optional — the server gracefully falls back and logs a warning at startup.

### Claude Code uses wrong model or version

The server resolves the `claude` binary via `PATH`. If multiple versions are installed, the first one found wins. Check which binary is being used:

```bash
which claude
claude --version
```

Ensure the `PATH` in your LaunchAgent or environment puts the desired version first.

### Sessions exit immediately with code 1

Check the session output via `session_output` — it includes the error message. Common causes:
- Missing credentials (OAuth login or API key not configured for the agent)
- CLI binary not found in `PATH`
- Working directory doesn't exist

## Development

```bash
npm run dev          # Start with tsx hot reload
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier format
npm run format:check # Prettier check
npm test             # Run test suite
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
