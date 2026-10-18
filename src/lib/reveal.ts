export interface RevealPacer {
  append: (text: string) => void;
  flush: () => void;
  stop: () => void;
}

export function createRevealPacer(
  onUpdate: (text: string) => void,
  onComplete: () => void,
): RevealPacer {
  let pending = '';
  let visible = '';
  let frame = 0;
  let previous = 0;
  let flushing = false;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const tick = (time: number): void => {
    const elapsed = Math.max(16, time - previous);
    previous = time;
    const rate = flushing ? Math.max(90, pending.length * 2) : pending.length > 80 ? 90 : 22;
    const count = reducedMotion ? pending.length : Math.max(1, Math.floor((rate * elapsed) / 1000));
    visible += pending.slice(0, count);
    pending = pending.slice(count);
    onUpdate(visible);

    if (pending.length > 0) {
      frame = window.requestAnimationFrame(tick);
      return;
    }

    frame = 0;
    if (flushing) onComplete();
  };

  const start = (): void => {
    if (frame === 0) {
      previous = performance.now();
      frame = window.requestAnimationFrame(tick);
    }
  };

  return {
    append: (text) => {
      pending += text;
      start();
    },
    flush: () => {
      flushing = true;
      start();
    },
    stop: () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
      pending = '';
    },
  };
}
