import { useEggMedia, useVideoClock } from './EggClock';
import { REVEAL_AT_SECONDS } from './easteregg-cues';

const fmt = (seconds: number): string => (Number.isFinite(seconds) ? seconds.toFixed(2) : '--.--');

/** Development-only calibration readout: video.currentTime / video.duration, plus audio drift. */
export function DevClock() {
  const { currentTime, duration } = useVideoClock();
  const { audioRef } = useEggMedia();
  const audioTime = audioRef.current?.currentTime ?? 0;
  const drift = currentTime - audioTime;

  return (
    <div className="egg-ui egg-dev-clock" aria-hidden="true">
      <span>{fmt(currentTime)} / {fmt(duration)}</span>
      <span>audio {fmt(audioTime)} · Δ {drift >= 0 ? '+' : ''}{drift.toFixed(3)}</span>
      <span data-past={currentTime >= REVEAL_AT_SECONDS || undefined}>reveal @ {fmt(REVEAL_AT_SECONDS)}</span>
    </div>
  );
}
