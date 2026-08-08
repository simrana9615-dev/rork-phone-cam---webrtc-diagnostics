/**
 * The sheets — everything a run can say about itself, without an archive.
 *
 * These used to be produced inside the ZIP builder, which meant the cheapest
 * and most useful products of a run only existed if the most expensive and most
 * fragile one survived. They are built here instead, from the facts pass, and
 * the archive now consumes them rather than owning them.
 *
 * One registry, three renderings. Every section is described once as structured
 * blocks; the plain-text sheet, the readable HTML page and the on-screen viewer
 * are all rendered from that same description. A summary that drifts from the
 * document it summarises is worse than no summary, and keeping three
 * hand-written versions in step is a promise no codebase keeps.
 *
 * This file states facts and never draws a conclusion. Deep Probe is a
 * diagnostic: no verdict, no score, no finding.
 */

import { formatBytes, type LogEntry } from "../camera-diagnostics";
import type { CaptureFacts } from "./capture-facts";
import { constancyObservations, ORIGIN_TEXT } from "./capture-facts";
import type { CameraMatrixReport } from "./camera-matrix";
import { buildConstancy } from "./constancy";
import { briefChecklist, buildCorrelationBrief, type CorrelationInput } from "./correlation-brief";
import { buildMimicSpec } from "./mimic-spec";
import type { PassiveGroup } from "./passive";
import { CAPACITOR_PASS_POLICY, MAX_DATA_POLICY, PHOTO_FORM_LABEL, type CameraRequestFinding, type CapacitorSelfReport, type FormReading } from "./capacitor-pass";
import { OUTCOME_LABEL, TIER_INFO, type PermissionRecord, type PermissionTier } from "./permissions";
import { formatDuration, type RunCost } from "./run-cost";
import type { SensorSeries } from "./sensors";
import { statsText } from "./sensor-stats";
import { FACING_LABEL as WIDTH_FACING_LABEL, widthProbeText, type WidthProbeReport } from "./width-probe";

/** A stage that did not run, and the honest reason. */
export type StageOmission = { stage: string; reason: string };

/** Everything a run gathered, before any capture bytes are considered. */
export type RunFacts = {
  startedAt: string;
  finishedAt: string;
  tier: PermissionTier;
  permissions: PermissionRecord[];
  passive: PassiveGroup[];
  permissionStatesBefore: { name: string; state: string | null }[];
  permissionStatesAfter: { name: string; state: string | null }[];
  sensors: SensorSeries[];
  matrix: CameraMatrixReport | null;
  /**
   * The 640-only investigation, when that mode was chosen. Null on a full run.
   * Kept separate from the matrix rather than folded into it because the two
   * ask opposite questions — the matrix pins a device and states both
   * dimensions to measure a RANGE, this sends one bare width to measure a
   * DEFAULT — and merging them would make each one read as the other.
   */
  widthProbe: WidthProbeReport | null;
  logs: LogEntry[];
  /** Stages that never ran — named, with the reason, so nothing is quietly partial. */
  omissions: StageOmission[];
  /**
   * `enumerateDevices()` taken before any permission was requested. Kept apart
   * from the sweep's own snapshots because "before permission" and "before the
   * sweep" are different moments and only one shows the pre-grant state.
   */
  devicesBeforePermission: { kind: string; deviceId: string; groupId: string; label: string }[];
  /**
   * What the run actually cost, measured. Null only when nothing was timed.
   *
   * Recorded because the page used to promise a range typed in by hand and draw
   * a bar from a fixed guess. A run that describes its own cost from a constant
   * is making a claim it did not measure, which is the one thing this app is
   * not allowed to do.
   */
  cost: RunCost | null;
  /**
   * The Capacitor pass. Null when it never ran at all.
   *
   * Kept together rather than scattered because the three things it produces
   * only mean something next to each other: what the plugin claims about
   * itself, what the two camera shots proved about the camera request, and what
   * each alternate form did to the same photo.
   */
  capacitor: {
    selfReport: CapacitorSelfReport | null;
    cameraRequest: CameraRequestFinding | null;
    forms: FormReading[];
  } | null;
};

/* ------------------------------------------------------------------ *
 * The block vocabulary every rendering shares
 * ------------------------------------------------------------------ */

export type SheetRow = { label: string; value: string; tone?: "ok" | "warn" | "bad" | "muted" };

export type SheetBlock =
  | { kind: "prose"; text: string }
  | { kind: "rows"; rows: SheetRow[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "mono"; text: string };

export type SheetSection = {
  id: string;
  title: string;
  /** One sentence on what this section is, and what it deliberately is not. */
  blurb: string;
  blocks: SheetBlock[];
};

export type SheetSet = {
  generatedAt: string;
  partial: boolean;
  sections: SheetSection[];
  /** The whole sheet as plain text. */
  statSheetText: string;
  /** The same content as a readable page. Also written into the archive. */
  statSheetHtml: string;
  /** The itemised answers to the forensic request. */
  correlationBrief: string;
  /** The item list on its own, which is also the first section of the sheet. */
  forensicChecklist: string;
  /** Only what is distinctive about this device. */
  specMarkdown: string;
  fileNames: { statText: string; statHtml: string; brief: string; checklist: string; spec: string };
};

/* ------------------------------------------------------------------ *
 * Shared prose used by both the sheet and the archive
 * ------------------------------------------------------------------ */

export const VERIFY_HOW_TO = [
  "HOW TO CHECK ALL OF THIS WITHOUT THIS APP",
  "-".repeat(78),
  "",
  "1. Extract and checksum. Files under captures/ and rendered-frames/ are STORED, not compressed, so",
  "   extraction is a pure copy:",
  "     unzip -p <this>.zip 'captures/<file>' > out.bin",
  "     md5sum out.bin ; sha1sum out.bin ; sha256sum out.bin ; crc32 out.bin",
  "   All four must match the values in checksums/checksums.txt.",
  "",
  "2. Bulk-verify with the provided digest files, which are in the exact format the standard tools read:",
  "     unzip -o <this>.zip -d unpacked && cd unpacked",
  "     md5sum -c checksums/checksums.md5",
  "     sha256sum -c checksums/checksums.sha256",
  "",
  "3. Carve at the raw offset. This is the strongest check because it bypasses ZIP tooling entirely.",
  "   Stored entries sit contiguously in the archive at the offset listed in verification/byte-identity.txt:",
  "     dd if=<this>.zip bs=1 skip=<data offset> count=<bytes> of=carved.bin",
  "     cmp carved.bin out.bin        # identical",
  "   If carving at the stated offset yields an image that opens, the bytes were never transformed on the",
  "   way in. There is nowhere for a re-encode to hide.",
  "",
  "4. Re-dump the hex yourself and diff it against the copy in raw/:",
  "     xxd out.bin > mine.hex && diff mine.hex <(tail -n +8 raw/<slug>.hex.txt)",
  "",
  "Honesty note: this file cannot verify itself, and neither can any other file inside the archive it",
  "describes. It gives you the numbers to check against. The app additionally re-carves every capture out",
  "of the finished archive immediately after building it and reports the result on screen.",
  "",
  "Compression note: text files in this archive MAY be deflated to keep the size sane. Captures never are.",
  "verification/byte-identity.txt states which is which for every entry, and the CRC-32 in the ZIP header",
  "is always the checksum of the uncompressed bytes, so `unzip -t` validates everything either way.",
  "",
].join("\n");

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function permissionLedgerText(input: RunFacts): string {
  const lines: string[] = [
    "PERMISSION LEDGER",
    "=".repeat(78),
    `Scope: ${TIER_INFO[input.tier].label} — ${TIER_INFO[input.tier].blurb}`,
    `Run started ${input.startedAt}, finished ${input.finishedAt}`,
    "",
    "WHAT THE OUTCOMES MEAN",
    "-".repeat(78),
    "  Allowed             you agreed, and the API returned something. What it returned is quoted below.",
    "  Denied              you refused, or the browser reused an earlier refusal without asking again.",
    "  Dismissed           the prompt was closed without an answer, or nothing was chosen from a picker.",
    "  Not in this browser the API does not exist here. NOTHING WAS ASKED. This is never a refusal, and it",
    "                      is listed separately for exactly that reason.",
    "  Skipped             you moved past it before it fired.",
    "  Errored             the API exists and failed for some other reason, quoted verbatim.",
    "",
    "A NOTE ON COVERAGE",
    "-".repeat(78),
    "This ledger covers every request this app knows how to make at the chosen scope. It is not, and cannot",
    "honestly claim to be, every request that exists: the permission surface differs between browsers and",
    "grows with each release. What you have here is a floor, not a ceiling.",
    "",
    "Nothing below was retried. A refusal was taken as final.",
    "",
  ];

  const counts = new Map<string, number>();
  for (const record of input.permissions) counts.set(record.outcome, (counts.get(record.outcome) ?? 0) + 1);
  lines.push("SUMMARY", "-".repeat(78));
  for (const [outcome, label] of Object.entries(OUTCOME_LABEL)) {
    lines.push(`  ${label.padEnd(20)} ${counts.get(outcome) ?? 0}`);
  }

  for (const tier of ["standard", "extended", "everything"] as PermissionTier[]) {
    const group = input.permissions.filter((p) => p.tier === tier);
    if (group.length === 0) continue;
    lines.push("", "=".repeat(78), `${TIER_INFO[tier].label.toUpperCase()} TIER (${group.length} requests)`, "=".repeat(78));
    if (TIER_INFO[tier].caution) lines.push(`! ${TIER_INFO[tier].caution}`, "");
    for (const record of group) {
      lines.push(
        "",
        `${OUTCOME_LABEL[record.outcome].toUpperCase()} — ${record.label}`,
        `  api            ${record.api}`,
        `  asked at       ${record.askedAt}`,
        `  you answered   ${record.responseMs} ms later`,
        `  reaches        ${record.reaches}`,
        `  grant lasts    ${record.duration}`,
        `  what happened  ${record.detail}`,
        `  browser state  before: ${record.stateBefore ?? "(not queryable)"} → after: ${record.stateAfter ?? "(not queryable)"}`
      );
      if (record.data) lines.push(`  returned       ${JSON.stringify(record.data)}`);
    }
  }
  return lines.join("\n");
}

export function sensorsText(series: SensorSeries[]): string {
  const lines: string[] = [
    "SENSOR RECORDINGS",
    "=".repeat(78),
    "",
    "A grant proves very little on its own; what matters is the data that follows it. Each recording below",
    "reports the MEASURED sample rate, not the requested one, because browsers throttle these events and",
    "quoting the request back would be repeating an intention as though it were a reading.",
    "",
  ];
  if (series.length === 0) {
    lines.push("No sensor recordings ran. Either nothing was granted, or the stage was skipped — the omissions list says which.");
    return lines.join("\n");
  }
  for (const s of series) {
    lines.push(
      "",
      `── ${s.label} ──`,
      `   file        sensors/${s.id}.csv`,
      `   samples     ${s.rows.length}`,
      `   duration    ${s.durationMs} ms`,
      `   requested   ${s.requestedHz != null ? `${s.requestedHz} Hz` : "not applicable — this API has no rate control"}`,
      `   measured    ${s.measuredHz != null ? `${s.measuredHz} Hz` : "too few samples to state a rate"}`,
      `   ${s.note}`
    );
  }
  return lines.join("\n");
}

export function checksumsText(facts: CaptureFacts[]): string {
  const lines: string[] = [
    "CHECKSUMS",
    "=".repeat(78),
    "",
    "Four independent checksums per capture, so whichever tool you already trust can confirm the contents.",
    "",
    "MD5 is included because md5sum is the most universally available checker there is. It is a broken hash",
    "for signature purposes and is offered here only as an integrity and transcription check — never as a",
    "security claim. SHA-256 is the one to rely on.",
    "",
  ];
  for (const f of facts) {
    lines.push(
      f.archivePath,
      `  bytes    ${f.hashes.bytes.toLocaleString("en-US")}`,
      `  md5      ${f.hashes.md5}`,
      `  sha1     ${f.hashes.sha1}`,
      `  sha256   ${f.hashes.sha256}`,
      `  crc32    ${f.hashes.crc32}`,
      ""
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * The sections
 * ------------------------------------------------------------------ */

function quantSummary(facts: CaptureFacts): string {
  const tables = facts.encoder?.quantTables ?? [];
  if (tables.length === 0) return "no quantisation tables (not a JPEG, or none present)";
  return tables
    .map((t) => {
      const quality = t.libjpegQualityEstimate != null ? `q≈${t.libjpegQualityEstimate}` : "quality withheld — not scaled Annex K";
      return `table ${t.id} (${t.precisionBits}-bit, sum ${t.sum}, ${t.isAnnexKBase ? "Annex K base" : "custom"}, ${quality})`;
    })
    .join("; ");
}

function ifdSummary(facts: CaptureFacts): string {
  const ifd = facts.ifd;
  if (!ifd || !ifd.found) return "no EXIF directory structure";
  const entries = ifd.blocks.reduce((sum, block) => sum + block.entries.length, 0);
  const maker = ifd.makerNote ? `maker note ${ifd.makerNote.bytes} bytes (${ifd.makerNote.signature || "unsigned"})` : "no maker note";
  return `${ifd.byteOrder}, ${ifd.blocks.length} directories (${ifd.ifdOrder.join(" → ")}), ${entries} entries, ${maker}${ifd.hasIfd1 ? ", thumbnail IFD present" : ""}`;
}

function substitutedRows(matrix: CameraMatrixReport): string[][] {
  const rows: string[][] = [];
  for (const row of matrix.rows) {
    if (!row.ok || !row.grantedSettings) continue;
    const asked = row.askedConstraints as Record<string, unknown>;
    const wantedWidth = typeof asked.width === "object" && asked.width != null ? (asked.width as Record<string, unknown>).ideal ?? (asked.width as Record<string, unknown>).exact : asked.width;
    const gotWidth = row.grantedSettings.width;
    if (wantedWidth != null && gotWidth != null && Number(wantedWidth) !== Number(gotWidth)) {
      rows.push([row.deviceLabel || row.deviceId.slice(0, 8), row.kind, row.asked, row.granted ?? "", "the camera substituted a different size without refusing"]);
    }
  }
  return rows;
}

function buildSections(run: RunFacts, facts: CaptureFacts[], checklist: string): SheetSection[] {
  const counts = new Map<string, number>();
  for (const p of run.permissions) counts.set(p.outcome, (counts.get(p.outcome) ?? 0) + 1);
  const matrixRows = run.matrix?.rows ?? [];
  const grantedRows = matrixRows.filter((r) => r.ok).length;
  const totalBytes = facts.reduce((sum, f) => sum + f.bytes, 0);
  const passiveCount = run.passive.reduce((sum, g) => sum + g.rows.length, 0);
  const partial = run.omissions.length > 0 || run.matrix?.aborted === true;

  const sections: SheetSection[] = [];

  sections.push({
    id: "forensic",
    title: "The forensic item list",
    blurb:
      "Every item of the request, answered or refused, at the top where it belongs. Four statuses, never two: not looked at and cannot be looked at are different claims.",
    blocks: [{ kind: "mono", text: checklist }],
  });

  sections.push({
    id: "run",
    title: "The run",
    blurb: partial
      ? "This run did not complete every stage. What is missing is named in full further down rather than quietly left out."
      : "Every stage of this run completed.",
    blocks: [
      {
        kind: "rows",
        rows: [
          { label: "Started", value: run.startedAt },
          { label: "Finished", value: run.finishedAt },
          { label: "Scope", value: `${TIER_INFO[run.tier].label} — ${TIER_INFO[run.tier].blurb}` },
          { label: "Requests made", value: String(run.permissions.length) },
          { label: "Allowed", value: String(counts.get("granted") ?? 0), tone: "ok" },
          { label: "Denied", value: String(counts.get("denied") ?? 0), tone: "bad" },
          { label: "Not in this browser", value: String(counts.get("unavailable") ?? 0), tone: "muted" },
          { label: "Read with no prompt at all", value: `${passiveCount} facts`, tone: "warn" },
          { label: "Sensor recordings", value: String(run.sensors.length) },
          { label: "Camera requests", value: `${grantedRows} granted of ${matrixRows.length}` },
          { label: "Photos", value: `${facts.length} · ${formatBytes(totalBytes)}` },
          { label: "Stages omitted", value: String(run.omissions.length), tone: run.omissions.length > 0 ? "warn" : "ok" },
        ],
      },
      {
        kind: "prose",
        text: "This is a diagnostic. It states what was asked, what came back and what the bytes contain. It reaches no verdict, awards no score and makes no claim about whether any photo shows something real.",
      },
    ],
  });

  sections.push({
    id: "permissions",
    title: "What was asked for",
    blurb: "Denied and not-in-this-browser are never merged. An unavailable API was never asked about, so it is not a refusal.",
    blocks: [
      {
        kind: "table",
        head: ["Request", "API", "Outcome", "You answered in", "What it reaches"],
        rows: run.permissions.map((p) => [
          p.label,
          p.api,
          OUTCOME_LABEL[p.outcome],
          p.outcome === "unavailable" ? "—" : `${p.responseMs} ms`,
          p.reaches,
        ]),
      },
    ],
  });

  sections.push({
    id: "passive",
    title: "What was taken without asking",
    blurb: "No prompt, no indicator, no way to decline. Arguably the more revealing half of the run.",
    blocks: run.passive.flatMap((group): SheetBlock[] => [
      { kind: "prose", text: group.title },
      { kind: "rows", rows: group.rows.map((r) => ({ label: r.label, value: r.value })) },
    ]),
  });

  sections.push({
    id: "sensors",
    title: "Sensor recordings",
    blurb: "The rate measured, next to the rate requested. Browsers throttle these, so quoting the request back would repeat an intention as though it were a reading.",
    blocks:
      run.sensors.length === 0
        ? [{ kind: "prose", text: "No sensor recordings ran. Either nothing that produces a time series was granted, or the stage was skipped — the omissions list says which." }]
        : [
            {
              kind: "table",
              head: ["Sensor", "Samples", "Duration", "Requested", "Measured", "Note"],
              rows: run.sensors.map((s) => [
                s.label,
                String(s.rows.length),
                `${s.durationMs} ms`,
                s.requestedHz != null ? `${s.requestedHz} Hz` : "no rate control",
                s.measuredHz != null ? `${s.measuredHz} Hz` : "too few samples",
                s.note,
              ]),
            },
            {
              kind: "prose",
              text: "What the rows themselves say about the hardware. The delivery rate counts every event; the distinct rate counts only the events that carried a new reading, and on a device that re-sends the last value on a timer the two are different numbers. The step is the smallest gap between distinct readings, which is the converter's own quantisation and not this app's formatting.",
            },
            { kind: "mono", text: run.sensors.map((s) => [`── ${s.label} ──`, ...statsText(s.stats)].join("\n")).join("\n\n") },
          ],
  });

  if (run.widthProbe) {
    const probe = run.widthProbe;
    sections.push({
      id: "width-640",
      title: `What this phone does when a site asks for ${probe.width} wide`,
      blurb:
        "One constraint per camera — a plain width — and everything the phone decided on its own around it. This is the request most real websites actually send; what a platform fills in around it is undocumented, and nothing here is a judgement about whether the behaviour is good.",
      blocks: [
        {
          kind: "table",
          head: ["Camera", "Open", "Granted size", "Width verdict", "Aspect", "Frame rate", "facingMode", "Camera opened"],
          rows: probe.rows.map((row) => [
            WIDTH_FACING_LABEL[row.facing],
            row.ok ? `${row.openMs} ms` : `refused — ${row.error ?? "no reason given"}`,
            row.grantedWidth != null && row.grantedHeight != null ? `${row.grantedWidth}×${row.grantedHeight}` : "—",
            row.verdict === "exact"
              ? `exactly ${probe.width}`
              : row.verdict === "near"
                ? `${row.grantedWidth} — near, not it`
                : row.verdict === "different"
                  ? `${row.grantedWidth} — nowhere near`
                  : "no width reported",
            row.grantedAspect != null ? String(Math.round(row.grantedAspect * 1000) / 1000) : "not reported",
            row.grantedFrameRate != null ? `${Math.round(row.grantedFrameRate * 100) / 100} fps` : "not reported",
            row.grantedFacing ?? "not reported",
            row.trackLabel ?? "no track label",
          ]),
        },
        { kind: "mono", text: widthProbeText(probe) },
      ],
    });
  }

  if (run.matrix) {
    const matrix = run.matrix;
    const substitutions = substitutedRows(matrix);
    const cameraBlocks: SheetBlock[] = [
      {
        kind: "rows",
        rows: [
          { label: "Cameras found", value: String(matrix.inventory.length) },
          { label: "Requests made", value: String(matrix.rows.length) },
          { label: "Granted", value: String(grantedRows), tone: "ok" },
          { label: "Refused", value: String(matrix.rows.length - grantedRows), tone: "muted" },
          { label: "Sweep duration", value: `${(matrix.durationMs / 1000).toFixed(1)} s` },
          { label: "Stills stopped early", value: matrix.stillsStoppedForMemory ?? "no", tone: matrix.stillsStoppedForMemory ? "warn" : "ok" },
          { label: "Peak capture bytes held", value: `${formatBytes(matrix.memory.heldBytes)} of a ${formatBytes(matrix.memory.ceilingBytes)} ceiling` },
          { label: "Stopped early by you", value: matrix.aborted ? "yes" : "no", tone: matrix.aborted ? "warn" : "ok" },
        ],
      },
      {
        kind: "prose",
        text: "A refusal is a result, not a fault: it marks where the hardware's limit actually is. A grant that returns something other than what was asked for is more interesting still, and those rows are listed separately below.",
      },
      {
        kind: "table",
        head: ["Camera", "Kind", "Asked", "Result", "Granted", "ms"],
        rows: matrix.rows.map((r) => [
          r.deviceLabel || r.deviceId.slice(0, 8),
          r.kind,
          r.asked,
          r.ok ? "granted" : `refused — ${r.error ?? "no reason given"}`,
          r.granted ?? "—",
          String(r.durationMs),
        ]),
      },
    ];
    if (substitutions.length > 0) {
      cameraBlocks.push({
        kind: "table",
        head: ["Camera", "Kind", "Asked", "Actually got", "What happened"],
        rows: substitutions,
      });
    } else {
      cameraBlocks.push({ kind: "prose", text: "No granted request came back with a different size than the one asked for." });
    }
    sections.push({
      id: "camera",
      title: "Camera sweep",
      blurb:
        "Every camera, at the sizes, ratios, frame rates and control modes it says it supports — asked against granted, including the silent substitutions. Rungs above a camera's own stated ceiling are not asked for, apart from one deliberate over-ask that shows whether it clamps or refuses.",
      blocks: cameraBlocks,
    });
  } else {
    sections.push({
      id: "camera",
      title: "Camera sweep",
      blurb: "The sweep did not run in this session.",
      blocks: [{ kind: "prose", text: "No camera data is claimed anywhere in this sheet. The omissions list says why the stage did not happen." }],
    });
  }

  const photoBlocks: SheetBlock[] = [];
  if (facts.length === 0) {
    photoBlocks.push({
      kind: "prose",
      text: "This run produced no photos. That is either because the camera stages did not run or because every attempt failed — the omissions list distinguishes the two, and neither is reported as an empty result.",
    });
  } else {
    photoBlocks.push({
      kind: "prose",
      text: "The two capture paths are opposites and are never presented as each other. A frame this app drew from a video track and encoded itself carries no camera metadata at all — that is the only possible outcome on that path, and sparse tags there mean nothing. A file handed over by the camera app or picked from the photo library carries whatever the device chose to write, which is usually the full set.",
    });
    for (const f of facts) {
      photoBlocks.push({ kind: "prose", text: `${f.archivePath} — ${f.label}` });
      photoBlocks.push({
        kind: "rows",
        rows: [
          { label: "Where the bytes came from", value: ORIGIN_TEXT[f.origin] ?? f.origin },
          { label: "Production path", value: f.path },
          { label: "Stage", value: f.stage },
          { label: "Camera", value: f.deviceLabel ?? "not attributable to one camera" },
          { label: "Asked for", value: f.asked },
          { label: "Track reported", value: f.granted },
          { label: "Dimensions", value: `${f.width} × ${f.height}` },
          { label: "Bytes", value: `${f.bytes.toLocaleString("en-US")} (${formatBytes(f.bytes)})` },
          { label: "MIME", value: f.mime || "not declared" },
          { label: "Container", value: f.structure.container },
          {
            label: "File shape",
            value: f.shape
              ? `${f.shape.id} — the device-describing parts of this file, folded into one comparable handle. Two captures sharing it are the same file in every respect except the moment.`
              : "not readable",
          },
          { label: "Structure", value: `${f.structure.segments.length} carvable region(s), ${f.structure.nodes.length} node(s)` },
          { label: "Encoder tables", value: quantSummary(f) },
          { label: "Huffman tables", value: f.encoder ? String(f.encoder.huffmanTables.length) : "—" },
          { label: "APP segments", value: f.encoder && f.encoder.appSegments.length > 0 ? f.encoder.appSegments.map((a) => `${a.marker}:${a.signature || "unsigned"}`).join(", ") : "none" },
          { label: "Metadata directories", value: ifdSummary(f) },
          { label: "Colour profile", value: f.iccMd5 ? `embedded, MD5 ${f.iccMd5}` : "none embedded" },
          {
            label: "Tags found",
            value:
              f.tags.metadataCount === 0
                ? "none — no metadata whatsoever. On a frame this app encoded that is the only possible outcome and means nothing."
                : `${f.tags.metadataCount}${f.tags.unknown > 0 ? ` (${f.tags.unknown} undocumented)` : ""}`,
          },
          { label: "File name as delivered", value: f.fileName ?? "no File object on this path" },
          { label: "File lastModified", value: f.fileLastModified != null ? String(f.fileLastModified) : "—" },
          { label: "Taken at", value: f.takenAt },
          {
            label: "8x8 block grid",
            value: f.pixels
              ? f.pixels.grid.reading
              : (f.pixelsUnavailable ?? "not measured, and no reason was recorded — which is itself a fault."),
            tone: f.pixels && f.pixels.grid.present && !f.pixels.grid.aligned && f.origin !== "app-encoded-frame" ? "warn" : undefined,
          },
          {
            label: "Sensor pipeline",
            value: f.pixels
              ? `channel means R ${f.pixels.tone.meanR} G ${f.pixels.tone.meanG} B ${f.pixels.tone.meanB} · balance R/G ${f.pixels.tone.ratioRG}, B/G ${f.pixels.tone.ratioBG} · ` +
                `${(f.pixels.tone.clippedLow * 100).toFixed(3)}% pure black, ${(f.pixels.tone.clippedHigh * 100).toFixed(3)}% pure white · noise floor ${f.pixels.tone.noise} · ` +
                `${f.pixels.tone.distinctLuma} of 256 luma values present. These are scene-dependent: compare them between photographs of the same scene, never across different ones.`
              : "not measured",
          },
          { label: "MD5", value: f.hashes.md5 },
          { label: "SHA-1", value: f.hashes.sha1 },
          { label: "SHA-256", value: f.hashes.sha256 },
          { label: "CRC-32", value: f.hashes.crc32 },
        ],
      });
      for (const warning of f.warnings) photoBlocks.push({ kind: "prose", text: `! ${warning}` });
    }
  }
  sections.push({
    id: "photos",
    title: "Every photo, in full",
    blurb:
      "Per photo: which path produced it, its true dimensions, its encoder fingerprint, its compression tables, its metadata directories, its colour profile, its internal structure, what its pixels measure and four checksums.",
    blocks: photoBlocks,
  });

  const constancy = buildConstancy(constancyObservations(facts));
  const constancyBlocks: SheetBlock[] = [
    {
      kind: "prose",
      text:
        "Each trait is classified by what it moves WITH, which is the part no single file can tell you. " +
        "Hold the wrong one constant and the result is wrong in a way a one-file comparison would never catch. " +
        "Nothing here is extrapolated to a request this run never made.",
    },
    {
      kind: "rows",
      rows: [
        { label: "Photos classified", value: String(constancy.coverage.captures) },
        { label: "Production paths covered", value: constancy.coverage.paths.join(", ") || "none" },
        { label: "Cameras covered", value: constancy.coverage.cameras.join(", ") || "none" },
        { label: "Frame sizes covered", value: constancy.coverage.sizes.join(", ") || "none" },
      ],
    },
  ];
  for (const note of constancy.notes) constancyBlocks.push({ kind: "prose", text: `! ${note}` });
  if (constancy.traits.length > 0) {
    constancyBlocks.push({
      kind: "table",
      head: ["Trait", "Moves with", "Values seen", "What to do with it"],
      rows: constancy.traits.map((trait) => [
        trait.name,
        trait.classification,
        trait.values.length === 1 ? trait.values[0].value : `${trait.values.length} distinct: ${trait.values.map((v) => v.value).slice(0, 3).join(" | ")}`,
        trait.guidance,
      ]),
    });
  }
  sections.push({
    id: "constancy",
    title: "What holds, and what moves",
    blurb: "Which traits held across every camera and path, which follow the path, which belong to one lens, and which follow the frame size.",
    blocks: constancyBlocks,
  });

  sections.push({
    id: "omissions",
    title: partial ? "What did not run" : "Nothing was omitted",
    blurb: "A gap must never be mistaken for a finding, so every one is named with its reason.",
    blocks:
      run.omissions.length === 0 && !run.matrix?.aborted
        ? [{ kind: "prose", text: "Every stage ran to completion." }]
        : [
            {
              kind: "rows",
              rows: [
                ...run.omissions.map((o) => ({ label: o.stage, value: o.reason, tone: "warn" as const })),
                ...(run.matrix?.aborted
                  ? [{ label: "Camera sweep", value: "You stopped it early. The rows that ran are all real; the rest are simply absent.", tone: "warn" as const }]
                  : []),
              ],
            },
          ],
  });

  if (run.capacitor) {
    const pass = run.capacitor;
    const blocks: SheetBlock[] = [{ kind: "mono", text: CAPACITOR_PASS_POLICY }];
    if (pass.cameraRequest) {
      blocks.push({
        kind: "prose",
        text: `DOES THIS PHONE HONOUR A CAMERA REQUEST? ${pass.cameraRequest.verdict}`,
      });
    } else {
      blocks.push({
        kind: "prose",
        text: "The camera request was not measured: the pair of shots that measures it did not both complete. Stated as unmeasured rather than answered — one shot on its own cannot tell an honoured request from an ignored one.",
      });
    }
    if (pass.selfReport) {
      const report = pass.selfReport;
      blocks.push(
        {
          kind: "rows",
          rows: [
            { label: "Platform Capacitor believes it is on", value: report.platform },
            { label: "Running natively?", value: report.isNativePlatform ? "yes" : "no — this is a website, so most native-only abilities do not exist here" },
            { label: "Plugin present", value: report.pluginPresent ? "yes" : "no" },
            ...report.permissions.map((pair) => ({
              label: `Permission “${pair.what}”`,
              value: `Capacitor says ${pair.capacitor ?? "nothing — the call is unimplemented here, which is UNAVAILABLE and not denied"} · the browser says ${pair.browser ?? "nothing — this browser has no entry for it"}`,
              tone: pair.disagreement ? ("warn" as const) : undefined,
            })),
          ],
        },
        {
          kind: "table",
          head: ["Ability", "Present here", "What it is"],
          rows: report.abilities.map((ability) => [ability.name, ability.present ? "yes" : "absent — never asked, nothing claimed", ability.note]),
        }
      );
      for (const pair of report.permissions) {
        if (pair.disagreement) blocks.push({ kind: "prose", text: pair.disagreement });
      }
      for (const note of report.notes) blocks.push({ kind: "prose", text: note });
      for (const error of report.errors) blocks.push({ kind: "prose", text: error });
    }
    if (pass.forms.length > 0) {
      blocks.push({
        kind: "table",
        head: ["Form", "What came back"],
        rows: pass.forms.map((form) => [PHOTO_FORM_LABEL[form.form], form.reading]),
      });
    } else {
      blocks.push({
        kind: "prose",
        text: "No alternate form was collected, so nothing is said about what any of them would have done to the file. That is an absence, not a result.",
      });
    }
    blocks.push({ kind: "mono", text: MAX_DATA_POLICY });
    sections.push({
      id: "capacitor",
      title: "The Capacitor pass",
      blurb:
        "The one route in the run that returns several files from a single trip, hands the same photo back in three shapes, and has its own opinion about your permissions. Every pick here is a library pick and none is offered as a photo taken just now.",
      blocks,
    });
  }

  if (run.cost) {
    const cost = run.cost;
    sections.push({
      id: "cost",
      title: "What this run cost",
      blurb:
        "Wall clock readings from this run on this phone, not an average of other devices and not a target. A slow camera is a fact about the hardware, and one of the more useful ones here.",
      blocks: [
        {
          kind: "rows",
          rows: [
            { label: "Total", value: formatDuration(cost.totalMs) },
            ...cost.stages.map((stage) => ({
              label: stage.stage,
              value: `${formatDuration(stage.ms)}${cost.totalMs > 0 ? ` · ${Math.round((stage.ms / cost.totalMs) * 100)}%` : ""}`,
            })),
          ],
        },
        ...(cost.cameras.length > 0
          ? ([
              {
                kind: "table",
                head: ["Camera", "Time", "Requests", "Untried"],
                rows: cost.cameras.map((camera) => [
                  camera.label + (camera.hitBudget ? "  (reached its share of the run's time)" : ""),
                  formatDuration(camera.ms),
                  String(camera.steps),
                  camera.untried > 0 ? String(camera.untried) : "none",
                ]),
              },
            ] as SheetBlock[])
          : []),
        {
          kind: "prose",
          text: cost.slowestStep
            ? `Slowest single request: ${formatDuration(cost.slowestStep.ms)} — ${cost.slowestStep.label}. Measured against the ${(cost.cameraDeadlineMs / 1000).toFixed(0)}-second camera deadline, past which a request is abandoned rather than waited on. A request close to that line is a camera that very nearly did not answer at all.`
            : "No camera request was timed, so there is no slowest one to name. That is an absence, not a zero.",
        },
        ...(cost.perCameraBudgetMs != null
          ? ([
              {
                kind: "prose",
                text: `Each camera was allowed ${formatDuration(cost.perCameraBudgetMs)} of its own. A camera that reaches it stops where it is and every step it never got to is listed as UNTRIED — which is its own word here. It is NOT a refusal, NOT a limit the camera stated and NOT a timeout: those three exist separately, they mean different things, and nothing whatsoever is inferred about a step that never ran. The ceiling is generous on purpose; it exists for the one camera on a phone that takes fifteen seconds to open and would otherwise consume the entire run.`,
              },
            ] as SheetBlock[])
          : []),
      ],
    });
  }

  sections.push({
    id: "verify",
    title: "Checking this yourself",
    blurb: "This sheet cannot verify itself. These are the numbers and the commands to check it with tools that owe this app nothing.",
    blocks: [{ kind: "mono", text: VERIFY_HOW_TO }],
  });

  return sections;
}

/* ------------------------------------------------------------------ *
 * Renderings
 * ------------------------------------------------------------------ */

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(indent + line);
  return lines;
}

function renderText(sections: SheetSection[], run: RunFacts, partial: boolean): string {
  const lines: string[] = [
    "DEEP PROBE — FULL STAT AND SPEC SHEET",
    "=".repeat(78),
    "",
    partial ? "*** PARTIAL RUN. Every missing stage is named in the omissions section. ***" : "This run completed every stage.",
    `Generated ${run.finishedAt}`,
    "",
    "This is the whole of what one website could detect about this device in one session, with no",
    "archive required to read it. It is a diagnostic: it states readings, never conclusions.",
    "",
  ];
  for (const section of sections) {
    lines.push("", "=".repeat(78), section.title.toUpperCase(), "=".repeat(78));
    lines.push(...wrap(section.blurb, 96, ""), "");
    for (const block of section.blocks) {
      if (block.kind === "prose") {
        lines.push(...wrap(block.text, 96, ""), "");
      } else if (block.kind === "mono") {
        lines.push(block.text, "");
      } else if (block.kind === "rows") {
        const width = Math.min(34, Math.max(...block.rows.map((r) => r.label.length), 0) + 2);
        for (const row of block.rows) {
          const value = row.value.split("\n").join(" ");
          if (value.length + width <= 96) lines.push(`  ${row.label.padEnd(width)}${value}`);
          else {
            lines.push(`  ${row.label}`);
            lines.push(...wrap(value, 92, "    "));
          }
        }
        lines.push("");
      } else {
        lines.push(`  ${block.head.join(" | ")}`, `  ${"-".repeat(90)}`);
        for (const row of block.rows) lines.push(`  ${row.map((cell) => cell.split("\n").join(" ")).join(" | ")}`);
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}

const SHEET_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 72px;background:#0e1116;color:#e8edf3;font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto}
h1{margin:0 0 6px;font-size:27px;letter-spacing:-0.02em}
h2{margin:40px 0 6px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#c084fc;border-bottom:1px solid #232b36;padding-bottom:8px}
p{margin:8px 0}
.sub{color:#8b9aab;font-size:13px;margin:0 0 4px}
.blurb{color:#8b9aab;font-size:12.5px;margin:0 0 14px}
.banner{margin:18px 0;padding:14px 16px;border-radius:12px;border:1px solid #6b4d09;background:#2a2109;color:#f3d38a;font-size:14px}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12.5px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #1e252f;vertical-align:top}
th{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#7d8da0}
.rows{margin:10px 0;border:1px solid #1e252f;border-radius:12px;overflow:hidden}
.rows div{display:grid;grid-template-columns:minmax(140px,32%) 1fr;gap:12px;padding:7px 11px;border-bottom:1px solid #171d25;font-size:12.5px}
.rows div:last-child{border-bottom:0}
.rows b{color:#8b9aab;font-weight:500}
.ok{color:#5ee0a0}.bad{color:#ff9a9a}.warn{color:#f3d38a}.muted{color:#8b9aab}
pre{background:#151a21;border:1px solid #232b36;border-radius:12px;padding:14px;overflow:auto;font:11.5px/1.55 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
@media print{body{background:#fff;color:#111}}
`;

function renderHtml(sections: SheetSection[], run: RunFacts, partial: boolean): string {
  const parts: string[] = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Deep Probe — full stat and spec sheet</title>",
    `<style>${SHEET_CSS}</style></head><body><div class="wrap">`,
    "<h1>Deep Probe — full stat and spec sheet</h1>",
    `<p class="sub">${esc(run.startedAt)} → ${esc(run.finishedAt)} · scope ${esc(TIER_INFO[run.tier].label)}</p>`,
    partial
      ? '<div class="banner"><b>Partial run.</b> One or more stages did not complete. Everything present really happened; the missing parts are named in the omissions section rather than quietly left out.</div>'
      : "",
    '<p class="blurb">A diagnostic, not a judgement. It states readings and never reaches a verdict.</p>',
  ];
  for (const section of sections) {
    parts.push(`<h2 id="${esc(section.id)}">${esc(section.title)}</h2>`, `<p class="blurb">${esc(section.blurb)}</p>`);
    for (const block of section.blocks) {
      if (block.kind === "prose") parts.push(`<p>${esc(block.text)}</p>`);
      else if (block.kind === "mono") parts.push(`<pre>${esc(block.text)}</pre>`);
      else if (block.kind === "rows") {
        parts.push('<div class="rows">');
        for (const row of block.rows) {
          parts.push(`<div><b>${esc(row.label)}</b><span class="${row.tone ?? ""}">${esc(row.value)}</span></div>`);
        }
        parts.push("</div>");
      } else {
        parts.push("<table><thead><tr>", ...block.head.map((h) => `<th>${esc(h)}</th>`), "</tr></thead><tbody>");
        for (const row of block.rows) parts.push("<tr>", ...row.map((cell) => `<td>${esc(cell)}</td>`), "</tr>");
        parts.push("</tbody></table>");
      }
    }
  }
  parts.push("</div></body></html>");
  return parts.join("");
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Builds every sheet from the facts pass. Nothing here touches capture bytes,
 * which is the point: these can be produced after the bytes have been released
 * and long before any archive is attempted.
 */
export function buildSheets(run: RunFacts, facts: CaptureFacts[]): SheetSet {
  const correlationInput: CorrelationInput = {
    generatedAt: run.finishedAt,
    passive: run.passive,
    sensors: run.sensors,
    matrix: run.matrix,
    captures: facts.map((f) => f.brief),
    devicesBeforePermission: run.devicesBeforePermission,
    permissionStatesBefore: run.permissionStatesBefore,
    permissionStatesAfter: run.permissionStatesAfter,
    omissions: run.omissions,
  };
  const checklist = briefChecklist(correlationInput);
  const sections = buildSections(run, facts, checklist);
  const partial = run.omissions.length > 0 || run.matrix?.aborted === true;
  const suffix = stamp(new Date());
  const tail = partial ? "-PARTIAL" : "";

  return {
    generatedAt: run.finishedAt,
    partial,
    sections,
    statSheetText: renderText(sections, run, partial),
    statSheetHtml: renderHtml(sections, run, partial),
    correlationBrief: buildCorrelationBrief(correlationInput),
    forensicChecklist: checklist,
    specMarkdown: buildMimicSpec({
      generatedAt: run.finishedAt,
      tier: run.tier,
      passive: run.passive,
      permissionStates: run.permissionStatesAfter,
      permissions: run.permissions,
      sensors: run.sensors,
      matrix: run.matrix,
      captures: facts.map((f) => f.spec),
      omissions: run.omissions,
      briefChecklist: checklist,
    }),
    fileNames: {
      statText: `deep-probe-stat-sheet-${suffix}${tail}.txt`,
      statHtml: `deep-probe-stat-sheet-${suffix}${tail}.html`,
      brief: `deep-probe-correlation-brief-${suffix}${tail}.md`,
      checklist: `deep-probe-forensic-items-${suffix}${tail}.txt`,
      spec: `device-spec-${suffix}${tail}.md`,
    },
  };
}
