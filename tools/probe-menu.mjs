import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Dump the sidebar tree structurally so the menu trigger can be identified from
// real attributes instead of guessed from text shape.
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

console.log('=== every [role=treeitem]: attributes, class, buttons ===');
console.log(JSON.stringify(await page.evaluate(() => {
  return [...document.querySelectorAll('[role="treeitem"]')].map((row) => ({
    class: (row.className || '').toString(),
    ariaLevel: row.getAttribute('aria-level'),
    ariaExpanded: row.getAttribute('aria-expanded'),
    ariaSelected: row.getAttribute('aria-selected'),
    text: (row.textContent ?? '').trim().slice(0, 60),
    nestedTreeitems: row.querySelectorAll('[role="treeitem"]').length,
    buttons: [...row.querySelectorAll('button')].map((b) => ({
      cls: (b.className || '').toString().slice(0, 60),
      ariaLabel: b.getAttribute('aria-label'),
      title: b.title || null,
      text: (b.textContent ?? '').trim(),
      rect: (() => { const r = b.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
    })),
  }));
}, null, 2)));

console.log('\n=== click each button of the first real session row, one at a time ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const rows = [...document.querySelectorAll('[role="treeitem"]')];
  // "real session row" = the earlier probe showed these carry 3 buttons and a
  // duration; identify by having 3 buttons and not being a project parent.
  const row = rows.find((r) => r.querySelectorAll('button').length >= 2
    && r.querySelectorAll('[role="treeitem"]').length === 0);
  if (!row) return { error: 'no candidate row', rowCount: rows.length };

  const out = { rowText: (row.textContent ?? '').trim().slice(0, 60), attempts: [] };
  const buttons = [...row.querySelectorAll('button')];
  for (const [i, button] of buttons.entries()) {
    button.click();
    await new Promise((r) => setTimeout(r, 700));
    const before = [...document.querySelectorAll('[role="menuitem"]')].length;
    const menuTexts = [...document.querySelectorAll('[role="menuitem"]')].map((n) => (n.textContent ?? '').trim());
    out.attempts.push({
      index: i,
      buttonText: (button.textContent ?? '').trim(),
      buttonAria: button.getAttribute('aria-label'),
      menuItemCount: before,
      menuTexts,
      injected: menuTexts.some((t) => /回收站|delet|删除会话/i.test(t)),
      dialogOpen: document.querySelector('.dshsd-dialog') !== null || /正在生成删除计划|将要发生什么/.test(document.body.innerText),
    });
    // Close whatever opened.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}, null, 2)));

await browser.close();
