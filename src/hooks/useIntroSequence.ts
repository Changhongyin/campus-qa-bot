import { useCallback, useEffect, useState } from 'react';

/** Presentation-only state for the first-visit opening sequence. */
export type IntroPhase = 'backdrop' | 'line' | 'line-out' | 'landing';

const SEEN_KEY = 'ldzd-intro-seen';

// Background settles first, the English line then holds ~6 s from its appearance,
// and its fade-out matches --dur-long in tokens.css before the landing copy reveals.
const BACKDROP_MS = 700;
const LINE_HOLD_MS = 6000;
const LINE_FADE_MS = 720;

function shouldPlay(): boolean {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  // Automated browsers (end-to-end tests, screenshot scripts) go straight to the landing page.
  if (navigator.webdriver) return false;
  try {
    return sessionStorage.getItem(SEEN_KEY) !== 'true';
  } catch {
    return true;
  }
}

function markSeen(): void {
  try { sessionStorage.setItem(SEEN_KEY, 'true'); } catch { /* storage unavailable: intro simply plays again */ }
}

export function useIntroSequence(): { phase: IntroPhase; skip: () => void } {
  const [phase, setPhase] = useState<IntroPhase>(() => (shouldPlay() ? 'backdrop' : 'landing'));

  useEffect(() => {
    if (phase === 'landing') { markSeen(); return undefined; }
    const next: Record<Exclude<IntroPhase, 'landing'>, [IntroPhase, number]> = {
      backdrop: ['line', BACKDROP_MS],
      line: ['line-out', LINE_HOLD_MS],
      'line-out': ['landing', LINE_FADE_MS],
    };
    const [target, delay] = next[phase];
    const timer = window.setTimeout(() => setPhase(target), delay);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const skip = useCallback(() => setPhase('landing'), []);
  return { phase, skip };
}
