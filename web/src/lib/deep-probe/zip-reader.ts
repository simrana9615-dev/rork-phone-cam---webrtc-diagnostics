/**
 * Dependency-free ZIP reader — the other half of `zip-writer.ts`.
 *
 * This exists so a Deep Probe archive can be opened again inside the app that
 * wrote it, without unzipping it first and without shipping a ZIP library. The
 * reader is deliberately strict about the one property the whole archive rests
 * on: a stored entry must come back byte-for-byte, and the reader proves that
 * by checking the CRC-32 in the archive's own central directory rather than
 * trusting the file.
 *
 * Two reading modes, and the difference matters:
 *
 * - **Stored entries** (every capture) can be read at any window without
 *   touching the rest of the file. `storedSlice` is a plain `Blob.slice`, so
 *   jumping to byte 3,000,000 of a photo costs nothing and returns the exact
 *   original bytes. This is the same property the archive's byte-identity
 *   report relies on.
 * - **Deflated entries** (bulky derived text) have no random access at all: the
 *   only way to reach byte N is to inflate everything before it. `inflatePrefix`
 *   therefore streams and stops early, and reports honestly whether it reached
 *   the end — a viewer showing the first 256 KB of a 90 MB hex dump must say so
 *   rather than imply the file is short.
 *
 * ZIP64, encryption and multi-disk archives are detected and reported, never
 * half-parsed. An archive this reader cannot fully understand says so; it does
 * not quietly show you a subset and let you believe it was everything.
 */

import { crcHex } from "../zip-writer";

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const CENTRAL_FIXED_BYTES = 46;
const LOCAL_FIXED_BYTES = 30;
const MAX_COMMENT_BYTES = 0xffff;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** General purpose bit 0 — the entry is encrypted. */
const FLAG_ENCRYPTED = 0x0001;
/** General purpose bit 11 — the name is UTF-8 rather than CP437. */
const FLAG_UTF8 = 0x0800;
const CRC_CHUNK = 4 * 1024 * 1024;

export type ZipReadEntry = {
  /** Path inside the archive, exactly as stored. */
  path: string;
  /** Size after extraction. */
  size: number;
  /** Bytes the payload occupies inside the archive. */
  compressedSize: number;
  method: number;
  /** True when method 0 — the payload sits verbatim and can be sliced directly. */
  stored: boolean;
  /** CRC-32 of the uncompressed payload, as recorded by whoever wrote the archive. */
  crc32: number;
  /** Offset of the local file header. */
  headerOffset: number;
  modified: Date | null;
  encrypted: boolean;
  /** Set when this specific entry cannot be read, with the reason. */
  unreadable: string | null;
};

export type ZipArchive = {
  blob: Blob;
  entries: ZipReadEntry[];
  comment: string;
  /** Anything about the archive this reader could not fully account for. */
  warnings: string[];
  /** Total size after extraction, of the entries the reader understood. */
  totalUncompressed: number;
};

/** Bytes read back out of an entry, with a truthful account of how much of it this is. */
export type EntryBytes = {
  bytes: Uint8Array;
  /** False when a byte cap cut the read short. */
  complete: boolean;
  /** Where these bytes start within the uncompressed payload. */
  start: number;
  /** Total uncompressed size, so a caller can say "showing X of Y". */
  totalSize: number;
};

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  // CP437 is the format's legacy default. Our own archives always set the UTF-8
  // flag; foreign ones may not, and mislabelling a name is better than throwing.
  return new TextDecoder(utf8 ? "utf-8" : "windows-1252").decode(bytes);
}

function dosToDate(time: number, date: number): Date | null {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

/** Scans backwards for the end-of-central-directory record, which has no fixed position. */
function findEocd(view: DataView, tailStart: number): number | null {
  for (let i = view.byteLength - EOCD_MIN_BYTES; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      const commentLength = view.getUint16(i + 20, true);
      // The comment length must account for exactly the remaining bytes, which
      // rules out a false positive from a signature appearing inside a payload.
      if (i + EOCD_MIN_BYTES + commentLength === view.byteLength) return tailStart + i;
    }
  }
  return null;
}

/**
 * Parses the central directory. Nothing is decompressed here — opening a 400 MB
 * archive reads only its index, which is a few kilobytes.
 */
export async function readZip(blob: Blob): Promise<ZipArchive> {
  const warnings: string[] = [];
  if (blob.size < EOCD_MIN_BYTES) {
    throw new Error("This file is too small to be a ZIP archive.");
  }

  const tailSize = Math.min(blob.size, EOCD_MIN_BYTES + MAX_COMMENT_BYTES);
  const tailStart = blob.size - tailSize;
  const tail = new DataView(await blob.slice(tailStart).arrayBuffer());
  const eocdOffset = findEocd(tail, tailStart);
  if (eocdOffset == null) {
    throw new Error("No ZIP end-of-central-directory record was found. This is not a ZIP file, or it is truncated.");
  }

  const eocd = new DataView(await blob.slice(eocdOffset, eocdOffset + EOCD_MIN_BYTES).arrayBuffer());
  const diskNumber = eocd.getUint16(4, true);
  const centralDisk = eocd.getUint16(6, true);
  const entriesOnDisk = eocd.getUint16(8, true);
  const entriesTotal = eocd.getUint16(10, true);
  const centralSize = eocd.getUint32(12, true);
  const centralOffset = eocd.getUint32(16, true);
  const commentLength = eocd.getUint16(20, true);
  const comment = commentLength > 0 ? new TextDecoder().decode(await blob.slice(eocdOffset + EOCD_MIN_BYTES, eocdOffset + EOCD_MIN_BYTES + commentLength).arrayBuffer()) : "";

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal) {
    warnings.push("This archive claims to be split across multiple disks. Only the part in this file can be read, so the listing below may be incomplete.");
  }
  if (entriesTotal === U16_MAX || centralOffset === U32_MAX || centralSize === U32_MAX) {
    warnings.push(
      "This archive uses ZIP64 extensions, which this reader does not parse. The listing may be incomplete or the offsets wrong. Use a desktop unzip tool for this one — nothing here should be trusted over that."
    );
  }
  if (eocdOffset >= 20 && new DataView(await blob.slice(eocdOffset - 20, eocdOffset - 16).arrayBuffer()).getUint32(0, true) === EOCD64_LOCATOR_SIG) {
    warnings.push("A ZIP64 locator record is present. See the ZIP64 note above.");
  }
  if (centralOffset + centralSize > blob.size) {
    throw new Error("The central directory points past the end of the file. The archive is truncated or corrupt.");
  }

  const central = new DataView(await blob.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const entries: ZipReadEntry[] = [];
  let cursor = 0;
  while (cursor + CENTRAL_FIXED_BYTES <= central.byteLength) {
    if (central.getUint32(cursor, true) !== CENTRAL_SIG) {
      warnings.push(`The central directory stopped making sense after ${entries.length} entries. Everything listed above that point was read normally.`);
      break;
    }
    const flags = central.getUint16(cursor + 8, true);
    const method = central.getUint16(cursor + 10, true);
    const time = central.getUint16(cursor + 12, true);
    const date = central.getUint16(cursor + 14, true);
    const crc32 = central.getUint32(cursor + 16, true);
    const compressedSize = central.getUint32(cursor + 20, true);
    const size = central.getUint32(cursor + 24, true);
    const nameLength = central.getUint16(cursor + 28, true);
    const extraLength = central.getUint16(cursor + 30, true);
    const commentLen = central.getUint16(cursor + 32, true);
    const headerOffset = central.getUint32(cursor + 42, true);
    const nameBytes = new Uint8Array(central.buffer, central.byteOffset + cursor + CENTRAL_FIXED_BYTES, nameLength);
    const path = decodeName(nameBytes, (flags & FLAG_UTF8) !== 0);

    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
    let unreadable: string | null = null;
    if (encrypted) unreadable = "This entry is encrypted. The reader will not guess at a password.";
    else if (method !== METHOD_STORE && method !== METHOD_DEFLATE) unreadable = `Compression method ${method} is not supported by this reader (only store and deflate are).`;
    else if (size === U32_MAX || compressedSize === U32_MAX) unreadable = "This entry uses ZIP64 sizes, which this reader does not parse.";
    else if (headerOffset + LOCAL_FIXED_BYTES > blob.size) unreadable = "This entry's header points past the end of the file.";

    // Directory markers are stored as zero-length entries ending in a slash.
    if (!path.endsWith("/")) {
      entries.push({
        path,
        size,
        compressedSize,
        method,
        stored: method === METHOD_STORE,
        crc32,
        headerOffset,
        modified: dosToDate(time, date),
        encrypted,
        unreadable,
      });
    }
    cursor += CENTRAL_FIXED_BYTES + nameLength + extraLength + commentLen;
  }

  if (entries.length === 0) warnings.push("The archive parsed, but contains no readable file entries.");

  return {
    blob,
    entries,
    comment,
    warnings,
    totalUncompressed: entries.reduce((sum, e) => sum + e.size, 0),
  };
}

/**
 * Resolves where an entry's payload physically begins. The local header repeats
 * the name and may carry a *different* extra field to the central one, so the
 * offset has to be read from the local header rather than assumed.
 */
export async function payloadStart(archive: ZipArchive, entry: ZipReadEntry): Promise<number> {
  const header = new DataView(await archive.blob.slice(entry.headerOffset, entry.headerOffset + LOCAL_FIXED_BYTES).arrayBuffer());
  if (header.byteLength < LOCAL_FIXED_BYTES || header.getUint32(0, true) !== LOCAL_SIG) {
    throw new Error(`The local header for "${entry.path}" is missing or corrupt.`);
  }
  const nameLength = header.getUint16(26, true);
  const extraLength = header.getUint16(28, true);
  return entry.headerOffset + LOCAL_FIXED_BYTES + nameLength + extraLength;
}

/** The raw archived payload as a blob, still compressed if the entry was deflated. */
export async function rawPayload(archive: ZipArchive, entry: ZipReadEntry): Promise<Blob> {
  const start = await payloadStart(archive, entry);
  const end = start + entry.compressedSize;
  if (end > archive.blob.size) throw new Error(`"${entry.path}" claims more bytes than the archive contains.`);
  return archive.blob.slice(start, end);
}

type DecompressionStreamCtor = new (format: string) => ReadableWritablePair<Uint8Array, Uint8Array>;

function decompressionStreamCtor(): DecompressionStreamCtor | null {
  if (typeof globalThis === "undefined") return null;
  return (globalThis as unknown as { DecompressionStream?: DecompressionStreamCtor }).DecompressionStream ?? null;
}

/** True when this platform can inflate, so deflated entries are readable here. */
export function isInflateSupported(): boolean {
  return decompressionStreamCtor() != null;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Inflates at most `maxBytes` from the front of a deflated payload, stopping the
 * stream as soon as it has enough. `complete` distinguishes "that is the whole
 * file" from "that is where we stopped", which is the difference between a
 * viewer telling the truth and a viewer implying a 90 MB dump is 256 KB long.
 */
async function inflatePrefix(payload: Blob, maxBytes: number): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const Ctor = decompressionStreamCtor();
  if (!Ctor) throw new Error("This browser cannot decompress deflated entries (no DecompressionStream). Stored entries still read fine.");
  const stream = payload.stream().pipeThrough(new Ctor("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = (stream as unknown as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = true;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      if (!step.value) continue;
      chunks.push(step.value);
      total += step.value.length;
      if (total >= maxBytes) {
        // One more read decides whether we stopped at the end or short of it.
        const probe = await reader.read();
        complete = probe.done === true && total <= maxBytes;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = concat(chunks, total);
  return { bytes: total > maxBytes ? joined.subarray(0, maxBytes) : joined, complete };
}

/**
 * Reads a window of an entry's uncompressed payload.
 *
 * Stored entries are sliced directly, so any window is cheap and exact.
 * Deflated entries have to be inflated from the start, so `start` is honoured
 * but costs the bytes before it — which is why the archive stores captures
 * uncompressed in the first place.
 */
export async function readEntry(archive: ZipArchive, entry: ZipReadEntry, start = 0, maxBytes = 256 * 1024): Promise<EntryBytes> {
  if (entry.unreadable) throw new Error(entry.unreadable);
  const from = Math.max(0, Math.min(start, entry.size));
  const payload = await rawPayload(archive, entry);

  if (entry.stored) {
    const to = Math.min(entry.size, from + maxBytes);
    const bytes = new Uint8Array(await payload.slice(from, to).arrayBuffer());
    return { bytes, complete: to >= entry.size, start: from, totalSize: entry.size };
  }

  const wanted = from + maxBytes;
  const prefix = await inflatePrefix(payload, wanted);
  const bytes = prefix.bytes.subarray(Math.min(from, prefix.bytes.length));
  return {
    bytes,
    complete: prefix.complete && from + bytes.length >= entry.size,
    start: from,
    totalSize: entry.size,
  };
}

/** Convenience wrapper for text entries. Invalid UTF-8 is replaced, never thrown on. */
export async function readEntryText(archive: ZipArchive, entry: ZipReadEntry, start = 0, maxBytes = 256 * 1024): Promise<{ text: string; complete: boolean; bytesRead: number; totalSize: number }> {
  const chunk = await readEntry(archive, entry, start, maxBytes);
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(chunk.bytes),
    complete: chunk.complete,
    bytesRead: chunk.bytes.length,
    totalSize: chunk.totalSize,
  };
}

/** The whole entry as a blob, for previewing an image or handing it to a download. */
export async function readEntryBlob(archive: ZipArchive, entry: ZipReadEntry, type?: string): Promise<Blob> {
  if (entry.unreadable) throw new Error(entry.unreadable);
  const payload = await rawPayload(archive, entry);
  if (entry.stored) return type ? payload.slice(0, payload.size, type) : payload;
  const inflated = await inflatePrefix(payload, entry.size);
  const copy = new Uint8Array(inflated.bytes.length);
  copy.set(inflated.bytes);
  return new Blob([copy.buffer], type ? { type } : undefined);
}

export type EntryVerification = {
  ok: boolean;
  /** CRC-32 recorded in the archive's central directory. */
  expected: string;
  /** CRC-32 computed here from the extracted bytes. */
  actual: string;
  detail: string;
};

/**
 * Recomputes an entry's CRC-32 from its extracted bytes and compares it with the
 * one the archive recorded. This is the archive checking itself: a mismatch means
 * the file changed after it was written, and is reported as such rather than
 * shrugged off.
 */
export async function verifyEntry(archive: ZipArchive, entry: ZipReadEntry): Promise<EntryVerification> {
  if (entry.unreadable) {
    return { ok: false, expected: crcHex(entry.crc32), actual: "—", detail: entry.unreadable };
  }
  let crc = 0xffffffff;
  const table = crcTable();
  const update = (bytes: Uint8Array): void => {
    let c = crc;
    for (let i = 0; i < bytes.length; i += 1) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    crc = c;
  };

  if (entry.stored) {
    const payload = await rawPayload(archive, entry);
    for (let offset = 0; offset < payload.size; offset += CRC_CHUNK) {
      update(new Uint8Array(await payload.slice(offset, Math.min(offset + CRC_CHUNK, payload.size)).arrayBuffer()));
    }
  } else {
    const payload = await rawPayload(archive, entry);
    const inflated = await inflatePrefix(payload, entry.size);
    if (!inflated.complete && inflated.bytes.length < entry.size) {
      return {
        ok: false,
        expected: crcHex(entry.crc32),
        actual: "—",
        detail: `Only ${inflated.bytes.length.toLocaleString("en-US")} of ${entry.size.toLocaleString("en-US")} bytes could be inflated, so no checksum was computed. Reporting no answer rather than a wrong one.`,
      };
    }
    update(inflated.bytes);
  }

  const actual = crcHex((crc ^ 0xffffffff) >>> 0);
  const expected = crcHex(entry.crc32);
  const ok = actual === expected;
  return {
    ok,
    expected,
    actual,
    detail: ok
      ? `CRC-32 ${actual} matches the value stored in the archive. These are the original bytes.`
      : `CRC-32 MISMATCH — the archive records ${expected}, the bytes here produce ${actual}. This entry has changed since it was written.`,
  };
}

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  const built = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    built[i] = c >>> 0;
  }
  table = built;
  return built;
}
