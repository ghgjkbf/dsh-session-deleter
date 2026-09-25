import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Ask the running client runtime, not the DOM, which slot occupants exist.
//
// The DOM can only show what happens to be rendered; the registration ledger is
// the ground truth for "did the plugin's apply() run in THIS page".
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});

// Cold start: no cache at all.
await page.setCacheEnabled(false);
await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 6000));

console.log('=== what the module loader knows about our bundle ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const loader = window.__ModuleLoader__;
  const out = { hasLoader: typeof loader !== 'undefined', keys: [] };
  if (!loader) return out;
  // The loader keeps whatever registry it keeps; enumerate defensively.
  for (const key of ['modules', 'registry', 'loaded', 'cache']) {
    const value = loader[key];
    if (value instanceof Map) out.keys.push(`${key}(Map): ${[...value.keys()].filter((k) => /session-deleter/i.test(String(k))).join(', ')}`);
    else if (value && typeof value === 'object') out.keys.push(`${key}(obj): ${Object.keys(value).filter((k) => /session-deleter/i.test(k)).join(', ')}`);
  }
  return out;
}, null, 2)));

console.log('\n=== our style tag, looked up correctly ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const mine = document.querySelector('style[data-plugin-css="dsh-session-deleter/client.css"]');
  return {
    found: mine !== null,
    viaPluginAttr: document.querySelector('style[data-plugin="dsh-session-deleter"]') !== null,
    allPluginCssTags: [...document.querySelectorAll('style[data-plugin-css]')]
      .map((t) => t.dataset.pluginCss)
      .filter((id) => /session-deleter/i.test(id ?? '')),
    totalPluginCssTags: document.querySelectorAll('style[data-plugin-css]').length,
  };
}, null, 2)));

console.log('\n=== does the settings nav show the section label? ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const gear = [...document.querySelectorAll('button')].find((b) =>
    /^(settings|设置)$/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.title ?? ''}`.trim()));
  if (!gear) return { opened: false };
  gear.click();
  await new Promise((r) => setTimeout(r, 2000));
  const navs = [...document.querySelectorAll('button,a,[role="tab"],[role="menuitem"],[role="option"]')]
    .map((n) => (n.textContent ?? '').trim());
  return {
    opened: true,
    hasSection: navs.some((t) => t === '会话删除'),
    // Raw key leakage would mean the dictionary never registered.
    leakedKey: navs.some((t) => /section\.title|menu\.deleteSession/.test(t)),
    nearMisses: navs.filter((t) => /删除|会话删除/.test(t)).slice(0, 8),
  };
}, null, 2)));

console.log('\n=== all page errors ===');
console.log(errors.length === 0 ? '  none' : errors.slice(0, 12).map((e) => `  ${e}`).join('\n'));

await browser.close();
