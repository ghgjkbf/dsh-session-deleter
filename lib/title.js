/**
 * Read a session's display title straight from its log.
 *
 * Titles live under `event.data.title` on a `session/title` event, which the
 * harness emits *after* the first user turn — so a reader that stops at the first
 * user message never sees the real title. Worse, the first user/message events in
 * a session are injected context (runtime snapshots, skill lists, workspace
 * instructions) rather than anything a human typed, so the fallback must filter on
 * `data.source.kind === 'user'`.
 *
 * Decoding is incremental: each frame is consumed as it is decoded and its text is
 * discarded, so a log with thousands of frames costs one pass rather than a
 * quadratic rebuild of the accumulated text. A multi-megabyte log therefore costs
 * about the same per frame as a small one, and the scan stops as soon as the line
 * budget is spent.
 *
 * Decoding goes through the frame-aware reader because the artifact is a
 * concatenation of independent Zstandard frames: feeding it to a streaming
 * decoder stops at the first frame boundary.
 */

import { readFile } from 'node:fs/promises';
import { decodeFrame, readLog, scanFrames, splitLines } from './frames.js';

/** Longest title kept. */
const TITLE_MAX = 80;

/** Line budget before a title search gives up. */
const LINE_BUDGET = 2000;

/**
 * Longest single line tolerated while reassembling a batch boundary.
 *
 * JSONL lines are far smaller than this; the bound only stops a log with no
 * newline at all from accumulating without limit.
 */
const LINE_MAX = 1 << 20;

/** Collapse a raw prompt into one trimmed display line. */
function normalize(value) {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_MAX) return flat;
  return `${flat.slice(0, TITLE_MAX - 1)}…`;
}

/** Read `data.title` from a `session/title` event, tolerating shape drift. */
function titleOf(event) {
  const data = event?.data;
  if (typeof data?.title === 'string' && data.title.trim().length > 0) return data.title;
  if (typeof event?.title === 'string' && event.title.trim().length > 0) return event.title;
  return undefined;
}

/**
 * Read the first text block of a genuine user message.
 *
 * Injected context arrives as `user/message` too, so `source.kind` is the
 * discriminator: only `'user'` marks something the human actually submitted.
 */
function userPromptOf(event) {
  const data = event?.data;
  if (data?.source?.kind !== 'user') return undefined;
  const content = data?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === 'string' && part.text.trim().length > 0) return part.text;
      if (typeof part === 'string' && part.trim().length > 0) return part;
    }
  }
  return undefined;
}

/** Fold one log line into the running title scan. */
function absorbLine(scan, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === 'session/title') {
    const title = titleOf(event);
    // The last title wins: a provider-generated title supersedes the fallback
    // one the harness writes earlier in the same log.
    if (title !== undefined) scan.best = normalize(title);
  } else if (scan.fallback === undefined && event.type === 'user/message') {
    const prompt = userPromptOf(event);
    if (prompt !== undefined) scan.fallback = normalize(prompt);
  }
}

/**
 * Build a line consumer that keeps only the unterminated tail between pushes.
 *
 * Frames end on batch boundaries, not necessarily on newlines, so one line can
 * straddle two frames. Holding just that fragment — never the consumed text — is
 * what keeps the scan linear.
 */
function makeLineConsumer(scan) {
  let pending = '';
  const consumer = {
    stopped: false,
    push(text) {
      if (consumer.stopped) return;
      pending += text;
      let start = 0;
      for (;;) {
        const newline = pending.indexOf('\n', start);
        if (newline === -1) break;
        const line = pending.slice(start, newline);
        start = newline + 1;
        if (line.length === 0) continue;
        if (++scan.seen > LINE_BUDGET) {
          consumer.stopped = true;
          return;
        }
        absorbLine(scan, line);
      }
      pending = pending.slice(start);
      if (pending.length > LINE_MAX) {
        if (++scan.seen > LINE_BUDGET) {
          consumer.stopped = true;
          return;
        }
        absorbLine(scan, pending);
        pending = '';
      }
    },
    /** Consume a trailing line the artifact never terminated with a newline. */
    flush() {
      if (consumer.stopped || pending.length === 0) return;
      const line = pending;
      pending = '';
      if (++scan.seen > LINE_BUDGET) {
        consumer.stopped = true;
        return;
      }
      absorbLine(scan, line);
    },
  };
  return consumer;
}

/**
 * Scan one session log for its display title.
 *
 * @param path - the generation artifact to read.
 * @returns the title, or `undefined` when the log holds no usable text.
 */
export async function readTitle(path) {
  const buffer = await readFile(path);
  const scan = { seen: 0, fallback: undefined, best: undefined };
  const consumer = makeLineConsumer(scan);

  if (path.endsWith('.zstd') || path.endsWith('.gz')) {
    // Frame-aware: a concatenated container cannot be fed to a stream decoder.
    const { frames } = scanFrames(buffer);
    for (const frame of frames) {
      const text = (await decodeFrame(buffer.subarray(frame.start, frame.end))).toString('utf8');
      consumer.push(text);
      if (consumer.stopped) return scan.best ?? scan.fallback;
    }
  } else {
    const { text } = await readLog(buffer);
    consumer.push(text.toString('utf8'));
  }

  consumer.flush();
  return scan.best ?? scan.fallback;
}

/** Extract only the title events of one log, for diagnostics. */
export async function titleEvents(path) {
  const buffer = await readFile(path);
  const { text } = await readLog(buffer);
  const out = [];
  for (const line of splitLines(text.toString('utf8'))) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'session/title') out.push(event.data);
  }
  return out;
}
