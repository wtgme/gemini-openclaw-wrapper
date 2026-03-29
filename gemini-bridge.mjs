#!/usr/bin/env node
// gemini-bridge.mjs — OpenAI-compatible API wrapper around Gemini CLI (ACP mode)
// Zero dependencies, Node.js built-ins only.
// Uses persistent gemini --acp processes (one per model) to eliminate cold-start latency.
// Each API request gets a fresh ACP session (clean context) within the persistent process.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = parseInt(process.env.GEMINI_BRIDGE_PORT || '18790', 10);
const HOST = '127.0.0.1';
const GEMINI_CMD = process.env.GEMINI_CMD || 'gemini';
const MAX_CONCURRENT = parseInt(process.env.GEMINI_MAX_CONCURRENT || '4', 10);
const REQUEST_TIMEOUT_MS = 180_000;
const ACP_INIT_TIMEOUT_MS = 30_000;

const MODELS = [
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', contextWindow: 131072, maxTokens: 8192 },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', contextWindow: 131072, maxTokens: 8192 },
];
const DEFAULT_MODEL = MODELS[0].id;
const VALID_MODEL_IDS = new Set(MODELS.map(m => m.id));
let activeRequests = 0;

// --- ACP Process Manager ---
// One persistent `gemini --acp --yolo -e ""` process per model.
// Each API request: session/new (fresh context) + session/prompt.
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
  constructor(model) {
    this.model = model;
    this.child = null;
    this.ready = false;
    this.pendingCallbacks = new Map(); // id -> { resolve, reject }
    this.notificationHandlers = new Map(); // sessionId -> handler fn
    this.buf = '';
    this.nextId = 1;
    this.respawning = false;
  }

  spawn() {
    const args = ['--acp', '--yolo', '-e', '', '-m', this.model];
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
    // JSON-RPC response (has id) — includes session/prompt completion
    if (msg.id !== undefined) {
      const cb = this.pendingCallbacks.get(msg.id);
      if (cb) {
        this.pendingCallbacks.delete(msg.id);
        if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else cb.resolve(msg.result);
      }
      return;
    }
    // JSON-RPC notification (no id) — session/update events
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

  // Run a prompt: returns async generator yielding content chunks (strings),
  // then a final { done: true, stopReason } object.
  async* prompt(promptText) {
    if (!this.isReady()) throw new Error(`ACP process for ${this.model} not ready`);

    // Fresh session per request = clean context
    const sessionResult = await this._send('session/new', {
      cwd: process.env.HOME || '/home/wt',
      mcpServers: [],
    });
    const sessionId = sessionResult.sessionId;

    // Queue of updates + resolver for backpressure
    const queue = [];
    let resolver = null;
    let promptDone = false;
    let promptError = null;

    const push = (item) => {
      queue.push(item);
      if (resolver) { const r = resolver; resolver = null; r(); }
    };

    // Register notification handler
    this.notificationHandlers.set(sessionId, (update) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
        push({ text: update.content.text });
      } else if (update.sessionUpdate === 'error') {
        push({ error: update.error });
      }
      // agent_thought_chunk and available_commands_update are silently ignored
    });

    // Send prompt — resolves when session/prompt JSON-RPC response arrives (after all content)
    this._send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: promptText }],
    }).then(result => {
      promptDone = true;
      push({ done: true, stopReason: result?.stopReason || 'stop' });
    }).catch(err => {
      promptError = err;
      push({ error: err.message });
    });

    const timeout = setTimeout(() => push({ error: 'request timeout' }), REQUEST_TIMEOUT_MS);

    try {
      while (true) {
        while (queue.length > 0) {
          const item = queue.shift();
          yield item;
          if (item.done || item.error) return;
        }
        // Wait for next item
        await new Promise(r => { resolver = r; });
      }
    } finally {
      clearTimeout(timeout);
      this.notificationHandlers.delete(sessionId);
    }
  }
}

// One persistent ACP process per model
const acpProcesses = new Map();
for (const m of MODELS) {
  const proc = new AcpProcess(m.id);
  acpProcesses.set(m.id, proc);
  proc.start().catch(err => console.error(`[acp:${m.id}] start error:`, err.message));
}

// --- Message conversion ---

function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (messages.length === 1 && messages[0].role === 'user') {
    return extractContent(messages[0]);
  }
  return messages.map(m => {
    const role = m.role === 'system' ? 'System' : m.role === 'assistant' ? 'Assistant' : 'User';
    return `[${role}]\n${extractContent(m)}`;
  }).join('\n\n');
}

function extractContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  return '';
}

// --- OpenAI response helpers ---

function openaiChunk(id, model, delta, finishReason, usage) {
  const chunk = {
    id, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// --- Request handlers ---

async function handleCompletions(req, res, body) {
  const { messages, stream, model } = body;
  if (!messages || !Array.isArray(messages)) {
    return jsonResponse(res, 400, { error: { message: 'messages array required', type: 'invalid_request_error' } });
  }

  const resolvedModel = (model && VALID_MODEL_IDS.has(model)) ? model : DEFAULT_MODEL;
  const prompt = messagesToPrompt(messages);
  if (!prompt) {
    return jsonResponse(res, 400, { error: { message: 'empty prompt', type: 'invalid_request_error' } });
  }

  const acp = acpProcesses.get(resolvedModel);
  if (!acp || !acp.isReady()) {
    return jsonResponse(res, 503, { error: { message: `model ${resolvedModel} not ready, try again shortly`, type: 'server_error' } });
  }

  if (activeRequests >= MAX_CONCURRENT) {
    return jsonResponse(res, 429, { error: { message: 'too many concurrent requests', type: 'rate_limit_error' } });
  }

  activeRequests++;
  let aborted = false;
  const onClose = () => { aborted = true; };
  req.on('close', onClose);

  try {
    if (stream) {
      await handleStream(res, acp, prompt, `chatcmpl-${randomUUID()}`, resolvedModel, () => aborted);
    } else {
      await handleNonStream(res, acp, prompt, `chatcmpl-${randomUUID()}`, resolvedModel);
    }
  } catch (err) {
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: { message: err.message || 'internal error', type: 'server_error' } });
    }
  } finally {
    req.off('close', onClose);
    activeRequests--;
  }
}

async function handleStream(res, acp, prompt, id, model, isAborted) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  sseWrite(res, openaiChunk(id, model, { role: 'assistant', content: '' }, null));

  for await (const item of acp.prompt(prompt)) {
    if (isAborted()) break;
    if (item.error) {
      sseWrite(res, { ...openaiChunk(id, model, {}, 'error'), error: { message: item.error } });
      break;
    }
    if (item.text) {
      sseWrite(res, openaiChunk(id, model, { content: item.text }, null));
    }
    if (item.done) {
      sseWrite(res, openaiChunk(id, model, {}, 'stop'));
      break;
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleNonStream(res, acp, prompt, id, model) {
  let content = '';
  let geminiError = null;

  for await (const item of acp.prompt(prompt)) {
    if (item.error) { geminiError = item.error; break; }
    if (item.text) content += item.text;
    if (item.done) break;
  }

  if (geminiError && !content) {
    return jsonResponse(res, 500, { error: { message: geminiError, type: 'server_error' } });
  }

  jsonResponse(res, 200, {
    id, object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
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
    object: 'list',
    data: MODELS.map(m => ({
      id: m.id, object: 'model', created: 1700000000, owned_by: 'google',
    })),
  };
}

// --- Server ---

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

  if (path === '/v1/models' && req.method === 'GET') {
    return jsonResponse(res, 200, modelsResponse());
  }

  if (path === '/v1/chat/completions' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return await handleCompletions(req, res, body);
    } catch (err) {
      return jsonResponse(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
    }
  }

  jsonResponse(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
});

server.listen(PORT, HOST, () => {
  console.log(`gemini-bridge listening on http://${HOST}:${PORT}`);
  console.log(`Models: ${MODELS.map(m => m.id).join(', ')}`);
  console.log(`Mode: persistent ACP (gemini --acp --yolo)`);
});

// Cleanup on exit
process.on('SIGTERM', () => {
  for (const proc of acpProcesses.values()) {
    try { proc.child?.kill(); } catch {}
  }
  server.close();
  process.exit(0);
});
