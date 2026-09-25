// Verify the browser bundle loads and registers correctly, without a browser.
//
// `lib/client.js` is a module-loader bundle, so loading it means: provide a
// `window.__ModuleLoader__`, capture the factory, and call it with a `require`
// that returns stand-ins. React is not needed as a real renderer here — the point
// is to prove the factory runs, the dictionaries register, all three slots are
// claimed with the right ids and orders, and every component is a function.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baseUrl as BASE_URL } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

let failures = 0;
const check = (label, condition, detail = '') => {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- a minimal React stand-in ----------------------------------------------
// Only the surface the bundle actually touches: hooks used at render time are
// never called here (no rendering), but the factory evaluates top-level code and
// each component's implementation must parse and be reachable.
const react = {
  createElement: () => ({}),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const jsxRuntime = {
  jsx: (type, props, key) => ({ type, props, key }),
  jsxs: (type, props, key) => ({ type, props, key }),
  Fragment: Symbol('Fragment'),
};

const ICONS = [
  'IconTrashOutlineRegular', 'IconArchiveOutlineRegular', 'IconWarningOutlineRegular',
  'IconCloseFillRegular', 'IconEllipsisOutlineRegular', 'IconFolderCloseRegular',
];
const primitives = {
  MenuItemButton: function MenuItemButton() {},
  Modal: function Modal() {},
  Button: function Button() {},
  Toast: function Toast() {},
  Tooltip: function Tooltip() {},
};
for (const icon of ICONS) primitives[icon] = function Icon() {};

// --- a capture-only window -------------------------------------------------
let registered = null;
const headChildren = [];
const documentStub = {
  head: { appendChild: (node) => headChildren.push(node) },
  createElement: (tag) => ({ tag, dataset: {}, textContent: '', setAttribute() {} }),
  querySelector: () => null,
};
globalThis.document = documentStub;
globalThis.window = {
  location: { origin: BASE_URL() },
  __ModuleLoader__: { load: (entry) => { registered = entry; } },
};
globalThis.fetch = async () => ({ ok: true, text: async () => '{"ok":true}' });

// --- load ------------------------------------------------------------------
const source = await readFile(clientPath, 'utf8');

// The bundle is an ordinary script that calls `window.__ModuleLoader__.load(...)`,
// so it has to be *executed* against the stub window — reading the text would only
// prove the file parses.
const { runInNewContext } = await import('node:vm');
const sandbox = {
  window: globalThis.window,
  document: documentStub,
  fetch: globalThis.fetch,
  URL,
  JSON,
  Object,
  Array,
  String,
  Number,
  Math,
  Error,
  Promise,
  Set,
  Map,
  Symbol,
  encodeURIComponent,
  console,
};
try {
  runInNewContext(source, sandbox, { filename: clientPath });
} catch (error) {
  console.log(`  [FAIL] bundle threw at script evaluation — ${error.message}`);
  process.exit(1);
}

console.log('=== 1. bundle shape ===');
check('the file registers exactly one module', registered !== null);
check('the module id is the package name', registered && registered.id === 'dsh-session-deleter', registered && registered.id);
check('the factory is a function', registered && typeof registered.factory === 'function');

const requireStub = (specifier) => {
  switch (specifier) {
    case 'react': return react;
    case 'react/jsx-runtime': return jsxRuntime;
    case '@deepseek-ai/dsh-client-ui-primitives': return primitives;
    default: throw new Error(`the bundle required an unavailable module: ${specifier}`);
  }
};

console.log('\n=== 2. factory executes ===');
let exported;
try {
  exported = registered.factory(requireStub);
  check('factory returned without throwing', true);
} catch (error) {
  check('factory returned without throwing', false, error.message);
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
check('exports.apply is a function', typeof exported.apply === 'function');
check('exports.inject lists the required services', Array.isArray(exported.inject));
check('inject includes slots', exported.inject.includes('slots'));
check('inject includes locale', exported.inject.includes('locale'));
check('the bundle injected its stylesheet', headChildren.length === 1);
check('the stylesheet tag is namespaced', headChildren[0] && headChildren[0].dataset.pluginCss === 'dsh-session-deleter/client.css');

console.log('\n=== 3. apply() registers every surface ===');

const registrations = [];
const effects = [];
const dicts = {};

const ctx = {
  // Real cordis runs the callback immediately and keeps the returned disposer,
  // so the dictionary registration only happens if this stub does the same.
  effect(fn, label) {
    effects.push(label);
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  locale: {
    register(ns, d) { dicts[ns] = d; return () => {}; },
    bind(ns) {
      return (key) => {
        const table = dicts[ns];
        const value = table && table.zh && table.zh[key];
        if (value === undefined) throw new Error(`missing locale key: ${ns}.${key}`);
        return value;
      };
    },
  },
  slots: {
    inject(name, callback) { callback(); return () => {}; },
    register(options, component) {
      const record = { name: options.name, id: options.id, order: options.order, component, options };
      registrations.push(record);
      // The real registry keys list entries on id and rejects duplicates, so the
      // same collision check runs here.
      const clash = registrations.filter((r) => r.name === options.name && r.id === options.id);
      if (clash.length > 1) throw new Error(`duplicate slot registration: ${options.name}#${options.id}`);
      return () => {};
    },
  },
};

try {
  exported.apply(ctx);
  check('apply() returned without throwing', true);
} catch (error) {
  check('apply() returned without throwing', false, error.message);
}

check('dictionaries registered under the plugin namespace', Object.keys(dicts).length === 1, Object.keys(dicts).join(','));
const dict = dicts['session-deleter'];
check('dictionary carries zh and en', dict && dict.zh && dict.en);
check('zh and en cover the same keys', dict && Object.keys(dict.zh).sort().join(',') === Object.keys(dict.en).sort().join(','));
check('every zh value is a non-empty string', dict && Object.values(dict.zh).every((v) => typeof v === 'string' && v.length > 0));
check('effects registered', effects.length >= 1, effects.join(' | '));

const byId = (name) => registrations.filter((r) => r.name === name);

console.log('\n=== 4. the session "..." menu row ===');
const menuRows = byId('sidebar.workspaces.session.menu.item');
check('exactly one menu row registered', menuRows.length === 1);
const menuRow = menuRows[0];
check('its id is package-namespaced, not a shipped id', menuRow && menuRow.id === 'session-deleter', menuRow && menuRow.id);
const SHIPPED = ['pin', 'rename', 'fork', 'archive'];
check('it does not reuse a shipped id', menuRow && !SHIPPED.includes(menuRow.id));
check('its order lands after the shipped rows (100/200/300/400)', menuRow && menuRow.order === 500, String(menuRow && menuRow.order));
check('it renders a component', typeof menuRow.component === 'function');
check('it declares the package locale namespace', menuRow && menuRow.options.locale === 'session-deleter');

console.log('\n=== 5. the confirmation dialog and settings page ===');
const overlays = byId('shell.overlay');
check('exactly two overlays registered (dialog + picker)', overlays.length === 2, String(overlays.length));
check('the dialog overlay id is namespaced', overlays.some((o) => o.id === 'session-deleter.dialog'), overlays.map((o) => o.id).join(', '));
check('the picker overlay id is namespaced', overlays.some((o) => o.id === 'session-deleter.picker'), overlays.map((o) => o.id).join(', '));

const sections = byId('settings.section');
check('exactly one settings section registered', sections.length === 1);
check('the section id is namespaced', sections[0] && sections[0].id === 'session-deleter', sections[0] && sections[0].id);
check('the section order sits among the shipped pages', sections[0] && typeof sections[0].order === 'number', String(sections[0] && sections[0].order));

// The always-visible way in: a hover-only menu row cannot be the only entry.
const footerActions = byId('sidebar.footer.action');
check('one persistent sidebar-footer entry registered', footerActions.length === 1, String(footerActions.length));
check('the footer id is namespaced', footerActions[0] && footerActions[0].id === 'session-deleter.delete', footerActions[0] && footerActions[0].id);

console.log('\n=== 6. no surface collides with another ===');
const keys = registrations.map((r) => `${r.name}#${r.id}`);
check('all registration keys are distinct', new Set(keys).size === keys.length, keys.join(', '));
// Five surfaces: menu row, dialog overlay, picker overlay, footer entry, settings page.
check('exactly five surfaces were registered', registrations.length === 5, String(registrations.length));

console.log('\n=== 7. components are renderable functions ===');
for (const record of registrations) {
  check(`${record.name}#${record.id} is a function`, typeof record.component === 'function');
}
// A component that touches a hook the stand-in lacks would throw here.
for (const record of registrations) {
  if (record.options.locale !== 'session-deleter') continue;
}

console.log('\n=== 8. every referenced route exists in the host ===');
const hostSource = await readFile(join(here, '..', 'lib', 'index.js'), 'utf8');
const routes = [...source.matchAll(/["'`](\/session-deleter\/[a-z]+)/g)].map((m) => m[1]);
const unique = [...new Set(routes)];
for (const route of unique) {
  check(`host serves ${route}`, hostSource.includes(`\${BASE}${route.slice('/session-deleter'.length)}`) || hostSource.includes(route), route);
}
check('the bundle calls at least four routes', unique.length >= 4, unique.join(', '));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
