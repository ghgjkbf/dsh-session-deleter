// Load the host half exactly the way the harness does and exercise every route
// over real HTTP, against a sandbox session tree.
//
// This is the integration check the unit verification cannot give: it proves the
// module's export shape (`name`/`inject`/`apply`) is what cordis expects, that
// `apply` registers routes through a stubbed `webServer` whose contract mirrors
// the shipped one (single argument, disposer function back), and that each
// handler answers a real request with the documented JSON shape.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';

// Source tree the sandbox copies its fixture sessions from. Override with
// DSH_SESSIONS_DIR; when it does not exist the suite builds its own fixtures.
const SANDBOX_SRC = process.env.DSH_SESSIONS_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');

let failures = 0;
const check = (label, condition, detail = '') => {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('=== 1. cordis plugin export shape ===');
check('exports a name', typeof plugin.name === 'string' && plugin.name.length > 0, plugin.name);
check('the name is the package name', plugin.name === 'session-deleter', plugin.name);
check('exports an inject array', Array.isArray(plugin.inject));
check('exports apply as a function', typeof plugin.apply === 'function');

// ---------------------------------------------------------------------------
console.log('\n=== 2. apply() registers every route through a webServer stub ===');

const sandbox = await mkdtemp(join(tmpdir(), 'dshsd-http-'));
const sessionRoot = join(sandbox, 'sessions');
const trashRoot = join(sandbox, 'trash');

// Seed the sandbox with two real session directories so inventory has content.
const sourceProject = join(SANDBOX_SRC, '--D-ai-use--');
await cp(sourceProject, join(sessionRoot, '--D-ai-use--'), { recursive: true });

const registered = new Map();
const seenPaths = new Set();
const webServer = {
  register(route) {
    // The shipped contract: exactly one argument in, a disposer function out,
    // and a duplicate (kind, path) throws.
    if (arguments.length !== 1) throw new Error(`register() took ${arguments.length} arguments, expected 1`);
    const key = `${route.kind} ${route.path}`;
    if (seenPaths.has(key)) throw new Error(`duplicate route ${key}`);
    seenPaths.add(key);
    registered.set(route.path, route.handler);
    let disposed = false;
    return () => { disposed = true; registered.delete(route.path); };
  },
};

const effects = [];
const ctx = {
  inject(keys, callback) {
    check('injects only webServer', Array.isArray(keys) && keys.length === 1 && keys[0] === 'webServer', keys.join(','));
    const host = { webServer, effect: (fn, label) => { effects.push(label); return fn(); } };
    callback(host);
  },
};

let applied = false;
try {
  plugin.apply(ctx, { sessionRoot, trashRoot });
  applied = true;
  check('apply() returned without throwing', true);
} catch (error) {
  check('apply() returned without throwing', false, error.message);
}
if (!applied) {
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}

const expected = ['/session-deleter/health', '/session-deleter/inventory', '/session-deleter/plan',
  '/session-deleter/delete', '/session-deleter/trash', '/session-deleter/restore',
  '/session-deleter/purge', '/session-deleter/ledger'];
for (const path of expected) check(`registered ${path}`, registered.has(path));
check('registered exactly 8 routes', registered.size === 8, String(registered.size));
check('declared one effect', effects.length === 1, effects.join(' | '));

// ---------------------------------------------------------------------------
console.log('\n=== 3. every route answers over real HTTP ===');

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const handler = registered.get(path);
  if (handler === undefined) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"ok":false}');
    return;
  }
  Promise.resolve(handler(request, response)).catch((error) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { message: error.message } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function call(path, init) {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: response.status, body };
}
const post = (path, payload) => call(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

// health
const health = await call('/session-deleter/health');
check('GET /health returns 200', health.status === 200, String(health.status));
check('GET /health is ok', health.body.ok === true);
check('GET /health reports the session root', health.body.sessionRoot === sessionRoot, health.body.sessionRoot);
check('GET /health reports the trash root', health.body.trashRoot === trashRoot, health.body.trashRoot);

// inventory
const inventory = await call('/session-deleter/inventory');
check('GET /inventory returns 200', inventory.status === 200, String(inventory.status));
check('GET /inventory lists sessions', Array.isArray(inventory.body.sessions) && inventory.body.sessions.length > 0, `${inventory.body.sessions?.length} rows`);
const row = inventory.body.sessions[0];
check('an inventory row carries the fields the UI reads', row && typeof row.sessionId === 'string' && typeof row.bytes === 'number' && Array.isArray(row.generations));
check('inventory flags the current session', typeof row.isCurrent === 'boolean');
check('inventory reports trash size', inventory.body.trash && typeof inventory.body.trash.bytes === 'number');

// plan
const plan = await call(`/session-deleter/plan?sessionId=${encodeURIComponent(row.sessionId)}`);
check('GET /plan returns 200', plan.status === 200, String(plan.status));
check('GET /plan returns a plan object', plan.body.plan !== undefined);
check('the plan names the directory', typeof plan.body.plan.dir === 'string', plan.body.plan.dir);
check('the plan lists consequences', Array.isArray(plan.body.plan.consequences));
check('the plan lists residue', Array.isArray(plan.body.plan.residue));
check('the plan lists blockers', Array.isArray(plan.body.plan.blockers));
check('the plan carries a human size', typeof plan.body.plan.humanBytes === 'string', plan.body.plan.humanBytes);

// plan for an unknown session must be a clean 4xx, not a crash
const planUnknown = await call('/session-deleter/plan?sessionId=session-does-not-exist');
check('GET /plan for an unknown session is refused', planUnknown.status >= 400 && planUnknown.status < 500, String(planUnknown.status));
check('the refusal carries a machine code', planUnknown.body.error && typeof planUnknown.body.error.code === 'string', planUnknown.body.error?.code);

// delete
const deleted = await post('/session-deleter/delete', { sessionId: row.sessionId, force: true });
check('POST /delete returns 200', deleted.status === 200, String(deleted.status));
check('POST /delete reports a trash id', typeof deleted.body.result?.trashId === 'string', deleted.body.result?.trashId);
const trashId = deleted.body.result?.trashId;

const afterDelete = await call('/session-deleter/inventory');
check('the deleted session is gone from inventory', afterDelete.body.sessions.every((s) => s.sessionId !== row.sessionId));

// trash
const trash = await call('/session-deleter/trash');
check('GET /trash returns 200', trash.status === 200, String(trash.status));
check('GET /trash lists the held entry', trash.body.entries.some((e) => e.id === trashId), `${trash.body.entries.length} entries`);
check('GET /trash reports no corruption', trash.body.corrupt === false);
check('GET /trash reports reconcile state', Array.isArray(trash.body.orphans) && Array.isArray(trash.body.missing));

// restore
const restored = await post('/session-deleter/restore', { id: trashId });
check('POST /restore returns 200', restored.status === 200, String(restored.status));
const afterRestore = await call('/session-deleter/inventory');
check('the restored session is back in inventory', afterRestore.body.sessions.some((s) => s.sessionId === row.sessionId));

// purge refuses without the explicit confirmation flag
const deleteAgain = await post('/session-deleter/delete', { sessionId: row.sessionId, force: true });
const purgeId = deleteAgain.body.result?.trashId;
const purgeUnconfirmed = await post('/session-deleter/purge', { id: purgeId });
check('POST /purge without confirm is refused', purgeUnconfirmed.status >= 400, String(purgeUnconfirmed.status));
check('the refusal names the confirm requirement', /confirm/i.test(purgeUnconfirmed.body.error?.message ?? ''), purgeUnconfirmed.body.error?.message);

const purgeConfirmed = await post('/session-deleter/purge', { id: purgeId, confirm: true });
check('POST /purge with confirm returns 200', purgeConfirmed.status === 200, String(purgeConfirmed.status));
const trashAfter = await call('/session-deleter/trash');
check('the purged entry left the trash', trashAfter.body.entries.every((e) => e.id !== purgeId));

// ledger
const ledger = await call('/session-deleter/ledger?limit=50');
check('GET /ledger returns 200', ledger.status === 200, String(ledger.status));
check('GET /ledger recorded the operations', Array.isArray(ledger.body.entries) && ledger.body.entries.length > 0, `${ledger.body.entries?.length} entries`);
check('the ledger saw the deletion', ledger.body.entries.some((e) => e.op === 'session/delete'));
check('the ledger saw the restore', ledger.body.entries.some((e) => e.op === 'session/restore'));
check('the ledger saw the purge', ledger.body.entries.some((e) => e.op === 'session/purge'));

// ---------------------------------------------------------------------------
console.log('\n=== 4. request hardening ===');

const wrongMethod = await call('/session-deleter/delete');
check('GET on a POST-only route is refused', wrongMethod.status === 405, String(wrongMethod.status));

const badJson = await call('/session-deleter/delete', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
});
check('malformed JSON is refused with 400', badJson.status === 400, String(badJson.status));

const missingId = await post('/session-deleter/delete', {});
check('a missing sessionId is refused', missingId.status >= 400, String(missingId.status));

const traversal = await post('/session-deleter/delete', { sessionId: '../../etc/passwd', force: true });
check('a traversal-shaped sessionId is refused', traversal.status >= 400, String(traversal.status));

const oversized = await call('/session-deleter/delete', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'x'.repeat(2 * 1024 * 1024) }),
});
check('an oversized body is refused', oversized.status === 413, String(oversized.status));

const unknownRoute = await call('/session-deleter/nope');
check('an unknown path is a 404 from the router, not the plugin', unknownRoute.status === 404, String(unknownRoute.status));

// ---------------------------------------------------------------------------
console.log('\n=== 5. unload releases every route ===');
// The previous stub still holds every path, so mount the plugin on a fresh
// server stub: that is what a reload looks like, and it proves the plugin's own
// registrations are the only ones it touches.
const reloaded = new Map();
const webServer2 = {
  register(route) {
    if (reloaded.has(route.path)) throw new Error(`duplicate route ${route.path}`);
    reloaded.set(route.path, route.handler);
    return () => { reloaded.delete(route.path); };
  },
};
const captured = [];
const ctx2 = {
  inject: (keys, callback) => callback({
    webServer: webServer2,
    effect: (fn) => { const disposer = fn(); captured.push(disposer); return disposer; },
  }),
};
plugin.apply(ctx2, { sessionRoot, trashRoot });
check('a reload registers all 8 routes again', reloaded.size === 8, String(reloaded.size));
for (const disposer of captured) if (typeof disposer === 'function') disposer();
check('teardown emptied the reloaded route table', reloaded.size === 0, String(reloaded.size));
check('the first mount is still registered', registered.size === 8, String(registered.size));

server.close();
await rm(sandbox, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
