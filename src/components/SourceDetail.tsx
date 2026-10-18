import { useState } from 'react';
import type { SourceSnippet } from '../types';

interface SourceDetailProps {
  sources: string[];
  snippets?: SourceSnippet[];
}

export function SourceDetail({ sources, snippets }: SourceDetailProps) {
  const [open, setOpen] = useState<string | null>(null);

  if (sources.length === 0) return null;

  return (
    <div className="sources" data-testid="sources">
      {sources.map((source) => {
        const snippet = snippets?.find((item) => item.source === source);
        return (
          <div key={source}>
            <button type="button" onClick={() => setOpen(open === source ? null : source)}>{source}</button>
            {open === source && snippet ? <blockquote><strong>{snippet.title}</strong><p>{snippet.text}</p></blockquote> : null}
          </div>
        );
      })}
    </div>
  );
}
