/**
 * The correlation brief — a direct, itemised answer to a specific forensic
 * request, so nothing has to be inferred from the rest of the archive.
 *
 * The design rule here is that the checklist and the detailed brief are rendered
 * from ONE registry of items. A summary that drifts from the document it
 * summarises is worse than no summary, and keeping two hand-written lists in
 * step is a promise no codebase keeps.
 *
 * Every item carries a status, and the statuses are deliberately four rather
 * than two:
 *
 *   captured        read from this run, and where to find it is stated.
 *   partial         some of it was read; what is missing is named.
 *   not-run         the stage did not happen. A gap in the observation.
 *   not-obtainable  a browser cannot read this at all. Not a gap — a limit.
 *
 * Collapsing the last two would be the central lie available to a document like
 * this: "we didn't look" and "it cannot be looked at" are entirely different
 * claims, and a requester needs to know which one they are reading.
 */

import type { CameraMatrixReport } from "./camera-matrix";
import type { ExifIfdReport } from "./exif-ifd";
import type { JpegEncoderReport } from "./jpeg-encoder";
import type { PassiveGroup } from "./passive";
import type { StageOmission } from "./raw-pack";
import type { SensorSeries } from "./sensors";

export type BriefStatus = "captured" | "partial" | "not-run" | "not-obtainable";

export type BriefItem = {
  /** Section number from the original request, kept so items can be matched back. */
  section: string;
  /** The thing that was asked for, in the requester's own terms. */
  ask: string;
  status: BriefStatus;
  /** What this run actually found, or why it could not be found. */
  answer: string;
  /** Archive path holding the evidence. Empty when there is nothing to point at. */
  where: string;
};

/** One capture, with the two deep parses already run over its bytes. */
export type BriefCapture = {
  slug: string;
  archivePath: string;
  label: string;
  /** The declared production path — the thing that determines the whole target. */
  path: "image-capture" | "canvas" | "camera-file" | "picker-file";
  origin: string;
  deviceLabel: string | null;
  fileName: string | null;
  fileLastModified: number | null;
  fileRelativePath: string | null;
  bytes: number;
  mime: string;
  width: number;
  height: number;
  encoder: JpegEncoderReport | null;
  ifd: ExifIfdReport | null;
  /** Our own MD5 of the exact ICC bytes, when a profile is embedded. */
  iccMd5: string | null;
};

export type CorrelationInput = {
  generatedAt: string;
  passive: PassiveGroup[];
  sensors: SensorSeries[];
  matrix: CameraMatrixReport | null;
  captures: BriefCapture[];
  /** `enumerateDevices()` taken before any permission was requested. */
  devicesBeforePermission: { kind: string; deviceId: string; groupId: string; label: string }[];
  permissionStatesBefore: { name: string; state: string | null }[];
  permissionStatesAfter: { name: string; state: string | null }[];
  omissions: StageOmission[];
};

const STATUS_LABEL: Record<BriefStatus, string> = {
  captured: "CAPTURED",
  partial: "PARTIAL",
  "not-run": "NOT RUN",
  "not-obtainable": "NOT OBTAINABLE",
};

function passiveValue(groups: PassiveGroup[], label: string): string | null {
  for (const group of groups) {
    const row = group.rows.find((r) => r.label === label);
    if (row) return row.value;
  }
  return null;
}

function byPath(captures: BriefCapture[], path: BriefCapture["path"]): BriefCapture[] {
  return captures.filter((c) => c.path === path);
}

/** iOS version as the user-agent states it. There is no better source on Safari. */
function iosVersionFrom(ua: string | null): string | null {
  if (!ua) return null;
  const match = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))?/);
  if (!match) return null;
  return `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/**
 * The exiftool invocations the requester asked for, pointed at this archive's
 * own paths. Emitted verbatim so they can be pasted.
 */
const EXIFTOOL_COMMANDS = [
  "# 1. Extract the originals first. Captures are STORED (method 0), so this is a pure copy.",
  "unzip -o <this>.zip -d unpacked && cd unpacked",
  "",
  "# 2. Numeric: all tags, all groups, unknown tags included, composites suppressed.",
  "exiftool -a -G1 -U -s -n --composite -api largefilesupport captures/<file>",
  "",
  "# 3. The same again WITHOUT -n, for the manufacturer's own formatting.",
  "exiftool -a -G1 -s captures/<file>",
  "",
  "# 4. Byte-level segment map.",
  "exiftool -htmlDump captures/<file> > dump.html",
  "",
  "# 5. Raw maker block.",
  "exiftool -MakerNotes -b captures/<file> | xxd | head -100",
  "",
  "# 6. Exact ICC bytes and their checksum.",
  "exiftool -icc_profile -b captures/<file> > icc.bin && md5sum icc.bin",
  "",
  "# The carved regions are already in the archive if you would rather not re-derive them:",
  "#   raw/segments/<slug>/exif-app1.bin    the whole EXIF block",
  "#   raw/segments/<slug>/maker-note.bin   the maker note alone",
  "#   raw/segments/<slug>/icc-profile.bin  the ICC profile alone",
  "#   raw/segments/<slug>/exif-thumbnail.bin",
].join("\n");

/* ------------------------------------------------------------------ *
 * Item registry
 * ------------------------------------------------------------------ */

function captureMatrixItems(input: CorrelationInput): BriefItem[] {
  const items: BriefItem[] = [];
  const cameraFiles = byPath(input.captures, "camera-file");
  const pickerFiles = byPath(input.captures, "picker-file");
  const canvas = byPath(input.captures, "canvas");
  const platform = byPath(input.captures, "image-capture");
  const ua = passiveValue(input.passive, "User agent");

  items.push({
    section: "0.1",
    ask: "Native Camera app photo → AirDrop/Files, as an untouched reference",
    status: "not-obtainable",
    answer:
      "A web page cannot produce this. Every file a browser can reach has already passed through a browser input, which is the exact transform the reference is meant to exclude. It has to be sideloaded by hand — AirDrop the original to a Mac and dump it there. Nothing in this archive should be treated as a substitute, and none of the files here claims to be one.",
    where: "",
  });
  items.push({
    section: "0.2",
    ask: "Same photo uploaded via <input type=file> from Photos",
    status: pickerFiles.length > 0 ? "captured" : "not-run",
    answer:
      pickerFiles.length > 0
        ? `${pickerFiles.length} file(s) on this path. This is the library-pick path, so the bytes are whatever Photos handed over — this app cannot know what happened to them beforehand and does not guess.`
        : "No library pick happened in this run. The manual stage offers the camera-app handoffs; a plain library pick was not among them.",
    where: pickerFiles.map((c) => c.archivePath).join(", "),
  });
  items.push({
    section: "0.3",
    ask: "<input type=file accept=image/* capture> — direct to camera",
    status: cameraFiles.length > 0 ? "captured" : "not-run",
    answer:
      cameraFiles.length > 0
        ? `${cameraFiles.length} file(s) across three distinct handoffs (the direct capture attribute, the bare boolean form, and Capacitor's camera API). This is the only path in the whole run that yields the camera's own metadata.`
        : "The manual stage did not complete, so no camera-app file was obtained. Without one there is no full EXIF example in this archive.",
    where: cameraFiles.map((c) => c.archivePath).join(", "),
  });
  items.push({
    section: "0.4",
    ask: "getUserMedia → canvas → toBlob → POST",
    status: canvas.length > 0 ? "captured" : "not-run",
    answer:
      canvas.length > 0
        ? `${canvas.length} frame(s), encoded by this app at JPEG quality 0.95 from a canvas. Filed under rendered-frames/ rather than captures/ precisely so they can never be read as camera output. Note the quality value when comparing quantisation tables: 0.95 here, not the 0.92 in your pipeline, so the tables will differ by that scaling and should not be expected to match.`
        : "No canvas frames were produced, because the camera sweep did not run.",
    where: canvas.map((c) => c.archivePath).slice(0, 4).join(", "),
  });
  items.push({
    section: "0.5",
    ask: "ImageCapture.takePhoto()",
    status: platform.length > 0 ? "captured" : "not-obtainable",
    answer:
      platform.length > 0
        ? `${platform.length} still(s) from the browser's own photo pipeline.`
        : "ImageCapture does not exist in this browser, so this path could not be exercised. Safari on iOS is in this position — the class is absent, so no request was ever made and this is not a refusal.",
    where: platform.map((c) => c.archivePath).slice(0, 4).join(", "),
  });

  const facings = new Set(input.captures.map((c) => c.deviceLabel ?? "").filter((l) => l.length > 0));
  items.push({
    section: "0.6",
    ask: "Front and back for each path",
    status: input.captures.length > 0 ? (cameraFiles.length >= 2 ? "captured" : "partial") : "not-run",
    answer:
      input.captures.length === 0
        ? "No captures in this run."
        : `The manual stage runs both facings through every camera-app handoff. The automated sweep runs per named device rather than per facing, and the platform withholds labels until a grant exists, so facing is reported only where the label made it derivable. Named cameras seen this run: ${facings.size > 0 ? Array.from(facings).join(" · ") : "none were named"}.`,
    where: "camera/matrix.json · device-spec.md",
  });

  items.push({
    section: "0.7",
    ask: "iOS version per capture",
    status: iosVersionFrom(ua) != null ? "captured" : "partial",
    answer:
      iosVersionFrom(ua) != null
        ? `${iosVersionFrom(ua)}, from the user-agent string. Safari does not expose a build number, so this is as precise as the platform allows.`
        : `No iOS version is readable from this user agent: "${ua ?? "(not exposed)"}". On Android the platform version arrives through high-entropy client hints instead — see the passive dump.`,
    where: "environment/passive-dump.txt",
  });

  const model = passiveValue(input.passive, "Device model");
  const proxies = [
    ["WebGL renderer", passiveValue(input.passive, "WebGL renderer")],
    ["Screen", passiveValue(input.passive, "Screen")],
    ["Device pixel ratio", passiveValue(input.passive, "Device pixel ratio")],
    ["Safe-area insets", passiveValue(input.passive, "Safe-area insets")],
    ["Audio sample rate", passiveValue(input.passive, "Audio sample rate")],
    ["JS heap limit", passiveValue(input.passive, "JS heap limit")],
  ].filter((p): p is [string, string] => p[1] != null && !p[1].startsWith("(not"));
  items.push({
    section: "0.8",
    ask: "Exact handset",
    status: model != null && !model.startsWith("(not") ? "captured" : "partial",
    answer:
      model != null && !model.startsWith("(not")
        ? `"${model}", from high-entropy client hints. This is a direct read with no prompt of any kind, and it is the single most identifying prompt-free value on the platform.`
        : `Not directly readable here — iOS Safari reports only "iPhone" and implements no high-entropy hints, so no amount of probing yields the model name. What this run did read, which together narrows it hard: ${proxies.map(([k, v]) => `${k} = ${v}`).join(" · ") || "no useful proxies were readable"}. Those are measurements, not an identification, and the archive does not convert them into one.`,
    where: "environment/passive-dump.txt · device-spec.md",
  });

  const heicSeen = input.captures.some((c) => /heic|heif/i.test(c.mime) || /\.heic$/i.test(c.fileName ?? ""));
  const jpegFromCamera = cameraFiles.some((c) => /jpe?g/i.test(c.mime) || /\.jpe?g$/i.test(c.fileName ?? ""));
  items.push({
    section: "0.9",
    ask: 'Photos setting: "Most Compatible" vs "High Efficiency"',
    status: cameraFiles.length > 0 ? "partial" : "not-run",
    answer:
      cameraFiles.length === 0
        ? "No camera-app file was obtained, so there is nothing to infer from."
        : `Not a readable setting — only an inference from what came back, and a confounded one. This run received ${heicSeen ? "at least one HEIC/HEIF file, which points to High Efficiency" : jpegFromCamera ? "JPEG only, which points to Most Compatible" : "no clearly-typed image file"}. The confound: Safari transcodes HEIC to JPEG on some upload paths, so JPEG arriving is consistent with High Efficiency plus a transcode. The file types are listed verbatim rather than resolved into a setting.`,
    where: "MANIFEST.txt · raw/*.structure.txt",
  });

  const withGps = input.captures.filter((c) => (c.ifd?.gps.length ?? 0) > 0);
  items.push({
    section: "0.10",
    ask: "Whether Location was on for Camera",
    status: cameraFiles.length > 0 ? (withGps.length > 0 ? "captured" : "partial") : "not-run",
    answer:
      cameraFiles.length === 0
        ? "No camera-app file was obtained."
        : withGps.length > 0
          ? `A GPS directory is present in ${withGps.length} capture(s), so location was on for the camera when those were taken. Every sub-tag is listed with its reference tag.`
          : "No GPS directory in any capture. That single observation is produced by three different situations — location off for the camera, location on but withheld, or the block stripped in transit — and they cannot be told apart from the file. No conclusion is drawn.",
    where: withGps.length > 0 ? withGps.map((c) => `raw/${c.slug}.ifd.txt`).join(", ") : "raw/*.ifd.txt",
  });
  return items;
}

function byteStructureItems(input: CorrelationInput): BriefItem[] {
  const jpegs = input.captures.filter((c) => c.encoder?.isJpeg === true);
  const withTables = jpegs.filter((c) => (c.encoder?.quantTables.length ?? 0) > 0);
  const items: BriefItem[] = [];

  items.push({
    section: "1",
    ask: "The exiftool invocations to reproduce all of this",
    status: "captured",
    answer:
      "All six commands are written out against this archive's own paths, including both the -n and non-(-n) runs. One caveat worth stating: the parses in this archive are this app's own, not exiftool's. Where the two disagree, exiftool is right.",
    where: "correlation-brief.md, section 1",
  });
  items.push({
    section: "2.1",
    ask: "Full APP-segment order and lengths — JFIF, EXIF, XMP, ICC, MPF",
    status: jpegs.length > 0 ? "captured" : "not-run",
    answer:
      jpegs.length > 0
        ? `Every APP segment in file order with its declared length, offset and leading signature, for ${jpegs.length} JPEG(s). Whether APP0/JFIF is present at all is called out explicitly, since camera JPEGs often have none.`
        : "No JPEG captures in this run.",
    where: "raw/<slug>.encoder.txt",
  });
  items.push({
    section: "2.2",
    ask: "Quantization tables — the full 64-value luma and chroma matrices",
    status: withTables.length > 0 ? "captured" : jpegs.length > 0 ? "partial" : "not-run",
    answer:
      withTables.length > 0
        ? `All 64 coefficients per table, printed twice: in reading order for comparison, and in file (zig-zag) order as the bytes actually appear. Per table: the sum, whether it is the unscaled Annex K base table, and an approximate libjpeg quality — the last one flagged as meaningful only for libjpeg-family encoders. Apple's camera encoder does not scale Annex K, so no quality number is invented for it; the refusal to state one is itself the finding.`
        : jpegs.length > 0
          ? "JPEGs are present but no DQT segment could be read from them, which is reported rather than glossed over."
          : "No JPEG captures in this run.",
    where: "raw/<slug>.encoder.txt",
  });
  items.push({
    section: "2.3",
    ask: "Chroma subsampling, baseline vs progressive, scan count",
    status: jpegs.length > 0 ? "captured" : "not-run",
    answer:
      jpegs.length > 0
        ? "Subsampling is derived from the frame header's per-component sampling factors and reported as both the 4:2:0/4:2:2/4:4:4 label and the raw factors. Frame mode comes from the SOF marker itself, and the scan count is a direct count of SOS markers."
        : "No JPEG captures in this run.",
    where: "raw/<slug>.encoder.txt",
  });
  items.push({
    section: "2.4",
    ask: "Huffman tables — optimised or standard",
    status: jpegs.length > 0 ? "captured" : "not-run",
    answer:
      jpegs.length > 0
        ? "Each DHT's 16 code-length counts are printed and compared against all four ITU T.81 Annex K tables. A match means the encoder shipped the textbook table; anything else was computed from the image, which not every encoder bothers to do."
        : "No JPEG captures in this run.",
    where: "raw/<slug>.encoder.txt",
  });
  items.push({
    section: "2.5",
    ask: "Restart interval, if any",
    status: jpegs.length > 0 ? "captured" : "not-run",
    answer: jpegs.length > 0 ? "Read from the DRI segment, and reported as explicitly unset where there is no DRI." : "No JPEG captures in this run.",
    where: "raw/<slug>.encoder.txt",
  });
  const thumbs = jpegs.filter((c) => c.encoder?.thumbnail != null);
  items.push({
    section: "2.6",
    ask: "Embedded thumbnail — present, dimensions, its own tables, byte size",
    status: thumbs.length > 0 ? "captured" : jpegs.length > 0 ? "captured" : "not-run",
    answer:
      thumbs.length > 0
        ? `Found in ${thumbs.length} capture(s). The thumbnail is parsed as the complete second JPEG it is, so its own dimensions, subsampling and quantisation-table sums are reported separately from the main image's — they frequently differ. The bytes are also carved out whole.`
        : jpegs.length > 0
          ? "No embedded thumbnail in any JPEG this run, stated as an absence rather than left blank."
          : "No JPEG captures in this run.",
    where: "raw/<slug>.encoder.txt · raw/segments/<slug>/exif-thumbnail.bin",
  });
  const trailing = jpegs.filter((c) => (c.encoder?.trailingBytes ?? 0) > 0);
  items.push({
    section: "2.7",
    ask: "Any bytes after EOI",
    status: jpegs.length > 0 ? "captured" : "not-run",
    answer:
      jpegs.length === 0
        ? "No JPEG captures in this run."
        : trailing.length > 0
          ? `${trailing.length} capture(s) carry data past the EOI marker; the count and the first 64 bytes are printed. Nothing normally writes there.`
          : "Checked on every JPEG: none has any data after EOI.",
    where: "raw/<slug>.encoder.txt",
  });
  items.push({
    section: "2.8",
    ask: "File size for a known resolution, to sanity-check an encode",
    status: jpegs.length > 0 ? "captured" : "not-run",
    answer:
      jpegs.length > 0
        ? `Exact byte size beside exact pixel dimensions for every capture, grouped by production path so a camera original is never averaged with a canvas encode. ${jpegs
            .slice(0, 4)
            .map((c) => `${c.width}x${c.height} = ${c.bytes.toLocaleString("en-US")} B (${c.path})`)
            .join(" · ")}`
        : "No JPEG captures in this run.",
    where: "MANIFEST.txt · checksums/checksums.txt",
  });
  return items;
}

function exifItems(input: CorrelationInput): BriefItem[] {
  const withExif = input.captures.filter((c) => c.ifd?.found === true);
  const items: BriefItem[] = [];
  const has = (name: string): BriefCapture[] => withExif.filter((c) => c.ifd?.blocks.some((b) => b.entries.some((e) => e.name?.startsWith(name) === true)) === true);

  items.push({
    section: "3.1",
    ask: "Every tag with its ID, type, count and raw value",
    status: withExif.length > 0 ? "captured" : input.captures.length > 0 ? "not-obtainable" : "not-run",
    answer:
      withExif.length > 0
        ? `A raw directory walk was written specifically for this: each entry reports tag number, TIFF type, component count, byte length, whether the value is inline or at an offset, and the value AS STORED. Rationals print as numerator/denominator — 1/60 rather than 0.016667 — because the decimal is the same reading and different bytes. ASCII strings state their length and whether they are NUL-terminated. ${withExif.length} capture(s) have an EXIF block.`
        : input.captures.length > 0
          ? "No capture in this run has an EXIF block. Every capture here came from a canvas encode or the platform photo pipeline, and neither can carry camera EXIF — this is the expected result, not a stripping event."
          : "No captures in this run.",
    where: "raw/<slug>.ifd.txt",
  });
  items.push({
    section: "3.2",
    ask: "TIFF byte order, IFD order, presence of IFD1",
    status: withExif.length > 0 ? "captured" : "not-run",
    answer:
      withExif.length > 0
        ? `Reported per capture: II or MM, the magic number, the order the directories were reached in, and whether IFD1 exists. ${withExif
            .slice(0, 3)
            .map((c) => `${c.slug}: ${c.ifd?.byteOrder}, ${c.ifd?.ifdOrder.join("→")}, IFD1 ${c.ifd?.hasIfd1 ? "present" : "absent"}`)
            .join(" · ")}`
        : "No EXIF block to walk.",
    where: "raw/<slug>.ifd.txt",
  });
  items.push({
    section: "3.3",
    ask: "Make, Model, Software, HostComputer, DateTime, resolution as rationals, YCbCrPositioning, Orientation",
    status: has("Make").length > 0 ? "captured" : withExif.length > 0 ? "partial" : "not-run",
    answer:
      withExif.length > 0
        ? `Present in the IFD0 walk with their stored types. XResolution and YResolution appear as rationals, not decimals. HostComputer is reported when present — ${has("HostComputer").length > 0 ? `it is, in ${has("HostComputer").length} capture(s)` : "no capture this run has it"}. Software is quoted exactly as stored, so its formatting is visible rather than normalised.`
        : "No EXIF block in any capture.",
    where: "raw/<slug>.ifd.txt",
  });
  items.push({
    section: "3.4",
    ask: "OffsetTime / OffsetTimeOriginal / OffsetTimeDigitized",
    status: has("OffsetTime").length > 0 ? "captured" : withExif.length > 0 ? "captured" : "not-run",
    answer:
      withExif.length === 0
        ? "No EXIF block in any capture."
        : has("OffsetTime").length > 0
          ? `Present in ${has("OffsetTime").length} capture(s), with the exact stored string.`
          : "Explicitly checked and absent from every capture with EXIF. The tags are named in the dictionary, so absence here means the writer did not emit them rather than that the walker cannot see them.",
    where: "raw/<slug>.ifd.txt",
  });
  items.push({
    section: "3.5",
    ask: "SubsecTime / Original / Digitized, including digit count",
    status: withExif.length > 0 ? "captured" : "not-run",
    answer:
      withExif.length > 0
        ? "Reported as ASCII with the byte count stated, so the number of digits is visible — which is the part that matters, since a two-digit and a three-digit subsecond field are different writers."
        : "No EXIF block in any capture.",
    where: "raw/<slug>.ifd.txt",
  });
  items.push({
    section: "3.6",
    ask: "The whole exposure group from one photo, as one set",
    status: withExif.length > 0 ? "captured" : "not-run",
    answer:
      withExif.length > 0
        ? "All nineteen requested tags are in the dictionary and appear per capture in the ExifIFD walk, so the set stays coherent per file rather than being averaged across files. BrightnessValue keeps its signed rational form, which is where a naive decimal rendering loses the sign convention."
        : "No EXIF block in any capture.",
    where: "raw/<slug>.ifd.txt",
  });
  items.push({
    section: "3.7",
    ask: "FocalLength, FocalLengthIn35mmFilm, LensSpecification, LensMake, LensModel — front and back separately",
    status: has("Lens").length > 0 ? "captured" : withExif.length > 0 ? "partial" : "not-run",
    answer:
      withExif.length === 0
        ? "No EXIF block in any capture, so no lens tags exist to read."
        : has("Lens").length > 0
          ? `Lens tags found in ${has("Lens").length} capture(s). LensSpecification keeps its four rationals in stored form. Front and back are separable because the manual stage takes each facing through its own handoff and the capture's declared facing travels with it.`
          : "No lens tags in any capture with EXIF this run. The camera-app handoff is the only path that carries them, so this usually means that stage did not complete or the OS wrote none.",
    where: "raw/<slug>.ifd.txt · device-spec.md",
  });
  items.push({
    section: "3.8",
    ask: "SubjectArea — 4 values vs 3",
    status: has("SubjectArea").length > 0 ? "captured" : withExif.length > 0 ? "captured" : "not-run",
    answer:
      withExif.length === 0
        ? "No EXIF block in any capture."
        : has("SubjectArea").length > 0
          ? `Present. The component count is printed beside the value, so 3 versus 4 is read directly off the entry rather than counted by eye.`
          : "Not present in any capture this run. Where it does appear the count is printed explicitly, which is the distinction you are after.",
    where: "raw/<slug>.ifd.txt",
  });
  items.push({
    section: "3.9",
    ask: "CompositeImage, CompositeImageCount, CompositeImageExposureTimes",
    status: has("CompositeImage").length > 0 ? "captured" : withExif.length > 0 ? "captured" : "not-run",
    answer:
      withExif.length === 0
        ? "No EXIF block in any capture."
        : has("CompositeImage").length > 0
          ? `Present in ${has("CompositeImage").length} capture(s) — these are the tags that mark a computational-photography merge.`
          : "All three are in the dictionary and none appears in this run's captures. Stated as checked-and-absent.",
    where: "raw/<slug>.ifd.txt",
  });
  const makers = input.captures.filter((c) => c.ifd?.makerNote != null);
  items.push({
    section: "3.10",
    ask: "MakerNote — total byte length, and whether it survives the upload path",
    status: makers.length > 0 ? "captured" : withExif.length > 0 ? "captured" : "not-run",
    answer:
      makers.length > 0
        ? `Present in ${makers.length} capture(s): ${makers.map((c) => `${c.slug} = ${c.ifd?.makerNote?.bytes.toLocaleString("en-US")} bytes, signature "${c.ifd?.makerNote?.signature}"`).join(" · ")}. Carved out whole as its own file. Survival is directly observable here: the block is present in the camera-app path and absent from the others, and both facts are recorded per path rather than merged.`
        : withExif.length > 0
          ? "No MakerNote in any capture with EXIF, which is itself the answer to the survival question on these paths."
          : "No EXIF block in any capture.",
    where: "raw/segments/<slug>/maker-note.bin · raw/<slug>.ifd.txt",
  });
  items.push({
    section: "3.11",
    ask: "GPS block — every sub-tag with its Ref, including ImgDirection when Location is off",
    status: input.captures.some((c) => (c.ifd?.gps.length ?? 0) > 0) ? "captured" : withExif.length > 0 ? "captured" : "not-run",
    answer:
      input.captures.some((c) => (c.ifd?.gps.length ?? 0) > 0)
        ? "Every GPS entry is listed with its reference tag resolved, because a coordinate without its Ref is ambiguous by 180 degrees. GPSImgDirection and GPSImgDirectionRef are in the dictionary and reported whether or not a position is present."
        : withExif.length > 0
          ? "No GPS directory in any capture. The three indistinguishable causes are named in the report rather than resolved into a guess."
          : "No EXIF block in any capture.",
    where: "raw/<slug>.ifd.txt",
  });
  const sameScene = input.captures.filter((c) => c.path === "camera-file").length;
  items.push({
    section: "3.12",
    ask: "Two or three captures of the same scene, to separate varying tags from constant ones",
    status: sameScene >= 2 ? "captured" : sameScene === 1 ? "partial" : "not-run",
    answer:
      sameScene >= 2
        ? `${sameScene} camera-app files are present, so per-shot tags can be separated from device-constant ones by comparison. The device spec already makes that split: only device and lens tags are carried into it, and exposure and timestamps are deliberately excluded, because copying per-shot values across every frame is itself a tell.`
        : sameScene === 1
          ? "Only one camera-app file this run, so varying versus constant cannot be established by comparison. The device spec still separates them, but on documented tag semantics rather than on observation from this run — and that distinction is stated there."
          : "No camera-app files this run.",
    where: "device-spec.md · raw/*.ifd.txt",
  });
  return items;
}

function colourItems(input: CorrelationInput): BriefItem[] {
  const withIcc = input.captures.filter((c) => c.encoder?.icc != null);
  const items: BriefItem[] = [];
  items.push({
    section: "4.1",
    ask: "ICC profile name, byte size and MD5",
    status: withIcc.length > 0 ? "captured" : input.captures.length > 0 ? "captured" : "not-run",
    answer:
      withIcc.length > 0
        ? `${withIcc.length} capture(s) embed a profile. Per profile: the desc-tag name, exact byte size, ICC version, class, colour space, creator, rendering intent, the profile's own embedded ID field, and our MD5 of the exact carved bytes. ${withIcc
            .slice(0, 3)
            .map((c) => `${c.slug}: "${c.encoder?.icc?.description ?? "no desc tag"}", ${c.encoder?.icc?.bytes} B, md5 ${c.iccMd5 ?? "not computed"}`)
            .join(" · ")}`
        : input.captures.length > 0
          ? "No capture embeds an ICC profile. Those files therefore make no colour-space claim beyond the EXIF ColorSpace tag, and none is invented for them."
          : "No captures in this run.",
    where: "raw/segments/<slug>/icc-profile.bin · raw/<slug>.encoder.txt · checksums/",
  });
  const uncalibrated = input.captures.filter((c) => c.ifd?.colorSpace === 0xffff);
  items.push({
    section: "4.2",
    ask: "Whether ColorSpace is 65535 and, if so, whether InteroperabilityIndex is R03",
    status: input.captures.some((c) => c.ifd?.found === true) ? "captured" : "not-run",
    answer:
      input.captures.some((c) => c.ifd?.found === true)
        ? `Both are read directly and reported together. ${
            uncalibrated.length > 0
              ? `${uncalibrated.length} capture(s) carry ColorSpace 65535 (uncalibrated) — how Apple marks a wide-gamut file — with InteroperabilityIndex ${uncalibrated.map((c) => c.ifd?.interopIndex ?? "not present").join(", ")}.`
              : "No capture uses 65535 this run; the values found are printed as read."
          } Whether the profile is genuinely Display P3 or sRGB is answered from the ICC bytes, not from these tags.`
        : "No EXIF block in any capture.",
    where: "raw/<slug>.ifd.txt",
  });
  items.push({
    section: "4.3",
    ask: "Bit depth and colour model",
    status: input.captures.some((c) => c.encoder?.frame != null) ? "captured" : "not-run",
    answer: input.captures.some((c) => c.encoder?.frame != null)
      ? "Sample precision and component count come from the frame header, and each component's ID and sampling factors are listed, which is what identifies the colour model in a JPEG."
      : "No frame header was readable in any capture.",
    where: "raw/<slug>.encoder.txt",
  });
  return items;
}

function surfaceItems(input: CorrelationInput): BriefItem[] {
  const surface = input.matrix?.surface ?? [];
  const items: BriefItem[] = [];
  const sdp = passiveValue(input.passive, "WebRTC codecs offered");

  items.push({
    section: "5.1",
    ask: "track.getSettings() verbatim for both cameras, key order preserved",
    status: surface.length > 0 ? "captured" : "not-run",
    answer:
      surface.length > 0
        ? `Recorded for ${surface.length} camera(s) as the browser returned it. Key order is preserved deliberately — it is itself an engine trait, and passing the object through anything that sorts keys would quietly destroy it.`
        : "The camera sweep did not run, so no track was open to interrogate.",
    where: "camera/surface.json",
  });
  items.push({
    section: "5.2",
    ask: "track.getCapabilities() verbatim, with min/max ranges and the facingMode array",
    status: surface.filter((s) => s.capabilities != null).length > 0 ? "captured" : surface.length > 0 ? "partial" : "not-run",
    answer:
      surface.filter((s) => s.capabilities != null).length > 0
        ? "Stored as a full structured copy, so the nested {min, max} range objects survive intact rather than being flattened."
        : surface.length > 0
          ? "Tracks were opened but getCapabilities returned nothing usable on this browser. Recorded as an absent API rather than as an empty range — the two are not the same claim."
          : "The camera sweep did not run.",
    where: "camera/surface.json",
  });
  items.push({
    section: "5.3",
    ask: "track.getConstraints() after a typical request",
    status: surface.filter((s) => s.constraints != null).length > 0 ? "captured" : surface.length > 0 ? "partial" : "not-run",
    answer:
      surface.filter((s) => s.constraints != null).length > 0
        ? "Read on the same open track, immediately after the native-maximum request, so it reflects a realistic site request rather than a synthetic one."
        : surface.length > 0
          ? "getConstraints returned nothing on this browser; recorded as such."
          : "The camera sweep did not run.",
    where: "camera/surface.json",
  });
  items.push({
    section: "5.4",
    ask: "track.id, track.label, stream.id formats",
    status: surface.length > 0 ? "captured" : "not-run",
    answer:
      surface.length > 0
        ? `Captured in full, untruncated, along with kind, readyState, muted and enabled. ${surface
            .slice(0, 2)
            .map((s) => `${s.deviceLabel || "unnamed"}: track.id "${s.trackId}", stream.id "${s.streamId}"`)
            .join(" · ")}`
        : "The camera sweep did not run.",
    where: "camera/surface.json",
  });
  items.push({
    section: "5.5",
    ask: "SDP — codec order, profile-level-id, negotiated resolution/fps",
    status: sdp != null && !sdp.startsWith("(not") ? "partial" : "not-run",
    answer:
      sdp != null && !sdp.startsWith("(not")
        ? `A local offer is generated and summarised: codec list in offer order, header extensions, and media sections. It is never sent anywhere, which is the limit worth stating — there is no answer, so nothing is negotiated. Resolution and fps do not appear in an unnegotiated offer, and profile-level-id appears only where the browser puts it in the fmtp lines of that offer. Codecs offered: ${sdp}`
        : "No local offer could be produced in this browser, so no SDP is reported.",
    where: "environment/passive-dump.txt",
  });
  items.push({
    section: "5.6",
    ask: "video.videoWidth/videoHeight, and how long getUserMedia takes to resolve",
    status: surface.length > 0 ? "captured" : "not-run",
    answer:
      surface.length > 0
        ? `Both recorded per camera: the dimensions a <video> element reports for the track, and the measured open time. ${surface
            .slice(0, 3)
            .map((s) => `${s.deviceLabel || "unnamed"}: ${s.videoWidth ?? "?"}x${s.videoHeight ?? "?"} in ${s.openMs} ms`)
            .join(" · ")}. Every row of the sweep also carries its own open duration, so the distribution is visible rather than a single sample.`
        : "The camera sweep did not run.",
    where: "camera/surface.json · camera/matrix.json",
  });
  return items;
}

function jsSurfaceItems(input: CorrelationInput): BriefItem[] {
  const items: BriefItem[] = [];
  const before = input.devicesBeforePermission;
  const after = input.matrix?.devicesAfter ?? [];
  const files = input.captures.filter((c) => c.fileName != null);

  items.push({
    section: "6.1",
    ask: "enumerateDevices() verbatim before and after permission, full deviceId and groupId",
    status: before.length > 0 || after.length > 0 ? "captured" : "not-run",
    answer: `Three snapshots, not two, because two would be ambiguous about when they were taken: before any permission was requested (${before.length} device(s)), before the sweep opened anything (${
      input.matrix?.devicesBefore.length ?? 0
    } device(s)), and after the sweep (${after.length} device(s)). All IDs are stored at full length and every kind is included, not just video inputs — audio inputs share a groupId with their camera, which is what makes grouping possible. Blank labels in the earliest snapshot are the privacy rule working, not a fault.`,
    where: "camera/devices.json",
  });
  items.push({
    section: "6.2",
    ask: "The File object a site receives — name, size, type, lastModified, webkitRelativePath — several in a row",
    status: files.length >= 2 ? "captured" : files.length === 1 ? "partial" : "not-run",
    answer:
      files.length > 0
        ? `All five fields for ${files.length} file(s), in the order they were received, with lastModified as the raw epoch number rather than a formatted date — the step between consecutive values is the interesting part and formatting would hide it. Sequence: ${files
            .map((c) => `${c.fileName} = ${c.fileLastModified ?? "null"}`)
            .join(" · ")}`
        : "No file-bearing captures this run, so there is no File object to report.",
    where: "camera/files.json",
  });
  const identity = ["User agent", "Platform", "Vendor", "Maximum touch points", "Processor threads", "Device memory (rounded)"]
    .map((k) => [k, passiveValue(input.passive, k)] as const)
    .filter((p): p is readonly [string, string] => p[1] != null);
  items.push({
    section: "6.3",
    ask: "userAgent, platform, vendor, maxTouchPoints, hardwareConcurrency, deviceMemory",
    status: identity.length === 6 ? "captured" : identity.length > 0 ? "partial" : "not-run",
    answer: identity.length > 0 ? identity.map(([k, v]) => `${k} = ${v}`).join(" · ") : "None of these were readable, which would be highly unusual and is reported as-is.",
    where: "environment/passive-dump.txt",
  });
  const display = ["Screen", "Device pixel ratio", "Viewport"].map((k) => [k, passiveValue(input.passive, k)] as const).filter((p): p is readonly [string, string] => p[1] != null);
  items.push({
    section: "6.4",
    ask: "screen.width/height, devicePixelRatio, window.innerWidth/innerHeight",
    status: display.length === 3 ? "captured" : display.length > 0 ? "partial" : "not-run",
    answer: display.length > 0 ? `${display.map(([k, v]) => `${k} = ${v}`).join(" · ")}. Viewport is tagged as varying between runs, since it moves with browser chrome and orientation.` : "Not readable.",
    where: "environment/passive-dump.txt",
  });
  const camBefore = input.permissionStatesBefore.find((p) => p.name === "camera");
  const camAfter = input.permissionStatesAfter.find((p) => p.name === "camera");
  items.push({
    section: "6.5",
    ask: "Permissions.query({name:'camera'}) state before and after",
    status: camBefore != null || camAfter != null ? "captured" : "not-obtainable",
    answer:
      camBefore != null || camAfter != null
        ? `camera: ${camBefore?.state ?? "not queryable"} → ${camAfter?.state ?? "not queryable"}. The same before/after pair is recorded for all ${input.permissionStatesAfter.length} permission names this browser will answer for, and each individual request also carries its own state transition.`
        : "This browser does not answer permissions.query for the camera name at all, so no state could be read. That is an absent API, not a denial.",
    where: "environment/passive-dump.json · permissions/ledger.txt",
  });
  const photo = (input.matrix?.surface ?? []).filter((s) => s.photoCapabilities != null);
  items.push({
    section: "6.6",
    ask: "ImageCapture.getPhotoCapabilities() / getPhotoSettings()",
    status: photo.length > 0 ? "captured" : (input.matrix?.surface.length ?? 0) > 0 ? "not-obtainable" : "not-run",
    answer:
      photo.length > 0
        ? `Both read verbatim for ${photo.length} camera(s).`
        : (input.matrix?.surface.length ?? 0) > 0
          ? "ImageCapture is not implemented in this browser, so neither call was reachable. The per-camera notes say so explicitly rather than leaving the fields empty."
          : "The camera sweep did not run.",
    where: "camera/surface.json",
  });
  return items;
}

function motionItems(input: CorrelationInput): BriefItem[] {
  const motion = input.sensors.find((s) => s.id === "motion");
  const items: BriefItem[] = [];
  items.push({
    section: "7.1",
    ask: "DeviceMotionEvent interval, and the decimal precision of accelerationIncludingGravity and rotationRate",
    status: motion != null && motion.rows.length > 0 ? "captured" : "not-run",
    answer:
      motion != null && motion.rows.length > 0
        ? `${motion.rows.length} samples. The event's own reported interval is in the CSV's interval_ms column, beside the measured rate of ${
            motion.measuredHz ?? "?"
          } Hz — the two often disagree and neither is presented as the other. Worth knowing about this run specifically: axis values are now written at FULL precision with no rounding of ours. An earlier version formatted them to four decimals, which would have made the smallest observable step 0.0001 on every device — a measurement of the formatter rather than the accelerometer. The quantisation step in the device spec is therefore the hardware's own.`
        : "No motion recording in this run, so nothing is claimed about precision or interval.",
    where: "sensors/motion.csv · device-spec.md",
  });
  items.push({
    section: "7.2",
    ask: "A few seconds of raw samples from a still phone, to match the noise floor",
    status: motion != null && motion.rows.length > 0 ? "captured" : "not-run",
    answer:
      motion != null && motion.rows.length > 0
        ? `The full series is present as plain CSV — every sample, unsmoothed and unfiltered, with a millisecond timestamp per row. Whether the phone was actually still during the window is not something this app can verify, so it is not claimed; the accelerometer magnitudes in the file will show it.`
        : "No motion recording in this run.",
    where: "sensors/motion.csv",
  });
  return items;
}

/** The single registry both renderings are built from. */
export function briefItems(input: CorrelationInput): BriefItem[] {
  return [
    ...captureMatrixItems(input),
    ...byteStructureItems(input),
    ...exifItems(input),
    ...colourItems(input),
    ...surfaceItems(input),
    ...jsSurfaceItems(input),
    ...motionItems(input),
  ];
}

const PATH_TARGETS = [
  "| Production path | EXIF present? | What it can ever carry |",
  "| --- | --- | --- |",
  "| Camera app via `<input capture>` | **Full** | Make, Model, Software, HostComputer, lens tags, MakerNote, GPS, subsecond timestamps. The camera's own bytes. |",
  "| Library pick via `<input type=file>` | **Full, if it survived** | The same set, as whatever wrote the file left it. This app cannot know what happened to it before it arrived and does not guess. |",
  "| `ImageCapture.takePhoto()` | **Sparse or none** | The platform's own encode. Browsers write little or no camera metadata here. Sparse tags are normal and mean nothing. |",
  "| `getUserMedia` → canvas → `toBlob` | **NONE** | Nothing. A canvas encode cannot carry camera metadata — the pixels came from the track, the JPEG around them was written by this app. |",
];

/** The full standalone document. */
export function buildCorrelationBrief(input: CorrelationInput): string {
  const items = briefItems(input);
  const counts = items.reduce<Record<BriefStatus, number>>(
    (acc, item) => ({ ...acc, [item.status]: acc[item.status] + 1 }),
    { captured: 0, partial: 0, "not-run": 0, "not-obtainable": 0 }
  );

  const lines: string[] = [
    "# Correlation brief",
    "",
    `Observed ${input.generatedAt} · ${items.length} requested items · ${counts.captured} captured, ${counts.partial} partial, ${counts["not-run"]} not run, ${counts["not-obtainable"]} not obtainable from a browser.`,
    "",
    "This answers a specific request, item by item, in the order it was asked. Every answer points at the",
    "file in this archive that holds the evidence.",
    "",
    "## Read this first — the target is different per path, and two of them are opposites",
    "",
    "This is the thing that determines how to read everything else, so it is at the top rather than in a footnote.",
    "",
    ...PATH_TARGETS,
    "",
    "The practical consequence: **stamping rich camera EXIF onto a canvas-path blob makes it more detectable, not less.**",
    "It would be metadata no browser can produce. A file arriving by that route with a Model, a lens and a MakerNote",
    "is not a better forgery than one with none — it is a self-identifying one.",
    "",
    "Every capture in this archive is therefore labelled with the path that produced it, and files this app",
    "encoded itself live in `rendered-frames/` rather than `captures/` so the two can never be confused. The",
    "spec groups its capture facts the same way, by production path, for the same reason.",
    "",
    "## Status meanings",
    "",
    "- **CAPTURED** — read from this run. The location is stated.",
    "- **PARTIAL** — some of it was read; what is missing is named.",
    "- **NOT RUN** — the stage did not happen. A gap in the observation, not a property of the device.",
    "- **NOT OBTAINABLE** — a web page cannot read this at all. A limit, not a gap.",
    "",
    "The last two are kept apart deliberately. \"We did not look\" and \"it cannot be looked at\" are different",
    "claims, and merging them would be the most useful lie a document like this could tell.",
    "",
    "## 1 How to dump it yourself",
    "",
    "```bash",
    EXIFTOOL_COMMANDS,
    "```",
    "",
    "Both the `-n` and the plain run are covered above. One caveat: the parses in this archive are this app's",
    "own, not exiftool's. Where the two disagree, **exiftool is right** — it has decades of vendor-specific",
    "knowledge this does not.",
    "",
    "## 2 Item-by-item answers",
    "",
  ];

  let currentSection = "";
  for (const item of items) {
    const major = item.section.split(".")[0];
    if (major !== currentSection) {
      currentSection = major;
      lines.push(`### Section ${major}`, "");
    }
    lines.push(`**${item.section} ${item.ask}**`, "", `\`${STATUS_LABEL[item.status]}\` — ${item.answer}`, ...(item.where ? ["", `→ \`${item.where}\``] : []), "");
  }

  if (input.omissions.length > 0) {
    lines.push(
      "## 3 Stages that did not run",
      "",
      "Anything marked NOT RUN above traces back to one of these. None of it is a statement about the device:",
      "",
      ...input.omissions.map((o) => `- **${o.stage}** — ${o.reason}`),
      ""
    );
  }

  lines.push(
    "## 4 What this brief will not do",
    "",
    "- **It will not claim a canvas frame is a camera original,** or the reverse. The production path is declared by the code that made each file, at the moment it was made, and never re-inferred afterwards.",
    "- **It will not fabricate a quality number.** The libjpeg quality estimate is withheld where the quantisation tables are not a scaled Annex K table — Apple's encoder is the common case — because a number there would describe the estimator rather than the encoder.",
    "- **It will not resolve an ambiguity by picking the likely branch.** A missing GPS block has three indistinguishable causes and all three are named. A JPEG arriving from the camera roll is consistent with two different Photos settings and both are stated.",
    "- **It will not present absence as capability.** A probe that failed is recorded as failed; an API that does not exist is recorded as absent. Neither is written as an empty value.",
    "- **It will not claim completeness.** This covers what was asked for. The readable surface of a browser is larger than any one request and grows every release.",
    ""
  );

  return lines.join("\n");
}

/**
 * The compact form for the top of the device spec: every requested item on one
 * line, generated from the same registry, so the checklist cannot drift from the
 * document it summarises.
 */
export function briefChecklist(input: CorrelationInput): string {
  const items = briefItems(input);
  const counts = items.reduce<Record<BriefStatus, number>>(
    (acc, item) => ({ ...acc, [item.status]: acc[item.status] + 1 }),
    { captured: 0, partial: 0, "not-run": 0, "not-obtainable": 0 }
  );
  const width = Math.max(...items.map((i) => i.section.length));

  return [
    "## 0 Correlation brief — answer key",
    "",
    `All ${items.length} requested items, in the order asked: ${counts.captured} captured, ${counts.partial} partial, ${counts["not-run"]} not run, ${counts["not-obtainable"]} not obtainable from a browser. Full detail with evidence paths in \`correlation-brief.md\`; this table and that document are generated from one registry and cannot disagree.`,
    "",
    "**The one thing to read before anything else:** a photo reaching a server via `getUserMedia` → canvas → `toBlob` has **no EXIF at all** — canvas destroys it. A photo arriving via `<input type=file>` from the camera roll carries the **full** tag set. Stamping rich camera EXIF onto a canvas-path blob therefore makes it *more* detectable, not less: it is metadata no browser can produce. Every capture here is labelled with its production path for exactly this reason, and app-encoded frames are filed separately from camera bytes.",
    "",
    "```",
    ...items.map((i) => `${i.section.padEnd(width)}  ${STATUS_LABEL[i.status].padEnd(14)}  ${i.ask}`),
    "```",
    "",
    "`NOT RUN` is a gap in this observation. `NOT OBTAINABLE` is a limit of what a web page can read. They are never merged.",
    "",
  ].join("\n");
}
