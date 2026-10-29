import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copy } from '../copy';
import { DevClock } from './DevClock';
import { useEggMedia } from './EggClock';
import { startedAudio, type EggStage } from './useEasterEgg';

interface EasterEggProps {
  /** Mounted from 'armed' on (to preload); visible from 'playing'. */
  stage: Exclude<EggStage, 'idle'>;
  onEnded: () => void;
  onClose: () => void;
}

const media = (file: string): string => `${import.meta.env.BASE_URL}media/${file}`;

/** Drift beyond this is corrected by seeking; below it, by nudging the playback rate. */
const SEEK_DRIFT_S = 0.25;
const NUDGE_DRIFT_S = 0.03;

export function EasterEgg({ stage, onEnded, onClose }: EasterEggProps) {
  const { videoRef, audioRef } = useEggMedia();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [blocked, setBlocked] = useState(false);
  const live = stage === 'playing' || stage === 'final';

  // Start together: both from zero, the audio is the clock and the video is made to follow it.
  useEffect(() => {
    if (stage !== 'playing') return;
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio || !video) return;
    video.muted = true;
    audio.currentTime = 0;
    video.currentTime = 0;
    startedAudio.add(audio);
    void video.play().catch(() => undefined);
    audio.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
  }, [stage, audioRef, videoRef]);

  // Slave the video to the audio every frame while the film runs.
  useEffect(() => {
    if (stage !== 'playing') return undefined;
    let frame = 0;
    const step = (): void => {
      const audio = audioRef.current;
      const video = videoRef.current;
      if (audio && video && !video.ended) {
        if (audio.paused || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          if (!video.paused) video.pause();
        } else if (!video.seeking) {
          const drift = video.currentTime - audio.currentTime;
          if (Math.abs(drift) > SEEK_DRIFT_S) {
            video.currentTime = audio.currentTime;
            video.playbackRate = 1;
          } else {
            video.playbackRate = Math.abs(drift) > NUDGE_DRIFT_S ? Math.min(1.1, Math.max(0.9, 1 - drift)) : 1;
          }
          if (video.paused) void video.play().catch(() => undefined);
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [stage, audioRef, videoRef]);

  // Whichever ends first, hold the video on its last frame and hand over to the final stage.
  useEffect(() => {
    if (stage !== 'playing') return undefined;
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio || !video) return undefined;
    const finish = (): void => {
      video.pause();
      if (Number.isFinite(video.duration)) video.currentTime = video.duration;
      onEnded();
    };
    audio.addEventListener('ended', finish);
    video.addEventListener('ended', finish);
    return () => {
      audio.removeEventListener('ended', finish);
      video.removeEventListener('ended', finish);
    };
  }, [stage, audioRef, videoRef, onEnded]);

  useEffect(() => {
    if (!live) return undefined;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, onClose]);

  const resume = (): void => {
    const audio = audioRef.current;
    if (audio) audio.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
  };

  return createPortal(
    <div
      className="egg-root"
      data-phase={stage}
      role={live ? 'dialog' : undefined}
      aria-modal={live || undefined}
      aria-label={live ? copy.easterEgg.dialog : undefined}
      aria-hidden={live ? undefined : true}
    >
      <div className="egg-stage">
        <video
          ref={videoRef}
          className="egg-film"
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          aria-hidden="true"
        >
          <source src={media('easteregg.webm')} type="video/webm" />
          <source src={media('easteregg.mp4')} type="video/mp4" />
        </video>
        {/* Final dynamic stage: living layers over the held last frame. */}
        <div className="egg-final" aria-hidden="true">
          <div className="egg-final__grid" />
          <div className="egg-final__ring" />
          <div className="egg-final__glow" />
        </div>
        {/* Handoff: the font engineer injects 计量 and the motto here, cued on video.currentTime. */}
        <div className="egg-final-reveal" data-state="awaiting" />
      </div>
      <audio ref={audioRef} src={media('anthem.mp3')} preload="auto" />
      {blocked && live ? (
        <button className="egg-ui egg-play" type="button" aria-label={copy.easterEgg.playLabel} onClick={resume}>
          {copy.easterEgg.play}
        </button>
      ) : null}
      <button
        ref={closeRef}
        className="egg-ui egg-close"
        type="button"
        aria-label={copy.easterEgg.closeLabel}
        aria-keyshortcuts="Escape"
        tabIndex={live ? 0 : -1}
        onClick={onClose}
      >
        {copy.easterEgg.close}
      </button>
      {import.meta.env.DEV && live ? <DevClock /> : null}
    </div>,
    document.body,
  );
}
