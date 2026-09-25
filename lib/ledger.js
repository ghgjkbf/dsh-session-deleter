/**
 * Append-only audit ledger.
 *
 * Every mutation this plugin performs is recorded before and after it happens,
 * so a deletion can be explained (and undone, when it is still in the trash)
 * without trusting in-memory state. The file is plain JSONL: it survives a
 * crash mid-write as a truncatable tail rather than becoming unparseable.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Ledger filename inside the plugin's own state directory. */
export const LEDGER_FILENAME = 'ledger.jsonl';

/** How many trailing records a listing returns. */
const DEFAULT_TAIL = 200;

/**
 * Append one record.
 *
 * A single `appendFile` of one newline-terminated line is atomic enough for
 * this purpose on both platforms: the record either lands whole or not at all,
 * and a reader drops any unparsable trailing line.
 */
export async function record(path, entry) {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  await appendFile(path, line, 'utf8');
}

/**
 * Read the ledger tail, newest last.
 *
 * @param path - ledger file.
 * @param limit - maximum records returned.
 * @returns parsed records, dropping any malformed line.
 */
export async function tail(path, limit = DEFAULT_TAIL) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* A torn final write: skip it rather than failing the whole read. */
    }
  }
  return out.slice(-limit);
}
