import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Check every session row's menu, not just the first one, and report whether the
// delete row appears in each. This separates "the entry point is broken" from
// "some rows legitimately do not offer it".
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && /session-deleter|dshsd/i.test(m.text())) errors.push(`console: ${m.text()}`); });

await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});
await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 5000));

// List every session row: title text and whether it carries an actions trigger.
const rows = await page.evaluate(() => {
  return [...document.querySelectorAll('[role="treeitem"]')].map((row, index) => {
    const trigger = [...row.querySelectorAll('button')].find((b) =>
      /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
    const projectTrigger = [...row.querySelectorAll('button')].find((b) =>
      /^工作区[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? ''));
    return {
      index,
      text: (row.textContent ?? '').trim().slice(0, 46),
      selected: row.getAttribute('aria-selected'),
      kind: trigger ? 'session' : (projectTrigger ? 'workspace' : 'other'),
      ariaLabel: trigger?.getAttribute('aria-label') ?? projectTrigger?.getAttribute('aria-label') ?? null,
    };
  });
});

console.log('=== sidebar rows ===');
for (const row of rows) console.log(`  [${row.index}] ${row.kind.padEnd(9)} sel=${row.selected ?? '-'} ${JSON.stringify(row.text)}`);

console.log('\n=== open the menu on EVERY session row (programmatic click) ===');
const sessionRows = rows.filter((r) => r.kind === 'session');
console.log(`  session rows found: ${sessionRows.length}`);

for (const row of sessionRows) {
  const outcome = await page.evaluate(async (ariaLabel) => {
    // Close anything already open first.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    const trigger = [...document.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === ariaLabel);
    if (!trigger) return { error: 'trigger gone' };
    trigger.click();
    await new Promise((r) => setTimeout(r, 700));
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((n) => (n.textContent ?? '').trim());
    return { items };
  }, row.ariaLabel);

  const hasDelete = (outcome.items ?? []).some((text) => /移入回收站|recycle/i.test(text));
  console.log(`  ${hasDelete ? 'HAS DELETE' : 'no delete '} | ${JSON.stringify(row.text)}`);
  console.log(`              menu: ${JSON.stringify(outcome.items ?? outcome.error)}`);
}

console.log('\n=== plugin errors ===');
console.log(errors.length === 0 ? '  none' : errors.slice(0, 6).map((e) => `  ${e}`).join('\n'));

await browser.close();
