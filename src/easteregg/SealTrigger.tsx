import type { AnimationEvent, RefObject } from 'react';
import { copy } from '../copy';
import type { SealShake } from './useEasterEgg';

export interface SealTriggerProps {
  buttonRef: RefObject<HTMLButtonElement | null>;
  shake: SealShake;
  onClick: () => void;
  onAnimationEnd: () => void;
}

/** The landing masthead's 量 seal, as the easter egg's hidden trigger. Looks exactly like `.brand-mark`. */
export function SealTrigger({ buttonRef, shake, onClick, onAnimationEnd }: SealTriggerProps) {
  const handleAnimationEnd = (event: AnimationEvent<HTMLButtonElement>): void => {
    if (event.target === event.currentTarget) onAnimationEnd();
  };

  return (
    <button
      ref={buttonRef}
      className="brand-mark egg-seal"
      type="button"
      aria-label={copy.easterEgg.seal}
      data-shake={shake ?? undefined}
      onClick={onClick}
      onAnimationEnd={handleAnimationEnd}
    >
      <span aria-hidden="true">量</span>
    </button>
  );
}
