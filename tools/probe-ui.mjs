import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Focused DOM forensics against the live GUI: find why the session menu row and
// the settings list are not rendering, without guessing at selectors.
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const puppeteer = await import(`file:///${PUPPETEER_CORE}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`reqfail: ${r.url()} ${r.failure()?.errorText}`));

await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME,
  value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});

await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 5000));

console.log('=== A. where do the alias tokens actually live? ===');
console.log(await page.evaluate(() => {
  const names = ['--dsw-alias-label-primary', '--dsw-alias-border-l2'];
  const out = {};
  for (const name of names) {
    out[name] = { onDocumentElement: getComputedStyle(document.documentElement).getPropertyValue(name).trim() };
  }
  // Hunt any element in the tree that resolves them.
  const all = [document.documentElement, document.body, ...document.querySelectorAll('*')];
  for (const name of names) {
    const host = all.find((el) => getComputedStyle(el).getPropertyValue(name).trim().length > 0);
    out[name].firstResolvingTag = host ? `${host.tagName.toLowerCase()}.${(host.className || '').toString().slice(0, 60)}` : null;
    out[name].firstResolvingValue = host ? getComputedStyle(host).getPropertyValue(name).trim() : null;
  }
  out.stylesheetCount = document.styleSheets.length;
  out.themeAttrs = ['data-theme', 'class', 'data-dsh-theme'].map((a) => `${a}=${document.documentElement.getAttribute(a)}`);
  return out;
}));

console.log('\n=== B. every button that could be a row overflow trigger ===');
console.log(await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button')];
  return buttons
    .map((b, index) => {
      const label = `${b.getAttribute('aria-label') ?? ''}|${b.title ?? ''}|${(b.textContent ?? '').trim().slice(0, 24)}`;
      const rect = b.getBoundingClientRect();
      return { index, label, x: Math.round(rect.x), y: Math.round(rect.y), visible: rect.width > 0 && rect.height > 0 };
    })
    .filter((b) => b.visible && /more|ellipsis|\.\.\.|更多|操作|归档|重命名/i.test(b.label));
}));

console.log('\n=== C. sidebar session row markup (the element carrying the session title) ===');
console.log(await page.evaluate(() => {
  // Find nodes whose text looks like a session title, then walk up to the row.
  const out = [];
  for (const el of document.querySelectorAll('[role="treeitem"], li, [data-session-id], [class*="session" i]')) {
    const text = (el.textContent ?? '').trim();
    if (text.length === 0 || text.length > 120) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 70),
      role: el.getAttribute('role'),
      sessionId: el.getAttribute('data-session-id'),
      text: text.slice(0, 50),
      buttonsInside: [...el.querySelectorAll('button')].length,
    });
  }
  return out.slice(0, 20);
}));

console.log('\n=== D. the plugin routes seen from inside the page ===');
console.log(await page.evaluate(async () => {
  const probe = async (path, init) => {
    try {
      const response = await fetch(path, init);
      const text = await response.text();
      return { path, status: response.status, len: text.length, head: text.slice(0, 300) };
    } catch (error) {
      return { path, error: String(error) };
    }
  };
  return [
    await probe('/session-deleter/health'),
    await probe('/session-deleter/inventory'),
    await probe('/session-deleter/trash'),
    await probe('/session-deleter/ledger'),
  ];
}));

console.log('\n=== E. click the SESSION row overflow and dump its menu ===');
console.log(await page.evaluate(async () => {
  // Session rows are the narrower sidebar entries below the workspace headers.
  // Pick every visible button and click each candidate, capturing menu text.
  const results = [];
  const buttons = [...document.querySelectorAll('button')].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const candidates = buttons.filter((b) => {
    const label = `${b.getAttribute('aria-label') ?? ''} ${b.title ?? ''} ${(b.textContent ?? '').trim()}`;
    return /more|ellipsis|\.\.\.|更多|操作/i.test(label);
  });
  for (const [i, button] of candidates.entries()) {
    button.click();
    await new Promise((r) => setTimeout(r, 600));
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((n) => (n.textContent ?? '').trim());
    if (rows.length > 0) {
      const rect = button.getBoundingClientRect();
      results.push({ candidateIndex: i, at: `${Math.round(rect.x)},${Math.round(rect.y)}`, rows });
      // close it again
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return results;
}));

console.log('\n=== F. settings -> Session Deleter section, full text + html shape ===');
console.log(await page.evaluate(async () => {
  const gear = [...document.querySelectorAll('button')].find((b) =>
    /settings|设置/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.title ?? ''}`));
  if (gear) gear.click();
  await new Promise((r) => setTimeout(r, 1500));
  const entry = [...document.querySelectorAll('button,a,[role="tab"],[role="menuitem"]')]
    .find((n) => /会话删除|Session Deleter/i.test(n.textContent ?? ''));
  if (!entry) return { found: false, settingsText: document.body.innerText.slice(0, 600) };
  entry.click();
  await new Promise((r) => setTimeout(r, 3000));
  const host = document.querySelector('.dshsd-section');
  return {
    found: true,
    sectionExists: host !== null,
    sectionHtmlHead: host ? host.innerHTML.slice(0, 1200) : null,
    rowCount: document.querySelectorAll('.dshsd-row').length,
    fullText: (host ?? document.body).innerText.slice(0, 900),
  };
}));

console.log('\n=== console/network errors ===');
console.log(errors.slice(0, 20));

await browser.close();
