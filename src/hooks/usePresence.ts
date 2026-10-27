import { useEffect, useState } from 'react';

// Keep in step with --dur-base in tokens.css (drawer exit duration).
const EXIT_MS = 320;

/**
 * Keeps a panel mounted for its exit animation after `open` turns false.
 * Returns whether to render and whether the panel is currently closing.
 */
export function usePresence(open: boolean): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) { setMounted(true); return undefined; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setMounted(false); return undefined; }
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return { mounted: open || mounted, closing: !open && mounted };
}
