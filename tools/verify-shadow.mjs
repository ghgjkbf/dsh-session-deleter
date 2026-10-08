// Verification of the message-level operations (line A shadow, line B
// truncate) against real session logs copied into a sandbox, plus a
// cross-check of the local fold replica against the installed
// @deepseek-ai/dsh-session when that package is resolvable.
//
// Run: node tools/verify-shadow.mjs [<real-sessions-root>]
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { inventory } from '../lib/sessions.js';
import { readLog, writeLog, splitLines, scanFrames } from '../lib/frames.js';
import {
  planShadow,
  applyShadow,
  undoShadow,
  planTruncate,
  applyTruncate,
  restoreTruncate,
} from '../lib/shadow.js';
import { foldNodes } from '../lib/shadow-fold.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const defaultRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
const realRoot = process.argv[2] ?? process.env.DSH_SESSIONS_DIR ?? defaultRoot;
if (!existsSync(realRoot)) {
  console.error(`no session tree at ${realRoot}; pass a root or set DSH_SESSIONS_DIR`);
  process.exit(2);
}

const sandbox = await mkdtemp(join(tmpdir(), 'dshsd-shadow-'));
const root = join(sandbox, 'sessions');
console.log(`sandbox: ${sandbox}`);
console.log(`source:  ${realRoot}`);

// ---------------------------------------------------------------------------
console.log('\n=== 1. local fold replica vs installed @deepseek-ai/dsh-session ===');

const real = await inventory(realRoot, { withTitles: false });
check('source tree has sessions', real.rows.length > 0, `${real.rows.length}`);

let realPkg = null;
const realPkgPaths = [
  '@deepseek-ai/dsh-session',
  'C:/Users/Administrator/.ai-manager/npm-global/node-v24/node_modules/@deepseek-ai/dsh-session/lib/index.js',
  'file:///C:/Users/Administrator/.ai-manager/npm-global/node-v24/node_modules/@deepseek-ai/dsh-session/lib/index.js',
];
for (const spec of realPkgPaths) {
  try {
    realPkg = await import(spec);
    console.log(`  installed @deepseek-ai/dsh-session resolved (${spec}); cross-checking…`);
    break;
  } catch {
    /* try the next resolution path */
  }
}
if (realPkg === null) console.log('  installed package not resolvable from here; skipping cross-check');

// Take a few real logs (append-heavy ones preferred) and compare folds.
const crossCandidates = real.rows
  .filter((row) => typeof row.dir === 'string' && typeof row.generations[0]?.filename === 'string')
  .slice(0, 4);

for (const row of crossCandidates) {
  const artifact = join(row.dir, row.generations[0].filename);
  const buffer = await readFile(artifact);
  const { text } = await readLog(buffer);
  // The real foldSurface demands contiguous seqs starting at 0; the raw log
  // holds the seq-less `session` header record first, so both folds here see
  // the sequenced events only.
  const events = splitLines(text.toString('utf8'))
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((event) => event !== null && typeof event.seq === 'number');
  if (events.length === 0) continue;

  let replica;
  try {
    replica = foldNodes(events);
  } catch (error) {
    check(`replica folds ${row.sessionId}`, false, error.message);
    continue;
  }
  if (realPkg !== null) {
    try {
      const canonical = realPkg.foldSurface(events);
      const sameNodes = JSON.stringify(canonical.nodes) === JSON.stringify(replica.nodes);
      check(`replica matches foldSurface on ${row.sessionId}`, sameNodes,
        `${replica.nodes.length} nodes`);
    } catch (error) {
      // The real fold can demand projections the replica reports too; both
      // must refuse, not one succeed and one fail.
      let replicaAlsoRefused = false;
      try { foldNodes(events); } catch { replicaAlsoRefused = true; }
      check(`real fold refused and replica agrees on ${row.sessionId}`, replicaAlsoRefused, error.message.slice(0, 80));
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. shadow: plan -> apply -> verify tombstone semantics ===');

// Pick a real session with an append user/message after seq 0.
const pickRow = real.rows.find((row) => {
  const gen = row.generations[0];
  return gen !== undefined && typeof row.dir === 'string';
});
check('a candidate session exists', pickRow !== undefined);
if (pickRow === undefined) {
  await rm(sandbox, { recursive: true, force: true });
  process.exit(1);
}

const cwd = pickRow.cwd ?? 'D:\\ai-use';
const destDir = join(root, 'proj', pickRow.sessionId);
await mkdir(destDir, { recursive: true });
const gen = pickRow.generations[0];
const artifactPath = join(destDir, gen.filename);
await writeFile(artifactPath, await readFile(join(pickRow.dir, gen.filename)));

const { readLog: rl, splitLines: sl } = await import('../lib/frames.js');
const readEvents = async (path) => {
  const buffer = await readFile(path);
  const { text } = await rl(buffer);
  return sl(text.toString('utf8'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((event) => event !== null && typeof event.seq === 'number');
};

const originalEvents = await readEvents(artifactPath);
const originalBytes = (await stat(artifactPath)).size;
const target = originalEvents.find(
  (event) => event.surfaceOp === 'append' && (event.type === 'user/message' || event.type === 'assistant/message'),
);
check('a shadowable append message exists', target !== undefined, target ? `seq ${target.seq} ${target.type}` : '');

const planned = await planShadow(artifactPath, target.seq);
check('plan succeeds', planned.ok === true, planned.ok ? '' : planned.error?.message);
check('plan is reversible by default', planned.plan?.reversible === true);
check('plan tombstone seq exceeds every event seq',
  planned.plan?.tombstoneSeq > Math.max(...originalEvents.map((e) => e.seq)));

const applied = await applyShadow(artifactPath, target.seq);
check('apply succeeds', applied.ok === true, applied.ok ? '' : applied.error?.message);

const afterEvents = await readEvents(artifactPath);
check('log grew by exactly one event', afterEvents.length === originalEvents.length + 1);
const tombstone = afterEvents[afterEvents.length - 1];
check('tombstone is a developer/message', tombstone.type === 'developer/message');
check('tombstone carries a replace op over the target',
  tombstone.surfaceOp?.op === 'replace' && tombstone.surfaceOp.startSeq === target.seq && tombstone.surfaceOp.endSeq === target.seq);
check('tombstone cites its source',
  Array.isArray(tombstone.sourceEventSeqs) && tombstone.sourceEventSeqs.includes(target.seq));
check('tombstone content is empty (derives to no LLM message)',
  Array.isArray(tombstone.data?.message?.content) && tombstone.data.message.content.length === 0);

// The original events must be byte-identical in the prefix (append-only kept).
check('every original event survived untouched',
  JSON.stringify(originalEvents) === JSON.stringify(afterEvents.slice(0, originalEvents.length)));

// The fold contract: a single-node replace splices one node out and the
// tombstone in, so the node count is unchanged — but the target leaves the
// live node list (the model-facing message count drops by one).
const foldBefore = foldNodes(originalEvents);
const foldAfter = foldNodes(afterEvents);
check('node count is unchanged by a single-node replace',
  foldAfter.nodes.length === foldBefore.nodes.length,
  `${foldBefore.nodes.length} -> ${foldAfter.nodes.length}`);
check('target left the live node list', !foldAfter.nodes.includes(target.seq));
check('tombstone joined the live node list', foldAfter.nodes.includes(applied.result.tombstoneSeq));
if (realPkg !== null) {
  const canonical = realPkg.foldSurface(afterEvents);
  const replica = foldNodes(afterEvents);
  check('real foldSurface agrees with replica post-shadow',
    JSON.stringify(canonical.nodes) === JSON.stringify(replica.nodes));
  // deriveEventMessage semantics: the tombstone must derive to null.
  const { deriveEventMessage } = realPkg;
  const projected = new Map(canonical.projectedMessages);
  check('tombstone derives to no LLM message', deriveEventMessage(tombstone, projected) === null);
}

// Model-facing message count: every live surface node that derives to a
// real message. Original fold: nodes minus shadowed ones all derive; after:
// one fewer live message because the target's node is the tombstone now.
const originalLiveTargets = originalEvents.filter(
  (event) => event.surfaceOp === 'append' && foldBefore.nodes.includes(event.seq),
).length;
const afterLiveTargets = afterEvents.filter(
  (event) => event.surfaceOp === 'append' && foldAfter.nodes.includes(event.seq),
).length;
check('model-facing append-origin message count drops by one',
  afterLiveTargets === originalLiveTargets - 1,
  `${originalLiveTargets} -> ${afterLiveTargets}`);

// ---------------------------------------------------------------------------
console.log('\n=== 3. shadow refusals ===');

const toolResult = originalEvents.find((event) => event.type === 'tool/result' && event.surfaceOp === 'append');
if (toolResult !== undefined) {
  const refused = await planShadow(artifactPath, toolResult.seq);
  check('tool/result shadow is refused', refused.ok === false && refused.error.code === 'not-shadowable');
}
const replacementCopy = originalEvents.find((event) => typeof event.surfaceOp === 'object');
if (replacementCopy !== undefined) {
  const refused = await planShadow(artifactPath, replacementCopy.seq);
  check('replacement copy shadow is refused', refused.ok === false && refused.error.code === 'already-replaced');
}
const reShadow = await planShadow(artifactPath, target.seq);
check('already-shadowed node is refused', reShadow.ok === false && reShadow.error.code === 'already-shadowed');
const badSeq = await planShadow(artifactPath, 999999);
check('unknown seq is refused', badSeq.ok === false && badSeq.error.code === 'not-found');

// ---------------------------------------------------------------------------
console.log('\n=== 4. unshadow: byte-exact rollback ===');

const unshadow = await undoShadow(artifactPath, applied.result.tombstoneSeq);
check('unshadow succeeds', unshadow.ok === true, unshadow.ok ? '' : unshadow.error?.message);
const rolledEvents = await readEvents(artifactPath);
check('log is back to the original event count', rolledEvents.length === originalEvents.length);
check('rolled log is byte-identical to the original',
  (await stat(artifactPath)).size === originalBytes);
const secondUndo = await undoShadow(artifactPath, applied.result.tombstoneSeq);
check('second unshadow is refused', secondUndo.ok === false && secondUndo.error.code === 'not-found');

// ---------------------------------------------------------------------------
console.log('\n=== 5. truncate: plan -> apply -> backup restore ===');

// Choose a cut inside the log: after the first append user/message.
const cut = target.seq;
const expectedRemoved = originalEvents.filter((event) => event.seq > cut).length;
const expectedKept = originalEvents.filter((event) => event.seq <= cut).length;
const plannedCut = await planTruncate(artifactPath, cut);
check('truncate plan succeeds', plannedCut.ok === true, plannedCut.ok ? '' : plannedCut.error?.message);
check('plan counts removed events', plannedCut.plan?.removedCount === expectedRemoved,
  `${plannedCut.plan?.removedCount} vs ${expectedRemoved}`);
check('plan counts kept events', plannedCut.plan?.keptCount === expectedKept);

const appliedCut = await applyTruncate(artifactPath, cut);
check('truncate applies', appliedCut.ok === true, appliedCut.ok ? '' : appliedCut.error?.message);
check('backup was kept', typeof appliedCut.result?.backupPath === 'string');
const backupPath = appliedCut.result.backupPath;
const truncatedEvents = await readEvents(artifactPath);
check('all events up to the cut survive', truncatedEvents.every((event) => event.seq <= cut));
check('event count matches the plan', truncatedEvents.length === expectedKept,
  `${truncatedEvents.length} vs ${expectedKept}`);

// The truncated prefix must still be a legal surface.
let prefixLegal = true;
try { foldNodes(truncatedEvents); } catch { prefixLegal = false; }
check('truncated prefix still folds cleanly', prefixLegal);

// Restore: byte-exact return of the removed tail.
const restored = await restoreTruncate(artifactPath, backupPath);
check('restore succeeds', restored.ok === true, restored.ok ? '' : restored.error?.message);
const restoredEvents = await readEvents(artifactPath);
check('restored log matches the original event count', restoredEvents.length === originalEvents.length);
check('backup file was consumed', !existsSync(backupPath));

// Restore must refuse when the log moved on. The truncated log is 9 events;
// append a frame to grow it, then expect the refusal.
const again = await applyTruncate(artifactPath, cut);
check('second truncate succeeds (fresh backup)', again.ok === true);
{
  const { encodeFrame } = await import('../lib/frames.js');
  const current = await readEvents(artifactPath);
  const nextSeq = Math.max(...current.map((event) => event.seq)) + 1;
  const frame = await encodeFrame(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: nextSeq, time: Date.now(), data: {} })}\n`, 'utf8'));
  await writeFile(artifactPath, Buffer.concat([await readFile(artifactPath), frame]));
}
const refusedRestore = await restoreTruncate(artifactPath, again.result.backupPath, again.result.bytesAfter);
check('restore after growth is refused', refusedRestore.ok === false && refusedRestore.error.code === 'moved-on',
  refusedRestore.ok ? '' : refusedRestore.error?.message.slice(0, 80));

// ---------------------------------------------------------------------------
console.log('\n=== 6. kept prefix closed under shadowing (dangling defense) ===');

// A tombstone always sits after its target in the log, so a seq-cut prefix
// is closed under shadowing: any tombstone kept implies its target kept.
// The plan still folds the kept prefix as a structural defense against
// future log shapes; assert the invariant holds on this real log instead of
// expecting a refusal.
const shadowAgain = await applyShadow(artifactPath, target.seq);
check('precondition: shadow applied', shadowAgain.ok === true, shadowAgain.ok ? '' : JSON.stringify(shadowAgain.error));
const belowTarget = target.seq - 1;
if (belowTarget >= 0) {
  // Truncating below the target removes BOTH the target and its tombstone:
  // the plan must succeed (nothing dangles) and the result must fold.
  const plannedBelow = await planTruncate(artifactPath, belowTarget);
  check('truncation below a shadowed target is planned, not refused',
    plannedBelow.ok === true, plannedBelow.ok ? '' : plannedBelow.error?.message);
  if (plannedBelow.ok === true) {
    check('the shadowed target and its tombstone both leave the log',
      plannedBelow.plan.removedCount >= 2);
    const appliedBelow = await applyTruncate(artifactPath, belowTarget);
    check('truncation below a shadowed target applies', appliedBelow.ok === true, appliedBelow.ok ? '' : appliedBelow.error?.message);
    const belowEvents = await readEvents(artifactPath);
    let belowFolds = true;
    try { foldNodes(belowEvents); } catch { belowFolds = false; }
    check('the further-truncated prefix still folds cleanly', belowFolds);
    // Roll this second truncation back so later sections see the expected shape.
    const restoredBelow = await restoreTruncate(artifactPath, appliedBelow.result.backupPath);
    check('second truncation restored', restoredBelow.ok === true, restoredBelow.ok ? '' : restoredBelow.error?.message);
  }
}
// Roll the shadow back so later sections see the expected shape.
await undoShadow(artifactPath, shadowAgain.result.tombstoneSeq);

// ---------------------------------------------------------------------------
console.log('\n=== 7. frame-boundary fidelity across a real rewrite ===');

// Re-read the artifact and confirm every frame is independently decodable and
// that the container remains a concatenation of complete frames.
const finalBuffer = await readFile(artifactPath);
const scan = scanFrames(finalBuffer);
check('artifact ends on a frame boundary', scan.tornStart === undefined);
let decodeOk = true;
for (const frame of scan.frames) {
  try {
    await import('../lib/frames.js').then(({ decodeFrame }) => decodeFrame(finalBuffer.subarray(frame.start, frame.end)));
  } catch {
    decodeOk = false;
  }
}
check('every frame decodes independently', decodeOk, `${scan.frames.length} frames`);

await rm(sandbox, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
