// Determine the exact physical layout of a session log: how many zstd frames,
// where each boundary is, and whether the concatenation decodes to clean JSONL.
// Read-only.
import { readFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
const buf = await readFile(path);
console.log('file bytes:', buf.length);

// A frame boundary is the minimal prefix length at which a fresh decoder
// succeeds: one byte shorter is a truncated frame and throws. Binary search
// finds it exactly, without trusting magic-byte scanning (which false-positives
// inside compressed payloads).
function frameEnd(offset) {
  const tail = buf.subarray(offset);
  let reference;
  try {
    reference = zstdDecompressSync(tail);
  } catch {
    return undefined; // truncated tail: the last frame is incomplete
  }
  let lo = 1;
  let hi = tail.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const out = zstdDecompressSync(tail.subarray(0, mid));
      ok = out.equals(reference);
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { end: offset + lo, bytes: reference };
}

const frames = [];
let offset = 0;
let total = 0;
while (offset < buf.length) {
  const found = frameEnd(offset);
  if (found === undefined) {
    console.log(`truncated frame at offset ${offset} (${buf.length - offset} bytes remain)`);
    break;
  }
  frames.push({ start: offset, end: found.end, size: found.end - offset, bytes: found.bytes.length });
  total += found.bytes.length;
  offset = found.end;
  if (frames.length > 5000) { console.log('frame budget reached'); break; }
}

console.log('frames:', frames.length, 'decoded bytes total:', total, 'consumed all:', offset === buf.length);
console.log('first 8 frames:', frames.slice(0, 8).map((f) => `${f.size}->${f.bytes}`).join(' '));
console.log('last 3 frames:', frames.slice(-3).map((f) => `${f.size}->${f.bytes}`).join(' '));

// Reassemble and validate the logical stream.
const parts = [];
let off = 0;
for (const f of frames) {
  parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)));
  off = f.end;
}
const text = Buffer.concat(parts).toString('utf8');
const lines = text.split('\n');
console.log('reassembled bytes:', Buffer.byteLength(text), 'lines:', lines.filter((l) => l.length > 0).length);
console.log('ends with newline:', text.endsWith('\n'));

// Every frame must decode to whole lines except possibly the last.
let ragged = 0;
for (let i = 0; i < frames.length; i++) {
  const s = zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString('utf8');
  const whole = s.endsWith('\n');
  if (!whole && i !== frames.length - 1) ragged++;
}
console.log('frames not ending in a newline (excluding last):', ragged);

// Event type census.
const types = new Map();
for (const line of lines) {
  if (!line) continue;
  try { const e = JSON.parse(line); types.set(e.type, (types.get(e.type) ?? 0) + 1); } catch {}
}
console.log('event types:', [...types].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}:${v}`).join(' '));
