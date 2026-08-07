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
 *
 * Compression is opt-in per entry and OFF by default. Evidence payloads must
 * never be deflated: byte identity is proved by carving them out of the
 * archive at a known offset, which only works while they sit there verbatim.
 * Bulky *derived* text — hex dumps especially — may set `compress: true`, in
 * which case DEFLATE runs through the platform `CompressionStream`. The CRC-32
 * written into the header is always the checksum of the UNCOMPRESSED bytes, as
 * the format requires, so `unzip -t` still validates them.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Version 2.0 — the minimum that understands the UTF-8 name flag. */
const VERSION = 20;
/** General purpose bit 11: file name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_ENTRY_BYTES = 0xffffffff;
/** EOCD stores the central-directory offset in 32 bits, so the whole archive must fit too. */
const MAX_ARCHIVE_BYTES = 0xffffffff;
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
  /**
   * Opt in to DEFLATE for this entry. Only ever set this on derived text a
   * reader does not need to carve out byte-for-byte — never on a capture.
   * Ignored when the platform has no CompressionStream, in which case the
   * entry is stored and `ZipEntryInfo.stored` reports that truthfully.
   */
  compress?: boolean;
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

/** CRC-32 of a blob, streamed so a large clip never lands in memory whole. */
export async function crc32OfBlob(blob: Blob): Promise<number> {
  const crc = new Crc32();
  for (let offset = 0; offset < blob.size; offset += CRC_CHUNK) {
    const slice = blob.slice(offset, Math.min(offset + CRC_CHUNK, blob.size));
    crc.update(new Uint8Array(await slice.arrayBuffer()));
  }
  return crc.value;
}

/** CRC-32 as the 8-digit lowercase hex string that zip/crc32 tools print. */
export function crcHex(crc: number): string {
  return (crc >>> 0).toString(16).padStart(8, "0");
}

type CompressionStreamCtor = new (format: string) => ReadableWritablePair<Uint8Array, Uint8Array>;

function compressionStreamCtor(): CompressionStreamCtor | null {
  if (typeof globalThis === "undefined") return null;
  return (globalThis as unknown as { CompressionStream?: CompressionStreamCtor }).CompressionStream ?? null;
}

/** True when this platform can DEFLATE, so bulky derived text need not be stored raw. */
export function isDeflateSupported(): boolean {
  return compressionStreamCtor() != null;
}

/**
 * Raw-deflate a blob through the platform compressor. Returns null on any
 * failure so the caller falls back to storing — a bigger archive is always
 * preferable to a broken one.
 */
async function deflateRaw(blob: Blob): Promise<Blob | null> {
  const Ctor = compressionStreamCtor();
  if (!Ctor) return null;
  try {
    const compressed = blob.stream().pipeThrough(new Ctor("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    return await new Response(compressed as unknown as ReadableStream).blob();
  } catch {
    return null;
  }
}

/**
 * Streams two blobs side by side, comparing them byte-for-byte while computing
 * the CRC-32 of the first. One pass over each, 4 MB at a time — used to verify
 * that what landed in the archive is exactly what went in.
 */
export async function verifyBytes(archived: Blob, source: Blob): Promise<{ identical: boolean; crc32: number; firstDifferenceAt: number | null }> {
  const crc = new Crc32();
  let identical = archived.size === source.size;
  let firstDifferenceAt: number | null = identical ? null : Math.min(archived.size, source.size);
  const limit = Math.min(archived.size, source.size);
  for (let offset = 0; offset < archived.size; offset += CRC_CHUNK) {
    const end = Math.min(offset + CRC_CHUNK, archived.size);
    const a = new Uint8Array(await archived.slice(offset, end).arrayBuffer());
    crc.update(a);
    if (firstDifferenceAt != null && offset >= limit) continue;
    const b = new Uint8Array(await source.slice(offset, Math.min(end, limit)).arrayBuffer());
    for (let i = 0; i < b.length; i += 1) {
      if (a[i] !== b[i]) {
        identical = false;
        if (firstDifferenceAt == null) firstDifferenceAt = offset + i;
        break;
      }
    }
  }
  return { identical, crc32: crc.value, firstDifferenceAt };
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
  storedSize: number;
  method: number;
  offset: number;
  time: number;
  date: number;
};

/** Where an entry physically lives in the finished archive. */
export type ZipEntryInfo = {
  path: string;
  /** Logical size of the payload, i.e. the size after extraction. */
  size: number;
  /** Bytes actually occupied in the archive. Equal to `size` when stored. */
  compressedSize: number;
  /** False when this entry was deflated, so carving at `dataOffset` yields compressed bytes. */
  stored: boolean;
  /** CRC-32 of the uncompressed payload, as the ZIP format defines it. */
  crc32: number;
  /** Offset of the local file header. */
  headerOffset: number;
  /** Offset of the first payload byte — carve from here for `compressedSize` bytes. */
  dataOffset: number;
};

export type BuildZipOptions = {
  onProgress?: (p: ZipProgress) => void;
  /**
   * Called once every entry above has been laid out, so the entries it returns
   * can cite the exact offset and checksum of everything before them. This is
   * how a verification report gets written into the archive it describes.
   */
  finalize?: (table: ZipEntryInfo[]) => Promise<ZipEntry[]> | ZipEntry[];
};

export type ZipResult = {
  blob: Blob;
  /** Offset/size/CRC of every entry, so any of them can be carved back out. */
  entries: ZipEntryInfo[];
};

/**
 * Builds a ZIP archive from the given entries.
 *
 * Duplicate paths are de-duplicated (`name.ext` → `name (2).ext`) so a caller
 * never silently loses a file. Progress is reported per entry, and the returned
 * table locates every payload inside the archive.
 */
export async function buildZip(entries: ZipEntry[], options?: BuildZipOptions): Promise<ZipResult> {
  const encoder = new TextEncoder();
  const used = new Set<string>();
  const parts: BlobPart[] = [];
  const prepared: PreparedEntry[] = [];
  const table: ZipEntryInfo[] = [];
  let offset = 0;
  let done = 0;
  const onProgress = options?.onProgress;

  const layout = async (entry: ZipEntry, total: number): Promise<void> => {
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
    // CRC is always of the uncompressed bytes, whether or not we deflate.
    const crc = await crc32OfBlob(blob);
    const deflated = entry.compress === true && blob.size > 0 ? await deflateRaw(blob) : null;
    // Only take the compressed form when it actually helps.
    const useDeflate = deflated != null && deflated.size < blob.size;
    const payload = useDeflate && deflated ? deflated : blob;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const nameBytes = encoder.encode(path);
    const { time, date } = dosDateTime(entry.date ?? new Date());
    const headerLength = 30 + nameBytes.length;
    if (offset + headerLength + payload.size > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `The archive would exceed the 4 GB ZIP limit while adding "${path}". Export fewer clips at a time — a truncated archive would be worse than a refused one.`
      );
    }

    const header = writer(headerLength);
    u32(header, LOCAL_SIG);
    u16(header, VERSION);
    u16(header, FLAG_UTF8);
    u16(header, method);
    u16(header, time);
    u16(header, date);
    u32(header, crc);
    u32(header, payload.size);
    u32(header, blob.size);
    u16(header, nameBytes.length);
    u16(header, 0);
    raw(header, nameBytes);

    parts.push(header.buffer);
    if (payload.size > 0) parts.push(payload);
    prepared.push({ nameBytes, blob, crc, size: blob.size, storedSize: payload.size, method, offset, time, date });
    table.push({
      path,
      size: blob.size,
      compressedSize: payload.size,
      stored: !useDeflate,
      crc32: crc,
      headerOffset: offset,
      dataOffset: offset + headerLength,
    });
    offset += headerLength + payload.size;

    done += 1;
    onProgress?.({ done, total, path, bytes: blob.size });
  };

  for (const entry of entries) await layout(entry, entries.length);

  const extra = (await options?.finalize?.(table)) ?? [];
  const grandTotal = entries.length + extra.length;
  for (const entry of extra) await layout(entry, grandTotal);

  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const central = writer(centralSize);
  for (const e of prepared) {
    u32(central, CENTRAL_SIG);
    u16(central, VERSION);
    u16(central, VERSION);
    u16(central, FLAG_UTF8);
    u16(central, e.method);
    u16(central, e.time);
    u16(central, e.date);
    u32(central, e.crc);
    u32(central, e.storedSize);
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
  return { blob: new Blob(parts, { type: "application/zip" }), entries: table };
}
