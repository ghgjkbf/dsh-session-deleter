/**
 * Atomic artifact mutation: stage beside the target, fsync, rename over it, and
 * keep a timestamped backup of the replaced bytes.
 *
 * The point is that a crash at any instant leaves either the old artifact or the
 * new one, never a half-written log. Session logs are the only copy of a
 * conversation, so the staging file is written in the target's own directory —
 * rename is only atomic within one filesystem.
 */

import { createHash, randomBytes } from 'node:crypto';
import { open, rename, rm, stat, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Suffix identifying a staged file that has not been committed yet. */
const STAGING_TOKEN = '.dshsd-tmp-';

/** Suffix prefix for the pre-mutation copy of a replaced artifact. */
const BACKUP_MARK = '.bak-';

/** Stable, sortable, filesystem-safe timestamp. */
export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** Content hash used to prove a staged artifact matches what was planned. */
export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write bytes to a staged file and flush them to stable storage.
 *
 * `fsync` on the file is what makes the following rename meaningful: without it
 * a rename can commit a directory entry that points at data the kernel has not
 * yet written, and a power loss then yields a zero-length log.
 *
 * @returns the staging path, already flushed but not yet renamed.
 */
async function stage(path, bytes) {
  const staging = join(dirname(path), `${basename(path)}${STAGING_TOKEN}${randomBytes(6).toString('hex')}`);
  const handle = await open(staging, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return staging;
}

/**
 * Flush a directory entry so the rename itself survives a power loss.
 *
 * Directories cannot be fsynced on Windows (`EPERM`/`EISDIR`), where NTFS
 * orders metadata operations sufficiently for this purpose, so the failure is
 * swallowed deliberately rather than treated as an error.
 */
async function syncDir(dir) {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    /* Windows, or a filesystem without directory fsync: the rename still stands. */
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Replace one file's contents atomically, keeping the previous bytes as a
 * timestamped sibling backup.
 *
 * @param path - artifact to replace.
 * @param bytes - complete new contents (a rewrite, never a partial patch).
 * @param options.backup - keep `<path>.bak-<stamp>` of the replaced bytes.
 * @returns the backup path when one was kept.
 */
export async function replaceFile(path, bytes, options = {}) {
  const keepBackup = options.backup !== false;
  let previous;
  try {
    previous = await readFile(path);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  let backupPath;
  if (previous !== undefined && keepBackup) {
    // The random suffix matters here too: two rewrites within the same second
    // would otherwise pick the same backup name and the second would silently
    // overwrite the first copy of the original bytes.
    backupPath = `${path}${BACKUP_MARK}${stamp()}-${randomBytes(3).toString('hex')}`;
    await replaceFileRaw(backupPath, previous);
  }

  await replaceFileRaw(path, bytes);
  return backupPath;
}

/** Commit bytes over `path` with no backup step (used for the backup itself). */
async function replaceFileRaw(path, bytes) {
  const staging = await stage(path, bytes);
  try {
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => {});
    throw error;
  }
  await syncDir(dirname(path));
}

/**
 * Move a whole directory aside into a trash root instead of unlinking it.
 *
 * Rename keeps the operation atomic and cheap regardless of log size, so an
 * 8 MB session directory costs the same as an empty one.
 *
 * @returns the trash-side path holding the directory.
 */
export async function moveAside(target, trashRoot, label) {
  const destination = join(trashRoot, `${label}-${randomBytes(6).toString('hex')}`);
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(destination), { recursive: true }));
  await rename(target, destination);
  await syncDir(dirname(target));
  return destination;
}

/** Whether a path exists as a directory. */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path exists as a regular file. */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * List the staging files a crashed run may have left behind.
 *
 * They are inert (nothing reads them) but they are litter, so dry-run reporting
 * surfaces them and explicit deletion removes them.
 */
export async function findStagingLitter(dir) {
  const { readdir } = await import('node:fs/promises');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.includes(STAGING_TOKEN)).map((name) => join(dir, name));
}
