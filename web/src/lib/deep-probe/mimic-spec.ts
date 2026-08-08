/**
 * The device spec — a dense, machine-readable description of what makes THIS
 * device distinguishable, written so another system could reproduce its
 * observable behaviour.
 *
 * The whole file rests on one editorial decision: what to leave out. A raw dump
 * of everything the probe read is mostly boilerplate that is identical on every
 * mobile browser on earth, and boilerplate is worse than useless here — it
 * buries the handful of values that actually differ. So each reading is checked
 * against a declared list of common defaults and dropped when it matches.
 *
 * Three honesty rules govern that filter, because a filter is exactly where a
 * tool like this would start lying:
 *
 * 1. **"Distinctive" is a declared classification, not a measurement.** The app
 *    sees one device. It cannot observe a population, so it never claims
 *    uniqueness, entropy or "N in a million" — it says only that a value differs
 *    from a documented common default, and it publishes that default list inside
 *    the file so the judgement can be checked and overridden.
 * 2. **When in doubt, keep the row.** A dropped fact is invisible; a redundant
 *    one costs a line. Every borderline value stays.
 * 3. **Nothing is inferred.** Every value was read on this device in this run.
 *    Absent facts are printed as absent rather than silently skipped, because a
 *    missing line and a missing capability must not look the same.
 *
 * Every fact also carries a stability tag, which is what makes the file usable
 * rather than merely accurate. Reproducing a device means holding the hardware
 * facts constant, matching the OS facts to the version being claimed, and
 * *varying* the volatile ones — a battery level or a round-trip time that never
 * moves between sessions describes a recording, not a phone.
 */

import type { PackOrigin } from "../evidence-pack";
import type { CameraMatrixReport, MatrixRow } from "./camera-matrix";
import type { PassiveGroup } from "./passive";
import type { PermissionRecord, PermissionTier } from "./permissions";
import type { StageOmission } from "./sheets";
import type { SensorSeries } from "./sensors";

/**
 * How a value behaves over time. The distinction is the practical core of the
 * file: pinning a `VAR` value is as wrong as failing to match an `HW` one.
 */
export type Stability =
  /** Fixed to the physical device. Changes only if the hardware does. */
  | "HW"
  /** Moves with the OS or browser version. */
  | "OS"
  /** A user or OS setting: stable until someone changes it. */
  | "SET"
  /** Changes between runs, sometimes between seconds. Must be varied, not pinned. */
  | "VAR";

export type SpecFact = {
  key: string;
  value: string;
  stability: Stability;
  /** True when this differs from the documented common default — the strongest rows in the file. */
  deviates?: boolean;
};

export type SpecSection = {
  title: string;
  /** One short line on why this section discriminates. Omitted where obvious. */
  note?: string;
  facts: SpecFact[];
};

/** Everything the spec needs about one archived capture, gathered while the pack is built. */
export type MimicCaptureFact = {
  slug: string;
  origin: PackOrigin;
  path: "image-capture" | "canvas" | "camera-file" | "picker-file";
  deviceLabel: string | null;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  container: string;
  /** Top-level container sections in the order they appear — an encoder signature. */
  markers: string[];
  /** Names of the metadata regions carved out of this file. */
  segments: string[];
  tagCount: number;
  unknownTagCount: number;
  /** Every metadata tag name present, sorted. The schema matters more than the values. */
  tagKeys: string[];
  /** The device-constant tags, by name. Per-shot values (exposure, time) are excluded. */
  stableTags: Record<string, string>;
};

export type MimicSpecInput = {
  generatedAt: string;
  tier: PermissionTier;
  passive: PassiveGroup[];
  permissionStates: { name: string; state: string | null }[];
  permissions: PermissionRecord[];
  sensors: SensorSeries[];
  matrix: CameraMatrixReport | null;
  captures: MimicCaptureFact[];
  omissions: StageOmission[];
  /**
   * The correlation answer key, rendered from the same registry as
   * `correlation-brief.md`. Placed at the very top of the spec because the
   * capture-path caveat it carries changes how every capture fact below it
   * should be read.
   */
  briefChecklist?: string;
};

/**
 * Metadata tags that describe the device or lens rather than the moment. These
 * are the ones worth reproducing exactly; exposure time, ISO and timestamps are
 * per-shot and deliberately excluded, since copying them across every frame is
 * itself a tell.
 */
export const STABLE_TAG_KEYS: string[] = [
  "Make",
  "Model",
  "Software",
  "HostComputer",
  "LensMake",
  "LensModel",
  "LensSpecification",
  "FocalLength",
  "FocalLengthIn35mmFilm",
  "FNumber",
  "MaxApertureValue",
  "SensingMethod",
  "SceneType",
  "ExifVersion",
  "FlashpixVersion",
  "ComponentsConfiguration",
  "YCbCrPositioning",
  "ColorSpace",
  "ResolutionUnit",
  "XResolution",
  "YResolution",
  "Orientation",
  "JFIFVersion",
  "ICC Description",
  "ICC Profile Name",
  "ProfileDescription",
  "TileWidth",
  "TileLength",
];

/**
 * Values that are the same on essentially every current mobile browser. A row
 * matching one of these is dropped as boilerplate; a row *differing* from one is
 * kept and flagged, because a deviation from the common default is a stronger
 * signal than an unusual-looking value that everyone shares.
 *
 * This list is an editorial judgement, published here so it can be argued with.
 * It is intentionally short: only entries confidently near-universal appear, and
 * anything borderline is left in the spec instead.
 */
export const COMMON_DEFAULTS: Record<string, string> = {
  "Cookies enabled": "true",
  Online: "true",
  "Automation flag (navigator.webdriver)": "false",
  "Do Not Track": "not set",
  "Local storage": "available",
  IndexedDB: "available",
  Pointer: "coarse (touch)",
  "Hover capable": "false",
  getUserMedia: "available",
  enumerateDevices: "available",
  MediaRecorder: "available",
  "crypto.subtle": "available",
  "Service workers": "available",
  CompressionStream: "available",
  OffscreenCanvas: "available",
  "Credential management": "available",
  "image/jpeg": "canvas can encode it",
  "image/png": "canvas can encode it",
};

/** Short machine-friendly names for the passive readings. Anything unmapped is slugified. */
const KEY_MAP: Record<string, string> = {
  "User agent": "ua",
  Platform: "navigator.platform",
  "UA-CH platform": "uaCh.platform",
  "UA-CH brands": "uaCh.brands",
  Vendor: "navigator.vendor",
  Languages: "languages",
  "Automation flag (navigator.webdriver)": "webdriver",
  "PDF viewer enabled": "pdfViewerEnabled",
  "Do Not Track": "doNotTrack",
  "Cookies enabled": "cookieEnabled",
  "Processor threads": "cpu.threads",
  "Device memory (rounded)": "memory.gb",
  "Maximum touch points": "touch.maxPoints",
  Screen: "screen.size",
  "Available screen area": "screen.avail",
  "Device pixel ratio": "screen.dpr",
  "Colour depth": "screen.colorDepth",
  Viewport: "viewport",
  "Screen orientation": "screen.orientation",
  "Wide colour gamut": "screen.gamut",
  HDR: "screen.dynamicRange",
  "WebGL renderer": "gpu.renderer",
  "WebGL vendor": "gpu.vendor",
  "WebGL version": "gpu.glVersion",
  "WebGL extensions": "gpu.extensionCount",
  "Max texture size": "gpu.maxTextureSize",
  WebGPU: "gpu.webgpu",
  Online: "net.online",
  "Effective type": "net.effectiveType",
  "Downlink estimate": "net.downlink",
  "Round-trip time estimate": "net.rtt",
  "Data saver": "net.saveData",
  "Connection type": "net.type",
  "Charge level": "battery.level",
  Charging: "battery.charging",
  "Time to full": "battery.toFull",
  "Time to empty": "battery.toEmpty",
  "Battery status": "battery.api",
  "Time zone": "tz",
  "UTC offset": "tz.offsetMinutes",
  "Calendar / numbering": "intl.calendarNumbering",
  "Storage estimate": "storage.estimate",
  "Local storage": "storage.localStorage",
  IndexedDB: "storage.indexedDb",
  "Device model": "hints.model",
  "Platform version": "hints.platformVersion",
  "CPU architecture": "hints.architecture",
  "CPU bitness": "hints.bitness",
  "Full browser version": "hints.uaFullVersion",
  "Full version list": "hints.fullVersionList",
  "Form factors": "hints.formFactors",
  "WebGL extension names": "gpu.extensions",
  "WebGL generation": "gpu.generation",
  "Shading language": "gpu.glsl",
  "WebGPU adapter vendor": "gpu.webgpu.vendor",
  "WebGPU adapter architecture": "gpu.webgpu.architecture",
  "WebGPU adapter device": "gpu.webgpu.device",
  "Canvas 2D signature": "signature.canvas2d",
  "WebGL render signature": "signature.webgl",
  "Audio DSP signature": "signature.audio",
  "Audio DSP sum": "signature.audioSum",
  "WebRTC SDP signature": "signature.sdp",
  "Audio sample rate": "audio.sampleRate",
  "Audio base latency": "audio.baseLatency",
  "Audio output latency": "audio.outputLatency",
  "Audio max channels": "audio.maxChannels",
  "Fonts present": "fonts.present",
  "Fonts absent": "fonts.absent",
  "MediaRecorder encoders": "codec.encoders",
  "Speech voice names": "voices.names",
  "Speech voice count": "voices.count",
  "WebRTC codecs offered": "rtc.codecs",
  "WebRTC header extensions": "rtc.extensions",
  "Clock resolution": "engine.clockResolution",
  "Math signature": "engine.math",
  "JS heap limit": "engine.heapLimit",
  "Safe-area insets": "screen.safeArea",
  "Colour scheme": "pref.colorScheme",
  "Reduced motion": "pref.reducedMotion",
  "Reduced transparency": "pref.reducedTransparency",
  "Increased contrast": "pref.contrast",
  "Forced colours": "pref.forcedColors",
  "Inverted colours": "pref.invertedColors",
  Pointer: "pref.pointer",
  "Hover capable": "pref.hover",
  "Display mode": "pref.displayMode",
};

/** Per-reading stability, where it differs from the section default. */
const STABILITY_MAP: Record<string, Stability> = {
  Viewport: "VAR",
  "Screen orientation": "VAR",
  "Storage estimate": "VAR",
  "Time zone": "SET",
  "UTC offset": "VAR",
  Languages: "SET",
  "Do Not Track": "SET",
  "Device pixel ratio": "HW",
  "Maximum touch points": "HW",
  "Colour depth": "HW",
  // Signatures move with a driver or browser update, so they are not hardware
  // facts — pinning one to the hardware would misdescribe how long it holds.
  "Canvas 2D signature": "OS",
  "WebGL render signature": "OS",
  "Audio DSP signature": "OS",
  "Audio DSP sum": "OS",
  "WebRTC SDP signature": "OS",
  "Audio context state": "VAR",
  "Visual viewport": "VAR",
  "Screen extended": "VAR",
  "Clock resolution": "OS",
  "Error stack format": "OS",
  "Timezone display name": "SET",
  "Date part order": "SET",
  "Number formatting": "SET",
  "Collation order": "SET",
  "Intl detail": "SET",
  "Safe-area insets": "HW",
  "Audio sample rate": "HW",
  "Audio max channels": "HW",
  "JS heap limit": "HW",
  "Fonts present": "SET",
  "Fonts absent": "SET",
  "Speech voice names": "SET",
  "Speech voice count": "SET",
  "Speech voice languages": "SET",
};

const SECTION_STABILITY: Record<string, Stability> = {
  "Identity strings": "OS",
  Hardware: "HW",
  Graphics: "HW",
  Network: "VAR",
  Power: "VAR",
  "Locale, time and storage": "SET",
  "Display preferences": "SET",
  "Media format support": "OS",
  "API surface": "OS",
  "Device model strings": "HW",
  "Graphics detail": "HW",
  "Rendering signatures": "OS",
  "Audio stack": "HW",
  Fonts: "SET",
  "Codec detail": "HW",
  "Installed voices": "SET",
  "Real-time stack": "OS",
  "Engine behaviour": "OS",
  "Deep passive probes": "OS",
};

/**
 * Passive groups the spec renders through a dedicated collapser instead of the
 * plain key/value path. Everything *not* listed here flows through generically,
 * so a newly-added collector cannot be silently dropped from the spec.
 */
const SPECIALLY_HANDLED_GROUPS: string[] = ["Media format support", "API surface"];

/** Section heading for a passive group, where the spec prefers a shorter one. */
const SECTION_TITLE: Record<string, string> = {
  "Identity strings": "Identity",
  "Locale, time and storage": "Locale, time, storage",
  "Display preferences": "User settings",
};

function keyFor(label: string): string {
  const mapped = KEY_MAP[label];
  if (mapped) return mapped;
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function rowsOf(groups: PassiveGroup[], title: string): { label: string; value: string }[] {
  return groups.find((g) => g.title === title)?.rows ?? [];
}

/* ------------------------------------------------------------------ *
 * Sensors
 * ------------------------------------------------------------------ */

function columnFacts(series: SensorSeries): SpecFact[] {
  const facts: SpecFact[] = [];
  const delivery = series.stats.delivery;
  facts.push({
    key: `sensor.${series.id}.rate`,
    value: `${series.measuredHz != null ? `${series.measuredHz} Hz measured` : "rate not measurable from this sample"}${series.requestedHz != null ? ` (asked for ${series.requestedHz} Hz)` : ""}, ${series.rows.length} samples over ${Math.round(series.durationMs)} ms`,
    stability: "HW",
  });
  // The delivery rate and the sensor's own update rate are the same number on
  // some devices and are not on others, and a spec that quotes only the first
  // describes a timer where it means to describe a sensor.
  if (delivery.distinctHz != null && delivery.deliveredHz != null) {
    facts.push({
      key: `sensor.${series.id}.delivery`,
      value:
        `${delivery.deliveredHz} Hz delivered, ${delivery.distinctHz} Hz carrying a new reading (${delivery.repeats} of ${delivery.samples} repeated the one before)` +
        `${delivery.medianGapMs != null ? `, median gap ${delivery.medianGapMs} ms` : ""}${delivery.jitter != null ? `, jitter ${delivery.jitter}` : ""}`,
      stability: "HW",
    });
  }
  if (series.stats.gravity) {
    facts.push({
      key: `sensor.${series.id}.gravity`,
      value: `${series.stats.gravity.magnitude} m/s² over ${series.stats.gravity.samples} samples (spread ${series.stats.gravity.spread})`,
      stability: "HW",
    });
  }
  for (const column of series.stats.columns) {
    if (column.samples < 3) continue;
    facts.push({
      key: `sensor.${series.id}.${column.column}`,
      value:
        `min ${column.min != null ? column.min.toPrecision(6) : "—"} max ${column.max != null ? column.max.toPrecision(6) : "—"} ` +
        `step ${column.step != null ? column.step : "not determinable from this sample"} ` +
        `· ${column.distinct} distinct values · written to ${column.decimals} decimals`,
      stability: "HW",
    });
  }
  return facts;
}

/* ------------------------------------------------------------------ *
 * Cameras
 * ------------------------------------------------------------------ */

function settingSize(row: MatrixRow): string | null {
  const settings = row.grantedSettings;
  if (!settings) return null;
  const width = settings.width;
  const height = settings.height;
  if (typeof width !== "number" || typeof height !== "number") return null;
  return `${width}x${height}`;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function cameraFacts(matrix: CameraMatrixReport): SpecFact[] {
  const facts: SpecFact[] = [];
  const byDevice = new Map<string, MatrixRow[]>();
  for (const row of matrix.rows) {
    const list = byDevice.get(row.deviceId);
    if (list) list.push(row);
    else byDevice.set(row.deviceId, [row]);
  }

  facts.push({ key: "camera.count", value: `${matrix.inventory.length} named by the platform`, stability: "HW" });
  for (const device of matrix.inventory) {
    facts.push({
      key: `camera[${device.deviceId.slice(0, 8)}].label`,
      value: `"${device.label || "(withheld)"}"${device.classified ? ` · ${device.facing} · ${device.lensClass}${device.isVirtual ? " · virtual multi-lens device" : ""}` : " · label not recognised, so facing and lens class are not claimed"}`,
      stability: "HW",
    });
  }

  let index = 0;
  for (const [deviceId, rows] of byDevice) {
    const short = deviceId.slice(0, 8);
    const label = rows[0]?.deviceLabel || `camera ${index}`;
    index += 1;
    const ok = rows.filter((r) => r.ok);
    const sizes = uniq(ok.map(settingSize).filter((s): s is string => s != null));
    const areas = sizes.map((s) => {
      const [w, h] = s.split("x").map((n) => Number.parseInt(n, 10));
      return { s, area: w * h };
    });
    const max = areas.sort((a, b) => b.area - a.area)[0]?.s ?? null;

    facts.push({ key: `camera[${short}].name`, value: label, stability: "HW" });
    facts.push({ key: `camera[${short}].maxGranted`, value: max ?? "nothing was granted on this camera", stability: "HW" });
    facts.push({
      key: `camera[${short}].modes`,
      value: sizes.length > 0 ? sizes.join(" ") : "none observed",
      stability: "HW",
    });

    const frameRates = uniq(
      ok
        .filter((r) => r.kind === "frame-rate")
        .map((r) => {
          const fps = r.grantedSettings?.frameRate;
          return typeof fps === "number" ? String(Math.round(fps)) : null;
        })
        .filter((f): f is string => f != null)
    );
    facts.push({ key: `camera[${short}].frameRates`, value: frameRates.length > 0 ? frameRates.join(" ") : "none granted", stability: "HW" });

    // Where the constraint solver moved the request. This is a platform
    // signature: two devices with identical mode lists still snap differently.
    const snaps = ok
      .filter((r) => (r.kind === "resolution" || r.kind === "aspect-ratio" || r.kind === "frame-rate") && r.granted != null && r.granted !== r.asked)
      .map((r) => `${r.asked}->${r.granted}`);
    const distinctSnaps = uniq(snaps);
    facts.push({
      key: `camera[${short}].snapping`,
      value: distinctSnaps.length === 0 ? "every granted request came back exactly as asked" : `${distinctSnaps.slice(0, 32).join(" · ")}${distinctSnaps.length > 32 ? ` · (+${distinctSnaps.length - 32} more in camera/matrix.json)` : ""}`,
      stability: "HW",
    });

    const refusals = uniq(rows.filter((r) => !r.ok && r.error).map((r) => `${r.asked}->${r.error}`));
    facts.push({
      key: `camera[${short}].refused`,
      value: refusals.length === 0 ? "nothing was refused" : `${refusals.slice(0, 24).join(" · ")}${refusals.length > 24 ? ` · (+${refusals.length - 24} more)` : ""}`,
      stability: "HW",
    });

    for (const kind of ["focus", "exposure", "white-balance", "resize-mode", "zoom", "torch"] as const) {
      const kindRows = rows.filter((r) => r.kind === kind);
      if (kindRows.length === 0) continue;
      const applied = kindRows.filter((r) => r.ok).map((r) => r.asked);
      facts.push({
        key: `camera[${short}].${kind}`,
        value: applied.length > 0 ? applied.join(" ") : `advertised nothing this run (${kindRows.length} attempted, none applied)`,
        stability: "HW",
      });
    }
  }
  return facts;
}

/* ------------------------------------------------------------------ *
 * Captures
 * ------------------------------------------------------------------ */

function captureFacts(captures: MimicCaptureFact[]): SpecFact[] {
  if (captures.length === 0) {
    return [{ key: "capture", value: "no captures in this run, so no encoder signature is claimed", stability: "HW" }];
  }
  const groups = new Map<string, MimicCaptureFact[]>();
  for (const capture of captures) {
    const key = `${capture.origin}|${capture.path}|${capture.deviceLabel ?? "-"}`;
    const list = groups.get(key);
    if (list) list.push(capture);
    else groups.set(key, [capture]);
  }

  const facts: SpecFact[] = [];
  let index = 0;
  for (const [, members] of groups) {
    const first = members[0];
    const tag = `capture[${index}]`;
    index += 1;
    const sizes = uniq(members.map((m) => `${m.width}x${m.height}`));
    const byteRange = members.map((m) => m.bytes).sort((a, b) => a - b);

    facts.push({
      key: `${tag}.source`,
      value: `${first.origin} via ${first.path}${first.deviceLabel ? ` · ${first.deviceLabel}` : ""} · ${members.length} file(s)`,
      stability: "HW",
    });
    facts.push({ key: `${tag}.container`, value: `${first.container} · ${first.mime || "type not reported"}`, stability: "OS" });
    facts.push({ key: `${tag}.dimensions`, value: sizes.join(" "), stability: "HW" });
    facts.push({
      key: `${tag}.bytes`,
      value: members.length === 1 ? String(byteRange[0]) : `${byteRange[0]}–${byteRange[byteRange.length - 1]} across ${members.length} files`,
      stability: "VAR",
    });
    facts.push({
      key: `${tag}.markers`,
      value: first.markers.length > 0 ? first.markers.join(" ") : "no container sections parsed",
      stability: "OS",
    });
    const segments = uniq(members.flatMap((m) => m.segments));
    facts.push({ key: `${tag}.metadataRegions`, value: segments.length > 0 ? segments.join(" ") : "none present", stability: "OS" });

    const tagKeys = uniq(members.flatMap((m) => m.tagKeys)).sort();
    facts.push({
      key: `${tag}.tagCount`,
      value: `${first.tagCount} tags, ${first.unknownTagCount} of them undocumented`,
      stability: "OS",
    });
    facts.push({
      key: `${tag}.tagSchema`,
      value: tagKeys.length > 0 ? `${tagKeys.slice(0, 120).join(" ")}${tagKeys.length > 120 ? ` (+${tagKeys.length - 120} more, full list in raw/*.tags.txt)` : ""}` : "no metadata at all — expected and unavoidable on an app-encoded frame",
      stability: "OS",
    });
    const stable = members.reduce<Record<string, string>>((acc, m) => ({ ...acc, ...m.stableTags }), {});
    for (const [name, value] of Object.entries(stable)) {
      facts.push({ key: `${tag}.tag.${name}`, value, stability: "HW" });
    }
  }
  return facts;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

type BuiltSpec = {
  sections: SpecSection[];
  droppedAsCommon: string[];
};

function buildSections(input: MimicSpecInput): BuiltSpec {
  const sections: SpecSection[] = [];
  const droppedAsCommon: string[] = [];

  // Derived from what was actually collected rather than a fixed list: a
  // hardcoded roster silently drops any collector added later, which is the
  // worst failure mode here — the data is gathered, the archive holds it, and
  // only the spec quietly omits it.
  const plainGroups = input.passive.map((g) => g.title).filter((title) => !SPECIALLY_HANDLED_GROUPS.includes(title));

  for (const groupTitle of plainGroups) {
    const rows = rowsOf(input.passive, groupTitle);
    if (rows.length === 0) continue;
    const facts: SpecFact[] = [];
    for (const row of rows) {
      const common = COMMON_DEFAULTS[row.label];
      if (common != null && common === row.value) {
        droppedAsCommon.push(`${keyFor(row.label)} = ${row.value}`);
        continue;
      }
      facts.push({
        key: keyFor(row.label),
        value: row.value,
        stability: STABILITY_MAP[row.label] ?? SECTION_STABILITY[groupTitle] ?? "OS",
        deviates: common != null,
      });
    }
    if (facts.length > 0) sections.push({ title: SECTION_TITLE[groupTitle] ?? groupTitle, facts });
  }

  // Codecs and API surface collapse to yes/no lists — 26 individual lines of
  // "available" would bury the four that are not.
  const codecRows = rowsOf(input.passive, "Media format support");
  if (codecRows.length > 0) {
    const kept = codecRows.filter((row) => {
      const common = COMMON_DEFAULTS[row.label];
      if (common != null && common === row.value) {
        droppedAsCommon.push(`codec ${row.label} = ${row.value}`);
        return false;
      }
      return true;
    });
    const bucket = (predicate: (value: string) => boolean): string =>
      kept
        .filter((r) => predicate(r.value))
        .map((r) => r.label)
        .join(" · ") || "none";
    sections.push({
      title: "Codecs",
      note: "The exact combination of what decodes and what encodes pins the OS version and often the chipset.",
      facts: [
        { key: "codec.probably", value: bucket((v) => v === "probably" || v === "canvas can encode it"), stability: "OS" },
        { key: "codec.maybe", value: bucket((v) => v === "maybe"), stability: "OS" },
        { key: "codec.no", value: bucket((v) => v === "no" || v === "canvas cannot encode it"), stability: "OS" },
      ],
    });
  }

  const apiRows = rowsOf(input.passive, "API surface");
  if (apiRows.length > 0) {
    const kept = apiRows.filter((row) => {
      const common = COMMON_DEFAULTS[row.label];
      if (common != null && common === row.value) {
        droppedAsCommon.push(`api ${row.label} = ${row.value}`);
        return false;
      }
      return true;
    });
    sections.push({
      title: "API surface",
      note: "Absence is the signal here: the set of APIs a browser lacks pins its engine and version tightly.",
      facts: [
        { key: "api.present", value: kept.filter((r) => r.value === "available").map((r) => r.label).join(" · ") || "none beyond the universal set", stability: "OS" },
        { key: "api.absent", value: kept.filter((r) => r.value !== "available").map((r) => r.label).join(" · ") || "none", stability: "OS" },
      ],
    });
  }

  // Which permission names the browser will answer for at all — a per-version trait.
  const answered = input.permissionStates.filter((p) => p.state != null).map((p) => p.name);
  const unanswered = input.permissionStates.filter((p) => p.state == null).map((p) => p.name);
  const unavailableApis = input.permissions.filter((p) => p.outcome === "unavailable").map((p) => p.api);
  if (input.permissionStates.length > 0 || unavailableApis.length > 0) {
    sections.push({
      title: "Permission surface",
      note: "Which names exist, not which you allowed. Your answers are choices about this run and say nothing about the device, so they are not in this file.",
      facts: [
        { key: "permissions.queryable", value: answered.join(" ") || "none", stability: "OS" },
        { key: "permissions.notRecognised", value: unanswered.join(" ") || "none", stability: "OS" },
        { key: "permissions.apisAbsent", value: unavailableApis.join(" · ") || "none — every request in this scope had an API behind it", stability: "OS" },
      ],
    });
  }

  if (input.sensors.length > 0) {
    sections.push({
      title: "Sensors",
      note: "Rates and quantisation steps as measured. The step is the physical resolution of the sensor, estimated from these samples only.",
      facts: input.sensors.flatMap(columnFacts),
    });
  }

  if (input.matrix) {
    sections.push({
      title: "Cameras",
      note: "The capability envelope as the platform actually granted it, including where it silently substituted a different mode.",
      facts: cameraFacts(input.matrix),
    });
  }

  sections.push({
    title: "Capture signatures",
    note: "What files off this device look like. Grouped by how the bytes were produced, because a camera original and a canvas encode are not interchangeable.",
    facts: captureFacts(input.captures),
  });

  return { sections, droppedAsCommon };
}

const LEGEND = [
  "`HW` fixed to the hardware · `OS` moves with the OS/browser version · `SET` a user setting, stable until changed · `VAR` changes between runs",
  "`!` marks a value that differs from the documented common default listed in the appendix — the strongest rows here.",
].join("  \n");

function factLine(fact: SpecFact, keyWidth: number): string {
  const mark = fact.deviates ? "!" : " ";
  return `${fact.stability.padEnd(3)} ${mark} ${fact.key.padEnd(keyWidth)} = ${fact.value}`;
}

/**
 * Renders the spec. The markdown body and the JSON block at the end are
 * generated from the same objects, so they cannot disagree; the JSON is the
 * canonical form and the body is the readable one.
 */
export function buildMimicSpec(input: MimicSpecInput): string {
  const { sections, droppedAsCommon } = buildSections(input);
  const factCount = sections.reduce((sum, s) => sum + s.facts.length, 0);
  const deviations = sections.flatMap((s) => s.facts.filter((f) => f.deviates));

  const lines: string[] = [
    "# Device spec",
    "",
    `Observed ${input.generatedAt} · one device, one Deep Probe run at ${input.tier} scope · ${factCount} facts kept, ${droppedAsCommon.length} dropped as common to all mobile browsers.`,
    "",
    "Everything below was measured on this device during the run. Nothing is inferred, looked up, or filled in from a database.",
    "",
    LEGEND,
    "",
  ];

  if (input.briefChecklist) lines.push(input.briefChecklist, "");

  if (deviations.length > 0) {
    lines.push(
      "## Start here",
      "",
      "These differ from the common default, so they carry the most weight:",
      "",
      "```",
      ...deviations.map((f) => `${f.key} = ${f.value}`),
      "```",
      ""
    );
  }

  let sectionNumber = 0;
  for (const section of sections) {
    if (section.facts.length === 0) continue;
    sectionNumber += 1;
    lines.push(`## ${sectionNumber} ${section.title}`, "");
    if (section.note) lines.push(section.note, "");
    const keyWidth = Math.min(34, Math.max(...section.facts.map((f) => f.key.length)));
    lines.push("```", ...section.facts.map((f) => factLine(f, keyWidth)), "```", "");
  }

  if (input.omissions.length > 0) {
    lines.push(
      `## ${sectionNumber + 1} Not observed`,
      "",
      "These stages did not run, so this spec says nothing about them. Their absence is a gap in the observation, not a property of the device:",
      "",
      ...input.omissions.map((o) => `- **${o.stage}** — ${o.reason}`),
      ""
    );
    sectionNumber += 1;
  }

  lines.push(
    `## ${sectionNumber + 1} How to read this`,
    "",
    "- **Uniqueness is not claimed.** This app sees one device. It cannot observe a population, so it never reports entropy, rarity or a fingerprint score — any such number would be a guess wearing the costume of a measurement. `!` means only *differs from the default listed below*.",
    "- **Match the tags, not just the values.** Holding a `VAR` value constant is as wrong as getting an `HW` value wrong: a battery level that never moves, or a round-trip time identical across sessions, describes a recording rather than a phone.",
    "- **Absent is printed, not omitted.** Where a capability is missing you will see it named as missing. A blank line and an absent feature must not look alike.",
    "- **Consistency is not identity.** A device matching every line here is *consistent with* this device. It is not proof of it, and nothing in this file should be presented as such.",
    "- **Your permission answers are not here.** What you allowed or refused is a decision about this run, not a property of the hardware. Only which permission names exist is recorded.",
    "",
    `## ${sectionNumber + 2} Appendix — what was dropped`,
    "",
    `${droppedAsCommon.length} readings matched a documented common default and were left out to keep this file legible. The list is editorial and published so it can be argued with; when a value was borderline it was kept rather than dropped.`,
    "",
    "```",
    ...(droppedAsCommon.length > 0 ? droppedAsCommon : ["(nothing was dropped — every reading in this run differed from the defaults)"]),
    "```",
    ""
  );

  const canonical = {
    kind: "deep-probe-device-spec",
    version: 1,
    generatedAt: input.generatedAt,
    scope: input.tier,
    uniquenessClaimed: false,
    stabilityLegend: {
      HW: "fixed to the hardware",
      OS: "moves with the OS or browser version",
      SET: "a user setting, stable until changed",
      VAR: "changes between runs and must be varied, not pinned",
    },
    sections: sections.map((section) => ({
      title: section.title,
      facts: section.facts.map((f) => ({ key: f.key, value: f.value, stability: f.stability, differsFromCommonDefault: f.deviates === true })),
    })),
    droppedAsCommonDefault: droppedAsCommon,
    notObserved: input.omissions,
  };

  lines.push(
    `## ${sectionNumber + 3} Canonical form`,
    "",
    "Same facts, generated from the same objects as the text above, so the two cannot disagree. Parse this one.",
    "",
    "```json",
    JSON.stringify(canonical, null, 1),
    "```",
    ""
  );

  return lines.join("\n");
}
