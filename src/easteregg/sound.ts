/**
 * Synthesised sound for the easter egg. Every sound is built from oscillators and a noise
 * buffer with the Web Audio API; there are no audio files.
 */

// Pentatonic steps, so any run of readings landing on the bench stays consonant.
const PENTATONIC = [0, 2, 4, 7, 9];
const BEAT_BASE = 196; // G3: the reference tone the instrument is tuned against.

type AudioCtor = typeof AudioContext;

export class EggSound {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private beat: { a: OscillatorNode; b: OscillatorNode; level: GainNode } | null = null;
  private lastPing = 0;
  private lastDetent = 0;
  private muted = false;

  /** Creates or resumes the context. Must first run inside a user gesture. */
  wake(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor: AudioCtor | undefined = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const out = ctx.createGain();
    out.gain.value = this.muted ? 0 : 0.9;
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
  }

  get isMuted(): boolean { return this.muted; }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.out) this.out.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  /** Seal knock: 1 is the soft first tap, 2 the firmer second. */
  knock(strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = this.tone(strength > 1 ? 300 : 440, 'sine', 0.16 * strength, 0.002, 0.11, t);
    osc?.frequency.exponentialRampToValueAtTime(strength > 1 ? 120 : 220, t + 0.1);
    this.burst(t, 'bandpass', 1900, 0.07 * strength, 0.035);
  }

  /** The long, filtered breath under the page receding. */
  swell(): void {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.noise) return;
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
  }

  /** A glassy reading landing on the bench; `position` 0…1 picks the pitch. */
  ping(position: number, level = 1): void {
    const ctx = this.ctx;
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
    const ctx = this.ctx;
    if (!ctx) return;
    const now = performance.now();
    if (now - this.lastDetent < 24) return;
    this.lastDetent = now;
    this.burst(ctx.currentTime, 'highpass', 3200, 0.05, 0.014);
  }

  /** Starts the two tones whose beating tells the operator how far off the instrument is. */
  startBeat(hz: number): void {
    const ctx = this.ctx;
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

  setBeat(hz: number): void {
    if (this.ctx && this.beat) this.beat.b.frequency.setTargetAtTime(BEAT_BASE + hz, this.ctx.currentTime, 0.05);
  }

  /** The two tones meet: the beating stops, and the unison fades into the chord. */
  resolve(): void {
    const ctx = this.ctx;
    const beat = this.beat;
    if (!ctx || !beat) return;
    const t = ctx.currentTime;
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
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    [98, 196, 293.66, 392, 587.33, 783.99].forEach((f, i) => {
      this.tone(f, i < 2 ? 'sine' : 'triangle', i < 2 ? 0.06 : 0.026, 0.35 + i * 0.09, 4.8, t + i * 0.06);
    });
    this.tone(1567.98, 'sine', 0.02, 0.01, 2.6, t + 0.5);
    this.tone(1567.98 * 2.76, 'sine', 0.006, 0.01, 1.2, t + 0.5);
  }

  /** The certificate stamp landing. */
  thud(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = this.tone(110, 'sine', 0.34, 0.003, 0.28, t);
    osc?.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    this.burst(t, 'lowpass', 700, 0.18, 0.1);
  }

  /** A short air rush when the standard is struck and scatters. */
  scatter(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.burst(ctx.currentTime, 'bandpass', 900, 0.08, 0.22);
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
