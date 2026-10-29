import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

/** The two media elements of the easter egg. The audio is the master clock; the video follows it. */
export interface EggMedia {
  videoRef: RefObject<HTMLVideoElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
}

const EggMediaContext = createContext<EggMedia | null>(null);

/** Creates the media refs once; App owns them so the seal click can unlock audio. */
export function useCreateEggMedia(): EggMedia {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  return useMemo(() => ({ videoRef, audioRef }), []);
}

export function EggMediaProvider({ media, children }: { media: EggMedia; children: ReactNode }) {
  return <EggMediaContext.Provider value={media}>{children}</EggMediaContext.Provider>;
}

export function useEggMedia(): EggMedia {
  const media = useContext(EggMediaContext);
  if (!media) throw new Error('useEggMedia must be used inside <EggMediaProvider>.');
  return media;
}

export interface VideoClock {
  /** `video.currentTime`, or 0 before the video exists. */
  currentTime: number;
  /** `video.duration`, or NaN until metadata has loaded. */
  duration: number;
  /** The video element itself, for modules that prefer to read it directly. */
  video: HTMLVideoElement | null;
}

/**
 * The film's clock, refreshed once per animation frame. Cues are compared
 * against `currentTime` (see easteregg-cues.ts); never drive them with timers.
 */
export function useVideoClock(): VideoClock {
  const { videoRef } = useEggMedia();
  const [clock, setClock] = useState<VideoClock>({ currentTime: 0, duration: Number.NaN, video: null });

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const video = videoRef.current;
      const currentTime = video?.currentTime ?? 0;
      const duration = video?.duration ?? Number.NaN;
      setClock((prev) => (
        prev.currentTime === currentTime && Object.is(prev.duration, duration) && prev.video === video
          ? prev
          : { currentTime, duration, video }
      ));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [videoRef]);

  return clock;
}
