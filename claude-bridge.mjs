#!/usr/bin/env node
// claude-bridge.mjs — Anthropic Messages API bridge around Claude Code CLI
// Zero dependencies, Node.js built-ins only.
//
// Unlike gemini-bridge which uses persistent ACP processes, this bridge spawns
// a new `claude -p` process per request.  Session continuity is maintained via
// `--resume <sessionId>`.  Claude Code CLI has no persistent subprocess mode
// equivalent to Gemini's `--acp`.
//
// Exposes Anthropic Messages API format:
//   POST /v1/messages  — Anthropic-format request/response (streaming + non-streaming)
//   GET  /v1/models    — list available bridge models
//   GET  /health       — bridge status
//
// Session lifecycle:
//   First request for an agent:
//     `claude -p "text" --append-system-prompt "..." --output-format ...`
//   Subsequent requests (same agent):
//     `claude -p "text" --resume <sessionId> --output-format ...`
//   New session detected (count drop / startup marker):
//     Drops --resume, starts fresh with system prompt.
//
// Only the latest user message is sent per turn (delta messaging); the Claude
// CLI session carries full conversation context across --resume calls.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const STATE_FILE = join(HOME, '.claude-bridge-state.json');

const PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || '18791', 10);
const HOST = '127.0.0.1';
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const MAX_CONCURRENT = parseInt(process.env.CLAUDE_MAX_CONCURRENT || '4', 10);
const REQUEST_TIMEOUT_MS = 180_000;
// --bare skips .claude/ auto-discovery (including auth); set CLAUDE_BARE=1 to enable
const BARE_MODE = process.env.CLAUDE_BARE === '1';
// Working directory for spawned claude processes. Sessions are namespaced by cwd,
// so this must be consistent for /resume to work. Defaults to HOME so sessions
// are always visible when you run `claude` from your home directory.
const CLAUDE_CWD = process.env.CLAUDE_BRIDGE_CWD || HOME;

// Bridge model IDs use a "ccli-" prefix so they never collide with real Claude
// model IDs that might appear elsewhere in OpenClaw configuration.
const MODELS = [
  { id: 'ccli-sonnet', claudeId: 'sonnet', name: 'Claude Sonnet (CLI Bridge)', contextWindow: 200000, maxTokens: 16384 },
  { id: 'ccli-opus', claudeId: 'opus', name: 'Claude Opus (CLI Bridge)', contextWindow: 200000, maxTokens: 16384 },
  { id: 'ccli-haiku', claudeId: 'haiku', name: 'Claude Haiku (CLI Bridge)', contextWindow: 200000, maxTokens: 8192 },
];
const DEFAULT_MODEL = MODELS[0].id;
const VALID_MODEL_IDS = new Set(MODELS.map(m => m.id));

let activeRequests = 0;
const agentMessageCounts = new Map(); // agentId -> last known message count

// --- Session State ---
// Flat map of "modelId:agentId" -> sessionId, persisted to disk.

const sessions = new Map();

function loadSessions() {
  try {
    if (existsSync(STATE_FILE)) {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      for (const [key, sessionId] of Object.entries(state)) {
        sessions.set(key, sessionId);
      }
      console.log(`Loaded ${sessions.size} session(s) from ${STATE_FILE}`);
    }
  } catch (err) {
    console.warn('Failed to load session state:', err.message);
  }
}

function _persistSessions() {
  try {
    const state = Object.fromEntries(sessions);
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save session state:', err.message);
  }
}

function saveSession(modelId, agentId, sessionId) {
  sessions.set(`${modelId}:${agentId}`, sessionId);
  _persistSessions();
}

function getSession(modelId, agentId) {
  return sessions.get(`${modelId}:${agentId}`) || null;
}

function clearSession(modelId, agentId) {
  sessions.delete(`${modelId}:${agentId}`);
  _persistSessions();
}

loadSessions();

// --- Per-agent locking ---
// Serializes concurrent requests for the same agent so session state (the
// sessionId used for --resume) is never stale or raced.

const locks = new Map();

async function acquireLock(key) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  locks.set(key, new Promise(resolve => { release = resolve; }));
  await prev;
  return release;
}

// --- Claude CLI spawner ---

function spawnClaude(userText, modelId, opts = {}) {
  const model = MODELS.find(m => m.id === modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  const args = ['-p', userText, '--model', model.claudeId, '--dangerously-skip-permissions'];

  if (opts.stream) {
    args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
  } else {
    args.push('--output-format', 'json');
  }

  if (BARE_MODE) args.push('--bare');

  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  } else if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }

  const logArgs = ['claude', '-p', '"…"', '--model', model.claudeId];
  if (opts.sessionId) logArgs.push('--resume', opts.sessionId.slice(0, 8) + '…');
  console.log(`[spawn] ${logArgs.join(' ')}`);

  const child = spawn(CLAUDE_CMD, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: CLAUDE_CWD,
    env: { ...process.env },
  });

  // Close stdin immediately so claude -p doesn't wait for piped input.
  child.stdin.end();

  return child;
}

// --- Message helpers ---

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  return '';
}

function stripOpenClawMeta(text) {
  return text
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '')
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '')
    .replace(/Untrusted context \(metadata[^)]*\):\s*\n\n<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '')
    .trim();
}

// --- Anthropic Messages API response helpers ---

function anthropicError(status, type, message) {
  return { status, body: { type: 'error', error: { type, message } } };
}

function sseEvent(res, eventType, data) {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

// --- Request handlers ---

async function handleMessages(req, res, body) {
  const { messages, stream, model, system, metadata } = body;
  if (!messages || !Array.isArray(messages)) {
    const err = anthropicError(400, 'invalid_request_error', 'messages array required');
    return jsonResponse(res, err.status, err.body);
  }

  const resolvedModel = (model && VALID_MODEL_IDS.has(model)) ? model : DEFAULT_MODEL;

  // Derive agentId: prefer metadata.user_id, then chat_id from system prompt, then 'default'.
  let agentId = metadata?.user_id || null;
  if (!agentId) {
    const sysText = typeof system === 'string' ? system : extractTextContent(system);
    const metaMatch = sysText.match(/"chat_id"\s*:\s*"([^"]+)"/);
    if (metaMatch) agentId = metaMatch[1];
  }
  if (!agentId) agentId = 'default';

  console.log(`[req] model=${resolvedModel} agent=${agentId} stream=${!!stream} msgs=${messages.length}`);

  // In Anthropic format, last message must be role=user.
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    const err = anthropicError(400, 'invalid_request_error', 'no user message found');
    return jsonResponse(res, err.status, err.body);
  }
  const userText = stripOpenClawMeta(extractTextContent(lastUserMsg.content));
  if (!userText) {
    const err = anthropicError(400, 'invalid_request_error', 'empty user message');
    return jsonResponse(res, err.status, err.body);
  }

  // Detect session reset (same signals as gemini-bridge):
  const prevCount = agentMessageCounts.get(agentId) || 0;
  agentMessageCounts.set(agentId, messages.length);
  const countDropped = prevCount > 0 && messages.length < prevCount;
  const hasStartupMarker = /new session was started/i.test(userText);
  const newSession = countDropped || hasStartupMarker;
  if (newSession) {
    console.log(`[req] new session for agent=${agentId} (countDrop=${countDropped}, startupMarker=${hasStartupMarker})`);
    clearSession(resolvedModel, agentId);
  }

  // System prompt: Anthropic format has it as a top-level field, not in messages.
  // Only sent when creating a new session (no --resume).
  let systemPrompt = null;
  if (typeof system === 'string') {
    systemPrompt = system;
  } else if (Array.isArray(system)) {
    systemPrompt = extractTextContent(system);
  }

  if (activeRequests >= MAX_CONCURRENT) {
    const err = anthropicError(429, 'rate_limit_error', 'too many concurrent requests');
    return jsonResponse(res, err.status, err.body);
  }

  activeRequests++;
  const lockKey = `${resolvedModel}:${agentId}`;
  const releaseLock = await acquireLock(lockKey);

  try {
    const sessionId = getSession(resolvedModel, agentId);
    const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    if (stream) {
      await handleStream(req, res, userText, resolvedModel, agentId, sessionId, systemPrompt, msgId);
    } else {
      await handleNonStream(res, userText, resolvedModel, agentId, sessionId, systemPrompt, msgId);
    }
  } catch (err) {
    if (!res.headersSent) {
      const e = anthropicError(500, 'api_error', err.message || 'internal error');
      jsonResponse(res, e.status, e.body);
    }
  } finally {
    releaseLock();
    activeRequests--;
  }
}

async function handleStream(req, res, userText, modelId, agentId, sessionId, systemPrompt, msgId) {
  const child = spawnClaude(userText, modelId, {
    stream: true,
    sessionId,
    systemPrompt: sessionId ? null : systemPrompt,
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Anthropic streaming: message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
  sseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant',
      content: [], model: modelId,
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  sseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });

  let aborted = false;
  req.on('close', () => {
    aborted = true;
    try { child.kill(); } catch {}
  });

  let buf = '';
  let capturedSessionId = null;
  let stderrBuf = '';
  let sentAnyText = false;

  const timeout = setTimeout(() => {
    try { child.kill(); } catch {}
  }, REQUEST_TIMEOUT_MS);

  child.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });

  return new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      if (aborted) return;
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }

        // Capture session_id from any event that carries it
        if (event.session_id && !capturedSessionId) {
          capturedSessionId = event.session_id;
          saveSession(modelId, agentId, capturedSessionId);
        }

        // Forward text deltas as Anthropic content_block_delta events
        if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
          sseEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: event.event.delta.text },
          });
          sentAnyText = true;
        }
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (aborted) { resolve(); return; }

      if (code !== 0 && !sentAnyText) {
        console.error(`[claude:${modelId}] exit ${code}: ${stderrBuf.trim()}`);
        if (sessionId) clearSession(modelId, agentId);
        // Send error as a text delta so the client sees it
        sseEvent(res, 'content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: `[bridge error] ${stderrBuf.trim() || `claude exited with code ${code}`}` },
        });
      }

      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      sseEvent(res, 'message_stop', { type: 'message_stop' });
      res.end();
      resolve();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!aborted) {
        console.error(`[claude:${modelId}] spawn error:`, err.message);
        sseEvent(res, 'content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: `[bridge error] ${err.message}` },
        });
        sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sseEvent(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        sseEvent(res, 'message_stop', { type: 'message_stop' });
        res.end();
      }
      resolve();
    });
  });
}

async function handleNonStream(res, userText, modelId, agentId, sessionId, systemPrompt, msgId) {
  return _doNonStream(res, userText, modelId, agentId, sessionId, systemPrompt, msgId, true);
}

async function _doNonStream(res, userText, modelId, agentId, sessionId, systemPrompt, msgId, canRetry) {
  const child = spawnClaude(userText, modelId, {
    stream: false,
    sessionId,
    systemPrompt: sessionId ? null : systemPrompt,
  });

  let stdout = '';
  let stderr = '';

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      if (!res.headersSent) {
        const err = anthropicError(504, 'api_error', 'request timeout');
        jsonResponse(res, err.status, err.body);
      }
      resolve();
    }, REQUEST_TIMEOUT_MS);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('exit', async (code) => {
      clearTimeout(timeout);
      if (res.headersSent) { resolve(); return; }

      if (code !== 0) {
        console.error(`[claude:${modelId}] exit ${code}: ${stderr.trim()}`);
        // If we used --resume and it failed, retry without it
        if (sessionId && canRetry) {
          console.log(`[claude:${modelId}] retrying without --resume for agent=${agentId}`);
          clearSession(modelId, agentId);
          try {
            await _doNonStream(res, userText, modelId, agentId, null, systemPrompt, msgId, false);
          } catch (err) {
            if (!res.headersSent) {
              const e = anthropicError(500, 'api_error', err.message);
              jsonResponse(res, e.status, e.body);
            }
          }
          resolve();
          return;
        }
        const err = anthropicError(500, 'api_error', stderr.trim() || `claude exited with code ${code}`);
        jsonResponse(res, err.status, err.body);
        resolve();
        return;
      }

      try {
        const result = JSON.parse(stdout);

        if (result.session_id) {
          saveSession(modelId, agentId, result.session_id);
        }

        const content = result.result || '';
        const usage = result.usage || {};

        jsonResponse(res, 200, {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: content }],
          model: modelId,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          },
        });
      } catch {
        // Fallback: stdout may be plain text if JSON parsing fails
        jsonResponse(res, 200, {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: stdout.trim() }],
          model: modelId,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      }
      resolve();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!res.headersSent) {
        const e = anthropicError(500, 'api_error', err.message);
        jsonResponse(res, e.status, e.body);
      }
      resolve();
    });
  });
}

// --- OpenAI-compatible /v1/chat/completions handlers ---

async function handleChatCompletions(req, res, body) {
  const { messages, stream, model } = body;
  if (!messages || !Array.isArray(messages)) {
    return jsonResponse(res, 400, { error: { message: 'messages array required', type: 'invalid_request_error' } });
  }

  const resolvedModel = (model && VALID_MODEL_IDS.has(model)) ? model : DEFAULT_MODEL;

  // OpenAI format has system message inside the messages array (role: "system")
  const systemMsg = messages.find(m => m.role === 'system');
  const sysText = systemMsg ? extractTextContent(systemMsg.content) : '';

  let agentId = null;
  const metaMatch = sysText.match(/"chat_id"\s*:\s*"([^"]+)"/);
  if (metaMatch) agentId = metaMatch[1];
  if (!agentId) agentId = 'default';

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    return jsonResponse(res, 400, { error: { message: 'no user message found', type: 'invalid_request_error' } });
  }
  const userText = stripOpenClawMeta(extractTextContent(lastUserMsg.content));
  if (!userText) {
    return jsonResponse(res, 400, { error: { message: 'empty user message', type: 'invalid_request_error' } });
  }

  console.log(`[req/oai] model=${resolvedModel} agent=${agentId} stream=${!!stream} msgs=${messages.length}`);

  const prevCount = agentMessageCounts.get(agentId) || 0;
  agentMessageCounts.set(agentId, messages.length);
  const countDropped = prevCount > 0 && messages.length < prevCount;
  const hasStartupMarker = /new session was started/i.test(userText);
  const newSession = countDropped || hasStartupMarker;
  if (newSession) {
    console.log(`[req/oai] new session for agent=${agentId}`);
    clearSession(resolvedModel, agentId);
  }

  const systemPrompt = sysText || null;

  if (activeRequests >= MAX_CONCURRENT) {
    return jsonResponse(res, 429, { error: { message: 'too many concurrent requests', type: 'rate_limit_error' } });
  }

  activeRequests++;
  const lockKey = `${resolvedModel}:${agentId}`;
  const releaseLock = await acquireLock(lockKey);

  try {
    const sessionId = getSession(resolvedModel, agentId);
    const completionId = `chatcmpl_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      await handleChatStream(req, res, userText, resolvedModel, agentId, sessionId, systemPrompt, completionId, created);
    } else {
      await handleChatNonStream(res, userText, resolvedModel, agentId, sessionId, systemPrompt, completionId, created);
    }
  } catch (err) {
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: { message: err.message || 'internal error', type: 'api_error' } });
    }
  } finally {
    releaseLock();
    activeRequests--;
  }
}

async function handleChatStream(req, res, userText, modelId, agentId, sessionId, systemPrompt, completionId, created) {
  const child = spawnClaude(userText, modelId, {
    stream: true,
    sessionId,
    systemPrompt: sessionId ? null : systemPrompt,
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const oaiChunk = (delta, finishReason = null) => `data: ${JSON.stringify({
    id: completionId, object: 'chat.completion.chunk', created, model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

  // Initial chunk establishes the assistant role
  res.write(oaiChunk({ role: 'assistant', content: '' }));

  let aborted = false;
  req.on('close', () => { aborted = true; try { child.kill(); } catch {} });

  let buf = '';
  let stderrBuf = '';
  let sentAnyText = false;
  const timeout = setTimeout(() => { try { child.kill(); } catch {} }, REQUEST_TIMEOUT_MS);

  child.stderr.on('data', ch => { stderrBuf += ch.toString(); });

  return new Promise((resolve) => {
    child.stdout.on('data', (ch) => {
      if (aborted) return;
      buf += ch.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.session_id) saveSession(modelId, agentId, event.session_id);
        if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
          res.write(oaiChunk({ content: event.event.delta.text }));
          sentAnyText = true;
        }
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (aborted) { resolve(); return; }
      if (code !== 0 && !sentAnyText) {
        console.error(`[claude:${modelId}/oai] exit ${code}: ${stderrBuf.trim()}`);
        if (sessionId) clearSession(modelId, agentId);
        res.write(oaiChunk({ content: `[bridge error] ${stderrBuf.trim() || `claude exited with code ${code}`}` }));
      }
      res.write(oaiChunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      resolve();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!aborted) {
        res.write(oaiChunk({ content: `[bridge error] ${err.message}` }));
        res.write(oaiChunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      }
      resolve();
    });
  });
}

async function handleChatNonStream(res, userText, modelId, agentId, sessionId, systemPrompt, completionId, created) {
  return _doChatNonStream(res, userText, modelId, agentId, sessionId, systemPrompt, completionId, created, true);
}

async function _doChatNonStream(res, userText, modelId, agentId, sessionId, systemPrompt, completionId, created, canRetry) {
  const child = spawnClaude(userText, modelId, {
    stream: false,
    sessionId,
    systemPrompt: sessionId ? null : systemPrompt,
  });

  let stdout = '';
  let stderr = '';

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      if (!res.headersSent) jsonResponse(res, 504, { error: { message: 'request timeout', type: 'api_error' } });
      resolve();
    }, REQUEST_TIMEOUT_MS);

    child.stdout.on('data', ch => { stdout += ch.toString(); });
    child.stderr.on('data', ch => { stderr += ch.toString(); });

    child.on('exit', async (code) => {
      clearTimeout(timeout);
      if (res.headersSent) { resolve(); return; }

      if (code !== 0) {
        console.error(`[claude:${modelId}/oai] exit ${code}: ${stderr.trim()}`);
        if (sessionId && canRetry) {
          clearSession(modelId, agentId);
          try {
            await _doChatNonStream(res, userText, modelId, agentId, null, systemPrompt, completionId, created, false);
          } catch (err) {
            if (!res.headersSent) jsonResponse(res, 500, { error: { message: err.message, type: 'api_error' } });
          }
          resolve();
          return;
        }
        jsonResponse(res, 500, { error: { message: stderr.trim() || `claude exited with code ${code}`, type: 'api_error' } });
        resolve();
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (result.session_id) saveSession(modelId, agentId, result.session_id);
        const content = result.result || '';
        const usage = result.usage || {};
        jsonResponse(res, 200, {
          id: completionId, object: 'chat.completion', created, model: modelId,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          },
        });
      } catch {
        jsonResponse(res, 200, {
          id: completionId, object: 'chat.completion', created, model: modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: stdout.trim() }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      resolve();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!res.headersSent) jsonResponse(res, 500, { error: { message: err.message, type: 'api_error' } });
      resolve();
    });
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
      id: m.id, object: 'model', created: 1700000000, owned_by: 'anthropic',
    })),
  };
}

// --- Server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  console.log(`[http] ${req.method} ${path} ua=${req.headers['user-agent'] || '-'}`);

  if (path === '/health' && req.method === 'GET') {
    return jsonResponse(res, 200, {
      status: 'ok',
      active: activeRequests,
      max: MAX_CONCURRENT,
      sessions: sessions.size,
      models: MODELS.map(m => m.id),
    });
  }

  if (path === '/v1/models' && req.method === 'GET') {
    return jsonResponse(res, 200, modelsResponse());
  }

  if (path === '/v1/messages' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return await handleMessages(req, res, body);
    } catch (err) {
      const e = anthropicError(400, 'invalid_request_error', err.message);
      return jsonResponse(res, e.status, e.body);
    }
  }

  // OpenAI-compatible endpoint for clients like Hermes
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return await handleChatCompletions(req, res, body);
    } catch (err) {
      return jsonResponse(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
    }
  }

  const err = anthropicError(404, 'not_found_error', 'not found');
  jsonResponse(res, err.status, err.body);
});

server.listen(PORT, HOST, () => {
  console.log(`claude-bridge listening on http://${HOST}:${PORT}`);
  console.log(`API: Anthropic Messages (POST /v1/messages)`);
  console.log(`Models: ${MODELS.map(m => m.id).join(', ')}`);
  console.log(`Mode: spawn-per-request (claude -p --resume)`);
  console.log(`Bare mode: ${BARE_MODE ? 'on' : 'off'}`);
  console.log(`Session cwd: ${CLAUDE_CWD}  (use /resume here to see bridge sessions)`);
});

// Cleanup
const cleanup = () => {
  console.log('Shutting down claude-bridge...');
  server.close();
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
