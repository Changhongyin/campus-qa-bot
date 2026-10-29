/**
 * Synthesised sound for the easter egg. Every sound is built from oscillators and a noise
 * buffer with the Web Audio API; there are no audio files.
 */
import { loadEggMuted, saveEggMuted } from '../lib/storage';

// Pentatonic steps, so any run of readings landing on the bench stays consonant.
const PENTATONIC = [0, 2, 4, 7, 9];
const BEAT_BASE = 196; // G3: the reference tone the instrument is tuned against.
const LEVEL = 0.9;
// A sound asked for while the context is still waking (iOS resolves resume() a few ms
// after the gesture) is played once it runs, unless it has gone stale by then.
const PENDING_MS = 250;

type AudioCtor = typeof AudioContext;
type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

export type HapticKind = 'knock' | 'reading' | 'stamp';

const HAPTICS: Record<HapticKind, number | number[]> = {
  knock: 12,
  reading: 8,
  stamp: [36, 70, 36],
};
const HAPTIC_GAP: Record<HapticKind, number> = { knock: 0, reading: 160, stamp: 0 };
const lastHaptic: Record<HapticKind, number> = { knock: 0, reading: 0, stamp: 0 };

/**
 * A short motor pulse where the device has one (Android). iOS has no Vibration API and
 * desktops have no motor, so there it does nothing; the bass and the shakes carry the hit.
 */
export function haptic(kind: HapticKind): void {
  const now = performance.now();
  if (now - lastHaptic[kind] < HAPTIC_GAP[kind]) return;
  lastHaptic[kind] = now;
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(HAPTICS[kind]);
  } catch {
    // Some embedded browsers expose vibrate but throw when it is called.
  }
}

export class EggSound {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private beat: { a: OscillatorNode; b: OscillatorNode; level: GainNode } | null = null;
  private lastPing = 0;
  private lastDetent = 0;
  private muted = loadEggMuted();
  private sessionType: string | null = null;

  /**
   * Creates or resumes the context. Must run inside a user gesture: iOS only lets a
   * context start from one, and finishes the unlock when a buffer plays in that gesture.
   */
  wake(): void {
    if (this.ctx) {
      this.unlock();
      return;
    }
    const Ctor: AudioCtor | undefined = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    const out = ctx.createGain();
    out.gain.value = this.muted ? 0 : LEVEL;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 6;
    out.connect(limiter).connect(ctx.destination);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.out = out;
    this.noise = noise;
    this.unlock();
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start(0);
  }

  /** Resumes a context the browser suspended or interrupted. Safe to call on any gesture. */
  unlock(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    ctx.resume().catch(() => undefined);
  }

  /**
   * Safari 16.4+: play through the media channel while the bench is open, so the page is
   * not treated as ambient sound. Restored when the bench closes.
   */
  claimSession(): void {
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (!session || this.sessionType !== null) return;
    try {
      this.sessionType = session.type;
      session.type = 'playback';
    } catch {
      this.sessionType = null;
    }
  }

  releaseSession(): void {
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (!session || this.sessionType === null) return;
    try {
      session.type = this.sessionType;
    } catch {
      // Nothing to restore on a browser that refuses the write.
    }
    this.sessionType = null;
  }

  get isMuted(): boolean { return this.muted; }

  setMuted(muted: boolean): void {
    this.muted = muted;
    saveEggMuted(muted);
    if (this.ctx && this.out) this.out.gain.setTargetAtTime(muted ? 0 : LEVEL, this.ctx.currentTime, 0.05);
  }

  /** Seal knock: 1 is the soft first tap, 2 the firmer second. */
  knock(strength: number): void {
    this.play((ctx) => {
      const t = ctx.currentTime;
      const osc = this.tone(strength > 1 ? 300 : 440, 'sine', 0.16 * strength, 0.002, 0.11, t);
      osc?.frequency.exponentialRampToValueAtTime(strength > 1 ? 120 : 220, t + 0.1);
      const body = this.tone(strength > 1 ? 82 : 96, 'sine', 0.07 * strength, 0.004, 0.14, t);
      body?.frequency.exponentialRampToValueAtTime(48, t + 0.12);
      this.burst(t, 'bandpass', 1900, 0.07 * strength, 0.035);
    });
  }

  /** The long, filtered breath under the page receding. */
  swell(): void {
    this.play((ctx) => {
      if (!this.out || !this.noise) return;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 2.2;
      filter.frequency.setValueAtTime(160, t);
      filter.frequency.exponentialRampToValueAtTime(1500, t + 1.9);
      filter.frequency.exponentialRampToValueAtTime(260, t + 3.8);
      const level = ctx.createGain();
      level.gain.setValueAtTime(0.0001, t);
      level.gain.exponentialRampToValueAtTime(0.06, t + 1.5);
      level.gain.exponentialRampToValueAtTime(0.0001, t + 3.9);
      src.connect(filter).connect(level).connect(this.out);
      src.start(t);
      src.stop(t + 4);
      this.tone(73.42, 'sine', 0.07, 1.2, 2.8, t);
    });
  }

  /** A glassy reading landing on the bench; `position` 0…1 picks the pitch. */
  ping(position: number, level = 1): void {
    const ctx = this.running();
    if (!ctx) return;
    const now = performance.now();
    if (now - this.lastPing < 34) return;
    this.lastPing = now;
    const index = Math.max(0, Math.min(13, Math.floor(position * 14)));
    const semitones = 12 * Math.floor(index / 5) + PENTATONIC[index % 5];
    const f = 523.25 * 2 ** (semitones / 12);
    const t = ctx.currentTime;
    this.tone(f, 'sine', 0.03 * level, 0.003, 0.32, t);
    this.tone(f * 2.76, 'sine', 0.01 * level, 0.002, 0.14, t);
  }

  /** A thimble detent passing the datum. */
  detent(): void {
    const ctx = this.running();
    if (!ctx) return;
    const now = performance.now();
    if (now - this.lastDetent < 24) return;
    this.lastDetent = now;
    this.burst(ctx.currentTime, 'highpass', 3200, 0.05, 0.014);
  }

  /** Starts the two tones whose beating tells the operator how far off the instrument is. */
  startBeat(hz: number): void {
    const ctx = this.running();
    if (!ctx || !this.out || this.beat) return;
    const t = ctx.currentTime;
    const level = ctx.createGain();
    level.gain.setValueAtTime(0.0001, t);
    level.gain.exponentialRampToValueAtTime(0.045, t + 1.4);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = 'triangle';
    b.type = 'triangle';
    a.frequency.value = BEAT_BASE;
    b.frequency.value = BEAT_BASE + hz;
    a.connect(level);
    b.connect(level);
    level.connect(filter).connect(this.out);
    a.start(t);
    b.start(t);
    this.beat = { a, b, level };
  }

  /** Follows the error; starts the tones if the context was not running when they were due. */
  setBeat(hz: number): void {
    if (!this.beat) { this.startBeat(hz); return; }
    if (this.ctx) this.beat.b.frequency.setTargetAtTime(BEAT_BASE + hz, this.ctx.currentTime, 0.05);
  }

  /** The two tones meet: the beating stops, and the unison fades into the chord. */
  resolve(): void {
    const ctx = this.running();
    if (!ctx) return;
    const t = ctx.currentTime;
    // The instrument seats: a soft low bump under the unison.
    const seat = this.tone(70, 'sine', 0.12, 0.006, 0.3, t);
    seat?.frequency.exponentialRampToValueAtTime(46, t + 0.26);
    const beat = this.beat;
    if (!beat) return;
    beat.b.frequency.cancelScheduledValues(t);
    beat.b.frequency.setTargetAtTime(BEAT_BASE, t, 0.06);
    beat.level.gain.cancelScheduledValues(t);
    beat.level.gain.setValueAtTime(Math.max(0.0001, beat.level.gain.value), t);
    beat.level.gain.exponentialRampToValueAtTime(0.06, t + 0.4);
    beat.level.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
    beat.a.stop(t + 4.6);
    beat.b.stop(t + 4.6);
    this.beat = null;
  }

  stopBeat(): void {
    const ctx = this.ctx;
    const beat = this.beat;
    if (!ctx || !beat) return;
    const t = ctx.currentTime;
    beat.level.gain.cancelScheduledValues(t);
    beat.level.gain.setTargetAtTime(0.0001, t, 0.08);
    beat.a.stop(t + 0.5);
    beat.b.stop(t + 0.5);
    this.beat = null;
  }

  /** G major spread over three octaves, voiced in from the bottom, with a bell on top. */
  bloom(): void {
    const ctx = this.running();
    if (!ctx) return;
    const t = ctx.currentTime;
    [98, 196, 293.66, 392, 587.33, 783.99].forEach((f, i) => {
      this.tone(f, i < 2 ? 'sine' : 'triangle', i < 2 ? 0.06 : 0.026, 0.35 + i * 0.09, 4.8, t + i * 0.06);
    });
    this.tone(1567.98, 'sine', 0.02, 0.01, 2.6, t + 0.5);
    this.tone(1567.98 * 2.76, 'sine', 0.006, 0.01, 1.2, t + 0.5);
  }

  /**
   * The certificate stamp landing: the loudest event, a 110 → 42 Hz sweep at full level so
   * a laptop's body buzzes with it where there is no motor to drive.
   */
  thud(): void {
    const ctx = this.running();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = this.tone(110, 'sine', 0.5, 0.003, 0.3, t);
    osc?.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    this.burst(t, 'lowpass', 700, 0.18, 0.1);
  }

  /** A short air rush when the standard is struck and scatters. */
  scatter(): void {
    const ctx = this.running();
    if (!ctx) return;
    this.burst(ctx.currentTime, 'bandpass', 900, 0.08, 0.22);
  }

  /** The context, only while it is actually producing sound. */
  private running(): AudioContext | null {
    return this.ctx && this.ctx.state === 'running' ? this.ctx : null;
  }

  /** Plays now if the context runs, or as soon as a pending resume lands. */
  private play(fn: (ctx: AudioContext) => void): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'running') { fn(ctx); return; }
    if (ctx.state === 'closed') return;
    const asked = performance.now();
    ctx.resume().then(() => {
      if (ctx.state === 'running' && performance.now() - asked < PENDING_MS) fn(ctx);
    }).catch(() => undefined);
  }

  private tone(freq: number, type: OscillatorType, peak: number, attack: number, decay: number, when: number): OscillatorNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.out) return null;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    osc.connect(gain).connect(this.out);
    osc.start(when);
    osc.stop(when + attack + decay + 0.05);
    return osc;
  }

  private burst(when: number, type: BiquadFilterType, freq: number, peak: number, decay: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    src.connect(filter).connect(gain).connect(this.out);
    src.start(when, Math.random());
    src.stop(when + decay + 0.05);
  }
}
