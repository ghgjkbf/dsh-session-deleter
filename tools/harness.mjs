// Shared path and credential resolution for every verification tool.
//
// Nothing machine-specific is stored in this repository: the browser-automation
// dependency and the Chrome build are discovered at run time (each with an
// environment override), and the GUI gate cookie is read from the environment
// rather than committed. That keeps the suites runnable on another machine.

import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Candidate `chrome/` build directories, newest discovery order first. */
function chromeCaches() {
  return [
    process.env.PUPPETEER_CACHE_DIR,
    join(homedir(), '.cache', 'puppeteer', 'chrome'),
  ].filter(Boolean);
}

/** Platform-relative paths inside one Chrome build directory. */
const BROWSER_RELATIVE_PATHS = [
  ['chrome-win64', 'chrome.exe'],
  ['chrome-win32', 'chrome.exe'],
  ['chrome-linux64', 'chrome'],
  ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
];

/** Absolute path to a Chrome binary. Override with DSH_CHROME. */
export function chromePath() {
  const override = process.env.DSH_CHROME;
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_CHROME does not exist: ${override}`);
    return override;
  }
  for (const cache of chromeCaches()) {
    if (!existsSync(cache)) continue;
    for (const build of readdirSync(cache).sort().reverse()) {
      for (const relative of BROWSER_RELATIVE_PATHS) {
        const candidate = join(cache, build, ...relative);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('no Chrome build found; set DSH_CHROME to a browser binary');
}

/** Profile node_modules roots that might hold puppeteer-core. */
function profileDirs() {
  const dirs = [process.env.DSH_PROFILE_DIR, process.env.DSH_PLUGIN_DIR, process.cwd()];
  if (process.env.DSH_HOME) {
    dirs.push(join(process.env.DSH_HOME, 'profiles', 'web'));
    dirs.push(process.env.DSH_HOME);
  }
  return dirs.filter(Boolean);
}

/** Absolute path to a puppeteer-core entry module. Override with DSH_PUPPETEER_CORE. */
export function puppeteerCorePath() {
  const override = process.env.DSH_PUPPETEER_CORE;
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_PUPPETEER_CORE does not exist: ${override}`);
    return override;
  }
  const entry = join('lib', 'puppeteer', 'puppeteer-core.js');
  for (const dir of profileDirs()) {
    // pnpm layout: node_modules/.pnpm/<name>@<version>/node_modules/<name>
    const pnpm = join(dir, 'node_modules', '.pnpm');
    if (existsSync(pnpm)) {
      const builds = readdirSync(pnpm)
        .filter((name) => name.startsWith('puppeteer-core@'))
        .sort()
        .reverse();
      for (const build of builds) {
        const candidate = join(pnpm, build, 'node_modules', 'puppeteer-core', entry);
        if (existsSync(candidate)) return candidate;
      }
    }
    // Flat layout.
    const flat = join(dir, 'node_modules', 'puppeteer-core', entry);
    if (existsSync(flat)) return flat;
  }
  throw new Error('no puppeteer-core found; set DSH_PUPPETEER_CORE or install it in the profile');
}

/** Directory screenshots are written to. Override with DSH_SHOTS_DIR. */
export function shotsDir() {
  return process.env.DSH_SHOTS_DIR ?? join(tmpdir(), 'dshsd-shots');
}

/** The GUI base URL under test. Override with DSH_URL. */
export function baseUrl() {
  return process.env.DSH_URL ?? 'http://127.0.0.1:3080';
}

/**
 * The secondary origin to compare against (the LAN/pocket listener). Only used
 * by the origin-comparison probe; it deliberately points at a different port on
 * the same host. Override with DSH_URL_ALT.
 */
export function baseUrlAlt() {
  return process.env.DSH_URL_ALT ?? 'http://127.0.0.1:3081';
}

/** The GUI gate cookie, or null when the caller supplied none. */
export function cookiePair() {
  const name = process.env.DSH_COOKIE_NAME;
  const value = process.env.DSH_COOKIE_VALUE;
  if (!name || !value) return null;
  return { name, value };
}
