import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Determine the exact condition under which the session "..." trigger appears.
//
// Prior probes disagree: the trigger measures 0x0 with no pointer, 16x16 after a
// real hover. That means a CSS rule gates it. This script finds the rule and the
// selector chain that activates it, so the condition is known rather than guessed.
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

console.log('=== 1. every session row and its trigger, with the row selected state ===');
console.log(JSON.stringify(await page.evaluate(() => {
  return [...document.querySelectorAll('[role="treeitem"]')].map((row) => {
    const trigger = [...row.querySelectorAll('button')].find((b) =>
      /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
    if (!trigger) return { text: (row.textContent ?? '').trim().slice(0, 40), trigger: false };
    const rect = trigger.getBoundingClientRect();
    return {
      text: (row.textContent ?? '').trim().slice(0, 40),
      selected: row.getAttribute('aria-selected'),
      trigger: true,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      cls: (trigger.className || '').toString().slice(0, 70),
      rowCls: (row.className || '').toString().slice(0, 70),
    };
  });
}, null, 2)));

console.log('\n=== 2. the CSS rules that mention this button class ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const trigger = [...document.querySelectorAll('button')].find((b) =>
    /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
  if (!trigger) return { error: 'no trigger' };
  const cls = (trigger.className || '').toString().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (const rule of rules) {
      const text = rule.cssText ?? '';
      if (cls.some((c) => text.includes(`.${c}`)) && /opacity|visibility|transform|width|display/.test(text)) {
        hits.push(text.slice(0, 220));
      }
    }
  }
  return { classes: cls, rules: hits.slice(0, 14) };
}, null, 2)));

console.log('\n=== 3. sweep the pointer down the sidebar and watch the trigger appear ===');
const rowsBox = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find((r) =>
    [...r.querySelectorAll('button')].some((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? '')));
  const r = row.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log(`  first session row box: ${JSON.stringify(rowsBox)}`);

for (const dx of [0.15, 0.4, 0.7, 0.9]) {
  const x = Math.round(rowsBox.x + rowsBox.w * dx);
  const y = Math.round(rowsBox.y + rowsBox.h / 2);
  await page.mouse.move(x, y);
  await new Promise((r) => setTimeout(r, 500));
  const state = await page.evaluate(() => {
    const trigger = [...document.querySelectorAll('button')].find((b) =>
      /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
    const r = trigger.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log(`  pointer at x=${x} (${Math.round(dx * 100)}% across row) -> trigger ${state.w}x${state.h}`);
}

console.log('\n=== 4. is the trigger actually visible at the row right edge? ===');
const final = await page.evaluate(async () => {
  const trigger = [...document.querySelectorAll('button')].find((b) =>
    /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
  const r = trigger.getBoundingClientRect();
  const style = getComputedStyle(trigger);
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const top = r.width > 0 ? document.elementFromPoint(cx, cy) : null;
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    opacity: style.opacity, visibility: style.visibility, pointerEvents: style.pointerEvents,
    hitTest: top ? `${top.tagName}.${(top.className || '').toString().split(/\s+/)[0]}` : 'out of viewport',
    isTriggerItself: top === trigger,
  };
});
console.log(`  ${JSON.stringify(final)}`);

await page.screenshot({ path: `${process.env.TEMP}\\dshsd-shots\\12-final-hover.png` });
await browser.close();
