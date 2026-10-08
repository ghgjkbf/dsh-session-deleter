/**
 * Message-level deletion: shadowing (line A) and tail truncation (line B).
 *
 * Both operations exist because a session log is append-only and the surface
 * derived from it has exactly two legal mutations:
 *
 * - **Shadow (reversible, append-only).** A `developer/message` tombstone event
 *   with empty content replaces one live surface node. The backend's own fold
 *   (`foldSurface`) shadows the replaced range, `deriveEventMessage` derives
 *   the tombstone to no LLM message at all, and the shipped transcript keeps
 *   the original row because it is built from append-origin events only.
 *   Nothing existing is rewritten — the tombstone is one appended frame, so
 *   the log stays append-only end to end and undo is deleting the tail frames
 *   that hold the tombstone.
 *
 * - **Truncate (line B, rewritable via backups).** Dropping a whole tail of
 *   the log down to a chosen seq removes both model content and transcript
 *   rows. The artifact is rebuilt from its surviving prefix, byte-for-byte
 *   identical up to the cut, with the replaced tail kept as a timestamped
 *   backup for an explicit restore.
 *
 * Both refuse to touch a log that is not at rest: an append mid-rewrite would
 * either be lost or land after a shorter log.
 */

import { readFile } from 'node:fs/promises';

import { readLog, writeLog, scanFrames, splitLines } from './frames.js';
import { replaceFile } from './atomic.js';
import { foldNodes, tombstoneFor } from './shadow-fold.js';

/** Event types the shadow planner offers for deletion. */
export const SHADOWABLE_TYPES = new Set(['user/message', 'assistant/message', 'developer/message', 'system/message']);

/**
 * Read the current generation artifact into events plus frame map.
 *
 * @returns `{ text, events, frames, tornStart }`; `events` holds every parsed
 *   line in seq order, `frames[i]` is the frame range holding line i.
 */
async function readArtifact(path) {
  const buffer = await readFile(path);
  const { text, frames, tornStart } = await readLog(buffer);
  const lines = splitLines(text.toString('utf8'));
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`${path}: a log line is not valid JSON`);
    }
  }
  if (tornStart !== undefined) {
    throw new Error(`${path}: the artifact ends in an incomplete frame; the backend must repair it before any message operation`);
  }
  return { buffer, text, events, frames, tornStart };
}

/**
 * Map one line index to the frame index holding it.
 *
 * Frames end on batch boundaries and never split a line, so the line's byte
 * offset lands inside exactly one frame.
 */
function frameOfLine(frames, text, lineIndex) {
  // Byte offset of the line's start: sum the lengths of the lines before it.
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    offset += Buffer.byteLength(splitLineAt(text, i), 'utf8');
  }
  for (let f = 0; f < frames.length; f++) {
    const { start, end } = frames[f];
    if (offset >= start && offset < end) return f;
  }
  return frames.length; // beyond the last frame: impossible for a parsed line
}

function splitLineAt(text, index) {
  let start = 0;
  for (let i = 0; i < index; i++) {
    const newline = text.indexOf(10, start);
    if (newline === -1) return '';
    start = newline + 1;
  }
  const newline = text.indexOf(10, start);
  return newline === -1 ? text.slice(start) : text.slice(start, newline + 1);
}

/**
 * Plan a shadow: everything a dry-run shows, nothing written.
 *
 * @param path - current generation artifact.
 * @param seq - the surface node to shadow.
 * @returns `{ ok, plan }` or `{ ok: false, error: { code, message } }`.
 */
export async function planShadow(path, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return { ok: false, error: { code: 'bad-seq', message: 'seq must be a non-negative integer' } };
  }
  let artifact;
  try {
    artifact = await readArtifact(path);
  } catch (error) {
    return { ok: false, error: { code: 'unreadable', message: error.message } };
  }
  const { events } = artifact;
  const target = events.find((event) => event.seq === seq);
  if (target === undefined) {
    return { ok: false, error: { code: 'not-found', message: `no event at seq ${seq}` } };
  }
  if (!SHADOWABLE_TYPES.has(target.type)) {
    return {
      ok: false,
      error: { code: 'not-shadowable', message: `seq ${seq} is "${target.type}"; only user/assistant/developer/system messages can be shadowed` },
    };
  }
  if (isAppendSurfaceEvent(target) === false) {
    return {
      ok: false,
      error: { code: 'already-replaced', message: `seq ${seq} is itself a replacement copy; shadow its append-origin node instead` },
    };
  }

  let fold;
  try {
    fold = foldNodes(events);
  } catch (error) {
    return { ok: false, error: { code: 'fold-failed', message: error.message } };
  }
  if (!fold.nodes.includes(seq)) {
    return {
      ok: false,
      error: { code: 'already-shadowed', message: `seq ${seq} is already shadowed by seq ${fold.shadowedBy.get(seq) ?? '?'}` },
    };
  }

  // A replacement tombstone becomes the surface's tail node; it must land at
  // max(seq)+1 for every sequenced event. The `session` header record carries
  // no seq and is excluded — folding it into Math.max would yield NaN, which
  // serializes to null and would poison the tombstone.
  let maxSeq = -1;
  for (const event of events) {
    if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq > maxSeq) {
      maxSeq = event.seq;
    }
  }
  const tombstoneSeq = maxSeq + 1;
  const tombstone = tombstoneFor(target, tombstoneSeq, Date.now());

  const after = foldNodes([...events, tombstone]);
  return {
    ok: true,
    plan: {
      kind: 'shadow',
      path,
      target: { seq, type: target.type },
      tombstoneSeq,
      shadowedCount: fold.nodes.length - after.nodes.length,
      nodesBefore: fold.nodes.length,
      nodesAfter: after.nodes.length,
      bytesBefore: artifact.buffer.length,
      reversible: true,
    },
  };
}

function isAppendSurfaceEvent(event) {
  return event.surfaceOp === 'append';
}

/**
 * Append one tombstone frame and record it in the marker file.
 *
 * The marker file (`shadow-markers.json`, one line of JSON per shadow) is
 * what makes undo possible without trusting a scan of the log: each entry
 * names the artifact, the tombstone's seq, and the byte offset the artifact
 * had before the append.
 */
export async function applyShadow(path, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return { ok: false, error: { code: 'bad-seq', message: 'seq must be a non-negative integer' } };
  }
  let artifact;
  try {
    artifact = await readArtifact(path);
  } catch (error) {
    return { ok: false, error: { code: 'unreadable', message: error.message } };
  }
  const { buffer, events } = artifact;
  const target = events.find((event) => event.seq === seq);
  if (target === undefined) {
    return { ok: false, error: { code: 'not-found', message: `no event at seq ${seq}` } };
  }
  if (!SHADOWABLE_TYPES.has(target.type)) {
    return {
      ok: false,
      error: { code: 'not-shadowable', message: `seq ${seq} is "${target.type}"; only user/assistant/developer/system messages can be shadowed` },
    };
  }
  if (isAppendSurfaceEvent(target) === false) {
    return {
      ok: false,
      error: { code: 'already-replaced', message: `seq ${seq} is itself a replacement copy; shadow its append-origin node instead` },
    };
  }

  let fold;
  try {
    fold = foldNodes(events);
  } catch (error) {
    return { ok: false, error: { code: 'fold-failed', message: error.message } };
  }
  if (!fold.nodes.includes(seq)) {
    return {
      ok: false,
      error: { code: 'already-shadowed', message: `seq ${seq} is already shadowed by seq ${fold.shadowedBy.get(seq) ?? '?'}` },
    };
  }

  let maxSeq = -1;
  for (const event of events) {
    if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq > maxSeq) {
      maxSeq = event.seq;
    }
  }
  const tombstoneSeq = maxSeq + 1;
  const tombstone = tombstoneFor(target, tombstoneSeq, Date.now());

  const { encodeFrame } = await import('./frames.js');
  const frame = await encodeFrame(Buffer.from(`${JSON.stringify(tombstone)}\n`, 'utf8'));
  const bytesBefore = buffer.length;
  const updated = Buffer.concat([buffer, frame]);

  const markerFile = markerPath(path);
  const markers = await readMarkers(markerFile);
  await replaceFile(path, updated, { backup: false });
  await writeMarkers(markerFile, [...markers, {
    artifact: path,
    tombstoneSeq,
    targetSeq: seq,
    targetBytes: bytesBefore,
    at: new Date().toISOString(),
  }]);

  return {
    ok: true,
    result: {
      kind: 'shadow',
      targetSeq: seq,
      tombstoneSeq,
      bytesBefore,
      bytesAfter: updated.length,
      reversible: true,
    },
  };
}

/** Marker file beside the log, named after the generation. */
function markerPath(artifactPath) {
  return `${artifactPath}.shadow-markers.json`;
}

async function readMarkers(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeMarkers(path, markers) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(markers, null, 1)}\n`, 'utf8');
}

/**
 * Undo one shadow: truncate the artifact back to the bytes it had before the
 * tombstone frame was appended, then drop the marker.
 *
 * Only the exact tombstone this plugin appended is removable — the marker's
 * `targetBytes` must still match the artifact's current length up to the
 * tombstone, otherwise the log moved on and undo is refused.
 */
export async function undoShadow(path, tombstoneSeq) {
  const markerFile = markerPath(path);
  const markers = await readMarkers(markerFile);
  const entry = markers.find((marker) => marker.tombstoneSeq === tombstoneSeq && marker.artifact === path);
  if (entry === undefined) {
    return { ok: false, error: { code: 'not-found', message: `no shadow marker for tombstone seq ${tombstoneSeq} on this artifact` } };
  }

  const buffer = await readFile(path);
  const { frames } = scanFrames(buffer);
  if (frames.length === 0) {
    return { ok: false, error: { code: 'unreadable', message: 'the artifact holds no complete frame' } };
  }
  // Locate the frame holding the tombstone event.
  const { text } = await readLog(buffer);
  const lines = splitLines(text.toString('utf8'));
  let tombstoneFrame = -1;
  let lineOffset = 0;
  let frameIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf8');
    while (frameIndex < frames.length - 1 && lineOffset >= frames[frameIndex].end) frameIndex++;
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      event = {};
    }
    if (event.seq === tombstoneSeq) {
      tombstoneFrame = frameIndex;
      break;
    }
    lineOffset += lineBytes;
  }
  if (tombstoneFrame === -1) {
    return { ok: false, error: { code: 'not-found', message: `the log no longer contains seq ${tombstoneSeq}` } };
  }
  if (frames[tombstoneFrame].start !== entry.targetBytes) {
    return {
      ok: false,
      error: { code: 'moved-on', message: `the log grew or changed since the shadow (marker said ${entry.targetBytes}, tombstone frame starts at ${frames[tombstoneFrame].start}); undo refused` },
    };
  }

  const restored = buffer.subarray(0, entry.targetBytes);
  await replaceFile(path, restored, { backup: false });
  await writeMarkers(markerFile, markers.filter((marker) => marker !== entry));
  return {
    ok: true,
    result: { kind: 'unshadow', tombstoneSeq, bytesAfter: restored.length, reversible: false },
  };
}

// ---------------------------------------------------------------------------
// Line B: tail truncation.
// ---------------------------------------------------------------------------

/**
 * Plan a truncation: what survives, what a restore would put back.
 *
 * @param path - current generation artifact.
 * @param throughSeq - every event with `seq > throughSeq` is removed.
 */
export async function planTruncate(path, throughSeq) {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
    return { ok: false, error: { code: 'bad-seq', message: 'throughSeq must be a non-negative integer' } };
  }
  let artifact;
  try {
    artifact = await readArtifact(path);
  } catch (error) {
    return { ok: false, error: { code: 'unreadable', message: error.message } };
  }
  const { events, buffer } = artifact;
  const removed = events.filter((event) => event.seq > throughSeq);
  if (removed.length === 0) {
    return { ok: false, error: { code: 'nothing-to-truncate', message: `no event exceeds seq ${throughSeq}` } };
  }
  const kept = events.filter((event) => event.seq <= throughSeq);
  // The kept prefix must itself be a legal surface: a tombstone that shadowed
  // a node the truncation removes would leave a dangling replacement.
  try {
    foldNodes(kept);
  } catch (error) {
    return { ok: false, error: { code: 'would-dangle', message: `truncating at seq ${throughSeq} leaves a replacement without its target: ${error.message}` } };
  }
  const lastKept = kept[kept.length - 1];
  const lastKeptFrame = lastKept !== undefined ? frameOfLine(artifact.frames, artifact.text, kept.length - 1) : -1;
  return {
    ok: true,
    plan: {
      kind: 'truncate',
      path,
      throughSeq,
      removedCount: removed.length,
      keptCount: kept.length,
      keptBytes: lastKeptFrame >= 0 ? artifact.frames[lastKeptFrame].end : 0,
      bytesBefore: buffer.length,
      removedTypes: Object.entries(removed.reduce((acc, event) => {
        acc[event.type] = (acc[event.type] ?? 0) + 1;
        return acc;
      }, {})),
      reversible: true,
    },
  };
}

/**
 * Rebuild the artifact from its surviving prefix, keeping the removed tail as
 * a `.bak-<stamp>` backup beside it.
 *
 * The rebuild writes each surviving batch as its own frame, so the container
 * shape stays one-frame-per-batch. The backup holds the exact replaced bytes,
 * which is what restore puts back.
 */
export async function applyTruncate(path, throughSeq) {
  const planned = await planTruncate(path, throughSeq);
  if (planned.ok !== true) return planned;
  const { plan } = planned;

  // Rebuild from the kept lines rather than cutting bytes: one frame holds a
  // whole batch of lines, so a byte cut at the last kept frame boundary would
  // keep lines beyond the cut. Kept lines are grouped back into their
  // original batches (a frame boundary never splits a line, so line byte
  // offsets resolve to exactly one frame), and each surviving batch becomes
  // one new frame — the container shape is preserved end to end.
  const artifact = await readArtifact(path);
  const { text } = artifact;
  const allLines = splitLines(text.toString('utf8'));

  // Byte offset of each line start; frames are byte ranges over the same text.
  const lineOffsets = [];
  let cursor = 0;
  for (const line of allLines) {
    lineOffsets.push(cursor);
    cursor += Buffer.byteLength(line, 'utf8');
  }
  const frameOfLineIndex = (lineIndex) => {
    const start = lineOffsets[lineIndex];
    for (let f = 0; f < artifact.frames.length; f++) {
      if (start >= artifact.frames[f].start && start < artifact.frames[f].end) return f;
    }
    return artifact.frames.length;
  };

  // Collect kept lines, remembering their frame index.
  const kept = [];
  for (let i = 0; i < allLines.length; i++) {
    let event;
    try {
      event = JSON.parse(allLines[i]);
    } catch {
      break;
    }
    if (typeof event.seq === 'number' && event.seq > throughSeq) break;
    kept.push({ line: allLines[i], frame: frameOfLineIndex(i) });
  }
  // Group consecutive kept lines by frame: each group is one original batch.
  const batches = [];
  let current = [];
  let currentFrame = -1;
  for (const entry of kept) {
    if (currentFrame !== -1 && entry.frame !== currentFrame) {
      batches.push(Buffer.from(current.join(''), 'utf8'));
      current = [];
    }
    current.push(entry.line);
    currentFrame = entry.frame;
  }
  if (current.length > 0) batches.push(Buffer.from(current.join(''), 'utf8'));

  const rebuilt = await writeLog(batches);
  const backupPath = await replaceFile(path, rebuilt, { backup: true });
  return {
    ok: true,
    result: {
      kind: 'truncate',
      throughSeq,
      removedCount: plan.removedCount,
      bytesBefore: plan.bytesBefore,
      bytesAfter: rebuilt.length,
      backupPath,
      reversible: true,
    },
  };
}

/**
 * Put a truncation backup back.
 *
 * The backup is the exact byte range the artifact held before the cut, so
 * restore is a byte-exact replacement. Restore is refused unless the current
 * artifact is still the truncated prefix — any append or change since the
 * cut means real turns now exist that restore would silently discard. The
 * check compares against the artifact's recorded post-cut length (returned
 * by applyTruncate in its result and carried by the caller), so the caller
 * passes `expectedBytes`; a mismatch of any kind refuses. The backup file is
 * consumed (removed) on success so a second restore cannot happen.
 */
export async function restoreTruncate(path, backupPath, expectedBytes) {
  const backup = await readFile(backupPath);
  const current = await readFile(path);
  if (expectedBytes !== undefined) {
    if (current.length !== expectedBytes) {
      return {
        ok: false,
        error: { code: 'moved-on', message: `the artifact is no longer the truncated prefix (${current.length} B now vs ${expectedBytes} B expected); restore refused` },
      };
    }
  } else if (current.length >= backup.length) {
    // No expected length supplied: fall back to the weaker structural check —
    // the current artifact must be shorter than what restore would write.
    return {
      ok: false,
      error: { code: 'moved-on', message: `the artifact is not shorter than the backup (${current.length} B now vs ${backup.length} B restored); restore refused` },
    };
  }
  await replaceFile(path, backup, { backup: false });
  const { rm } = await import('node:fs/promises');
  await rm(backupPath, { force: true });
  return {
    ok: true,
    result: { kind: 'restore-truncate', bytesAfter: backup.length, reversible: false },
  };
}
