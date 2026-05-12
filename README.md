# openclaw-cli-bridges — Gemini & Claude CLI bridges for OpenClaw and Hermes

Local API bridges that wrap [Gemini CLI](https://github.com/google-gemini/gemini-cli) and [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as HTTP endpoints, so [**OpenClaw**](https://openclaw.ai), [**Hermes**](https://github.com/transmissions11/hermes), or any OpenAI/Anthropic-compatible client can use these models via your existing CLI authentication — no extra OAuth, no API keys, no account risk, and **no per-token API billing**.

Each bridge speaks **two API formats on the same port**:
- the **native** format (Gemini API / Anthropic Messages) used by **OpenClaw**,
- and **OpenAI-compatible** Chat Completions (`POST /v1/chat/completions`) used by **Hermes** and any other OpenAI SDK client.

## Why this exists

### Google: avoid OAuth bans

Google blocks [OpenClaw](https://openclaw.ai), [Hermes](https://github.com/transmissions11/hermes), and [OpenCode](https://opencode.ai) from using Gemini via OAuth. If you connect these tools directly to your Google account, Google detects the third-party client and may **suspend or ban your account**.

`gemini-bridge` is a safe workaround: the third-party tool talks to a local HTTP API on localhost, while the actual authentication is handled entirely by the official `gemini` CLI. Your Google account never sees an unauthorized third-party OAuth client.

### Anthropic: subscription quota vs API billing

Anthropic deliberately gates third-party access differently from CLI access. When you connect OpenClaw or Hermes to Claude through the regular Anthropic API, requests bill against your **API budget** or your **"Extra usage credit"** — your Claude **Pro / Max subscription quota does not apply**. The only path that consumes subscription quota is the official Claude Code CLI itself.

`claude-bridge` exploits exactly that: it wraps `claude -p` as a subprocess, so requests flow through the same authenticated CLI path that draws from your subscription quota. OpenClaw / Hermes get a local HTTP endpoint to talk to — they never see your API key, and you never get charged for tokens you've already paid for via subscription.

## Bridges

### gemini-bridge (port 18790)

```
OpenClaw (Gemini API)  ─┐
Hermes (OpenAI SDK)    ─┤
any compatible client  ─┘
        │
        ▼
gemini-bridge  (Node.js, port 18790)
        │  Native:      POST /v1beta/models/{model}:generateContent
        │  OpenAI-compat: POST /v1/chat/completions
        │  persistent gemini --acp --yolo process per model
        ▼
Gemini CLI  (uses your existing ~/.gemini OAuth credentials)
        │
        ▼
Google Code Assist API
```

### claude-bridge (port 18791)

```
OpenClaw (Anthropic Messages) ─┐
Hermes (Anthropic SDK)         ─┤
Hermes (OpenAI SDK)            ─┤
any compatible client          ─┘
        │
        ▼
claude-bridge  (Node.js, port 18791)
        │  Native:      POST /v1/messages
        │  OpenAI-compat: POST /v1/chat/completions
        │  spawns claude -p --dangerously-skip-permissions per request
        ▼
Claude Code CLI  (uses your existing Claude authentication)
        │
        ▼
Anthropic API
```

## Key design points

- **Dual API surface**: each bridge speaks its provider's native API (Gemini `generateContent` / Anthropic Messages) **and** OpenAI-compatible Chat Completions on the same port. Native is what OpenClaw uses; OpenAI-compat is what Hermes and most other off-the-shelf SDK clients use.

- **Per-client agent namespacing**: OpenAI-compatible requests are tagged with an `oai:` agentId namespace so sessions opened by Hermes never collide with native-API sessions opened by OpenClaw. The bridge also honors the OpenAI `user` field and the Anthropic `metadata.user_id` field as the agent identifier when present.

- **Auto-approve modes**: gemini-bridge uses `--yolo` to auto-approve all Gemini CLI actions; claude-bridge uses `--dangerously-skip-permissions` for the same effect with Claude Code CLI. Both flags bypass interactive permission prompts so the bridges can run unattended.

- **Persistent ACP process** (gemini only): `gemini --acp` runs as a persistent daemon per model — responses arrive in ~2s instead of ~12s cold-start.

- **Spawn-per-request** (claude only): Claude Code CLI has no persistent subprocess mode, so each request spawns `claude -p`. Session continuity is maintained via `--resume <sessionId>`.

- **Delta messaging**: only the user's latest message is sent each turn (not the full history). The CLI session carries conversation context naturally.

- **Session seeding**: when a new session is created (first use, or after `/new`), the agent's system prompt is prepended to establish the model's role. All subsequent turns send only the bare user message.

- **Session persistence**: session IDs are saved to `~/.gemini-bridge-state.json` / `~/.claude-bridge-state.json`. On bridge restart, sessions are restored so existing conversations resume without re-seeding.

- **Session reset on `/new`**: the bridge detects a fresh conversation in three ways — the message-history count dropping, an explicit `"new session was started"` marker, or (for the OpenAI endpoint) any request that contains exactly one user message. On reset, the bridge creates a fresh CLI session and re-seeds it with the system prompt.

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
bash install.sh
```

`install.sh` auto-detects which CLIs are available and installs only the relevant bridges — safe to run if you only have one CLI installed. Re-run at any time to pick up a newly installed CLI.

Each bridge installer:
1. Copies the bridge script to `~/.local/bin/`
2. Installs and enables a systemd user service
3. Starts the bridge and runs a health check
4. Patches `~/.openclaw/openclaw.json` and all per-agent `models.json` files (if OpenClaw is installed)
5. Patches `~/.hermes/config.yaml` so every bridge model shows up in Hermes's `/model` picker (if Hermes is installed and `python3 -c "import yaml"` works)
6. Restarts OpenClaw (`openclaw-gateway`) to apply the changes

OpenClaw and Hermes configs are touched only if they exist — the installer is safe to run with neither, either, or both clients installed. See the [Hermes configuration](#hermes-configuration) section for what gets written and how to opt out.

To install a single bridge explicitly:

```bash
bash gemini/install.sh   # Gemini CLI only
bash claude/install.sh   # Claude Code CLI only
```

## Manual run (without systemd)

```bash
# Gemini bridge
node gemini/bridge.mjs

# Claude bridge
node claude/bridge.mjs
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

# List models (native Gemini format)
curl http://127.0.0.1:18790/v1beta/models

# List models (OpenAI format — Hermes uses this)
curl http://127.0.0.1:18790/v1/models

# Non-streaming request — Gemini API
curl -X POST http://127.0.0.1:18790/v1beta/models/gcli-3-flash:generateContent \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"say hi"}]}]}'

# Non-streaming request — OpenAI Chat Completions
curl -X POST http://127.0.0.1:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gcli-3-flash","messages":[{"role":"user","content":"say hi"}]}'

# --- claude-bridge ---

# Health check
curl http://127.0.0.1:18791/health

# Non-streaming request — Anthropic Messages
curl -X POST http://127.0.0.1:18791/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"ccli-sonnet","max_tokens":100,"messages":[{"role":"user","content":"say hi"}]}'

# Non-streaming request — OpenAI Chat Completions
curl -X POST http://127.0.0.1:18791/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"ccli-sonnet","messages":[{"role":"user","content":"say hi"}]}'
```

## OpenClaw configuration

The install scripts handle this automatically. For manual setup, merge the relevant config snippet into your `~/.openclaw/openclaw.json`:

- `gemini/openclaw-snippet.json` — gemini-local provider (`google-generative-ai` API)
- `claude/openclaw-snippet.json` — claude-local provider (`anthropic-messages` API)

## Hermes configuration

The bridge installers patch `~/.hermes/config.yaml` automatically when both the file and `python3 + PyYAML` are present. One `custom_providers` entry is written per (provider, model) pair, with all entries for the same bridge sharing the **same `name:`** — Hermes groups entries by `name:` in the `/model` picker, so you get two provider rows (`gemini-local` and `claude-local`) that expand into 3 models each, rather than 6 flat single-model rows.

Re-running the installer is idempotent: it removes any entry whose `name:` it manages (`gemini-local` / `claude-local`) and re-adds the current set. The top-level `model:` default is left untouched if you've already set one with `hermes setup model`.

After install, `~/.hermes/config.yaml` ends up looking like this (entries you had before are preserved):

```yaml
custom_providers:
- name: gemini-local
  base_url: http://127.0.0.1:18790/v1     # OpenAI SDK takes base_url literally — keep the /v1
  api_key: ''
  api_mode: chat_completions
  model: gcli-3.1-pro
- name: gemini-local
  base_url: http://127.0.0.1:18790/v1
  api_key: ''
  api_mode: chat_completions
  model: gcli-3-flash
- name: gemini-local
  base_url: http://127.0.0.1:18790/v1
  api_key: ''
  api_mode: chat_completions
  model: gcli-3.1-flash-lite
- name: claude-local
  base_url: http://127.0.0.1:18791        # Anthropic SDK auto-prepends /v1 — DO NOT include it here
  api_key: ''
  api_mode: anthropic_messages
  model: ccli-sonnet
- name: claude-local
  base_url: http://127.0.0.1:18791
  api_key: ''
  api_mode: anthropic_messages
  model: ccli-opus
- name: claude-local
  base_url: http://127.0.0.1:18791
  api_key: ''
  api_mode: anthropic_messages
  model: ccli-haiku
```

The base-URL asymmetry is deliberate: the OpenAI Python SDK appends `/chat/completions` to whatever you give it, while the Anthropic Python SDK appends `/v1/messages` itself. Mixing those up produces a 404 like `POST /v1/v1/messages` or `POST /chat/completions`.

**Caveats:**

- PyYAML rewrites the file via `safe_dump`, which **strips comments and may rearrange key order** in unrelated sections. If you've hand-edited the file with comments you want to keep, back it up first or paste the snippet manually.
- If `python3 -c "import yaml"` fails, the installer prints the snippet for you to paste instead of editing the file.
- The uninstaller removes only the entries it manages (by `name:`); anything else in `custom_providers` is left alone.

## Available models

**gemini-bridge:**

| Bridge ID | Gemini model | Description |
|---|---|---|
| `gcli-3.1-pro` | `gemini-3.1-pro-preview` | Top-tier, slower |
| `gcli-3-flash` | `gemini-3-flash-preview` | Default — balanced |
| `gcli-3.1-flash-lite` | `gemini-3.1-flash-lite-preview` | Lightest / fastest |

**claude-bridge:**

| Bridge ID | Claude model | Description |
|---|---|---|
| `ccli-sonnet` | `sonnet` | Default — balanced speed and capability |
| `ccli-opus` | `opus` | Most capable |
| `ccli-haiku` | `haiku` | Fastest, lightweight |

Edit the `MODELS` array at the top of each bridge file to add or remove models. Each Gemini model runs its own persistent `gemini --acp` subprocess; trim the list if memory is tight.

## Uninstall

```bash
# Remove gemini-bridge
bash gemini/uninstall.sh

# Remove claude-bridge
bash claude/uninstall.sh
```

Removes the bridge services and cleans up all provider entries from OpenClaw config automatically.

## License

MIT
