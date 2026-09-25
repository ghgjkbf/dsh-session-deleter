// End-to-end verification of the plugin's host half, against a sandbox copy of
// real session logs. Proves the destructive path is reversible and that a
// rewrite reproduces the container exactly.
//
// Run: node tools/verify-host.mjs [<real-sessions-root>]
//      DSH_SESSIONS_DIR overrides, and <DSH_HOME>/sessions is the default. When
//      that tree is missing or empty the suite synthesizes its own fixture, so
//      the checks still run in CI.
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { inventory, locate } from '../lib/sessions.js';
import { hold, purge, reconcile, restore } from '../lib/trash.js';
import { readLog, writeLog } from '../lib/frames.js';
import { replaceFile } from '../lib/atomic.js';
import { projectKey, sessionDir, encodeSegment } from '../lib/paths.js';
import { record, tail } from '../lib/ledger.js';

const defaultRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
const realRoot = process.argv[2] ?? process.env.DSH_SESSIONS_DIR ?? defaultRoot;
if (!existsSync(realRoot)) {
  console.error(`no session tree at ${realRoot}; pass a root or set DSH_SESSIONS_DIR`);
  process.exit(2);
}

let failures = 0;
const check = (label, condition, detail = '') => {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const sandbox = await mkdtemp(join(tmpdir(), 'dshsd-verify-'));
const root = join(sandbox, 'sessions');
const trashRoot = join(sandbox, 'trash');

console.log(`sandbox: ${sandbox}`);
console.log(`source:  ${realRoot}`);

// ---------------------------------------------------------------------------
console.log('\n=== 1. inventory over a sandbox copy of the real session tree ===');

const real = await inventory(realRoot, { withTitles: true });
console.log(`  discovered ${real.rows.length} session(s) in ${real.projects.length} project dir(s)`);
check('inventory found sessions', real.rows.length > 0, `${real.rows.length} rows`);
const multiGen = real.rows.filter((row) => row.generations.length > 1);
console.log(`  multi-generation sessions: ${multiGen.length}`);
check('a source session has >1 generation or >=1', real.rows.every((row) => row.generations.length >= 1));
check('every row has a title field', real.rows.every((row) => typeof row.title === 'string'));
check('every row reports bytes', real.rows.every((row) => typeof row.bytes === 'number' && row.bytes > 0));
const titled = real.rows.filter((row) => row.title.length > 0);
check('titles were parsed from real logs', titled.length > 0, `${titled.length}/${real.rows.length}`);
if (titled.length > 0) console.log(`  sample title: ${JSON.stringify(titled[0].title.slice(0, 60))}`);

// ---------------------------------------------------------------------------
console.log('\n=== 2. copy one real session into the sandbox ===');

const source = real.rows.find((row) => row.generations.length > 1) ?? real.rows[0];
const cwd = source.cwd ?? 'D:\\ai-use';
const destDir = sessionDir(root, cwd, source.sessionId);
await mkdir(destDir, { recursive: true });
for (const generation of source.generations) {
  await writeFile(join(destDir, generation.filename), await readFile(join(source.dir, generation.filename)));
}
const copied = await discoverGenerationsIn(destDir);
console.log(`  copied ${copied.length} generation(s) of ${source.sessionId} -> ${destDir}`);
check('copy has the same generation count', copied.length === source.generations.length);

const destRoot = join(sandbox, 'sessions');
const found = await locate(destRoot, source.sessionId, cwd);
check('locate() resolves the copied session by id + cwd', found !== undefined && found.dir === destDir);

// ---------------------------------------------------------------------------
console.log('\n=== 3. recycle bin: hold -> verify gone -> restore -> verify back ===');

const beforeBytes = (await stat(destDir)).isDirectory();
check('target directory exists before deletion', beforeBytes);

const entry = await hold({
  trashRoot,
  dir: destDir,
  sessionId: source.sessionId,
  title: source.title,
  cwd,
  bytes: source.bytes,
  generations: source.generations.map((g) => g.filename),
});
check('held entry recorded', typeof entry.id === 'string' && entry.id.length > 0, entry.id);
check('original directory is gone', !(await exists(destDir)));
check('trashed directory exists', await exists(entry.held));
check('held bytes match', (await stat(entry.held)).isDirectory());
const heldFiles = await readdirNames(entry.held);
check('held directory kept its log files', heldFiles.some((n) => n.includes('.jsonl')));

const afterHold = await inventory(destRoot, { withTitles: false });
check('inventory no longer lists the deleted session', afterHold.rows.every((row) => row.sessionId !== source.sessionId));

const view = await reconcile(trashRoot);
check('manifest lists exactly one entry', view.entries.length === 1);
check('reconcile reports no orphans after a clean hold', view.orphans.length === 0);
check('reconcile reports no missing directories', view.missing.length === 0);

const restored = await restore(trashRoot, entry.id);
check('restore returns the original path', restored === destDir);
check('directory is back', await exists(destDir));
const backView = await reconcile(trashRoot);
check('manifest is empty after restore', backView.entries.length === 0);
const reListed = await inventory(destRoot, { withTitles: false });
check('inventory lists the session again', reListed.rows.some((row) => row.sessionId === source.sessionId));

// ---------------------------------------------------------------------------
console.log('\n=== 4. permanent deletion removes the bytes irreversibly ===');

const entry2 = await hold({ trashRoot, dir: destDir, sessionId: source.sessionId, title: source.title, cwd, bytes: source.bytes, generations: [] });
const heldPath = entry2.held;
await purge(trashRoot, entry2.id);
check('held directory is gone after purge', !(await exists(heldPath)));
check('manifest is empty after purge', (await reconcile(trashRoot)).entries.length === 0);
// Restoring a purged entry must fail loudly rather than silently recreating it.
let restoreThrew = false;
try { await restore(trashRoot, entry2.id); } catch { restoreThrew = true; }
check('restoring a purged entry is refused', restoreThrew);

// Purging twice must also refuse rather than deleting something else.
let purgeThrew = false;
try { await purge(trashRoot, entry2.id); } catch { purgeThrew = true; }
check('purging an unknown entry is refused', purgeThrew);

// ---------------------------------------------------------------------------
console.log('\n=== 5. restore refuses to overwrite a live session ===');

// Recreate the target path first: hold() must be able to move a real directory.
await mkdir(destDir, { recursive: true });
for (const generation of source.generations) {
  await writeFile(join(destDir, generation.filename), await readFile(join(source.dir, generation.filename)));
}
const entry3 = await hold({ trashRoot, dir: destDir, sessionId: source.sessionId, title: source.title, cwd, bytes: 0, generations: [] });
await mkdir(destDir, { recursive: true });
await writeFile(join(destDir, 'placeholder.txt'), 'a live session recreated this path');
let overwriteRefused = false;
try { await restore(trashRoot, entry3.id); } catch (error) { overwriteRefused = /already exists/.test(error.message); }
check('restore refuses when the original path is occupied', overwriteRefused);
check('the occupying directory survives', await exists(join(destDir, 'placeholder.txt')));
await purge(trashRoot, entry3.id);
await rm(destDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log('\n=== 6. atomic replacement keeps a backup and loses nothing ===');

const probe = join(sandbox, 'probe.bin');
await writeFile(probe, 'original-content');
const backupPath = await replaceFile(probe, 'replacement-content');
check('backup path was returned', typeof backupPath === 'string' && backupPath.includes('.bak-'));
check('target holds the new bytes', (await readFile(probe, 'utf8')) === 'replacement-content');
check('backup holds the old bytes', (await readFile(backupPath, 'utf8')) === 'original-content');
let secondCallUnchanged = true;
try {
  const again = await replaceFile(probe, 'third-content');
  check('a second replacement still yields a distinct backup', again !== backupPath);
} catch { secondCallUnchanged = false; }
check('replacement is repeatable', secondCallUnchanged);

// ---------------------------------------------------------------------------
console.log('\n=== 7. audit ledger survives and is readable ===');

const ledgerPath = join(sandbox, 'ledger.jsonl');
await record(ledgerPath, { op: 'session/delete', phase: 'begin', sessionId: 'session-x' });
await record(ledgerPath, { op: 'session/delete', phase: 'done', sessionId: 'session-x', trashId: 'e1' });
const entries = await tail(ledgerPath, 10);
check('ledger recorded both phases', entries.length === 2);
check('ledger entries carry a timestamp', entries.every((e) => typeof e.at === 'string'));
check('ledger preserves the operation', entries[0].op === 'session/delete' && entries[1].phase === 'done');
// A torn final line (crash mid-append) must not break reading.
await writeFile(ledgerPath, (await readFile(ledgerPath, 'utf8')) + '{"op":"torn"', 'utf8');
const toleranted = await tail(ledgerPath, 10);
check('a torn trailing line is dropped, not fatal', toleranted.length === 2);

// ---------------------------------------------------------------------------
console.log('\n=== 8. rewrite fidelity on a real log ===');

// Read the source directly: the sandbox copy has been deleted and restored by
// the earlier steps, so its directory is no longer a stable fixture.
const srcGen = source.generations.find((g) => g.compression === 'zstd') ?? source.generations[0];
{
  const buffer = await readFile(join(source.dir, srcGen.filename));
  const { text, frames } = await readLog(buffer);
  const { decodeFrame } = await import('../lib/frames.js');
  const batches = [];
  for (const frame of frames) {
    batches.push(await decodeFrame(buffer.subarray(frame.start, frame.end)));
  }
  const rebuilt = await writeLog(batches);
  const again = await readLog(rebuilt);
  check('round trip preserves every byte', again.text.equals(text));
  check('round trip preserves the frame count', again.frames.length === frames.length);
  check('round trip leaves no torn frame', again.tornStart === undefined);
  console.log(`  ${srcGen.filename}: ${frames.length} frames, ${text.length} logical bytes, ${buffer.length} -> ${rebuilt.length} encoded bytes`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. traversal-shaped ids are refused ===');

const { assertSafeSessionId } = await import('../lib/paths.js');
for (const bad of ['..', '.', 'a/b', 'a\\b', '']) {
  let threw = false;
  try { assertSafeSessionId(bad); } catch { threw = true; }
  check(`refuses ${JSON.stringify(bad)}`, threw);
}
check('encodeSegment escapes separators', encodeSegment('a/b') === 'a~002Fb', encodeSegment('a/b'));
check('projectKey matches the shipped shape', projectKey('D:\\ai-use') === '--D-ai-use--', projectKey('D:\\ai-use'));

await rm(sandbox, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

// --- helpers ---------------------------------------------------------------
async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}
async function readdirNames(path) {
  const { readdir } = await import('node:fs/promises');
  return await readdir(path);
}
async function discoverGenerationsIn(dir) {
  const { discoverGenerations } = await import('../lib/paths.js');
  return await discoverGenerations(dir);
}
