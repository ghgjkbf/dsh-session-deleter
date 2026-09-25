/**
 * Self-managed recycle bin.
 *
 * Deleted session directories are renamed into a trash root paired with a JSON
 * manifest entry recording what was moved, so a restore is a rename back and an
 * explicit purge is the only step that touches the bytes irreversibly.
 *
 * A private trash root is used rather than the OS recycle bin: the OS bin gives
 * no per-item manifest, its restore is interactive, and reaching it means
 * shelling out to a COM/VisualBasic API, none of which can be verified or
 * rolled back from inside the plugin.
 */

import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stamp } from './atomic.js';

/** Trash root name under the harness home, beside `sessions`. */
export const TRASH_DIR_NAME = 'session-trash';

/** Manifest listing every entry currently held. */
const MANIFEST = 'manifest.json';

/** One recorded deletion. */
const ENTRY_SCHEMA_KEYS = ['id', 'sessionId', 'title', 'cwd', 'deletedAt', 'from', 'held', 'bytes', 'generations'];

/** Absolute path of the manifest for one trash root. */
function manifestPath(trashRoot) {
  return join(trashRoot, MANIFEST);
}

/**
 * Read the manifest, tolerating absence and refusing to guess at corruption.
 *
 * A corrupt manifest is reported as empty-with-an-error rather than thrown: the
 * held directories are still on disk and a partial listing must not hide them,
 * but the caller needs to know restore metadata is unavailable.
 */
export async function readManifest(trashRoot) {
  let raw;
  try {
    raw = await readFile(manifestPath(trashRoot), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { entries: [], corrupt: false };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return { entries: entries.filter(isEntry), corrupt: false };
  } catch {
    return { entries: [], corrupt: true };
  }
}

/** Accept only well-formed manifest rows, dropping anything else silently. */
function isEntry(value) {
  if (typeof value !== 'object' || value === null) return false;
  return ENTRY_SCHEMA_KEYS.every((key) => key in value);
}

/** Write the manifest durably (a temp file plus rename, so it is never half-written). */
async function writeManifest(trashRoot, entries) {
  await mkdir(trashRoot, { recursive: true });
  const path = manifestPath(trashRoot);
  const staging = `${path}.tmp`;
  await writeFile(staging, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
  await rename(staging, path);
}

/**
 * Move one session directory into the trash and record it.
 *
 * @param options.trashRoot - trash root to hold the directory.
 * @param options.dir - the session directory being removed.
 * @param options.sessionId - the session the directory belongs to.
 * @param options.title - display title captured at deletion time.
 * @param options.cwd - the session's project directory.
 * @param options.bytes - total size at deletion time, for reporting.
 * @param options.generations - generation filenames that were present.
 * @returns the recorded entry.
 */
export async function hold({ trashRoot, dir, sessionId, title, cwd, bytes, generations }) {
  await mkdir(trashRoot, { recursive: true });
  // A random suffix keeps two deletions in the same second from colliding:
  // the timestamp is what a human reads, the suffix is what guarantees
  // uniqueness.
  const id = `${stamp()}-${randomBytes(3).toString('hex')}-${sessionId}`;
  const held = join(trashRoot, id);
  await rename(dir, held);

  const entry = {
    id,
    sessionId,
    title: title ?? '',
    cwd: cwd ?? null,
    deletedAt: new Date().toISOString(),
    from: dir,
    held,
    bytes: bytes ?? 0,
    generations: generations ?? [],
  };

  const { entries } = await readManifest(trashRoot);
  entries.push(entry);
  await writeManifest(trashRoot, entries);
  return entry;
}

/**
 * Put one held directory back where it came from.
 *
 * @returns the restored path.
 * @throws when the original parent has meanwhile gained a directory of the same
 *   name, which would mean restoring would overwrite a live session.
 */
export async function restore(trashRoot, id) {
  const { entries } = await readManifest(trashRoot);
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no trash entry "${id}"`);

  await mkdir(join(entry.from, '..'), { recursive: true });

  // Check the destination before renaming. Windows answers a rename onto an
  // existing directory with a bare `EPERM` — indistinguishable from a real
  // permission failure — so the occupied case is detected up front instead of
  // being inferred from an ambiguous error code.
  if (await exists(entry.from)) {
    throw new Error(`refusing to restore "${id}": "${entry.from}" already exists`);
  }

  try {
    await rename(entry.held, entry.from);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY' || error.code === 'EPERM')) {
      throw new Error(`refusing to restore "${id}": "${entry.from}" already exists`);
    }
    throw error;
  }

  const remaining = entries.filter((candidate) => candidate.id !== id);
  await writeManifest(trashRoot, remaining);
  return entry.from;
}

/** Whether a path exists at all. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Permanently remove one held directory.
 *
 * This is the only irreversible step in the plugin, so it names its target in
 * the error path rather than failing anonymously.
 */
export async function purge(trashRoot, id) {
  const { entries } = await readManifest(trashRoot);
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no trash entry "${id}"`);
  await rm(entry.held, { recursive: true, force: true });
  const remaining = entries.filter((candidate) => candidate.id !== id);
  await writeManifest(trashRoot, remaining);
  return entry;
}

/**
 * Reconcile the manifest against what is actually held.
 *
 * A crash between `rename` and the manifest write leaves an unlisted directory;
 * a crash mid-purge leaves a listed but absent one. Reporting both lets the UI
 * show the true contents instead of a stale list.
 */
export async function reconcile(trashRoot) {
  const { entries, corrupt } = await readManifest(trashRoot);
  let present = [];
  try {
    present = await readdir(trashRoot);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const heldNames = new Set(present);
  const listed = new Set(entries.map((entry) => entry.id));
  return {
    corrupt,
    entries,
    orphans: present.filter((name) => name !== MANIFEST && !listed.has(name)),
    missing: entries.filter((entry) => !heldNames.has(entry.id)).map((entry) => entry.id),
  };
}
