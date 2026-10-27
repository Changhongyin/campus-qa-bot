import { useEffect, useRef } from 'react';

/**
 * Remembers which element had focus when a drawer opened and returns focus to it
 * once the drawer closes, if that element is still on the page and focusable.
 */
export function useReturnFocus(open: boolean): void {
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return undefined;
    }
    const target = opener.current;
    opener.current = null;
    if (target && target.isConnected && !target.matches(':disabled')) target.focus({ preventScroll: true });
    return undefined;
  }, [open]);
}
