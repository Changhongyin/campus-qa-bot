import { copy } from '../copy';
import type { Message } from '../types';
import { FeedbackBar } from './FeedbackBar';
import { MarkdownContent } from './MarkdownContent';
import { SourceDetail } from './SourceDetail';
import { ThoughtTrail } from './ThoughtTrail';

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const testId = message.role === 'user' ? 'msg-user' : 'msg-assistant';

  return (
    <article className={`message message--${message.role}`} data-testid={testId}>
      <span className="message__avatar" aria-hidden="true">{message.role === 'user' ? '我' : '量'}</span>
      <div className="message__content">
        {message.role === 'assistant' ? <MarkdownContent content={message.content} /> : <p>{message.content}</p>}
        {message.badge === 'personal' ? <small className="personal-badge">{copy.chat.personalMatch}</small> : null}
        {message.interrupted ? <small>{copy.chat.interrupted}</small> : null}
        {message.role === 'assistant' && message.thoughts ? <ThoughtTrail thoughts={message.thoughts} active={false} /> : null}
        {message.role === 'assistant' && message.sources ? <SourceDetail sources={message.sources} snippets={message.snippets} /> : null}
        {message.role === 'assistant' && message.badge !== 'personal' ? <FeedbackBar requestId={message.requestId} /> : null}
      </div>
    </article>
  );
}
