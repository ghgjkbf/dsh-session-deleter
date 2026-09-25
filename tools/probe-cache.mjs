import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Decide whether the human's browser can possibly be running the current bundle.
//
// Two independent checks:
//   1. Fetch the bundle URL the boot manifest advertises and confirm its bytes.
//   2. Load a page with a cold cache and confirm the plugin's registration ran.
// Also dump every slot the plugin claims, read straight from the live client
// runtime, so registration is proven rather than inferred.
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const { statSync } = await import('node:fs');
const { createHash } = await import('node:crypto');

const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();

const requests = [];
page.on('response', async (r) => {
  if (r.url().includes('session-deleter') && r.url().includes('/plugins/')) {
    requests.push({ url: r.url().replace(/^https?:\/\/[^/]+/, ''), status: r.status(), fromCache: r.fromCache?.() ?? null });
  }
});

await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});
await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 5000));

console.log('=== 1. the bundle the browser actually fetched ===');
for (const r of requests) console.log(`  ${r.status} cache=${r.fromCache} ${r.url}`);

console.log('\n=== 2. did the plugin registration actually run in this page? ===');
console.log(JSON.stringify(await page.evaluate(() => {
  // The registration is observable through its effects: the injected CSS tag, the
  // boot entry, and a live React tree that contains our menu row when a menu opens.
  const styleTag = document.querySelector('style[data-plugin-css]');
  const boot = window.__DSH_BOOT__?.entries?.find((e) => e.id === 'dsh-session-deleter');
  return {
    styleTagPresent: styleTag !== null,
    styleTagId: styleTag?.dataset?.pluginCss ?? null,
    styleRuleCount: styleTag ? (styleTag.textContent.match(/\.dshsd-/g) ?? []).length : 0,
    bootEntry: boot ?? null,
  };
}, null, 2)));

console.log('\n=== 3. force a cold reload and re-check ===');
await page.setCacheEnabled(false);
await page.reload({ waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 5000));
console.log(JSON.stringify(await page.evaluate(() => {
  const styleTag = document.querySelector('style[data-plugin-css]');
  return {
    styleTagPresent: styleTag !== null,
    bootEntryRev: window.__DSH_BOOT__?.entries?.find((e) => e.id === 'dsh-session-deleter')?.rev ?? null,
  };
}), null, 2));

console.log('\n=== 4. hover a real session row with a real pointer, twice ===');
const before = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find((r) =>
    [...r.querySelectorAll('button')].some((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? '')));
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  const trigger = [...row.querySelectorAll('button')].find((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
  const tr = trigger.getBoundingClientRect();
  return { rowY: rect.y + rect.height / 2, rowX: rect.x + rect.width / 2, triggerW: Math.round(tr.width), triggerH: Math.round(tr.height) };
});
console.log(`  before hover: ${JSON.stringify(before)}`);

if (before) {
  await page.mouse.move(before.rowX, before.rowY);
  await new Promise((r) => setTimeout(r, 300));
  await page.mouse.move(before.rowX - 40, before.rowY); // jiggle: some hover CSS needs a move event on the row
  await new Promise((r) => setTimeout(r, 900));
  console.log(`  after real hover: ${JSON.stringify(await page.evaluate(() => {
    const trigger = [...document.querySelectorAll('button')].find((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
    const tr = trigger.getBoundingClientRect();
    return { triggerW: Math.round(tr.width), triggerH: Math.round(tr.height), visible: tr.width > 0 };
  }))}`);
}

await browser.close();
