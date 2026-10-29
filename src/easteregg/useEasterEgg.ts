import { useCallback, useRef, useState, type AnimationEvent } from 'react';
import type { EggMedia } from './EggClock';

/**
 * idle → (click 1: soft shake) → (click 2: hard shake) armed, media preloading
 * → (click 3) receding, the page recedes → playing → final, the dynamic stage.
 */
export type EggStage = 'idle' | 'armed' | 'receding' | 'playing' | 'final';
export type SealShake = 'soft' | 'hard' | null;

/** Clicks further apart than this start the count again. */
const CLICK_WINDOW_MS = 1500;

/** Audio elements whose real playback has begun; the unlock below must not pause those. */
export const startedAudio = new WeakSet<HTMLMediaElement>();

/**
 * Play and pause the audio inside the third click, so the browser counts its
 * later, delayed start as user-initiated. The anthem opens with 0.6 s of
 * silence, so nothing is heard.
 */
function unlockAudio(audio: HTMLAudioElement | null): void {
  if (!audio) return;
  void audio.play().then(() => {
    if (startedAudio.has(audio)) return;
    audio.pause();
    audio.currentTime = 0;
  }).catch(() => undefined);
}

export function useEasterEgg(media: EggMedia) {
  const [stage, setStage] = useState<EggStage>('idle');
  const [shake, setShake] = useState<SealShake>(null);
  const clicks = useRef({ count: 0, last: 0 });
  const sealRef = useRef<HTMLButtonElement>(null);

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
      unlockAudio(media.audioRef.current);
      setStage('receding');
    }
  }, [stage, media]);

  const onSealAnimationEnd = useCallback((): void => setShake(null), []);

  /** Attach to the page root: mounts the film once the landing has receded. */
  const onPageAnimationEnd = useCallback((event: AnimationEvent<HTMLElement>): void => {
    if (event.animationName === 'egg-page-recede' && stage === 'receding') setStage('playing');
  }, [stage]);

  const onPlaybackEnded = useCallback((): void => {
    setStage((current) => (current === 'playing' ? 'final' : current));
  }, []);

  const close = useCallback((): void => {
    media.audioRef.current?.pause();
    media.videoRef.current?.pause();
    clicks.current.count = 0;
    setStage('idle');
    sealRef.current?.focus({ preventScroll: true });
  }, [media]);

  return { stage, shake, sealRef, onSealClick, onSealAnimationEnd, onPageAnimationEnd, onPlaybackEnded, close };
}
