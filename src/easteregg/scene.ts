import type { Glyph, Harvest } from './harvest';
import { haptic, type EggSound } from './sound';

/**
 * The calibration bench, drawn on one canvas.
 *
 * recede     every character of the landing page backs away into depth, in reading order,
 *            and condenses into a bead: a single reading.
 * calibrate  readings fall from the seal onto the axis and pile into a distribution that sits
 *            off the true value. Turning the thimble removes the bias; two tones beat at a
 *            rate proportional to the remaining error. Holding still shrinks U as 1/√n.
 * lock       the beating stops. Every reading rises and assembles into 量.
 * certified  a graduated dial with the motto draws itself around the standard, and the
 *            certificate is stamped.
 */
export type Stage = 'recede' | 'calibrate' | 'lock' | 'certified';

const C = {
  ink: '#1b2a44',
  muted: '#5a6779',
  jade: '#2d7a64',
  brass: '#9c7a43',
  paper: '#f6f3eb',
  seal: '#a33c48',
};
const INK_RGB: [number, number, number] = [27, 42, 68];
const BRASS_RGB: [number, number, number] = [156, 122, 67];
/** Canvas cannot resolve var(), so the font tokens are read from :root, with the same stacks as fallback. */
function fontToken(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
const SERIF = fontToken('--font-serif', '"Songti SC", "STSong", "SimSun", "Noto Serif SC", serif');
const SANS = fontToken('--font-sans', '"Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif');
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

const SIGMA = 0.85;        // spread of one reading, in axis units
const WINDOW = 240;        // readings kept on the bench
const RATE = 34;           // readings per second from the seal
const SPAN = 10;           // the axis runs from −5 to +5
const BINS = 50;
const DIVISIONS = 100;     // graduations per thimble turn
const TURN = 1;            // axis units per turn, so one division is 0.01
const TOLERANCE = 0.05;
const LOCK_READINGS = 90;
const GRAVITY = 2600;
const RECEDE_SPREAD = 2.1; // seconds over which the page's characters set off
const CALIBRATE_AT = 3;    // seconds into the egg when the bench takes over
const STAMP_AT = 2.3;      // seconds into the certified stage
const MOTTO = ['精思国计', '细量民生'];

type Mode = 'fall' | 'rest' | 'fade' | 'form';

interface Bead {
  x: number; y: number; vx: number; vy: number; r: number; alpha: number;
  mode: Mode;
  value: number; bin: number; epoch: number;
  sx: number; sy: number; t: number; tFall: number;
  hx: number; hy: number; hr: number; delay: number; arrived: boolean;
}

interface Flyer { g: Glyph; delay: number; dur: number; done: boolean }

interface Layout {
  W: number; H: number; narrow: boolean;
  cx: number; aw: number; ax0: number; unit: number; binPx: number; r: number; step: number;
  baseY: number; srcY: number; scopeY: number; sealSize: number;
  thY: number; tw: number; th: number;
  gs: number; gcy: number; R1: number;
}

const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOut = (t: number): number => 1 - (1 - t) ** 3;
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeIn = (t: number): number => t * t * t;
const ramp = (time: number, start: number, dur: number): number => clamp((time - start) / dur);

function gauss(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function mix(a: [number, number, number], b: [number, number, number], t: number, alpha: number): string {
  return `rgba(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))},${alpha})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function freshBias(): number {
  return (Math.random() < 0.5 ? -1 : 1) * (1.3 + Math.random() * 0.8);
}

function layout(W: number, H: number): Layout {
  const narrow = W < 640;
  const aw = Math.min(W - (narrow ? 36 : 140), 920);
  const unit = aw / SPAN;
  const binPx = aw / BINS;
  const r = binPx * 0.42;
  const scopeY = H * (narrow ? 0.1 : 0.11);
  const srcY = H * (narrow ? 0.2 : 0.21);
  const baseY = H * (narrow ? 0.63 : 0.67);
  const peak = (WINDOW * (SPAN / BINS)) / (SIGMA * Math.sqrt(2 * Math.PI)) * 1.3;
  const step = Math.min(r * 2 * 0.96, (baseY - srcY - 40) / peak);
  const gs = narrow ? Math.min(W * 0.56, H * 0.36) : Math.min(W * 0.5, H * 0.46, 420);
  return {
    W, H, narrow, cx: W / 2, aw, ax0: (W - aw) / 2, unit, binPx, r, step,
    baseY, srcY, scopeY, sealSize: narrow ? 24 : 30,
    thY: H * (narrow ? 0.85 : 0.865), tw: Math.min(340, W - 56), th: narrow ? 48 : 56,
    gs, gcy: H * (narrow ? 0.41 : 0.43), R1: gs * 0.66,
  };
}

export interface SceneOptions {
  reduced: boolean;
  sound: EggSound;
  onStage: (stage: Stage) => void;
}

export class Scene {
  private readonly ctx: CanvasRenderingContext2D;
  private L: Layout;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private time = 0;
  private stage: Stage = 'recede';
  private stageTime = 0;

  private beads: Bead[] = [];
  private cols: Bead[][] = Array.from({ length: BINS }, () => []);
  private bench: Bead[] = [];
  private flyers: Flyer[];
  private readonly seal: DOMRect | null;
  private readonly scaleRect: DOMRect | null;

  private b0 = freshBias();
  private theta = 0;
  private omega = 0;
  private dragging = false;
  private dragX = 0;
  private dragVel = 0;
  private lastDiv = 0;
  private epoch = 0;
  private stillSum = 0;
  private stillN = 0;
  private spawnAcc = 0;
  private lastInput = 0;
  private ui = 0;
  private dial = 0;
  private stampU = 0;
  private stamped = false;
  private stampImage: HTMLCanvasElement | null = null;
  private shake = 0;
  private pointer = { x: -1e4, y: -1e4 };
  private leaving = false;
  private stillCue = 0;

  constructor(private readonly canvas: HTMLCanvasElement, seed: Harvest, private readonly opts: SceneOptions) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    this.ctx = ctx;
    this.L = layout(window.innerWidth, window.innerHeight);
    this.seal = seed.seal;
    this.scaleRect = seed.scale;
    const n = Math.max(1, seed.glyphs.length);
    this.flyers = seed.glyphs.map((g, i) => ({ g, delay: 0.15 + (i / n) * RECEDE_SPREAD + Math.random() * 0.12, dur: 1.5, done: false }));
  }

  start(): void {
    this.resize();
    if (this.opts.reduced) {
      this.toStatic();
      this.draw();
      // The still drops the motion, never the sound: the chord and the stamp still land.
      this.stillCue = window.setTimeout(() => {
        this.opts.sound.bloom();
        this.opts.sound.thud();
        haptic('stamp');
      }, 600);
      return;
    }
    this.last = performance.now();
    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.stillCue);
    this.opts.sound.stopBeat();
  }

  resize(): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(W * this.dpr);
    this.canvas.height = Math.round(H * this.dpr);
    this.L = layout(W, H);
    if (this.stage === 'lock' || this.stage === 'certified') {
      this.stampImage = null;
      this.formGlyph(true);
    }
    if (this.opts.reduced) this.draw();
  }

  leave(): void {
    this.leaving = true;
    this.opts.sound.stopBeat();
  }

  // Input ---------------------------------------------------------------------------------

  pointerDown(x: number, y: number): void {
    this.lastInput = this.time;
    this.pointer = { x, y };
    if (this.stage === 'certified') {
      this.strike(x, y);
      return;
    }
    if (this.stage !== 'calibrate' && !(this.stage === 'recede' && this.time > 2.4)) return;
    this.dragging = true;
    this.dragX = x;
    this.dragVel = 0;
    this.omega = 0;
  }

  pointerMove(x: number, y: number): void {
    this.pointer = { x, y };
    if (!this.dragging) return;
    const dx = x - this.dragX;
    this.dragX = x;
    // Slow drags move a fraction of a division; fast ones gear up for coarse travel.
    const dTheta = (dx / (this.L.tw / 2)) * (1 + Math.min(3, Math.abs(dx) / 6));
    this.turn(dTheta);
    this.dragVel = lerp(this.dragVel, dTheta / (1 / 60), 0.5);
    this.lastInput = this.time;
  }

  pointerUp(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.omega = clamp(this.dragVel, -40, 40);
  }

  pointerLeave(): void {
    this.pointer = { x: -1e4, y: -1e4 };
    this.pointerUp();
  }

  /** Arrow keys and the wheel: `divisions` graduations of the thimble. */
  nudge(divisions: number): void {
    if (this.stage !== 'calibrate') return;
    this.lastInput = this.time;
    this.omega = 0;
    this.turn((divisions / DIVISIONS) * 2 * Math.PI);
  }

  reset(): void {
    if (this.stage !== 'certified' && this.stage !== 'lock') return;
    this.b0 = freshBias();
    this.theta = 0;
    this.omega = 0;
    this.lastDiv = 0;
    this.epoch += 1;
    this.stillSum = 0;
    this.stillN = 0;
    this.stamped = false;
    this.stampImage = null;
    this.cols = Array.from({ length: BINS }, () => []);
    this.bench = [];
    // The standard dissolves back into readings and falls onto the bench again.
    for (const b of this.beads) {
      if (b.mode === 'fade') continue;
      this.drop(b, b.x, b.y);
    }
    this.lastInput = this.time;
    this.setStage('calibrate');
    this.opts.sound.startBeat(this.beatHz());
  }

  private turn(dTheta: number): void {
    this.theta += dTheta;
    const div = Math.round((this.theta / (2 * Math.PI)) * DIVISIONS);
    if (div !== this.lastDiv) {
      this.lastDiv = div;
      this.opts.sound.detent();
    }
    // Moving the instrument invalidates the readings taken so far.
    this.epoch += 1;
    this.stillSum = 0;
    this.stillN = 0;
  }

  private get bias(): number {
    return this.b0 + (this.theta / (2 * Math.PI)) * TURN;
  }

  private beatHz(): number {
    return 2.6 * Math.abs(this.bias);
  }

  // Simulation ----------------------------------------------------------------------------

  private setStage(stage: Stage): void {
    this.stage = stage;
    this.stageTime = 0;
    this.opts.onStage(stage);
  }

  private binOf(value: number): number {
    return clamp(Math.floor(((value + SPAN / 2) / SPAN) * BINS), 0, BINS - 1);
  }

  private binX(bin: number): number {
    return this.L.ax0 + (bin + 0.5) * this.L.binPx;
  }

  private slotY(slot: number): number {
    return this.L.baseY - this.L.r - slot * this.L.step;
  }

  private newBead(x: number, y: number, r: number): Bead {
    const bead: Bead = {
      x, y, vx: 0, vy: 0, r, alpha: 1, mode: 'fall', value: 0, bin: 0, epoch: 0,
      sx: x, sy: y, t: 0, tFall: 0.4, hx: x, hy: y, hr: r, delay: 0, arrived: false,
    };
    this.beads.push(bead);
    return bead;
  }

  /** Turns a bead into a fresh reading falling from (x, y). */
  private drop(b: Bead, x: number, y: number): void {
    b.mode = 'fall';
    b.value = this.bias + gauss() * SIGMA;
    b.bin = this.binOf(b.value);
    b.epoch = this.epoch;
    b.sx = x;
    b.sy = y;
    b.t = 0;
    b.tFall = Math.sqrt((2 * Math.max(30, this.L.baseY - y)) / GRAVITY);
  }

  private land(b: Bead): void {
    b.mode = 'rest';
    this.cols[b.bin].push(b);
    this.bench.push(b);
    if (b.epoch === this.epoch) {
      this.stillSum += b.value;
      this.stillN += 1;
    }
    this.opts.sound.ping(b.bin / BINS, 0.8);
    // Felt only while the operator's hand is on the thimble, never as a background buzz.
    if (this.dragging || this.time - this.lastInput < 0.5) haptic('reading');
    while (this.bench.length > WINDOW) {
      const old = this.bench.shift() as Bead;
      const col = this.cols[old.bin];
      col.splice(col.indexOf(old), 1);
      old.mode = 'fade';
    }
  }

  private update(dt: number): void {
    this.time += dt;
    this.stageTime += dt;
    const L = this.L;
    const time = this.time;

    // The page's characters condense into readings once they have receded.
    for (const f of this.flyers) {
      if (f.done || time < f.delay + f.dur) continue;
      f.done = true;
      const p = this.flyerPose(f, 1);
      this.drop(this.newBead(p.x, p.y, L.r), p.x, p.y);
    }
    if (this.stage === 'recede' && time >= CALIBRATE_AT) {
      this.setStage('calibrate');
      this.lastInput = time;
      this.opts.sound.startBeat(this.beatHz());
    }

    if (this.stage === 'calibrate') {
      if (!this.dragging && this.omega !== 0) {
        this.turn(this.omega * dt);
        this.omega *= Math.exp(-dt * 3.4);
        if (Math.abs(this.omega) < 0.03) this.omega = 0;
      }
      this.spawnAcc += dt * RATE;
      while (this.spawnAcc >= 1) {
        this.spawnAcc -= 1;
        const x = L.cx + (Math.random() - 0.5) * L.sealSize * 0.4;
        const y = L.srcY + L.sealSize * 0.55;
        this.drop(this.newBead(x, y, L.r * 0.4), x, y);
      }
      if (!this.leaving) this.opts.sound.setBeat(this.beatHz());
      if (Math.abs(this.bias) < TOLERANCE && this.stillN >= LOCK_READINGS && !this.dragging && this.omega === 0) this.lock();
    }

    if (this.stage === 'lock' && this.stageTime > 2.2) this.certify();
    if (this.stage === 'certified' && !this.stamped && this.stageTime >= STAMP_AT + 0.16) {
      this.stamped = true;
      this.shake = 1;
      this.opts.sound.thud();
      haptic('stamp');
    }
    this.shake = Math.max(0, this.shake - dt * 4);

    const uiTarget = this.stage === 'recede' || this.stage === 'calibrate' ? 1 : 0;
    this.ui = lerp(this.ui, uiTarget, clamp(dt * (uiTarget ? 3 : 2.2)));
    this.dial = lerp(this.dial, this.stage === 'certified' ? 1 : 0, clamp(dt * 3));

    // Resting columns settle into their slots; removing a reading lets the stack drop.
    for (const col of this.cols) {
      col.forEach((b, i) => {
        const k = clamp(dt * 16);
        b.x = lerp(b.x, this.binX(b.bin), k);
        b.y = lerp(b.y, this.slotY(i), k);
        b.r = lerp(b.r, L.r, k);
      });
    }

    for (const b of this.beads) {
      if (b.mode === 'fall') {
        b.t += dt;
        b.x = lerp(b.sx, this.binX(b.bin), easeOut(clamp(b.t / b.tFall)));
        b.y = b.sy + 0.5 * GRAVITY * b.t * b.t;
        b.r = lerp(b.r, L.r, clamp(dt * 10));
        b.alpha = lerp(b.alpha, 1, clamp(dt * 8));
        if (b.y >= this.slotY(this.cols[b.bin].length)) this.land(b);
      } else if (b.mode === 'fade') {
        b.alpha -= dt * 2.5;
        b.r *= 1 - dt * 2;
      } else if (b.mode === 'form') {
        this.updateForm(b, dt);
      }
    }
    if (this.beads.some((b) => b.mode === 'fade' && b.alpha <= 0)) {
      this.beads = this.beads.filter((b) => b.mode !== 'fade' || b.alpha > 0);
    }
  }

  private updateForm(b: Bead, dt: number): void {
    const local = this.stageTime - b.delay;
    if (this.stage === 'lock' && local < 0) {
      b.y += Math.sin(this.time * 6 + b.hx * 0.05) * 0.08;
      return;
    }
    const k = 70;
    const c = 2 * Math.sqrt(k) * 0.62;
    let ax = (b.hx - b.x) * k - b.vx * c;
    let ay = (b.hy - b.y) * k - b.vy * c;
    if (this.stage === 'certified') {
      const dx = b.x - this.pointer.x;
      const dy = b.y - this.pointer.y;
      const reach = this.L.narrow ? 54 : 78;
      const d2 = dx * dx + dy * dy;
      if (d2 < reach * reach && d2 > 0.01) {
        const d = Math.sqrt(d2);
        const f = (1 - d / reach) ** 2 * 5200;
        ax += (dx / d) * f;
        ay += (dy / d) * f;
      }
    }
    b.vx += ax * dt;
    b.vy += ay * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.r = lerp(b.r, b.hr, clamp(dt * 6));
    b.alpha = lerp(b.alpha, 1, clamp(dt * 6));
    if (!b.arrived && Math.abs(b.hx - b.x) + Math.abs(b.hy - b.y) < 4) {
      b.arrived = true;
      this.opts.sound.ping(1 - (b.hy - (this.L.gcy - this.L.gs / 2)) / this.L.gs, 0.7);
    }
  }

  private lock(): void {
    this.stampU = (2 * SIGMA) / Math.sqrt(this.stillN);
    this.setStage('lock');
    this.opts.sound.resolve();
    this.formGlyph(false);
  }

  private certify(): void {
    this.setStage('certified');
    this.opts.sound.bloom();
  }

  private toStatic(): void {
    this.stampU = (2 * SIGMA) / Math.sqrt(LOCK_READINGS);
    this.time = CALIBRATE_AT + 10;
    this.ui = 0;
    this.dial = 1;
    this.stamped = true;
    this.flyers.forEach((f) => { f.done = true; });
    this.stage = 'certified';
    this.stageTime = 60;
    this.opts.onStage('certified');
    this.formGlyph(true);
  }

  /** Samples 量 into a hex lattice and sends every reading on the bench to a point of it. */
  private formGlyph(instant: boolean): void {
    const L = this.L;
    const size = Math.max(64, Math.round(L.gs));
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return;
    octx.fillStyle = '#000';
    octx.font = `900 ${size * 0.94}px ${SANS}`;
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillText('量', size / 2, size / 2 + size * 0.03);
    const data = octx.getImageData(0, 0, size, size).data;
    let filled = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) filled += 1;

    const alive = this.beads.filter((b) => b.mode !== 'fade');
    const want = clamp(alive.length, L.narrow ? 300 : 380, L.narrow ? 420 : 560);
    const sp = Math.sqrt(filled / (0.866 * want));
    const targets: { x: number; y: number }[] = [];
    for (let row = 0, y = sp / 2; y < size; row += 1, y += sp * 0.866) {
      for (let x = (row % 2 ? sp / 2 : 0) + sp / 4; x < size; x += sp) {
        if (data[((y | 0) * size + (x | 0)) * 4 + 3] > 128) targets.push({ x: L.cx - size / 2 + x, y: L.gcy - size / 2 + y });
      }
    }
    // Extra readings rise out of the axis, beneath the stroke they will fill.
    while (alive.length < targets.length) {
      const t = targets[alive.length];
      const b = this.newBead(t.x, L.baseY, 0);
      b.alpha = 0;
      alive.push(b);
    }
    alive.sort((a, b) => a.x - b.x || b.y - a.y);
    targets.sort((a, b) => a.x - b.x || b.y - a.y);
    const used = new Set<Bead>();
    targets.forEach((t, i) => {
      const b = alive[Math.floor((i * alive.length) / targets.length)];
      used.add(b);
      b.mode = 'form';
      b.hx = t.x;
      b.hy = t.y;
      b.hr = sp * 0.4;
      b.arrived = instant;
      // The centre of the distribution rises first; the tails follow.
      b.delay = instant ? 0 : 0.25 + (Math.abs(b.x - L.cx) / (L.aw / 2)) * 0.6 + Math.random() * 0.16;
      if (instant) {
        b.x = t.x;
        b.y = t.y;
        b.r = b.hr;
        b.alpha = 1;
        b.vx = 0;
        b.vy = 0;
      }
    });
    for (const b of alive) if (!used.has(b)) b.mode = 'fade';
    this.cols = Array.from({ length: BINS }, () => []);
    this.bench = [];
  }

  private strike(x: number, y: number): void {
    const reach = this.L.narrow ? 140 : 200;
    let hit = 0;
    for (const b of this.beads) {
      if (b.mode !== 'form') continue;
      const dx = b.x - x;
      const dy = b.y - y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      if (d > reach) continue;
      const f = (1 - d / reach) * 1100;
      b.vx += (dx / d) * f;
      b.vy += (dy / d) * f;
      b.arrived = false;
      hit += 1;
    }
    if (hit) this.opts.sound.scatter();
  }

  // Drawing -------------------------------------------------------------------------------

  private flyerPose(f: Flyer, p: number): { x: number; y: number; s: number; e: number } {
    const L = this.L;
    const e = easeInOut(p);
    const vx = L.cx;
    const vy = lerp(L.srcY, L.baseY, 0.55);
    return {
      x: vx + (f.g.cx - vx) * (1 - 0.6 * e),
      y: vy + (f.g.cy - vy) * (1 - 0.6 * e) - Math.sin(Math.PI * e) * 14,
      s: 1 - 0.8 * e,
      e,
    };
  }

  private draw(): void {
    const { ctx, L } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, L.W, L.H);
    if (this.shake > 0) {
      const s = this.shake * this.shake * 6;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    this.drawDial();
    this.drawAxis();
    this.drawModel();
    this.drawTrueLine();
    this.drawBeads();
    this.drawFlyers();
    this.drawSeal();
    this.drawScope();
    this.drawThimble();
    this.drawReadout();
    this.drawStamp();
  }

  private drawFlyers(): void {
    const { ctx } = this;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    // Deepest first, so characters still on the page are never painted over by receding ones.
    const live = this.flyers
      .filter((f) => !f.done)
      .map((f) => ({ f, p: clamp((this.time - f.delay) / f.dur) }))
      .sort((a, b) => b.p - a.p);
    for (const { f, p } of live) {
      const pose = this.flyerPose(f, p);
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.scale(pose.s, pose.s);
      ctx.font = f.g.font;
      ctx.fillStyle = mix(f.g.rgb, BRASS_RGB, pose.e, 1 - Math.min(1, pose.e * 1.4) * 0.85);
      ctx.fillText(f.g.ch, f.g.x - f.g.cx, f.g.baseline - f.g.cy);
      ctx.restore();
      if (p > 0.65) {
        const k = (p - 0.65) / 0.35;
        ctx.fillStyle = mix(BRASS_RGB, INK_RGB, k, 0.9 * k);
        ctx.beginPath();
        ctx.arc(pose.x, pose.y, this.L.r * k, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawSeal(): void {
    const { ctx, L } = this;
    const p = this.opts.reduced ? 1 : easeInOut(ramp(this.time, 0.2, 1.8));
    const fade = this.stage === 'lock' || this.stage === 'certified' ? this.ui : 1;
    if (fade < 0.01) return;
    const from = this.seal;
    const fx = from ? from.left + from.width / 2 : L.cx;
    const fy = from ? from.top + from.height / 2 : L.srcY;
    const fs = from ? from.width : L.sealSize;
    const x = lerp(fx, L.cx, p);
    const y = lerp(fy, L.srcY, p) - Math.sin(Math.PI * p) * 40;
    const pulse = this.stage === 'calibrate' ? 1 + Math.sin(this.time * 2.2) * 0.02 : 1;
    const size = lerp(fs, L.sealSize, p) * pulse;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(x, y);
    ctx.rotate(p * Math.PI * 2);
    roundRect(ctx, -size / 2, -size / 2, size, size, size * 0.11);
    ctx.fillStyle = C.ink;
    ctx.fill();
    roundRect(ctx, -size / 2 + size * 0.06, -size / 2 + size * 0.06, size * 0.88, size * 0.88, size * 0.07);
    ctx.strokeStyle = 'rgba(156,122,67,.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.paper;
    ctx.font = `800 ${size * 0.5}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('量', 0, size * 0.03);
    ctx.restore();

    // Within tolerance, a ring around the seal fills as the readings accumulate.
    if (this.stage === 'calibrate' && Math.abs(this.bias) < TOLERANCE && this.stillN > 0) {
      const k = clamp(this.stillN / LOCK_READINGS);
      ctx.beginPath();
      ctx.arc(L.cx, L.srcY, L.sealSize * 0.95, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
      ctx.strokeStyle = C.jade;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  private drawAxis(): void {
    const { ctx, L } = this;
    const p = easeInOut(ramp(this.time, 0.5, 1.6));
    const a = this.ui;
    if (a < 0.01) return;
    const from = this.scaleRect;
    const x0 = lerp(from ? from.left : L.cx, L.ax0, p);
    const w = lerp(from ? from.width : 0, L.aw, p);
    const y = lerp(from ? from.bottom : L.baseY, L.baseY, p);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y + 0.5);
    ctx.lineTo(x0 + w, y + 0.5);
    for (let i = 0; i <= BINS; i += 1) {
      const x = Math.round(x0 + (i / BINS) * w) + 0.5;
      const len = i % 5 === 0 ? 10 : 5;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + len);
    }
    ctx.stroke();
    const labels = ramp(this.time, 1.9, 0.6);
    if (labels > 0) {
      ctx.globalAlpha = a * labels;
      ctx.fillStyle = C.muted;
      ctx.font = `${L.narrow ? 9 : 11}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let v = -SPAN / 2; v <= SPAN / 2; v += 1) {
        if (L.narrow && v % 2 !== 0) continue;
        ctx.fillText(v > 0 ? `+${v}` : `${v}`, x0 + ((v + SPAN / 2) / SPAN) * w, y + 14);
      }
    }
    ctx.restore();
  }

  /** The expected shape for the current setting: it moves the instant the thimble turns. */
  private drawModel(): void {
    const { ctx, L } = this;
    const a = this.ui * ramp(this.time, CALIBRATE_AT - 0.4, 1);
    if (a < 0.01) return;
    const scale = (WINDOW * (SPAN / BINS)) / (SIGMA * Math.sqrt(2 * Math.PI)) * L.step;
    ctx.save();
    ctx.globalAlpha = a * 0.6;
    ctx.strokeStyle = C.brass;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let px = 0; px <= L.aw; px += 3) {
      const z = ((px / L.unit - SPAN / 2) - this.bias) / SIGMA;
      const y = L.baseY - Math.exp(-0.5 * z * z) * scale;
      if (px === 0) ctx.moveTo(L.ax0 + px, y);
      else ctx.lineTo(L.ax0 + px, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Mean of the readings since the last adjustment, with its expanded uncertainty.
    if (this.stillN >= 3) {
      const mean = this.stillSum / this.stillN;
      const u = (2 * SIGMA) / Math.sqrt(this.stillN);
      const xm = L.ax0 + (mean + SPAN / 2) * L.unit;
      const top = L.srcY + L.sealSize * 1.4;
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(45,122,100,.08)';
      ctx.fillRect(xm - u * L.unit, top, u * 2 * L.unit, L.baseY - top);
      ctx.strokeStyle = C.brass;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xm, L.baseY);
      ctx.lineTo(xm, top);
      ctx.stroke();
      ctx.fillStyle = C.brass;
      ctx.beginPath();
      ctx.moveTo(xm, L.baseY + 1);
      ctx.lineTo(xm - 5, L.baseY + 9);
      ctx.lineTo(xm + 5, L.baseY + 9);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawTrueLine(): void {
    const { ctx, L } = this;
    const grow = easeOut(ramp(this.time, 1.8, 0.9));
    const a = this.ui;
    if (grow <= 0 || a < 0.01) return;
    const near = this.stage === 'calibrate' && Math.abs(this.bias) < TOLERANCE;
    const top = L.srcY + L.sealSize * 1.4;
    const y1 = lerp(L.baseY, top, grow);
    ctx.save();
    ctx.globalAlpha = a;
    if (near) {
      ctx.shadowColor = 'rgba(45,122,100,.55)';
      ctx.shadowBlur = 10 + Math.sin(this.time * 5) * 4;
    }
    ctx.strokeStyle = C.jade;
    ctx.lineWidth = near ? 2 : 1.25;
    ctx.beginPath();
    ctx.moveTo(L.cx, L.baseY);
    ctx.lineTo(L.cx, y1);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = C.jade;
    ctx.beginPath();
    ctx.moveTo(L.cx, L.baseY - 1);
    ctx.lineTo(L.cx - 6, L.baseY - 11);
    ctx.lineTo(L.cx + 6, L.baseY - 11);
    ctx.globalAlpha = a * 0.9;
    ctx.fill();
    ctx.restore();
  }

  private drawBeads(): void {
    const { ctx, L } = this;
    const sweep = this.stage === 'certified' ? ((this.stageTime * 0.45) % 1.6) - 0.3 : -9;
    for (const b of this.beads) {
      if (b.r < 0.3 || b.alpha <= 0) continue;
      let fill: string;
      if (b.mode === 'form') {
        // A jade scan line passes across the standard now and then.
        const u = (b.hx - (L.cx - L.gs / 2)) / L.gs;
        const glow = clamp(1 - Math.abs(u - sweep) * 7);
        fill = glow > 0.02 ? mix(INK_RGB, [45, 122, 100], glow, b.alpha) : `rgba(27,42,68,${b.alpha})`;
      } else if (b.mode === 'rest' && b.epoch !== this.epoch) {
        fill = `rgba(90,103,121,${0.42 * b.alpha})`; // readings taken before the last adjustment
      } else {
        fill = `rgba(27,42,68,${0.88 * b.alpha})`;
      }
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Oscilloscope trace of the two summed tones: the envelope beats at the error frequency. */
  private drawScope(): void {
    const { ctx, L } = this;
    const a = this.ui * easeOut(ramp(this.time, 1.4, 0.8));
    if (a < 0.01) return;
    const reveal = easeOut(ramp(this.time, 1.4, 1.2));
    const w = L.aw * reveal;
    const amp = L.narrow ? 12 : 16;
    const hz = this.stage === 'calibrate' || this.stage === 'recede' ? this.beatHz() : 0;
    const tt = this.time;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = 'rgba(27,42,68,.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L.ax0, L.scopeY - amp - 6);
    ctx.lineTo(L.ax0 + w, L.scopeY - amp - 6);
    ctx.moveTo(L.ax0, L.scopeY + amp + 6);
    ctx.lineTo(L.ax0 + w, L.scopeY + amp + 6);
    ctx.stroke();
    const near = Math.abs(this.bias) < TOLERANCE;
    ctx.strokeStyle = near ? C.jade : C.ink;
    ctx.globalAlpha = a * (near ? 0.85 : 0.6);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i <= w; i += 2) {
      const taper = Math.sin((Math.PI * i) / L.aw) ** 0.6;
      const env = Math.abs(Math.cos(Math.PI * hz * (tt - (i / L.aw) * 1.6)));
      const y = L.scopeY + amp * env * taper * Math.sin(i * 0.42 - tt * 16);
      if (i === 0) ctx.moveTo(L.ax0 + i, y);
      else ctx.lineTo(L.ax0 + i, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawThimble(): void {
    const { ctx, L } = this;
    const a = this.ui * easeOut(ramp(this.time, 2.1, 0.8));
    if (a < 0.01) return;
    const rise = (1 - easeOut(ramp(this.time, 2.1, 0.8))) * 18;
    const R = L.tw / 2;
    const x0 = L.cx - R;
    const y0 = L.thY - L.th / 2 + rise;
    ctx.save();
    ctx.globalAlpha = a;

    const body = ctx.createLinearGradient(x0, 0, x0 + L.tw, 0);
    body.addColorStop(0, '#cfc4ad');
    body.addColorStop(0.2, '#ece4d3');
    body.addColorStop(0.45, '#fcfaf5');
    body.addColorStop(0.75, '#e6ddca');
    body.addColorStop(1, '#bcae94');
    roundRect(ctx, x0, y0, L.tw, L.th, 8);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = 'rgba(27,42,68,.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    roundRect(ctx, x0, y0, L.tw, L.th, 8);
    ctx.clip();
    ctx.font = `${L.narrow ? 9 : 10}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let j = 0; j < DIVISIONS; j += 1) {
      const phi = (j / DIVISIONS) * Math.PI * 2 + this.theta;
      const depth = Math.cos(phi);
      if (depth <= 0.03) continue;
      const x = L.cx + R * 0.97 * Math.sin(phi);
      const len = j % 10 === 0 ? L.th * 0.42 : j % 5 === 0 ? L.th * 0.3 : L.th * 0.18;
      ctx.strokeStyle = `rgba(27,42,68,${0.75 * depth})`;
      ctx.lineWidth = j % 10 === 0 ? 1.3 : 0.9;
      ctx.beginPath();
      ctx.moveTo(x, y0 + 4);
      ctx.lineTo(x, y0 + 4 + len);
      ctx.stroke();
      if (j % 10 === 0 && depth > 0.3) {
        ctx.save();
        ctx.translate(x, y0 + L.th * 0.68);
        ctx.scale(depth, 1);
        ctx.fillStyle = `rgba(27,42,68,${0.8 * depth})`;
        ctx.fillText(String(j), 0, 0);
        ctx.restore();
      }
    }
    // Knurled grip along the bottom edge.
    for (let j = 0; j < 160; j += 1) {
      const phi = (j / 160) * Math.PI * 2 + this.theta;
      const depth = Math.cos(phi);
      if (depth <= 0.05) continue;
      const x = L.cx + R * Math.sin(phi);
      ctx.strokeStyle = `rgba(27,42,68,${0.28 * depth})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y0 + L.th - 11);
      ctx.lineTo(x, y0 + L.th - 3);
      ctx.stroke();
    }
    ctx.restore();

    // Fixed datum index above the thimble.
    ctx.fillStyle = C.jade;
    ctx.beginPath();
    ctx.moveTo(L.cx, y0 + 2);
    ctx.lineTo(L.cx - 6, y0 - 8);
    ctx.lineTo(L.cx + 6, y0 - 8);
    ctx.fill();
    ctx.strokeStyle = C.jade;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(L.cx, y0);
    ctx.lineTo(L.cx, y0 + L.th * 0.5);
    ctx.stroke();

    // If nobody has touched it for a while, chevrons breathe on both sides.
    const idle = this.time - this.lastInput;
    if (this.stage === 'calibrate' && idle > 4) {
      const k = clamp((idle - 4) / 0.6) * (0.5 + 0.5 * Math.sin(this.time * 4));
      const off = 14 + Math.sin(this.time * 4) * 4;
      ctx.strokeStyle = C.brass;
      ctx.globalAlpha = a * k;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const cy = y0 + L.th / 2;
      ctx.moveTo(x0 - off, cy - 7); ctx.lineTo(x0 - off - 7, cy); ctx.lineTo(x0 - off, cy + 7);
      ctx.moveTo(x0 + L.tw + off, cy - 7); ctx.lineTo(x0 + L.tw + off + 7, cy); ctx.lineTo(x0 + L.tw + off, cy + 7);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawReadout(): void {
    const { ctx, L } = this;
    const a = this.ui * ramp(this.time, 2.6, 0.6);
    if (a < 0.01) return;
    const mean = this.stillN ? this.stillSum / this.stillN : this.bias;
    const sign = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
    const u = this.stillN ? `±${((2 * SIGMA) / Math.sqrt(this.stillN)).toFixed(2)}` : '—';
    const text = `x̄ ${sign(mean)}    U(k=2) ${u}    n ${String(this.stillN).padStart(3, ' ')}`;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = Math.abs(this.bias) < TOLERANCE ? C.jade : C.muted;
    ctx.font = `${L.narrow ? 11 : 12}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, L.cx, L.baseY + (L.narrow ? 40 : 46));
    ctx.restore();
  }

  private drawDial(): void {
    const { ctx, L } = this;
    const a = this.dial;
    if (a < 0.01) return;
    const d = this.stageTime;
    const { cx, gcy: cy, R1 } = L;
    const fs = Math.max(14, R1 * 0.11);
    const Rm = R1 + fs * 1.05;
    const R2 = R1 + fs * 2.1;
    ctx.save();
    ctx.globalAlpha = a;

    // Ripples: the standard's reach spreading outward, ring after ring.
    for (let k = 0; k < 3; k += 1) {
      const p = ramp(d, 0.1 + k * 0.28, 2.6);
      if (p <= 0 || p >= 1) continue;
      const r = lerp(R2, Math.hypot(L.W, L.H) * 0.7, easeOut(p));
      ctx.globalAlpha = a * (1 - p) * 0.5;
      ctx.strokeStyle = k === 1 ? C.jade : C.brass;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < 120; i += 1) {
        const ang = (i / 120) * Math.PI * 2;
        const len = i % 10 === 0 ? 9 : 4;
        ctx.moveTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
        ctx.lineTo(cx + Math.cos(ang) * (r - len), cy + Math.sin(ang) * (r - len));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = a;

    const draw = easeInOut(ramp(d, 0, 1.2));
    ctx.strokeStyle = 'rgba(27,42,68,.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R1, -Math.PI / 2, -Math.PI / 2 + draw * Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(156,122,67,.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, R2, Math.PI / 2, Math.PI / 2 + draw * Math.PI * 2);
    ctx.stroke();

    // Graduated ring, turning into calibration.
    const tick = easeOut(ramp(d, 0.3, 1.6));
    const rot = (1 - tick) * -0.6;
    ctx.globalAlpha = a * tick;
    ctx.beginPath();
    for (let i = 0; i < 100; i += 1) {
      const ang = (i / 100) * Math.PI * 2 + rot - Math.PI / 2;
      const len = i % 10 === 0 ? 12 : i % 5 === 0 ? 8 : 4;
      ctx.moveTo(cx + Math.cos(ang) * R1, cy + Math.sin(ang) * R1);
      ctx.lineTo(cx + Math.cos(ang) * (R1 - len), cy + Math.sin(ang) * (R1 - len));
    }
    ctx.strokeStyle = C.brass;
    ctx.stroke();
    ctx.fillStyle = C.jade;
    ctx.beginPath();
    ctx.moveTo(cx, cy - R1 + 1);
    ctx.lineTo(cx - 5, cy - R1 - 9);
    ctx.lineTo(cx + 5, cy - R1 - 9);
    ctx.fill();

    // The motto, written around the standard one character at a time.
    const spread = Math.min(0.32, (fs * 1.5) / Rm);
    ctx.font = `700 ${fs}px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    MOTTO.forEach((line, row) => {
      Array.from(line).forEach((ch, k) => {
        const appear = easeOut(ramp(d, 0.9 + (row * 4 + k) * 0.13, 0.5));
        if (appear <= 0) return;
        const off = (k - 1.5) * spread;
        const ang = row === 0 ? -Math.PI / 2 + off : Math.PI / 2 - off;
        ctx.save();
        ctx.translate(cx + Math.cos(ang) * Rm, cy + Math.sin(ang) * Rm);
        ctx.rotate(row === 0 ? ang + Math.PI / 2 : ang - Math.PI / 2);
        ctx.scale(lerp(1.6, 1, appear), lerp(1.6, 1, appear));
        ctx.globalAlpha = a * appear;
        ctx.fillStyle = C.ink;
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      });
    });
    ctx.globalAlpha = a * easeOut(ramp(d, 1.9, 0.4));
    ctx.fillStyle = C.brass;
    for (const ang of [0, Math.PI]) {
      const x = cx + Math.cos(ang) * Rm;
      const y = cy + Math.sin(ang) * Rm;
      ctx.beginPath();
      ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y);
      ctx.fill();
    }
    ctx.restore();
  }

  private buildStamp(scale: number): HTMLCanvasElement {
    const w = 168 * scale;
    const h = 100 * scale;
    const pad = 12 * scale;
    const off = document.createElement('canvas');
    off.width = Math.ceil((w + pad * 2) * this.dpr);
    off.height = Math.ceil((h + pad * 2) * this.dpr);
    const c = off.getContext('2d');
    if (!c) return off;
    c.scale(this.dpr, this.dpr);
    c.translate(pad, pad);
    c.strokeStyle = C.seal;
    c.fillStyle = C.seal;
    c.lineWidth = 3.2 * scale;
    roundRect(c, 0, 0, w, h, 8 * scale);
    c.stroke();
    c.lineWidth = 1 * scale;
    roundRect(c, 5 * scale, 5 * scale, w - 10 * scale, h - 10 * scale, 5 * scale);
    c.stroke();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `900 ${30 * scale}px ${SERIF}`;
    c.fillText('校准合格', w / 2, h * 0.38);
    c.fillRect(w * 0.16, h * 0.6, w * 0.68, 1.2 * scale);
    c.font = `${10.5 * scale}px ${MONO}`;
    const now = new Date();
    const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    c.fillText(`U = ±${this.stampU.toFixed(3)}  k=2`, w / 2, h * 0.72);
    c.fillText(`CJLU · ${date}`, w / 2, h * 0.86);
    // Uneven ink: knock out specks so it reads as pressed, not printed.
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 260; i += 1) {
      c.globalAlpha = Math.random() * 0.8;
      c.beginPath();
      c.arc(Math.random() * w, Math.random() * h, Math.random() * 1.6 * scale, 0, Math.PI * 2);
      c.fill();
    }
    return off;
  }

  private drawStamp(): void {
    const { ctx, L } = this;
    if (this.stage !== 'certified') return;
    const t = this.stageTime - STAMP_AT;
    if (t < 0) return;
    const scale = clamp(L.W / 640, 0.62, 1);
    if (!this.stampImage) this.stampImage = this.buildStamp(scale);
    const img = this.stampImage;
    const w = img.width / this.dpr;
    const h = img.height / this.dpr;
    const k = clamp(t / 0.16);
    const s = lerp(2.3, 1, easeIn(k));
    const x = Math.min(L.W - w / 2 - 4, L.cx + L.R1 * 0.74);
    const y = Math.min(L.H - h / 2 - 90, L.gcy + L.R1 * 0.7);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.21);
    ctx.scale(s, s);
    ctx.globalAlpha = 0.9 * k;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
}
