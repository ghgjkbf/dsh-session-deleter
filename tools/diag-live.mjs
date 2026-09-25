// Answer two questions with one run:
//   1. Is the plugin actually live in the frontend right now?
//   2. Is something calling the host in a loop and freezing the GUI?
//
// Also decide whether a client-side fix can land without a host restart, by
// comparing the live boot-manifest revision against the revision the current
// file on disk would produce.
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';

const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
// Reproduce the host's own artifactRevision so the comparison is exact.
const framedHash = (domain, parts) => {
  const hash = createHash('sha1');
  hash.update(domain);
  hash.update('\0');
  for (const part of parts) {
    hash.update(`${Buffer.byteLength(part)}:${part}`);
  }
  return hash.digest('hex').slice(0, 12);
};
const revisionOf = (path) => {
  const s = statSync(path);
  return framedHash('plugin-artifact', [String(s.mtimeMs), String(s.ctimeMs), String(s.size)]);
};

const CLIENT = 'D:/ai-use/projects/dsh-session-deleter/lib/client.js';
const diskRev = revisionOf(CLIENT);
console.log('=== revision check ===');
console.log(`  client.js on disk      -> rev ${diskRev}`);

const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();

// Count every request the page makes to this plugin, with timing.
const calls = [];
const failures = [];
page.on('request', (r) => {
  if (r.url().includes('/session-deleter/')) calls.push({ url: r.url().replace(/^https?:\/\/[^/]+/, ''), at: Date.now() });
  if (r.url().includes('/plugins/') && r.url().includes('session-deleter')) {
    calls.push({ url: r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 90), at: Date.now(), kind: 'bundle' });
  }
});
page.on('requestfailed', (r) => failures.push(`${r.url().slice(0, 80)} ${r.failure()?.errorText}`));
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') failures.push(`console: ${m.text().slice(0, 160)}`); });

await browser.setCookie({
  name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
  domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
});

const startedAt = Date.now();
await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
await page.waitForSelector('body', { timeout: 30_000 });

console.log('\n=== live boot manifest entry ===');
const entry = await page.evaluate(() => {
  const boot = window.__DSH_BOOT__;
  if (!boot || !Array.isArray(boot.entries)) return null;
  return boot.entries.find((e) => e.id === 'dsh-session-deleter') ?? null;
});
console.log(`  ${JSON.stringify(entry)}`);
if (entry) {
  const live = entry.rev;
  console.log(`  live rev ${live} vs disk rev ${diskRev} -> ${live === diskRev ? 'MATCH (client edits are live)' : 'STALE (page served an older bundle)'}`);
}

console.log('\n=== idle observation: 12s with no interaction ===');
// Reload once so counters start clean, then sit still and watch for a loop.
calls.length = 0;
await page.goto(BASE_URL(), { waitUntil: 'networkidle2', timeout: 60_000 });
const idleStart = Date.now();
await new Promise((r) => setTimeout(r, 12_000));
const pluginCalls = calls.filter((c) => c.kind !== 'bundle');
console.log(`  plugin route calls while idle: ${pluginCalls.length}`);
for (const call of pluginCalls.slice(0, 20)) console.log(`    +${call.at - idleStart}ms ${call.url}`);
const bundleCalls = calls.filter((c) => c.kind === 'bundle');
console.log(`  bundle requests: ${bundleCalls.length}`);

console.log('\n=== is the page responsive right now? ===');
const responsive = await page.evaluate(async () => {
  const started = performance.now();
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  // Measure how long a trivial timer takes against a busy main thread.
  const timerStart = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    rafMs: performance.now() - started,
    timerMs: performance.now() - timerStart,
    buttons: document.querySelectorAll('button').length,
    hasSection: document.querySelector('.dshsd-section') !== null,
  };
});
console.log(`  ${JSON.stringify(responsive)}`);

console.log('\n=== time one inventory request, with and without titles ===');
const timings = await page.evaluate(async () => {
  const out = [];
  for (const query of ['?titles=0', '']) {
    const url = new URL(`/session-deleter/inventory${query}`, window.location.origin).toString();
    const started = performance.now();
    try {
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      const text = await response.text();
      const parsed = JSON.parse(text);
      out.push({
        query: query || '(default)',
        ms: Math.round(performance.now() - started),
        sessions: parsed.sessions.length,
        titled: parsed.sessions.filter((s) => s.title !== '').length,
      });
    } catch (error) {
      out.push({ query: query || '(default)', error: String(error) });
    }
  }
  return out;
});
for (const t of timings) console.log(`  ${JSON.stringify(t)}`);

console.log('\n=== failures ===');
console.log(failures.length === 0 ? '  none' : failures.slice(0, 10).map((f) => `  ${f}`).join('\n'));

console.log(`\ntotal observe time: ${Date.now() - startedAt} ms`);
await browser.close();
