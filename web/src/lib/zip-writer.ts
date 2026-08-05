/**
 * Dependency-free ZIP writer, store-only (compression method 0).
 *
 * Why store-only: this archive is evidence. A captured JPEG/MP4 must come out
 * of the ZIP byte-for-byte identical to what the camera produced — same EXIF,
 * same entropy-coded scan data, same file hash. Storing without deflate makes
 * that provable by construction rather than by trust, and it means an inspector
 * can carve the original bytes straight out of the archive at a known offset.
 *
 * Memory: entry payloads are never concatenated into one buffer. Blob parts are
 * handed to the Blob constructor as-is, so the browser keeps large video clips
 * on disk. CRC-32 is computed by streaming 4 MB slices, so a 500 MB clip costs
 * 4 MB of peak heap.
 *
 * Format: APPNOTE 6.3.x local header + central directory + EOCD. UTF-8 flag
 * (bit 11) is set on every entry, so non-ASCII names survive. ZIP64 is not
 * emitted — entries above 4 GiB are rejected with a clear error instead of
 * silently producing a corrupt archive.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Version 2.0 — the minimum that understands the UTF-8 name flag. */
const VERSION = 20;
/** General purpose bit 11: file name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const MAX_ENTRY_BYTES = 0xffffffff;
const CRC_CHUNK = 4 * 1024 * 1024;

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** Rolling CRC-32 so payloads can be hashed in slices instead of all at once. */
class Crc32 {
  private state = 0xffffffff;

  update(bytes: Uint8Array): void {
    const table = getCrcTable();
    let c = this.state;
    for (let i = 0; i < bytes.length; i += 1) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    this.state = c;
  }

  get value(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }
}

/** MS-DOS packed date/time pair used by the ZIP headers. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  // DOS epoch starts at 1980 and cannot represent anything earlier.
  const safeYear = year < 1980 ? 1980 : year > 2107 ? 2107 : year;
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const packed = (((safeYear - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: packed };
}

export type ZipEntry = {
  /** Path inside the archive, forward slashes. Directories are implicit. */
  path: string;
  /** Payload. Strings are written as UTF-8 text; Blobs are stored verbatim. */
  data: Blob | Uint8Array | ArrayBuffer | string;
  /** Modification stamp written into the entry (defaults to now). */
  date?: Date;
};

export type ZipProgress = {
  /** Entries finished so far. */
  done: number;
  total: number;
  /** Path of the entry that just finished. */
  path: string;
  bytes: number;
};

/** Sanitises a path segment set: no leading slash, no traversal, no illegal chars. */
export function safeZipPath(path: string): string {
  const cleaned = path
    .split("/")
    .map((seg) =>
      seg
        .replace(/[\u0000-\u001f<>:"\\|?*]+/g, "_")
        .replace(/^\.+$/, "_")
        .replace(/\.+$/, "")
        .trim()
    )
    .filter((seg) => seg.length > 0)
    .join("/");
  return cleaned.length > 0 ? cleaned : "unnamed";
}

function toBlob(data: ZipEntry["data"]): Blob {
  if (typeof data === "string") return new Blob([data], { type: "text/plain;charset=utf-8" });
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data]);
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Blob([copy.buffer]);
}

async function crcOfBlob(blob: Blob): Promise<number> {
  const crc = new Crc32();
  for (let offset = 0; offset < blob.size; offset += CRC_CHUNK) {
    const slice = blob.slice(offset, Math.min(offset + CRC_CHUNK, blob.size));
    crc.update(new Uint8Array(await slice.arrayBuffer()));
  }
  return crc.value;
}

type Writer = {
  /** Backing buffer, exactly `size` bytes — handed to Blob directly. */
  buffer: ArrayBuffer;
  bytes: Uint8Array;
  view: DataView;
  pos: number;
};

function writer(size: number): Writer {
  const buffer = new ArrayBuffer(size);
  return { buffer, bytes: new Uint8Array(buffer), view: new DataView(buffer), pos: 0 };
}

function u16(w: Writer, value: number): void {
  w.view.setUint16(w.pos, value & 0xffff, true);
  w.pos += 2;
}

function u32(w: Writer, value: number): void {
  w.view.setUint32(w.pos, value >>> 0, true);
  w.pos += 4;
}

function raw(w: Writer, bytes: Uint8Array): void {
  w.bytes.set(bytes, w.pos);
  w.pos += bytes.length;
}

type PreparedEntry = {
  nameBytes: Uint8Array;
  blob: Blob;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
};

/**
 * Builds a ZIP archive from the given entries.
 *
 * Duplicate paths are de-duplicated (`name.ext` → `name (2).ext`) so a caller
 * never silently loses a file. Progress is reported per entry.
 */
export async function buildZip(entries: ZipEntry[], onProgress?: (p: ZipProgress) => void): Promise<Blob> {
  const encoder = new TextEncoder();
  const used = new Set<string>();
  const parts: BlobPart[] = [];
  const prepared: PreparedEntry[] = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    let path = safeZipPath(entry.path);
    if (used.has(path)) {
      const dot = path.lastIndexOf(".");
      const stem = dot > 0 ? path.slice(0, dot) : path;
      const ext = dot > 0 ? path.slice(dot) : "";
      let n = 2;
      while (used.has(`${stem} (${n})${ext}`)) n += 1;
      path = `${stem} (${n})${ext}`;
    }
    used.add(path);

    const blob = toBlob(entry.data);
    if (blob.size > MAX_ENTRY_BYTES) {
      throw new Error(`"${path}" is ${(blob.size / 1024 / 1024 / 1024).toFixed(2)} GB — above the 4 GB per-file ZIP limit`);
    }
    const crc = await crcOfBlob(blob);
    const nameBytes = encoder.encode(path);
    const { time, date } = dosDateTime(entry.date ?? new Date());

    const header = writer(30 + nameBytes.length);
    u32(header, LOCAL_SIG);
    u16(header, VERSION);
    u16(header, FLAG_UTF8);
    u16(header, METHOD_STORE);
    u16(header, time);
    u16(header, date);
    u32(header, crc);
    u32(header, blob.size);
    u32(header, blob.size);
    u16(header, nameBytes.length);
    u16(header, 0);
    raw(header, nameBytes);

    parts.push(header.buffer);
    if (blob.size > 0) parts.push(blob);
    prepared.push({ nameBytes, blob, crc, size: blob.size, offset, time, date });
    offset += header.buffer.byteLength + blob.size;

    onProgress?.({ done: i + 1, total: entries.length, path, bytes: blob.size });
  }

  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const central = writer(centralSize);
  for (const e of prepared) {
    u32(central, CENTRAL_SIG);
    u16(central, VERSION);
    u16(central, VERSION);
    u16(central, FLAG_UTF8);
    u16(central, METHOD_STORE);
    u16(central, e.time);
    u16(central, e.date);
    u32(central, e.crc);
    u32(central, e.size);
    u32(central, e.size);
    u16(central, e.nameBytes.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, e.offset);
    raw(central, e.nameBytes);
  }

  const eocd = writer(22);
  u32(eocd, EOCD_SIG);
  u16(eocd, 0);
  u16(eocd, 0);
  u16(eocd, prepared.length);
  u16(eocd, prepared.length);
  u32(eocd, centralSize);
  u32(eocd, offset);
  u16(eocd, 0);

  parts.push(central.buffer, eocd.buffer);
  return new Blob(parts, { type: "application/zip" });
}
