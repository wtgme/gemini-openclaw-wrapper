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

- **Persistent processes**: one `gemini --acp --yolo` process per model, pre-warmed at startup. Responses in ~2s instead of ~12s cold-start.
- **Fresh context per request**: each API call gets a new ACP session — no context pollution between requests. OpenClaw manages conversation history at its layer.
- **Zero dependencies**: pure Node.js built-ins (`http`, `child_process`, `crypto`). No npm install needed.
- **Yolo mode**: `--yolo` flag means Gemini CLI never pauses for tool-use approval prompts.

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
  -d '{"model":"gemini-3-flash-preview","messages":[{"role":"user","content":"say hi"}]}'

# Streaming request
curl -N -X POST http://127.0.0.1:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3-flash-preview","messages":[{"role":"user","content":"count to 3"}],"stream":true}'
```

## OpenClaw configuration

Merge the contents of `openclaw-config-snippet.json` into your `~/.openclaw/openclaw.json` under the top-level `"models"` key:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "gemini-local": {
        "baseUrl": "http://127.0.0.1:18790/v1",
        "api": "openai-completions",
        "apiKey": "dummy",
        "models": [
          {
            "id": "gemini-3-flash-preview",
            "name": "Gemini 3 Flash (local CLI)",
            ...
          }
        ]
      }
    }
  }
}
```

Then reference models as `gemini-local/gemini-3-flash-preview` in your agent config or fallbacks list.

## Available models

The bridge exposes whatever models your Gemini CLI account can access. The default config includes:

- `gemini-3-flash-preview` — fast, good for most tasks
- `gemini-3.1-pro-preview` — more capable, slower

Edit the `MODELS` array at the top of `gemini-bridge.mjs` to add or remove models.

## Uninstall

```bash
bash uninstall.sh
```

## License

MIT
