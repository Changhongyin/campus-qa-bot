// End-to-end check for the masthead-seal easter egg.
// Run against a dev server (npx vite) or a preview build (npx vite build && npx vite preview):
//   BASE_URL=http://localhost:5173 node tests/easteregg_e2e.mjs
// Screenshots land in screenshots/easteregg-*.png (gitignored).
import { createRequire } from 'node:module';

// Playwright is not a project dependency; use the one installed on the machine.
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => sessionStorage.setItem('ldzd-intro-seen', 'true'));
await page.goto(BASE_URL, { waitUntil: 'networkidle' });
const shot = (name) => page.screenshot({ path: `screenshots/easteregg-${name}.png` });

// Only the landing masthead seal is a trigger.
const seal = page.locator('.landing__masthead .brand-mark');
check('masthead seal is a button with a label',
  (await seal.evaluate((el) => el.tagName)) === 'BUTTON' && !!(await seal.getAttribute('aria-label')));
check('seal keeps its 56x56 look', await seal.evaluate((el) => {
  const box = el.getBoundingClientRect();
  return Math.round(box.width) === 56 && Math.round(box.height) === 56;
}));
check('no other seal is a button', (await page.locator('button.brand-mark').count()) === 1);

await seal.click();
check('click 1: soft shake', (await seal.getAttribute('data-shake')) === 'soft');
check('click 1: nothing mounted', (await page.locator('.egg-root').count()) === 0);
await page.waitForTimeout(250);
await seal.click();
check('click 2: hard shake', (await seal.getAttribute('data-shake')) === 'hard');
check('click 2: media preloading', await page.evaluate(() => {
  const root = document.querySelector('.egg-root');
  return root?.getAttribute('data-phase') === 'armed' && !!root.querySelector('video') && !!root.querySelector('audio');
}));
await page.waitForTimeout(250);
await seal.click();
check('click 3: page recedes', (await page.locator('main').getAttribute('data-egg')) === 'receding');
await page.waitForTimeout(300);
await shot('1-receding');
await page.waitForSelector('.egg-root[data-phase="playing"]', { timeout: 3000 });
check('easter egg mounted after the recede', true);

await page.waitForFunction(() => document.querySelector('.egg-root audio')?.currentTime > 3, null, { timeout: 15000 });
const sync = await page.evaluate(() => {
  const v = document.querySelector('.egg-root video');
  const a = document.querySelector('.egg-root audio');
  return { v: v.currentTime, a: a.currentTime, vd: v.duration, ad: a.duration, muted: v.muted, src: v.currentSrc };
});
check('video and audio play together', Math.abs(sync.v - sync.a) < 0.15, `video ${sync.v.toFixed(3)} audio ${sync.a.toFixed(3)}`);
check('video is muted', sync.muted);
check('video and audio share duration D', Math.abs(sync.vd - sync.ad) < 0.05, `video ${sync.vd} audio ${sync.ad}`);
const devClock = await page.locator('.egg-dev-clock').textContent().catch(() => null);
check('dev clock shows currentTime / duration (dev builds only)', devClock === null || /\d+\.\d\d \/ \d+\.\d\d/.test(devClock), devClock ?? 'production build');
await shot('2-playing');

// Jump the master clock to just before the reveal; the video must follow.
await page.evaluate(() => { document.querySelector('.egg-root audio').currentTime = 157.5; });
await page.waitForFunction(() => {
  const v = document.querySelector('.egg-root video');
  const a = document.querySelector('.egg-root audio');
  return Math.abs(v.currentTime - a.currentTime) < 0.1 && a.currentTime > 158.4;
}, null, { timeout: 8000 });
check('video follows a seek of the master clock', true);
await shot('3-ji');
await page.evaluate(() => { document.querySelector('.egg-root audio').currentTime = 170.5; });
await page.waitForSelector('.egg-root[data-phase="final"]', { timeout: 8000 });
check('final stage after the film ends', true);
const finalState = await page.evaluate(() => {
  const reveal = document.querySelector('.egg-final-reveal');
  const v = document.querySelector('.egg-root video');
  const anim = (sel) => getComputedStyle(document.querySelector(sel)).animationName;
  const dur = (sel) => getComputedStyle(document.querySelector(sel)).animationDuration;
  return {
    state: reveal?.getAttribute('data-state'), empty: reveal?.childNodes.length === 0,
    held: v.currentTime, duration: v.duration,
    grid: `${anim('.egg-final__grid')} ${dur('.egg-final__grid')}`,
    glow: `${anim('.egg-final__glow')} ${dur('.egg-final__glow')}`,
  };
});
check('reveal container is empty and awaiting', finalState.state === 'awaiting' && finalState.empty);
check('video holds its last frame', finalState.duration - finalState.held < 0.1, `${finalState.held} / ${finalState.duration}`);
check('grid drifts 60s', finalState.grid === 'egg-grid-drift 60s', finalState.grid);
check('glow breathes 8s', finalState.glow === 'egg-glow-breathe 8s', finalState.glow);
await page.waitForTimeout(1800);
await shot('4-final');

// The font engineer's per-character spans must lay out even with fallback fonts only.
const layout = await page.evaluate(() => {
  const reveal = document.querySelector('.egg-final-reveal');
  reveal.innerHTML = '<p class="egg-reveal-line"><span data-char>计</span><span data-char>量</span></p>'
    + '<p class="egg-reveal-line" data-motto>精思国计 细量民生</p>';
  const boxes = [...reveal.querySelectorAll('[data-char]')].map((el) => el.getBoundingClientRect());
  const r = reveal.getBoundingClientRect();
  const out = {
    centred: Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2 && Math.abs(r.top + r.height / 2 - innerHeight / 2) < 2,
    oneLine: Math.abs(boxes[0].top - boxes[1].top) < 1 && boxes[0].width > 0 && boxes[1].left > boxes[0].left,
    fonts: [...new Set([...reveal.querySelectorAll('*')].map((el) => getComputedStyle(el).fontFamily))],
  };
  return out;
});
check('reveal container is centred', layout.centred);
check('character spans sit on one line', layout.oneLine);
check('egg text only uses the font slots', layout.fonts.every((f) => /Times New Roman|Georgia/.test(f)), layout.fonts.join(' | '));
await shot('5-handoff-sample');
await page.evaluate(() => { document.querySelector('.egg-final-reveal').innerHTML = ''; });

await page.keyboard.press('Escape');
await page.waitForSelector('.egg-root', { state: 'detached', timeout: 3000 });
check('Escape closes and restores the landing page', (await page.locator('main').getAttribute('data-egg')) === null);
await page.waitForTimeout(1200);
check('landing visible again', await page.locator('.landing').evaluate((el) => getComputedStyle(el).opacity === '1'));
await shot('6-restored');

// Chat page is untouched, and its seal is not a trigger.
await page.getByTestId('landing-cta').click();
await page.waitForTimeout(800);
const chatSeal = page.locator('.chat-header__brand .brand-mark');
check('chat header seal is not interactive', (await chatSeal.evaluate((el) => el.tagName)) === 'SPAN');
await chatSeal.click({ force: true });
await chatSeal.click({ force: true });
await chatSeal.click({ force: true });
await page.waitForTimeout(800);
check('chat seal triple-click does nothing', (await page.locator('.egg-root').count()) === 0);
await shot('7-chat');

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
