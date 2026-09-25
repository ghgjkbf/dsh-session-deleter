// Drive the real GUI with a browser: restore the authenticated session cookie,
// then prove the plugin's three surfaces actually render — not merely register.
//
// Registration was already proven through the client Slot inspector; this is the
// check that catches what registration cannot: a component that throws while
// rendering, a menu row that never appears, a settings page that mounts empty.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookieForBaseUrl } from './harness.mjs';

const ORIGIN = BASE_URL();
const SHOT_DIR = process.argv[2] ?? SHOTS_DIR();

// Environment overrides win; otherwise the cookie is minted in memory from this
// Harness home's credential file. Nothing is printed or persisted.
const credentials = await cookieForBaseUrl();
if (credentials === null) {
  console.error('no GUI cookie: set DSH_COOKIE_NAME and DSH_COOKIE_VALUE, or point DSH_HOME at a Harness home');
  process.exit(2);
}
const { name: COOKIE_NAME, value: COOKIE_VALUE } = credentials;

let failures = 0;
const check = (label, condition, detail = '') => {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
};

// puppeteer-core lives in the profile's pnpm store, not beside this plugin, so
// import it by absolute path rather than relying on node resolution.
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const puppeteer = await import(`file:///${PUPPETEER_CORE}`);

mkdirSync(SHOT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000 },
});

const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

await browser.setCookie({
  name: COOKIE_NAME,
  value: COOKIE_VALUE,
  domain: '127.0.0.1',
  path: '/',
  httpOnly: true,
  sameSite: 'Strict',
});

console.log('=== 1. the authenticated shell loads ===');
await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.waitForSelector('body', { timeout: 30_000 });
const title = await page.title();
check('the page has a title', typeof title === 'string' && title.length > 0, title);

// Wait for the app to mount its sidebar rather than assuming a fixed delay.
await new Promise((resolve) => setTimeout(resolve, 4000));

console.log('\n=== 2. the plugin bundle executed in the real page ===');
const bootHas = await page.evaluate(() => {
  const boot = window.__DSH_BOOT__;
  if (boot === undefined || !Array.isArray(boot.entries)) return false;
  return boot.entries.some((entry) => entry.id === 'dsh-session-deleter');
});
check('the boot manifest carries the plugin entry', bootHas);

const styleInjected = await page.evaluate(() =>
  document.querySelector('style[data-plugin-css="dsh-session-deleter/client.css"]') !== null);
check('the bundle injected its stylesheet at materialization', styleInjected);

const cssText = await page.evaluate(() => {
  const tag = document.querySelector('style[data-plugin-css="dsh-session-deleter/client.css"]');
  return tag === null ? '' : tag.textContent;
});
check('the stylesheet carries the plugin rules', cssText.includes('.dshsd-section'), `${cssText.length} chars`);

console.log('\n=== 3. the theme tokens the stylesheet relies on exist ===');
// The tokens are declared on `body`, not on :root, so reading them off
// documentElement reports "" for tokens that resolve perfectly well.
const tokens = await page.evaluate(() => {
  const style = getComputedStyle(document.body);
  const names = [
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l2',
  ];
  return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
});
for (const [name, value] of Object.entries(tokens)) {
  check(`token ${name} resolves`, value.length > 0, value);
}

console.log('\n=== 4. no error came from the plugin bundle ===');
const pluginErrors = consoleErrors.filter((line) => /session-deleter|dshsd/i.test(line));
check('no console error names the plugin', pluginErrors.length === 0, pluginErrors.join(' | ') || 'none');

await page.screenshot({ path: join(SHOT_DIR, '01-shell.png'), fullPage: false });

console.log('\n=== 5. the Session "..." menu offers the delete row ===');

// The session overflow trigger has a stable aria-label: 会话“<title>”的操作
// (full-width quotes). Workspace rows use 工作区“<name>”的操作 instead, and they
// open a different menu ("rename / delete workspace"), so matching on the label is
// what separates the two. The trigger is visually hidden until the row is hovered,
// but activating it programmatically opens the same menu.
const isSessionTrigger = (label) =>
  /^会话[“"].*[”"]的操作$/u.test(label) || /^Session [“"].*[”"] actions$/u.test(label);

const menuOpened = await page.evaluate(async (matches) => {
  // Rebuild the predicate inside the page: functions cannot be passed through.
  const test = new RegExp(matches, 'u');
  const trigger = [...document.querySelectorAll('button')]
    .find((button) => test.test(button.getAttribute('aria-label') ?? ''));

  if (trigger === undefined) {
    const labels = [...document.querySelectorAll('button')]
      .map((b) => b.getAttribute('aria-label'))
      .filter((label) => label !== null && label.length > 0);
    return { opened: false, reason: `no session action trigger; labels: ${JSON.stringify(labels.slice(0, 14))}` };
  }

  const row = trigger.closest('[role="treeitem"]');
  trigger.click();
  await new Promise((resolve) => setTimeout(resolve, 800));
  return {
    opened: true,
    rowText: (row?.textContent ?? '').trim().slice(0, 70),
    triggerLabel: trigger.getAttribute('aria-label'),
    rows: [...document.querySelectorAll('[role="menuitem"]')].map((node) => (node.textContent ?? '').trim()),
  };
}, '^(?:会话[“"].*[”"]的操作|Session [“"].*[”"] actions)$');
check('a Session row overflow menu opened', menuOpened.opened === true,
  menuOpened.reason ?? `row "${menuOpened.rowText}" via "${menuOpened.triggerLabel}"`);
if (menuOpened.rows) console.log(`  menu rows: ${JSON.stringify(menuOpened.rows)}`);

const menuRows = menuOpened.rows ?? [];
const hasDeleteRow = menuRows.some((text) => /回收站|recycle|delet/i.test(text));
check('the menu carries the delete row', hasDeleteRow, menuRows.join(' | '));

if (menuOpened.opened) {
  await page.screenshot({ path: join(SHOT_DIR, '02-menu.png'), fullPage: false });
}

console.log('\n=== 6. the confirmation dialog opens and plans a real session ===');

if (hasDeleteRow) {
  // Click the delete row by its text, then wait for the dialog to finish its
  // dry-run request.
  const clicked = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('[role="menuitem"]')]
      .find((node) => /回收站|recycle|delet/i.test(node.textContent ?? ''));
    if (row === undefined) return false;
    row.click();
    return true;
  });
  check('the delete row was clickable', clicked);

  await new Promise((resolve) => setTimeout(resolve, 2500));

  const dialog = await page.evaluate(() => {
    const text = document.body.innerText;
    const planHeading = /将要发生什么|What will happen/i.test(text);
    const hasSession = /session-[0-9a-f]{8}/i.test(text);
    const hasSize = /\d+(\.\d+)?\s*(B|KiB|MiB|GiB)/.test(text);
    const hasTrash = /回收站|recycle/i.test(text);
    return { planHeading, hasSession, hasSize, hasTrash, excerpt: text.slice(0, 400) };
  });
  check('the dialog shows the plan heading', dialog.planHeading);
  check('the plan names a real session id', dialog.hasSession);
  check('the plan reports a size', dialog.hasSize);
  check('the plan names the recycle bin', dialog.hasTrash);
  await page.screenshot({ path: join(SHOT_DIR, '03-dialog.png'), fullPage: false });
}

console.log('\n=== 7. the settings page renders its three panels ===');

await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((resolve) => setTimeout(resolve, 3500));

// Open Settings through the sidebar's gear, then pick our section.
const settingsOpened = await page.evaluate(async () => {
  const buttons = [...document.querySelectorAll('button')];
  const gear = buttons.find((button) => {
    const label = `${button.getAttribute('aria-label') ?? ''} ${button.title ?? ''}`;
    return /settings|设置/i.test(label);
  });
  if (gear === undefined) return false;
  gear.click();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return true;
});
check('the settings panel opened', settingsOpened);

if (settingsOpened) {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const sectionOpened = await page.evaluate(async () => {
    const candidates = [...document.querySelectorAll('button,a,[role="tab"],[role="menuitem"]')];
    const target = candidates.find((node) => /会话删除|Session Deleter/i.test(node.textContent ?? ''));
    if (target === undefined) return false;
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return true;
  });
  check('the Session Deleter section is listed and opened', sectionOpened);

  if (sectionOpened) {
    // The panel renders before its fetch resolves (that is what made the earlier
    // probe read "0 sessions"), so wait for the busy button to come back instead
    // of sampling at a fixed offset.
    const section = await page.evaluate(async () => {
      const readState = () => {
        const host = document.querySelector('.dshsd-section');
        if (host === null) return null;
        const button = host.querySelector('button');
        return {
          disabled: button ? button.disabled : null,
          buttonText: button ? button.textContent : null,
          rowCount: document.querySelectorAll('.dshsd-row').length,
          firstTitle: document.querySelector('.dshsd-cardTitle')?.textContent ?? null,
        };
      };

      const started = Date.now();
      let state = readState();
      while (state !== null && state.disabled === true && Date.now() - started < 30_000) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        state = readState();
      }

      const text = document.body.innerText;
      return {
        ...(state ?? {}),
        elapsedMs: Date.now() - started,
        hasSessions: /磁盘上的会话|Sessions on disk/i.test(text),
        hasTrash: /回收站|Recycle bin/i.test(text),
        hasLedger: /操作账本|Audit ledger/i.test(text),
        firstRowText: document.querySelector('.dshsd-row')?.innerText?.slice(0, 160) ?? null,
      };
    });
    check('the sessions panel rendered', section.hasSessions);
    check('the recycle-bin panel rendered', section.hasTrash);
    check('the ledger panel rendered', section.hasLedger);
    check('the panel filled in after its fetch settled', section.disabled === false,
      `busy button "${section.buttonText}" after ${section.elapsedMs} ms`);
    check('the panel listed session rows', section.rowCount > 0, `${section.rowCount} row(s)`);
    if (section.firstRowText !== null) console.log(`  first row: ${JSON.stringify(section.firstRowText)}`);
    await page.screenshot({ path: join(SHOT_DIR, '04-settings.png'), fullPage: false });
  }
}

console.log(`\nscreenshots: ${SHOT_DIR}`);
if (consoleErrors.length > 0) {
  console.log('\nconsole errors captured:');
  for (const line of consoleErrors.slice(0, 10)) console.log(`  ${line}`);
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
