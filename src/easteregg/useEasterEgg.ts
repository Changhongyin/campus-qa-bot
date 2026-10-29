import { useCallback, useEffect, useRef, useState, type AnimationEvent } from 'react';

/**
 * idle → (click 1: soft shake) → (click 2: hard shake) armed
 * → (click 3) receding, the page recedes → placeholder, the empty stage.
 */
export type EggStage = 'idle' | 'armed' | 'receding' | 'placeholder';
export type SealShake = 'soft' | 'hard' | null;

/** Clicks further apart than this start the count again. */
const CLICK_WINDOW_MS = 1500;

export function useEasterEgg() {
  const [stage, setStage] = useState<EggStage>('idle');
  const [shake, setShake] = useState<SealShake>(null);
  const clicks = useRef({ count: 0, last: 0 });
  const sealRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  const onSealClick = useCallback((): void => {
    if (stage !== 'idle' && stage !== 'armed') return;
    const now = performance.now();
    const state = clicks.current;
    state.count = now - state.last > CLICK_WINDOW_MS ? 1 : state.count + 1;
    state.last = now;
    if (state.count === 1) {
      setShake('soft');
    } else if (state.count === 2) {
      setShake('hard');
      setStage('armed');
    } else {
      state.count = 0;
      setShake(null);
      setStage('receding');
    }
  }, [stage]);

  const onSealAnimationEnd = useCallback((): void => setShake(null), []);

  /** Attach to the page root: shows the stage once the landing has receded. */
  const onPageAnimationEnd = useCallback((event: AnimationEvent<HTMLElement>): void => {
    if (event.animationName === 'egg-page-recede' && stage === 'receding') setStage('placeholder');
  }, [stage]);

  const close = useCallback((): void => {
    clicks.current.count = 0;
    returnFocus.current = true;
    setStage('idle');
  }, []);

  // Back to the seal once the landing is visible again (it is hidden while receded, so focus would fail).
  useEffect(() => {
    if (stage !== 'idle' || !returnFocus.current) return;
    returnFocus.current = false;
    sealRef.current?.focus({ preventScroll: true });
  }, [stage]);

  return { stage, shake, sealRef, onSealClick, onSealAnimationEnd, onPageAnimationEnd, close };
}
