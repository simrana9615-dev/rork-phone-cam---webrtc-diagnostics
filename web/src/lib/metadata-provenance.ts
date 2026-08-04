/**
 * Segment-scoped metadata provenance extraction.
 *
 * WHY THIS EXISTS: the previous engine searched the entire file, read as ASCII,
 * for tool names like "photoshop". Genuine iPhone/Android JPEGs contain that
 * string as *structure*, not provenance:
 *   - APP13 segments begin with the literal header `Photoshop 3.0\0` — that is
 *     simply the name of the Image Resource Block container Apple, Google,
 *     Samsung and virtually every phone pipeline use to carry IPTC data.
 *   - APP2 ICC profiles embed descriptions such as "Adobe RGB (1998)".
 *   - XMP packets declare `xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"`
 *     because the Adobe-authored namespace is the standard for basic fields.
 * A whole-file substring scan therefore accuses almost every real phone photo of
 * having been edited in Photoshop.
 *
 * This module walks real container structure (JPEG segments, PNG chunks, RIFF
 * chunks, ISO-BMFF boxes, EBML elements) and returns ONLY the values of fields
 * that actually state who wrote or generated the file. Structural container
 * names are recorded separately as benign and never matched against markers.
 *
 * Fields are split into two tiers so an accusation is scoped correctly:
 *   - `writer`  — "which program produced this file" (EXIF Software, XMP
 *                 CreatorTool, xmpMM softwareAgent, IPTC Originating Program,
 *                 QuickTime ©swr/©too, Matroska Muxing/WritingApp, C2PA claim
 *                 generator). Only these can support an editor fingerprint.
 *   - `content` — human/tool captions (UserComment, ImageDescription, PNG
 *                 `parameters`/`prompt` text chunks). Generators write prompts
 *                 here, so these support AI-signature detection but never an
 *                 "edited after capture" claim.
 */

export type ProvenanceTier = "writer" | "content";

export type ProvenanceField = {
  /** Container location the value came from, e.g. "JPEG APP1 XMP" or "PNG tEXt". */
  source: string;
  /** Field name as defined by the spec, e.g. "xmp:CreatorTool". */
  key: string;
  value: string;
  tier: ProvenanceTier;
};

export type ProvenanceScan = {
  fields: ProvenanceField[];
  /** Lowercased concatenation of writer-tier values only. */
  writerText: string;
  /** Lowercased concatenation of content-tier values only. */
  contentText: string;
  /** Structural container names found and deliberately NOT treated as provenance. */
  benignContainers: string[];
  /** Containers successfully parsed — proof the scan was structural, not a byte grep. */
  containersParsed: string[];
  hasXmp: boolean;
  hasC2pa: boolean;
  c2paGenerators: string[];
  /** IPTC/XMP DigitalSourceType values (the file declaring its own origin). */
  digitalSourceTypes: string[];
  /** Stable-Diffusion / ComfyUI style generation parameter blocks. */
  generationParamBlocks: ProvenanceField[];
};

function ascii(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = "";
  const chunk = 8192;
  const stop = Math.min(end, bytes.length);
  for (let i = Math.max(0, start); i < stop; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, stop)));
  }
  return out;
}

function utf8(bytes: Uint8Array, start: number, end: number): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, Math.min(end, bytes.length)));
  } catch {
    return ascii(bytes, start, end);
  }
}

function clean(value: string): string {
  // EXIF/IPTC strings are frequently NUL-padded and may carry stray control bytes.
  return value
    .replace(/\u0000+/g, " ")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushField(
  out: ProvenanceField[],
  source: string,
  key: string,
  rawValue: string,
  tier: ProvenanceTier
): void {
  const value = clean(rawValue);
  if (value === "" || value.length > 4000) return;
  if (out.some((f) => f.source === source && f.key === key && f.value === value)) return;
  out.push({ source, key, value, tier });
}

async function inflate(bytes: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array | null> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (typeof Ctor !== "function") return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Ctor(format));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// ───────────────────────────── XMP ─────────────────────────────

/** Qualified XMP field names that state which program wrote the file. */
const XMP_WRITER_KEYS = [
  "xmp:CreatorTool",
  "tiff:Software",
  "photoshop:History",
  "pdf:Producer",
  "stEvt:softwareAgent",
  "xmpMM:History",
  "GIMP:API",
  "GIMP:Platform",
  "Iptc4xmpExt:DigitalSourceFileType",
];

/** XMP fields carrying captions/prompts — AI evidence only, never "edited". */
const XMP_CONTENT_KEYS = ["dc:description", "dc:title", "exif:UserComment", "sd-metadata:prompt", "ai:prompt"];

const XMP_SOURCE_TYPE_KEYS = ["Iptc4xmpExt:DigitalSourceType", "plus:DigitalSourceType"];

function extractXmpValues(xml: string, key: string): string[] {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out: string[] = [];
  // Element form, incl. rdf:Alt/rdf:Seq wrappers: <key>…</key>
  const el = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]{0,4000}?)</${esc}>`, "gi");
  for (const m of xml.matchAll(el)) {
    const inner = m[1].replace(/<[^>]*>/g, " ");
    out.push(inner);
  }
  // Attribute form: key="…"
  const attr = new RegExp(`${esc}\\s*=\\s*"([^"]{0,4000})"`, "gi");
  for (const m of xml.matchAll(attr)) out.push(m[1]);
  return out;
}

function parseXmp(xml: string, source: string, scan: ProvenanceScan): void {
  scan.hasXmp = true;
  if (!scan.containersParsed.includes(source)) scan.containersParsed.push(source);
  // Namespace declarations name Adobe/Google/Apple schemas on genuine photos —
  // structure, never provenance. Recorded so the report can say so explicitly.
  for (const m of xml.matchAll(/xmlns:([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/g)) {
    const label = `${source} xmlns:${m[1]} (schema declaration)`;
    if (!scan.benignContainers.includes(label)) scan.benignContainers.push(label);
  }
  for (const key of XMP_WRITER_KEYS) {
    for (const v of extractXmpValues(xml, key)) pushField(scan.fields, source, key, v, "writer");
  }
  for (const key of XMP_CONTENT_KEYS) {
    for (const v of extractXmpValues(xml, key)) pushField(scan.fields, source, key, v, "content");
  }
  for (const key of XMP_SOURCE_TYPE_KEYS) {
    for (const v of extractXmpValues(xml, key)) {
      const value = clean(v);
      if (value !== "" && !scan.digitalSourceTypes.includes(value)) scan.digitalSourceTypes.push(value);
    }
  }
}

// ───────────────────────────── IPTC IIM (APP13 8BIM) ─────────────────────────────

/** IPTC record 2 datasets that name the producing program or declare source type. */
const IPTC_DATASETS: Record<number, { key: string; tier: ProvenanceTier | "source" }> = {
  65: { key: "IPTC 2:65 OriginatingProgram", tier: "writer" },
  70: { key: "IPTC 2:70 ProgramVersion", tier: "writer" },
  120: { key: "IPTC 2:120 Caption", tier: "content" },
  105: { key: "IPTC 2:105 Headline", tier: "content" },
  187: { key: "IPTC 2:187 DigitalSourceType", tier: "source" },
};

function parsePhotoshopIrb(bytes: Uint8Array, start: number, end: number, source: string, scan: ProvenanceScan): void {
  let i = start;
  while (i + 12 <= end) {
    if (ascii(bytes, i, i + 4) !== "8BIM") break;
    const id = (bytes[i + 4] << 8) | bytes[i + 5];
    let p = i + 6;
    const nameLen = bytes[p];
    p += 1 + nameLen;
    if ((p - i) % 2 !== 0) p += 1; // name is NUL/even padded
    if (p + 4 > end) break;
    const size = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    p += 4;
    if (size < 0 || p + size > end) break;
    if (id === 0x0404) parseIptcIim(bytes, p, p + size, source, scan);
    i = p + size + (size % 2);
  }
}

function parseIptcIim(bytes: Uint8Array, start: number, end: number, source: string, scan: ProvenanceScan): void {
  let i = start;
  while (i + 5 <= end) {
    if (bytes[i] !== 0x1c) {
      i += 1;
      continue;
    }
    const record = bytes[i + 1];
    const dataset = bytes[i + 2];
    let len = (bytes[i + 3] << 8) | bytes[i + 4];
    let p = i + 5;
    if (len & 0x8000) {
      // Extended dataset: low 15 bits give the length-of-length.
      const lenBytes = len & 0x7fff;
      len = 0;
      for (let k = 0; k < lenBytes && p + k < end; k++) len = len * 256 + bytes[p + k];
      p += lenBytes;
    }
    if (len < 0 || p + len > end) break;
    if (record === 2) {
      const spec = IPTC_DATASETS[dataset];
      if (spec) {
        const value = utf8(bytes, p, p + len);
        if (spec.tier === "source") {
          const v = clean(value);
          if (v !== "" && !scan.digitalSourceTypes.includes(v)) scan.digitalSourceTypes.push(v);
        } else {
          pushField(scan.fields, source, spec.key, value, spec.tier);
        }
      }
    }
    i = p + len;
  }
}

// ───────────────────────────── C2PA / JUMBF ─────────────────────────────

/**
 * Pulls claim-generator strings out of a JUMBF/C2PA payload. The manifest is
 * CBOR, but the generator is a definite-length text string, so the readable run
 * that follows the `claim_generator` key is the actual value.
 */
function extractC2paGenerators(bytes: Uint8Array, start: number, end: number, scan: ProvenanceScan): void {
  scan.hasC2pa = true;
  const text = ascii(bytes, start, end);
  for (const key of ["claim_generator_info", "claim_generator"]) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(key, from);
      if (at < 0) break;
      from = at + key.length;
      const run = text.slice(from, from + 220).match(/[\x20-\x7e]{4,}/);
      if (run) {
        const value = clean(run[0]);
        if (value !== "" && !scan.c2paGenerators.includes(value)) scan.c2paGenerators.push(value);
      }
    }
  }
}

// ───────────────────────────── JPEG ─────────────────────────────

const XMP_SIG = "http://ns.adobe.com/xap/1.0/\u0000";
const XMP_EXT_SIG = "http://ns.adobe.com/xmp/extension/\u0000";

function scanJpeg(bytes: Uint8Array, scan: ProvenanceScan): void {
  scan.containersParsed.push("JPEG segment table");
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of entropy-coded scan
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    const payloadStart = i + 4;
    const payloadEnd = Math.min(bytes.length, i + 2 + len);
    const head = ascii(bytes, payloadStart, Math.min(payloadEnd, payloadStart + 40));

    if (marker === 0xe0 && head.startsWith("JFIF")) {
      scan.benignContainers.push("APP0 JFIF header");
    } else if (marker === 0xe1 && head.startsWith(XMP_SIG)) {
      parseXmp(utf8(bytes, payloadStart + XMP_SIG.length, payloadEnd), "JPEG APP1 XMP", scan);
    } else if (marker === 0xe1 && head.startsWith(XMP_EXT_SIG)) {
      parseXmp(utf8(bytes, payloadStart + XMP_EXT_SIG.length + 40, payloadEnd), "JPEG APP1 XMP (extended)", scan);
    } else if (marker === 0xe1 && head.startsWith("Exif")) {
      scan.containersParsed.push("APP1 EXIF (tags read via EXIF parser)");
    } else if (marker === 0xe2 && head.startsWith("ICC_PROFILE")) {
      // Holds strings like "Adobe RGB (1998)" / "Display P3" — colour science, not provenance.
      scan.benignContainers.push("APP2 ICC colour profile (contains vendor colour-space names)");
    } else if (marker === 0xed && head.startsWith("Photoshop 3.0")) {
      // THE false-positive source. The header is the IRB container name that
      // Apple/Google/Samsung phones write; only the IPTC payload is provenance.
      scan.benignContainers.push('APP13 "Photoshop 3.0" Image Resource Block — standard IPTC container written by phone camera pipelines');
      scan.containersParsed.push("APP13 Photoshop IRB → IPTC IIM");
      parsePhotoshopIrb(bytes, payloadStart + 14, payloadEnd, "JPEG APP13 IPTC", scan);
    } else if (marker === 0xeb) {
      extractC2paGenerators(bytes, payloadStart, payloadEnd, scan);
      scan.containersParsed.push("APP11 JUMBF/C2PA");
    } else if (marker === 0xee && head.startsWith("Adobe")) {
      scan.benignContainers.push("APP14 Adobe segment (colour transform marker — scored separately)");
    } else if (marker === 0xfe) {
      pushField(scan.fields, "JPEG COM", "Comment", utf8(bytes, payloadStart, payloadEnd), "content");
    }
    i = i + 2 + len;
  }
}

// ───────────────────────────── PNG ─────────────────────────────

const PNG_WRITER_KEYWORDS = new Set(["software", "source", "creator tool", "creatortool"]);
const PNG_PARAM_KEYWORDS = new Set(["parameters", "prompt", "workflow", "sd-metadata", "comfy", "negative prompt", "invokeai_metadata"]);

async function scanPng(bytes: Uint8Array, scan: ProvenanceScan): Promise<void> {
  scan.containersParsed.push("PNG chunk table");
  let i = 8;
  while (i + 12 <= bytes.length) {
    const size = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = ascii(bytes, i + 4, i + 8);
    const dataStart = i + 8;
    const dataEnd = dataStart + size;
    if (size < 0 || dataEnd > bytes.length) break;

    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      let p = dataStart;
      while (p < dataEnd && bytes[p] !== 0) p += 1;
      const keyword = ascii(bytes, dataStart, p).trim();
      let textStart = p + 1;
      let text = "";
      if (type === "tEXt") {
        text = utf8(bytes, textStart, dataEnd);
      } else if (type === "zTXt") {
        textStart = p + 2; // compression method byte
        const raw = await inflate(bytes.subarray(textStart, dataEnd), "deflate");
        text = raw ? utf8(raw, 0, raw.length) : "";
      } else {
        const compressed = bytes[p + 1] === 1;
        let q = p + 3; // compression flag + method
        while (q < dataEnd && bytes[q] !== 0) q += 1; // language tag
        q += 1;
        while (q < dataEnd && bytes[q] !== 0) q += 1; // translated keyword
        q += 1;
        if (compressed) {
          const raw = await inflate(bytes.subarray(q, dataEnd), "deflate");
          text = raw ? utf8(raw, 0, raw.length) : "";
        } else {
          text = utf8(bytes, q, dataEnd);
        }
      }
      const lowerKey = keyword.toLowerCase();
      if (lowerKey === "xml:com.adobe.xmp") {
        parseXmp(text, "PNG iTXt XMP", scan);
      } else if (PNG_PARAM_KEYWORDS.has(lowerKey)) {
        const field: ProvenanceField = { source: `PNG ${type}`, key: keyword, value: clean(text).slice(0, 4000), tier: "content" };
        if (field.value !== "") {
          scan.generationParamBlocks.push(field);
          scan.fields.push(field);
        }
      } else if (PNG_WRITER_KEYWORDS.has(lowerKey)) {
        pushField(scan.fields, `PNG ${type}`, keyword, text, "writer");
      } else if (lowerKey === "comment" || lowerKey === "description" || lowerKey === "title") {
        pushField(scan.fields, `PNG ${type}`, keyword, text, "content");
      }
    } else if (type === "caBX") {
      extractC2paGenerators(bytes, dataStart, dataEnd, scan);
    } else if (type === "IDAT" || type === "IEND") {
      // Pixel data begins; text chunks after IDAT are rare and already covered above.
      if (type === "IEND") break;
    }
    i = dataEnd + 4;
  }
}

// ───────────────────────────── RIFF / WebP ─────────────────────────────

function scanRiff(bytes: Uint8Array, scan: ProvenanceScan): void {
  scan.containersParsed.push("RIFF chunk table");
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = ascii(bytes, i, i + 4);
    const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | bytes[i + 7] * 0x1000000;
    const dataStart = i + 8;
    const dataEnd = Math.min(bytes.length, dataStart + size);
    if (size < 0) break;
    if (type === "XMP ") parseXmp(utf8(bytes, dataStart, dataEnd), "WebP XMP chunk", scan);
    else if (type === "EXIF") scan.containersParsed.push("WebP EXIF chunk (tags read via EXIF parser)");
    else if (type === "ICCP") scan.benignContainers.push("WebP ICC colour profile");
    i = dataEnd + (size % 2);
  }
}

// ───────────────────────────── ISO-BMFF (MP4/MOV/HEIC) ─────────────────────────────

/** QuickTime/iTunes metadata atoms that name the writing software. */
const BMFF_WRITER_ATOMS: Record<string, string> = {
  "\u00a9swr": "QuickTime ©swr (software)",
  "\u00a9too": "QuickTime ©too (encoding tool)",
  "\u00a9ard": "QuickTime ©ard (art director)",
};
const BMFF_CONTENT_ATOMS: Record<string, string> = {
  "\u00a9cmt": "QuickTime ©cmt (comment)",
  "\u00a9des": "QuickTime ©des (description)",
};
const BMFF_CONTAINERS = new Set(["moov", "udta", "meta", "ilst", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf"]);
const XMP_UUID = "be7acfcb97a942e89c71999491e3afac";

function scanBmff(bytes: Uint8Array, scan: ProvenanceScan): void {
  scan.containersParsed.push("ISO-BMFF box tree");
  const walk = (start: number, end: number, depth: number): void => {
    let i = start;
    while (i + 8 <= end && depth < 8) {
      let size = bytes[i] * 0x1000000 + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
      const type = ascii(bytes, i + 4, i + 8);
      let headerSize = 8;
      if (size === 1) {
        // 64-bit size; only the low 32 bits matter for browser-sized files.
        size = bytes[i + 12] * 0x1000000 + (bytes[i + 13] << 16) + (bytes[i + 14] << 8) + bytes[i + 15];
        headerSize = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (size < headerSize || i + size > end) break;
      const dataStart = i + headerSize;
      const dataEnd = i + size;

      if (BMFF_CONTAINERS.has(type)) {
        // `meta` carries a 4-byte version/flags prefix before its children.
        walk(type === "meta" ? dataStart + 4 : dataStart, dataEnd, depth + 1);
      } else if (BMFF_WRITER_ATOMS[type] || BMFF_CONTENT_ATOMS[type]) {
        // iTunes-style atoms wrap the value in a `data` box (8-byte header + 8-byte type/locale).
        const inner = ascii(bytes, dataStart + 4, dataStart + 8) === "data" ? dataStart + 16 : dataStart;
        const value = utf8(bytes, inner, dataEnd);
        if (BMFF_WRITER_ATOMS[type]) pushField(scan.fields, BMFF_WRITER_ATOMS[type], type, value, "writer");
        else pushField(scan.fields, BMFF_CONTENT_ATOMS[type], type, value, "content");
      } else if (type === "uuid") {
        const uuid = Array.from(bytes.subarray(dataStart, dataStart + 16))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (uuid === XMP_UUID) parseXmp(utf8(bytes, dataStart + 16, dataEnd), "ISO-BMFF uuid XMP", scan);
      } else if (type === "hdlr") {
        scan.benignContainers.push("ISO-BMFF hdlr handler name");
      }
      i = dataEnd;
    }
  };
  walk(0, bytes.length, 0);
}

// ───────────────────────────── Matroska / WebM ─────────────────────────────

function readVint(bytes: Uint8Array, at: number): { value: number; length: number } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || at + length > bytes.length) return null;
  let value = first & (mask - 1);
  for (let k = 1; k < length; k++) value = value * 256 + bytes[at + k];
  return { value, length };
}

function scanMatroska(bytes: Uint8Array, scan: ProvenanceScan): void {
  scan.containersParsed.push("Matroska EBML elements");
  // MuxingApp (0x4D80) and WritingApp (0x5741) live in the Info element near the
  // head of the file; both are the muxer's self-declaration (e.g. "Lavf60.3").
  const limit = Math.min(bytes.length - 4, 512 * 1024);
  for (let i = 0; i < limit; i++) {
    const isMuxing = bytes[i] === 0x4d && bytes[i + 1] === 0x80;
    const isWriting = bytes[i] === 0x57 && bytes[i + 1] === 0x41;
    if (!isMuxing && !isWriting) continue;
    const size = readVint(bytes, i + 2);
    if (!size || size.value === 0 || size.value > 512) continue;
    const start = i + 2 + size.length;
    const value = utf8(bytes, start, start + size.value);
    if (/^[\x20-\x7e]{2,}$/.test(value.trim())) {
      pushField(scan.fields, "Matroska Info", isMuxing ? "MuxingApp" : "WritingApp", value, "writer");
    }
  }
}

// ───────────────────────────── EXIF tag bridge ─────────────────────────────

/** EXIF/TIFF tags that name the writing program. */
export const EXIF_WRITER_TAGS = ["Software", "ProcessingSoftware", "CreatorTool", "History", "OriginatingProgram"] as const;
/** EXIF tags carrying free text where generators leave prompts. */
export const EXIF_CONTENT_TAGS = ["UserComment", "ImageDescription", "XPComment", "XPSubject", "Description"] as const;

/**
 * Adds EXIF-parser-derived values into the scan. `HostComputer` is deliberately
 * excluded from the writer tier: iPhones write the device name there ("iPhone 15
 * Pro"), so it identifies hardware, not an editor.
 */
export function addExifProvenance(scan: ProvenanceScan, lookup: (key: string) => string | null): void {
  for (const key of EXIF_WRITER_TAGS) {
    const v = lookup(key);
    if (v) pushField(scan.fields, "EXIF", key, v, "writer");
  }
  for (const key of EXIF_CONTENT_TAGS) {
    const v = lookup(key);
    if (v) pushField(scan.fields, "EXIF", key, v, "content");
  }
  const dst = lookup("DigitalSourceType");
  if (dst) {
    const value = clean(dst);
    if (value !== "" && !scan.digitalSourceTypes.includes(value)) scan.digitalSourceTypes.push(value);
  }
  finalizeScan(scan);
}

function emptyScan(): ProvenanceScan {
  return {
    fields: [],
    writerText: "",
    contentText: "",
    benignContainers: [],
    containersParsed: [],
    hasXmp: false,
    hasC2pa: false,
    c2paGenerators: [],
    digitalSourceTypes: [],
    generationParamBlocks: [],
  };
}

/** Recomputes the lowercase haystacks after fields change. */
export function finalizeScan(scan: ProvenanceScan): void {
  scan.writerText = scan.fields
    .filter((f) => f.tier === "writer")
    .map((f) => f.value)
    .concat(scan.c2paGenerators)
    .join(" \u00b7 ")
    .toLowerCase();
  scan.contentText = scan.fields
    .filter((f) => f.tier === "content")
    .map((f) => f.value)
    .join(" \u00b7 ")
    .toLowerCase();
}

/**
 * Walks the real container structure of an image/video and returns only the
 * fields that state who wrote or generated it.
 */
export async function scanProvenance(bytes: Uint8Array): Promise<ProvenanceScan> {
  const scan = emptyScan();
  try {
    const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng =
      bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isRiff = bytes.length > 12 && ascii(bytes, 0, 4) === "RIFF";
    const isBmff = bytes.length > 12 && ["ftyp", "moov", "styp", "free", "mdat", "skip"].includes(ascii(bytes, 4, 8));
    const isMatroska = bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;

    if (isJpeg) scanJpeg(bytes, scan);
    else if (isPng) await scanPng(bytes, scan);
    else if (isRiff) scanRiff(bytes, scan);
    else if (isBmff) scanBmff(bytes, scan);
    else if (isMatroska) scanMatroska(bytes, scan);
    else scan.containersParsed.push("unrecognized container — no provenance fields readable");
  } catch (err) {
    // A malformed container is not evidence of fraud; report what was parsed.
    scan.containersParsed.push(`parse aborted: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  finalizeScan(scan);
  return scan;
}
