import { useEffect, useRef } from 'react';
import { copy } from '../copy';
import type { ChatState } from '../types';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  state: ChatState;
  onRegenerate: () => Promise<void>;
  onStop: () => void;
}

export function MessageList({ state, onRegenerate, onStop }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [state.messages, state.streamText, state.phase]);

  return (
    <div className="message-list" data-testid="chat-window" aria-live="polite">
      {state.messages.length === 0 ? (
        <article className="message message--assistant">
          <span className="message__avatar" aria-hidden="true">量</span>
          <div className="message__content"><p>{copy.chat.welcome}</p><p>{copy.chat.welcomeDetail}</p></div>
        </article>
      ) : null}

      {state.messages.map((message) => <MessageBubble key={message.id} message={message} />)}

      {state.isStreaming ? (
        <article className="message message--assistant" data-testid="msg-assistant-streaming">
          <span className="message__avatar" aria-hidden="true">量</span>
          <div className="message__content">
            <p>{state.streamText || state.thoughtText || copy.chat.thinking}</p>
            {state.canStop ? <button className="text-button" data-testid="stop-btn" type="button" onClick={onStop}>{copy.chat.stop}</button> : null}
          </div>
        </article>
      ) : null}

      {state.error ? <p className="message-list__error">{state.error}</p> : null}

      {state.canRegenerate ? (
        <button className="message-list__regenerate" data-testid="regenerate-btn" type="button" onClick={() => void onRegenerate()}>
          {copy.chat.regenerate}
        </button>
      ) : null}

      <div ref={bottomRef} />
    </div>
  );
}
