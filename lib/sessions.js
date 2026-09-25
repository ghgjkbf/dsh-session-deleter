/**
 * Session inventory: what exists on disk, what the harness knows about it, and
 * whether it can be deleted right now.
 *
 * The listing is built from the filesystem rather than from the harness's
 * in-memory store, because the point of the plugin is to reach sessions the
 * store no longer tracks (a crashed run, a session from another workspace, an
 * orphaned subagent child).
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  discoverGenerations,
  projectKey,
  assertSafeSessionId,
  sessionDir,
} from './paths.js';
import { readTitle } from './title.js';
import { decodeFrame, scanFrames } from './frames.js';

/** First probe for a session header; the first frame is normally far smaller. */
const HEAD_PROBE_BYTES = 64 * 1024;

/** Ceiling for header probing, so a pathological frame cannot pull in a whole log. */
const HEAD_MAX_BYTES = 16 * 1024 * 1024;

/** Byte total of every generation in one session directory. */
async function sizeOf(generations) {
  let total = 0;
  for (const generation of generations) {
    try {
      total += (await stat(generation.path)).size;
    } catch {
      /* Raced with a write or a removal: report what is measurable. */
    }
  }
  return total;
}

/**
 * Read the immutable header of one stored session.
 *
 * The header sits on the artifact's first line inside its own frame, so only the
 * first frame's bytes are fetched — reading the whole artifact would cost a
 * multi-megabyte read for a single short line. A plaintext artifact needs no
 * decompression at all.
 *
 * Filesystem failures are absorbed here and reported as `undefined`, so an
 * unreadable or mid-append log simply drops out of the listing. Programming
 * errors are NOT absorbed: a caller that wrapped this in a bare `.catch` would
 * otherwise turn a typo into a silently empty inventory.
 *
 * @returns the decoded header, or `undefined` when it cannot be read.
 */
async function readHeader(generation) {
  let buffer;
  try {
    buffer = await readHead(generation.path, HEAD_PROBE_BYTES);
  } catch {
    return undefined;
  }

  if (generation.compression !== 'zstd') return firstJsonLine(buffer);

  // A frame may be larger than the probe, so grow until one complete frame is
  // visible. The loop terminates: the artifact's own size bounds it.
  let head;
  try {
    head = scanFrames(buffer);
    while (head.frames.length === 0 && head.tornStart !== undefined && buffer.length < HEAD_MAX_BYTES) {
      const next = Math.min(buffer.length * 4, HEAD_MAX_BYTES);
      if (next <= buffer.length) break;
      buffer = await readHead(generation.path, next);
      head = scanFrames(buffer);
    }
  } catch {
    // A torn or unrecognized container: this generation has no readable header.
    return undefined;
  }
  if (head.frames.length === 0) return undefined;

  try {
    const first = await decodeFrame(buffer.subarray(head.frames[0].start, head.frames[0].end));
    return firstJsonLine(first);
  } catch {
    return undefined;
  }
}

/**
 * Read at most `bytes` of a file without loading the rest.
 *
 * Returns the complete file when it is smaller than the probe, so the caller can
 * tell a truncated read from a complete one by comparing lengths.
 */
async function readHead(path, bytes) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Parse the first newline-terminated JSON value of a byte buffer. */
function firstJsonLine(buffer) {
  const end = buffer.indexOf(10);
  const line = (end === -1 ? buffer : buffer.subarray(0, end)).toString('utf8').trim();
  if (line.length === 0) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Enumerate every stored session under a root.
 *
 * @param root - the backend's session root directory.
 * @param options.withTitles - read each log's display title (extra I/O per session).
 * @returns one row per session directory, newest first.
 */
export async function inventory(root, options = {}) {
  const withTitles = options.withTitles !== false;
  let projectNames;
  try {
    projectNames = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { root, rows: [], projects: [] };
    throw error;
  }

  const rows = [];
  const projects = [];
  for (const projectEntry of projectNames) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = join(root, projectEntry.name);
    let sessionNames;
    try {
      sessionNames = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    let projectSessions = 0;
    for (const sessionEntry of sessionNames) {
      if (!sessionEntry.isDirectory()) continue;
      const dir = join(projectPath, sessionEntry.name);
      const generations = await discoverGenerations(dir);
      if (generations.length === 0) continue; // Not a session directory.

      const current = generations[0];

      // The directory name is a path-encoded session id; the header's own `id`
      // is authoritative, so it is preferred and the directory name is the
      // fallback for a log whose header cannot be read.
      // readHeader absorbs its own I/O failures, so no catch is needed here: a
      // genuinely thrown error means a bug, and it must surface rather than
      // silently emptying the listing.
      const header = await readHeader(current);
      const sessionId = typeof header?.id === 'string' ? header.id : undefined;
      if (sessionId === undefined) continue;
      try {
        assertSafeSessionId(sessionId);
      } catch {
        continue;
      }

      const bytes = await sizeOf(generations);
      // A title is a display nicety: an unreadable log still belongs in the list.
      const title = withTitles ? await readTitle(current.path).catch(() => undefined) : undefined;
      rows.push({
        sessionId,
        title: title ?? '',
        cwd: typeof header?.cwd === 'string' ? header.cwd : null,
        createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
        origin: header?.origin ?? null,
        parentSession: typeof header?.parentSession === 'string' ? header.parentSession : null,
        delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0,
        isSeeded: header?.isSeeded === true,
        dir,
        project: projectEntry.name,
        generations: generations.map((generation) => ({
          filename: generation.filename,
          version: generation.version,
          compression: generation.compression,
          bytes: generation.bytes ?? null,
        })),
        currentVersion: current.version,
        bytes,
        modifiedAt: await stat(dir).then((s) => s.mtimeMs).catch(() => null),
      });
      projectSessions++;
    }
    if (projectSessions > 0 || projectEntry.name.startsWith('--')) {
      projects.push({ key: projectEntry.name, sessions: projectSessions });
    }
  }

  rows.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  return { root, rows, projects };
}

/**
 * Locate the on-disk directory of a session without scanning every project.
 *
 * The header carries the session's `cwd`, which determines its project
 * directory, so a sessionId plus cwd resolves directly. A missing cwd falls
 * back to a full sweep, because guessing a project directory would be wrong
 * for every session created in another workspace.
 */
export async function locate(root, sessionId, cwd) {
  assertSafeSessionId(sessionId);
  if (typeof cwd === 'string' && cwd.length > 0) {
    const dir = sessionDir(root, cwd, sessionId);
    const generations = await discoverGenerations(dir);
    if (generations.length > 0) {
      return { dir, project: projectKey(cwd), generations };
    }
  }
  const { rows } = await inventory(root, { withTitles: false });
  const row = rows.find((candidate) => candidate.sessionId === sessionId);
  if (row === undefined) return undefined;
  return {
    dir: row.dir,
    project: row.project,
    generations: await discoverGenerations(row.dir),
    row,
  };
}

/** Total bytes held under a trash root, for reporting. */
export async function trashBytes(trashRoot) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(trashRoot, { withFileTypes: true });
  } catch {
    return { bytes: 0, count: 0 };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stack = [join(trashRoot, entry.name)];
    while (stack.length > 0) {
      const current = stack.pop();
      let children;
      try {
        children = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        const childPath = join(current, child.name);
        if (child.isDirectory()) stack.push(childPath);
        else total += await stat(childPath).then((s) => s.size).catch(() => 0);
      }
    }
  }
  return { bytes: total, count: entries.filter((entry) => entry.isDirectory).length };
}
