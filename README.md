# openclaw-cli-bridges

Local API bridges that wrap [Gemini CLI](https://github.com/google-gemini/gemini-cli) and [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as native-format HTTP endpoints, so [OpenClaw](https://openclaw.ai) (or any compatible client) can use these models via your existing CLI authentication — no extra OAuth, no API keys, no account risk.

## Why this exists

Google blocks [OpenClaw](https://openclaw.ai) and [OpenCode](https://opencode.ai) from using Gemini via OAuth. If you connect these tools directly to your Google account, Google detects the third-party client and may **suspend or ban your account**.

These bridges are a safe workaround: OpenClaw talks to a local HTTP API on localhost, while the actual authentication is handled entirely by the official CLIs. Your accounts never see an unauthorized third-party OAuth client.

## Bridges

### gemini-bridge (port 18790) — Gemini API format

```
OpenClaw / any Gemini API client
        │
        ▼
gemini-bridge  (Node.js, port 18790)
        │  Gemini API: POST /v1beta/models/{model}:generateContent
        │  persistent gemini --acp --yolo process per model
        ▼
Gemini CLI  (uses your existing ~/.gemini OAuth credentials)
        │
        ▼
Google Code Assist API
```

### claude-bridge (port 18791) — Anthropic Messages API format

```
OpenClaw / any Anthropic API client
        │
        ▼
claude-bridge  (Node.js, port 18791)
        │  Anthropic API: POST /v1/messages
        │  spawns claude -p --dangerously-skip-permissions per request
        ▼
Claude Code CLI  (uses your existing Claude authentication)
        │
        ▼
Anthropic API
```

## Key design points

- **Native API formats**: gemini-bridge speaks Gemini API (`generateContent` / `streamGenerateContent`); claude-bridge speaks Anthropic Messages API (`/v1/messages` with streaming SSE).

- **Auto-approve modes**: gemini-bridge uses `--yolo` to auto-approve all Gemini CLI actions; claude-bridge uses `--dangerously-skip-permissions` for the same effect with Claude Code CLI. Both flags bypass interactive permission prompts so the bridges can run unattended.

- **Persistent ACP process** (gemini only): `gemini --acp` runs as a persistent daemon per model — responses arrive in ~2s instead of ~12s cold-start.

- **Spawn-per-request** (claude only): Claude Code CLI has no persistent subprocess mode, so each request spawns `claude -p`. Session continuity is maintained via `--resume <sessionId>`.

- **Delta messaging**: only the user's latest message is sent each turn (not the full history). The CLI session carries conversation context naturally.

- **Session seeding**: when a new session is created (first use, or after `/new`), the agent's system prompt is prepended to establish the model's role. All subsequent turns send only the bare user message.

- **Session persistence**: session IDs are saved to `~/.gemini-bridge-state.json` / `~/.claude-bridge-state.json`. On bridge restart, sessions are restored so existing conversations resume without re-seeding.

- **Session reset on `/new`**: when OpenClaw's `/new` or `/clear` is used, the bridge detects the conversation history reset (message count drop or startup marker), creates a fresh session, and re-seeds it with the system prompt.

- **Race-condition-free**: all session state checks and mutations happen inside per-agent locks, so concurrent requests for the same agent always serialize correctly.

- **Concurrency**: per-agent locking serializes requests within the same session; a global `MAX_CONCURRENT` cap protects against system overload.

- **Zero dependencies**: pure Node.js built-ins (`http`, `child_process`, `crypto`, `fs`). No `npm install`, no lockfile, nothing to audit.

- **No ID collisions**: bridge model IDs use prefixes (`gcli-` for Gemini, `ccli-` for Claude) so they never clash with real model IDs in OpenClaw.

## Transparency — inspect your sessions

Both bridges use standard CLI sessions, so you can read or continue any conversation directly:

```bash
# Gemini sessions
cat ~/.gemini-bridge-state.json
gemini --resume <sessionId>

# Claude sessions
cat ~/.claude-bridge-state.json
claude --resume <sessionId>
```

## Prerequisites

- **gemini-bridge**: [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated (`gemini` in PATH)
- **claude-bridge**: [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` in PATH)
- Node.js 18+
- Linux with systemd (for the services) — or run manually on any OS

## Install

```bash
git clone https://github.com/wtgme/openclaw-cli-bridges
cd openclaw-cli-bridges

# Install gemini-bridge
bash gemini-install.sh

# Install claude-bridge
bash claude-install.sh
```

Each installer:
1. Copies the bridge script to `~/.local/bin/`
2. Installs and enables a systemd user service
3. Starts the bridge and runs a health check
4. Automatically patches `~/.openclaw/openclaw.json` and all per-agent `models.json` files
5. Restarts OpenClaw (`openclaw-gateway`) to apply the changes

No manual config steps required.

## Manual run (without systemd)

```bash
# Gemini bridge
node gemini-bridge.mjs

# Claude bridge
node claude-bridge.mjs
```

### Environment variables

**gemini-bridge:**

| Variable | Default | Description |
|---|---|---|
| `GEMINI_BRIDGE_PORT` | `18790` | Port to listen on |
| `GEMINI_CMD` | `gemini` | Path to gemini CLI binary |
| `GEMINI_MAX_CONCURRENT` | `4` | Max concurrent requests |

**claude-bridge:**

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_BRIDGE_PORT` | `18791` | Port to listen on |
| `CLAUDE_CMD` | `claude` | Path to claude CLI binary |
| `CLAUDE_MAX_CONCURRENT` | `4` | Max concurrent requests |
| `CLAUDE_BARE` | `0` | Set to `1` to use `--bare` mode (skips .claude/ discovery) |

## Verify

```bash
# --- gemini-bridge ---

# Health check
curl http://127.0.0.1:18790/health

# List models
curl http://127.0.0.1:18790/v1beta/models

# Non-streaming request (Gemini format)
curl -X POST http://127.0.0.1:18790/v1beta/models/gcli-3-flash:generateContent \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"say hi"}]}]}'

# Streaming request
curl -N -X POST http://127.0.0.1:18790/v1beta/models/gcli-3-flash:streamGenerateContent \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"count to 3"}]}]}'

# --- claude-bridge ---

# Health check
curl http://127.0.0.1:18791/health

# Non-streaming request (Anthropic format)
curl -X POST http://127.0.0.1:18791/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"ccli-sonnet","max_tokens":100,"messages":[{"role":"user","content":"say hi"}]}'

# Streaming request
curl -N -X POST http://127.0.0.1:18791/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"ccli-sonnet","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"count to 3"}]}'
```

## OpenClaw configuration

The install scripts handle this automatically. For manual setup, merge the relevant config snippet into your `~/.openclaw/openclaw.json`:

- `openclaw-config-snippet.json` — gemini-local provider (`google-generative-ai` API)
- `claude-openclaw-config-snippet.json` — claude-local provider (`anthropic-messages` API)

## Available models

**gemini-bridge:**

| Bridge ID | Gemini model | Description |
|---|---|---|
| `gcli-3-flash` | `gemini-3-flash-preview` | Fast, good for most tasks |
| `gcli-3.1-pro` | `gemini-3.1-pro-preview` | More capable, slower |

**claude-bridge:**

| Bridge ID | Claude model | Description |
|---|---|---|
| `ccli-sonnet` | `sonnet` | Balanced speed and capability |
| `ccli-opus` | `opus` | Most capable |
| `ccli-haiku` | `haiku` | Fastest, lightweight |

Edit the `MODELS` array at the top of each bridge file to add or remove models.

## Uninstall

```bash
# Remove gemini-bridge
bash gemini-uninstall.sh

# Remove claude-bridge
bash claude-uninstall.sh
```

Removes the bridge services and cleans up all provider entries from OpenClaw config automatically.

## License

MIT
