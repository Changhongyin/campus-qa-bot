import { useState } from 'react';
import type { Thought } from '../types';

interface ThoughtTrailProps {
  thoughts: Thought[];
  active: boolean;
}

export function ThoughtTrail({ thoughts, active }: ThoughtTrailProps) {
  const [expanded, setExpanded] = useState(active);

  if (thoughts.length === 0) return null;

  return (
    <section className="thought-trail" data-testid="thought-trail" aria-live="polite" aria-atomic="false">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? thoughts[thoughts.length - 1]?.text : `${thoughts.length} 项检索步骤`}
      </button>
      {expanded ? <ol>{thoughts.map((thought) => <li key={`${thought.stage}-${thought.ms}`}>{thought.text}<small>{thought.ms}ms</small></li>)}</ol> : null}
    </section>
  );
}
