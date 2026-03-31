# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A zero-dependency Node.js HTTP bridge that wraps the Gemini CLI as a persistent subprocess, exposing an OpenAI-compatible API at `http://127.0.0.1:18790`. This lets OpenClaw (or any OpenAI-compatible client) use Google Gemini models safely — via the user's existing `gemini` CLI OAuth — without exposing credentials to third-party clients.

```
OpenClaw / OpenAI client
    ↓
gemini-bridge.mjs  (port 18790)
    ↓  JSON-RPC over stdio (ACP protocol)
gemini --acp --yolo  (persistent subprocess per model)
    ↓
Google Code Assist API
```

## Running & Installing

```bash
# Run directly (for development/testing)
node gemini-bridge.mjs

# Full install as a systemd user service (patches OpenClaw config automatically)
bash install.sh

# Remove
bash uninstall.sh
```

**Environment variables:**

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_BRIDGE_PORT` | `18790` | HTTP listen port |
| `GEMINI_CMD` | `gemini` | Path to Gemini CLI |
| `GEMINI_MAX_CONCURRENT` | `4` | Global concurrent request cap |

**Verification after running:**
```bash
curl http://127.0.0.1:18790/health
curl http://127.0.0.1:18790/v1/models
curl -s http://127.0.0.1:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gcli-3-flash","messages":[{"role":"user","content":"hi"}]}'
```

## Architecture: `gemini-bridge.mjs`

This is the only source file (~580 lines). It has two main parts:

### `AcpProcess` class
Manages one persistent `gemini --acp --yolo` subprocess per model. Key behaviors:

- **Persistent processes**: Spawned once, kept alive, respawned automatically on crash (5s delay). This avoids ~12s cold-start latency on every request.
- **Per-agent locking**: Each `agentId` gets a mutex so concurrent requests for the same agent are serialized. Different agents run in parallel.
- **Session lifecycle**: Sessions are persisted to `~/.gemini-bridge-state.json` (survives bridge restarts). A new session is started when:
  - Message count drops (user ran `/clear` or `/new`)
  - The first user message contains the startup marker `"new session was started"`
  - A small message count is detected with an existing session
- **Delta messaging**: Only the latest user message is sent to the ACP process each turn — not the full conversation history. The system prompt is sent once at session start, then discarded.
- **JSON-RPC over stdio**: Communicates with `gemini --acp` via newline-delimited JSON. Responses are streamed as SSE chunks.

### HTTP Server
Implements three endpoints:
- `GET /health` — ACP process states + active request count
- `GET /v1/models` — Lists bridge models (`gcli-3-flash`, `gcli-3.1-pro`)
- `POST /v1/chat/completions` — Main chat endpoint, supports both streaming (SSE) and non-streaming JSON

### Available Models

| Bridge ID | Maps to | Notes |
|---|---|---|
| `gcli-3-flash` | `gemini-3-flash-preview` | Fast, default |
| `gcli-3.1-pro` | `gemini-3.1-pro-preview` | More capable |

The `gcli-` prefix avoids collision with real Gemini OAuth model IDs in OpenClaw.

## Key Constraints

- **No dependencies**: Only Node.js built-ins (`http`, `child_process`, `crypto`, `fs`, `path`, `os`). No `package.json`. Do not introduce npm dependencies.
- **No tests**: There is no test suite. Verify behavior manually with curl.
- **Linux + systemd assumed** for the service installation path; `gemini-bridge.mjs` itself is cross-platform.
- **`gemini` CLI must be pre-authenticated** by the user (`gemini auth login`) before the bridge will work.
- Request timeout: 180 seconds. ACP init timeout: 30 seconds.
