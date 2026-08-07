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
 * This file no longer reads the captures. The facts pass does that once, up
 * front, and the sheets are written from the result — so a run that never asks
 * for an archive never enters this file at all, and a run that does still only
 * walks the bytes once for facts and once for hex. What remains here is the
 * genuinely archive-shaped work: hex renderings, segment carving, assembly and
 * the byte-identity re-check.
 *
 * The two things this file will never do:
 *   • call a file a camera original when this app encoded it, and
 *   • imply completeness it did not achieve. Every truncation, every skipped
 *     stage and every unparsed container is named in the archive itself.
 */

import { downloadBlob, type LogEntry } from "../camera-diagnostics";
import { buildZip, crcHex, isDeflateSupported, safeZipPath, verifyBytes, type ZipEntry, type ZipEntryInfo } from "../zip-writer";
import { breatheEvery } from "./breathe";
import { capturePolicyText } from "./capture-memory";
import { folderFor, ORIGIN_TEXT, type CaptureFacts } from "./capture-facts";
import { matrixText, type ProbeCapture } from "./camera-matrix";
import { encoderText } from "./jpeg-encoder";
import { ifdText } from "./exif-ifd";
import { hashBlob } from "./hashes";
import { hexPolicyText, hexTextBytesFor, memoryPressure, perCaptureHexBudget, readMemoryHints, HEX_MIN_PER_CAPTURE, HEX_PRESSURE_LIMIT } from "./hex-budget";
import { passiveText } from "./passive";
import { seriesCsv } from "./sensors";
import { checksumsText, permissionLedgerText, sensorsText, stamp, VERIFY_HOW_TO, type RunFacts, type SheetSet, type StageOmission } from "./sheets";
import { hexDumpBlob, structureText } from "./raw-bytes";
import { TIER_INFO } from "./permissions";

export type { StageOmission } from "./sheets";

export type RawPackInput = RunFacts & {
  /** The capture list, still holding its bytes. Released runs cannot be archived. */
  captures: ProbeCapture[];
  /**
   * Total source bytes allowed a hex rendering across the whole run. Shared out
   * equally per capture rather than spent in arrival order — see `hex-budget.ts`
   * for why, and for the memory arithmetic that sets the figure.
   */
  hexBudgetBytes: number;
};

export type RawPackProgress = (message: string, done: number, total: number) => void;

export type RawPackOptions = {
  onProgress: RawPackProgress;
  /** Called before each unit of work, so the crash trail records where it died. */
  onStep?: (step: string) => void;
};

export type RawPackResult = {
  blob: Blob;
  fileName: string;
  files: number;
  bytes: number;
  warnings: string[];
  verification: { path: string; ok: boolean; detail: string }[];
};

/** Raised when an archive is asked for after the capture bytes were released. */
export class CapturesReleasedError extends Error {
  constructor() {
    super(
      "The archive cannot be built because the photo bytes were released. That happens when the run was started without the archive ticked, which is the setting that keeps memory low. Run Deep Probe again with the archive ticked to get one."
    );
    this.name = "CapturesReleasedError";
  }
}

function readMe(input: RawPackInput, facts: CaptureFacts[], fileCount: number): string {
  const partial = input.omissions.length > 0 || input.matrix?.aborted === true;
  const rendered = facts.filter((f) => f.archivePath.startsWith("rendered-frames/")).length;
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
    "stat-sheet.html          Start here. Every detectable factor of this run, end to end.",
    "stat-sheet.txt           The same sheet as plain text, for grepping and diffing.",
    "forensic-items.txt       The item list on its own, first in the sheet and standalone here.",
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
    "correlation-brief.md     Item-by-item answers to the forensic request: capture paths, encoder tables,",
    "                         raw directory entries, colour profile, JS surface and motion precision.",
    "device-spec.md           Only what is distinctive about this device, with the generic facts left out",
    "                         on purpose.",
    "raw/                     Per capture: the complete hex + ASCII dump, the structural map of the container,",
    "                         the full tag listing including undocumented entries, the JPEG encoder signature",
    "                         (quantisation and Huffman tables), and a raw EXIF directory walk reporting every",
    "                         entry's tag ID, type, count and stored value.",
    "camera/surface.json      track.getSettings/getCapabilities/getConstraints verbatim, plus the three",
    "                         enumerateDevices snapshots and the File objects, in camera/devices.json and",
    "                         camera/files.json.",
    "raw/hex-budget.txt       Why some hex dumps are windowed: the budget, the equal per-capture share, what",
    "                         a window omits, and how to dump the missing range yourself.",
    "camera/memory-policy.txt The two memory costs a byte counter cannot see \u2014 canvas backing store and image",
    "                         decoding \u2014 with this run's real figures and whether stills stopped early.",
    "log/build-trail.txt      Every step of this build with its duration and heap use, so a build that dies",
    "                         next time can be compared against one that did not.",
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

/**
 * Appends a suspension summary to the session log. Backgrounding is expected
 * during the camera-app handoff, so the archive states plainly that the gaps in
 * the timeline were the page being suspended and that the run continued across
 * them — an unexplained gap would otherwise look like missing evidence.
 */
function sessionLogText(logs: LogEntry[]): string {
  return [
    "DEEP PROBE SESSION LOG",
    "=".repeat(78),
    `${logs.length} entries, in order, exactly as recorded on the device.`,
    "",
    ...logs.map((l) => `${l.ts}  [${l.level.toUpperCase().padEnd(7)}] ${l.message}`),
  ].join("\n");
}

/** Builds the raw dump archive from facts already read and sheets already written. */
export async function buildRawPack(input: RawPackInput, facts: CaptureFacts[], sheets: SheetSet, options: RawPackOptions): Promise<RawPackResult> {
  if (facts.length > 0 && input.captures.length === 0) throw new CapturesReleasedError();

  const onProgress = options.onProgress;
  const step = (message: string): void => options.onStep?.(message);
  const entries: ZipEntry[] = [];
  const warnings: string[] = [];
  const capturePaths = new Map<string, ProbeCapture>();
  const byteTrail: string[] = [];
  const breather = breatheEvery();
  const buildStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
  const trailAt = (label: string): void => {
    const at = typeof performance !== "undefined" ? performance.now() : Date.now();
    byteTrail.push(`${((at - buildStarted) / 1000).toFixed(2).padStart(8)}s  ${label}`);
  };

  const total = input.captures.length * 2 + 14;
  let done = 0;
  const tick = (message: string): void => {
    done += 1;
    onProgress(message, done, total);
  };

  // Equal share per capture. Spending the budget first-come made the
  // completeness of a dump a fact about when a photo was taken rather than about
  // the photo, and let one early large file starve every capture after it.
  const perCaptureHex = perCaptureHexBudget(input.hexBudgetBytes, input.captures.length);
  // Deliberately the caller's own array: an omission discovered here has to reach
  // the on-screen list too, not just the archive.
  const omissions = input.omissions;
  let hexSpent = 0;
  let hexWindowed = 0;
  let pressureThrottled = false;

  const factBySlug = new Map(facts.map((f) => [f.slug, f]));

  for (const capture of input.captures) {
    const fact = factBySlug.get(capture.slug);
    if (!fact) {
      warnings.push(`${capture.slug} was captured but never read by the facts pass, so it is stored without its derived files. The bytes themselves are complete.`);
    }
    const path = fact?.archivePath ?? `${folderFor(capture)}/${safeZipPath(`${capture.slug}.bin`)}`;
    capturePaths.set(path, capture);

    // The capture itself: stored, never compressed, never re-encoded.
    entries.push({ path, data: capture.blob });

    if (fact) {
      if (fact.encoder) entries.push({ path: `raw/${capture.slug}.encoder.txt`, data: encoderText(fact.encoder, capture.label), compress: true });
      if (fact.ifd) entries.push({ path: `raw/${capture.slug}.ifd.txt`, data: ifdText(fact.ifd, capture.label), compress: true });
      entries.push({ path: `raw/${capture.slug}.structure.txt`, data: structureText(fact.structure, capture.label), compress: true });
      entries.push({ path: `raw/${capture.slug}.tags.txt`, data: fact.tags.text, compress: true });

      step(`Carving segments from ${capture.slug}`);
      for (const segment of fact.structure.segments) {
        if (segment.offset < 0 || segment.length <= 0 || segment.offset + segment.length > capture.blob.size) {
          warnings.push(`Segment "${segment.name}" of ${capture.slug} reported an out-of-range position and was not carved. The hex dump still covers those bytes.`);
          continue;
        }
        // Blob.slice is a lazy view: this costs no memory until something reads it,
        // and the ZIP writer reads each one exactly once, in order.
        entries.push({ path: `raw/segments/${capture.slug}/${safeZipPath(segment.name)}.bin`, data: capture.blob.slice(segment.offset, segment.offset + segment.length) });
      }
      trailAt(`segments carved: ${capture.slug}`);
      tick(`Carving segments from ${capture.slug}`);
      await breather.tick();
    } else {
      tick(`Packing ${capture.slug}`);
    }

    // Where the browser reports heap use, back off before it kills the tab.
    // Losing the whole archive to render bytes nobody reads would be a poor
    // trade, and the throttle is reported rather than applied quietly.
    const pressure = memoryPressure();
    const throttled = pressure != null && pressure > HEX_PRESSURE_LIMIT;
    if (throttled && !pressureThrottled) {
      pressureThrottled = true;
      warnings.push(
        `Memory use reached ${Math.round((pressure ?? 0) * 100)}% of this browser's heap limit while building. Hex dumps from ${capture.slug} onward drop to the minimum window so the archive finishes instead of the tab being killed. Every capture is still present and complete in captures/ — only the hex rendering is shortened.`
      );
      omissions.push({
        stage: "Full hex dumps for later captures",
        reason: `The browser reported heap use above ${Math.round(HEX_PRESSURE_LIMIT * 100)}% during the build, so hex rendering was reduced to the minimum window from ${capture.slug} onward. The captures themselves are unaffected and byte-identical.`,
      });
    }
    const allowance = throttled ? HEX_MIN_PER_CAPTURE : perCaptureHex;
    step(`Rendering hex for ${capture.slug} (${(allowance / 1024).toFixed(0)} KiB window)`);
    const hex = await hexDumpBlob(capture.blob, capture.label, allowance);
    hexSpent += hex.bytesRendered;
    entries.push({ path: `raw/${capture.slug}.hex.txt`, data: hex.blob, compress: true });
    if (hex.truncated) {
      hexWindowed += 1;
      warnings.push(`${capture.slug}: the hex dump is windowed, not complete — ${hex.note}`);
    }
    trailAt(`hex rendered: ${capture.slug}`);
    tick(`Dumping bytes of ${capture.slug}`);
    await breather.tick();
  }

  // Reports
  if (input.captures.length > 0) {
    entries.push({
      path: "raw/hex-budget.txt",
      data: [
        ...hexPolicyText(input.hexBudgetBytes, perCaptureHex, input.captures.length),
        "WHAT HAPPENED IN THIS RUN",
        "-".repeat(78),
        `  Complete dumps            ${input.captures.length - hexWindowed} of ${input.captures.length}`,
        `  Windowed dumps            ${hexWindowed} of ${input.captures.length}`,
        `  Source bytes rendered     ${hexSpent.toLocaleString("en-US")}`,
        `  Hex text produced         ~${hexTextBytesFor(hexSpent).toLocaleString("en-US")} bytes`,
        pressureThrottled
          ? "  Throttled                 YES \u2014 the browser reported heap pressure mid-build and later dumps\n                            dropped to the minimum window. Named in READ-ME.txt too."
          : "  Throttled                 no",
        "",
      ].join("\n"),
      compress: true,
    });
  }

  step("Writing the permission ledger");
  entries.push({ path: "permissions/ledger.txt", data: permissionLedgerText(input), compress: true });
  entries.push({
    path: "permissions/ledger.json",
    data: JSON.stringify({ kind: "deep-probe-permission-ledger", version: 1, tier: input.tier, requests: input.permissions }, null, 2),
    compress: true,
  });
  tick("Writing the permission ledger");
  await breather.tick();

  step("Writing the passive dump");
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
  await breather.tick();

  step("Writing the sensor recordings");
  entries.push({ path: "sensors/README.txt", data: sensorsText(input.sensors), compress: true });
  for (const series of input.sensors) {
    entries.push({ path: `sensors/${safeZipPath(series.id)}.csv`, data: seriesCsv(series), compress: true });
  }
  tick("Writing the sensor recordings");
  await breather.tick();

  step("Writing the camera matrix");
  if (input.matrix) {
    entries.push({ path: "camera/matrix.txt", data: matrixText(input.matrix), compress: true });
    entries.push({ path: "camera/matrix.json", data: JSON.stringify({ kind: "deep-probe-camera-matrix", version: 1, ...input.matrix }, null, 2), compress: true });
    entries.push({
      path: "camera/surface.json",
      data: JSON.stringify(
        {
          kind: "deep-probe-camera-surface",
          version: 1,
          note: "track.getSettings(), getCapabilities() and getConstraints() exactly as the browser returned them, with key order preserved. Key order is itself an engine trait, so nothing here was sorted, renamed or rounded.",
          cameras: input.matrix.surface,
        },
        null,
        2
      ),
      compress: true,
    });
    entries.push({
      path: "camera/memory-policy.txt",
      data: capturePolicyText(
        {
          heldBytes: input.matrix.memory.heldBytes,
          ceilingBytes: input.matrix.memory.ceilingBytes,
          peakCanvasBytes: input.matrix.memory.peakCanvasBytes,
          stillsStoppedForMemory: input.matrix.stillsStoppedForMemory,
        },
        readMemoryHints()
      ).join("\n"),
      compress: true,
    });
  } else {
    entries.push({
      path: "camera/NOT-RUN.txt",
      data: "The camera sweep did not run in this session. See READ-ME.txt for the reason. No camera data is claimed anywhere in this archive.",
    });
  }
  tick("Writing the camera matrix");
  await breather.tick();

  entries.push({
    path: "camera/devices.json",
    data: JSON.stringify(
      {
        kind: "deep-probe-device-enumeration",
        version: 1,
        note: "Three enumerateDevices() snapshots, full IDs, every kind included. Two would be ambiguous about when they were taken: beforeAnyPermission is the genuinely pre-grant state, beforeSweep is after the stage-one grant but before any camera was opened, afterSweep is the end state. Blank labels in the first are the privacy rule working, not a fault.",
        beforeAnyPermission: input.devicesBeforePermission,
        beforeSweep: input.matrix?.devicesBefore ?? [],
        afterSweep: input.matrix?.devicesAfter ?? [],
      },
      null,
      2
    ),
    compress: true,
  });

  const fileCaptures = input.captures.filter((c) => c.fileName != null);
  entries.push({
    path: "camera/files.json",
    data: JSON.stringify(
      {
        kind: "deep-probe-file-objects",
        version: 1,
        note: "The File object as a site receives it, in arrival order. lastModified is the raw epoch value, deliberately unformatted: the step between consecutive shots is the informative part and a formatted date would hide it.",
        files: fileCaptures.map((c) => ({
          slug: c.slug,
          name: c.fileName,
          size: c.blob.size,
          type: c.blob.type,
          lastModified: c.fileLastModified,
          webkitRelativePath: c.fileRelativePath,
          receivedAt: c.takenAt,
          producedBy: c.asked,
        })),
      },
      null,
      2
    ),
    compress: true,
  });
  tick("Writing the device and file surface");
  await breather.tick();

  step("Writing the checksum files");
  entries.push({ path: "checksums/checksums.txt", data: checksumsText(facts), compress: true });
  entries.push({ path: "checksums/checksums.md5", data: facts.map((f) => `${f.hashes.md5}  ${f.archivePath}`).join("\n") });
  entries.push({ path: "checksums/checksums.sha1", data: facts.map((f) => `${f.hashes.sha1}  ${f.archivePath}`).join("\n") });
  entries.push({ path: "checksums/checksums.sha256", data: facts.map((f) => `${f.hashes.sha256}  ${f.archivePath}`).join("\n") });
  tick("Writing the checksum files");
  await breather.tick();

  entries.push({ path: "log/session-log.txt", data: sessionLogText(input.logs), compress: true });
  tick("Writing the session log");

  // The sheets were written before this file ever ran. They are copied in, not
  // rebuilt, so what the archive contains is byte-identical to what was handed
  // over on screen.
  step("Copying in the sheets");
  entries.push({ path: "stat-sheet.html", data: sheets.statSheetHtml, compress: true });
  entries.push({ path: "stat-sheet.txt", data: sheets.statSheetText, compress: true });
  entries.push({ path: "forensic-items.txt", data: sheets.forensicChecklist, compress: true });
  entries.push({ path: "correlation-brief.md", data: sheets.correlationBrief, compress: true });
  entries.push({ path: "device-spec.md", data: sheets.specMarkdown, compress: true });
  tick("Copying in the sheets");
  await breather.tick();

  const fileCount = entries.length + 6;
  entries.unshift({ path: "READ-ME.txt", data: readMe(input, facts, fileCount) });
  trailAt("entry list complete, assembly begins");
  entries.push({
    path: "log/build-trail.txt",
    data: [
      "ARCHIVE BUILD TRAIL",
      "=".repeat(78),
      "",
      "Wall-clock time at each stage of building this archive, measured from the moment the build began.",
      "A build that dies next time can be compared against this one to see exactly where it got further,",
      "or did not. The same trail is written to browser storage as it happens, so a build that kills the",
      "tab still leaves this behind.",
      "",
      ...byteTrail,
      "",
    ].join("\n"),
    compress: true,
  });
  tick("Writing the build trail");

  // Build, then write the verification report citing every offset laid out above.
  step(`Assembling ${entries.length} entries`);
  const built = await buildZip(entries, {
    onProgress: (p) => {
      onProgress(`Archiving ${p.path}`, done, total);
      step(`Archiving ${p.path}`);
    },
    finalize: (table) => [
      { path: "verification/byte-identity.txt", data: verificationText(table, capturePaths), compress: true },
      { path: "MANIFEST.txt", data: manifestText(table) },
    ],
  });
  trailAt("archive assembled");
  tick("Assembling the archive");
  await breather.tick();

  // Carve every capture back out of the finished archive and compare. The claim
  // is checked, not asserted. Blob.slice is a view rather than a copy, and
  // verifyBytes streams, so this never materialises the archive twice.
  const verification: { path: string; ok: boolean; detail: string }[] = [];
  for (const entry of built.entries) {
    const capture = capturePaths.get(entry.path);
    if (!capture) continue;
    step(`Re-carving ${entry.path} to verify it`);
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
    await breather.tick();
  }
  trailAt("byte-identity re-check complete");
  tick("Re-carving every capture to verify it");

  if (!isDeflateSupported()) {
    warnings.push(
      "This browser has no CompressionStream, so every text file was stored uncompressed. The archive is correct and complete, just considerably larger than it would otherwise be."
    );
  }

  const partial = input.omissions.length > 0 || input.matrix?.aborted;
  const fileName = `deep-probe-${stamp(new Date())}${partial ? "-PARTIAL" : ""}.zip`;
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

/** MD5 of an arbitrary blob, re-exported so callers need not know where hashing lives. */
export { hashBlob };
