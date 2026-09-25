import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Capture the sidebar so the human can see the new persistent entry in context.
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const SHOT = process.env.TEMP + '\\dshsd-shots';

const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1500, height: 1000 },
});
const page = await browser.newPage();
await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});
await page.setCacheEnabled(false);
await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 6000));

// 1. The sidebar alone, with the new entry at its foot.
const entry = await page.evaluate(() => {
  const e = document.querySelector('.dshsd-foot-entry');
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.screenshot({
  path: `${SHOT}\\30-sidebar.png`,
  clip: { x: 0, y: 0, width: 300, height: 1000 },
});
console.log(`sidebar shot; entry box: ${JSON.stringify(entry)}`);

// 2. The picker dialog, opened by a real pointer click.
await page.mouse.click(entry.x + entry.w / 2, entry.y + entry.h / 2);
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${SHOT}\\31-picker.png` });
console.log('picker shot');

// 3. Zoomed crop of the picker's row list.
const list = await page.evaluate(() => {
  const node = document.querySelector('.dshsd-plan');
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: Math.min(1100, r.width + 24), height: Math.min(880, r.height + 24) };
});
if (list) {
  await page.screenshot({ path: `${SHOT}\\32-picker-rows.png`, clip: list });
  console.log(`picker rows shot; clip ${JSON.stringify(list)}`);
}

await browser.close();
console.log(`\nshots in ${SHOT}`);
