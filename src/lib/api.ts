import type {
  ChatRequest,
  FeedbackRequest,
  FeedbackResponse,
  HealthResponse,
  UploadRequest,
  UploadResponse,
} from '../types';

export class ApiError extends Error {
  public readonly code: string;

  public readonly status: number;

  public constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

interface ErrorPayload {
  error?: unknown;
  code?: unknown;
  message?: unknown;
}

const apiBase = (
  import.meta.env.VITE_API_BASE_URL ?? window.location.origin
).replace(/\/$/, '');

function endpoint(path: string): string {
  return `${apiBase}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }

  const candidate =
    typeof payload.error === 'string'
      ? payload.error
      : typeof payload.message === 'string'
        ? payload.message
        : fallback;

  return candidate;
}

function errorCode(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.code !== 'string') {
    return 'REQUEST_FAILED';
  }

  return payload.code;
}

export async function readErrorResponse(response: Response): Promise<ApiError> {
  let payload: ErrorPayload | null = null;

  try {
    const raw: unknown = await response.json();
    payload = isRecord(raw) ? raw : null;
  } catch {
    payload = null;
  }

  return new ApiError(
    errorMessage(payload, `Request failed with status ${response.status}.`),
    errorCode(payload),
    response.status,
  );
}

export function createChatRequest(
  messages: ChatRequest['messages'],
  sessionId: string,
): ChatRequest {
  return {
    messages,
    stream: true,
    sessionId,
  };
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(endpoint('/api/health'), {
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  if (!response.ok) {
    throw await readErrorResponse(response);
  }

  return (await response.json()) as HealthResponse;
}

export async function submitUpload(
  payload: UploadRequest,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  const response = await fetch(endpoint('/api/upload'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw await readErrorResponse(response);
  }

  return (await response.json()) as UploadResponse;
}

export async function submitFeedback(
  payload: FeedbackRequest,
  signal?: AbortSignal,
): Promise<FeedbackResponse> {
  const response = await fetch(endpoint('/api/feedback'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw await readErrorResponse(response);
  }

  return (await response.json()) as FeedbackResponse;
}

export function chatEndpoint(): string {
  return endpoint('/api/chat');
}
