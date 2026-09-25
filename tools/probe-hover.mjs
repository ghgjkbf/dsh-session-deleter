import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Use REAL mouse movement (not synthetic events) so CSS :hover applies, then
// report whether each entry point is actually visible and clickable for a human.
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const SHOT = process.env.TEMP + '\\dshsd-shots';

const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});
await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 5000));

const locateRow = async () => page.evaluate(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find((r) =>
    [...r.querySelectorAll('button')].some((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? '')));
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  return { text: (row.textContent ?? '').trim().slice(0, 50), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height };
});

console.log('=== A. baseline (no pointer over anything) ===');
let row = await locateRow();
console.log(`  row: ${JSON.stringify(row)}`);
console.log(`  ${JSON.stringify(await page.evaluate(() => {
  const t = [...document.querySelectorAll('button')].find((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
  const r = t.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}))}`);

console.log('\n=== B. move the REAL pointer onto the row ===');
await page.mouse.move(row.x, row.y);
await new Promise((r) => setTimeout(r, 900));
console.log(`  ${JSON.stringify(await page.evaluate(() => {
  const t = [...document.querySelectorAll('button')].find((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
  const r = t.getBoundingClientRect();
  return {
    triggerW: Math.round(r.width), triggerH: Math.round(r.height),
    triggerX: Math.round(r.x), triggerY: Math.round(r.y),
    clickable: r.width > 0 && r.height > 0,
  };
}))}`);
await page.screenshot({ path: `${SHOT}\\10-hover-row.png` });

console.log('\n=== C. move onto the trigger itself and click it ===');
const triggerBox = await page.evaluate(() => {
  const t = [...document.querySelectorAll('button')].find((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
});
console.log(`  trigger centre: ${JSON.stringify(triggerBox)}`);
if (triggerBox.w > 0) {
  await page.mouse.move(triggerBox.x, triggerBox.y);
  await new Promise((r) => setTimeout(r, 400));
  await page.mouse.click(triggerBox.x, triggerBox.y);
  await new Promise((r) => setTimeout(r, 900));
} else {
  // Zero-size: fall back to a programmatic click to prove the menu still opens.
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''))?.click();
  });
  await new Promise((r) => setTimeout(r, 900));
}
console.log(`  menu rows: ${JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll('[role="menuitem"]')].map((n) => (n.textContent ?? '').trim())))}`);
await page.screenshot({ path: `${SHOT}\\11-menu-real-hover.png` });

await browser.close();
console.log('\nscreenshots: 10-hover-row.png, 11-menu-real-hover.png');
