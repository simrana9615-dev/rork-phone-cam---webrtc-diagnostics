/**
 * Evidence pack builder — one ZIP that makes a session auditable offline.
 *
 * Design rules:
 *  1. Originals are copied byte-for-byte. The captured Blob goes into the
 *     archive untouched, stored (not deflated), so EXIF, entropy-coded scan
 *     data and file hash all survive. Nothing in this module re-encodes an
 *     original.
 *  2. `originals/` holds ONLY bytes this app did not create — camera files,
 *     platform stills, recorder output. A frame the app drew on a canvas and
 *     encoded itself is not an original and is filed under `rendered-frames/`
 *     instead. Each item's origin is declared by the capture code that made it
 *     (`PackMediaItem.origin`); it is never guessed here.
 *  3. Everything the engine derived — heat maps, ELA, frame strips, deskewed
 *     document crops, aligned face crops — is written to a separate folder and
 *     clearly labelled as derived, so a reviewer can never confuse a render
 *     with a capture.
 *  4. Nothing is silently missing. Every item that could not be packed is
 *     recorded as a warning inside the pack itself.
 *  5. Metadata is re-read from the original bytes at pack time (ExifReader +
 *     the structural provenance walk), so the archive stands on its own
 *     instead of trusting numbers copied out of the UI.
 *  6. The byte-identity claim is verified, not asserted: after the archive is
 *     built, every media payload is carved back out of it and compared to the
 *     source blob byte-for-byte, and the offsets/checksums needed to repeat
 *     that check independently ship inside the pack.
 *
 * Everything runs locally; nothing is uploaded.
 */

import ExifReader from "exifreader";

import { buildLedgerJsonObject, buildLedgerText } from "./capture-ledger";
import { downloadBlob, formatBytes, type LogEntry } from "./camera-diagnostics";
import {
  CATEGORY_LABELS,
  categoryOf,
  currentDeviceProfile,
  findingImpact,
  VERDICT_LABELS,
  type AiMediaVerdict,
  type Finding,
  type MediaFraudReport,
} from "./fraud-detection";
import { scanProvenance } from "./metadata-provenance";
import type { CaptureEngine } from "./capture-engine";
import { extractFrameCanvases } from "./pixel-forensics";
import { describeThreshold, THRESHOLDS } from "./thresholds";
import { buildZip, crcHex, safeZipPath, verifyBytes, type ZipEntry, type ZipEntryInfo } from "./zip-writer";
import type { CheckCoverage } from "./verification-templates";

export type PackVerdictTone = "pass" | "review" | "fail" | "info";

/**
 * Where a media item's bytes came from. Declared by the capture code, never
 * inferred here — it decides which folder the file is archived in and what the
 * pack is allowed to claim about it.
 */
export type PackOrigin =
  /** A File handed over by the operating system's camera app. */
  | "camera-file"
  /** A File the user picked from storage. */
  | "supplied-file"
  /** A still produced by the browser's own photo pipeline (ImageCapture.takePhoto). */
  | "platform-photo"
  /** Byte stream straight out of MediaRecorder. */
  | "recorder-stream"
  /** A frame this app drew to a canvas and encoded itself — NOT an original. */
  | "app-encoded-frame";

/**
 * How a File-based capture should be classified, given the engine that produced
 * it. Engines that open the OS camera app yield a fresh camera file; picker
 * engines let the user choose an existing photo, so the pack must not claim the
 * file came from the camera — the forensic checks decide whether it is fresh.
 */
export function originForCaptureEngine(engine: CaptureEngine): PackOrigin {
  switch (engine) {
    case "native-camera":
    case "capacitor":
    case "capture-boolean":
      return "camera-file";
    case "system-picker":
    case "legacy-accept":
    case "fs-picker":
      return "supplied-file";
  }
}

type OriginInfo = {
  folder: "originals" | "rendered-frames";
  short: string;
  long: string;
  metadataNote: string;
};

const ORIGIN_INFO: Record<PackOrigin, OriginInfo> = {
  "camera-file": {
    folder: "originals",
    short: "camera file from the OS camera app",
    long: "The file the operating system's camera app handed to the browser. These are the camera's own bytes: this app copied them into the archive without decoding or re-encoding them.",
    metadataNote: "EXIF as the camera wrote it, intact.",
  },
  "supplied-file": {
    folder: "originals",
    short: "file supplied from storage",
    long: "A file you selected from storage, copied into the archive byte-for-byte. This app did not alter it — but it cannot know what happened to the file before you supplied it, which is precisely what the forensic checks are for.",
    metadataNote: "Whatever metadata the file arrived with, intact.",
  },
  "platform-photo": {
    folder: "originals",
    short: "platform still (ImageCapture.takePhoto)",
    long: "A full-resolution still produced by the browser's own photo pipeline from the live camera track. The bytes are as the platform encoded them; this app copied them in untouched.",
    metadataNote: "Only what the platform chose to embed — browsers usually write little or no EXIF on this path.",
  },
  "recorder-stream": {
    folder: "originals",
    short: "recorder output (MediaRecorder)",
    long: "The exact byte stream the browser's media recorder produced from the live camera track. Copied in untouched — never remuxed, never transcoded.",
    metadataNote: "MediaRecorder containers carry no EXIF; timing and codec facts live in the container itself.",
  },
  "app-encoded-frame": {
    folder: "rendered-frames",
    short: "frame encoded by this app (canvas → JPEG)",
    long: "A frame this app drew from the live video track onto a canvas and encoded as JPEG. It is NOT an original camera file: the pixels are what the browser handed the canvas, and the JPEG around them was written by this app. That is exactly why it is filed here and not in originals/.",
    metadataNote: "None. A canvas encode cannot carry camera EXIF, so absent metadata here says nothing about authenticity.",
  },
};

/** A derived render (heat map, crop, chart) held as a data or blob URL. */
export type PackDerived = {
  id: string;
  label: string;
  url: string;
  caption?: string;
};

/** One captured artefact plus everything the engine produced from it. */
export type PackMediaItem = {
  /** Filename-safe id, e.g. "01-front". Determines ordering in the archive. */
  slug: string;
  label: string;
  /**
   * How these bytes came to exist. Required: the archive folder and the claims
   * the pack makes about this file both follow from it, so it must be stated by
   * whichever code performed the capture rather than guessed at export time.
   */
  origin: PackOrigin;
  /** The captured bytes exactly as received. Null when only a rendered URL exists. */
  blob?: Blob | null;
  /** Original name as produced by the camera or picker. */
  fileName?: string | null;
  /** Data/blob URL fallback when no original Blob is held (e.g. a liveness frame). */
  url?: string | null;
  captureMeta?: string | null;
  report?: MediaFraudReport | null;
  ai?: AiMediaVerdict | null;
  /** Renders not already carried on `report.visuals`. */
  derived?: PackDerived[];
  /** Extra plain-language lines for the overview. */
  notes?: string[];
};

export type PackSection = { title: string; lines: string[] };

export type PackInput = {
  /** Slug used in the archive filename, e.g. "verification-passport". */
  surface: string;
  title: string;
  subtitle?: string;
  /** One-line statement of what this pack does and does not cover. */
  scopeNote?: string;
  verdict?: { label: string; tone: PackVerdictTone; reasons?: string[]; corrective?: string[] };
  media?: PackMediaItem[];
  logs?: LogEntry[];
  /** Include the global capture-feed ledger (camera feeds, frames, native trips). */
  includeLedger?: boolean;
  /** Deep human-readable report already produced by the surface. */
  deepText?: string;
  /** Deep structured report already produced by the surface. */
  deepJson?: string;
  coverage?: CheckCoverage[];
  /** Additional overview sections (face match, liveness, tool-specific results). */
  sections?: PackSection[];
  extraFiles?: { path: string; data: Blob | string }[];
};

/** Result of carving one media payload back out of the finished archive. */
export type PackVerification = {
  path: string;
  label: string;
  ok: boolean;
  bytes: number;
  crc32: string;
  detail: string;
};

export type PackResult = {
  blob: Blob;
  fileName: string;
  files: number;
  bytes: number;
  warnings: string[];
  /** Byte-identity check on every archived media payload. */
  verification: PackVerification[];
};

const ENGINE_DOCS: { file: string; label: string; load: () => Promise<{ default: string }> }[] = [
  { file: "detection-engine.md", label: "Detection engine — every criterion and its evidence basis", load: () => import("../../docs/detection-engine.md?raw") },
  { file: "architecture.md", label: "Architecture — modules, data flow, routes", load: () => import("../../docs/architecture.md?raw") },
  { file: "templates.md", label: "Verification templates — flow definitions and fusion rules", load: () => import("../../docs/templates.md?raw") },
  { file: "capture-ledger.md", label: "Capture feed ledger — what is recorded and why", load: () => import("../../docs/capture-ledger.md?raw") },
  { file: "coverage-report.md", label: "Coverage report — checks per flow", load: () => import("../../docs/coverage-report.md?raw") },
];

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
};

function extensionFor(blob: Blob, fileName?: string | null): string {
  const fromName = fileName?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const base = blob.type.split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] ?? (base.startsWith("video/") ? "bin" : "bin");
}

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function urlToBlob(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

function decodeImage(blob: Blob): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Small JPEG preview for the overview page only. Originals are never touched —
 * this is an extra, clearly-labelled thumbnail.
 */
async function thumbnail(item: PackMediaItem, maxEdge: number): Promise<string | null> {
  const source = item.blob ?? (item.url ? await urlToBlob(item.url) : null);
  if (!source) return null;
  try {
    const isVideo = source.type.startsWith("video/") || item.report?.kind === "video";
    let width = 0;
    let height = 0;
    let draw: HTMLImageElement | HTMLCanvasElement | null = null;
    if (isVideo) {
      const frames = await extractFrameCanvases(source, 1, maxEdge);
      draw = frames[0] ?? null;
      width = draw?.width ?? 0;
      height = draw?.height ?? 0;
    } else {
      const img = await decodeImage(source);
      if (img) {
        draw = img;
        width = img.naturalWidth;
        height = img.naturalHeight;
      }
    }
    if (!draw || width === 0 || height === 0) return null;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(draw, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

function tagToText(key: string, tag: unknown): string {
  if (tag == null) return "";
  const holder = tag as { description?: unknown; value?: unknown };
  const raw = holder.description ?? holder.value ?? tag;
  let text: string;
  if (Array.isArray(raw)) {
    text = raw.length > 32 ? `[${raw.length} values] ${JSON.stringify(raw.slice(0, 16))}…` : JSON.stringify(raw);
  } else if (typeof raw === "object") {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  } else {
    text = String(raw);
  }
  if (text.length > 400) text = `${text.slice(0, 400)}… (${text.length} chars total)`;
  return text;
}

type MetadataScan = {
  tagCount: number;
  tags: Record<string, string>;
  parseError: string | null;
  provenance: {
    containersParsed: string[];
    benignContainers: string[];
    hasXmp: boolean;
    hasC2pa: boolean;
    c2paGenerators: string[];
    digitalSourceTypes: string[];
    fields: { source: string; key: string; value: string; tier: string }[];
  } | null;
};

/** Re-reads metadata straight from the archived bytes so the pack is self-proving. */
async function scanMetadata(blob: Blob): Promise<MetadataScan> {
  const out: MetadataScan = { tagCount: 0, tags: {}, parseError: null, provenance: null };
  let buffer: ArrayBuffer | null = null;
  try {
    buffer = await blob.arrayBuffer();
  } catch (err) {
    out.parseError = err instanceof Error ? err.message : String(err);
    return out;
  }
  try {
    const tags = ExifReader.load(buffer, { expanded: false });
    for (const key of Object.keys(tags)) {
      if (key === "Thumbnail") {
        out.tags[key] = "[embedded thumbnail — binary payload, length recorded only]";
        continue;
      }
      out.tags[key] = tagToText(key, (tags as Record<string, unknown>)[key]);
    }
    out.tagCount = Object.keys(out.tags).length;
  } catch (err) {
    out.parseError = err instanceof Error ? err.message : String(err);
  }
  try {
    const scan = await scanProvenance(new Uint8Array(buffer));
    out.provenance = {
      containersParsed: scan.containersParsed,
      benignContainers: scan.benignContainers,
      hasXmp: scan.hasXmp,
      hasC2pa: scan.hasC2pa,
      c2paGenerators: scan.c2paGenerators,
      digitalSourceTypes: scan.digitalSourceTypes,
      fields: scan.fields.map((f) => ({ source: f.source, key: f.key, value: f.value, tier: f.tier })),
    };
  } catch {
    // Structural scan is best-effort; the tag dump above still stands.
  }
  return out;
}

function metadataText(item: PackMediaItem, scan: MetadataScan, archivedAs: string, bytes: number, type: string): string {
  const origin = ORIGIN_INFO[item.origin];
  const lines: string[] = [
    `METADATA — ${item.label}`,
    "=".repeat(60),
    `Archived at: ${archivedAs}`,
    `Origin: ${origin.short}`,
    `  ${origin.long}`,
    `  Expected metadata on this path: ${origin.metadataNote}`,
    `Original file name: ${item.fileName ?? "(not provided by the capture path)"}`,
    `Declared type: ${type || "unknown"}`,
    `Bytes: ${bytes.toLocaleString("en-US")}`,
    item.captureMeta ? `Capture channel: ${item.captureMeta}` : "Capture channel: (not recorded)",
    "",
    "The dump below was read out of the archived bytes at export time, not copied from the app's screens.",
    "",
    `READABLE TAG DUMP — ${scan.tagCount} tag(s)`,
    "-".repeat(60),
  ];
  if (scan.parseError) lines.push(`Parse error: ${scan.parseError}`);
  if (scan.tagCount === 0 && !scan.parseError) {
    lines.push("No readable metadata. This is normal for browser-generated frames (canvas encodes carry no EXIF) and for");
    lines.push("files re-saved by apps that strip metadata. Absence of tags is treated as missing evidence, not as guilt.");
  }
  for (const key of Object.keys(scan.tags).sort()) lines.push(`${key}: ${scan.tags[key]}`);

  lines.push("", "FILE STRUCTURE WALK (container segments, not a byte grep)", "-".repeat(60));
  if (scan.provenance) {
    lines.push(`Containers parsed: ${scan.provenance.containersParsed.join(", ") || "(none recognised)"}`);
    lines.push(`Structural containers present, deliberately NOT treated as provenance: ${scan.provenance.benignContainers.join(", ") || "(none)"}`);
    lines.push(`XMP present: ${scan.provenance.hasXmp ? "yes" : "no"} · C2PA present: ${scan.provenance.hasC2pa ? "yes" : "no"}`);
    if (scan.provenance.c2paGenerators.length > 0) lines.push(`C2PA generators: ${scan.provenance.c2paGenerators.join(", ")}`);
    if (scan.provenance.digitalSourceTypes.length > 0) lines.push(`Declared digital source types: ${scan.provenance.digitalSourceTypes.join(", ")}`);
    lines.push("", "Provenance fields found:");
    if (scan.provenance.fields.length === 0) {
      lines.push("  (none — no field in this file names a program that wrote or generated it)");
    }
    for (const f of scan.provenance.fields) {
      lines.push(`  [${f.tier}] ${f.source} · ${f.key} = ${f.value}`);
    }
    lines.push(
      "",
      "Tier meaning: only a WRITER-tier field (Software, CreatorTool, XMP history, C2PA claim generator) can support an",
      '"edited after capture" statement. CONTENT-tier fields are user-authored text and never accuse on their own.'
    );
  } else {
    lines.push("Structural walk unavailable for this file type.");
  }
  return lines.join("\n");
}

function findingLine(f: Finding): string {
  const impact = findingImpact(f);
  const tag = f.status.toUpperCase().padEnd(4);
  return `[${tag}] ${f.label} — ${impact > 0 ? `−${impact.toFixed(1)} pts` : "0.0 pts"}`;
}

type ScoreRationale = {
  label: string;
  slug: string;
  score: number | null;
  confidence: number | null;
  verdictLabel: string | null;
  deductions: { label: string; impact: number; detail: string; category: string; status: string }[];
  totalPenalty: number;
  clean: string[];
  unscored: string[];
};

function rationaleFor(item: PackMediaItem): ScoreRationale | null {
  const r = item.report;
  if (!r) return null;
  const deductions = r.findings
    .map((f) => ({ f, impact: findingImpact(f) }))
    .filter((x) => x.impact > 0)
    .sort((a, b) => b.impact - a.impact)
    .map((x) => ({
      label: x.f.label,
      impact: x.impact,
      detail: x.f.detail,
      category: CATEGORY_LABELS[categoryOf(x.f)],
      status: x.f.status,
    }));
  const unscored = (r.telemetry?.checks ?? [])
    .filter((c) => !c.scoring)
    .map((c) => `${c.label} — measured ${c.measured}; not scored (${c.provenance})`);
  return {
    label: item.label,
    slug: item.slug,
    score: r.score,
    confidence: r.confidence,
    verdictLabel: r.verdictLabel || VERDICT_LABELS[r.verdict],
    deductions,
    totalPenalty: Math.round(deductions.reduce((s, d) => s + d.impact, 0) * 10) / 10,
    clean: r.findings.filter((f) => f.status === "pass").map((f) => f.label),
    unscored,
  };
}

function thresholdsText(): string {
  const lines: string[] = [
    "THRESHOLD REFERENCE",
    "=".repeat(70),
    "",
    "Every number that can move a score, and where that number came from. A threshold with no defensible",
    "origin is not allowed to accuse anyone: entries marked `uncalibrated` are measured and reported but",
    "contribute exactly zero points until separation between genuine and fraudulent captures has been",
    "demonstrated on real captures from this device (the Calibration screen does that).",
    "",
    "Provenance meanings:",
    "  browser-invariant  guaranteed by the web platform — cannot be otherwise in a real browser",
    "  spec-defined       fixed by a published standard (ISO 7810, ICAO 9303, EXIF, IPTC, JPEG)",
    "  physical-limit     a hard limit of optics or sensors",
    "  calibrated         derived from measured captures on this device",
    "  uncalibrated       measurable, no proven separation yet — reported, never scored",
    "",
  ];
  const order = ["browser-invariant", "spec-defined", "physical-limit", "calibrated", "uncalibrated"] as const;
  for (const provenance of order) {
    const group = THRESHOLDS.filter((t) => t.provenance === provenance);
    if (group.length === 0) continue;
    lines.push("", `── ${provenance.toUpperCase()} (${group.length}) ──`);
    for (const t of group) {
      lines.push(
        "",
        `${t.id} — ${t.label}`,
        `  measures: ${t.measures}`,
        `  decision: ${describeThreshold(t)}`,
        `  source:   ${t.source}`
      );
    }
  }
  return lines.join("\n");
}

function timelineFrom(logs: LogEntry[]): string[] {
  return logs.map((l) => `${l.ts}  [${l.level.toUpperCase().padEnd(7)}] ${l.message}`);
}

/** The in-app log buffer size; a full buffer means earlier entries were dropped. */
const LOG_BUFFER_LIMIT = 300;

function logsText(logs: LogEntry[], title: string): string {
  return [
    `END-TO-END SESSION LOG — ${title}`,
    "=".repeat(70),
    `${logs.length} entr${logs.length === 1 ? "y" : "ies"}, in order, exactly as recorded on the device.`,
    "Timestamps are local device time (24-hour).",
    logs.length >= LOG_BUFFER_LIMIT
      ? `The log buffer holds the most recent ${LOG_BUFFER_LIMIT} entries and was full at export, so entries from earlier in this session were dropped before the pack was built.`
      : "The buffer never filled during this session, so this is the complete log — nothing was dropped.",
    "",
    ...timelineFrom(logs),
    "",
    `Exported ${new Date().toISOString()}`,
  ].join("\n");
}

function coverageText(coverage: CheckCoverage[]): string[] {
  return coverage.map((c) => {
    const tag = c.status === "ran" ? "RAN" : c.status === "not-run" ? "NOT RUN" : "UNAVAILABLE";
    return `[${tag}] ${c.label}${c.result ? ` — ${c.result}` : ""}${c.note ? ` — ${c.note}` : ""}`;
  });
}

const READ_ME = (input: PackInput, files: string[], packed: PackedRecord[]): string => {
  const hasOriginals = packed.some((p) => ORIGIN_INFO[p.origin].folder === "originals");
  const hasRendered = packed.some((p) => ORIGIN_INFO[p.origin].folder === "rendered-frames");
  return [
    "EVIDENCE PACK — READ ME FIRST",
    "=".repeat(70),
    "",
    input.title,
    ...(input.subtitle ? [input.subtitle] : []),
    `Exported: ${new Date().toISOString()}`,
    "",
    "Start with overview.html — open it in any browser, or print it to PDF. It explains the result in plain",
    "language and points at everything else.",
    "",
    "WHAT IS IN HERE",
    "-".repeat(70),
    "overview.html / overview.txt   The readable summary: verdict, the exact points behind the score, what ran,",
    "                               what did not, the data read from the document, the timeline, thumbnails.",
    "report/                        The deep forensic report — every finding with observed vs expected, every",
    "                               measurement with its threshold and where that threshold came from.",
    ...(hasOriginals
      ? [
          "originals/                     Media whose bytes this app did NOT create — camera files, platform stills,",
          "                               recorder output — copied in byte-for-byte and stored uncompressed on purpose.",
          "                               What you extract is exactly what arrived: same bytes, same metadata, same",
          "                               hash. originals/SOURCES.txt states, per file, which capture path produced it.",
        ]
      : []),
    ...(hasRendered
      ? [
          "rendered-frames/               Frames this app drew from the live video track and encoded itself. NOT camera",
          "                               files: the pixels came from the browser, the JPEG was written here. They are",
          "                               kept out of originals/ so they can never be mistaken for camera output.",
          "                               rendered-frames/READ-ME.txt explains what that does and does not prove.",
        ]
      : []),
    "processed/                     What the engine derived from each capture — heat maps, error-level analysis,",
    "                               frequency charts, video frame strips, the straightened document crop and the",
    "                               aligned face crops. These are RENDERS, not captures. captions.txt in each",
    "                               folder explains how to read every image.",
    "metadata/                      Per file: the full readable tag dump plus the container-structure walk, read",
    "                               back out of the archived bytes at export time.",
    "verification/                  The size, CRC-32 and byte offset of every file in this archive, so you can",
    "                               confirm for yourself that nothing was altered. Instructions included.",
    "log/                           The complete end-to-end session log and the capture feed ledger.",
    "reference/                     The threshold reference and the engine documentation, so the reasoning can be",
    "                               audited without access to the app.",
    "MANIFEST.txt                   Every file in this archive with its exact byte size.",
    "",
    "HOW TO READ A SCORE",
    "-".repeat(70),
    "Each file starts at 100. A failed check removes its full weight; a warning removes 40% of it. The overview",
    "lists every deduction with its exact points, and they add up to the score shown — nothing hidden.",
    "A low CONFIDENCE number means little evidence was available (small image, stripped metadata). Low",
    "confidence is never treated as guilt.",
    "",
    `FILES: ${files.length}`,
  ].join("\n");
};

/** What actually got archived for one media item — the basis for every claim the overview makes. */
type PackedRecord = {
  slug: string;
  label: string;
  origin: PackOrigin;
  archivedAs: string | null;
  bytes: number | null;
  type: string;
  fileName: string | null;
  captureMeta: string | null;
  tagCount: number | null;
};

function sourcesText(packed: PackedRecord[], folder: "originals" | "rendered-frames"): string {
  const rows = packed.filter((p) => p.archivedAs != null && ORIGIN_INFO[p.origin].folder === folder);
  const header =
    folder === "originals"
      ? [
          "ORIGINALS — WHERE EACH FILE CAME FROM",
          "=".repeat(70),
          "",
          "Every file in this folder arrived as a finished byte stream that this app did not author. It was copied",
          "into the archive without being decoded, resized, recompressed or re-encoded, and it is stored",
          "uncompressed (ZIP method 0), so extracting it returns the identical bytes. Confirm that yourself with",
          "verification/byte-identity.txt.",
          "",
          "What this does prove: the app did not modify these files.",
          "What it does not prove: that the scene in front of the lens was genuine. That is what the forensic",
          "checks in report/ are for.",
          "",
        ]
      : [
          "RENDERED FRAMES — WHAT THESE ARE, AND WHAT THEY ARE NOT",
          "=".repeat(70),
          "",
          "These images are NOT camera files. Each one is a frame the app pulled from the live video track, drew",
          "onto a canvas, and encoded as JPEG itself. The pixel values are the ones the browser delivered; the file",
          "around them was written by this app.",
          "",
          "Consequences, stated plainly:",
          "  • There is no camera EXIF, and there never could be. Missing metadata here is not a red flag.",
          "  • The JPEG quantisation is the app's, so compression-based measurements on these frames describe the",
          "    app's encoder as much as the camera. The engine accounts for that; a human reader should too.",
          "  • The bytes below are still exactly what the app produced — nothing re-encoded them a second time on",
          "    the way into this archive.",
          "",
        ];
  const body = rows.flatMap((r) => [
    `${r.archivedAs}`,
    `  ${r.label}`,
    `  Origin: ${ORIGIN_INFO[r.origin].short}`,
    `  ${ORIGIN_INFO[r.origin].long}`,
    `  Bytes: ${r.bytes?.toLocaleString("en-US") ?? "—"} · type ${r.type || "unknown"}${r.fileName ? ` · name as received: ${r.fileName}` : ""}`,
    r.captureMeta ? `  Capture channel: ${r.captureMeta}` : "  Capture channel: (not recorded)",
    `  Metadata read back at export: ${r.tagCount == null ? "not attempted" : `${r.tagCount} tag(s) — see metadata/${r.slug}.txt`}`,
    "",
  ]);
  return [...header, ...body].join("\n");
}

const VERIFY_HOW_TO = [
  "HOW TO CHECK THIS YOURSELF",
  "-".repeat(70),
  "",
  "1. Extract and compare. Every entry is stored, not compressed, so extraction is a pure copy:",
  "     unzip -p <this-pack>.zip 'originals/<file>' > out.bin",
  "     cmp out.bin <the file you still hold>          # if you kept a copy",
  "",
  "2. Checksum. The CRC-32 below is the value written into the ZIP's own directory AND the value of the",
  "   payload bytes. Any archiver will verify it:",
  "     unzip -t <this-pack>.zip                        # tests every entry's CRC",
  "     crc32 out.bin                                   # must equal the value listed below",
  "",
  "3. Carve at the raw offset — the strongest check, because it bypasses ZIP tooling entirely. Because the",
  "   entries are stored uncompressed, the file's bytes sit contiguously in the archive at the offset given",
  "   below and can be lifted straight out:",
  "     dd if=<this-pack>.zip bs=1 skip=<data offset> count=<bytes> of=carved.bin",
  "     cmp carved.bin out.bin                          # identical",
  "   If carving at the stated offset yields a valid, openable image or video, the bytes were never",
  "   transformed on the way in — there is nowhere for a re-encode to hide.",
  "",
  "A note on honesty: this file cannot contain the result of verifying itself — nothing can. It contains the",
  "numbers you check against. The app also runs check 3 on every media payload immediately after building the",
  "archive and reports the outcome on screen and in the session log.",
  "",
].join("\n");

function verificationText(table: ZipEntryInfo[], mediaPaths: Map<string, { label: string; origin: PackOrigin }>): string {
  const lines: string[] = [
    "BYTE IDENTITY — VERIFICATION DATA",
    "=".repeat(70),
    "",
    "Every entry in this archive is stored with compression method 0 (store). No entry was deflated, and no",
    "media payload was decoded or re-encoded on the way in. For each file below you get its exact size, its",
    "CRC-32, and the byte offset inside this ZIP where its payload begins.",
    "",
    VERIFY_HOW_TO,
    "MEDIA PAYLOADS",
    "=".repeat(70),
    "",
  ];
  const mediaRows = table.filter((e) => mediaPaths.has(e.path));
  if (mediaRows.length === 0) lines.push("(this pack contains no media — it is a report-only export)", "");
  for (const e of mediaRows) {
    const info = mediaPaths.get(e.path);
    lines.push(
      e.path,
      `  ${info?.label ?? ""}`,
      `  origin      ${info ? ORIGIN_INFO[info.origin].short : "unknown"}`,
      `  bytes       ${e.size.toLocaleString("en-US")}`,
      `  crc-32      ${crcHex(e.crc32)}`,
      `  data offset ${e.dataOffset}   (payload occupies bytes ${e.dataOffset}–${e.dataOffset + e.size - 1})`,
      ""
    );
  }
  lines.push("ALL OTHER ENTRIES", "=".repeat(70), "", "path  |  bytes  |  crc-32  |  data offset", "-".repeat(70));
  for (const e of table) {
    if (mediaPaths.has(e.path)) continue;
    lines.push(`${e.path}  |  ${e.size}  |  ${crcHex(e.crc32)}  |  ${e.dataOffset}`);
  }
  lines.push(
    "",
    "Entries added after this file was generated (the central directory, and this report's own entry) are not",
    "listed above — a file cannot describe its own position before it has one. `unzip -t` covers those.",
    ""
  );
  return lines.join("\n");
}

function overviewText(
  input: PackInput,
  rationales: ScoreRationale[],
  packed: PackedRecord[],
  files: string[],
  warnings: string[],
  logs: LogEntry[]
): string {
  const lines: string[] = [
    "=".repeat(70),
    input.title.toUpperCase(),
    "=".repeat(70),
  ];
  if (input.subtitle) lines.push(input.subtitle);
  lines.push(`Exported: ${new Date().toISOString()}`);
  const device = currentDeviceProfile();
  lines.push(`Device: ${device.os} · ${device.platform} · screen ${device.screen}`);
  lines.push(`User agent: ${device.ua}`);
  if (input.scopeNote) lines.push("", `Scope: ${input.scopeNote}`);

  if (input.verdict) {
    lines.push("", "─".repeat(70), `RESULT: ${input.verdict.label.toUpperCase()}`, "─".repeat(70));
    for (const r of input.verdict.reasons ?? []) lines.push(`• ${r}`);
    if ((input.verdict.corrective ?? []).length > 0) {
      lines.push("", "What to do next:");
      for (const c of input.verdict.corrective ?? []) lines.push(`→ ${c}`);
    }
  }

  if (rationales.length > 0) {
    lines.push("", "─".repeat(70), "WHY THE SCORE IS WHAT IT IS", "─".repeat(70));
    for (const r of rationales) {
      lines.push("", `${r.label} — score ${r.score}/100 · confidence ${r.confidence}% · ${r.verdictLabel ?? ""}`);
      if (r.deductions.length === 0) {
        lines.push("  No deductions. Every scored check passed on this file.");
      } else {
        lines.push(`  100 starting points, minus ${r.totalPenalty.toFixed(1)} = ${r.score}. The deductions are:`);
        for (const d of r.deductions) {
          lines.push(`   −${d.impact.toFixed(1)}  ${d.label}  (${d.category}, ${d.status})`);
          lines.push(`         ${d.detail}`);
        }
      }
      if (r.unscored.length > 0) {
        lines.push("  Measured but deliberately NOT scored (no proven separation yet — see reference/thresholds.txt):");
        for (const u of r.unscored) lines.push(`   · ${u}`);
      }
      lines.push(`  Read more: report/deep-report.txt (full findings) · metadata/${r.slug}.txt (tags) · processed/${r.slug}/ (renders)`);
    }
  }

  if (input.coverage && input.coverage.length > 0) {
    lines.push("", "─".repeat(70), "WHAT WAS CHECKED", "─".repeat(70), ...coverageText(input.coverage));
  }

  for (const section of input.sections ?? []) {
    if (section.lines.length === 0) continue;
    lines.push("", "─".repeat(70), section.title.toUpperCase(), "─".repeat(70), ...section.lines);
  }

  const archived = packed.filter((p) => p.archivedAs != null);
  if (archived.length > 0) {
    lines.push(
      "",
      "─".repeat(70),
      "EVIDENCE FILES — WHERE EACH ONE CAME FROM",
      "─".repeat(70),
      "Files under originals/ are byte-for-byte as they arrived; this app never decoded or re-encoded them.",
      "Files under rendered-frames/ were encoded by this app from the live video track and carry no camera",
      "metadata — they are kept separate so they cannot be mistaken for camera output. Verify any of it with",
      "verification/byte-identity.txt.",
      ""
    );
    for (const p of archived) {
      lines.push(
        `${p.label}`,
        `  file      ${p.archivedAs}`,
        `  origin    ${ORIGIN_INFO[p.origin].short}`,
        `  size      ${p.bytes == null ? "—" : formatBytes(p.bytes)} · type ${p.type || "unknown"}${p.fileName ? ` · name as received: ${p.fileName}` : ""}`,
        p.captureMeta ? `  channel   ${p.captureMeta}` : "  channel   (not recorded)",
        `  metadata  ${p.tagCount == null ? "not read" : `${p.tagCount} tag(s) read back from the archived bytes → metadata/${p.slug}.txt`}`,
        ""
      );
    }
  }

  if (logs.length > 0) {
    lines.push("", "─".repeat(70), `TIMELINE (${logs.length} entries — full log in log/session-log.txt)`, "─".repeat(70));
    const shown = logs.length > 60 ? [...logs.slice(0, 30), ...logs.slice(-30)] : logs;
    if (logs.length > 60) {
      lines.push(...timelineFrom(logs.slice(0, 30)), `… ${logs.length - 60} entries omitted here, all present in log/session-log.txt …`, ...timelineFrom(logs.slice(-30)));
    } else {
      lines.push(...timelineFrom(shown));
    }
  }

  lines.push("", "─".repeat(70), `FILES IN THIS PACK (${files.length})`, "─".repeat(70), ...files);

  if (warnings.length > 0) {
    lines.push("", "─".repeat(70), "NOT INCLUDED — AND WHY", "─".repeat(70), ...warnings.map((w) => `! ${w}`));
  } else {
    lines.push("", "Everything available for this session was packed — no omissions.");
  }

  lines.push("", "=".repeat(70), "END OF OVERVIEW", "=".repeat(70));
  return lines.join("\n");
}

const OVERVIEW_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:28px 22px 64px;background:#f6f5f2;color:#16181d;font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto}
h1{margin:0 0 4px;font-size:26px;letter-spacing:-0.02em}
h2{margin:34px 0 10px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#6b6f7a;border-bottom:1px solid #ddd9d2;padding-bottom:6px}
h3{margin:18px 0 6px;font-size:16px}
p{margin:6px 0}
.sub{color:#6b6f7a;font-size:13px;margin:0 0 2px}
.verdict{margin:18px 0 0;padding:16px 18px;border-radius:14px;border:1px solid;font-weight:600;font-size:19px}
.pass{background:#e8f6ed;border-color:#9dd3b0;color:#12572f}
.review{background:#fdf4e3;border-color:#e6cf95;color:#6b4d09}
.fail{background:#fdecec;border-color:#e8a9a9;color:#7a1c1c}
.info{background:#eef1f6;border-color:#c8cfdb;color:#2b3446}
.verdict ul{margin:10px 0 0;padding-left:20px;font-weight:400;font-size:14px}
.card{background:#fff;border:1px solid #e3dfd8;border-radius:14px;padding:16px 18px;margin:12px 0}
.score{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.score b{font-size:30px;letter-spacing:-0.02em}
.score span{color:#6b6f7a;font-size:13px}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13.5px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #edeae4;vertical-align:top}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b6f7a}
td.pts{white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:600;color:#7a1c1c}
tr.total td{border-top:2px solid #16181d;border-bottom:none;font-weight:700}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.03em}
.t-ran{background:#e8f6ed;color:#12572f}
.t-not{background:#fdf4e3;color:#6b4d09}
.t-un{background:#eef1f6;color:#49526a}
.thumbs{display:flex;flex-wrap:wrap;gap:12px;margin:10px 0}
.thumb{width:172px}
.thumb img{width:100%;border-radius:10px;border:1px solid #ddd9d2;display:block;background:#e9e6e0}
.thumb div{font-size:11.5px;color:#6b6f7a;margin-top:5px;line-height:1.35}
pre{background:#fff;border:1px solid #e3dfd8;border-radius:12px;padding:12px 14px;overflow:auto;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:420px}
ul{margin:6px 0;padding-left:20px}
li{margin:3px 0}
.muted{color:#6b6f7a;font-size:13px}
.warn{background:#fdf4e3;border:1px solid #e6cf95;border-radius:12px;padding:12px 14px;font-size:13.5px}
code{background:#efece6;padding:1px 5px;border-radius:5px;font:12px ui-monospace,Menlo,monospace}
@media print{body{background:#fff;padding:0}.card,pre{break-inside:avoid}}
`;

function overviewHtml(
  input: PackInput,
  rationales: ScoreRationale[],
  packed: PackedRecord[],
  thumbs: { slug: string; label: string; url: string | null; meta: string }[],
  files: string[],
  warnings: string[],
  logs: LogEntry[]
): string {
  const device = currentDeviceProfile();
  const parts: string[] = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(input.title)} — Evidence Pack</title>`,
    `<style>${OVERVIEW_CSS}</style></head><body><div class="wrap">`,
    `<h1>${esc(input.title)}</h1>`,
    input.subtitle ? `<p class="sub">${esc(input.subtitle)}</p>` : "",
    `<p class="sub">Exported ${esc(new Date().toLocaleString())} · ${esc(device.os)} · ${esc(device.platform)} · screen ${esc(device.screen)}</p>`,
    input.scopeNote ? `<p class="muted">${esc(input.scopeNote)}</p>` : "",
  ];

  if (input.verdict) {
    parts.push(
      `<div class="verdict ${input.verdict.tone}">${esc(input.verdict.label)}`,
      (input.verdict.reasons ?? []).length > 0 ? `<ul>${(input.verdict.reasons ?? []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "",
      "</div>"
    );
    if ((input.verdict.corrective ?? []).length > 0) {
      parts.push(
        "<h2>What to do next</h2><ul>",
        (input.verdict.corrective ?? []).map((c) => `<li>${esc(c)}</li>`).join(""),
        "</ul>"
      );
    }
  }

  if (thumbs.length > 0) {
    parts.push("<h2>Captures</h2>", '<div class="thumbs">');
    for (const t of thumbs) {
      parts.push(
        '<div class="thumb">',
        t.url ? `<img src="${t.url}" alt="${esc(t.label)}">` : '<img alt="no preview available">',
        `<div><b>${esc(t.label)}</b><br>${esc(t.meta)}</div>`,
        "</div>"
      );
    }
    parts.push(
      "</div>",
      '<p class="muted">These thumbnails are downscaled JPEGs generated for this page only. The full-size files are in <code>originals/</code> (bytes exactly as they arrived) and <code>rendered-frames/</code> (frames this app encoded itself) — see the evidence table below for which is which.</p>'
    );
  }

  if (rationales.length > 0) {
    parts.push("<h2>Why the score is what it is</h2>");
    for (const r of rationales) {
      parts.push(
        '<div class="card">',
        `<h3>${esc(r.label)}</h3>`,
        `<p class="score"><b>${r.score}</b><span>/100 authenticity · confidence ${r.confidence}%</span></p>`,
        `<p class="muted">${esc(r.verdictLabel ?? "")}</p>`
      );
      if (r.deductions.length === 0) {
        parts.push("<p>No deductions — every scored check passed on this file.</p>");
      } else {
        parts.push(
          "<table><thead><tr><th>Points</th><th>Because of this</th></tr></thead><tbody>",
          r.deductions
            .map(
              (d) =>
                `<tr><td class="pts">−${d.impact.toFixed(1)}</td><td><b>${esc(d.label)}</b> <span class="muted">(${esc(d.category)} · ${esc(d.status)})</span><br><span class="muted">${esc(d.detail)}</span></td></tr>`
            )
            .join(""),
          `<tr class="total"><td class="pts">−${r.totalPenalty.toFixed(1)}</td><td>Total deducted from 100 → <b>${r.score}</b></td></tr>`,
          "</tbody></table>"
        );
      }
      if (r.unscored.length > 0) {
        parts.push(
          "<p class=\"muted\"><b>Measured but not scored</b> — no proven separation yet, so these cannot move the score (see <code>reference/thresholds.txt</code>):</p><ul>",
          r.unscored.map((u) => `<li class="muted">${esc(u)}</li>`).join(""),
          "</ul>"
        );
      }
      parts.push(
        `<p class="muted">Read more: <code>report/deep-report.txt</code> · <code>metadata/${esc(r.slug)}.txt</code> · <code>processed/${esc(r.slug)}/</code></p>`,
        "</div>"
      );
    }
  }

  if (input.coverage && input.coverage.length > 0) {
    parts.push("<h2>What was checked</h2><table><tbody>");
    for (const c of input.coverage) {
      const cls = c.status === "ran" ? "t-ran" : c.status === "not-run" ? "t-not" : "t-un";
      const tag = c.status === "ran" ? "RAN" : c.status === "not-run" ? "NOT RUN" : "UNAVAILABLE";
      parts.push(
        `<tr><td><span class="tag ${cls}">${tag}</span></td><td><b>${esc(c.label)}</b>${c.result ? `<br>${esc(c.result)}` : ""}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ""}</td></tr>`
      );
    }
    parts.push("</tbody></table>");
  }

  for (const section of input.sections ?? []) {
    if (section.lines.length === 0) continue;
    parts.push(`<h2>${esc(section.title)}</h2><ul>`, section.lines.map((l) => `<li>${esc(l)}</li>`).join(""), "</ul>");
  }

  const archived = packed.filter((p) => p.archivedAs != null);
  if (archived.length > 0) {
    parts.push(
      "<h2>Evidence files — where each one came from</h2>",
      '<p class="muted">Files under <code>originals/</code> are byte-for-byte as they arrived: this app never decoded or re-encoded them. Files under <code>rendered-frames/</code> were encoded by this app from the live video track and cannot carry camera metadata, so they are kept separate rather than presented as camera output. Every size and checksum can be re-checked from <code>verification/byte-identity.txt</code>.</p>',
      "<table><thead><tr><th>Capture</th><th>Archived as</th><th>Origin</th><th>Metadata</th></tr></thead><tbody>",
      archived
        .map(
          (p) =>
            `<tr><td><b>${esc(p.label)}</b>${p.captureMeta ? `<br><span class="muted">${esc(p.captureMeta)}</span>` : ""}</td><td><code>${esc(p.archivedAs ?? "")}</code><br><span class="muted">${esc(p.bytes == null ? "—" : formatBytes(p.bytes))} · ${esc(p.type || "unknown")}${p.fileName ? ` · ${esc(p.fileName)}` : ""}</span></td><td><span class="muted">${esc(ORIGIN_INFO[p.origin].short)}</span></td><td>${p.tagCount == null ? '<span class="muted">not read</span>' : `${p.tagCount} tag(s)<br><code>metadata/${esc(p.slug)}.txt</code>`}</td></tr>`
        )
        .join(""),
      "</tbody></table>"
    );
  }

  if (logs.length > 0) {
    parts.push(
      `<h2>Timeline (${logs.length} entries)</h2>`,
      `<pre>${esc(timelineFrom(logs).join("\n"))}</pre>`,
      '<p class="muted">Same content as <code>log/session-log.txt</code>; the capture feed ledger is alongside it.</p>'
    );
  }

  parts.push(`<h2>Files in this pack (${files.length})</h2><pre>${esc(files.join("\n"))}</pre>`);

  parts.push(
    warnings.length > 0
      ? `<h2>Not included — and why</h2><div class="warn"><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`
      : '<h2>Completeness</h2><p>Everything available for this session was packed — no omissions.</p>'
  );

  parts.push(
    '<h2>How to read this</h2><p class="muted">Each file starts at 100 points. A failed check removes its full weight, a warning removes 40% of it, and the deductions above add up to the score shown — nothing is hidden. A low confidence figure means little evidence was available (small image, stripped metadata); low confidence is never treated as guilt. Everything here was produced on this device; nothing was uploaded.</p>',
    '<h2>Proving the files were not altered</h2><p class="muted">Every entry in this archive is stored uncompressed, so extracting a file is a straight copy of the bytes that went in. <code>verification/byte-identity.txt</code> lists each file\'s exact size, its CRC-32 and the byte offset where its payload starts inside the ZIP, with three ways to confirm it — including carving the bytes out at the raw offset without any ZIP tooling at all. Do not take the claim on trust; the numbers are there to be checked.</p>',
    "</div></body></html>"
  );

  return parts.filter((p) => p !== "").join("\n");
}

/**
 * Builds the evidence ZIP for one session or tool run.
 *
 * Never throws for a single missing artefact: anything that cannot be packed is
 * reported in `warnings` and named inside the archive itself.
 */
export async function buildEvidencePack(input: PackInput, onProgress?: (message: string) => void): Promise<PackResult> {
  const now = new Date();
  const entries: ZipEntry[] = [];
  const warnings: string[] = [];
  const media = input.media ?? [];
  const logs = input.logs ?? [];
  const thumbs: { slug: string; label: string; url: string | null; meta: string }[] = [];
  const rationales: ScoreRationale[] = [];
  const packed: PackedRecord[] = [];
  /** Archived media path → the exact source blob, for the post-build byte comparison. */
  const mediaSources = new Map<string, { label: string; origin: PackOrigin; source: Blob }>();

  const add = (path: string, data: ZipEntry["data"]): string => {
    const safe = safeZipPath(path);
    entries.push({ path: safe, data, date: now });
    return safe;
  };

  // ── Captured media, derived renders, metadata ──
  for (const item of media) {
    onProgress?.(`Packing ${item.label}…`);
    const rationale = rationaleFor(item);
    if (rationale) rationales.push(rationale);

    const folder = ORIGIN_INFO[item.origin].folder;
    // A blob is the capture itself; a url-only item is a canvas render fetched back.
    const source = item.blob ?? (item.url ? await urlToBlob(item.url) : null);
    const record: PackedRecord = {
      slug: item.slug,
      label: item.label,
      origin: item.origin,
      archivedAs: null,
      bytes: null,
      type: source?.type ?? "",
      fileName: item.fileName ?? null,
      captureMeta: item.captureMeta ?? null,
      tagCount: null,
    };
    let archivedAs = "(no bytes held for this item)";

    if (source) {
      archivedAs = add(`${folder}/${item.slug}.${extensionFor(source, item.fileName)}`, source);
      record.archivedAs = archivedAs;
      record.bytes = source.size;
      mediaSources.set(archivedAs, { label: item.label, origin: item.origin, source });
      if (!item.blob) {
        warnings.push(
          `${item.label}: no camera file exists for this capture — it was a frame the app encoded from the live video track, so it is archived under ${folder}/ and carries no camera metadata.`
        );
      }
      try {
        const scan = await scanMetadata(source);
        record.tagCount = scan.tagCount;
        add(`metadata/${item.slug}.txt`, metadataText(item, scan, archivedAs, source.size, source.type));
        add(
          `metadata/${item.slug}.json`,
          JSON.stringify(
            {
              label: item.label,
              archivedAs,
              origin: item.origin,
              originDescription: ORIGIN_INFO[item.origin].long,
              bytesAreUnalteredByThisApp: item.origin !== "app-encoded-frame",
              originalFileName: item.fileName ?? null,
              declaredType: source.type || null,
              bytes: source.size,
              captureChannel: item.captureMeta ?? null,
              tagCount: scan.tagCount,
              tags: scan.tags,
              parseError: scan.parseError,
              structure: scan.provenance,
            },
            null,
            2
          )
        );
      } catch (err) {
        warnings.push(
          `${item.label}: metadata could not be re-read at export (${err instanceof Error ? err.message : String(err)}). The bytes themselves are unaffected and are in ${archivedAs}.`
        );
      }
    } else if (item.url) {
      warnings.push(`${item.label}: the image data was no longer available in memory at export time, so it could not be archived.`);
    } else {
      warnings.push(`${item.label}: not captured in this session, so there is nothing to archive.`);
    }
    packed.push(record);

    // Derived renders: report visuals + ELA + anything the surface adds.
    const derived: PackDerived[] = [
      ...(item.report?.visuals ?? []).map((v) => ({ id: v.id, label: v.label, url: v.url, caption: v.caption })),
      ...(item.report?.ela
        ? [
            { id: "ela-heatmap", label: "Error-level analysis heat map", url: item.report.ela.url, caption: `Amplified re-save difference. Mean ${item.report.ela.meanDiff}, block inconsistency ${item.report.ela.blockInconsistency}. Bright regions were saved at a different compression level from their surroundings. Visual reference only — this measurement does not score.` },
            { id: "ela-source", label: "ELA source reference", url: item.report.ela.sourceUrl, caption: "Downscaled copy of the analysed frame, for side-by-side comparison with the heat map." },
          ]
        : []),
      ...(item.derived ?? []),
    ];
    if (derived.length > 0) {
      const captions: string[] = [
        `DERIVED RENDERS — ${item.label}`,
        "=".repeat(60),
        "These images were PRODUCED BY THE ENGINE from the capture. They are not photographs and not evidence of",
        `themselves — they localise what the checks measured. The capture itself is ${archivedAs}.`,
        "",
      ];
      for (const d of derived) {
        const renderBlob = await urlToBlob(d.url);
        if (!renderBlob) {
          warnings.push(`${item.label}: the "${d.label}" render was no longer available at export time.`);
          continue;
        }
        const ext = extensionFor(renderBlob, null);
        const path = `processed/${item.slug}/${d.id}.${ext === "bin" ? "png" : ext}`;
        add(path, renderBlob);
        captions.push(`${d.id}.${ext === "bin" ? "png" : ext} — ${d.label}`, `  ${d.caption ?? "(no caption recorded)"}`, "");
      }
      add(`processed/${item.slug}/captions.txt`, captions.join("\n"));
    } else if (source) {
      warnings.push(`${item.label}: no derived renders were produced (pixel visualisations run on captures the engine screened in full).`);
    }

    const thumbUrl = await thumbnail(item, 420);
    thumbs.push({
      slug: item.slug,
      label: item.label,
      url: thumbUrl,
      meta: [
        source ? formatBytes(source.size) : "not captured",
        ORIGIN_INFO[item.origin].folder === "originals" ? "unaltered bytes" : "app-encoded frame",
        item.report ? `score ${item.report.score}/100` : null,
        item.captureMeta ?? null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
    if (!thumbUrl && source) {
      warnings.push(`${item.label}: a preview thumbnail could not be rendered for the overview — the archived file itself is unaffected.`);
    }
  }

  // ── Per-folder provenance statements ──
  if (packed.some((p) => p.archivedAs != null && ORIGIN_INFO[p.origin].folder === "originals")) {
    add("originals/SOURCES.txt", sourcesText(packed, "originals"));
  }
  if (packed.some((p) => p.archivedAs != null && ORIGIN_INFO[p.origin].folder === "rendered-frames")) {
    add("rendered-frames/READ-ME.txt", sourcesText(packed, "rendered-frames"));
  }

  // ── Deep report ──
  onProgress?.("Writing the deep report…");
  if (input.deepText) add("report/deep-report.txt", input.deepText);
  else warnings.push("No deep text report was supplied by this screen — the overview and the per-file metadata carry the full detail instead.");
  if (input.deepJson) add("report/deep-report.json", input.deepJson);

  // ── Logs & ledger ──
  if (logs.length > 0) {
    add("log/session-log.txt", logsText(logs, input.title));
    add("log/session-log.json", JSON.stringify({ title: input.title, exportedAt: now.toISOString(), entries: logs }, null, 2));
  } else {
    warnings.push("No session log entries were recorded on this screen.");
  }
  if (input.includeLedger !== false) {
    try {
      add("log/capture-ledger.txt", buildLedgerText());
      add("log/capture-ledger.json", JSON.stringify(buildLedgerJsonObject(), null, 2));
    } catch (err) {
      warnings.push(`The capture feed ledger could not be serialised (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  // ── Reference material ──
  onProgress?.("Adding the threshold reference…");
  add("reference/thresholds.txt", thresholdsText());
  add(
    "reference/thresholds.json",
    JSON.stringify(
      THRESHOLDS.map((t) => ({
        id: t.id,
        label: t.label,
        measures: t.measures,
        provenance: t.provenance,
        source: t.source,
        direction: t.direction,
        warnAt: t.warnAt,
        failAt: t.failAt,
        unit: t.unit ?? null,
        decision: describeThreshold(t),
      })),
      null,
      2
    )
  );
  for (const doc of ENGINE_DOCS) {
    try {
      const mod = await doc.load();
      add(`reference/engine/${doc.file}`, mod.default);
    } catch {
      warnings.push(`The reference document ${doc.file} could not be included in this build.`);
    }
  }

  for (const extra of input.extraFiles ?? []) add(extra.path, extra.data);

  // ── Overview, read-me and manifest last: they list everything else. ──
  onProgress?.("Writing the overview…");
  const TOP_LEVEL = [
    "MANIFEST.txt",
    "READ-ME-FIRST.txt",
    "overview.html",
    "overview.txt",
    "verification/byte-identity.txt",
    "verification/byte-identity.json",
  ];
  const listing = [...entries.map((e) => e.path), ...TOP_LEVEL].sort((a, b) => a.localeCompare(b));
  add("overview.txt", overviewText(input, rationales, packed, listing, warnings, logs));
  add("overview.html", overviewHtml(input, rationales, packed, thumbs, listing, warnings, logs));
  add("READ-ME-FIRST.txt", READ_ME(input, listing, packed));

  const encoder = new TextEncoder();
  const byteLength = (data: ZipEntry["data"]): number => {
    if (data instanceof Blob) return data.size;
    if (typeof data === "string") return encoder.encode(data).length;
    if (data instanceof ArrayBuffer) return data.byteLength;
    return data.byteLength;
  };
  const sized = new Map(entries.map((e) => [e.path, byteLength(e.data)] as const));
  add(
    "MANIFEST.txt",
    [
      `EVIDENCE PACK MANIFEST — ${input.title}`,
      "=".repeat(70),
      `Exported ${now.toISOString()}`,
      `${listing.length} files. Every size below is the exact number of bytes stored in this archive.`,
      "This manifest, the overview pages and the verification report all describe the archive they sit inside, so",
      "their own sizes are listed in verification/byte-identity.txt rather than here.",
      "",
      ...listing.map((path) => {
        const bytes = sized.get(path);
        return bytes == null ? `${path}  (size listed in verification/byte-identity.txt)` : `${path}  (${bytes.toLocaleString("en-US")} bytes)`;
      }),
    ].join("\n")
  );

  onProgress?.("Compiling the archive…");
  const mediaPaths = new Map([...mediaSources].map(([path, v]) => [path, { label: v.label, origin: v.origin }] as const));
  const { blob, entries: table } = await buildZip(entries, {
    onProgress: (p) => {
      if (p.done % 4 === 0 || p.done === p.total) onProgress?.(`Archiving ${p.done}/${p.total} — ${p.path}`);
    },
    // Written after layout, so it can cite the real offset and checksum of every entry above it.
    finalize: (laidOut) => [
      { path: "verification/byte-identity.txt", data: verificationText(laidOut, mediaPaths), date: now },
      {
        path: "verification/byte-identity.json",
        data: JSON.stringify(
          {
            exportedAt: now.toISOString(),
            compressionMethod: "store (0) — nothing in this archive is compressed",
            note: "dataOffset is the absolute byte position of the payload inside this ZIP. Carve `bytes` bytes from there to recover the file exactly.",
            entries: laidOut.map((e) => {
              const info = mediaPaths.get(e.path);
              return {
                path: e.path,
                bytes: e.size,
                crc32: crcHex(e.crc32),
                dataOffset: e.dataOffset,
                isMediaPayload: info != null,
                origin: info?.origin ?? null,
                bytesAreUnalteredByThisApp: info ? info.origin !== "app-encoded-frame" : null,
              };
            }),
          },
          null,
          2
        ),
        date: now,
      },
    ],
  });

  // ── Verify the claim rather than asserting it: carve every media payload back
  //    out of the finished archive and compare it to the source, byte for byte.
  onProgress?.("Verifying archived bytes…");
  const verification: PackVerification[] = [];
  for (const [path, entry] of mediaSources) {
    const info = table.find((e) => e.path === path);
    if (!info) {
      verification.push({ path, label: entry.label, ok: false, bytes: entry.source.size, crc32: "", detail: "not found in the archive index" });
      warnings.push(`${entry.label}: could not be located in the finished archive to verify — treat this pack as incomplete.`);
      continue;
    }
    try {
      const carved = blob.slice(info.dataOffset, info.dataOffset + info.size);
      const { identical, crc32, firstDifferenceAt } = await verifyBytes(carved, entry.source);
      const crcMatches = crc32 === info.crc32;
      const ok = identical && crcMatches && info.size === entry.source.size;
      const detail = ok
        ? `${info.size.toLocaleString("en-US")} bytes identical to the capture · CRC-32 ${crcHex(info.crc32)} · payload at offset ${info.dataOffset}`
        : `MISMATCH — archived ${info.size} bytes vs source ${entry.source.size}${firstDifferenceAt != null ? `, first difference at byte ${firstDifferenceAt}` : ""}${crcMatches ? "" : ", CRC-32 disagrees"}`;
      verification.push({ path, label: entry.label, ok, bytes: info.size, crc32: crcHex(info.crc32), detail });
      if (!ok) warnings.push(`${entry.label}: the archived bytes do NOT match the capture (${path}). Do not rely on this file.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      verification.push({ path, label: entry.label, ok: false, bytes: info.size, crc32: crcHex(info.crc32), detail: `could not be verified (${reason})` });
      warnings.push(`${entry.label}: the byte-identity check could not run on ${path} (${reason}).`);
    }
  }

  return {
    blob,
    fileName: `${safeZipPath(input.surface)}-evidence-${stamp(now)}.zip`,
    files: table.length,
    bytes: blob.size,
    warnings,
    verification,
  };
}

/** Builds the pack and hands it to the browser as a download. */
export async function downloadEvidencePack(input: PackInput, onProgress?: (message: string) => void): Promise<PackResult> {
  const result = await buildEvidencePack(input, onProgress);
  downloadBlob(result.blob, result.fileName);
  return result;
}
