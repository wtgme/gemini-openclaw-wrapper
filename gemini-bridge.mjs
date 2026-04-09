#!/usr/bin/env node
// gemini-bridge.mjs — Gemini-native API wrapper around Gemini CLI (ACP mode)
// Zero dependencies, Node.js built-ins only.
// Uses persistent gemini --acp processes (one per model) to eliminate cold-start latency.
//
// Exposes Gemini API format:
//   POST /v1beta/models/{model}:generateContent       — non-streaming
//   POST /v1beta/models/{model}:streamGenerateContent  — streaming SSE
//   GET  /v1beta/models                                — list models
//   GET  /health                                       — bridge status
//
// Session lifecycle:
//   initSession(agentId, systemPrompt) — creates a new ACP session and stores the system
//     prompt to be prepended on the first query (seeds Gemini with the agent's role).
//   prompt(userText, agentId) — sends the user message. On the first call after initSession
//     the stored system prompt is prepended and then discarded; subsequent calls send only
//     the user text. The ACP session carries conversation context naturally (like --resume).

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const STATE_FILE = join(HOME, '.gemini-bridge-state.json');

const PORT = parseInt(process.env.GEMINI_BRIDGE_PORT || '18790', 10);
const HOST = '127.0.0.1';
const GEMINI_CMD = process.env.GEMINI_CMD || 'gemini';
const MAX_CONCURRENT = parseInt(process.env.GEMINI_MAX_CONCURRENT || '4', 10);
const REQUEST_TIMEOUT_MS = 180_000;
const ACP_INIT_TIMEOUT_MS = 30_000;

// === Model Discovery ===
// Bridge IDs use "gcli-" prefix to avoid collision with native Gemini OAuth model IDs in OpenClaw.
// Model list is resolved at startup in this order:
//   1. GEMINI_MODELS env var: comma-separated Gemini model IDs
//      e.g. GEMINI_MODELS=gemini-3-flash-preview,gemini-3.1-pro-preview
//   2. ~/.gemini/settings.json → model.name (configured default) + known fallback list
//   3. Hardcoded fallback

const FALLBACK_GEMINI_IDS = ['gemini-3-flash-preview', 'gemini-3.1-pro-preview'];

function geminiIdToModel(geminiId) {
  // gemini-3-flash-preview → gcli-3-flash, gemini-3.1-pro-preview → gcli-3.1-pro
  const short = geminiId.replace(/^gemini-/i, '').replace(/-preview$/i, '');
  return {
    id: `gcli-${short}`,
    geminiId,
    name: `Gemini ${short} (CLI)`,
    contextWindow: 1048576,
    maxTokens: 8192,
  };
}

function buildModelList() {
  if (process.env.GEMINI_MODELS) {
    const ids = process.env.GEMINI_MODELS.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`[models] using GEMINI_MODELS env: ${ids.join(', ')}`);
    return ids.map(geminiIdToModel);
  }
  try {
    const sf = join(HOME, '.gemini', 'settings.json');
    if (existsSync(sf)) {
      const cfg = JSON.parse(readFileSync(sf, 'utf8'));
      const configured = cfg?.model?.name;
      if (configured) {
        // Configured model first, then remaining fallbacks (deduped)
        const ids = [configured, ...FALLBACK_GEMINI_IDS].filter((id, i, a) => a.indexOf(id) === i);
        console.log(`[models] discovered from settings.json: ${ids.join(', ')}`);
        return ids.map(geminiIdToModel);
      }
    }
  } catch {}
  return FALLBACK_GEMINI_IDS.map(geminiIdToModel);
}

const MODELS = buildModelList();
const VALID_MODEL_IDS = new Set(MODELS.map(m => m.id));
let activeRequests = 0;
const agentMessageCounts = new Map(); // agentId -> last known message count (for /new detection)

// --- ACP Process Manager ---
// One persistent `gemini --acp --yolo -e ""` process per model.
//
// ACP notification format (session/update):
//   { method: "session/update", params: { sessionId, update: { sessionUpdate, content?, ... } } }
//   sessionUpdate types:
//     "agent_message_chunk" — content delta: update.content.text
//     "agent_thought_chunk" — thinking text, skip
//     "available_commands_update" — session ready signal
//   session/prompt response (JSON-RPC reply with id):
//     { result: { stopReason: "end_turn" } } — signals completion

class AcpProcess {
  constructor(model, geminiId) {
    this.model = model;       // public bridge ID (e.g. "gcli-3-flash")
    this.geminiId = geminiId; // real Gemini model name for CLI invocation
    this.child = null;
    this.ready = false;
    this.pendingCallbacks = new Map();    // id -> { resolve, reject }
    this.notificationHandlers = new Map(); // sessionId -> handler fn
    this.buf = '';
    this.nextId = 1;
    this.respawning = false;
    this.sessions = new Map();            // agentId -> sessionId
    this.pendingSystemPrompts = new Map(); // agentId -> systemPrompt text (consumed on first prompt)
    this.locks = new Map();               // agentId -> Promise (per-agent serialization lock)
  }

  _getLock(agentId) {
    if (!this.locks.has(agentId)) this.locks.set(agentId, Promise.resolve());
    return this.locks.get(agentId);
  }

  spawn() {
    const args = ['--acp', '--yolo', '-e', '', '-m', this.geminiId];
    this.child = spawn(GEMINI_CMD, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      if (s.trim()) console.error(`[acp:${this.model}] stderr:`, s.trim());
    });
    this.child.on('exit', (code) => {
      console.error(`[acp:${this.model}] process exited (code=${code}), respawning in 2s`);
      this.ready = false;
      this._rejectAll(new Error('ACP process exited'));
      setTimeout(() => this._init(), 2000);
    });
    this.child.on('error', (err) => {
      console.error(`[acp:${this.model}] spawn error:`, err.message);
      this.ready = false;
      this._rejectAll(err);
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString();
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined) {
      const cb = this.pendingCallbacks.get(msg.id);
      if (cb) {
        this.pendingCallbacks.delete(msg.id);
        if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else cb.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'session/update' && msg.params?.sessionId) {
      const handler = this.notificationHandlers.get(msg.params.sessionId);
      if (handler) handler(msg.params.update);
    }
  }

  _send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(id, { resolve, reject });
      const line = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';
      this.child.stdin.write(line);
    });
  }

  _rejectAll(err) {
    for (const cb of this.pendingCallbacks.values()) cb.reject(err);
    this.pendingCallbacks.clear();
    for (const handler of this.notificationHandlers.values()) {
      try { handler({ sessionUpdate: 'error', error: err.message }); } catch {}
    }
    this.notificationHandlers.clear();
  }

  async _init() {
    if (this.respawning) return;
    this.respawning = true;
    try {
      if (!this.child || this.child.exitCode !== null) this.spawn();

      await Promise.race([
        this._send('initialize', {
          protocolVersion: 1,
          capabilities: {},
          clientInfo: { name: 'gemini-bridge', version: '1.0' },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ACP init timeout')), ACP_INIT_TIMEOUT_MS)),
      ]);

      // Restore persisted sessions so existing conversations resume without re-seeding.
      try {
        if (existsSync(STATE_FILE)) {
          const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
          for (const [agentId, sessionId] of Object.entries(saved[this.model] || {})) {
            try {
              await Promise.race([
                this._send('session/load', { sessionId, cwd: HOME, mcpServers: [] }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('session/load timeout')), 10_000)),
              ]);
              this.sessions.set(agentId, sessionId);
              console.log(`[acp:${this.model}] resumed session ${sessionId} (agent: ${agentId})`);
            } catch (err) {
              console.warn(`[acp:${this.model}] could not resume session ${sessionId} (agent: ${agentId}):`, err.message);
            }
          }
        }
      } catch (err) {
        console.warn(`[acp:${this.model}] failed to load session state:`, err.message);
      }

      this.ready = true;
      console.log(`[acp:${this.model}] ready`);
    } catch (err) {
      console.error(`[acp:${this.model}] init failed:`, err.message, '— retrying in 5s');
      setTimeout(() => { this.respawning = false; this._init(); }, 5000);
      return;
    }
    this.respawning = false;
  }

  async start() {
    await this._init();
  }

  isReady() { return this.ready && this.child && this.child.exitCode === null; }

  _saveSession(agentId, sessionId) {
    try {
      const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
      if (!state[this.model]) state[this.model] = {};
      state[this.model][agentId] = sessionId;
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error(`[acp:${this.model}] failed to save session state:`, err.message);
    }
  }

  async _createSession(agentId, systemPrompt) {
    const result = await this._send('session/new', { cwd: HOME, mcpServers: [] });
    const sessionId = result.sessionId;
    this.sessions.set(agentId, sessionId);
    this._saveSession(agentId, sessionId);
    if (systemPrompt) {
      this.pendingSystemPrompts.set(agentId, systemPrompt);
    } else {
      this.pendingSystemPrompts.delete(agentId);
    }
    console.log(`[acp:${this.model}] session ${sessionId} initialized (agent: ${agentId})`);
  }

  // Send a user message to the agent's session.
  // opts.newSession — force creation of a fresh session (user issued /new)
  // opts.systemPrompt — passed when creating a new session to seed the agent's role
  //
  // All session state checks and mutations happen under the per-agent lock, eliminating
  // race conditions between concurrent requests for the same agent.
  async* prompt(userText, agentId, opts = {}) {
    if (!this.isReady()) throw new Error(`ACP process for ${this.model} not ready`);

    // Acquire the per-agent lock before touching any session state.
    let resolveLock;
    const prevLock = this._getLock(agentId);
    this.locks.set(agentId, new Promise(resolve => { resolveLock = resolve; }));
    await prevLock;

    try {
      // Under the lock: decide whether to create a new session.
      // - opts.newSession: caller detected /new (message count drop)
      // - no session yet: first message from this agent (or bridge restarted)
      if (opts.newSession || !this.sessions.has(agentId)) {
        await this._createSession(agentId, opts.systemPrompt ?? null);
      }
      const sessionId = this.sessions.get(agentId);

      // First query after session creation: prepend system prompt to seed agent role.
      const systemPrompt = this.pendingSystemPrompts.get(agentId);
      if (systemPrompt) {
        this.pendingSystemPrompts.delete(agentId);
        userText = `[System]\n${systemPrompt}\n\n${userText}`;
      }

      const queue = [];
      let resolver = null;
      const push = (item) => {
        queue.push(item);
        if (resolver) { const r = resolver; resolver = null; r(); }
      };

      this.notificationHandlers.set(sessionId, (update) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
          push({ text: update.content.text });
        } else if (update.sessionUpdate === 'error') {
          push({ error: update.error });
        }
      });

      this._send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: userText }],
      }).then(result => {
        push({ done: true, stopReason: result?.stopReason || 'stop' });
      }).catch(async (err) => {
        if (err.message.includes('not found') || err.message.includes('invalid')) {
          console.warn(`[acp:${this.model}] session ${sessionId} invalid (agent: ${agentId}), creating replacement`);
          try {
            const r = await this._send('session/new', { cwd: HOME, mcpServers: [] });
            this.sessions.set(agentId, r.sessionId);
            console.log(`[acp:${this.model}] replacement session ${r.sessionId} (agent: ${agentId})`);
          } catch (e) {
            this.sessions.delete(agentId);
          }
        }
        push({ error: err.message });
      });

      const timeout = setTimeout(() => push({ error: 'request timeout' }), REQUEST_TIMEOUT_MS);

      try {
        while (true) {
          while (queue.length > 0) {
            const item = queue.shift();
            yield { ...item, sessionId };
            if (item.done || item.error) return;
          }
          await new Promise(r => { resolver = r; });
        }
      } finally {
        clearTimeout(timeout);
        this.notificationHandlers.delete(sessionId);
      }
    } finally {
      resolveLock();
    }
  }

  async cancelPrompt(sessionId) {
    if (!this.isReady()) return;
    try {
      await this._send('session/cancel', { sessionId });
      console.log(`[acp:${this.model}] canceled session ${sessionId}`);
    } catch {
      // session/cancel may not be supported in all Gemini CLI versions
    }
  }
}

// One persistent ACP process per model
const acpProcesses = new Map();
for (const m of MODELS) {
  const proc = new AcpProcess(m.id, m.geminiId);
  acpProcesses.set(m.id, proc);
  proc.start().catch(err => console.error(`[acp:${m.id}] start error:`, err.message));
}

// --- Message helpers ---

function extractParts(content) {
  // Gemini format: content.parts is an array of {text: "..."} objects
  if (!content || !content.parts) return '';
  return content.parts.filter(p => p.text).map(p => p.text).join('\n');
}

function stripOpenClawMeta(text) {
  return text
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '')
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '')
    .replace(/Untrusted context \(metadata[^)]*\):\s*\n\n<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '')
    .trim();
}

// --- Gemini response helpers ---

function geminiResponse(candidates, usageMetadata) {
  return { candidates, usageMetadata };
}

function geminiCandidate(text, finishReason) {
  return {
    content: { role: 'model', parts: [{ text }] },
    finishReason: finishReason || 'STOP',
    index: 0,
  };
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// --- Request handlers ---

async function handleGenerate(req, res, body, modelId, isStream) {
  const { contents, systemInstruction } = body;
  if (!contents || !Array.isArray(contents)) {
    return jsonResponse(res, 400, { error: { code: 400, message: 'contents array required', status: 'INVALID_ARGUMENT' } });
  }

  const acp = acpProcesses.get(modelId);
  if (!acp || !acp.isReady()) {
    return jsonResponse(res, 503, { error: { code: 503, message: `model ${modelId} not ready, try again shortly`, status: 'UNAVAILABLE' } });
  }

  // Derive agentId from systemInstruction metadata or fall back to 'default'.
  let agentId = null;
  const sysText = systemInstruction ? extractParts(systemInstruction) : '';
  const metaMatch = sysText.match(/"chat_id"\s*:\s*"([^"]+)"/);
  if (metaMatch) agentId = metaMatch[1];
  if (!agentId) agentId = 'default';

  // Extract the last user message (delta messaging — only send the latest turn).
  const lastUserContent = [...contents].reverse().find(c => c.role === 'user');
  if (!lastUserContent) {
    return jsonResponse(res, 400, { error: { code: 400, message: 'no user content found', status: 'INVALID_ARGUMENT' } });
  }
  const userText = stripOpenClawMeta(extractParts(lastUserContent));
  if (!userText) {
    return jsonResponse(res, 400, { error: { code: 400, message: 'empty user message', status: 'INVALID_ARGUMENT' } });
  }

  console.log(`[req] model=${modelId} agent=${agentId} stream=${isStream} contents=${contents.length}`);

  // Detect session reset:
  // 1. Content count drop — /new or /clear
  // 2. Startup marker in user text
  const prevCount = agentMessageCounts.get(agentId) || 0;
  agentMessageCounts.set(agentId, contents.length);
  const countDropped = prevCount > 0 && contents.length < prevCount;
  const hasStartupMarker = /new session was started/i.test(userText);
  const newSession = countDropped || hasStartupMarker;
  if (newSession) {
    console.log(`[req] new session detected for agent=${agentId} (countDrop=${countDropped}, startupMarker=${hasStartupMarker})`);
  }

  const systemPrompt = sysText || null;

  if (activeRequests >= MAX_CONCURRENT) {
    return jsonResponse(res, 429, { error: { code: 429, message: 'too many concurrent requests', status: 'RESOURCE_EXHAUSTED' } });
  }

  activeRequests++;
  let aborted = false;
  let lastSessionId = null;
  const onClose = () => {
    aborted = true;
    if (lastSessionId) acp.cancelPrompt(lastSessionId).catch(() => {});
  };
  req.on('close', onClose);

  try {
    const setSessionId = (sid) => { lastSessionId = sid; };
    if (isStream) {
      await handleStream(res, acp, userText, agentId, { newSession, systemPrompt }, modelId, () => aborted, setSessionId);
    } else {
      await handleNonStream(res, acp, userText, agentId, { newSession, systemPrompt }, modelId, setSessionId);
    }
  } catch (err) {
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: { code: 500, message: err.message || 'internal error', status: 'INTERNAL' } });
    }
  } finally {
    req.off('close', onClose);
    activeRequests--;
  }
}

async function handleStream(res, acp, userText, agentId, opts, model, isAborted, onSession) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  for await (const item of acp.prompt(userText, agentId, opts)) {
    if (item.sessionId) onSession(item.sessionId);
    if (isAborted()) break;
    if (item.error) {
      sseWrite(res, geminiResponse([geminiCandidate(`[error] ${item.error}`, 'ERROR')], null));
      break;
    }
    if (item.text) {
      sseWrite(res, geminiResponse([{
        content: { role: 'model', parts: [{ text: item.text }] },
        index: 0,
      }], null));
    }
    if (item.done) {
      sseWrite(res, geminiResponse([{
        content: { role: 'model', parts: [] },
        finishReason: 'STOP',
        index: 0,
      }], { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }));
      break;
    }
  }

  res.end();
}

async function handleNonStream(res, acp, userText, agentId, opts, model, onSession) {
  let content = '';
  let geminiError = null;

  for await (const item of acp.prompt(userText, agentId, opts)) {
    if (item.sessionId) onSession(item.sessionId);
    if (item.error) { geminiError = item.error; break; }
    if (item.text) content += item.text;
    if (item.done) break;
  }

  if (geminiError && !content) {
    return jsonResponse(res, 500, { error: { code: 500, message: geminiError, status: 'INTERNAL' } });
  }

  jsonResponse(res, 200, geminiResponse(
    [geminiCandidate(content, 'STOP')],
    { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  ));
}

// --- HTTP plumbing ---

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  }
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function modelsResponse() {
  return {
    models: MODELS.map(m => ({
      name: `models/${m.id}`,
      displayName: m.name,
      inputTokenLimit: m.contextWindow,
      outputTokenLimit: m.maxTokens,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    })),
  };
}

// --- Server ---
// Routes:
//   GET  /health
//   GET  /v1beta/models
//   POST /v1beta/models/{model}:generateContent
//   POST /v1beta/models/{model}:streamGenerateContent

const GENERATE_RE = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (path === '/health' && req.method === 'GET') {
    const procStats = {};
    for (const [model, proc] of acpProcesses) {
      procStats[model] = proc.isReady() ? 'ready' : 'initializing';
    }
    return jsonResponse(res, 200, { status: 'ok', active: activeRequests, max: MAX_CONCURRENT, processes: procStats });
  }

  if (path === '/v1beta/models' && req.method === 'GET') {
    return jsonResponse(res, 200, modelsResponse());
  }

  const match = path.match(GENERATE_RE);
  if (match && req.method === 'POST') {
    const modelId = match[1];
    const isStream = match[2] === 'streamGenerateContent';

    if (!VALID_MODEL_IDS.has(modelId)) {
      return jsonResponse(res, 404, { error: { code: 404, message: `model ${modelId} not found`, status: 'NOT_FOUND' } });
    }

    try {
      const body = await readBody(req);
      return await handleGenerate(req, res, body, modelId, isStream);
    } catch (err) {
      return jsonResponse(res, 400, { error: { code: 400, message: err.message, status: 'INVALID_ARGUMENT' } });
    }
  }

  jsonResponse(res, 404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
});

server.listen(PORT, HOST, () => {
  console.log(`gemini-bridge listening on http://${HOST}:${PORT}`);
  console.log(`API: Gemini (POST /v1beta/models/{model}:generateContent)`);
  console.log(`Models: ${MODELS.map(m => m.id).join(', ')}`);
  console.log(`Mode: persistent ACP (gemini --acp --yolo)`);
});

// Cleanup on exit
const cleanup = () => {
  console.log('Shutting down bridge...');
  for (const proc of acpProcesses.values()) {
    try { proc.child?.kill(); } catch {}
  }
  server.close();
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
