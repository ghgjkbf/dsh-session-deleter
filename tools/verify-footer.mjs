import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Verify the persistent entry actually renders and works, in a real browser.
//
// This is the check that matters: the previous entry (a hover-only menu row) was
// invisible to a reader who never hovered a non-current row. This one must be
// present with no pointer interaction at all, and must open a usable picker.
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});
await page.setCacheEnabled(false);
await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 6000));

console.log('=== 1. the persistent footer entry, with NO hover and NO click ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const entry = document.querySelector('.dshsd-foot-entry');
  if (!entry) return { found: false };
  const rect = entry.getBoundingClientRect();
  const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
  const top = rect.width > 0 ? document.elementFromPoint(cx, cy) : null;
  return {
    found: true,
    label: (entry.textContent ?? '').trim(),
    ariaLabel: entry.getAttribute('aria-label'),
    title: entry.getAttribute('title'),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    visible: rect.width > 0 && rect.height > 0,
    // Reachable means a human can click it where it is drawn.
    reachable: top === entry || entry.contains(top),
    hitTarget: top ? `${top.tagName}.${(top.className || '').toString().split(/\s+/)[0]}` : null,
    hasIcon: entry.querySelector('svg') !== null,
    hasLabelSpan: entry.querySelector('.dshsd-foot-label') !== null,
  };
}, null, 2)));

console.log('\n=== 2. click it with a real pointer and see the picker ===');
const box = await page.evaluate(() => {
  const entry = document.querySelector('.dshsd-foot-entry');
  if (!entry) return null;
  const rect = entry.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
});
if (box === null) {
  console.log('  entry not found; cannot click');
} else {
  console.log(`  clicking at (${Math.round(box.x)}, ${Math.round(box.y)})`);
  await page.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 2500));
  console.log(JSON.stringify(await page.evaluate(() => {
    const dialog = document.querySelector('.dshsd-plan');
    const rows = [...document.querySelectorAll('.dshsd-plan .dshsd-row')];
    return {
      dialogOpened: dialog !== null,
      heading: [...document.querySelectorAll('div,h2,h3')]
        .map((n) => (n.textContent ?? '').trim())
        .find((text) => /删除会话|Delete a session/.test(text) && text.length < 40) ?? null,
      rowCount: rows.length,
      firstRowText: rows[0] ? (rows[0].textContent ?? '').trim().slice(0, 90) : null,
      hasManageButton: [...document.querySelectorAll('button')]
        .some((b) => /管理回收站|Manage the recycle bin/.test(b.textContent ?? '')),
    };
  }, null, 2)));
  await page.screenshot({ path: `${process.env.TEMP}\\dshsd-shots\\20-picker-open.png` });
}

console.log('\n=== 3. the picker row leads into the real delete plan ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const row = [...document.querySelectorAll('.dshsd-plan .dshsd-row')]
    .find((r) => !r.textContent.includes('当前会话') && !r.textContent.includes('Current session'));
  if (!row) return { error: 'no deletable row' };
  const button = [...row.querySelectorAll('button')].pop();
  button.click();
  await new Promise((r) => setTimeout(r, 3000));
  const plan = [...document.querySelectorAll('.dshsd-plan')];
  const text = plan.length > 0 ? (plan[plan.length - 1].textContent ?? '') : '';
  return {
    planShown: /将要发生什么|What will happen/.test(text),
    namesSession: /session-[0-9a-f]{8}/.test(text),
    namesTrash: /回收站|recycle/i.test(text),
  };
}, null, 2)));
await page.screenshot({ path: `${process.env.TEMP}\\dshsd-shots\\21-picker-plan.png` });

console.log('\n=== 4. the settings page still works ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const gear = [...document.querySelectorAll('button')].find((b) =>
    /^(settings|设置)$/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.title ?? ''}`.trim()));
  if (!gear) return { opened: false };
  gear.click();
  await new Promise((r) => setTimeout(r, 2000));
  const nav = [...document.querySelectorAll('button,a,[role="tab"],[role="menuitem"],[role="option"]')];
  const section = nav.find((n) => (n.textContent ?? '').trim() === '会话删除');
  if (section) section.click();
  await new Promise((r) => setTimeout(r, 2500));
  return { opened: true, sectionFound: section !== undefined, rows: document.querySelectorAll('.dshsd-section .dshsd-row').length };
}, null, 2)));

console.log('\n=== 5. errors ===');
console.log(errors.length === 0 ? '  none' : errors.slice(0, 8).map((e) => `  ${e}`).join('\n'));

await browser.close();
