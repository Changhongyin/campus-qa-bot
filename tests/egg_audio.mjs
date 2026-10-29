// Manual check for the easter egg's audio and haptics (not part of the Python suite).
// Run the front end with `npx vite --port 5199`, then:
//   npm i --no-save puppeteer-core && node tests/egg_audio.mjs [--reduced]
// EDGE_PATH or CHROME_PATH overrides the browser binary.
//
// Drives the easter egg in headless Edge with a gesture-gated autoplay policy and records
// AudioContext state, every scheduled source (with the context state at the time), and
// every navigator.vibrate call.
import puppeteer from 'puppeteer-core';

const URL = process.env.EGG_URL ?? 'http://localhost:5199/';
const reduced = process.argv.includes('--reduced');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.EDGE_PATH ?? process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--autoplay-policy=user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.evaluateOnNewDocument(() => {
  const log = { starts: [], suspendedStarts: 0, vibrate: [], ctx: null };
  window.__log = log;
  const Orig = window.AudioContext;
  window.AudioContext = class extends Orig {
    constructor(...a) { super(...a); log.ctx = this; log.createdState = this.state; }
  };
  const start = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function (...a) {
    if (this.context.state !== 'running') log.suspendedStarts += 1;
    log.starts.push(this.constructor.name);
    return start.apply(this, a);
  };
  navigator.vibrate = (p) => { log.vibrate.push(JSON.stringify(p)); return true; };
});

const snap = () => page.evaluate(() => ({
  state: window.__log.ctx?.state ?? 'none',
  createdState: window.__log.createdState,
  starts: window.__log.starts.length,
  suspendedStarts: window.__log.suspendedStarts,
  vibrate: [...window.__log.vibrate],
  stage: document.querySelector('.egg')?.dataset.stage ?? null,
}));

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.removeItem('ldzd-egg-muted'));
await sleep(1500);
const seal = await page.$('.seal-trigger');
const box = await seal.boundingBox();
const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;

await page.mouse.click(cx, cy); await sleep(150);
console.log('after knock 1', await snap());
await page.mouse.click(cx, cy); await sleep(150);
console.log('after knock 2', await snap());
await page.mouse.click(cx, cy); await sleep(400);
console.log('after knock 3 (open)', await snap());

if (!reduced) {
  await sleep(5000);
  console.log('calibrating', await snap());
  // Zero the bias directly, then let the readings settle and the stamp land.
  await page.evaluate(() => {
    const s = window.__eggScene;
    // bias = b0 + theta/2π * TURN; solve for theta using two probes.
    const probe = (t) => { s.theta = t; return s.bias; };
    const b0 = probe(0); const b1 = probe(1);
    s.theta = -b0 / (b1 - b0);
    s.epoch += 1; s.stillSum = 0; s.stillN = 0;
  });
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const st = await snap();
    if (st.stage === 'certified') break;
  }
  await sleep(2500);
  console.log('certified', await snap());
} else {
  await sleep(1500);
  console.log('reduced still', await snap());
}

// Suspend from outside, then a gesture on the overlay must resume it.
await page.evaluate(() => window.__log.ctx.suspend());
await sleep(200);
const s1 = (await snap()).state;
await page.mouse.click(30, 400); await sleep(300);
console.log('suspended ->', s1, 'after overlay pointerdown ->', (await snap()).state);

// Mute persists across reloads.
await page.click('.egg__icon[aria-pressed]');
const stored = await page.evaluate(() => localStorage.getItem('ldzd-egg-muted'));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1500);
const s2 = await page.$('.seal-trigger'); const b2 = await s2.boundingBox();
for (let i = 0; i < 3; i += 1) { await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2); await sleep(150); }
await sleep(300);
const muteBtn = await page.$eval('.egg__icon[aria-pressed]', (b) => b.getAttribute('aria-pressed'));
console.log('stored muted:', stored, '| after reload button pressed:', muteBtn);

console.log('console errors/warnings:', errors.length ? errors : 'none');
await browser.close();
