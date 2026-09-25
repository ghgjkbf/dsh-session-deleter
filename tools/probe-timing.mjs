// Time each stage of the inventory pipeline against the real session tree, so
// the fix targets the measured bottleneck rather than a guessed one.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { discoverGenerations } from '../lib/paths.js';
import { scanFrames, decodeFrame } from '../lib/frames.js';
import { readTitle } from '../lib/title.js';

const root = process.argv[2];
if (root === undefined) {
  console.error('usage: node tools/probe-timing.mjs <sessionRoot>');
  process.exit(2);
}

const marks = new Map();
const time = async (label, fn) => {
  const started = performance.now();
  const value = await fn();
  const elapsed = performance.now() - started;
  marks.set(label, (marks.get(label) ?? 0) + elapsed);
  return value;
};

const targets = [];
for (const projectEntry of await readdir(root, { withFileTypes: true })) {
  if (!projectEntry.isDirectory()) continue;
  const projectPath = join(root, projectEntry.name);
  for (const sessionEntry of await readdir(projectPath, { withFileTypes: true }).catch(() => [])) {
    if (!sessionEntry.isDirectory()) continue;
    const dir = join(projectPath, sessionEntry.name);
    const generations = await discoverGenerations(dir);
    if (generations.length === 0) continue;
    targets.push({ dir, current: generations[0], generations });
  }
}

console.log(`sessions: ${targets.length}\n`);

let frameCount = 0;
let totalBytes = 0;

for (const target of targets) {
  const { current } = target;

  const bytes = await time('stat-sizes', async () => {
    let total = 0;
    for (const generation of target.generations) {
      total += await stat(generation.path).then((s) => s.size).catch(() => 0);
    }
    return total;
  });
  totalBytes += bytes;

  // Stage 1: read the whole file (what readHeader currently does).
  const buffer = await time('readFile-whole', () => readFile(current.path));

  // Stage 2: locate every frame.
  const frameInfo = await time('scanFrames', () => scanFrames(buffer));
  frameCount += frameInfo.frames.length;

  // Stage 3: decode only the first frame (what readHeader actually needs).
  await time('decode-first-frame', () =>
    decodeFrame(buffer.subarray(frameInfo.frames[0].start, frameInfo.frames[0].end)));

  // Stage 4: decode every frame (what readTitle currently does).
  await time('decode-all-frames', async () => {
    const parts = [];
    for (const frame of frameInfo.frames) {
      parts.push(await decodeFrame(buffer.subarray(frame.start, frame.end)));
    }
    return parts.length;
  });

  // Stage 5: the O(n^2) join the current readTitle performs per frame.
  await time('readTitle-as-shipped', () => readTitle(current.path));
}

console.log('=== per-stage cumulative milliseconds ===');
for (const [label, ms] of [...marks.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${label.padEnd(22)} ${ms.toFixed(1).padStart(9)} ms`);
}
console.log(`\nfiles: ${targets.length}  frames: ${frameCount}  bytes: ${(totalBytes / 1048576).toFixed(2)} MiB`);
console.log(`avg frames per file: ${(frameCount / targets.length).toFixed(0)}`);
