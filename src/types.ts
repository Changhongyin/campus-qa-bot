export type Role = 'user' | 'assistant';

export type Badge = 'knowledge' | 'general' | 'refusal' | 'personal';

export type Phase =
  | 'idle'
  | 'connecting'
  | 'thinking'
  | 'streaming'
  | 'done'
  | 'error';

export type View = 'landing' | 'chat';

export type ThoughtStage = 'intent' | 'retrieve' | 'rank' | 'compose';

export type ChatMode = 'deepseek' | 'offline' | 'unknown';

export interface SourceSnippet {
  source: string;
  title: string;
  text: string;
  score: number;
}

export interface ThoughtDetail {
  hits?: number;
  sources?: string[];
  topScore?: number;
  snippets?: SourceSnippet[];
}

export interface Thought {
  stage: ThoughtStage;
  text: string;
  ms: number;
  detail?: ThoughtDetail;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  badge?: Badge;
  sources?: string[];
  snippets?: SourceSnippet[];
  thoughts?: Thought[];
  requestId?: string;
  interrupted?: boolean;
  error?: string;
  createdAt: number;
}

export interface ChatState {
  view: View;
  messages: Message[];
  phase: Phase;
  isStreaming: boolean;
  streamText: string;
  thoughts: Thought[];
  thoughtText: string;
  sources: string[];
  badge: Badge | null;
  error: string | null;
  canStop: boolean;
  canRegenerate: boolean;
  uploadOpen: boolean;
  mode: ChatMode;
  ttsEnabled: boolean;
  contributionsEnabled: boolean;
  activeRequestId: string | null;
}

export interface ChatRequestMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  messages: ChatRequestMessage[];
  stream: true;
  sessionId?: string;
}

export interface ChatResponse {
  reply: string;
  badge: Exclude<Badge, 'personal'>;
  sources: string[];
  engine: 'embedding' | 'tfidf';
  mode: Exclude<ChatMode, 'unknown'>;
  requestId: string;
  latencyMs: number;
  snippets?: SourceSnippet[];
}

export interface ChatMetaEvent {
  type: 'meta';
  requestId: string;
  mode: Exclude<ChatMode, 'unknown'>;
  model?: string;
  ts?: number;
}

export interface ChatThoughtEvent {
  type: 'thought';
  thought: Thought;
}

export interface ChatTokenEvent {
  type: 'token';
  text: string;
}

export interface ChatDoneEvent {
  type: 'done';
  response: Omit<ChatResponse, 'mode' | 'engine'>;
}

export interface ChatErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

export interface ChatWarnEvent {
  type: 'warn';
  message: string;
}

export type ChatStreamEvent =
  | ChatMetaEvent
  | ChatThoughtEvent
  | ChatTokenEvent
  | ChatDoneEvent
  | ChatErrorEvent
  | ChatWarnEvent;

export interface HealthResponse {
  ok: boolean;
  mode: Exclude<ChatMode, 'unknown'>;
  apiKeyConfigured: boolean;
  contributions: {
    enabled: boolean;
    mode: 'pr' | 'direct' | 'local';
    maxBytes: number;
  };
}

export interface UploadRequest {
  fileName: string;
  content: string;
  consent: true;
  contributor?: string;
  note?: string;
}

export interface UploadResponse {
  ok: true;
  status: 'pending_review' | 'committed' | 'local_only';
  submissionId: string;
  sha256: string;
  storedPath: string;
  pullRequestUrl?: string;
  message: string;
}

export interface FeedbackRequest {
  requestId?: string;
  rating: 'up' | 'down';
  reason?: string;
  comment?: string;
}

export interface FeedbackResponse {
  ok: boolean;
  recorded: boolean;
  issueUrl?: string;
}
