import type { MouseEvent } from 'react';
import type { Shake } from './useEasterEgg';

interface SealTriggerProps {
  shake: Shake;
  onClick: () => void;
}

/** The masthead seal. It looks and behaves like the plain mark; only repeated clicks reach the egg. */
export function SealTrigger({ shake, onClick }: SealTriggerProps) {
  // Keep a quick multi-click from selecting nearby text.
  const onMouseDown = (event: MouseEvent): void => { if (event.detail > 1) event.preventDefault(); };
  return (
    <div className="brand-mark seal-trigger" data-shake={shake || undefined} aria-hidden="true" onMouseDown={onMouseDown} onClick={onClick}>
      量
    </div>
  );
}
