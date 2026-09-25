// Verify the frame reader against real session logs, and prove rewrite fidelity:
// decode every frame, reassemble the logical JSONL, re-encode, and confirm the
// round trip preserves both frame count and decoded content.
import { readFile } from 'node:fs/promises';
import { readLog, writeLog, splitLines, scanFrames, decodeFrame } from '../lib/frames.js';

const paths = process.argv.slice(2);
let failures = 0;

for (const path of paths) {
  console.log(`\n=== ${path.split('\\').at(-2)} ===`);
  const buffer = await readFile(path);
  let result;
  try {
    result = await readLog(buffer);
  } catch (error) {
    console.log('  FAIL decode:', error.message);
    failures++;
    continue;
  }
  const { text, frames, tornStart } = result;
  const lines = splitLines(text.toString('utf8'));
  console.log(`  file=${buffer.length}B frames=${frames.length} logical=${text.length}B lines=${lines.length} torn=${tornStart ?? 'none'}`);

  // Every frame except possibly the last must end on a line boundary, which is
  // what makes per-batch frames self-delimiting.
  let ragged = 0;
  for (let i = 0; i < frames.length; i++) {
    const decoded = (await decodeFrame(buffer.subarray(frames[i].start, frames[i].end))).toString('utf8');
    if (!decoded.endsWith('\n') && i !== frames.length - 1) ragged++;
  }
  console.log(`  frames not ending in newline (excl. last): ${ragged}`);

  // Type census proves the logical stream is real event JSON, not noise.
  const types = new Map();
  for (const line of lines) {
    try { const e = JSON.parse(line); types.set(e.type, (types.get(e.type) ?? 0) + 1); } catch { types.set('<unparsed>', (types.get('<unparsed>') ?? 0) + 1); }
  }
  const top = [...types].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`  types: ${top}`);

  // Round trip: one frame per original frame, same plaintext, same structure.
  try {
    const batches = [];
    for (const frame of frames) batches.push(await decodeFrame(buffer.subarray(frame.start, frame.end)));
    const rebuilt = await writeLog(batches);
    const again = await readLog(rebuilt);
    const sameText = again.text.equals(text);
    const sameShape = again.frames.length === frames.length;
    const cleanTail = again.tornStart === undefined;
    console.log(`  roundtrip: text=${sameText ? 'identical' : 'DIFFERS'} frames=${frames.length}->${again.frames.length} clean=${cleanTail} bytes=${buffer.length}->${rebuilt.length}`);
    if (!sameText || !sameShape || !cleanTail) failures++;
  } catch (error) {
    console.log('  roundtrip FAIL:', error.message);
    failures++;
  }
}

console.log(`\nfailures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
