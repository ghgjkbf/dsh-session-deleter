import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Answer "I can't see the delete option" with coordinates instead of assumptions.
// Reports where each entry point actually renders, and whether it is reachable
// without hovering.
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
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

const describe = (label, info) => console.log(`  ${label}\n    ${JSON.stringify(info)}`);

console.log('=== A. the "..." trigger on a session row, before any hover ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const trigger = [...document.querySelectorAll('button')].find((b) =>
    /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
  if (!trigger) return { found: false };
  const style = getComputedStyle(trigger);
  const rect = trigger.getBoundingClientRect();
  const row = trigger.closest('[role="treeitem"]');
  const rowRect = row?.getBoundingClientRect();
  return {
    found: true,
    ariaLabel: trigger.getAttribute('aria-label'),
    visibility: style.visibility,
    display: style.display,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    transform: style.transform,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    rowRect: rowRect ? { x: Math.round(rowRect.x), y: Math.round(rowRect.y), w: Math.round(rowRect.width), h: Math.round(rowRect.height) } : null,
    // Whether the element is visually present at its own centre.
    hitTest: (() => {
      const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      if (rect.width === 0 || rect.height === 0) return 'zero-size';
      const top = document.elementFromPoint(cx, cy);
      return top === trigger || trigger.contains(top) ? 'reachable' : `covered by ${top?.tagName}.${(top?.className || '').toString().slice(0, 40)}`;
    })(),
  };
}, null, 2)));

console.log('\n=== B. after hovering the row, is it visible? ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const row = [...document.querySelectorAll('[role="treeitem"]')]
    .find((r) => [...r.querySelectorAll('button')].some((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? '')));
  if (!row) return { found: false };
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 800));
  const trigger = [...row.querySelectorAll('button')].find((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
  const style = getComputedStyle(trigger);
  const rect = trigger.getBoundingClientRect();
  return {
    found: true,
    visibility: style.visibility,
    opacity: style.opacity,
    display: style.display,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}, null, 2)));

console.log('\n=== C. where is the settings entry for the plugin? ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const gear = [...document.querySelectorAll('button')].find((b) =>
    /^(settings|设置)$/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.title ?? ''}`.trim()));
  if (!gear) return { opened: false, reason: 'no settings button' };
  gear.click();
  await new Promise((r) => setTimeout(r, 2000));
  const navs = [...document.querySelectorAll('button,a,[role="tab"],[role="menuitem"],[role="option"]')]
    .filter((n) => (n.textContent ?? '').trim().length > 0 && (n.textContent ?? '').length < 40)
    .map((n) => (n.textContent ?? '').trim());
  return { opened: true, navLabels: [...new Set(navs)].slice(0, 40) };
}, null, 2)));

await browser.close();
