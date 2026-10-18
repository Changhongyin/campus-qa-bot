import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { copy } from '../copy';

interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  const [copied, setCopied] = useState(false);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
        code: ({ children, className }) => {
          const text = String(children).replace(/\n$/, '');
          const block = Boolean(className);
          return block ? (
            <span className="markdown-code">
              <button type="button" onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>
                {copied ? copy.chat.copied : copy.chat.copy}
              </button>
              <code className={className}>{children}</code>
            </span>
          ) : <code>{children}</code>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
