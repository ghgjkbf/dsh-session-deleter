/**
 * Session log path resolution and generation (v3/v4) discovery.
 *
 * Mirrors the shipped JSONL backend's own encoders exactly, so a path built here
 * is byte-identical to the one the harness reads and writes. Duplicated rather
 * than imported because those helpers are internal to the backend package.
 */

import { join } from 'node:path';
import { readdir } from 'node:fs/promises';

/** Session format generation this harness writes. */
export const CURRENT_FORMAT_VERSION = 4;

/** Encode one path segment the way the JSONL backend does. */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Build the readable project directory key for a session's cwd. */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** Project directory under the session root. */
export function projectDir(root, cwd) {
  if (cwd === undefined) return join(root, '_no-cwd');
  return join(root, projectKey(cwd));
}

/** Directory owned by one session. */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

/** Canonical generation log filename, e.g. `session.v4.jsonl.zstd`. */
export function generationLogFilename(version, compression) {
  const base = version === 0 ? 'session' : `session.v${version}`;
  return `${base}.jsonl${compression === 'zstd' ? '.zstd' : ''}`;
}

const GENERATION_NAME = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/;

/** Parse one generation log filename into `{version, compression}`. */
export function parseGenerationLogFilename(filename) {
  const m = GENERATION_NAME.exec(filename);
  if (m === null) return undefined;
  return {
    version: m[1] === undefined ? 0 : Number.parseInt(m[1], 10),
    compression: m[2] === '.zstd' ? 'zstd' : 'plain',
  };
}

/**
 * Refuse a session id that would escape its project directory.
 *
 * `encodeSegment` is total and traversal-safe by construction, so this is a
 * belt-and-braces check on the raw id before any filesystem use.
 */
export function assertSafeSessionId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('session id must be a non-empty string');
  if (id === '.' || id === '..') throw new Error(`refusing traversal-shaped session id "${id}"`);
  if (/[\\/]/.test(id)) throw new Error(`refusing session id containing a path separator: "${id}"`);
  if (id.includes('\0')) throw new Error('refusing session id containing NUL');
  return id;
}

/**
 * Discover every format generation present in one session directory.
 *
 * A directory may hold several generations at once (a migrated session keeps its
 * older file beside the current one), so deletion and rewrite must both work from
 * this list rather than assuming a single fixed filename.
 *
 * @returns generations sorted newest-version-first.
 */
export async function discoverGenerations(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const name of names) {
    const parsed = parseGenerationLogFilename(name);
    if (parsed === undefined) continue;
    found.push({ ...parsed, filename: name, path: join(dir, name) });
  }
  found.sort((a, b) => b.version - a.version);
  return found;
}
