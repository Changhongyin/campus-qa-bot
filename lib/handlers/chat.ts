/**
 * POST /api/chat
 *  - stream !== true: legacy-compatible JSON response (additive fields only).
 *  - stream === true: Server-Sent Events with staged thoughts, tokens and one terminal event.
 *
 * Client disconnects abort the upstream DeepSeek call through an AbortController that is
 * wired to the response 'close' event (the request 'close' event fires when the body has
 * been read in modern Node, so it cannot be used to detect a disconnect).
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { errorLabel } from '../redact.js';
import { openSse } from '../sse.js';
import { complete, streamCompletion, DeepSeekError } from '../deepseek.js';
import type { ChatMessage } from '../deepseek.js';
import { intentThought, retrieveThought, rankThought, composeThought } from '../thoughts.js';
import type { IntentDecision, IntentVia } from '../thoughts.js';
import { quickGate, classifyIntent, hasCampusTerm, REFUSAL_TEXT } from '../gate.js';
import { buildSystemPrompt } from '../prompt.js';
import { buildSnippets } from '../snippets.js';
import type { Chunk, Retriever, SearchResult } from '../retriever.js';

const MAX_MESSAGES = 10;
const MAX_CONTENT_CHARS = 2000;
const MAX_TOTAL_CHARS = 12000;
const MAX_SESSION_ID_CHARS = 64;
const TOP_K = 3;
const OFFLINE_MAX_CHARS = 600;

const MISSING_MESSAGE = '请求中缺少用户消息 messages';
const OFFLINE_MISS_REPLY = '知识库暂未收录该问题，建议咨询学校官方渠道。';

export interface ChatHandlerDeps {
  retriever: Pick<Retriever, 'search'>;
}

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

type ParsedBody =
  | { ok: true; history: HistoryMessage[]; stream: boolean }
  | { ok: false; message: string };

function fail(message: string): ParsedBody {
  return { ok: false, message };
}

/** Validates the chat request body against contract section 5.1. */
export function parseChatBody(body: unknown): ParsedBody {
  const obj = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const raw = obj.messages;
  if (!Array.isArray(raw)) return fail(MISSING_MESSAGE);

  const history: HistoryMessage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const message = item as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string') continue;
    history.push({ role: message.role, content: message.content.trim() });
  }

  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    return fail(MISSING_MESSAGE);
  }
  if (history.length > MAX_MESSAGES) return fail('单次最多携带 10 条消息，请精简后重试');

  let total = 0;
  for (const message of history) {
    if (message.content.length < 1 || message.content.length > MAX_CONTENT_CHARS) {
      return fail('每条消息需为 1 到 2000 个字符');
    }
    total += message.content.length;
  }
  if (total > MAX_TOTAL_CHARS) return fail('对话内容过长（总计不超过 12000 个字符）');

  const sessionId = obj.sessionId;
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== 'string' || sessionId.length > MAX_SESSION_ID_CHARS) {
      return fail('sessionId 无效');
    }
  }

  return { ok: true, history, stream: obj.stream === true };
}

interface ErrorInfo {
  status: number;
  code: 'UPSTREAM_ERROR' | 'TIMEOUT' | 'INTERNAL';
  message: string;
}

function mapError(err: unknown): ErrorInfo {
  if (err instanceof DeepSeekError) {
    if (err.kind === 'timeout') {
      return { status: 504, code: 'TIMEOUT', message: '模型响应超时，请稍后再试' };
    }
    return { status: 502, code: 'UPSTREAM_ERROR', message: '模型服务暂时不可用，请稍后再试' };
  }
  return { status: 500, code: 'INTERNAL', message: '服务器内部错误，请稍后再试' };
}

function logFailure(requestId: string, err: unknown, info: ErrorInfo): void {
  // Only request id, stable code and error label: never user content, never upstream bodies.
  console.error('[chat] ' + requestId + ' ' + info.code + ' ' + errorLabel(err));
}

function toIntentDecision(decision: string): IntentDecision {
  if (decision === 'campus') return 'campus';
  if (decision === 'offtopic') return 'offtopic';
  return 'unknown';
}

function sourceSuffix(sources: string[]): string {
  return '\n\n【来源：' + sources.join('、') + '】';
}

interface RetrievalView {
  hit: boolean;
  hitChunks: Chunk[];
  hitScores: number[];
  hitCount: number;
  hitSources: string[];
  topScore: number;
}

function evaluate(sr: SearchResult): RetrievalView {
  const topScore = sr.scores[0] ?? 0;
  const hit = sr.chunks.length > 0 && topScore >= config.sourceThreshold;
  const hitChunks: Chunk[] = [];
  const hitScores: number[] = [];
  if (hit) {
    sr.chunks.forEach((chunk, index) => {
      const score = sr.scores[index] ?? 0;
      if (score >= config.sourceThreshold) {
        hitChunks.push(chunk);
        hitScores.push(score);
      }
    });
  }
  return {
    hit,
    hitChunks,
    hitScores,
    hitCount: hitChunks.length,
    hitSources: Array.from(new Set(hitChunks.map((chunk) => chunk.source))),
    topScore,
  };
}

function offlineReply(sr: SearchResult, hit: boolean): string {
  return hit
    ? sr.chunks.map((chunk) => chunk.text).join('\n\n').slice(0, OFFLINE_MAX_CHARS)
    : OFFLINE_MISS_REPLY;
}

function makeAsk(signal: AbortSignal): (system: string, user: string) => Promise<string> {
  return async (system: string, user: string): Promise<string> => {
    const result = await complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      signal,
    });
    return result.text;
  };
}

interface RetrievalOutcome {
  result: SearchResult;
  ms: number;
}

function startRetrieval(deps: ChatHandlerDeps, question: string): Promise<RetrievalOutcome> {
  const started = Date.now();
  const promise = deps.retriever
    .search(question, TOP_K)
    .then((result) => ({ result, ms: Date.now() - started }));
  // Attach a no-op handler so a result that is ignored can never become an unhandled rejection.
  promise.catch(() => undefined);
  return promise;
}

/** Forwards tokens trimmed like String.trim(), holding back trailing whitespace until more text follows. */
function createTrimmingForwarder(emit: (text: string) => Promise<void>) {
  let started = false;
  let pending = '';
  let accumulated = '';
  return {
    async push(token: string): Promise<void> {
      let chunk = token;
      if (!started) {
        chunk = chunk.replace(/^\s+/, '');
        if (chunk.length === 0) return;
        started = true;
      }
      const trailing = /\s+$/.exec(chunk)?.[0] ?? '';
      const body = chunk.slice(0, chunk.length - trailing.length);
      if (body.length === 0) {
        pending += trailing;
        return;
      }
      const out = pending + body;
      pending = trailing;
      accumulated += out;
      await emit(out);
    },
    text(): string {
      return accumulated;
    },
  };
}

interface RunContext {
  deps: ChatHandlerDeps;
  res: Response;
  requestId: string;
  startedAt: number;
  history: HistoryMessage[];
  question: string;
  signal: AbortSignal;
  isGone: () => boolean;
}

async function runJson(ctx: RunContext): Promise<void> {
  const { deps, res, requestId, startedAt, history, question, signal } = ctx;
  const mode = config.deepseekApiKey.length > 0 ? 'deepseek' : 'offline';
  try {
    let decision = quickGate(question);
    if (decision === 'unknown') {
      const contextCampus = history.slice(0, -1).some((message) => hasCampusTerm(message.content));
      if (contextCampus) {
        decision = 'campus';
      } else if (config.deepseekApiKey.length > 0) {
        decision = await classifyIntent(question, makeAsk(signal));
      } else {
        decision = 'offtopic';
      }
    }
    if (ctx.isGone()) return;
    if (decision === 'offtopic') {
      res.json({
        reply: REFUSAL_TEXT,
        badge: 'refusal',
        sources: [],
        engine: 'none',
        mode,
        requestId,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const sr = await deps.retriever.search(question, TOP_K);
    const view = evaluate(sr);
    const badge = view.hit ? 'knowledge' : 'general';

    if (config.deepseekApiKey.length === 0) {
      if (ctx.isGone()) return;
      res.json({
        reply: offlineReply(sr, view.hit),
        badge,
        sources: sr.sources,
        engine: sr.engine,
        mode,
        requestId,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(sr.chunks) }, ...history];
    const result = await complete({ messages, signal });
    if (ctx.isGone()) return;
    const reply = view.hit ? result.text + sourceSuffix(sr.sources) : result.text;
    res.json({
      reply,
      badge,
      sources: sr.sources,
      engine: sr.engine,
      mode,
      requestId,
      latencyMs: Date.now() - startedAt,
      ...(result.usage ? { usage: result.usage } : {}),
    });
  } catch (err) {
    if (ctx.isGone()) return;
    const info = mapError(err);
    logFailure(requestId, err, info);
    if (!res.headersSent) {
      res.status(info.status).json({ error: info.message, code: info.code, requestId });
    }
  }
}

async function runStream(ctx: RunContext): Promise<void> {
  const { deps, res, requestId, startedAt, history, question, signal } = ctx;
  const mode = config.deepseekApiKey.length > 0 ? 'deepseek' : 'offline';
  const sse = openSse(res);
  const stopHeartbeat = sse.startHeartbeat(config.sseHeartbeatMs);
  let finished = false;

  const terminate = async (event: 'done' | 'error', data: unknown): Promise<void> => {
    if (finished) return;
    finished = true;
    stopHeartbeat();
    await sse.send(event, data);
    sse.close();
  };

  try {
    await sse.send('meta', { requestId, mode, model: config.deepseekModel, ts: Date.now() });

    // Stage 1: intent. Everything here is synchronous, so the first thought goes out at once.
    let decision = quickGate(question);
    let via: IntentVia = 'rules';
    if (decision === 'unknown') {
      const contextCampus = history.slice(0, -1).some((message) => hasCampusTerm(message.content));
      if (contextCampus) {
        decision = 'campus';
        via = 'context';
      } else if (config.deepseekApiKey.length === 0) {
        decision = 'offtopic';
        via = 'fallback';
      }
    }
    await sse.send(
      'thought',
      intentThought({ decision: toIntentDecision(decision), via, ms: Date.now() - startedAt }),
    );

    // Retrieval runs in parallel with the classifier; it is ignored if the question is refused.
    let retrieval: Promise<RetrievalOutcome> | null = null;
    if (decision !== 'offtopic') {
      retrieval = startRetrieval(deps, question);
    }
    if (decision === 'unknown') {
      decision = await classifyIntent(question, makeAsk(signal));
    }
    if (ctx.isGone()) return;

    if (decision === 'offtopic') {
      const composeStart = Date.now();
      await sse.send('thought', composeThought({ ms: Date.now() - composeStart, refusal: true }));
      await sse.send('token', { text: REFUSAL_TEXT });
      await terminate('done', {
        reply: REFUSAL_TEXT,
        badge: 'refusal',
        sources: [],
        engine: 'none',
        latencyMs: Date.now() - startedAt,
        requestId,
      });
      return;
    }

    const outcome = await (retrieval ?? startRetrieval(deps, question));
    if (ctx.isGone()) return;
    const sr = outcome.result;

    // Stage 3 work: threshold evaluation and verbatim evidence snippets (hit chunks only).
    const rankStart = Date.now();
    const view = evaluate(sr);
    const snippets = view.hit ? buildSnippets(question, view.hitChunks, view.hitScores) : [];
    const rankMs = Date.now() - rankStart;
    const badge = view.hit ? 'knowledge' : 'general';

    await sse.send(
      'thought',
      retrieveThought({
        hits: view.hitCount,
        sources: view.hitSources,
        topScore: view.topScore,
        ms: outcome.ms,
        snippets,
      }),
    );
    await sse.send('thought', rankThought({ ms: rankMs }));

    const composeStart = Date.now();
    if (config.deepseekApiKey.length === 0) {
      const reply = offlineReply(sr, view.hit);
      await sse.send('thought', composeThought({ ms: Date.now() - composeStart, mode: 'offline' }));
      if (reply.length > 0) await sse.send('token', { text: reply });
      await terminate('done', {
        reply,
        badge,
        sources: sr.sources,
        engine: sr.engine,
        latencyMs: Date.now() - startedAt,
        requestId,
        ...(snippets.length > 0 ? { snippets } : {}),
      });
      return;
    }

    const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(sr.chunks) }, ...history];
    await sse.send('thought', composeThought({ ms: Date.now() - composeStart, mode: 'deepseek' }));

    const forwarder = createTrimmingForwarder((text) => sse.send('token', { text }));
    const result = await streamCompletion({
      messages,
      signal,
      onToken: (text) => forwarder.push(text),
    });
    if (ctx.isGone()) return;

    let reply = forwarder.text();
    if (view.hit) {
      const suffix = sourceSuffix(sr.sources);
      reply += suffix;
      await sse.send('token', { text: suffix });
    }
    await terminate('done', {
      reply,
      badge,
      sources: sr.sources,
      engine: sr.engine,
      latencyMs: Date.now() - startedAt,
      requestId,
      ...(snippets.length > 0 ? { snippets } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    });
  } catch (err) {
    if (ctx.isGone() || finished) return;
    const info = mapError(err);
    logFailure(requestId, err, info);
    await terminate('error', { code: info.code, message: info.message });
  } finally {
    stopHeartbeat();
    if (!finished && !ctx.isGone()) {
      await terminate('error', { code: 'INTERNAL', message: '服务器内部错误，请稍后再试' });
    }
    sse.close();
  }
}

export function createChatHandler(deps: ChatHandlerDeps) {
  return async function chatHandler(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now();
    const requestId = 'req_' + randomUUID().replace(/-/g, '').slice(0, 20);
    res.setHeader('X-Request-Id', requestId);
    try {
      const parsed = parseChatBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.message, code: 'BAD_REQUEST' });
        return;
      }

      const controller = new AbortController();
      let clientGone = false;
      res.on('close', () => {
        if (!res.writableFinished) {
          clientGone = true;
          controller.abort();
        }
      });

      const ctx: RunContext = {
        deps,
        res,
        requestId,
        startedAt,
        history: parsed.history,
        question: parsed.history[parsed.history.length - 1].content,
        signal: controller.signal,
        isGone: () => clientGone,
      };

      if (parsed.stream) {
        await runStream(ctx);
      } else {
        await runJson(ctx);
      }
    } catch (err) {
      console.error('[chat] ' + requestId + ' INTERNAL ' + errorLabel(err));
      if (!res.headersSent) {
        res.status(500).json({ error: '服务器内部错误，请稍后再试', code: 'INTERNAL' });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

