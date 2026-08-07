/**
 * The encoder signature of a JPEG.
 *
 * A JPEG's metadata says what the camera claims. Its *tables* say what actually
 * wrote it, and they are far harder to forge convincingly because they are not
 * a field anyone thinks to edit — they are the compressor's own state. The
 * quantisation tables in particular are the strongest single fingerprint in the
 * file: Apple's camera encoder, Safari's canvas encoder and libjpeg at quality
 * 0.92 produce three visibly different 8x8 matrices for the same picture.
 *
 * Everything here is read out of the bytes. Where a table is absent it is
 * reported absent; nothing is filled in from a reference set. The one derived
 * number — the approximate libjpeg-equivalent quality — is explicitly marked as
 * meaningful only for libjpeg-family encoders and meaningless for Apple's, since
 * Apple does not scale the Annex K base tables.
 */

/** JPEG zig-zag index to natural 8x8 position. Tables are stored zig-zagged. */
const ZIGZAG: number[] = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57,
  50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** ITU T.81 Annex K luminance base table — what libjpeg scales by quality. */
const ANNEX_K_LUMA: number[] = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22,
  37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Annex K chrominance base table. */
const ANNEX_K_CHROMA: number[] = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/**
 * Annex K Huffman code-length counts. A DHT whose BITS array matches one of
 * these is the textbook table every encoder ships with; anything else was
 * computed from the image, which is itself a strong encoder trait.
 */
const ANNEX_K_BITS: Record<string, number[]> = {
  "dc-luma": [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  "dc-chroma": [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  "ac-luma": [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  "ac-chroma": [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
};

export type QuantTable = {
  /** Table slot as written in the file (0-3). Slot 0 is luma by convention. */
  id: number;
  /** 8-bit or 16-bit coefficients. */
  precisionBits: 8 | 16;
  /** All 64 coefficients in the order they appear in the file (zig-zag). */
  zigzag: number[];
  /** The same 64 values rearranged into reading order, row by row. */
  natural: number[];
  /** Sum of all 64 — a quick comparison handle. */
  sum: number;
  /** Matches the unscaled Annex K base table exactly. */
  isAnnexKBase: boolean;
  /**
   * Approximate libjpeg quality that would produce this table. Null when the
   * table does not look like a scaled Annex K table at all, which is itself
   * informative — Apple's camera encoder does not.
   */
  libjpegQualityEstimate: number | null;
  offset: number;
};

export type HuffmanTable = {
  /** 0 = DC, 1 = AC. */
  tableClass: 0 | 1;
  id: number;
  /** Number of codes of each length 1-16. */
  bits: number[];
  totalCodes: number;
  /** Which Annex K table this matches, or null when it was computed for the image. */
  annexKMatch: string | null;
  offset: number;
};

export type AppSegment = {
  marker: string;
  /** Segment length as declared in the file, excluding the 2 marker bytes. */
  declaredLength: number;
  /** Printable leading bytes — the payload's own identifier. */
  signature: string;
  offset: number;
};

export type FrameInfo = {
  marker: string;
  /** baseline / extended sequential / progressive / lossless. */
  mode: string;
  precisionBits: number;
  width: number;
  height: number;
  components: { id: number; hSampling: number; vSampling: number; quantTableId: number }[];
  /** 4:2:0, 4:2:2, 4:4:4, 4:4:0 or the raw factors when it is none of those. */
  subsampling: string;
  offset: number;
};

export type ThumbnailInfo = {
  offset: number;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Sums of the thumbnail's own quantisation tables — often different from the main image's. */
  quantSums: number[];
  subsampling: string | null;
};

export type IccSummary = {
  bytes: number;
  /** The `desc` tag text, which is the human-readable profile name. */
  description: string | null;
  colorSpace: string;
  connectionSpace: string;
  profileClass: string;
  creator: string;
  renderingIntent: string;
  version: string;
  /** The profile's own embedded MD5 field, when the writer set it. Not our checksum. */
  embeddedProfileId: string | null;
  /** How many APP2 chunks the profile was split across. */
  chunks: number;
};

export type JpegEncoderReport = {
  isJpeg: boolean;
  totalBytes: number;
  appSegments: AppSegment[];
  /** True when an APP0/JFIF header is present at all — many camera JPEGs have none. */
  hasJfif: boolean;
  jfifVersion: string | null;
  frame: FrameInfo | null;
  quantTables: QuantTable[];
  huffmanTables: HuffmanTable[];
  /** How many SOS markers: 1 for baseline, many for progressive. */
  scanCount: number;
  restartInterval: number | null;
  thumbnail: ThumbnailInfo | null;
  icc: IccSummary | null;
  /** Bytes present after the EOI marker, which nothing should normally write. */
  trailingBytes: number;
  trailingHex: string | null;
  comments: string[];
  warnings: string[];
};

function u16(view: DataView, at: number): number {
  return view.getUint16(at, false);
}

function printable(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = at; i < Math.min(at + length, bytes.length); i += 1) {
    const b = bytes[i];
    if (b === 0) break;
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
  }
  return out;
}

function toNatural(zigzag: number[]): number[] {
  const natural = new Array<number>(64).fill(0);
  for (let i = 0; i < 64; i += 1) natural[ZIGZAG[i]] = zigzag[i];
  return natural;
}

function sameArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Recovers the libjpeg quality setting from a quantisation table, by inverting
 * the scaling libjpeg applies to the Annex K base table.
 *
 * The median ratio is used rather than the mean because coefficients clamped at
 * 255 would otherwise drag the estimate down. Returns null when the ratios are
 * too inconsistent to be a scaled Annex K table — Apple's encoder lands here,
 * and that negative result is worth more than a fabricated number.
 */
function estimateLibjpegQuality(natural: number[], base: number[]): number | null {
  const ratios: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    if (base[i] <= 0 || natural[i] <= 0 || natural[i] >= 255) continue;
    ratios.push((natural[i] * 100) / base[i]);
  }
  if (ratios.length < 20) return null;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];

  // Consistency gate: a genuinely scaled table has one scale factor throughout.
  const spread = ratios.filter((r) => Math.abs(r - median) <= Math.max(12, median * 0.35)).length / ratios.length;
  if (spread < 0.75) return null;

  const quality = median <= 100 ? (200 - median) / 2 : 5000 / median;
  if (!Number.isFinite(quality) || quality <= 0 || quality > 100) return null;
  return Math.round(quality * 10) / 10;
}

function subsamplingLabel(components: FrameInfo["components"]): string {
  if (components.length === 1) return "4:0:0 (single channel, greyscale)";
  const luma = components[0];
  const raw = components.map((c) => `${c.hSampling}x${c.vSampling}`).join(",");
  const chromaFlat = components.slice(1).every((c) => c.hSampling === 1 && c.vSampling === 1);
  if (chromaFlat && luma.hSampling === 2 && luma.vSampling === 2) return `4:2:0 (${raw})`;
  if (chromaFlat && luma.hSampling === 2 && luma.vSampling === 1) return `4:2:2 (${raw})`;
  if (chromaFlat && luma.hSampling === 1 && luma.vSampling === 1) return `4:4:4 (${raw})`;
  if (chromaFlat && luma.hSampling === 1 && luma.vSampling === 2) return `4:4:0 (${raw})`;
  return `non-standard sampling factors ${raw}`;
}

const SOF_MODES: Record<number, string> = {
  0xc0: "baseline sequential DCT, Huffman",
  0xc1: "extended sequential DCT, Huffman",
  0xc2: "progressive DCT, Huffman",
  0xc3: "lossless, Huffman",
  0xc9: "extended sequential DCT, arithmetic",
  0xca: "progressive DCT, arithmetic",
};

const ICC_CLASSES: Record<string, string> = {
  scnr: "input device",
  mntr: "display device",
  prtr: "output device",
  link: "device link",
  spac: "colour space conversion",
  abst: "abstract",
  nmcl: "named colour",
};

const ICC_INTENTS: string[] = ["perceptual", "media-relative colorimetric", "saturation", "ICC-absolute colorimetric"];

function parseIcc(payload: Uint8Array, chunks: number): IccSummary | null {
  if (payload.length < 132) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const tagCount = view.getUint32(128, false);
  let description: string | null = null;
  if (tagCount > 0 && tagCount < 512) {
    for (let i = 0; i < tagCount; i += 1) {
      const entry = 132 + i * 12;
      if (entry + 12 > payload.length) break;
      const sig = printable(payload, entry, 4);
      const offset = view.getUint32(entry + 4, false);
      const size = view.getUint32(entry + 8, false);
      if (sig !== "desc" || offset + size > payload.length) continue;
      const type = printable(payload, offset, 4);
      // `desc` is a mluc in v4 profiles and a textDescription in v2.
      if (type === "mluc" && offset + 28 <= payload.length) {
        const strLength = view.getUint32(offset + 20, false);
        const strOffset = view.getUint32(offset + 24, false);
        let text = "";
        for (let j = 0; j + 1 < strLength && offset + strOffset + j + 1 < payload.length; j += 2) {
          const code = view.getUint16(offset + strOffset + j, false);
          if (code === 0) break;
          text += String.fromCharCode(code);
        }
        description = text || null;
      } else if (type === "desc" && offset + 12 <= payload.length) {
        const asciiLength = view.getUint32(offset + 8, false);
        description = printable(payload, offset + 12, Math.min(asciiLength, 128)) || null;
      }
      break;
    }
  }

  let embeddedProfileId: string | null = null;
  let nonZero = false;
  let hex = "";
  for (let i = 84; i < 100; i += 1) {
    if (payload[i] !== 0) nonZero = true;
    hex += payload[i].toString(16).padStart(2, "0");
  }
  if (nonZero) embeddedProfileId = hex;

  const classSig = printable(payload, 12, 4);
  const intent = view.getUint32(64, false);
  return {
    bytes: payload.length,
    description,
    colorSpace: printable(payload, 16, 4).trim() || "(none)",
    connectionSpace: printable(payload, 20, 4).trim() || "(none)",
    profileClass: `${classSig}${ICC_CLASSES[classSig] ? ` — ${ICC_CLASSES[classSig]}` : ""}`,
    creator: printable(payload, 80, 4).trim() || "(none)",
    renderingIntent: ICC_INTENTS[intent] ?? `unrecognised value ${intent}`,
    version: `${payload[8]}.${(payload[9] >> 4) & 0x0f}.${payload[9] & 0x0f}`,
    embeddedProfileId,
    chunks,
  };
}

/**
 * Reads the tables out of a JPEG. `depth` guards the one recursive call, which
 * is the embedded EXIF thumbnail — itself a complete JPEG with its own tables.
 */
function parseJpegBytes(bytes: Uint8Array, depth: number): JpegEncoderReport {
  const report: JpegEncoderReport = {
    isJpeg: bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8,
    totalBytes: bytes.length,
    appSegments: [],
    hasJfif: false,
    jfifVersion: null,
    frame: null,
    quantTables: [],
    huffmanTables: [],
    scanCount: 0,
    restartInterval: null,
    thumbnail: null,
    icc: null,
    trailingBytes: 0,
    trailingHex: null,
    comments: [],
    warnings: [],
  };
  if (!report.isJpeg) {
    report.warnings.push("Not a JPEG — no SOI marker. Nothing in this report applies.");
    return report;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iccChunks: Uint8Array[] = [];
  let offset = 2;
  let guard = 0;
  let eoiAt: number | null = null;

  while (offset + 1 < bytes.length && guard < 8192) {
    guard += 1;
    if (bytes[offset] !== 0xff) {
      report.warnings.push(`Expected a marker at byte ${offset}, found 0x${bytes[offset].toString(16)}. Table reading stopped here.`);
      break;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) {
      eoiAt = offset;
      offset += 2;
      break;
    }
    if (offset + 4 > bytes.length) {
      report.warnings.push(`A marker at byte ${offset} has no room for its length field. The file is truncated.`);
      break;
    }
    const declared = u16(view, offset + 2);
    const payloadAt = offset + 4;
    const payloadLength = declared - 2;
    if (payloadLength < 0 || payloadAt + payloadLength > bytes.length) {
      report.warnings.push(`Segment 0x${marker.toString(16)} at byte ${offset} declares ${declared} bytes, which runs past the end of the file.`);
      break;
    }

    if (marker >= 0xe0 && marker <= 0xef) {
      const signature = printable(bytes, payloadAt, 16);
      report.appSegments.push({ marker: `APP${marker - 0xe0}`, declaredLength: declared, signature, offset });
      if (marker === 0xe0 && signature.startsWith("JFIF")) {
        report.hasJfif = true;
        if (payloadAt + 7 < bytes.length) report.jfifVersion = `${bytes[payloadAt + 5]}.${String(bytes[payloadAt + 6]).padStart(2, "0")}`;
      }
      if (marker === 0xe2 && signature.startsWith("ICC_PROFILE") && payloadLength > 14) {
        iccChunks.push(bytes.subarray(payloadAt + 14, payloadAt + payloadLength));
      }
      if (marker === 0xe1 && signature.startsWith("Exif") && depth === 0) {
        report.thumbnail = readThumbnail(bytes, view, payloadAt + 6);
      }
    } else if (marker === 0xdb) {
      let at = payloadAt;
      const end = payloadAt + payloadLength;
      while (at < end) {
        const spec = bytes[at];
        const precisionBits: 8 | 16 = (spec >> 4) === 0 ? 8 : 16;
        const id = spec & 0x0f;
        const step = precisionBits === 8 ? 1 : 2;
        if (at + 1 + 64 * step > end) {
          report.warnings.push(`A quantisation table at byte ${at} is shorter than its 64 coefficients. It was not read.`);
          break;
        }
        const zigzag: number[] = [];
        for (let i = 0; i < 64; i += 1) {
          zigzag.push(precisionBits === 8 ? bytes[at + 1 + i] : u16(view, at + 1 + i * 2));
        }
        const natural = toNatural(zigzag);
        const base = id === 0 ? ANNEX_K_LUMA : ANNEX_K_CHROMA;
        report.quantTables.push({
          id,
          precisionBits,
          zigzag,
          natural,
          sum: natural.reduce((s, v) => s + v, 0),
          isAnnexKBase: sameArray(natural, base),
          libjpegQualityEstimate: estimateLibjpegQuality(natural, base),
          offset: at,
        });
        at += 1 + 64 * step;
      }
    } else if (marker === 0xc4) {
      let at = payloadAt;
      const end = payloadAt + payloadLength;
      while (at + 17 <= end) {
        const spec = bytes[at];
        const tableClass: 0 | 1 = (spec >> 4) === 0 ? 0 : 1;
        const id = spec & 0x0f;
        const bits: number[] = [];
        let totalCodes = 0;
        for (let i = 0; i < 16; i += 1) {
          bits.push(bytes[at + 1 + i]);
          totalCodes += bytes[at + 1 + i];
        }
        let annexKMatch: string | null = null;
        for (const [name, reference] of Object.entries(ANNEX_K_BITS)) {
          if (sameArray(bits, reference)) annexKMatch = name;
        }
        report.huffmanTables.push({ tableClass, id, bits, totalCodes, annexKMatch, offset: at });
        at += 17 + totalCodes;
      }
    } else if (marker === 0xdd) {
      report.restartInterval = payloadLength >= 2 ? u16(view, payloadAt) : null;
    } else if (marker === 0xfe) {
      report.comments.push(printable(bytes, payloadAt, Math.min(payloadLength, 200)));
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (payloadLength >= 6) {
        const componentCount = bytes[payloadAt + 5];
        const components: FrameInfo["components"] = [];
        for (let i = 0; i < componentCount; i += 1) {
          const at = payloadAt + 6 + i * 3;
          if (at + 2 >= bytes.length) break;
          components.push({ id: bytes[at], hSampling: bytes[at + 1] >> 4, vSampling: bytes[at + 1] & 0x0f, quantTableId: bytes[at + 2] });
        }
        report.frame = {
          marker: `SOF${marker - 0xc0}`,
          mode: SOF_MODES[marker] ?? `unrecognised frame type 0x${marker.toString(16)}`,
          precisionBits: bytes[payloadAt],
          height: u16(view, payloadAt + 1),
          width: u16(view, payloadAt + 3),
          components,
          subsampling: subsamplingLabel(components),
          offset,
        };
      }
    } else if (marker === 0xda) {
      report.scanCount += 1;
      // Skip the entropy-coded data to reach the next real marker.
      let scan = payloadAt + payloadLength;
      while (scan + 1 < bytes.length) {
        if (bytes[scan] === 0xff && bytes[scan + 1] !== 0x00 && !(bytes[scan + 1] >= 0xd0 && bytes[scan + 1] <= 0xd7)) break;
        scan += 1;
      }
      offset = scan;
      continue;
    }
    offset += declared + 2;
  }

  if (eoiAt != null) {
    report.trailingBytes = bytes.length - (eoiAt + 2);
    if (report.trailingBytes > 0) {
      let hex = "";
      for (let i = eoiAt + 2; i < Math.min(eoiAt + 2 + 64, bytes.length); i += 1) hex += `${bytes[i].toString(16).padStart(2, "0")} `;
      report.trailingHex = hex.trim();
    }
  } else {
    report.warnings.push("No EOI marker was found, so this file does not end where a JPEG should. Trailing-byte count is not reported.");
  }

  if (iccChunks.length > 0) {
    const total = iccChunks.reduce((sum, c) => sum + c.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const chunk of iccChunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    report.icc = parseIcc(joined, iccChunks.length);
  }

  return report;
}

/** Locates the EXIF thumbnail and reads its own tables — it is a whole JPEG in there. */
function readThumbnail(bytes: Uint8Array, view: DataView, tiff: number): ThumbnailInfo | null {
  try {
    if (tiff + 8 > bytes.length) return null;
    const little = printable(bytes, tiff, 2) === "II";
    const ifd0 = tiff + view.getUint32(tiff + 4, little);
    if (ifd0 + 2 > bytes.length) return null;
    const count0 = view.getUint16(ifd0, little);
    const nextAt = ifd0 + 2 + count0 * 12;
    if (nextAt + 4 > bytes.length) return null;
    const ifd1Rel = view.getUint32(nextAt, little);
    if (ifd1Rel === 0) return null;
    const ifd1 = tiff + ifd1Rel;
    if (ifd1 + 2 > bytes.length) return null;
    const count1 = view.getUint16(ifd1, little);
    let thumbOffset: number | null = null;
    let thumbLength: number | null = null;
    for (let i = 0; i < count1; i += 1) {
      const entry = ifd1 + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      const tag = view.getUint16(entry, little);
      if (tag === 0x0201) thumbOffset = tiff + view.getUint32(entry + 8, little);
      if (tag === 0x0202) thumbLength = view.getUint32(entry + 8, little);
    }
    if (thumbOffset == null || thumbLength == null || thumbLength <= 0 || thumbOffset + thumbLength > bytes.length) return null;
    const inner = parseJpegBytes(bytes.subarray(thumbOffset, thumbOffset + thumbLength), 1);
    return {
      offset: thumbOffset,
      bytes: thumbLength,
      width: inner.frame?.width ?? null,
      height: inner.frame?.height ?? null,
      quantSums: inner.quantTables.map((t) => t.sum),
      subsampling: inner.frame?.subsampling ?? null,
    };
  } catch {
    return null;
  }
}

/** Reads the encoder signature out of a blob. */
export async function readJpegEncoder(blob: Blob): Promise<JpegEncoderReport> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return parseJpegBytes(bytes, 0);
}

/** Exposed for tests: the same parse over bytes already in hand. */
export function readJpegEncoderBytes(bytes: Uint8Array): JpegEncoderReport {
  return parseJpegBytes(bytes, 0);
}

function grid(values: number[]): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 8; r += 1) {
    rows.push(
      values
        .slice(r * 8, r * 8 + 8)
        .map((v) => String(v).padStart(4))
        .join("")
    );
  }
  return rows;
}

/** The readable encoder report that goes into the archive. */
export function encoderText(report: JpegEncoderReport, label: string): string {
  const lines: string[] = [`ENCODER SIGNATURE — ${label}`, "=".repeat(78), ""];
  if (!report.isJpeg) {
    lines.push(
      "This file is not a JPEG, so it has no JPEG tables.",
      "",
      "That is a statement about the container, not a failure: HEIC and MP4 captures are analysed in the",
      "structure map instead. Nothing here is missing that could have been present."
    );
    return lines.join("\n");
  }

  lines.push(
    "The tables below are the compressor's own state, not a metadata field. They are the strongest",
    "encoder fingerprint in the file and nearly the only part of it nobody thinks to edit.",
    "",
    `Total size          ${report.totalBytes.toLocaleString("en-US")} bytes`,
    `APP0/JFIF present   ${report.hasJfif ? `yes, version ${report.jfifVersion ?? "unreadable"}` : "NO — common in camera JPEGs, and its absence is itself a signal"}`,
    ""
  );

  lines.push("APP SEGMENTS, IN FILE ORDER", "-".repeat(78));
  if (report.appSegments.length === 0) lines.push("  (none — unusual, and worth noting)");
  for (const seg of report.appSegments) {
    lines.push(`  ${seg.marker.padEnd(6)} at byte ${String(seg.offset).padStart(8)}  ${String(seg.declaredLength).padStart(7)} bytes  "${seg.signature}"`);
  }
  lines.push("", "The ORDER matters as much as the contents: encoders emit these in a fixed sequence.", "");

  if (report.frame) {
    lines.push(
      "FRAME",
      "-".repeat(78),
      `  ${report.frame.marker} — ${report.frame.mode}`,
      `  ${report.frame.width} x ${report.frame.height}, ${report.frame.precisionBits}-bit, ${report.frame.components.length} component(s)`,
      `  chroma subsampling  ${report.frame.subsampling}`,
      `  scans               ${report.scanCount} (1 = baseline; several = progressive)`,
      `  restart interval    ${report.restartInterval != null ? `${report.restartInterval} MCU rows` : "none set"}`,
      ""
    );
    for (const c of report.frame.components) {
      lines.push(`    component ${c.id}: sampling ${c.hSampling}x${c.vSampling}, quantisation table ${c.quantTableId}`);
    }
    lines.push("");
  } else {
    lines.push("FRAME", "-".repeat(78), "  No frame header was found. The file is truncated or malformed.", "");
  }

  lines.push("QUANTISATION TABLES — ALL 64 COEFFICIENTS", "=".repeat(78), "");
  if (report.quantTables.length === 0) {
    lines.push("  No DQT segment. For a JPEG this should not happen and is reported rather than glossed over.", "");
  }
  for (const table of report.quantTables) {
    lines.push(
      `── table ${table.id} (${table.id === 0 ? "luma" : "chroma"}), ${table.precisionBits}-bit, at byte ${table.offset} ──`,
      "",
      "  In reading order (row by row) — this is the form to compare:",
      ...grid(table.natural).map((r) => `   ${r}`),
      "",
      "  In file order (zig-zag), as the bytes actually appear:",
      `   ${table.zigzag.join(" ")}`,
      "",
      `  sum ${table.sum}`,
      `  identical to the Annex K base table: ${table.isAnnexKBase ? "YES — unscaled textbook table" : "no"}`,
      `  approximate libjpeg quality: ${
        table.libjpegQualityEstimate != null
          ? `${table.libjpegQualityEstimate} — meaningful ONLY if a libjpeg-family encoder wrote this (Chrome's canvas does; Apple's camera does not)`
          : "not a scaled Annex K table, so no quality number is claimed. Apple's camera encoder lands here — the absence of an estimate is itself the finding."
      }`,
      ""
    );
  }

  lines.push("HUFFMAN TABLES", "-".repeat(78), "");
  if (report.huffmanTables.length === 0) lines.push("  No DHT segment found.", "");
  for (const table of report.huffmanTables) {
    lines.push(
      `  ${table.tableClass === 0 ? "DC" : "AC"} table ${table.id} at byte ${table.offset} — ${table.totalCodes} codes`,
      `    code lengths 1-16: ${table.bits.join(" ")}`,
      `    ${table.annexKMatch != null ? `standard Annex K table (${table.annexKMatch}) — the textbook table shipped with the encoder` : "OPTIMISED — computed from this image's own statistics, which not every encoder bothers to do"}`
    );
  }
  lines.push("");

  lines.push("EMBEDDED THUMBNAIL", "-".repeat(78));
  if (report.thumbnail) {
    lines.push(
      `  ${report.thumbnail.bytes.toLocaleString("en-US")} bytes at offset ${report.thumbnail.offset}`,
      `  ${report.thumbnail.width ?? "?"} x ${report.thumbnail.height ?? "?"}${report.thumbnail.subsampling ? `, ${report.thumbnail.subsampling}` : ""}`,
      `  its own quantisation table sums: ${report.thumbnail.quantSums.length > 0 ? report.thumbnail.quantSums.join(", ") : "none readable"}`,
      "  A thumbnail is a complete second JPEG with its own tables, frequently written at a different quality",
      "  than the main image. Carved out whole in raw/segments/."
    );
  } else {
    lines.push("  None present.");
  }
  lines.push("");

  lines.push("ICC COLOUR PROFILE", "-".repeat(78));
  if (report.icc) {
    lines.push(
      `  name                ${report.icc.description ?? "(no desc tag)"}`,
      `  bytes               ${report.icc.bytes.toLocaleString("en-US")}${report.icc.chunks > 1 ? ` (reassembled from ${report.icc.chunks} APP2 chunks)` : ""}`,
      `  version             ${report.icc.version}`,
      `  class               ${report.icc.profileClass}`,
      `  colour space        ${report.icc.colorSpace} → ${report.icc.connectionSpace}`,
      `  creator             ${report.icc.creator}`,
      `  rendering intent    ${report.icc.renderingIntent}`,
      `  embedded profile ID ${report.icc.embeddedProfileId ?? "not set by the writer"}`,
      "",
      "  The exact bytes are carved to raw/segments/<capture>/icc-profile.bin and checksummed in",
      "  checksums/. The name above is what the profile calls itself — take the bytes as authoritative."
    );
  } else {
    lines.push("  None embedded. The file therefore makes no colour-space claim beyond what EXIF's ColorSpace tag says.");
  }
  lines.push("");

  if (report.comments.length > 0) {
    lines.push("COMMENT SEGMENTS", "-".repeat(78), ...report.comments.map((c) => `  "${c}"`), "");
  }

  lines.push("BYTES AFTER END OF IMAGE", "-".repeat(78));
  if (report.trailingBytes > 0) {
    lines.push(`  ${report.trailingBytes.toLocaleString("en-US")} bytes follow the EOI marker.`, `  first 64: ${report.trailingHex ?? ""}`, "", "  Nothing normally writes past EOI. This is worth looking at.");
  } else {
    lines.push("  None. The file ends at EOI, as it should.");
  }

  if (report.warnings.length > 0) {
    lines.push("", "WHERE THE PARSE STOPPED", "-".repeat(78), ...report.warnings.map((w) => `  ! ${w}`));
  }
  return lines.join("\n");
}
