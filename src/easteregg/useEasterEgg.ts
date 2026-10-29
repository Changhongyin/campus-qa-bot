import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { harvest, type Harvest } from './harvest';
import { EggSound } from './sound';

const WINDOW_MS = 1500;

export type Shake = 0 | 1 | 2;

/**
 * Triple-click on the seal within 1.5 s: a soft shake, a hard shake, then the egg.
 * The page is captured on the third click, before anything about it changes.
 */
export function useEasterEgg(getRoot: () => HTMLElement | null) {
  const [seed, setSeed] = useState<Harvest | null>(null);
  const [shake, setShake] = useState<Shake>(0);
  const clicks = useRef<number[]>([]);
  const shakeTimer = useRef(0);
  const sound = useMemo(() => new EggSound(), []);

  useEffect(() => () => window.clearTimeout(shakeTimer.current), []);

  const click = useCallback((): void => {
    if (seed) return;
    const now = performance.now();
    clicks.current = [...clicks.current.filter((t) => now - t < WINDOW_MS), now];
    const count = clicks.current.length;
    sound.wake();
    window.clearTimeout(shakeTimer.current);
    if (count >= 3) {
      clicks.current = [];
      setShake(0);
      sound.swell();
      setSeed(harvest(getRoot()));
      return;
    }
    sound.knock(count);
    setShake(count as Shake);
    shakeTimer.current = window.setTimeout(() => setShake(0), 480);
  }, [seed, sound, getRoot]);

  const close = useCallback((): void => setSeed(null), []);

  return { open: seed !== null, seed, shake, sound, click, close };
}
