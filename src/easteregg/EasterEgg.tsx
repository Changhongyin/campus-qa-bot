import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from '../hooks/useReducedMotion';
import type { Harvest } from './harvest';
import { Scene, type Stage } from './scene';
import type { EggSound } from './sound';

interface EasterEggProps {
  seed: Harvest;
  sound: EggSound;
  onClose: () => void;
}

const STATUS: Record<Stage, string> = {
  recede: '页面退入背景，校准台展开。',
  calibrate: '校准台：左右拖动或用方向键转动微分筒，消除偏差。两个音的拍频越慢，误差越小。',
  lock: '偏差已消除，读数汇聚为“量”。',
  certified: '校准合格。精思国计，细量民生。',
};

/** The calibration bench overlay. Escape or the close button returns to the cover. */
export function EasterEgg({ seed, sound, onClose }: EasterEggProps) {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [stage, setStage] = useState<Stage>('recede');
  const [muted, setMuted] = useState(sound.isMuted);
  const [leaving, setLeaving] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const scene = new Scene(canvas, seed, { reduced, sound, onStage: setStage });
    sceneRef.current = scene;
    // Dev builds only: lets a browser script drive the bench to the certified stage.
    if (import.meta.env.DEV) (window as unknown as { __eggScene?: Scene }).__eggScene = scene;
    scene.start();
    const onResize = (): void => scene.resize();
    window.addEventListener('resize', onResize);
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('resize', onResize);
      scene.dispose();
      sceneRef.current = null;
    };
    // The scene is built once per opening; later prop changes do not rebuild it.
  }, []);

  // Browsers suspend audio on their own (iOS interruptions, tab switches, autoplay rules);
  // any gesture on the bench or the page coming back wakes it again.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const unlock = (): void => sound.unlock();
    const onVisible = (): void => { if (document.visibilityState === 'visible') sound.unlock(); };
    const events = ['pointerdown', 'touchend', 'keydown'] as const;
    events.forEach((type) => root.addEventListener(type, unlock, { capture: true, passive: true }));
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      events.forEach((type) => root.removeEventListener(type, unlock, { capture: true }));
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sound]);

  const close = (): void => {
    if (leaving) return;
    setLeaving(true);
    sceneRef.current?.leave();
    window.setTimeout(onClose, reduced ? 0 : 520);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); sceneRef.current?.nudge(-step); }
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); sceneRef.current?.nudge(step); }
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    sound.wake();
    event.currentTarget.setPointerCapture(event.pointerId);
    sceneRef.current?.pointerDown(event.clientX, event.clientY);
    setDragging(true);
  };
  const onPointerUp = (): void => { sceneRef.current?.pointerUp(); setDragging(false); };
  const onWheel = (event: WheelEvent): void => { sceneRef.current?.nudge(Math.sign(event.deltaY || event.deltaX) * (event.shiftKey ? 10 : 2)); };

  const toggleMute = (): void => { sound.wake(); sound.setMuted(!muted); setMuted(!muted); };

  return createPortal(
    <div
      ref={rootRef}
      className="egg"
      data-stage={stage}
      data-leaving={leaving || undefined}
      data-dragging={dragging || undefined}
      role="dialog"
      aria-modal="true"
      aria-label="量 · 校准台"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <canvas
        ref={canvasRef}
        className="egg__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={(event) => sceneRef.current?.pointerMove(event.clientX, event.clientY)}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => sceneRef.current?.pointerLeave()}
        onWheel={onWheel}
      />
      <p className="sr-only" aria-live="polite">{STATUS[stage]}</p>
      <div className="egg__controls">
        <button className="egg__icon" type="button" onClick={toggleMute} aria-label={muted ? '开启声音' : '静音'} aria-pressed={muted}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 9h4l5-4v14l-5-4H4z" />
            {muted ? <path d="M16 9l5 6M21 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
          </svg>
        </button>
        <button className="egg__icon" type="button" onClick={close} aria-label="返回封面">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {stage === 'certified' ? (
        <div className="egg__actions">
          {!reduced ? <button className="egg__action" type="button" onClick={() => sceneRef.current?.reset()}>再校一次</button> : null}
          <button className="egg__action egg__action--primary" type="button" onClick={close}>回到封面</button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
