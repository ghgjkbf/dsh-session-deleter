// Frame-accurate reader/writer for the shipped session-log container.
//
// The artifact is NOT one Zstandard stream: it is a concatenation of
// independently decodable, checksummed frames, one per durable batch. Appending
// is therefore `write another frame`, and any rewrite MUST reproduce the same
// container shape — a single recompressed stream would decode to the right bytes
// but stop matching what the backend's own structural scanner expects on the
// next append.
//
// Frame header layout (Zstandard RFC 8878, and the shipped scanner's reading of
// it): 4-byte magic, 1 descriptor byte, a single-segment flag, an optional
// 1-byte window descriptor, up to 4 dictionary-id bytes, 0-8 content-size bytes,
// then blocks of (3-byte header + payload) until the last-block bit, then an
// optional 4-byte checksum.
import { zstdCompress, zstdDecompress } from 'node:zlib';
import { constants } from 'node:zlib';
import { promisify } from 'node:util';

const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);

/** Little-endian reading of the Zstandard magic number `0xFD2FB528`. */
const ZSTD_MAGIC = 4247762216;

/** Frames carry a content checksum, matching the backend's own writer. */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/**
 * Locate every complete frame without decompressing any block.
 *
 * A trailing truncated frame is reported as `tornStart` rather than throwing: a
 * process killed mid-append leaves exactly that, and the backend repairs it the
 * same way, so this plugin must not treat it as corruption.
 *
 * @param buffer - complete bytes currently present in the artifact.
 * @returns complete frame ranges plus the start of an incomplete final frame.
 */
export function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** Decode one complete frame, validating its checksum. */
export async function decodeFrame(bytes) {
  return zstdDecompressAsync(bytes);
}

/**
 * Read an artifact into its logical JSONL bytes.
 *
 * @returns the concatenated plaintext, plus the frame ranges it came from.
 */
export async function readLog(buffer) {
  const { frames, tornStart } = scanFrames(buffer);
  const parts = [];
  for (const frame of frames) {
    parts.push(await decodeFrame(buffer.subarray(frame.start, frame.end)));
  }
  return { text: Buffer.concat(parts), frames, tornStart };
}

/** Encode one plaintext batch as its own independently decodable frame. */
export async function encodeFrame(input) {
  return zstdCompressAsync(input, CHECKSUM_OPTIONS);
}

/**
 * Rebuild an artifact from logical JSONL, preserving the one-frame-per-batch
 * container shape.
 *
 * @param batches - plaintext batches, each becoming exactly one frame. An empty
 *   batch is dropped: a zero-length frame would carry no event and only add
 *   bytes for the scanner to walk.
 * @returns the complete artifact bytes.
 */
export async function writeLog(batches) {
  const frames = [];
  for (const batch of batches) {
    if (batch.length === 0) continue;
    frames.push(await encodeFrame(batch));
  }
  return Buffer.concat(frames);
}

/**
 * Split logical JSONL text into whole lines, keeping the trailing newline
 * convention the backend writes (every line, including the last, is terminated).
 *
 * @returns one entry per non-empty line, each already newline-terminated.
 */
export function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}
