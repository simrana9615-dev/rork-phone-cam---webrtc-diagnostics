/**
 * Stage five — the raw dump archive.
 *
 * Same discipline as the evidence pack, turned up: captures go in untouched and
 * stored (never deflated), so extracting one returns identical bytes and the
 * claim is checked by carving them back out of the finished archive rather than
 * asserted. Derived text — hex dumps above all — is allowed to compress,
 * because nobody needs to carve a hex dump out at a byte offset and refusing to
 * compress it would triple an already large archive for no gain.
 *
 * The two things this file will never do:
 *   • call a file a camera original when this app encoded it, and
 *   • imply completeness it did not achieve. Every truncation, every skipped
 *     stage and every unparsed container is named in the archive itself.
 */

import ExifReader from "exifreader";

import { downloadBlob, formatBytes, type LogEntry } from "../camera-diagnostics";
import { buildZip, crcHex, isDeflateSupported, safeZipPath, verifyBytes, type ZipEntry, type ZipEntryInfo } from "../zip-writer";
import { hashBlob, type FileHashes } from "./hashes";
import { hexDumpBlob, structureText, walkStructure } from "./raw-bytes";
import { matrixText, type CameraMatrixReport, type ProbeCapture } from "./camera-matrix";
import { passiveText, type PassiveGroup } from "./passive";
import { seriesCsv, type SensorSeries } from "./sensors";
import { OUTCOME_LABEL, TIER_INFO, type PermissionRecord, type PermissionTier } from "./permissions";

/** A stage that did not run, and the honest reason. */
export type StageOmission = { stage: string; reason: string };

export type RawPackInput = {
  startedAt: string;
  finishedAt: string;
  tier: PermissionTier;
  permissions: PermissionRecord[];
  passive: PassiveGroup[];
  permissionStatesBefore: { name: string; state: string | null }[];
  permissionStatesAfter: { name: string; state: string | null }[];
  sensors: SensorSeries[];
  matrix: CameraMatrixReport | null;
  captures: ProbeCapture[];
  logs: LogEntry[];
  /** Stages that never ran — named, with the reason, so the archive is never quietly partial. */
  omissions: StageOmission[];
  /** Total source bytes allowed to receive a complete hex dump. */
  hexBudgetBytes: number;
};

export type RawPackProgress = (message: string, done: number, total: number) => void;

export type RawPackResult = {
  blob: Blob;
  fileName: string;
  files: number;
  bytes: number;
  warnings: string[];
  verification: { path: string; ok: boolean; detail: string }[];
};

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

function extensionFor(blob: Blob, fileName: string | null): string {
  const fromName = fileName?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const base = blob.type.split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] ?? "bin";
}

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Captures whose bytes this app did not author go in `captures/`; the ones it did go in `rendered-frames/`. */
function folderFor(capture: ProbeCapture): "captures" | "rendered-frames" {
  return capture.origin === "app-encoded-frame" ? "rendered-frames" : "captures";
}

const ORIGIN_TEXT: Record<string, string> = {
  "camera-file": "A file the operating system's camera app produced and handed to the browser. These are the camera's own bytes, with whatever metadata it chose to write.",
  "supplied-file": "A file selected from storage. Copied in byte-for-byte; this app cannot know what happened to it before it arrived.",
  "platform-photo":
    "A still the browser's own photo pipeline produced from a live camera track. The bytes are the platform's; browsers write little or no camera metadata on this path, so sparse tags here are normal and mean nothing.",
  "recorder-stream": "The byte stream the browser's media recorder produced from a live track.",
  "app-encoded-frame":
    "A frame THIS APP drew from the video track onto a canvas and encoded as JPEG. It is not a camera file: the pixels came from the browser, the JPEG around them was written here. That is why it sits outside the captures folder.",
};

/** Everything recorded about one archived capture. */
type CaptureRecord = {
  capture: ProbeCapture;
  path: string;
  hashes: FileHashes;
  tagCount: number;
  unknownTagCount: number;
  hexTruncated: boolean;
  segmentCount: number;
  container: string;
};

function tagValue(tag: unknown): string {
  if (tag == null) return "";
  const holder = tag as { description?: unknown; value?: unknown };
  const raw = holder.description ?? holder.value ?? tag;
  let text: string;
  if (Array.isArray(raw)) text = raw.length > 48 ? `[${raw.length} values] ${JSON.stringify(raw.slice(0, 24))}…` : JSON.stringify(raw);
  else if (typeof raw === "object") {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  } else text = String(raw);
  return text.length > 600 ? `${text.slice(0, 600)}… (${text.length} chars total)` : text;
}

/**
 * Full tag listing, including the entries no dictionary names. `includeUnknown`
 * is the point of this function: the undocumented tags are exactly the ones a
 * normal viewer hides, and they are frequently the most device-specific.
 */
async function tagDump(blob: Blob, label: string): Promise<{ text: string; count: number; unknown: number }> {
  const lines: string[] = [`TAG DUMP — ${label}`, "=".repeat(78), ""];
  let buffer: ArrayBuffer;
  try {
    buffer = await blob.arrayBuffer();
  } catch (err) {
    return { text: `${lines.join("\n")}\nThe bytes could not be read: ${err instanceof Error ? err.message : String(err)}`, count: 0, unknown: 0 };
  }

  let count = 0;
  let unknown = 0;
  try {
    const tags = ExifReader.load(buffer, { expanded: true, includeUnknown: true }) as unknown as Record<string, Record<string, unknown>>;
    lines.push(
      "Read directly from the archived bytes, with unknown and undocumented entries INCLUDED. Ordinary",
      "metadata viewers drop those, which is a shame: an unnamed tag is still a fact about the device that",
      "wrote the file, and on phone cameras there are usually plenty of them.",
      ""
    );
    for (const group of Object.keys(tags).sort()) {
      const groupTags = tags[group];
      if (!groupTags || typeof groupTags !== "object") continue;
      const keys = Object.keys(groupTags);
      if (keys.length === 0) continue;
      lines.push("", `── ${group} (${keys.length}) ──`);
      for (const key of keys.sort()) {
        if (key === "Thumbnail") {
          lines.push(`  ${key} = [embedded thumbnail — carved out as its own file, see the segments folder]`);
          count += 1;
          continue;
        }
        const isUnknown = /^undefined-|^unknown/i.test(key) || /^\d+$/.test(key);
        if (isUnknown) unknown += 1;
        lines.push(`  ${isUnknown ? "[undocumented] " : ""}${key} = ${tagValue(groupTags[key])}`);
        count += 1;
      }
    }
    if (count === 0) {
      lines.push(
        "No tags at all.",
        "",
        "For a frame this app encoded from a video track that is the expected and only possible result — a",
        "canvas encode cannot carry camera metadata. Absence here is not evidence of anything."
      );
    }
  } catch (err) {
    lines.push(`The metadata parser could not read this file: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { text: lines.join("\n"), count, unknown };
}

function permissionLedgerText(input: RawPackInput): string {
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

function sensorsText(series: SensorSeries[]): string {
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

const VERIFY_HOW_TO = [
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

function readMe(input: RawPackInput, records: CaptureRecord[], fileCount: number): string {
  const partial = input.omissions.length > 0 || input.matrix?.aborted === true;
  const rendered = records.filter((r) => folderFor(r.capture) === "rendered-frames").length;
  return [
    "DEEP PROBE — RAW DUMP",
    "=".repeat(78),
    "",
    partial ? "*** THIS IS A PARTIAL RUN. See WHAT DID NOT RUN below. ***" : "This run completed every stage.",
    "",
    `Started  ${input.startedAt}`,
    `Finished ${input.finishedAt}`,
    `Scope    ${TIER_INFO[input.tier].label}`,
    `Files    ${fileCount}`,
    "",
    "WHAT THIS IS",
    "-".repeat(78),
    "A record of what one website was able to ask your device for, what your device handed over, and what",
    "it refused. Nothing here was uploaded anywhere — the whole run happened on your phone and this archive",
    "was assembled in the browser.",
    "",
    "WHAT IS IN HERE",
    "-".repeat(78),
    "overview.html            Start here. The readable summary of the whole run.",
    "permissions/             Every request: when it fired, what came back, how long you took to answer,",
    "                         and what that permission would have reached.",
    "environment/             Everything readable WITHOUT any prompt at all. Arguably the more revealing half.",
    "sensors/                 Time series from the sensors you granted, as plain CSV you can plot.",
    "camera/                  The asked-versus-granted matrix for every camera, resolution, ratio, frame rate",
    "                         and control mode that was tried.",
    "captures/                Photos whose bytes this app did NOT author — camera files and platform stills —",
    "                         copied in byte-for-byte and stored uncompressed on purpose.",
    ...(rendered > 0
      ? [
          "rendered-frames/         Frames this app drew from a video track and encoded itself. NOT camera files.",
          "                         Kept separate so they can never be mistaken for camera output.",
        ]
      : []),
    "raw/                     Per capture: the complete hex + ASCII dump, the structural map of the container,",
    "                         and the full tag listing including undocumented entries.",
    "raw/segments/            Metadata regions carved out whole — EXIF block, maker note, colour profile,",
    "                         embedded thumbnails — each at its exact position in the original.",
    "checksums/               MD5, SHA-1, SHA-256 and CRC-32 for every capture, plus digest files in the",
    "                         format md5sum and sha256sum read directly.",
    "verification/            Size, checksum and byte offset of every entry, and how to check it yourself.",
    "log/                     The full session timeline.",
    "MANIFEST.txt             Every file with its exact byte size.",
    "",
    "WHAT THIS ARCHIVE DOES AND DOES NOT PROVE",
    "-".repeat(78),
    "It proves this app did not modify the captured files: they are stored uncompressed at known offsets and",
    "you can carve them out and checksum them yourself.",
    "",
    "It does not prove that any photo shows something real, and it makes no claim about that. It also does",
    "not claim to have asked for every permission that exists — only every one this app knows how to ask for",
    "at the chosen scope, which differs by browser and changes with every release.",
    "",
    partial ? "WHAT DID NOT RUN" : "NOTHING WAS OMITTED",
    "-".repeat(78),
    ...(input.omissions.length > 0
      ? input.omissions.map((o) => `  • ${o.stage}\n    ${o.reason}`)
      : ["  Every stage ran to completion."]),
    ...(input.matrix?.aborted ? ["  • Camera sweep\n    You stopped it early. The rows that ran are all real; the rest are simply absent."] : []),
    "",
    VERIFY_HOW_TO,
  ].join("\n");
}

function checksumsText(records: CaptureRecord[]): string {
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
  for (const r of records) {
    lines.push(
      r.path,
      `  bytes    ${r.hashes.bytes.toLocaleString("en-US")}`,
      `  md5      ${r.hashes.md5}`,
      `  sha1     ${r.hashes.sha1}`,
      `  sha256   ${r.hashes.sha256}`,
      `  crc32    ${r.hashes.crc32}`,
      ""
    );
  }
  return lines.join("\n");
}

function overviewHtml(input: RawPackInput, records: CaptureRecord[], fileCount: number, totalBytes: number): string {
  const counts = new Map<string, number>();
  for (const p of input.permissions) counts.set(p.outcome, (counts.get(p.outcome) ?? 0) + 1);
  const partial = input.omissions.length > 0 || input.matrix?.aborted === true;
  const matrixRows = input.matrix?.rows ?? [];
  const grantedRows = matrixRows.filter((r) => r.ok).length;

  const css = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 72px;background:#0e1116;color:#e8edf3;font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:940px;margin:0 auto}
h1{margin:0 0 6px;font-size:27px;letter-spacing:-0.02em}
h2{margin:36px 0 12px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#7d8da0;border-bottom:1px solid #232b36;padding-bottom:8px}
p{margin:8px 0}
.sub{color:#8b9aab;font-size:13px;margin:0 0 4px}
.banner{margin:18px 0;padding:14px 16px;border-radius:12px;border:1px solid #6b4d09;background:#2a2109;color:#f3d38a;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}
.stat{background:#151a21;border:1px solid #232b36;border-radius:12px;padding:12px 14px}
.stat b{display:block;font-size:24px;letter-spacing:-0.02em}
.stat span{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:#7d8da0}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13.5px}
th,td{text-align:left;padding:8px 9px;border-bottom:1px solid #1e252f;vertical-align:top}
th{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#7d8da0}
.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600}
.granted{background:#0d3323;color:#5ee0a0}
.denied{background:#3a1518;color:#ff9a9a}
.unavailable{background:#1b2430;color:#8fb0d4}
.skipped{background:#2a2109;color:#f3d38a}
.dismissed{background:#2a2109;color:#f3d38a}
.error{background:#3a1518;color:#ff9a9a}
code{background:#1a212a;padding:2px 6px;border-radius:5px;font:12px ui-monospace,Menlo,monospace}
.muted{color:#8b9aab;font-size:13px}
@media print{body{background:#fff;color:#111}}
`;

  const parts: string[] = [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Deep Probe — Raw Dump</title>",
    `<style>${css}</style></head><body><div class="wrap">`,
    "<h1>Deep Probe — raw dump</h1>",
    `<p class="sub">${esc(input.startedAt)} → ${esc(input.finishedAt)} · scope ${esc(TIER_INFO[input.tier].label)}</p>`,
    partial
      ? '<div class="banner"><b>Partial run.</b> One or more stages did not complete. Everything present really happened; the missing parts are named in READ-ME.txt rather than quietly left out.</div>'
      : "",
    '<div class="grid">',
    `<div class="stat"><b>${input.permissions.length}</b><span>requests made</span></div>`,
    `<div class="stat"><b>${counts.get("granted") ?? 0}</b><span>allowed</span></div>`,
    `<div class="stat"><b>${counts.get("denied") ?? 0}</b><span>denied</span></div>`,
    `<div class="stat"><b>${counts.get("unavailable") ?? 0}</b><span>not in this browser</span></div>`,
    `<div class="stat"><b>${records.length}</b><span>photos</span></div>`,
    `<div class="stat"><b>${matrixRows.length}</b><span>camera requests</span></div>`,
    `<div class="stat"><b>${fileCount}</b><span>files in archive</span></div>`,
    `<div class="stat"><b>${formatBytes(totalBytes)}</b><span>archive size</span></div>`,
    "</div>",

    "<h2>What was asked for</h2>",
    '<p class="muted">Denied and “not in this browser” are different things and are never merged. An unavailable API was never asked about at all.</p>',
    "<table><thead><tr><th>Request</th><th>Outcome</th><th>What it reaches</th><th>You answered in</th></tr></thead><tbody>",
    ...input.permissions.map(
      (p) =>
        `<tr><td><b>${esc(p.label)}</b><br><code>${esc(p.api)}</code></td><td><span class="tag ${p.outcome}">${esc(OUTCOME_LABEL[p.outcome])}</span></td><td class="muted">${esc(p.reaches)}</td><td class="muted">${p.outcome === "unavailable" ? "—" : `${p.responseMs} ms`}</td></tr>`
    ),
    "</tbody></table>",

    "<h2>What was taken without asking</h2>",
    '<p class="muted">No prompt, no indicator, no way to decline. The full listing is in <code>environment/passive-dump.txt</code>.</p>',
    "<table><tbody>",
    ...input.passive.flatMap((g) => [
      `<tr><th colspan="2">${esc(g.title)}</th></tr>`,
      ...g.rows.slice(0, 6).map((r) => `<tr><td class="muted">${esc(r.label)}</td><td><code>${esc(r.value.slice(0, 120))}</code></td></tr>`),
    ]),
    "</tbody></table>",
  ];

  if (input.matrix) {
    parts.push(
      "<h2>Camera sweep</h2>",
      `<p>${grantedRows} of ${matrixRows.length} requests were granted across ${input.matrix.inventory.length} camera(s). A rejection is a result, not a fault — it marks where the hardware's limit actually is.</p>`,
      '<p class="muted">Full asked-versus-granted table: <code>camera/matrix.txt</code></p>'
    );
  }

  if (input.sensors.length > 0) {
    parts.push(
      "<h2>Sensor recordings</h2>",
      "<table><thead><tr><th>Sensor</th><th>Samples</th><th>Measured rate</th><th>Notes</th></tr></thead><tbody>",
      ...input.sensors.map(
        (s) =>
          `<tr><td>${esc(s.label)}</td><td>${s.rows.length}</td><td>${s.measuredHz != null ? `${s.measuredHz} Hz` : "—"}</td><td class="muted">${esc(s.note)}</td></tr>`
      ),
      "</tbody></table>"
    );
  }

  parts.push(
    "<h2>Photos</h2>",
    "<table><thead><tr><th>File</th><th>Where the bytes came from</th><th>Tags found</th><th>SHA-256</th></tr></thead><tbody>",
    ...records.map(
      (r) =>
        `<tr><td><code>${esc(r.path)}</code><br><span class="muted">${esc(r.capture.label)}</span></td><td class="muted">${esc(ORIGIN_TEXT[r.capture.origin] ?? r.capture.origin)}</td><td>${r.tagCount}${r.unknownTagCount > 0 ? ` <span class="muted">(${r.unknownTagCount} undocumented)</span>` : ""}</td><td><code>${esc(r.hashes.sha256.slice(0, 24))}…</code></td></tr>`
    ),
    "</tbody></table>",
    "<h2>Checking this yourself</h2>",
    `<pre style="background:#151a21;border:1px solid #232b36;border-radius:12px;padding:14px;overflow:auto;font:12px/1.6 ui-monospace,Menlo,monospace">${esc(VERIFY_HOW_TO)}</pre>`,
    "</div></body></html>"
  );
  return parts.join("");
}

/** Builds the raw dump archive. */
export async function buildRawPack(input: RawPackInput, onProgress: RawPackProgress): Promise<RawPackResult> {
  const entries: ZipEntry[] = [];
  const warnings: string[] = [];
  const records: CaptureRecord[] = [];
  const capturePaths = new Map<string, ProbeCapture>();

  const total = input.captures.length * 4 + 12;
  let done = 0;
  const tick = (message: string): void => {
    done += 1;
    onProgress(message, done, total);
  };

  let hexSpent = 0;

  for (const capture of input.captures) {
    const folder = folderFor(capture);
    const ext = extensionFor(capture.blob, capture.fileName);
    const path = `${folder}/${safeZipPath(`${capture.slug}.${ext}`)}`;
    capturePaths.set(path, capture);

    // The capture itself: stored, never compressed, never re-encoded.
    entries.push({ path, data: capture.blob });
    tick(`Packing ${capture.slug}`);

    const hashes = await hashBlob(capture.blob);
    tick(`Checksumming ${capture.slug}`);

    const structure = await walkStructure(capture.blob);
    entries.push({ path: `raw/${capture.slug}.structure.txt`, data: structureText(structure, capture.label), compress: true });
    for (const segment of structure.segments) {
      if (segment.offset < 0 || segment.length <= 0 || segment.offset + segment.length > capture.blob.size) {
        warnings.push(`Segment "${segment.name}" of ${capture.slug} reported an out-of-range position and was not carved. The hex dump still covers those bytes.`);
        continue;
      }
      entries.push({
        path: `raw/segments/${capture.slug}/${safeZipPath(segment.name)}.bin`,
        data: capture.blob.slice(segment.offset, segment.offset + segment.length),
      });
    }
    tick(`Carving segments from ${capture.slug}`);

    const remaining = Math.max(0, input.hexBudgetBytes - hexSpent);
    const hex = await hexDumpBlob(capture.blob, capture.label, remaining);
    hexSpent += hex.bytesRendered;
    entries.push({ path: `raw/${capture.slug}.hex.txt`, data: hex.blob, compress: true });
    if (hex.truncated) {
      warnings.push(`${capture.slug}: the hex dump is windowed, not complete — ${hex.note}`);
    }

    const tags = await tagDump(capture.blob, capture.label);
    entries.push({ path: `raw/${capture.slug}.tags.txt`, data: tags.text, compress: true });
    tick(`Dumping bytes of ${capture.slug}`);

    records.push({
      capture,
      path,
      hashes,
      tagCount: tags.count,
      unknownTagCount: tags.unknown,
      hexTruncated: hex.truncated,
      segmentCount: structure.segments.length,
      container: structure.container,
    });
  }

  // Reports
  entries.push({ path: "permissions/ledger.txt", data: permissionLedgerText(input), compress: true });
  entries.push({
    path: "permissions/ledger.json",
    data: JSON.stringify({ kind: "deep-probe-permission-ledger", version: 1, tier: input.tier, requests: input.permissions }, null, 2),
    compress: true,
  });
  tick("Writing the permission ledger");

  entries.push({ path: "environment/passive-dump.txt", data: passiveText(input.passive, input.permissionStatesAfter), compress: true });
  entries.push({
    path: "environment/passive-dump.json",
    data: JSON.stringify(
      {
        kind: "deep-probe-passive-dump",
        version: 1,
        groups: input.passive,
        permissionStatesBefore: input.permissionStatesBefore,
        permissionStatesAfter: input.permissionStatesAfter,
      },
      null,
      2
    ),
    compress: true,
  });
  tick("Writing the passive dump");

  entries.push({ path: "sensors/README.txt", data: sensorsText(input.sensors), compress: true });
  for (const series of input.sensors) {
    entries.push({ path: `sensors/${safeZipPath(series.id)}.csv`, data: seriesCsv(series), compress: true });
  }
  tick("Writing the sensor recordings");

  if (input.matrix) {
    entries.push({ path: "camera/matrix.txt", data: matrixText(input.matrix), compress: true });
    entries.push({ path: "camera/matrix.json", data: JSON.stringify({ kind: "deep-probe-camera-matrix", version: 1, ...input.matrix }, null, 2), compress: true });
  } else {
    entries.push({
      path: "camera/NOT-RUN.txt",
      data: "The camera sweep did not run in this session. See READ-ME.txt for the reason. No camera data is claimed anywhere in this archive.",
    });
  }
  tick("Writing the camera matrix");

  entries.push({ path: "checksums/checksums.txt", data: checksumsText(records), compress: true });
  entries.push({ path: "checksums/checksums.md5", data: records.map((r) => `${r.hashes.md5}  ${r.path}`).join("\n") });
  entries.push({ path: "checksums/checksums.sha1", data: records.map((r) => `${r.hashes.sha1}  ${r.path}`).join("\n") });
  entries.push({ path: "checksums/checksums.sha256", data: records.map((r) => `${r.hashes.sha256}  ${r.path}`).join("\n") });
  tick("Writing the checksum files");

  entries.push({
    path: "log/session-log.txt",
    data: [
      "DEEP PROBE SESSION LOG",
      "=".repeat(78),
      `${input.logs.length} entries, in order, exactly as recorded on the device.`,
      "",
      ...input.logs.map((l) => `${l.ts}  [${l.level.toUpperCase().padEnd(7)}] ${l.message}`),
    ].join("\n"),
    compress: true,
  });
  tick("Writing the session log");

  const fileCount = entries.length + 5;
  entries.unshift({ path: "READ-ME.txt", data: readMe(input, records, fileCount) });
  entries.push({ path: "overview.html", data: overviewHtml(input, records, fileCount, 0), compress: true });
  tick("Writing the overview");

  // Build, then write the verification report citing every offset laid out above.
  const built = await buildZip(entries, {
    onProgress: (p) => onProgress(`Archiving ${p.path}`, done, total),
    finalize: (table) => [
      { path: "verification/byte-identity.txt", data: verificationText(table, capturePaths), compress: true },
      { path: "MANIFEST.txt", data: manifestText(table) },
    ],
  });
  tick("Assembling the archive");

  // Carve every capture back out of the finished archive and compare. The claim is checked, not asserted.
  const verification: { path: string; ok: boolean; detail: string }[] = [];
  for (const entry of built.entries) {
    const capture = capturePaths.get(entry.path);
    if (!capture) continue;
    const carved = built.blob.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    const check = await verifyBytes(carved, capture.blob);
    verification.push({
      path: entry.path,
      ok: check.identical && crcHex(check.crc32) === crcHex(entry.crc32),
      detail: check.identical
        ? `${entry.size.toLocaleString("en-US")} bytes carved at offset ${entry.dataOffset} are identical to the capture, CRC-32 ${crcHex(entry.crc32)}.`
        : `MISMATCH at byte ${check.firstDifferenceAt ?? "unknown"}. Do not trust this entry.`,
    });
    if (!check.identical) warnings.push(`Byte-identity check FAILED for ${entry.path}. This is reported rather than hidden.`);
  }
  tick("Re-carving every capture to verify it");

  if (!isDeflateSupported()) {
    warnings.push(
      "This browser has no CompressionStream, so every text file was stored uncompressed. The archive is correct and complete, just considerably larger than it would otherwise be."
    );
  }

  const fileName = `deep-probe-${stamp(new Date())}${input.omissions.length > 0 || input.matrix?.aborted ? "-PARTIAL" : ""}.zip`;
  return { blob: built.blob, fileName, files: built.entries.length, bytes: built.blob.size, warnings, verification };
}

function verificationText(table: ZipEntryInfo[], capturePaths: Map<string, ProbeCapture>): string {
  const lines: string[] = [
    "BYTE IDENTITY — VERIFICATION DATA",
    "=".repeat(78),
    "",
    "Every capture in this archive is stored with compression method 0 (store): not deflated, not decoded,",
    "not re-encoded. For each one you get its exact size, its CRC-32, and the byte offset inside this ZIP",
    "where its payload begins, so you can lift it straight out with dd and compare.",
    "",
    "Text files may be deflated (method 8) to keep the archive a sane size. Those are marked below, and",
    "carving one at its offset gives you compressed bytes rather than the text — use unzip for those.",
    "",
    VERIFY_HOW_TO,
    "CAPTURES — STORED, CARVABLE",
    "=".repeat(78),
    "",
  ];
  const captureRows = table.filter((e) => capturePaths.has(e.path));
  if (captureRows.length === 0) lines.push("(this archive contains no captures)", "");
  for (const e of captureRows) {
    const capture = capturePaths.get(e.path);
    lines.push(
      e.path,
      `  ${capture?.label ?? ""}`,
      `  origin      ${capture ? (ORIGIN_TEXT[capture.origin] ?? capture.origin) : "unknown"}`,
      `  bytes       ${e.size.toLocaleString("en-US")}`,
      `  stored      ${e.stored ? "yes — carve it out and you get the file" : "NO — this entry was deflated"}`,
      `  crc-32      ${crcHex(e.crc32)}`,
      `  data offset ${e.dataOffset}   (payload occupies bytes ${e.dataOffset}–${e.dataOffset + e.compressedSize - 1})`,
      ""
    );
  }
  lines.push("ALL OTHER ENTRIES", "=".repeat(78), "", "path | logical bytes | archived bytes | method | crc-32 | data offset", "-".repeat(78));
  for (const e of table) {
    if (capturePaths.has(e.path)) continue;
    lines.push(`${e.path} | ${e.size} | ${e.compressedSize} | ${e.stored ? "store" : "deflate"} | ${crcHex(e.crc32)} | ${e.dataOffset}`);
  }
  lines.push(
    "",
    "Entries created after this file was generated — the central directory, the manifest and this report's",
    "own entry — cannot appear above, because a file cannot state its own position before it has one.",
    "`unzip -t` covers those.",
    ""
  );
  return lines.join("\n");
}

function manifestText(table: ZipEntryInfo[]): string {
  const lines: string[] = ["MANIFEST", "=".repeat(78), "", "bytes        archived     method    path", "-".repeat(78)];
  for (const e of table) {
    lines.push(`${String(e.size).padStart(11)}  ${String(e.compressedSize).padStart(11)}  ${(e.stored ? "store" : "deflate").padEnd(8)}  ${e.path}`);
  }
  const totalLogical = table.reduce((s, e) => s + e.size, 0);
  const totalArchived = table.reduce((s, e) => s + e.compressedSize, 0);
  lines.push("-".repeat(78), `${String(totalLogical).padStart(11)}  ${String(totalArchived).padStart(11)}            ${table.length} entries`);
  return lines.join("\n");
}

/** Saves the archive to the device. */
export function downloadRawPack(result: RawPackResult): void {
  downloadBlob(result.blob, result.fileName);
}
