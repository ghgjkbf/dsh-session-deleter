import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Instrument the live page: wrap fetch, then open the settings section and log
// exactly what the plugin's apiJson call sees. This is the evidence that
// separates "the route failed" from "the promise rejected before setState".
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();

page.on('pageerror', (e) => console.log(`  PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  const text = m.text();
  if (/session-deleter|dshsd/i.test(text)) console.log(`  CONSOLE[${m.type()}]: ${text}`);
});

// Instrument BEFORE the app boots: record every plugin-route request/response.
await page.evaluateOnNewDocument(() => {
  window.__probe = { requests: [], errors: [] };
  const originalFetch = window.fetch;
  window.fetch = function patched(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.includes('/session-deleter/')) {
      const entry = { url, method: (init && init.method) || 'GET', startedAt: Date.now() };
      window.__probe.requests.push(entry);
      return originalFetch.apply(this, arguments).then(
        (response) => {
          entry.status = response.status;
          entry.ok = response.ok;
          // Clone so the app's own read is untouched.
          response.clone().text().then((text) => { entry.bodyLen = text.length; entry.bodyHead = text.slice(0, 160); })
            .catch((error) => { entry.readError = String(error); });
          return response;
        },
        (error) => {
          entry.networkError = String(error);
          window.__probe.errors.push(`fetch rejected for ${url}: ${error}`);
          throw error;
        },
      );
    }
    return originalFetch.apply(this, arguments);
  };
});

// Also record unhandled rejections — the failure mode that leaves a spinner up.
await page.evaluateOnNewDocument(() => {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.__probe.errors.push(`unhandledrejection: ${reason && reason.message ? reason.message : String(reason)}\n${reason && reason.stack ? reason.stack.slice(0, 600) : ''}`);
  });
  window.addEventListener('error', (event) => {
    window.__probe.errors.push(`error: ${event.message}`);
  });
});

await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});

await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 4000));

console.log('=== open settings -> Session Deleter ===');
const result = await page.evaluate(async () => {
  const gear = [...document.querySelectorAll('button')].find((b) =>
    /settings|设置/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.title ?? ''}`));
  if (gear) gear.click();
  await new Promise((r) => setTimeout(r, 1500));
  const entry = [...document.querySelectorAll('button,a,[role="tab"],[role="menuitem"]')]
    .find((n) => /会话删除|Session Deleter/i.test(n.textContent ?? ''));
  if (entry) entry.click();
  await new Promise((r) => setTimeout(r, 3000));
  return {
    requests: window.__probe.requests,
    errors: window.__probe.errors,
    rowCount: document.querySelectorAll('.dshsd-row').length,
    buttonDisabled: (() => {
      const section = document.querySelector('.dshsd-section');
      const button = section && section.querySelector('button');
      return button ? { disabled: button.disabled, text: button.textContent } : null;
    })(),
    cardTitles: [...document.querySelectorAll('.dshsd-cardTitle')].map((n) => n.textContent),
  };
});

console.log(JSON.stringify(result, null, 2));

console.log('\n=== direct fetch from the page context, with the plugin path and read steps ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const out = [];
  for (const path of ['/session-deleter/inventory', '/session-deleter/trash', '/session-deleter/ledger?limit=50']) {
    const url = new URL(path, window.location.origin).toString();
    try {
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      const text = await response.text();
      let parsed = null; let parseError = null;
      try { parsed = JSON.parse(text); } catch (error) { parseError = String(error); }
      out.push({ path, status: response.status, ok: response.ok, len: text.length, parsed: parsed !== null, parseError, bodyOk: parsed ? parsed.ok : null, keyCount: parsed ? Object.keys(parsed).length : null });
    } catch (error) {
      out.push({ path, fetchError: String(error), message: error && error.message, stack: error && error.stack ? error.stack.slice(0, 400) : null });
    }
  }
  return out;
}, null, 2)));

await browser.close();
