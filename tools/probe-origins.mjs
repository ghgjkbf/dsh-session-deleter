import { puppeteerCorePath as PUPPETEER_CORE_PATH, chromePath as CHROME_PATH, baseUrl as BASE_URL, baseUrlAlt as BASE_URL_ALT, shotsDir as SHOTS_DIR, cookiePair } from './harness.mjs';
// Compare the two served origins: the loopback GUI (3080) and the LAN/pocket
// origin (3081). The plugin must be visible on whichever one the human is using.
const PUPPETEER_CORE = PUPPETEER_CORE_PATH();
const CHROME = CHROME_PATH();
const puppeteer = await import(`file:///${PUPPETEER_CORE}`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1000 },
});

for (const origin of [BASE_URL(), BASE_URL_ALT()]) {
  console.log(`\n########## ${origin} ##########`);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });

  const authority = new URL(origin).host;
  await browser.setCookie({
    name: process.env.DSH_COOKIE_NAME, value: process.env.DSH_COOKIE_VALUE,
    domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
  });

  try {
    await page.goto(origin, { waitUntil: 'networkidle2', timeout: 45_000 });
  } catch (error) {
    console.log(`  navigate failed: ${error.message.slice(0, 120)}`);
    await page.close();
    continue;
  }
  await new Promise((r) => setTimeout(r, 5000));

  console.log(JSON.stringify(await page.evaluate(() => {
    const text = document.body.innerText;
    const boot = window.__DSH_BOOT__;
    return {
      title: document.title,
      bootEntries: boot?.entries?.length ?? 0,
      pluginInBoot: boot?.entries?.some((e) => e.id === 'dsh-session-deleter') ?? false,
      pluginRev: boot?.entries?.find((e) => e.id === 'dsh-session-deleter')?.rev ?? null,
      cssTag: document.querySelector('style[data-plugin-css="dsh-session-deleter/client.css"]') !== null,
      // Does this shell render the session "...", sidebar at all?
      treeitems: document.querySelectorAll('[role="treeitem"]').length,
      hasSessionTriggers: [...document.querySelectorAll('button')]
        .filter((b) => /^会话[“"].*[”"]的操作$/u.test(b.getAttribute('aria-label') ?? '')).length,
      bodyHead: text.slice(0, 180).replace(/\n+/g, ' | '),
    };
  }, null, 2)));

  console.log(`  errors: ${errors.length === 0 ? 'none' : errors.slice(0, 4).join(' ;; ')}`);
  await page.close();
}

await browser.close();
