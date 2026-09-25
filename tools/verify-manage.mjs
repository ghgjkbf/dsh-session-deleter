// Verify the two management entry points that used to be silent no-ops.
//
// The bug: both buttons called a helper that did
// `ctx.layout.selectPanel("settings")` and swallowed every error in a bare
// `catch {}`. `selectPanel` only addresses a panel registered in the
// `sidebar.panellist` slot (whose shipped occupants are `plugins` and
// `dsh-market`), so "settings" threw, the catch hid it, and the click did
// nothing. The settings panel is shell-owned with no client service to open it.
//
// The fix: both entries now open this plugin's own management overlay, which
// renders the same body as the `settings.section` occupant.
//
// Assertion style: poll for each precondition, then require real data (not just
// a rendered shell), so an empty-but-mounted panel cannot pass.
//
// Exits 0 on pass, 1 on a failed assertion, 2 when no browser can be driven.

import { chromePath, puppeteerCorePath, baseUrl, cookieForBaseUrl } from './harness.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const URL_BASE = baseUrl();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let puppeteer;
try {
  puppeteer = require(puppeteerCorePath());
} catch (error) {
  console.error(`skip: ${error.message}`);
  process.exit(2);
}

const cookie = await cookieForBaseUrl();
if (cookie === null) {
  console.error('skip: no GUI cookie available; set DSH_COOKIE_NAME and DSH_COOKIE_VALUE');
  process.exit(2);
}

/** Poll a page predicate until true, across a bounded number of attempts. */
async function until(page, label, fn, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await page.evaluate(fn)) return true;
    } catch {
      // The page can be mid-render; a failed probe is not a failure.
    }
    await wait(1000);
  }
  console.error(`  timed out waiting for ${label}`);
  return false;
}

const clickBy = (fnSource) => new Function(fnSource);

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const failures = [];
let pageErrors = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie({ name: cookie.name, value: cookie.value, url: URL_BASE });

  page.on('pageerror', (error) => pageErrors.push(`PAGEERROR: ${String(error.message).slice(0, 200)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 200)}`);
  });

  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  if (!(await until(page, 'shell hydration', () => document.body.innerText.includes('删除会话')))) {
    throw new Error('the shell never hydrated; check the GUI URL and the cookie');
  }

  // --- 1. the discoverable entry exists without hovering ---------------
  const footer = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => (node.getAttribute('aria-label') ?? '') === '删除会话');
    if (!button) return { found: false };
    const box = button.getBoundingClientRect();
    return { found: true, visible: box.width > 0 && box.height > 0 };
  });
  if (!footer.found || !footer.visible) failures.push('the sidebar-foot entry is missing or invisible');

  // --- 2. it opens the session picker ---------------------------------
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((node) => (node.getAttribute('aria-label') ?? '') === '删除会话')?.click();
  });
  const pickerOpened = await until(page, 'the session picker', () =>
    [...document.querySelectorAll('button')].some((node) => (node.textContent ?? '').trim() === '管理回收站'));
  if (!pickerOpened) failures.push('the sidebar-foot entry did not open the session picker');

  // --- 3. 管理回收站 opens the management view WITH DATA ----------------
  // This is the reported no-op. Requiring populated cards is deliberate: a
  // mounted-but-empty panel would hide a broken fetch.
  const clickedManage = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => (node.textContent ?? '').trim() === '管理回收站');
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clickedManage) failures.push('the 管理回收站 button was not found in the picker');

  // Wait for loading to finish, not merely for cards to exist. While `busy` is
  // true the refresh control renders its busy label, so "刷新 present" is the
  // reliable loaded signal — polling on card text alone matches "· 0" and races.
  const loaded = await until(page, 'the management view to finish loading', () =>
    document.querySelectorAll('.dshsd-card').length >= 3
    && [...document.querySelectorAll('.dshsd-section button')]
      .some((node) => (node.textContent ?? '').trim() === '刷新')
    && document.querySelectorAll('.dshsd-row').length > 0);

  const titles = await page.evaluate(() => [...document.querySelectorAll('.dshsd-cardTitle')]
    .map((node) => node.textContent.trim()));

  if (titles.length < 3) {
    failures.push('the management view did not render its three data cards');
  } else {
    for (const expected of ['磁盘上的会话', '回收站', '操作账本']) {
      if (!titles.some((title) => title.startsWith(expected))) failures.push(`missing card: ${expected}`);
    }
  }

  // Assert the view reflects the API rather than accepting any number: compare
  // the rendered count with the route's own payload. This fails on a broken
  // fetch (UI zero, API full) and stays correct on a genuinely empty install.
  const comparison = await page.evaluate(async () => {
    const countIn = (title) => {
      const match = /·\s*(\d+)/.exec(title ?? '');
      return match ? Number(match[1]) : null;
    };
    const cards = [...document.querySelectorAll('.dshsd-cardTitle')].map((node) => node.textContent.trim());
    const shown = {
      sessions: countIn(cards.find((title) => title.startsWith('磁盘上的会话'))),
      trash: countIn(cards.find((title) => title.startsWith('回收站'))),
    };
    const read = async (path, pick) => {
      const response = await fetch(path, { headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      return pick(await response.json());
    };
    return {
      shown,
      api: {
        sessions: await read('/session-deleter/inventory', (body) => body.sessions.length),
        trash: await read('/session-deleter/trash', (body) => body.entries.length),
      },
    };
  });

  if (comparison.shown.sessions !== comparison.api.sessions) {
    failures.push(`session count mismatch: view ${comparison.shown.sessions}, API ${comparison.api.sessions}`);
  }
  if (comparison.shown.trash !== comparison.api.trash) {
    failures.push(`trash count mismatch: view ${comparison.shown.trash}, API ${comparison.api.trash}`);
  }

  // --- 4. the panel is operable, not just painted -----------------------
  const usable = await page.evaluate(() => ({
    refresh: [...document.querySelectorAll('.dshsd-section button')]
      .some((node) => (node.textContent ?? '').trim() === '刷新'),
    rowActions: document.querySelectorAll('.dshsd-row button').length,
  }));
  if (!usable.refresh) failures.push('the refresh control is missing from the management view');
  if (usable.rowActions === 0) failures.push('the management view lists no actionable rows');
  if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join(' | ')}`);

  console.log('管理回收站 manage entry point');
  console.log(`  sidebar-foot entry visible    : ${footer.found && footer.visible}`);
  console.log(`  picker opens from it          : ${pickerOpened}`);
  console.log(`  management view loaded        : ${loaded}`);
  console.log(`  cards                         : ${titles.join('  |  ')}`);
  console.log(`  view vs API sessions          : ${comparison.shown.sessions} / ${comparison.api.sessions}`);
  console.log(`  view vs API trash             : ${comparison.shown.trash} / ${comparison.api.trash}`);
  console.log(`  refresh + ${usable.rowActions} row actions  : ${usable.refresh}`);
  console.log(`  page errors                   : ${pageErrors.length}`);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error('\nFAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nPASS: both management entries render the view with live data');
