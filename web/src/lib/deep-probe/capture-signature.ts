/**
 * The shape of a file, as opposed to the moment it was taken.
 *
 * A run used to keep every photograph it produced. Sweeping four cameras
 * through eight resolution rungs and six aspect ratios down two paths each is
 * well over a hundred files, and the great majority of them are the same file
 * twice: same container, same quantisation tables, same Huffman tables, same
 * marker order, same metadata layout, same dimensions. They differ only in what
 * the lens happened to be pointed at, which is the one thing this app is not
 * measuring.
 *
 * So each capture is reduced to a SHAPE — a short comparable ID built from the
 * parts of the file that describe the device — and a second capture with a
 * shape already on file is dropped rather than stored. The fact that two
 * different requests produced an identical shape is itself recorded, because
 * that is evidence: it says the camera answered two different asks with one
 * pipeline.
 *
 * What goes into a shape is the whole argument, so it is stated plainly:
 *
 *   IN  — container, pixel dimensions, chroma subsampling, every quantisation
 *         coefficient, every Huffman code-length table, the marker sequence in
 *         file order, the APP segment identifiers in file order, TIFF byte
 *         order, the directory sequence, the TAG ID sequence of each directory,
 *         the maker-note signature, and the colour profile's identity.
 *
 *   OUT — every value that describes the moment rather than the machine:
 *         timestamps, GPS, exposure, ISO, aperture, orientation, the file's
 *         byte length, and the compressed image data itself. Two photos of two
 *         different scenes from the same camera at the same setting SHOULD
 *         collapse to one shape. That is the entire point.
 *
 * The tag ID sequence deserves its own line, because it is the subtle one: the
 * IDs are layout and belong in the shape, while the values behind them are the
 * moment and must not be. A camera that writes its directories in a fixed order
 * is telling you about its firmware; the exposure time it wrote there is
 * telling you about the light.
 *
 * The ID is a comparison handle, not a security digest. It is short on purpose
 * so it can be read aloud and eyeballed in a table, and every component that
 * fed it is kept alongside so a match can always be argued with rather than
 * taken on trust.
 */

/**
 * How much of the file to read. Everything a shape needs sits before the
 * compressed data: on a camera JPEG the EXIF block with its thumbnail is the
 * largest part and rarely passes 64 KB. Half a megabyte is generous enough that
 * truncation is a real surprise, and small enough that shaping a capture costs
 * nothing next to decoding one.
 */
export const SIGNATURE_HEADER_BYTES = 512 * 1024;

export type ShapeComponent = {
  name: string;
  /** The component as it fed the hash. Kept verbatim so a match can be checked by eye. */
  value: string;
};

export type ShapeSignature = {
  /** Sixteen hex characters. A comparison handle, not a cryptographic digest. */
  id: string;
  container: string;
  width: number;
  height: number;
  components: ShapeComponent[];
  /** How many bytes were actually examined. */
  bytesExamined: number;
  /** True when the header slice ran out before the shape was complete. */
  truncated: boolean;
  /** Anything that could not be read, named rather than dropped. */
  notes: string[];
};

/* ------------------------------------------------------------------ hashing */

/**
 * FNV-1a, run twice with different offset bases and concatenated.
 *
 * Chosen for being trivially reimplementable: anyone checking this work can
 * write the same twelve lines and get the same ID, which a WebCrypto digest
 * would not allow here because it is asynchronous and this runs inside the
 * sweep's inner loop.
 */
function fnv1a(text: string, offset: number): number {
  let hash = offset >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    // Multi-byte characters would otherwise collide on their low byte alone.
    const high = text.charCodeAt(i) >> 8;
    if (high !== 0) {
      hash ^= high;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

/** The comparison handle for a set of shape components. */
export function shapeId(components: ShapeComponent[]): string {
  const joined = components.map((c) => `${c.name}=${c.value}`).join("\n");
  const a = fnv1a(joined, 0x811c9dc5);
  const b = fnv1a(joined, 0x9e3779b9);
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/* ------------------------------------------------------------------ readers */

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = at; i < Math.min(at + length, bytes.length); i += 1) {
    const b = bytes[i];
    if (b === 0) break;
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
  }
  return out;
}

/**
 * TIFF directory LAYOUT, with no value decoding whatsoever.
 *
 * Only the byte order, the order the directories appear in and the tag IDs each
 * one holds. The values are deliberately never touched: they are the moment,
 * and a shape that included them would treat two photographs of two different
 * scenes as two different devices.
 */
function tiffLayout(bytes: Uint8Array, tiffAt: number, notes: string[]): string {
  if (tiffAt + 8 > bytes.length) return "unreadable";
  const marker = ascii(bytes, tiffAt, 2);
  const little = marker === "II";
  if (!little && marker !== "MM") return "no TIFF header";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: string[] = [little ? "II" : "MM"];

  /** Reads one directory's tag IDs and returns the offset of the next. */
  const walk = (dirAt: number, name: string, depth: number): number => {
    if (depth > 3 || dirAt + 2 > bytes.length) return 0;
    const count = view.getUint16(dirAt, little);
    if (count > 512) {
      notes.push(`A TIFF directory at byte ${dirAt} claims ${count} entries, which is past anything plausible. Its layout was not folded into the shape.`);
      return 0;
    }
    const ids: number[] = [];
    const nested: { at: number; name: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      const entry = dirAt + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      const tag = view.getUint16(entry, little);
      ids.push(tag);
      // Sub-directory pointers. Their own tag layout is part of the shape; the
      // offsets they sit at are not, since those move with the payload size.
      if (tag === 0x8769) nested.push({ at: tiffAt + view.getUint32(entry + 8, little), name: "exif" });
      if (tag === 0x8825) nested.push({ at: tiffAt + view.getUint32(entry + 8, little), name: "gps" });
      if (tag === 0xa005) nested.push({ at: tiffAt + view.getUint32(entry + 8, little), name: "interop" });
      if (tag === 0x927c) {
        const length = view.getUint32(entry + 4, little);
        const at = length > 4 ? tiffAt + view.getUint32(entry + 8, little) : entry + 8;
        // The maker note's SIGNATURE is a firmware trait. Its contents are not
        // read: they are largely undocumented and largely about the moment.
        parts.push(`maker:${ascii(bytes, at, 12) || "unnamed"}`);
      }
    }
    parts.push(`${name}[${ids.join(",")}]`);
    for (const sub of nested) {
      if (sub.at + 2 <= bytes.length) walk(sub.at, sub.name, depth + 1);
    }
    const nextAt = dirAt + 2 + count * 12;
    return nextAt + 4 <= bytes.length ? view.getUint32(nextAt, little) : 0;
  };

  let dirRel = view.getUint32(tiffAt + 4, little);
  let index = 0;
  while (dirRel !== 0 && index < 4) {
    const next = walk(tiffAt + dirRel, `ifd${index}`, 0);
    if (next === 0 || next === dirRel) break;
    dirRel = next;
    index += 1;
  }
  return parts.join(" ");
}

/** Walks a JPEG's markers up to the first scan. No entropy data is touched. */
function jpegShape(bytes: Uint8Array, truncated: boolean, notes: string[]): { components: ShapeComponent[]; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const markers: string[] = ["D8"];
  const apps: string[] = [];
  const quant: string[] = [];
  const huffman: string[] = [];
  let frame = "none";
  let restart = "none";
  let icc = "none";
  let tiff = "none";
  let width = 0;
  let height = 0;

  let offset = 2;
  let guard = 0;
  while (offset + 3 < bytes.length && guard < 4096) {
    guard += 1;
    if (bytes[offset] !== 0xff) {
      notes.push(`Marker walk stopped at byte ${offset}: expected 0xFF, found 0x${bytes[offset].toString(16)}.`);
      break;
    }
    const marker = bytes[offset + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      markers.push(marker.toString(16).toUpperCase());
      break;
    }
    const declared = view.getUint16(offset + 2, false);
    const payloadAt = offset + 4;
    const payloadLength = declared - 2;
    if (payloadLength < 0 || payloadAt + payloadLength > bytes.length) {
      if (!truncated) notes.push(`Segment 0x${marker.toString(16)} at byte ${offset} runs past the end of the file.`);
      break;
    }
    markers.push(marker.toString(16).toUpperCase());

    if (marker >= 0xe0 && marker <= 0xef) {
      const signature = ascii(bytes, payloadAt, 12);
      apps.push(`APP${marker - 0xe0}:${signature || "unnamed"}`);
      if (marker === 0xe1 && signature.startsWith("Exif")) tiff = tiffLayout(bytes, payloadAt + 6, notes);
      if (marker === 0xe2 && signature.startsWith("ICC_PROFILE") && payloadLength > 146) {
        // The profile's identity, not its size: the size moves with the chunk
        // count on some writers while the profile itself is unchanged.
        const profileAt = payloadAt + 14;
        icc = `${ascii(bytes, profileAt + 16, 4)}>${ascii(bytes, profileAt + 20, 4)} cmm:${ascii(bytes, profileAt + 4, 4)} creator:${ascii(bytes, profileAt + 80, 4)} v${bytes[profileAt + 8]}.${(bytes[profileAt + 9] >> 4) & 0x0f}`;
      }
      if (marker === 0xe0 && signature.startsWith("JFIF") && payloadAt + 7 < bytes.length) {
        apps[apps.length - 1] += `/v${bytes[payloadAt + 5]}.${bytes[payloadAt + 6]}`;
      }
    } else if (marker === 0xdb) {
      let at = payloadAt;
      const end = payloadAt + payloadLength;
      while (at < end) {
        const spec = bytes[at];
        const precision = spec >> 4 === 0 ? 8 : 16;
        const step = precision === 8 ? 1 : 2;
        if (at + 1 + 64 * step > end) break;
        const values: number[] = [];
        for (let i = 0; i < 64; i += 1) values.push(precision === 8 ? bytes[at + 1 + i] : view.getUint16(at + 1 + i * 2, false));
        quant.push(`q${spec & 0x0f}/${precision}:${values.join(".")}`);
        at += 1 + 64 * step;
      }
    } else if (marker === 0xc4) {
      let at = payloadAt;
      const end = payloadAt + payloadLength;
      while (at + 17 <= end) {
        const spec = bytes[at];
        const counts: number[] = [];
        let total = 0;
        for (let i = 0; i < 16; i += 1) {
          counts.push(bytes[at + 1 + i]);
          total += bytes[at + 1 + i];
        }
        huffman.push(`h${spec >> 4}${spec & 0x0f}:${counts.join(".")}`);
        at += 17 + total;
      }
    } else if (marker === 0xdd) {
      restart = payloadLength >= 2 ? String(view.getUint16(payloadAt, false)) : "unreadable";
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (payloadLength >= 6) {
        height = view.getUint16(payloadAt + 1, false);
        width = view.getUint16(payloadAt + 3, false);
        const componentCount = bytes[payloadAt + 5];
        const sampling: string[] = [];
        for (let i = 0; i < componentCount; i += 1) {
          const at = payloadAt + 6 + i * 3;
          if (at + 2 >= bytes.length) break;
          sampling.push(`${bytes[at]}:${bytes[at + 1] >> 4}x${bytes[at + 1] & 0x0f}/q${bytes[at + 2]}`);
        }
        frame = `SOF${marker - 0xc0} p${bytes[payloadAt]} ${width}x${height} ${sampling.join(" ")}`;
      }
    }
    offset += declared + 2;
  }

  return {
    width,
    height,
    components: [
      { name: "container", value: "jpeg" },
      { name: "markers", value: markers.join(" ") },
      { name: "app-segments", value: apps.join(" ") || "none" },
      { name: "frame", value: frame },
      { name: "quant-tables", value: quant.join(" ") || "none" },
      { name: "huffman-tables", value: huffman.join(" ") || "none" },
      { name: "restart-interval", value: restart },
      { name: "icc-identity", value: icc },
      { name: "tiff-layout", value: tiff },
    ],
  };
}

/** PNG: the chunk type sequence and the header fields, which is all the shape there is. */
function pngShape(bytes: Uint8Array): { components: ShapeComponent[]; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: string[] = [];
  let width = 0;
  let height = 0;
  let header = "unreadable";
  let offset = 8;
  let guard = 0;
  while (offset + 8 <= bytes.length && guard < 512) {
    guard += 1;
    const length = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    chunks.push(type);
    if (type === "IHDR" && offset + 8 + 13 <= bytes.length) {
      width = view.getUint32(offset + 8, false);
      height = view.getUint32(offset + 12, false);
      header = `${width}x${height} depth${bytes[offset + 16]} colour${bytes[offset + 17]} compress${bytes[offset + 18]} filter${bytes[offset + 19]} interlace${bytes[offset + 20]}`;
    }
    if (type === "IDAT" || type === "IEND") break;
    offset += 12 + length;
  }
  return {
    width,
    height,
    components: [
      { name: "container", value: "png" },
      { name: "chunks", value: chunks.join(" ") },
      { name: "ihdr", value: header },
    ],
  };
}

/** ISOBMFF (HEIC, HEIF, MP4, MOV): the top-level box sequence and the brand list. */
function isoShape(bytes: Uint8Array): { components: ShapeComponent[]; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: string[] = [];
  let brands = "none";
  let offset = 0;
  let guard = 0;
  while (offset + 8 <= bytes.length && guard < 256) {
    guard += 1;
    const size = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    boxes.push(type);
    if (type === "ftyp" && offset + 16 <= bytes.length) {
      const list: string[] = [ascii(bytes, offset + 8, 4)];
      for (let at = offset + 16; at + 4 <= Math.min(offset + size, bytes.length); at += 4) list.push(ascii(bytes, at, 4));
      brands = list.join(",");
    }
    if (size < 8) break;
    offset += size;
  }
  return {
    width: 0,
    height: 0,
    components: [
      { name: "container", value: "isobmff" },
      { name: "boxes", value: boxes.join(" ") },
      { name: "brands", value: brands },
    ],
  };
}

function detectContainer(bytes: Uint8Array): "jpeg" | "png" | "isobmff" | "unknown" {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 12 && ascii(bytes, 4, 4) === "ftyp") return "isobmff";
  return "unknown";
}

/** Reads a shape out of bytes already in hand. */
export function shapeFromBytes(bytes: Uint8Array, truncated: boolean): ShapeSignature {
  const notes: string[] = [];
  const container = detectContainer(bytes);
  let read: { components: ShapeComponent[]; width: number; height: number };
  if (container === "jpeg") read = jpegShape(bytes, truncated, notes);
  else if (container === "png") read = pngShape(bytes);
  else if (container === "isobmff") read = isoShape(bytes);
  else {
    notes.push("The container was not recognised, so the shape is the first bytes and nothing else. Two files like this are only ever treated as the same shape when their leading bytes match exactly.");
    read = {
      width: 0,
      height: 0,
      components: [
        { name: "container", value: "unknown" },
        { name: "leading-bytes", value: Array.from(bytes.subarray(0, 32), (b) => b.toString(16).padStart(2, "0")).join("") },
      ],
    };
  }
  if (truncated) {
    notes.push(
      `Only the first ${(SIGNATURE_HEADER_BYTES / 1024).toFixed(0)} KB were examined and the shape was still incomplete at that point. This shape is therefore based on less than the whole header, and two files sharing it are less firmly identical than the others.`
    );
  }
  return {
    id: shapeId(read.components),
    container,
    width: read.width,
    height: read.height,
    components: read.components,
    bytesExamined: bytes.length,
    truncated,
    notes,
  };
}

/** Reads a shape from a blob, examining only as much of the front as it needs. */
export async function readShape(blob: Blob): Promise<ShapeSignature> {
  const wanted = Math.min(blob.size, SIGNATURE_HEADER_BYTES);
  const bytes = new Uint8Array(await blob.slice(0, wanted).arrayBuffer());
  return shapeFromBytes(bytes, blob.size > wanted);
}

/* ------------------------------------------------------------------- ledger */

export type ShapeSighting = {
  /** Camera and production path, which is the scope a shape is unique within. */
  scope: string;
  asked: string;
  at: string;
};

export type ShapeGroup = {
  id: string;
  scope: string;
  /** The one capture kept for this shape. */
  keptSlug: string;
  keptAsked: string;
  container: string;
  width: number;
  height: number;
  /** Every later request that produced this same shape and was therefore dropped. */
  repeats: ShapeSighting[];
  /** Bytes not stored because of those repeats. */
  bytesSaved: number;
};

export type ShapeVerdict = {
  /** True when this shape had not been seen before under this scope. */
  keep: boolean;
  shape: ShapeSignature;
  group: ShapeGroup;
  /**
   * The capture this one repeated, and why it was not stored.
   *
   * Null on a kept capture, where there is nothing to say. Carrying the reason
   * here rather than leaving the caller to compose one means the wording that
   * ends up on the row is written once, next to the comparison that justifies
   * it — a dropped file explaining itself in two different voices would be two
   * chances to get the claim wrong.
   */
  repeat: { sameAsSlug: string; reason: string } | null;
};

export type ShapeLedger = {
  /** Decides whether a capture is worth keeping, and records it either way. */
  consider: (input: { slug: string; blob: Blob; scope: string; asked: string }) => Promise<ShapeVerdict>;
  groups: () => ShapeGroup[];
  /** Shapes seen under more than one scope, which is a finding rather than a duplicate. */
  sharedShapes: () => { id: string; scopes: string[] }[];
  keptCount: () => number;
  droppedCount: () => number;
  bytesSaved: () => number;
};

/** The scope a shape has to be unique within: one camera, one production path. */
export function shapeScope(deviceLabel: string | null, path: string): string {
  return `${deviceLabel ?? "no camera"} · ${path}`;
}

/**
 * Tracks which shapes have already been kept.
 *
 * Scoping by camera and path rather than globally is deliberate. The same
 * quantisation tables coming out of two different lenses is a real and
 * interesting finding, and collapsing it would erase the evidence for it — so
 * each scope keeps its own first copy, and shapes appearing in several scopes
 * are reported separately as exactly that.
 */
export function createShapeLedger(): ShapeLedger {
  const groups = new Map<string, ShapeGroup>();
  const scopesById = new Map<string, Set<string>>();
  let kept = 0;
  let dropped = 0;
  let saved = 0;

  return {
    consider: async ({ slug, blob, scope, asked }) => {
      const shape = await readShape(blob);
      const key = `${scope}::${shape.id}`;
      const seenScopes = scopesById.get(shape.id) ?? new Set<string>();
      seenScopes.add(scope);
      scopesById.set(shape.id, seenScopes);

      const existing = groups.get(key);
      if (existing) {
        existing.repeats.push({ scope, asked, at: new Date().toISOString() });
        existing.bytesSaved += blob.size;
        dropped += 1;
        saved += blob.size;
        return {
          keep: false,
          shape,
          group: existing,
          repeat: {
            sameAsSlug: existing.keptSlug,
            reason:
              `Byte-shape identical to ${existing.keptSlug} (shape ${shape.id}): same container, same ${shape.width}×${shape.height} frame, same quantisation and Huffman tables, same marker order, same metadata layout. ` +
              `It was a different request and a different moment, and both of those are recorded in the row — but the file itself would have been a second copy of one already held, so it was not kept.`,
          },
        };
      }

      const group: ShapeGroup = {
        id: shape.id,
        scope,
        keptSlug: slug,
        keptAsked: asked,
        container: shape.container,
        width: shape.width,
        height: shape.height,
        repeats: [],
        bytesSaved: 0,
      };
      groups.set(key, group);
      kept += 1;
      return { keep: true, shape, group, repeat: null };
    },
    groups: () => [...groups.values()],
    sharedShapes: () =>
      [...scopesById.entries()].filter(([, scopes]) => scopes.size > 1).map(([id, scopes]) => ({ id, scopes: [...scopes] })),
    keptCount: () => kept,
    droppedCount: () => dropped,
    bytesSaved: () => saved,
  };
}

/** The consolidation rule, said once, in the words the archive uses. */
export const CONSOLIDATION_POLICY: string[] = [
  "WHY THERE ARE FEWER PHOTOS THAN REQUESTS",
  "-".repeat(78),
  "Every still taken is reduced to a SHAPE before it is kept: container, pixel dimensions, chroma",
  "subsampling, all 64 coefficients of every quantisation table, every Huffman code-length table, the",
  "marker sequence in file order, the APP segment identifiers, the TIFF byte order, the directory order,",
  "the tag IDs each directory holds, the maker-note signature and the colour profile's identity.",
  "",
  "A still whose shape is already on file for that camera and that production path is NOT stored. The",
  "request still ran, the row below is still complete, and the identity is recorded on the row — a second",
  "copy of a file already held is not evidence, it is weight.",
  "",
  "What a shape deliberately EXCLUDES is as important as what it includes: timestamps, GPS, exposure, ISO,",
  "aperture, orientation, the file's length and the compressed image data itself. Those describe the",
  "moment, not the machine. Two photographs of two different scenes from one camera at one setting are",
  "MEANT to collapse to a single shape — that collapse is the measurement, not a loss.",
  "",
  "Consequences worth stating plainly: a dropped still is never counted as one that was taken, dropping is",
  "never described as a camera limitation, and shapes are compared within one camera and one path at a",
  "time. A shape appearing under two different cameras is listed separately as a finding, because two",
  "lenses sharing one encoder pipeline is a fact about the device rather than a duplicate.",
];
