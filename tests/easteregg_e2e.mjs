// End-to-end check for the masthead-seal easter egg's hidden entry point.
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
const eggAttr = () => page.locator('main').getAttribute('data-egg');

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
check('click 1: page untouched', (await eggAttr()) === null);
await page.waitForTimeout(250);
await seal.click();
check('click 2: hard shake', (await seal.getAttribute('data-shake')) === 'hard');
check('click 2: armed, page still untouched, nothing mounted',
  (await eggAttr()) === null && (await page.locator('.egg-root').count()) === 0);
await page.waitForTimeout(250);
await seal.click();
check('click 3: page recedes', (await eggAttr()) === 'receding');
await page.waitForTimeout(300);
await shot('1-receding');
await page.waitForSelector('.egg-root[data-phase="placeholder"]', { timeout: 3000 });
check('placeholder stage opens after the recede', (await eggAttr()) === 'placeholder');
check('placeholder is a dialog with focus on Close', await page.evaluate(() => {
  const root = document.querySelector('.egg-root');
  return root?.getAttribute('role') === 'dialog' && document.activeElement?.classList.contains('egg-close');
}));
check('no media elements anywhere', (await page.locator('video, audio').count()) === 0);
const reveal = await page.evaluate(() => {
  const el = document.querySelector('.egg-final-reveal');
  return { state: el?.getAttribute('data-state'), empty: el?.childNodes.length === 0 };
});
check('reveal container present, empty and awaiting', reveal.state === 'awaiting' && reveal.empty);
await page.waitForTimeout(1000);
await shot('2-placeholder');

await page.keyboard.press('Escape');
await page.waitForSelector('.egg-root', { state: 'detached', timeout: 3000 });
check('Escape closes and restores the landing page', (await eggAttr()) === null);
check('focus returns to the seal', await seal.evaluate((el) => el === document.activeElement));
await page.waitForTimeout(1200);
check('landing visible again', await page.locator('.landing').evaluate((el) => getComputedStyle(el).opacity === '1'));
await shot('3-restored');

// The entry point works again after closing, and the Close button closes too.
for (let i = 0; i < 3; i += 1) { await seal.click(); await page.waitForTimeout(250); }
await page.waitForSelector('.egg-root[data-phase="placeholder"]', { timeout: 3000 });
await page.locator('.egg-close').click();
await page.waitForSelector('.egg-root', { state: 'detached', timeout: 3000 });
check('re-opens, and Close returns to the landing page', (await eggAttr()) === null);

// Slow clicks never open it.
await page.waitForTimeout(1600);
for (let i = 0; i < 3; i += 1) { await seal.click(); await page.waitForTimeout(1700); }
check('clicks 1.5s+ apart never open it', (await eggAttr()) === null && (await page.locator('.egg-root').count()) === 0);

// Chat page is untouched, and its seal is not a trigger.
await page.getByTestId('landing-cta').click();
await page.waitForTimeout(800);
const chatSeal = page.locator('.chat-header__brand .brand-mark');
check('chat header seal is not interactive', (await chatSeal.evaluate((el) => el.tagName)) === 'SPAN');
for (let i = 0; i < 3; i += 1) await chatSeal.click({ force: true });
await page.waitForTimeout(800);
check('chat seal triple-click does nothing', (await page.locator('.egg-root').count()) === 0);
await shot('4-chat');

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
