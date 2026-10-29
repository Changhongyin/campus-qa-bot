import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { copy } from '../copy';

interface EasterEggProps {
  onClose: () => void;
}

/** The stage the hidden seal opens: empty for now, the code-rendered form will be built on it. */
export function EasterEgg({ onClose }: EasterEggProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="egg-root" data-phase="placeholder" role="dialog" aria-modal="true" aria-label={copy.easterEgg.dialog}>
      <div className="egg-stage" data-testid="egg-placeholder">
        {/* Handoff container, kept empty: the font engineer injects 计量 and the motto here. */}
        <div className="egg-final-reveal" data-state="awaiting" />
      </div>
      <button
        ref={closeRef}
        className="egg-ui egg-close"
        type="button"
        aria-label={copy.easterEgg.closeLabel}
        aria-keyshortcuts="Escape"
        onClick={onClose}
      >
        {copy.easterEgg.close}
      </button>
    </div>,
    document.body,
  );
}
