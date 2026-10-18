import { useCallback, useEffect, useReducer, useRef } from 'react';
import { copy } from '../copy';
import { ApiError } from '../lib/api';
import { createRevealPacer, type RevealPacer } from '../lib/reveal';
import { createChatStream } from '../lib/sse';
import type { ChatMode, ChatRequestMessage, ChatState, Message, SourceSnippet, Thought, View } from '../types';

const initialState: ChatState = { view: 'landing', messages: [], phase: 'idle', isStreaming: false, streamText: '', thoughts: [], thoughtText: '', sources: [], badge: null, error: null, canStop: false, canRegenerate: false, uploadOpen: false, mode: 'unknown', ttsEnabled: false, contributionsEnabled: false, activeRequestId: null };
type Action = { type: 'OPEN_CHAT' } | { type: 'SET_VIEW'; view: View } | { type: 'SEND'; message: Message } | { type: 'META'; requestId: string; mode: ChatMode } | { type: 'THOUGHT'; thought: Thought } | { type: 'TOKEN'; text: string } | { type: 'DONE'; message: Message; mode: ChatMode } | { type: 'STREAM_ERROR'; error: string } | { type: 'STOP'; message: Message | null } | { type: 'REGENERATE_START'; messages: Message[] } | { type: 'SET_UPLOAD_OPEN'; open: boolean } | { type: 'SET_TTS'; enabled: boolean } | { type: 'HEALTH'; mode: ChatMode; contributionsEnabled: boolean } | { type: 'CLEAR_ERROR' } | { type: 'PERSONAL_ANSWER'; user: Message; assistant: Message } | { type: 'CLEAR_MESSAGES' };
const last = <T,>(items: T[]): T | undefined => items[items.length - 1];
const canRegenerate = (messages: Message[], active: boolean): boolean => !active && last(messages)?.role === 'assistant';
const id = (prefix: string): string => `${prefix}_${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'OPEN_CHAT': return { ...state, view: 'chat' };
    case 'SET_VIEW': return { ...state, view: action.view };
    case 'SEND': return { ...state, messages: [...state.messages, action.message], phase: 'connecting', isStreaming: true, streamText: '', thoughts: [], thoughtText: '', error: null, canStop: true, canRegenerate: false };
    case 'META': return { ...state, phase: 'thinking', mode: action.mode, activeRequestId: action.requestId };
    case 'THOUGHT': return { ...state, phase: 'thinking', thoughts: [...state.thoughts, action.thought], thoughtText: action.thought.text };
    case 'TOKEN': return { ...state, phase: 'streaming', streamText: action.text };
    case 'DONE': return { ...state, messages: [...state.messages, action.message], phase: 'done', isStreaming: false, streamText: '', thoughts: [], thoughtText: '', error: null, canStop: false, canRegenerate: true, mode: action.mode, activeRequestId: null };
    case 'STREAM_ERROR': return { ...state, phase: 'error', isStreaming: false, error: action.error, canStop: false, canRegenerate: canRegenerate(state.messages, false), activeRequestId: null };
    case 'STOP': return { ...state, messages: action.message ? [...state.messages, action.message] : state.messages, phase: 'done', isStreaming: false, streamText: '', thoughts: [], thoughtText: '', error: null, canStop: false, canRegenerate: action.message !== null || canRegenerate(state.messages, false), activeRequestId: null };
    case 'REGENERATE_START': return { ...state, messages: action.messages, phase: 'connecting', isStreaming: true, streamText: '', thoughts: [], thoughtText: '', error: null, canStop: true, canRegenerate: false };
    case 'SET_UPLOAD_OPEN': return { ...state, uploadOpen: action.open };
    case 'SET_TTS': return { ...state, ttsEnabled: action.enabled };
    case 'HEALTH': return { ...state, mode: action.mode, contributionsEnabled: action.contributionsEnabled };
    case 'CLEAR_ERROR': return { ...state, error: null };
    case 'PERSONAL_ANSWER': return { ...state, messages: [...state.messages, action.user, action.assistant], phase: 'done', isStreaming: false, canStop: false, canRegenerate: true, error: null };
    case 'CLEAR_MESSAGES': return { ...state, messages: [], phase: 'idle', isStreaming: false, streamText: '', thoughts: [], thoughtText: '', error: null, canStop: false, canRegenerate: false, activeRequestId: null };
  }
}

function requestMessages(messages: Message[]): ChatRequestMessage[] {
  const values = messages.filter((item) => !item.interrupted && item.content.trim()).slice(-10).map(({ role, content }) => ({ role, content: content.slice(0, 2000) }));
  let count = values.reduce((total, item) => total + item.content.length, 0);
  while (count > 12000 && values.length > 1) count -= values.shift()?.content.length ?? 0;
  return values;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'STREAM_INCOMPLETE') return copy.errors.streamIncomplete;
  return error instanceof Error && error.message ? error.message : copy.errors.requestFailed;
}

export function useChatStream() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  const abortRef = useRef<(() => void) | null>(null);
  const pacerRef = useRef<RevealPacer | null>(null);
  const streamingRef = useRef(false);
  const completingRef = useRef(false);
  const sessionRef = useRef<string>('');
  if (!sessionRef.current) sessionRef.current = id('session').slice(0, 64);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => () => { pacerRef.current?.stop(); abortRef.current?.(); }, []);

  const run = useCallback(async (messages: Message[]) => {
    completingRef.current = false;
    const payload = requestMessages(messages);
    if (payload.length === 0 || last(payload)?.role !== 'user') { streamingRef.current = false; return; }
    const stream = createChatStream(payload, sessionRef.current);
    let fullText = ''; let thoughts: Thought[] = []; let mode: ChatMode = stateRef.current.mode; let requestId = ''; let completion: Message | null = null;
    const pacer = createRevealPacer((text) => dispatch({ type: 'TOKEN', text }), () => {
      if (completion) dispatch({ type: 'DONE', mode, message: completion });
      completion = null;
      completingRef.current = false;
      streamingRef.current = false;
    });
    pacerRef.current = pacer;
    abortRef.current = stream.abort;

    try {
      for await (const event of stream.events) {
        if (event.type === 'meta') { mode = event.mode; requestId = event.requestId; dispatch({ type: 'META', requestId, mode }); }
        else if (event.type === 'thought') { thoughts = [...thoughts, event.thought]; dispatch({ type: 'THOUGHT', thought: event.thought }); }
        else if (event.type === 'token' && event.text) { fullText += event.text; pacer.append(event.text); }
        else if (event.type === 'error') { pacer.stop(); dispatch({ type: 'STREAM_ERROR', error: event.message || copy.assistant.fallbackError }); return; }
        else if (event.type === 'done') {
          const reply = event.response.reply || fullText;
          if (reply.startsWith(fullText)) pacer.append(reply.slice(fullText.length));
          completion = { id: id('assistant'), role: 'assistant', content: reply, badge: event.response.badge, sources: event.response.sources, snippets: event.response.snippets as SourceSnippet[] | undefined, thoughts, requestId: event.response.requestId || requestId || undefined, createdAt: Date.now() };
          completingRef.current = true;
          pacer.flush();
          return;
        }
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && error.name === 'AbortError')) dispatch({ type: 'STREAM_ERROR', error: errorText(error) });
    } finally {
      abortRef.current = null;
      if (pacerRef.current === pacer) pacerRef.current = null;
      if (!completingRef.current) streamingRef.current = false;
    }
  }, []);

  const send = useCallback(async (raw: string) => {
    const content = raw.trim();
    if (!content) { dispatch({ type: 'STREAM_ERROR', error: copy.errors.emptyInput }); return; }
    if (streamingRef.current) return;
    streamingRef.current = true;
    const message: Message = { id: id('user'), role: 'user', content: content.slice(0, 2000), createdAt: Date.now() };
    dispatch({ type: 'SEND', message });
    await run([...stateRef.current.messages, message]);
  }, [run]);

  const sendPersonalAnswer = useCallback((question: string, answer: string) => {
    if (streamingRef.current) return;
    const timestamp = Date.now();
    dispatch({
      type: 'PERSONAL_ANSWER',
      user: { id: id('user'), role: 'user', content: question, createdAt: timestamp },
      assistant: { id: id('personal'), role: 'assistant', content: answer, badge: 'personal', createdAt: timestamp },
    });
  }, []);

  const clearMessages = useCallback(() => {
    if (streamingRef.current) {
      abortRef.current?.();
      pacerRef.current?.stop();
      streamingRef.current = false;
      completingRef.current = false;
    }
    dispatch({ type: 'CLEAR_MESSAGES' });
  }, []);

  const stop = useCallback(() => {
    if (completingRef.current || !streamingRef.current) return;
    const snapshot = stateRef.current;
    abortRef.current?.();
    pacerRef.current?.stop();
    streamingRef.current = false;
    const content = snapshot.streamText.trim();
    dispatch({ type: 'STOP', message: content ? { id: id('assistant'), role: 'assistant', content, thoughts: snapshot.thoughts, requestId: snapshot.activeRequestId ?? undefined, interrupted: true, createdAt: Date.now() } : null });
  }, []);

  const regenerate = useCallback(async () => {
    const snapshot = stateRef.current;
    let index = -1;
    for (let position = snapshot.messages.length - 1; position >= 0; position -= 1) if (snapshot.messages[position].role === 'user') { index = position; break; }
    if (streamingRef.current || index < 0) return;
    streamingRef.current = true;
    const messages = snapshot.messages.slice(0, index + 1);
    dispatch({ type: 'REGENERATE_START', messages });
    await run(messages);
  }, [run]);

  return { state, send, sendPersonalAnswer, clearMessages, stop, regenerate, openChat: () => dispatch({ type: 'OPEN_CHAT' }), setView: (view: View) => dispatch({ type: 'SET_VIEW', view }), setUploadOpen: (open: boolean) => dispatch({ type: 'SET_UPLOAD_OPEN', open }), setTtsEnabled: (enabled: boolean) => dispatch({ type: 'SET_TTS', enabled }), setHealth: (mode: ChatMode, contributionsEnabled: boolean) => dispatch({ type: 'HEALTH', mode, contributionsEnabled }), clearError: () => dispatch({ type: 'CLEAR_ERROR' }) };
}
