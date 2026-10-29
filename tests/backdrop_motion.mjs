// Checks the animated backdrop, the floating landing text and the chat emblem.
//   BASE_URL=http://localhost:4173 node tests/backdrop_motion.mjs
// Screenshots land in screenshots/backdrop-*.png (gitignored).
import { createRequire } from 'node:module';

// Playwright is not a project dependency; use the one installed on the machine.
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch();

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.addInitScript(() => sessionStorage.setItem('ldzd-intro-seen', 'true'));
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000); // let the staggered reveal and the contour draw-in finish
  return { context, page };
}

/** Running, endless animations whose targets sit inside `selector`. */
const loops = (page, selector) => page.evaluate((sel) => document.getAnimations()
  .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity
    && a.effect.target instanceof Element && a.effect.target.closest(sel))
  .map((a) => a.animationName), selector);

/** Positions of the things people click. */
const hitAreas = (page) => page.evaluate(() => [...document.querySelectorAll(
  '.landing__masthead .brand-mark, .landing__cta, .landing__upload, .quick-prompts button, .composer textarea, .composer button')]
  .filter((el) => el.getClientRects().length)
  .map((el) => { const r = el.getBoundingClientRect(); return `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)}`; }));

/** Layout and paint work while the page only animates, from a Chrome performance trace. */
async function traceIdle(page, ms = 4000) {
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame'] });
  await page.waitForTimeout(ms);
  const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  const count = (name) => events.filter((e) => e.name === name).length;
  const styleMs = events.filter((e) => e.name === 'UpdateLayoutTree' && e.ph === 'X')
    .reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000;
  return { layout: count('Layout'), paint: count('Paint'), styleMs, frames: count('DrawFrame'), ms };
}

// ---- landing
{
  const { context, page } = await open();
  const field = await loops(page, '.field');
  const expected = ['field-scroll-x', 'field-scroll-y', 'field-tide', 'field-pulse', 'field-drift', 'field-turn',
    'field-rock', 'field-sway', 'field-bubble'];
  const missing = expected.filter((n) => !field.includes(n));
  check('landing: backdrop is alive', missing.length === 0, `${field.length} loops${missing.length ? `, missing ${missing}` : ''}`);
  const wave = await page.evaluate(() => {
    const anims = document.getAnimations().filter((a) => a.animationName === 'fragment-wave');
    const timing = anims.map((a) => a.effect.getComputedTiming());
    const sheet = anims.some((a) => a.effect.target.closest('.landing__sheet, .landing__masthead, .landing__actions'));
    const rule = [...document.styleSheets].flatMap((s) => [...s.cssRules]).find((r) => r.name === 'fragment-wave');
    const keys = [...new Set([...rule.cssRules].map((k) => k.style.transform))];
    const frames = [...rule.cssRules].reduce((n, k) => n + k.keyText.split(',').length, 0);
    // Freeze the headline's characters at one instant, read their offsets, then advance all of
    // them by the same amount and read again: a travelling wave shifts by whole characters.
    const head = anims.filter((a) => a.effect.target.closest('h1'));
    const ty = () => head.map((a) => new DOMMatrix(getComputedStyle(a.effect.target).transform).m42);
    head.forEach((a) => a.pause());
    const t0 = ty();
    const STEP = 160;
    const SHIFT = 3;
    head.forEach((a) => { a.currentTime += STEP * SHIFT; });
    const t1 = ty();
    head.forEach((a) => a.play());
    const n = t0.length - SHIFT;
    let err = 0;
    for (let i = 0; i < n; i += 1) err = Math.max(err, Math.abs(t1[i] - t0[i + SHIFT]));
    const adjacent = t0.slice(1).map((v, i) => Math.abs(v - t0[i]));
    return {
      count: anims.length, sheet, keys,
      durations: [...new Set(timing.map((t) => t.duration))],
      frames,
      easing: [...new Set(anims.map((a) => getComputedStyle(a.effect.target).animationTimingFunction))],
      delaysStep: head.slice(1).map((a, i) => Math.round(head[i].effect.getComputedTiming().delay - a.effect.getComputedTiming().delay)),
      peak: Math.max(...t0.map(Math.abs)), err, maxAdj: Math.max(...adjacent), minAdj: Math.min(...adjacent), chars: t0.length,
    };
  });
  check('landing: every character floats', wave.count >= 40, `${wave.count} characters`);
  // ten cycles per iteration: 21 keyframes alternating low/high, eased per segment
  check('landing: one period for all, a 5s sine-like cycle',
    wave.durations.length === 1 && wave.durations[0] / 10 === 5000 && wave.frames === 21 && wave.easing.join() === 'ease-in-out',
    `${wave.durations[0] / 10} ms per cycle, ${wave.frames} keyframes, ${wave.easing}`);
  check('landing: amplitude ±3.5px', wave.keys.join(' ') === 'translateY(-3.5px) translateY(3.5px)' && wave.peak <= 3.51,
    `${wave.keys.join(' → ')}, headline peak now ${wave.peak.toFixed(2)}px`);
  check('landing: neighbours are one fixed phase step apart', wave.delaysStep.every((d) => d === 160), `${wave.delaysStep.length + 1} headline characters, 160ms apart`);
  check('landing: neighbours rise and fall together, not as a block', wave.minAdj > 0.01 && wave.maxAdj < 1,
    `adjacent offsets differ by ${wave.minAdj.toFixed(2)}-${wave.maxAdj.toFixed(2)}px`);
  check('landing: the wave travels through the line', wave.err < 0.05,
    `after 480ms each character sits where the one 3 ahead was (max error ${wave.err.toFixed(3)}px)`);
  check('landing: masthead, sheet and buttons do not float', !wave.sheet);
  const before = await hitAreas(page);
  const perf = await traceIdle(page);
  const after = await hitAreas(page);
  check('landing: hit areas never move', before.length >= 3 && before.join('|') === after.join('|'), `${before.length} targets`);
  check('landing: no layout while animating', perf.layout === 0, `${perf.layout} layouts in 4s`);
  check('landing: frames are drawn while animating', perf.frames > 30, `${perf.frames} frames in 4s`);
  check('landing: animations composite, no paint storm', perf.paint === 0, `${perf.paint} paints`);
  // Composited animations still get an occasional, cheap style sync from Chrome; it must stay negligible.
  check('landing: main-thread style work under 2%', perf.styleMs < perf.ms * 0.02, `${perf.styleMs.toFixed(1)} ms of ${perf.ms} ms`);
  check('landing: no emblem behind the reading column', (await page.locator('.field__emblem').count()) === 0);
  const tools = await page.evaluate(() => [...document.querySelectorAll('.field__tool')]
    .map((el) => Number(getComputedStyle(el).opacity)));
  check('landing: instruments faint (≤ 0.12)', tools.length === 7 && tools.every((o) => o <= 0.12), tools.join(','));
  await page.screenshot({ path: 'screenshots/backdrop-landing.png' });

  // ---- chat
  await page.getByTestId('landing-cta').click();
  await page.waitForTimeout(1500);
  const em = await page.evaluate(() => {
    const img = document.querySelector('.chat-shell__body--empty .chat-emblem');
    if (!img) return null;
    const body = img.parentElement.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    const s = getComputedStyle(img);
    // the body's child that holds the greeting is what stacks against the emblem
    const greet = [...img.parentElement.children].find((el) => el.querySelector('.message'));
    return {
      dx: Math.abs(r.x + r.width / 2 - (body.x + body.width / 2)), dy: Math.abs(r.y + r.height / 2 - (body.y + body.height / 2)),
      w: r.width, opacity: Number(s.opacity), z: Number(s.zIndex), greetZ: Number(getComputedStyle(greet).zIndex),
      hidden: img.getAttribute('aria-hidden'), pe: s.pointerEvents, tab: img.tabIndex,
    };
  });
  check('chat: emblem present in the empty state', !!em);
  if (em) {
    check('chat: emblem centred', em.dx < 1 && em.dy < 1, `off by ${em.dx.toFixed(1)},${em.dy.toFixed(1)}px, ${em.w.toFixed(0)}px wide`);
    check('chat: emblem faint (0.05-0.07)', em.opacity >= 0.05 && em.opacity <= 0.07, `opacity ${em.opacity}`);
    check('chat: emblem behind the greeting', em.z < em.greetZ, `z ${em.z} < ${em.greetZ}`);
    check('chat: emblem inert', em.hidden === 'true' && em.pe === 'none' && em.tab < 0);
  }
  const chatLoops = await loops(page, '.field');
  check('chat: backdrop is alive', chatLoops.length >= 9, `${chatLoops.length} loops`);
  const cBefore = await hitAreas(page);
  const cPerf = await traceIdle(page);
  const cAfter = await hitAreas(page);
  check('chat: hit areas never move', cBefore.length >= 3 && cBefore.join('|') === cAfter.join('|'), `${cBefore.length} targets`);
  check('chat: no layout while animating', cPerf.layout === 0, `${cPerf.layout} layouts in 4s`);
  check('chat: frames are drawn while animating', cPerf.frames > 30, `${cPerf.frames} frames in 4s`);
  check('chat: animations composite, no paint storm', cPerf.paint === 0, `${cPerf.paint} paints`);
  // Composited animations still get an occasional, cheap style sync from Chrome; it must stay negligible.
  check('chat: main-thread style work under 2%', cPerf.styleMs < cPerf.ms * 0.02, `${cPerf.styleMs.toFixed(1)} ms of ${cPerf.ms} ms`);
  await page.screenshot({ path: 'screenshots/backdrop-chat.png' });
  await context.close();
}

// ---- zones: no decoration overlaps another, the edge scales, or the content
/**
 * Drawn extent of each motif (union of its shapes' boxes), padded by how far it moves, and the
 * boxes of the content it must keep clear of.
 */
const zoneRects = (page) => page.evaluate(() => {
  // measure every motif at rest, then pad it by how far it moves, so the pad covers its whole sweep
  const still = document.createElement('style');
  still.textContent = '.field, .field * { animation: none !important; transition: none !important; }';
  document.head.append(still);
  // drift amplitude; the scales only slide along their own edge; everything else moves by ≤ 3px
  const PAD = { reticle: 14, contours: 9, 'scale-top': 0, 'scale-left': 0 };
  const union = (rects) => rects.reduce((u, r) => ({
    l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom),
  }), { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity });
  const clip = (u) => ({ l: Math.max(u.l, 0), t: Math.max(u.t, 0), r: Math.min(u.r, innerWidth), b: Math.min(u.b, innerHeight) });
  const motifs = {};
  for (const el of document.querySelectorAll('[data-motif]')) {
    const name = el.dataset.motif;
    const shapes = el.matches('svg, div') ? [...el.querySelectorAll('path, circle, rect, ellipse, line')] : [el];
    motifs[name] = [...(motifs[name] ?? []), ...shapes.map((sh) => sh.getBoundingClientRect())];
  }
  const out = {};
  for (const [name, rects] of Object.entries(motifs)) {
    const u = union(rects);
    const pad = PAD[name] ?? 3;
    out[name] = clip({ l: u.l - pad, t: u.t - pad, r: u.r + pad, b: u.b + pad });
  }
  const content = {};
  const pick = { masthead: '.landing__masthead', eyebrow: '.landing__eyebrow', headline: '.landing h1',
    description: '.landing__description', actions: '.landing__actions', privacy: '.landing__privacy', sheet: '.landing__sheet' };
  for (const [name, sel] of Object.entries(pick)) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const grow = name === 'sheet' ? 10 : 0; // its corner brackets sit just outside
    content[name] = { l: r.left - grow, t: r.top - grow, r: r.right + grow, b: r.bottom + grow };
  }
  still.remove();
  return { motifs: out, content };
});

const hit = (a, b, gap) => a.l < b.r + gap && b.l < a.r + gap && a.t < b.b + gap && b.t < a.b + gap;

for (const [w, h] of [[1440, 900], [1280, 800]]) {
  const { context, page } = await open({ viewport: { width: w, height: h } });
  const { motifs, content } = await zoneRects(page);
  const names = Object.keys(motifs).filter((n) => motifs[n].r > motifs[n].l && motifs[n].b > motifs[n].t);
  const pairs = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      if (hit(motifs[names[i]], motifs[names[j]], 4)) pairs.push(`${names[i]}×${names[j]}`);
    }
  }
  check(`${w}x${h}: no two motifs overlap`, pairs.length === 0, pairs.join(', ') || `${names.length} motifs, all disjoint`);
  const onContent = [];
  for (const m of names) {
    for (const [c, rect] of Object.entries(content)) if (hit(motifs[m], rect, 8)) onContent.push(`${m}×${c}`);
  }
  check(`${w}x${h}: reading area clear of motifs`, onContent.length === 0, onContent.join(', ') || 'clear');
  await page.waitForTimeout(3000); // lifting the hold restarts the backdrop's fade-in and draw-in
  await page.screenshot({ path: `screenshots/backdrop-landing-${w}x${h}.png` });

  await page.getByTestId('landing-cta').click();
  await page.waitForTimeout(1500);
  const clear = await page.evaluate(() => {
    const img = document.querySelector('.chat-shell__body--empty .chat-emblem');
    const e = img.getBoundingClientRect();
    const cx = e.left + e.width / 2;
    const cy = e.top + e.height / 2;
    const inner = e.width * 0.36; // radius of the emblem's open centre: the grey ring's inner edge
    const text = [...document.querySelectorAll('.chat-shell__body--empty .message__content p')].map((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      return range.getBoundingClientRect();
    });
    const far = Math.max(...text.flatMap((r) => [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]]
      .map(([x, y]) => Math.hypot(x - cx, y - cy))));
    return { size: e.width, inner, far };
  });
  check(`${w}x${h}: greeting sits inside the emblem's open centre`, clear.far < clear.inner,
    `emblem ${clear.size.toFixed(0)}px, text reaches ${clear.far.toFixed(0)}px of ${clear.inner.toFixed(0)}px`);
  await page.screenshot({ path: `screenshots/backdrop-chat-${w}x${h}.png` });
  await context.close();
}

// ---- reduced motion
{
  const { context, page } = await open({ reducedMotion: 'reduce' });
  const still = await loops(page, 'body');
  check('reduced motion: nothing loops', still.length === 0, still.join(',') || 'none');
  const visible = await page.evaluate(() => [...document.querySelectorAll('.landing .fragment')]
    .every((el) => getComputedStyle(el).opacity === '1'));
  check('reduced motion: content fully shown', visible);
  await page.screenshot({ path: 'screenshots/backdrop-landing-reduced.png' });
  await page.getByTestId('landing-cta').click();
  await page.waitForTimeout(800);
  check('reduced motion: chat emblem still there',
    (await page.locator('.chat-shell__body--empty .chat-emblem').count()) === 1);
  await page.screenshot({ path: 'screenshots/backdrop-chat-reduced.png' });
  await context.close();
}

// ---- phone
{
  const { context, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.screenshot({ path: 'screenshots/backdrop-landing-phone.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check('phone: no horizontal overflow from the backdrop', !overflow);
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
