/**
 * The raw dump — every byte of every capture, three ways.
 *
 *  1. `hexDumpBlob` renders the whole file as offset + hex + ASCII, in the
 *     `xxd` layout every hex editor and forensic tool already understands.
 *     Generated in slices and assembled as Blob parts, so a 40 MB capture
 *     never needs 200 MB of string on the heap.
 *  2. `walkStructure` parses the container and reports every internal section:
 *     where it starts, how long it is, and what it holds. This is a real parse
 *     of the format, not a byte grep for magic numbers — an offset that comes
 *     out of here is an offset you can seek to.
 *  3. `carveSegments` lifts the interesting regions out whole — the EXIF block,
 *     the maker note, the colour profile, embedded thumbnails, XMP, C2PA — each
 *     as its own file, at its exact position in the original.
 *
 * Where a format is not understood, that is said plainly and the hex dump still
 * covers every byte. A parser that guessed would be worse than one that admits
 * the limit.
 */

export type StructureNode = {
  offset: number;
  length: number;
  /** Marker/box/chunk identifier, exactly as it appears in the file. */
  id: string;
  /** What that identifier means. */
  name: string;
  /** Anything read out of the section itself. */
  detail: string;
  /** Nesting depth for indented display. */
  depth: number;
};

export type CarvedSegment = {
  /** Filename-safe name for the carved file. */
  name: string;
  /** What this region is, in plain words. */
  description: string;
  offset: number;
  length: number;
};

export type StructureReport = {
  container: string;
  parsed: boolean;
  nodes: StructureNode[];
  segments: CarvedSegment[];
  /** Any place the parse gave up, stated rather than hidden. */
  warnings: string[];
  totalBytes: number;
};

/* ------------------------------------------------------------------ *
 * Hex dump
 * ------------------------------------------------------------------ */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const ASCII: string[] = Array.from({ length: 256 }, (_, i) => (i >= 0x20 && i <= 0x7e ? String.fromCharCode(i) : "."));

const HEX_SLICE = 512 * 1024;

/**
 * One `xxd`-style line per 16 bytes. Exported so the in-app archive viewer
 * renders bytes in exactly the same layout as the dumps inside the archive —
 * two different hex formats for the same file would invite a reader to think
 * they were looking at two different files.
 */
export function hexLines(bytes: Uint8Array, baseOffset: number): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const end = Math.min(i + 16, bytes.length);
    let hex = "";
    let text = "";
    for (let j = i; j < end; j += 1) {
      hex += HEX[bytes[j]];
      hex += j - i === 7 ? "  " : " ";
      text += ASCII[bytes[j]];
    }
    out.push(`${(baseOffset + i).toString(16).padStart(8, "0")}  ${hex.padEnd(49)} |${text}|`);
  }
  return out.join("\n");
}

export type HexDumpResult = {
  blob: Blob;
  /** True when a byte budget cut the dump short — always surfaced, never silent. */
  truncated: boolean;
  bytesRendered: number;
  /** When truncated, the tail window that was rendered instead of the middle. */
  note: string;
};

/**
 * Renders a blob as hex + ASCII. When `maxBytes` is exceeded the dump becomes a
 * head window plus a tail window with an explicit gap marker naming exactly how
 * many bytes were skipped — the archive never contains a hex dump that looks
 * complete but is not.
 */
export async function hexDumpBlob(blob: Blob, label: string, maxBytes: number): Promise<HexDumpResult> {
  const parts: BlobPart[] = [];
  const header = [
    `HEX DUMP — ${label}`,
    "=".repeat(78),
    `${blob.size.toLocaleString("en-US")} bytes · type ${blob.type || "unknown"}`,
    "Layout: byte offset (hex) · 16 bytes · printable ASCII. Identical to `xxd` output, so it can be",
    "diffed against a dump you produce yourself from the file in originals/ or rendered-frames/.",
    "",
  ];

  const dumpRange = async (start: number, end: number): Promise<void> => {
    for (let offset = start; offset < end; offset += HEX_SLICE) {
      const sliceEnd = Math.min(offset + HEX_SLICE, end);
      const bytes = new Uint8Array(await blob.slice(offset, sliceEnd).arrayBuffer());
      parts.push(`${hexLines(bytes, offset)}\n`);
    }
  };

  if (blob.size <= maxBytes) {
    parts.push(`${[...header, "COMPLETE — every byte of the file is below.", ""].join("\n")}\n`);
    await dumpRange(0, blob.size);
    return {
      blob: new Blob(parts, { type: "text/plain;charset=utf-8" }),
      truncated: false,
      bytesRendered: blob.size,
      note: "Complete — every byte rendered.",
    };
  }

  const headBytes = Math.max(64 * 1024, Math.floor(maxBytes * 0.75));
  const tailBytes = Math.min(8 * 1024, blob.size - headBytes);
  const skipped = blob.size - headBytes - tailBytes;
  const note = `Windowed: the first ${headBytes.toLocaleString("en-US")} bytes and the last ${tailBytes.toLocaleString("en-US")} bytes are rendered; ${skipped.toLocaleString("en-US")} bytes in between were skipped to keep the archive inside its size budget. The complete file is still present, unaltered, in the captures folder — dump it yourself with \`xxd\` for the missing range.`;
  parts.push(`${[...header, "WINDOWED — NOT a complete dump.", ...note.match(/.{1,96}(\s|$)/g)?.map((s) => s.trim()) ?? [note], ""].join("\n")}\n`);
  await dumpRange(0, headBytes);
  parts.push(`\n${"-".repeat(78)}\n[ ${skipped.toLocaleString("en-US")} bytes skipped: offsets ${headBytes} through ${blob.size - tailBytes - 1} ]\n${"-".repeat(78)}\n\n`);
  await dumpRange(blob.size - tailBytes, blob.size);

  return {
    blob: new Blob(parts, { type: "text/plain;charset=utf-8" }),
    truncated: true,
    bytesRendered: headBytes + tailBytes,
    note,
  };
}

/* ------------------------------------------------------------------ *
 * Structure walk
 * ------------------------------------------------------------------ */

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function u16be(view: DataView, offset: number): number {
  return view.getUint16(offset, false);
}

function u32be(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < Math.min(offset + length, bytes.length); i += 1) out += ASCII[bytes[i]];
  return out;
}

const JPEG_MARKERS: Record<number, string> = {
  0xc0: "SOF0 — baseline DCT frame header",
  0xc1: "SOF1 — extended sequential DCT",
  0xc2: "SOF2 — progressive DCT",
  0xc3: "SOF3 — lossless",
  0xc4: "DHT — Huffman tables",
  0xc9: "SOF9 — arithmetic coded",
  0xcc: "DAC — arithmetic conditioning",
  0xd8: "SOI — start of image",
  0xd9: "EOI — end of image",
  0xda: "SOS — start of scan (compressed pixel data follows)",
  0xdb: "DQT — quantisation tables (the encoder's fingerprint)",
  0xdd: "DRI — restart interval",
  0xfe: "COM — free-text comment",
};

function appMarkerName(marker: number, signature: string): string {
  switch (marker) {
    case 0xe0:
      return "APP0 — JFIF header";
    case 0xe1:
      if (signature.startsWith("Exif")) return "APP1 — EXIF (camera metadata block)";
      if (signature.startsWith("http")) return "APP1 — XMP (Adobe extensible metadata)";
      return "APP1 — unrecognised payload";
    case 0xe2:
      if (signature.startsWith("ICC_")) return "APP2 — ICC colour profile";
      if (signature.startsWith("MPF")) return "APP2 — multi-picture format (depth/HDR companions)";
      return "APP2 — unrecognised payload";
    case 0xe3:
      return "APP3 — Kodak/Meta";
    case 0xe4:
      return "APP4 — vendor extension";
    case 0xe5:
      return "APP5 — vendor extension";
    case 0xeb:
      return "APP11 — JUMBF / C2PA content credentials";
    case 0xec:
      return "APP12 — Ducky / picture info";
    case 0xed:
      return "APP13 — Photoshop IRB / IPTC";
    case 0xee:
      return "APP14 — Adobe colour transform";
    case 0xef:
      return "APP15 — vendor extension";
    default:
      return `APP${marker - 0xe0} — application segment`;
  }
}

function walkJpeg(bytes: Uint8Array, view: DataView): StructureReport {
  const nodes: StructureNode[] = [];
  const segments: CarvedSegment[] = [];
  const warnings: string[] = [];
  let offset = 2;
  nodes.push({ offset: 0, length: 2, id: "FFD8", name: "SOI — start of image", detail: "The two bytes that make this a JPEG.", depth: 0 });

  let guard = 0;
  while (offset < bytes.length - 1 && guard < 4096) {
    guard += 1;
    if (bytes[offset] !== 0xff) {
      warnings.push(`Expected a marker at offset ${offset} and found 0x${HEX[bytes[offset]]}. The structural walk stopped there; the hex dump still covers the rest.`);
      break;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd9) {
      nodes.push({ offset, length: 2, id: "FFD9", name: "EOI — end of image", detail: "", depth: 0 });
      offset += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) break;
    const length = u16be(view, offset + 2);
    const payloadStart = offset + 4;
    const payloadLength = length - 2;
    const signature = ascii(bytes, payloadStart, 12);
    const id = `FF${HEX[marker].toUpperCase()}`;

    if (marker >= 0xe0 && marker <= 0xef) {
      const name = appMarkerName(marker, signature);
      nodes.push({
        offset,
        length: length + 2,
        id,
        name,
        detail: `payload ${payloadLength} bytes · leading signature "${signature.replace(/\.+$/, "")}"`,
        depth: 0,
      });
      if (marker === 0xe1 && signature.startsWith("Exif")) {
        segments.push({
          name: "exif-app1",
          description: "The complete EXIF block as the camera wrote it, including the TIFF header and every IFD. Carved whole, at its exact position.",
          offset: payloadStart + 6,
          length: payloadLength - 6,
        });
        const tiff = payloadStart + 6;
        const thumb = findExifThumbnail(bytes, view, tiff);
        if (thumb) {
          segments.push({
            name: "exif-thumbnail",
            description: "The embedded preview JPEG the camera stored inside EXIF. A complete, separate image — often it survives edits that changed the main picture.",
            offset: thumb.offset,
            length: thumb.length,
          });
        }
        const maker = findMakerNote(bytes, view, tiff);
        if (maker) {
          segments.push({
            name: "maker-note",
            description:
              "The manufacturer's private block. Undocumented and vendor-specific by design — it commonly holds lens serial numbers, shot counters and processing settings that appear nowhere else.",
            offset: maker.offset,
            length: maker.length,
          });
        }
      } else if (marker === 0xe1) {
        segments.push({ name: "xmp-app1", description: "XMP metadata — the XML block Adobe tools and many phones write, frequently carrying an edit history.", offset: payloadStart, length: payloadLength });
      } else if (marker === 0xe2 && signature.startsWith("ICC_")) {
        segments.push({ name: "icc-profile", description: "The embedded ICC colour profile, describing the colour space the pixels are in.", offset: payloadStart + 14, length: payloadLength - 14 });
      } else if (marker === 0xeb) {
        segments.push({ name: "jumbf-c2pa", description: "JUMBF / C2PA content credentials — a signed provenance manifest, if one is present.", offset: payloadStart, length: payloadLength });
      } else if (marker === 0xed) {
        segments.push({ name: "photoshop-irb", description: "Photoshop image resource block, which carries IPTC captions and editing residue.", offset: payloadStart, length: payloadLength });
      }
      offset += length + 2;
      continue;
    }

    if (marker === 0xda) {
      nodes.push({ offset, length: length + 2, id, name: JPEG_MARKERS[0xda], detail: `header ${payloadLength} bytes`, depth: 0 });
      // Entropy-coded data runs to the next non-restart, non-stuffed marker.
      let scan = payloadStart + payloadLength;
      while (scan < bytes.length - 1) {
        if (bytes[scan] === 0xff && bytes[scan + 1] !== 0x00 && !(bytes[scan + 1] >= 0xd0 && bytes[scan + 1] <= 0xd7)) break;
        scan += 1;
      }
      nodes.push({
        offset: payloadStart + payloadLength,
        length: scan - (payloadStart + payloadLength),
        id: "scan",
        name: "Entropy-coded image data",
        detail: "The compressed pixels themselves. Everything else in the file is description; this is the picture.",
        depth: 1,
      });
      offset = scan;
      continue;
    }

    let detail = `payload ${payloadLength} bytes`;
    if (marker >= 0xc0 && marker <= 0xc3 && payloadStart + 8 <= bytes.length) {
      const h = u16be(view, payloadStart + 1);
      const wpx = u16be(view, payloadStart + 3);
      detail = `${wpx}×${h}, ${bytes[payloadStart + 5]} components, ${bytes[payloadStart]}-bit`;
    }
    nodes.push({ offset, length: length + 2, id, name: JPEG_MARKERS[marker] ?? `marker 0x${HEX[marker]}`, detail, depth: 0 });
    offset += length + 2;
  }

  return { container: "JPEG (JFIF/EXIF)", parsed: true, nodes, segments, warnings, totalBytes: bytes.length };
}

/** Follows the TIFF header to IFD1 and reads the embedded thumbnail's offset/length. */
function findExifThumbnail(bytes: Uint8Array, view: DataView, tiff: number): { offset: number; length: number } | null {
  try {
    if (tiff + 8 > bytes.length) return null;
    const little = ascii(bytes, tiff, 2) === "II";
    const ifd0 = view.getUint32(tiff + 4, little);
    const ifd0At = tiff + ifd0;
    if (ifd0At + 2 > bytes.length) return null;
    const count0 = view.getUint16(ifd0At, little);
    const nextPtrAt = ifd0At + 2 + count0 * 12;
    if (nextPtrAt + 4 > bytes.length) return null;
    const ifd1 = view.getUint32(nextPtrAt, little);
    if (ifd1 === 0) return null;
    const ifd1At = tiff + ifd1;
    if (ifd1At + 2 > bytes.length) return null;
    const count1 = view.getUint16(ifd1At, little);
    let thumbOffset: number | null = null;
    let thumbLength: number | null = null;
    for (let i = 0; i < count1; i += 1) {
      const entry = ifd1At + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      const tag = view.getUint16(entry, little);
      const value = view.getUint32(entry + 8, little);
      if (tag === 0x0201) thumbOffset = tiff + value;
      if (tag === 0x0202) thumbLength = value;
    }
    if (thumbOffset == null || thumbLength == null || thumbLength <= 0) return null;
    if (thumbOffset + thumbLength > bytes.length) return null;
    return { offset: thumbOffset, length: thumbLength };
  } catch {
    return null;
  }
}

/** Locates the MakerNote tag (0x927C) inside the EXIF sub-IFD. */
function findMakerNote(bytes: Uint8Array, view: DataView, tiff: number): { offset: number; length: number } | null {
  try {
    const little = ascii(bytes, tiff, 2) === "II";
    const ifd0At = tiff + view.getUint32(tiff + 4, little);
    if (ifd0At + 2 > bytes.length) return null;
    const count0 = view.getUint16(ifd0At, little);
    let exifIfd: number | null = null;
    for (let i = 0; i < count0; i += 1) {
      const entry = ifd0At + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      if (view.getUint16(entry, little) === 0x8769) exifIfd = tiff + view.getUint32(entry + 8, little);
    }
    if (exifIfd == null || exifIfd + 2 > bytes.length) return null;
    const countE = view.getUint16(exifIfd, little);
    for (let i = 0; i < countE; i += 1) {
      const entry = exifIfd + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      if (view.getUint16(entry, little) === 0x927c) {
        const length = view.getUint32(entry + 4, little);
        const offset = tiff + view.getUint32(entry + 8, little);
        if (length > 0 && offset + length <= bytes.length) return { offset, length };
      }
    }
    return null;
  } catch {
    return null;
  }
}

const PNG_CHUNKS: Record<string, string> = {
  IHDR: "Image header — dimensions, bit depth, colour type",
  PLTE: "Palette",
  IDAT: "Compressed image data",
  IEND: "End of file",
  tEXt: "Uncompressed text metadata",
  zTXt: "Compressed text metadata",
  iTXt: "International text metadata (often XMP)",
  eXIf: "EXIF block, as PNG stores it",
  iCCP: "Embedded ICC colour profile",
  gAMA: "Gamma",
  cHRM: "Chromaticity",
  sRGB: "sRGB rendering intent",
  pHYs: "Physical pixel dimensions",
  tIME: "Last modification time",
  acTL: "Animation control (APNG)",
};

function walkPng(bytes: Uint8Array, view: DataView): StructureReport {
  const nodes: StructureNode[] = [];
  const segments: CarvedSegment[] = [];
  const warnings: string[] = [];
  nodes.push({ offset: 0, length: 8, id: "signature", name: "PNG signature", detail: "The eight bytes that identify a PNG.", depth: 0 });
  let offset = 8;
  let guard = 0;
  while (offset + 8 <= bytes.length && guard < 4096) {
    guard += 1;
    const length = u32be(view, offset);
    const type = fourcc(bytes, offset + 4);
    nodes.push({
      offset,
      length: length + 12,
      id: type,
      name: PNG_CHUNKS[type] ?? "Unrecognised chunk",
      detail: `${length} bytes of payload${type === "IHDR" && offset + 16 <= bytes.length ? ` · ${u32be(view, offset + 8)}×${u32be(view, offset + 12)}` : ""}`,
      depth: 0,
    });
    if (type === "eXIf") segments.push({ name: "png-exif", description: "The EXIF block as stored in a PNG chunk.", offset: offset + 8, length });
    if (type === "iCCP") segments.push({ name: "icc-profile", description: "Embedded ICC colour profile (deflate-compressed inside the chunk).", offset: offset + 8, length });
    if (type === "iTXt" || type === "tEXt" || type === "zTXt") {
      segments.push({ name: `png-text-${offset}`, description: `PNG ${type} chunk — text metadata, which is where editors leave their names.`, offset: offset + 8, length });
    }
    if (type === "IEND") {
      offset += length + 12;
      break;
    }
    offset += length + 12;
  }
  if (offset < bytes.length) {
    warnings.push(`${bytes.length - offset} bytes follow the IEND chunk. Data after the end of a PNG is unusual and is preserved in the hex dump.`);
  }
  return { container: "PNG", parsed: true, nodes, segments, warnings, totalBytes: bytes.length };
}

const BOX_NAMES: Record<string, string> = {
  ftyp: "File type and compatible brands",
  meta: "Metadata container",
  mdat: "Media data — the actual image or video payload",
  moov: "Movie header and track definitions",
  trak: "One track",
  mdia: "Media information for a track",
  minf: "Media information container",
  stbl: "Sample table — where every frame lives",
  hdlr: "Handler — what kind of data this is",
  iinf: "Item information",
  iloc: "Item locations — offsets of every embedded image",
  iprp: "Item properties",
  ipco: "Item property container",
  ispe: "Image spatial extent (dimensions)",
  colr: "Colour information / ICC profile",
  pitm: "Primary item",
  idat: "Item data",
  iref: "Item references (thumbnails, depth, auxiliary images)",
  udta: "User data — where vendors hide things",
  free: "Free space",
  skip: "Free space",
  wide: "Placeholder",
  uuid: "Vendor extension box (XMP frequently lives here)",
};

const BOX_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "meta", "iprp", "udta", "dinf", "edts", "mvex", "moof", "traf", "ipco"]);

function walkIsoBmff(bytes: Uint8Array, view: DataView): StructureReport {
  const nodes: StructureNode[] = [];
  const segments: CarvedSegment[] = [];
  const warnings: string[] = [];
  let boxCount = 0;

  const walk = (start: number, end: number, depth: number): void => {
    let offset = start;
    while (offset + 8 <= end && boxCount < 3000) {
      boxCount += 1;
      let size = u32be(view, offset);
      const type = fourcc(bytes, offset + 4);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        // 64-bit size; the high word is effectively always zero at these file sizes.
        size = Number(view.getBigUint64(offset + 8, false));
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) {
        warnings.push(`Box "${type}" at offset ${offset} declares a size of ${size}, which does not fit. The walk stopped in this branch.`);
        break;
      }
      nodes.push({
        offset,
        length: size,
        id: type,
        name: BOX_NAMES[type] ?? "Unrecognised box",
        detail: type === "ftyp" ? `brand "${ascii(bytes, offset + 8, 4)}"` : `${size} bytes`,
        depth,
      });
      if (type === "colr") segments.push({ name: `colr-${offset}`, description: "Colour information box — carries the ICC profile in HEIC and AVIF files.", offset: offset + headerSize, length: size - headerSize });
      if (type === "uuid") segments.push({ name: `uuid-${offset}`, description: "Vendor extension box — commonly the XMP packet in MP4 and MOV files.", offset: offset + headerSize, length: size - headerSize });
      if (type === "Exif" || type === "exif") segments.push({ name: `exif-${offset}`, description: "EXIF item inside the ISO container.", offset: offset + headerSize, length: size - headerSize });

      if (BOX_CONTAINERS.has(type)) {
        // `meta` carries a 4-byte version/flags word before its children.
        const childStart = offset + headerSize + (type === "meta" ? 4 : 0);
        walk(childStart, offset + size, depth + 1);
      }
      offset += size;
    }
  };

  walk(0, bytes.length, 0);
  const brand = ascii(bytes, 8, 4);
  return {
    container: `ISO base media (brand "${brand}") — HEIC, AVIF, MP4 and MOV all use this`,
    parsed: true,
    nodes,
    segments,
    warnings,
    totalBytes: bytes.length,
  };
}

function walkRiff(bytes: Uint8Array, view: DataView): StructureReport {
  const nodes: StructureNode[] = [];
  const segments: CarvedSegment[] = [];
  const form = ascii(bytes, 8, 4);
  nodes.push({ offset: 0, length: 12, id: "RIFF", name: `RIFF container, form "${form}"`, detail: `${u32be(view, 4)} bytes declared`, depth: 0 });
  let offset = 12;
  let guard = 0;
  while (offset + 8 <= bytes.length && guard < 2048) {
    guard += 1;
    const id = fourcc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    nodes.push({ offset, length: size + 8, id, name: riffChunkName(id), detail: `${size} bytes`, depth: 1 });
    if (id === "EXIF") segments.push({ name: "webp-exif", description: "EXIF chunk inside the WebP container.", offset: offset + 8, length: size });
    if (id === "XMP ") segments.push({ name: "webp-xmp", description: "XMP chunk inside the WebP container.", offset: offset + 8, length: size });
    if (id === "ICCP") segments.push({ name: "icc-profile", description: "Embedded ICC colour profile.", offset: offset + 8, length: size });
    offset += 8 + size + (size % 2);
  }
  return { container: `RIFF / ${form}`, parsed: true, nodes, segments, warnings: [], totalBytes: bytes.length };
}

function riffChunkName(id: string): string {
  switch (id) {
    case "VP8 ":
      return "Lossy image data";
    case "VP8L":
      return "Lossless image data";
    case "VP8X":
      return "Extended features header";
    case "ALPH":
      return "Alpha channel";
    case "ANIM":
    case "ANMF":
      return "Animation";
    case "EXIF":
      return "EXIF metadata";
    case "XMP ":
      return "XMP metadata";
    case "ICCP":
      return "ICC colour profile";
    default:
      return "Unrecognised chunk";
  }
}

/** Parses the container and reports every internal section. */
export async function walkStructure(blob: Blob): Promise<StructureReport> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch (err) {
    return {
      container: "unreadable",
      parsed: false,
      nodes: [],
      segments: [],
      warnings: [`The bytes could not be read for structural analysis: ${err instanceof Error ? err.message : String(err)}`],
      totalBytes: blob.size,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) {
    return { container: "too short to identify", parsed: false, nodes: [], segments: [], warnings: ["Fewer than 12 bytes — nothing to parse."], totalBytes: bytes.length };
  }

  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return walkJpeg(bytes, view);
    if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return walkPng(bytes, view);
    if (ascii(bytes, 4, 4) === "ftyp") return walkIsoBmff(bytes, view);
    if (ascii(bytes, 0, 4) === "RIFF") return walkRiff(bytes, view);
    if (ascii(bytes, 0, 3) === "GIF") {
      return {
        container: `GIF (${ascii(bytes, 0, 6)})`,
        parsed: false,
        nodes: [{ offset: 0, length: 13, id: "header", name: "GIF header and logical screen descriptor", detail: `${view.getUint16(6, true)}×${view.getUint16(8, true)}`, depth: 0 }],
        segments: [],
        warnings: ["GIF block-by-block walking is not implemented. The hex dump still covers every byte."],
        totalBytes: bytes.length,
      };
    }
    if (ascii(bytes, 0, 2) === "II" || ascii(bytes, 0, 2) === "MM") {
      return {
        container: "TIFF",
        parsed: false,
        nodes: [{ offset: 0, length: 8, id: "header", name: "TIFF header", detail: ascii(bytes, 0, 2) === "II" ? "little-endian" : "big-endian", depth: 0 }],
        segments: [{ name: "tiff-ifd", description: "The whole TIFF structure, which is itself the metadata container.", offset: 0, length: bytes.length }],
        warnings: ["Full TIFF IFD walking is not implemented here. The tag dump covers the readable entries."],
        totalBytes: bytes.length,
      };
    }
  } catch (err) {
    return {
      container: "recognised but the parse failed",
      parsed: false,
      nodes: [],
      segments: [],
      warnings: [`The structural walk threw: ${err instanceof Error ? err.message : String(err)}. Reported rather than hidden; the hex dump is unaffected.`],
      totalBytes: bytes.length,
    };
  }

  return {
    container: `unrecognised (first bytes ${HEX[bytes[0]]} ${HEX[bytes[1]]} ${HEX[bytes[2]]} ${HEX[bytes[3]]})`,
    parsed: false,
    nodes: [],
    segments: [],
    warnings: ["This container is not one this app knows how to parse. Every byte is still in the hex dump, and the file itself is archived untouched."],
    totalBytes: blob.size,
  };
}

/** The readable structural map that goes into the archive. */
export function structureText(report: StructureReport, label: string): string {
  const lines: string[] = [
    `FILE STRUCTURE — ${label}`,
    "=".repeat(78),
    `Container: ${report.container}`,
    `Total: ${report.totalBytes.toLocaleString("en-US")} bytes`,
    "",
    "Every offset below is a real position in the file. Seek to it and you will find exactly what the",
    "row describes — that is what makes this a parse rather than a guess.",
    "",
  ];
  if (!report.parsed) {
    lines.push("This container was NOT fully parsed. What follows is only what could be read with confidence.", "");
  }
  lines.push("offset       length       section", "-".repeat(78));
  for (const node of report.nodes) {
    const indent = "  ".repeat(node.depth);
    lines.push(
      `${String(node.offset).padStart(10)}   ${String(node.length).padStart(10)}   ${indent}${node.id}  ${node.name}`,
      node.detail ? `${" ".repeat(27)}${indent}${node.detail}` : ""
    );
  }
  if (report.segments.length > 0) {
    lines.push("", "CARVED OUT AS SEPARATE FILES", "-".repeat(78));
    for (const seg of report.segments) {
      lines.push("", `  ${seg.name}  —  bytes ${seg.offset} to ${seg.offset + seg.length - 1} (${seg.length.toLocaleString("en-US")} bytes)`, `    ${seg.description}`);
    }
  } else {
    lines.push("", "No metadata regions were found to carve. For a frame this app encoded itself that is expected — a", "canvas encode has no camera metadata to carry.");
  }
  if (report.warnings.length > 0) {
    lines.push("", "WHERE THE PARSE STOPPED", "-".repeat(78), ...report.warnings.map((w) => `  ! ${w}`));
  }
  return lines.filter((l) => l !== "").join("\n");
}
