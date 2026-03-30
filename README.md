# gemini-openclaw-wrapper

A lightweight local API bridge that wraps [Gemini CLI](https://github.com/google-gemini/gemini-cli) as an OpenAI-compatible `/v1/chat/completions` endpoint, so [OpenClaw](https://openclaw.ai) (or any OpenAI-compatible client) can use Gemini models via your existing CLI authentication — no extra OAuth, no API keys, no Google account risk.

## Why this exists

Google blocks [OpenClaw](https://openclaw.ai) and [OpenCode](https://opencode.ai) from using Gemini via OAuth. If you connect these tools directly to your Google account, Google detects the third-party client and may **suspend or ban your account**.

This bridge is a safe workaround: OpenClaw/OpenCode talk to a plain OpenAI-compatible HTTP API on localhost, while the actual Google authentication is handled entirely by the official Gemini CLI (which Google permits). Your Google account never sees an unauthorized third-party OAuth client.

## How it works

```
OpenClaw / any OpenAI client
        │
        ▼
gemini-bridge  (Node.js, port 18790)
        │  OpenAI-compatible HTTP API
        │  persistent gemini --acp --yolo process per model
        ▼
Gemini CLI  (uses your existing ~/.gemini OAuth credentials)
        │
        ▼
Google Code Assist API
```

### Key design points

- **Persistent ACP process**: `gemini --acp` runs as a persistent daemon per model — responses arrive in ~2s instead of ~12s cold-start.

- **Delta messaging**: only the user's latest message is sent to Gemini each turn (not the full history). The ACP session carries conversation context naturally, identical to how `gemini --resume <sessionId>` works on the command line.

- **Session seeding**: when a new session is created (first use, or after `/new`), the agent's system prompt is prepended to the first message to establish Gemini's role. All subsequent turns send only the bare user message.

- **Session persistence**: session IDs are saved to `~/.gemini-bridge-state.json`. On bridge restart, sessions are restored via `session/load` so existing conversations resume without re-seeding.

- **Session reset on `/new`**: when OpenClaw's `/new` or `/clear` is used, the bridge detects the conversation history reset (message count drop), creates a fresh Gemini session, and re-seeds it with the system prompt.

- **Race-condition-free**: all session state checks and mutations (creation, seeding, resuming) happen inside the per-agent lock, so concurrent requests for the same agent always serialize correctly.

- **Concurrency**: per-agent locking serializes requests within the same session; a global `MAX_CONCURRENT` cap protects against system overload.

- **Zero dependencies**: pure Node.js built-ins (`http`, `child_process`, `crypto`, `fs`). No `npm install`, no lockfile, nothing to audit.

- **No ID collisions**: bridge model IDs use a `gcli-` prefix (e.g. `gcli-3-flash`) so they never clash with real Gemini OAuth model IDs if you later add Gemini OAuth to OpenClaw.

## Transparency — inspect your sessions

Because the bridge uses standard Gemini CLI sessions, you can read or continue any conversation directly on the command line:

```bash
# View the session ID for a channel from the state file
cat ~/.gemini-bridge-state.json

# Resume that session interactively in your terminal
gemini --resume <sessionId>
```

The full conversation history is visible and portable — it lives in the Gemini CLI's own session store, not locked inside the bridge.

## Prerequisites

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated (`gemini` in PATH, OAuth working)
- Node.js 18+
- Linux with systemd (for the service) — or run manually on any OS

## Install

```bash
git clone https://github.com/wtgme/gemini-openclaw-wrapper
cd gemini-openclaw-wrapper
bash install.sh
```

The installer:
1. Copies `gemini-bridge.mjs` to `~/.local/bin/`
2. Installs and enables a systemd user service
3. Starts the bridge and runs a health check
4. Automatically patches `~/.openclaw/openclaw.json` and all per-agent `models.json` files to register the `gemini-local` provider
5. Restarts OpenClaw (`openclaw-gateway`) to apply the changes

No manual config steps required.

## Manual run (without systemd)

```bash
node ~/.local/bin/gemini-bridge.mjs
# or directly:
node gemini-bridge.mjs
```

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `GEMINI_BRIDGE_PORT` | `18790` | Port to listen on |
| `GEMINI_CMD` | `gemini` | Path to gemini CLI binary |
| `GEMINI_MAX_CONCURRENT` | `4` | Max concurrent requests |

## Verify

```bash
# Health check (shows if ACP processes are ready)
curl http://127.0.0.1:18790/health

# List models
curl http://127.0.0.1:18790/v1/models

# Non-streaming request
curl -X POST http://127.0.0.1:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gcli-3-flash","messages":[{"role":"user","content":"say hi"}]}'

# Streaming request
curl -N -X POST http://127.0.0.1:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gcli-3-flash","messages":[{"role":"user","content":"count to 3"}],"stream":true}'
```

## OpenClaw configuration

`install.sh` handles this automatically. For manual setup, merge `openclaw-config-snippet.json` into your `~/.openclaw/openclaw.json` under the top-level `"models"` key, then reference models as `gemini-local/gcli-3-flash` in your agent config or fallbacks list.

## Available models

| Bridge ID | Gemini model | Description |
|---|---|---|
| `gcli-3-flash` | `gemini-3-flash-preview` | Fast, good for most tasks |
| `gcli-3.1-pro` | `gemini-3.1-pro-preview` | More capable, slower |

The `gcli-` prefix ensures these IDs never collide with real Gemini OAuth models. Edit the `MODELS` array at the top of `gemini-bridge.mjs` to add or remove models.

## Uninstall

```bash
bash uninstall.sh
```

Removes the bridge service and cleans up all `gemini-local` entries from OpenClaw config automatically.

## License

MIT
