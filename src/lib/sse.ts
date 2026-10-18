import { chatEndpoint, createChatRequest, readErrorResponse, ApiError } from './api';
import type {
  ChatDoneEvent,
  ChatErrorEvent,
  ChatMetaEvent,
  ChatRequestMessage,
  ChatStreamEvent,
  ChatThoughtEvent,
  ChatTokenEvent,
  ChatWarnEvent,
  SourceSnippet,
  Thought,
  ThoughtDetail,
  ThoughtStage,
} from '../types';

export interface ChatStreamController {
  events: AsyncGenerator<ChatStreamEvent>;
  abort: () => void;
}

interface SseFrame {
  event: string;
  data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStage(value: unknown): value is ThoughtStage {
  return value === 'intent' || value === 'retrieve' || value === 'rank' || value === 'compose';
}

function parseSnippet(value: unknown): SourceSnippet | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.source !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.score !== 'number'
  ) {
    return null;
  }

  return {
    source: value.source,
    title: value.title,
    text: value.text,
    score: value.score,
  };
}

function parseSnippets(value: unknown): SourceSnippet[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const snippets = value
    .map(parseSnippet)
    .filter((snippet): snippet is SourceSnippet => snippet !== null);

  return snippets;
}

function parseThoughtDetail(value: unknown): ThoughtDetail | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const detail: ThoughtDetail = {};

  if (typeof value.hits === 'number') {
    detail.hits = value.hits;
  }

  if (isStringArray(value.sources)) {
    detail.sources = value.sources;
  }

  if (typeof value.topScore === 'number') {
    detail.topScore = value.topScore;
  }

  const snippets = parseSnippets(value.snippets);
  if (snippets !== undefined) {
    detail.snippets = snippets;
  }

  return Object.keys(detail).length > 0 ? detail : undefined;
}

function parseFrame(frame: string): SseFrame | null {
  const lines = frame.split('\n');

  if (lines.every((line) => line.startsWith(':') || line.trim() === '')) {
    return null;
  }

  let event = 'message';
  const data: string[] = [];

  for (const line of lines) {
    if (line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, '');

    if (field === 'event') {
      event = value;
    }

    if (field === 'data') {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return null;
  }

  return {
    event,
    data: data.join('\n'),
  };
}

function parseMeta(payload: Record<string, unknown>): ChatMetaEvent | null {
  if (
    typeof payload.requestId !== 'string' ||
    (payload.mode !== 'deepseek' && payload.mode !== 'offline')
  ) {
    return null;
  }

  return {
    type: 'meta',
    requestId: payload.requestId,
    mode: payload.mode,
    model: typeof payload.model === 'string' ? payload.model : undefined,
    ts: typeof payload.ts === 'number' ? payload.ts : undefined,
  };
}

function parseThought(payload: Record<string, unknown>): ChatThoughtEvent | null {
  if (
    !isStage(payload.stage) ||
    typeof payload.text !== 'string' ||
    typeof payload.ms !== 'number'
  ) {
    return null;
  }

  const thought: Thought = {
    stage: payload.stage,
    text: payload.text,
    ms: payload.ms,
    detail: parseThoughtDetail(payload.detail),
  };

  return {
    type: 'thought',
    thought,
  };
}

function parseToken(payload: Record<string, unknown>): ChatTokenEvent | null {
  if (typeof payload.text !== 'string') {
    return null;
  }

  return {
    type: 'token',
    text: payload.text,
  };
}

function parseDone(payload: Record<string, unknown>): ChatDoneEvent | null {
  if (
    typeof payload.reply !== 'string' ||
    (payload.badge !== 'knowledge' &&
      payload.badge !== 'general' &&
      payload.badge !== 'refusal') ||
    !isStringArray(payload.sources) ||
    typeof payload.latencyMs !== 'number' ||
    typeof payload.requestId !== 'string'
  ) {
    return null;
  }

  return {
    type: 'done',
    response: {
      reply: payload.reply,
      badge: payload.badge,
      sources: payload.sources,
      latencyMs: payload.latencyMs,
      requestId: payload.requestId,
      snippets: parseSnippets(payload.snippets),
    },
  };
}

function parseError(payload: Record<string, unknown>): ChatErrorEvent | null {
  if (typeof payload.code !== 'string' || typeof payload.message !== 'string') {
    return null;
  }

  return {
    type: 'error',
    code: payload.code,
    message: payload.message,
  };
}

function parseEvent(frame: SseFrame): ChatStreamEvent | null {
  let payload: unknown;

  try {
    payload = JSON.parse(frame.data) as unknown;
  } catch {
    return {
      type: 'warn',
      message: 'Malformed stream data.',
    };
  }

  if (!isRecord(payload)) {
    return {
      type: 'warn',
      message: 'Malformed stream payload.',
    };
  }

  switch (frame.event) {
    case 'meta':
      return parseMeta(payload) ?? {
        type: 'warn',
        message: 'Malformed meta event.',
      };
    case 'thought':
      return parseThought(payload) ?? {
        type: 'warn',
        message: 'Malformed thought event.',
      };
    case 'token':
      return parseToken(payload) ?? {
        type: 'warn',
        message: 'Malformed token event.',
      };
    case 'done':
      return parseDone(payload) ?? {
        type: 'warn',
        message: 'Malformed done event.',
      };
    case 'error':
      return parseError(payload) ?? {
        type: 'warn',
        message: 'Malformed error event.',
      };
    default:
      if (import.meta.env.DEV) {
        console.warn(`Unknown SSE event: ${frame.event}`);
      }
      return null;
  }
}

function toFallbackDone(payload: unknown): ChatDoneEvent {
  if (!isRecord(payload)) {
    throw new ApiError('Invalid non-streaming response.', 'INVALID_RESPONSE', 200);
  }

  const parsed = parseDone({
    ...payload,
    latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : 0,
  });

  if (parsed === null) {
    throw new ApiError('Invalid non-streaming response.', 'INVALID_RESPONSE', 200);
  }

  return parsed;
}

async function* readEvents(
  messages: ChatRequestMessage[],
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch(chatEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(createChatRequest(messages, sessionId)),
    signal,
  });

  if (!response.ok) {
    throw await readErrorResponse(response);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    yield toFallbackDone(await response.json());
    return;
  }

  if (response.body === null) {
    throw new ApiError('Response body is unavailable.', 'STREAM_INCOMPLETE', 200);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  let terminalReceived = false;
  let warningSent = false;

  const emitFrame = function* (rawFrame: string): Generator<ChatStreamEvent> {
    const frame = parseFrame(rawFrame);
    if (frame === null) {
      return;
    }

    const event = parseEvent(frame);
    if (event === null) {
      return;
    }

    if (event.type === 'warn') {
      if (!warningSent) {
        warningSent = true;
        yield event;
      }
      return;
    }

    if (event.type === 'done' || event.type === 'error') {
      terminalReceived = true;
    }

    yield event;
  };

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const event of emitFrame(rawFrame)) {
          yield event;
        }

        boundary = buffer.indexOf('\n\n');
      }
    }

    const remaining = buffer.replace(/\r\n/g, '\n').trim();
    if (remaining.length > 0) {
      for (const event of emitFrame(remaining)) {
        yield event;
      }
    }

    if (!terminalReceived) {
      throw new ApiError('Stream ended before a terminal event.', 'STREAM_INCOMPLETE', 200);
    }
  } finally {
    reader.releaseLock();
  }
}

export function createChatStream(
  messages: ChatRequestMessage[],
  sessionId: string,
): ChatStreamController {
  const controller = new AbortController();

  return {
    events: readEvents(messages, sessionId, controller.signal),
    abort: () => controller.abort(),
  };
}
