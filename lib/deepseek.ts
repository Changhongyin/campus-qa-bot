/**
 * DeepSeek client built on global fetch (no dependencies).
 * - streamCompletion: OpenAI-compatible SSE streaming with robust parsing.
 * - complete: single JSON call, used by the intent classifier and the JSON chat path.
 * Errors are normalized to DeepSeekError and never contain the API key or upstream bodies.
 */
import { config } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage | null;
  finishReason: string | null;
}

export type DeepSeekErrorKind = 'timeout' | 'upstream' | 'network';

export class DeepSeekError extends Error {
  readonly kind: DeepSeekErrorKind;
  readonly status: number | null;

  constructor(kind: DeepSeekErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'DeepSeekError';
    this.kind = kind;
    this.status = status;
  }
}

interface CallSignals {
  signal: AbortSignal;
  timeout: AbortSignal;
}

/** AbortSignal.any with a manual fallback for runtimes that lack it. */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') {
    return native.call(AbortSignal, signals);
  }
  const controller = new AbortController();
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

function buildSignals(external?: AbortSignal): CallSignals {
  const timeout = AbortSignal.timeout(config.deepseekTimeoutMs);
  const signal = external ? combineSignals([external, timeout]) : timeout;
  return { signal, timeout };
}

function normalizeError(err: unknown, external: AbortSignal | undefined, timeout: AbortSignal): DeepSeekError {
  if (err instanceof DeepSeekError) return err;
  if (external?.aborted) return new DeepSeekError('network', 'DeepSeek request aborted by the caller');
  if (timeout.aborted) return new DeepSeekError('timeout', 'DeepSeek request timed out');
  return new DeepSeekError('network', 'DeepSeek request failed before a response was received');
}

function ensureKey(): void {
  if (config.deepseekApiKey.length === 0) {
    throw new DeepSeekError('upstream', 'DeepSeek API key is not configured');
  }
}

function requestHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + config.deepseekApiKey,
  };
}

async function discardBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // Nothing useful can be done if the body is already closed.
  }
}

function readUsage(raw: unknown): Usage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const promptTokens = record.prompt_tokens;
  const completionTokens = record.completion_tokens;
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens };
}

interface JsonChoice {
  message?: { content?: unknown };
  finish_reason?: unknown;
}

interface JsonCompletion {
  choices?: JsonChoice[];
  usage?: unknown;
}

interface StreamChoice {
  delta?: { content?: unknown };
  finish_reason?: unknown;
}

interface StreamChunk {
  choices?: StreamChoice[];
  usage?: unknown;
}

/** Non-streaming completion. The returned text is trimmed. */
export async function complete(params: {
  messages: ChatMessage[];
  signal?: AbortSignal;
}): Promise<CompletionResult> {
  ensureKey();
  const { signal, timeout } = buildSignals(params.signal);
  try {
    const resp = await fetch(config.deepseekApiUrl, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({
        model: config.deepseekModel,
        temperature: config.deepseekTemperature,
        max_tokens: config.deepseekMaxTokens,
        messages: params.messages,
      }),
      signal,
    });
    if (!resp.ok) {
      await discardBody(resp);
      throw new DeepSeekError('upstream', 'DeepSeek responded with HTTP ' + resp.status, resp.status);
    }
    const data: unknown = await resp.json();
    const parsed = (typeof data === 'object' && data !== null ? data : {}) as JsonCompletion;
    const first = parsed.choices?.[0];
    const content = first?.message?.content;
    const finish = first?.finish_reason;
    return {
      text: typeof content === 'string' ? content.trim() : '',
      usage: readUsage(parsed.usage),
      finishReason: typeof finish === 'string' ? finish : null,
    };
  } catch (err) {
    throw normalizeError(err, params.signal, timeout);
  }
}

/**
 * Streaming completion. onToken receives every non-empty content delta in order.
 * The returned text is the raw concatenation of all deltas (not trimmed).
 */
export async function streamCompletion(params: {
  messages: ChatMessage[];
  signal?: AbortSignal;
  onToken: (text: string) => void | Promise<void>;
}): Promise<CompletionResult> {
  ensureKey();
  const { signal, timeout } = buildSignals(params.signal);
  try {
    const resp = await fetch(config.deepseekApiUrl, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({
        model: config.deepseekModel,
        temperature: config.deepseekTemperature,
        max_tokens: config.deepseekMaxTokens,
        messages: params.messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
    if (!resp.ok) {
      await discardBody(resp);
      throw new DeepSeekError('upstream', 'DeepSeek responded with HTTP ' + resp.status, resp.status);
    }
    if (!resp.body) {
      throw new DeepSeekError('upstream', 'DeepSeek returned an empty response body');
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let text = '';
    let usage: Usage | null = null;
    let finishReason: string | null = null;
    let sawDoneMarker = false;

    const handleEvent = async (rawEvent: string): Promise<void> => {
      const dataLines: string[] = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length === 0) return;
      const payload = dataLines.join('\n').trim();
      if (payload.length === 0) return;
      if (payload === '[DONE]') {
        sawDoneMarker = true;
        return;
      }
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(payload);
      } catch {
        return;
      }
      const chunk = (typeof parsedValue === 'object' && parsedValue !== null ? parsedValue : {}) as StreamChunk;
      const choice = chunk.choices?.[0];
      const piece = choice?.delta?.content;
      if (typeof piece === 'string' && piece.length > 0) {
        text += piece;
        await params.onToken(piece);
      }
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      const chunkUsage = readUsage(chunk.usage);
      if (chunkUsage) usage = chunkUsage;
    };

    const reader = resp.body.getReader();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          await handleEvent(rawEvent);
          boundary = buffer.indexOf('\n\n');
        }
        if (sawDoneMarker) break;
      }
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, '\n');
      if (!sawDoneMarker && buffer.trim().length > 0) {
        await handleEvent(buffer);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream is already closed or errored.
      }
    }

    return { text, usage, finishReason };
  } catch (err) {
    throw normalizeError(err, params.signal, timeout);
  }
}
