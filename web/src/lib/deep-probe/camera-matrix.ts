/**
 * Stage three — the exhaustive camera sweep.
 *
 * For every camera the device names, this asks for every resolution rung,
 * every aspect ratio, every frame rate and every control mode the hardware
 * advertises, and records ASKED versus GRANTED side by side.
 *
 * The central discipline here: a refusal is a result. `OverconstrainedError`
 * is not an app bug and is never reported as one — it is the camera stating
 * where its limits actually are, which is precisely what the sweep exists to
 * map. Equally, a request that succeeds while quietly delivering something
 * else is the more interesting case, so the granted settings are always read
 * back and compared rather than assumed to match the ask.
 *
 * Stills are taken at a declared subset of steps, and the report says exactly
 * which — implying a photo exists for every row would be a lie by omission.
 */

import type { PackOrigin } from "../evidence-pack";
import { type CameraDeviceInfo, classifyCameraLabel } from "../device-camera";
import { CAMERA_DEADLINE_POLICY, CAMERA_OPEN_TIMEOUT_MS, isCameraTimeout, openMediaWithDeadline, withCameraDeadline, type LateArrival } from "./camera-timeout";
import { drawVideoStill, heldBytesCeiling, readPixelSize, releaseScratchCanvas } from "./capture-memory";
import { CONSOLIDATION_POLICY, createShapeLedger, shapeScope, type ShapeGroup } from "./capture-signature";
import { readMemoryHints } from "./hex-budget";

/**
 * Quality passed to `toBlob` for the frames this app encodes. Recorded as a
 * constant because the value is itself evidence: it is one of the numbers that
 * distinguishes an app-encoded frame from a camera original, and a reader
 * comparing quantisation tables needs to know which figure produced them.
 */
export const CANVAS_ENCODE_QUALITY = 0.95;

/** One capture produced anywhere in the run, with its provenance already settled. */
export type ProbeCapture = {
  /** Filename-safe, unique within the run. */
  slug: string;
  label: string;
  blob: Blob;
  /** Declared by the code that made it — never inferred later. */
  origin: PackOrigin;
  /** Which stage produced it. */
  stage: "camera-sweep" | "manual";
  /** The camera it came from, when known. */
  deviceLabel: string | null;
  /** How the bytes were produced. */
  path: "image-capture" | "canvas" | "camera-file" | "picker-file";
  width: number;
  height: number;
  /** Original file name, for the paths that supply one. */
  fileName: string | null;
  /**
   * `File.lastModified` exactly as delivered. Kept raw because the sequence
   * across several shots in a row is the interesting part — how the number
   * moves is a platform trait, and a formatted date would hide the step.
   */
  fileLastModified: number | null;
  /** `File.webkitRelativePath`, which is empty on every path but a directory pick. */
  fileRelativePath: string | null;
  /** What was asked for at this step, in words. */
  asked: string;
  /** What the track actually reported after the ask. */
  granted: string;
  takenAt: string;
};

/** One row of the asked-versus-granted matrix. */
export type MatrixRow = {
  deviceId: string;
  deviceLabel: string;
  group: string;
  /** What kind of variation this row tests. */
  kind: "native-max" | "resolution" | "aspect-ratio" | "frame-rate" | "focus" | "exposure" | "white-balance" | "zoom" | "torch" | "resize-mode";
  asked: string;
  askedConstraints: Record<string, unknown>;
  ok: boolean;
  granted: string | null;
  grantedSettings: Record<string, unknown> | null;
  /** Set when the request was refused — the error name is the finding. */
  error: string | null;
  durationMs: number;
  /** Slugs of any captures taken at this step. Empty is normal and stated. */
  captureSlugs: string[];
  /**
   * Stills that WERE taken at this step and then not kept, because their
   * byte shape was already on file for this camera and this path.
   *
   * Recorded on the row rather than discarded, because the identity is the
   * finding: it says this request and an earlier one came out of one pipeline.
   * A row with entries here is a row where the camera answered — never one
   * where it failed.
   */
  duplicates: { path: ProbeCapture["path"]; sameAsSlug: string; shapeId: string; reason: string }[];
};

/**
 * The objects a website actually receives from a live camera track, kept
 * verbatim rather than summarised.
 *
 * Key order is preserved exactly as the browser produced it, because the order
 * of keys in `getSettings()` is itself an engine trait — reserialising through a
 * sorted structure would quietly destroy it. Nothing here is renamed,
 * reformatted or rounded.
 */
export type CameraSurfaceRecord = {
  deviceId: string;
  deviceLabel: string;
  /** How long getUserMedia took to resolve, in ms. */
  openMs: number;
  streamId: string;
  trackId: string;
  trackLabel: string;
  trackKind: string;
  trackReadyState: string;
  trackMuted: boolean;
  trackEnabled: boolean;
  /** `track.getSettings()` as returned. */
  settings: Record<string, unknown> | null;
  /** `track.getCapabilities()` as returned, with its min/max ranges intact. */
  capabilities: Record<string, unknown> | null;
  /** `track.getConstraints()` after a typical request. */
  constraints: Record<string, unknown> | null;
  /** What a `<video>` element reads for this track. */
  videoWidth: number | null;
  videoHeight: number | null;
  /** `ImageCapture.getPhotoCapabilities()`, when the class exists here. */
  photoCapabilities: Record<string, unknown> | null;
  photoSettings: Record<string, unknown> | null;
  /** Stated when a reading could not be taken, so absence never reads as zero. */
  notes: string[];
};

export type CameraMatrixReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inventory: CameraDeviceInfo[];
  rows: MatrixRow[];
  /** Steps at which a still was deliberately taken. */
  stillPolicy: string;
  notes: string[];
  /** True when the user stopped the sweep before it finished. */
  aborted: boolean;
  /**
   * Set when the held-bytes ceiling stopped stills part way through. The sweep
   * carries on mapping when this happens, so the rows stay complete while the
   * captures do not — a difference the archive has to state rather than imply.
   */
  stillsStoppedForMemory: string | null;
  /** Peak capture bytes held at once, and the ceiling it was measured against. */
  memory: { heldBytes: number; ceilingBytes: number; peakCanvasBytes: number };
  /** One entry per distinct file shape kept, with every later request that repeated it. */
  shapes: ShapeGroup[];
  /** Shapes that turned up under more than one camera or path — a finding, not a duplicate. */
  sharedShapes: { id: string; scopes: string[] }[];
  /** How many stills were taken, how many survived, and what the collapse saved. */
  consolidation: { taken: number; kept: number; dropped: number; bytesSaved: number };
  /** The verbatim JS-visible surface of each camera. */
  surface: CameraSurfaceRecord[];
  /** `enumerateDevices()` before the sweep opened anything, full IDs, untruncated. */
  devicesBefore: { kind: string; deviceId: string; groupId: string; label: string }[];
  /** The same call after the sweep, which is where labels and stable IDs appear. */
  devicesAfter: { kind: string; deviceId: string; groupId: string; label: string }[];
};

export type MatrixProgress = (message: string, done: number, total: number) => void;

/** The resolution ladder, largest first, each also asked in portrait. */
const LADDER: { w: number; h: number; name: string }[] = [
  { w: 7680, h: 4320, name: "8K UHD" },
  { w: 3840, h: 2160, name: "4K UHD" },
  { w: 2560, h: 1440, name: "1440p" },
  { w: 1920, h: 1080, name: "1080p" },
  { w: 1280, h: 720, name: "720p" },
  { w: 640, h: 480, name: "VGA" },
  { w: 320, h: 240, name: "QVGA" },
];

const ASPECTS: { ratio: number; name: string }[] = [
  { ratio: 4 / 3, name: "4:3" },
  { ratio: 16 / 9, name: "16:9" },
  { ratio: 1, name: "1:1" },
  { ratio: 3 / 2, name: "3:2" },
  { ratio: 9 / 16, name: "9:16" },
  { ratio: 21 / 9, name: "21:9" },
];

const FRAME_RATES: number[] = [15, 24, 30, 60, 120];

const STILL_POLICY =
  "A still was ATTEMPTED at the native maximum, at every landscape resolution rung, and at every aspect ratio — down BOTH available paths at each of those steps (the browser's own photo pipeline, and a frame this app encoded from the video track). Portrait variants, frame-rate steps and control-mode steps deliberately attempt none: they change how the track behaves, not what a photo of it looks like. A still that WAS taken is only kept when its byte shape is new for that camera and that path; one repeating a shape already held is recorded on its row and dropped, since a second copy of a file already in the archive is weight rather than evidence. So an empty capture list on a row means one of two stated things — no still was attempted there, or the still that was taken had a shape already on file — and never that the camera failed.";

type PhotoCaps = { imageWidth?: { max?: number }; imageHeight?: { max?: number } };
type ImageCaptureLike = {
  takePhoto: (s?: { imageWidth?: number; imageHeight?: number }) => Promise<Blob>;
  getPhotoCapabilities: () => Promise<PhotoCaps>;
  getPhotoSettings?: () => Promise<Record<string, unknown>>;
};
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

function imageCaptureCtor(): ImageCaptureCtor | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture ?? null;
}

function settingsText(s: MediaTrackSettings | null): string {
  if (!s) return "(no settings reported)";
  const bits: string[] = [];
  if (s.width && s.height) bits.push(`${s.width}×${s.height}`);
  if (s.frameRate) bits.push(`${Math.round(s.frameRate * 100) / 100} fps`);
  if (s.facingMode) bits.push(String(s.facingMode));
  if (s.aspectRatio) bits.push(`AR ${Math.round(s.aspectRatio * 1000) / 1000}`);
  const ext = s as MediaTrackSettings & { zoom?: number; torch?: boolean; focusMode?: string; exposureMode?: string; whiteBalanceMode?: string; resizeMode?: string };
  if (ext.zoom != null) bits.push(`zoom ${ext.zoom}`);
  if (ext.torch != null) bits.push(`torch ${ext.torch}`);
  if (ext.focusMode) bits.push(`focus ${ext.focusMode}`);
  if (ext.exposureMode) bits.push(`exposure ${ext.exposureMode}`);
  if (ext.whiteBalanceMode) bits.push(`WB ${ext.whiteBalanceMode}`);
  if (ext.resizeMode) bits.push(`resize ${ext.resizeMode}`);
  return bits.join(" · ") || "(settings object was empty)";
}

function plainSettings(s: MediaTrackSettings | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Copies a browser-produced object without touching key order or values.
 *
 * `getCapabilities()` returns nested `{min, max}` ranges that a naive spread
 * would flatten, so this goes through a structured clone of the whole object.
 */
function verbatim(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reads the whole JS-visible surface of one open track. */
async function readSurface(
  device: CameraDeviceInfo,
  name: string,
  stream: MediaStream,
  track: MediaStreamTrack,
  openMs: number,
  videoDims: { width: number; height: number } | null
): Promise<CameraSurfaceRecord> {
  const notes: string[] = [];
  let capabilities: Record<string, unknown> | null = null;
  try {
    capabilities = track.getCapabilities ? verbatim(track.getCapabilities()) : null;
    if (!track.getCapabilities) notes.push("track.getCapabilities is not implemented in this browser, so no capability ranges could be read. This is an absence, not an empty range.");
  } catch (err) {
    notes.push(`track.getCapabilities() threw: ${errorName(err)}`);
  }
  let constraints: Record<string, unknown> | null = null;
  try {
    constraints = track.getConstraints ? verbatim(track.getConstraints()) : null;
  } catch (err) {
    notes.push(`track.getConstraints() threw: ${errorName(err)}`);
  }

  let photoCapabilities: Record<string, unknown> | null = null;
  let photoSettings: Record<string, unknown> | null = null;
  const Ctor = imageCaptureCtor();
  if (!Ctor) {
    notes.push("ImageCapture does not exist in this browser, so no photo capabilities were readable. Safari on iOS is in this position.");
  } else {
    try {
      const capture = new Ctor(track);
      photoCapabilities = verbatim(await capture.getPhotoCapabilities());
      if (capture.getPhotoSettings) photoSettings = verbatim(await capture.getPhotoSettings());
      else notes.push("ImageCapture exists but getPhotoSettings is not implemented on it.");
    } catch (err) {
      notes.push(`ImageCapture photo interrogation threw: ${errorName(err)}`);
    }
  }

  if (!videoDims) notes.push("No <video> element could be attached, so videoWidth/videoHeight were not read.");

  return {
    deviceId: device.deviceId,
    deviceLabel: name,
    openMs: Math.round(openMs),
    streamId: stream.id,
    trackId: track.id,
    trackLabel: track.label,
    trackKind: track.kind,
    trackReadyState: track.readyState,
    trackMuted: track.muted,
    trackEnabled: track.enabled,
    settings: verbatim(track.getSettings?.() ?? null),
    capabilities,
    constraints,
    videoWidth: videoDims?.width ?? null,
    videoHeight: videoDims?.height ?? null,
    photoCapabilities,
    photoSettings,
    notes,
  };
}

function stop(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      // already stopped
    }
  });
}

function errorName(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message || "no message"}`;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Attaches a hidden video element so a canvas still has a frame to draw. */
async function attachVideo(stream: MediaStream): Promise<HTMLVideoElement | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "true");
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px";
  document.body.appendChild(video);
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    video.remove();
    return null;
  }
  // Wait for a real frame; a canvas drawn from a 0×0 video yields nothing.
  const start = performance.now();
  while (video.videoWidth === 0 && performance.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (video.videoWidth === 0) {
    video.remove();
    return null;
  }
  return video;
}

function detachVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.srcObject = null;
  video.remove();
}

async function platformStill(track: MediaStreamTrack): Promise<{ blob: Blob; width: number; height: number } | null> {
  const Ctor = imageCaptureCtor();
  if (!Ctor || track.readyState !== "live") return null;
  try {
    const capture = new Ctor(track);
    // takePhoto() hangs on the same devices, and for the same reasons, as the
    // open does. Without a deadline one wedged still stalls the whole sweep.
    const blob = await withCameraDeadline(capture.takePhoto(), { what: "the platform photo pipeline" });
    // Dimensions come from the file's own header. Decoding the whole picture to
    // read two numbers cost ~31.6 MiB a photo and was a direct cause of the
    // sweep running out of memory.
    const size = await readPixelSize(blob);
    return { blob, width: size?.width ?? 0, height: size?.height ?? 0 };
  } catch {
    return null;
  }
}

type StepPlan = {
  kind: MatrixRow["kind"];
  asked: string;
  constraints: MediaTrackConstraints;
  takeStills: boolean;
};

/** Builds every constraint variation for one camera. Order is coarse-to-fine so an early abort still yields the useful rows. */
function planFor(deviceId: string): StepPlan[] {
  const pin = { deviceId: { exact: deviceId } } as MediaTrackConstraints;
  const steps: StepPlan[] = [
    {
      kind: "native-max",
      asked: "native maximum (8K ideal, no other constraint)",
      constraints: { ...pin, width: { ideal: 7680 }, height: { ideal: 4320 } },
      takeStills: true,
    },
  ];
  for (const rung of LADDER) {
    steps.push({
      kind: "resolution",
      asked: `${rung.name} landscape — exactly ${rung.w}×${rung.h}`,
      constraints: { ...pin, width: { exact: rung.w }, height: { exact: rung.h } },
      takeStills: true,
    });
    steps.push({
      kind: "resolution",
      asked: `${rung.name} portrait — exactly ${rung.h}×${rung.w}`,
      constraints: { ...pin, width: { exact: rung.h }, height: { exact: rung.w } },
      takeStills: false,
    });
  }
  for (const aspect of ASPECTS) {
    steps.push({
      kind: "aspect-ratio",
      asked: `aspect ratio ${aspect.name} (exact ${Math.round(aspect.ratio * 10000) / 10000})`,
      constraints: { ...pin, aspectRatio: { exact: Math.round(aspect.ratio * 10000) / 10000 } },
      takeStills: true,
    });
  }
  for (const fps of FRAME_RATES) {
    steps.push({
      kind: "frame-rate",
      asked: `exactly ${fps} fps`,
      constraints: { ...pin, frameRate: { exact: fps } },
      takeStills: false,
    });
  }
  return steps;
}

/**
 * Camera controls live in the `advanced` constraint set, which the DOM types
 * model as a closed list that predates focus, exposure, white-balance, zoom and
 * torch. The properties are real and shipping; only the type definition lags,
 * so the cast is confined to this one helper rather than sprayed at each site.
 */
type AdvancedConstraint = { focusMode?: string; exposureMode?: string; whiteBalanceMode?: string; zoom?: number; torch?: boolean };

function advanced(set: AdvancedConstraint): MediaTrackConstraints {
  return { advanced: [set] } as unknown as MediaTrackConstraints;
}

/** Control modes are applied to an already-open track, since they are not opening constraints. */
type ControlStep = { kind: MatrixRow["kind"]; asked: string; constraints: MediaTrackConstraints };

function controlStepsFor(caps: MediaTrackCapabilities | null): ControlStep[] {
  if (!caps) return [];
  const ext = caps as MediaTrackCapabilities & {
    focusMode?: string[];
    exposureMode?: string[];
    whiteBalanceMode?: string[];
    resizeMode?: string[];
    zoom?: { min?: number; max?: number };
    torch?: boolean;
  };
  const steps: ControlStep[] = [];
  for (const mode of ext.focusMode ?? []) {
    steps.push({ kind: "focus", asked: `focusMode "${mode}"`, constraints: advanced({ focusMode: mode }) });
  }
  for (const mode of ext.exposureMode ?? []) {
    steps.push({ kind: "exposure", asked: `exposureMode "${mode}"`, constraints: advanced({ exposureMode: mode }) });
  }
  for (const mode of ext.whiteBalanceMode ?? []) {
    steps.push({ kind: "white-balance", asked: `whiteBalanceMode "${mode}"`, constraints: advanced({ whiteBalanceMode: mode }) });
  }
  for (const mode of ext.resizeMode ?? []) {
    steps.push({ kind: "resize-mode", asked: `resizeMode "${mode}"`, constraints: { resizeMode: { exact: mode } } as MediaTrackConstraints });
  }
  if (ext.zoom?.min != null && ext.zoom.max != null && ext.zoom.max > ext.zoom.min) {
    steps.push({ kind: "zoom", asked: `zoom at minimum (${ext.zoom.min})`, constraints: advanced({ zoom: ext.zoom.min }) });
    steps.push({ kind: "zoom", asked: `zoom at maximum (${ext.zoom.max})`, constraints: advanced({ zoom: ext.zoom.max }) });
  }
  if (ext.torch === true) {
    steps.push({ kind: "torch", asked: "torch on", constraints: advanced({ torch: true }) });
    steps.push({ kind: "torch", asked: "torch off", constraints: advanced({ torch: false }) });
  }
  return steps;
}

export type SweepOptions = {
  onProgress: MatrixProgress;
  onCapture: (capture: ProbeCapture) => void;
  /** Polled between steps; returning true ends the sweep cleanly at the next boundary. */
  shouldAbort: () => boolean;
  /**
   * Awaited at every step boundary, so a pause always lands between steps and
   * never mid-step. Half-applying a constraint and then holding the track open
   * would leave a row whose granted settings describe a paused camera rather
   * than the setting under test.
   */
  waitWhilePaused?: () => Promise<void>;
};

/**
 * Runs the full sweep. Requires camera permission to already be granted —
 * the permission stage handles that, and if it was refused this returns an
 * empty inventory with an explicit note instead of re-prompting.
 */
export async function runCameraSweep(options: SweepOptions): Promise<{ report: CameraMatrixReport; captures: ProbeCapture[] }> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const notes: string[] = [];
  const rows: MatrixRow[] = [];
  const captures: ProbeCapture[] = [];
  let aborted = false;
  let counter = 0;

  const surface: CameraSurfaceRecord[] = [];
  let devicesBefore: { kind: string; deviceId: string; groupId: string; label: string }[] = [];
  let devicesAfter: { kind: string; deviceId: string; groupId: string; label: string }[] = [];

  // Bytes held is tracked here rather than only on screen, because the sweep is
  // what has to act on it. Reaching the ceiling stops stills and keeps mapping:
  // the asked-versus-granted rows are the product of this stage and cost nothing
  // to hold, so spending the remaining memory on more near-identical frames
  // would be the wrong way round.
  const memoryHints = readMemoryHints();
  const ceilingBytes = heldBytesCeiling(memoryHints);
  let heldBytes = 0;
  let peakCanvasBytes = 0;
  let stillsStoppedForMemory: string | null = null;

  // Timeouts are counted rather than only written into their rows, so the
  // summary can say how much of the sweep was abandoned rather than answered.
  let timeouts = 0;
  const noteLate = (late: LateArrival): void => {
    notes.push(
      `${late.what} answered ${(late.arrivedAtMs / 1000).toFixed(1)}s after the request — past the ${(late.waitedMs / 1000).toFixed(0)}s deadline, so the sweep had already moved on. ` +
        `${late.streamClosed ? "The stream it handed over was closed immediately, so the camera did not stay open behind the run. " : ""}` +
        `The row for that step stays as a timeout: it is a record of what happened, not a judgement about the camera.`
    );
  };

  // Every still is reduced to a shape before it is kept. Two requests answered
  // by one pipeline produce one file, and the fact that they matched is written
  // onto the row instead of being stored a second time.
  const ledger = createShapeLedger();
  let stillsTaken = 0;

  /**
   * Offers a still to the ledger. Kept stills consume a slug and are recorded;
   * repeats are written onto the row and dropped without ever being counted as
   * photographs taken.
   */
  const offer = async (build: (slug: string) => ProbeCapture, row: { captureSlugs: string[]; duplicates: MatrixRow["duplicates"] }, prefix: string): Promise<void> => {
    // The slug is only peeked at: the counter moves when a still survives, so
    // the numbering never carries a gap where a duplicate used to be.
    const capture = build(`${String(counter + 1).padStart(3, "0")}-${prefix}`);
    stillsTaken += 1;
    const verdict = await ledger.consider({
      slug: capture.slug,
      blob: capture.blob,
      scope: shapeScope(capture.deviceLabel, capture.path),
      asked: capture.asked,
    });
    if (verdict.repeat != null) {
      row.duplicates.push({ path: capture.path, sameAsSlug: verdict.repeat.sameAsSlug, shapeId: verdict.shape.id, reason: verdict.repeat.reason });
      return;
    }
    counter += 1;
    captures.push(capture);
    heldBytes += capture.blob.size;
    row.captureSlugs.push(capture.slug);
    options.onCapture(capture);
  };

  /** True while there is still room to hold another still. */
  const stillsAllowed = (): boolean => {
    if (stillsStoppedForMemory != null) return false;
    if (heldBytes < ceilingBytes) return true;
    stillsStoppedForMemory =
      `Capture bytes held reached ${(heldBytes / 1024 / 1024).toFixed(1)} MB, at or above this device's ${(ceilingBytes / 1024 / 1024).toFixed(0)} MB ceiling, so the sweep stopped taking stills. Every remaining request was still made and every asked-versus-granted row below is complete — only the photographs stop. Rows after this point have an empty capture list for that reason and no other.`;
    notes.push(stillsStoppedForMemory);
    return false;
  };

  if (!navigator.mediaDevices?.getUserMedia) {
    notes.push("This browser exposes no navigator.mediaDevices, so no camera could be opened. Nothing below is a refusal — the API is simply absent.");
    return {
      report: {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        inventory: [],
        rows,
        stillPolicy: STILL_POLICY,
        notes,
        aborted,
        stillsStoppedForMemory: null,
        memory: { heldBytes: 0, ceilingBytes: heldBytesCeiling(readMemoryHints()), peakCanvasBytes: 0 },
        shapes: [],
        sharedShapes: [],
        consolidation: { taken: 0, kept: 0, dropped: 0, bytesSaved: 0 },
        surface,
        devicesBefore,
        devicesAfter,
      },
      captures,
    };
  }

  let inventory: CameraDeviceInfo[] = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // Full IDs, every kind, untruncated: a shortened deviceId cannot be compared
    // against anything, and audio inputs share a groupId with their camera.
    devicesBefore = devices.map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId ?? "", label: d.label ?? "" }));
    inventory = devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => ({ deviceId: d.deviceId, groupId: d.groupId ?? "", label: d.label ?? "", ...classifyCameraLabel(d.label ?? "") }));
  } catch (err) {
    notes.push(`enumerateDevices() failed: ${errorName(err)}`);
  }

  if (inventory.length === 0) {
    notes.push("No video inputs were enumerated. If camera permission was refused earlier, that is the reason — the sweep does not re-prompt.");
  }
  if (inventory.every((d) => d.label === "") && inventory.length > 0) {
    notes.push(
      `${inventory.length} camera(s) exist but none carries a name. Browsers blank device labels until a camera grant exists, so this is the privacy rule working, not a fault.`
    );
  }

  const perDevice = planFor("x").length;
  const total = Math.max(1, inventory.length * (perDevice + 6));
  let done = 0;

  for (const device of inventory) {
    await options.waitWhilePaused?.();
    if (options.shouldAbort()) {
      aborted = true;
      break;
    }
    const name = device.label || `camera ${device.deviceId.slice(0, 8)}`;
    let capabilities: MediaTrackCapabilities | null = null;

    for (const step of planFor(device.deviceId)) {
      await options.waitWhilePaused?.();
      if (options.shouldAbort()) {
        aborted = true;
        break;
      }
      done += 1;
      options.onProgress(`${name} — ${step.asked}`, done, total);

      const stepStart = performance.now();
      let stream: MediaStream | null = null;
      try {
        stream = await openMediaWithDeadline({ audio: false, video: step.constraints }, { what: `${name} (${step.asked})`, onLate: noteLate });
      } catch (err) {
        if (isCameraTimeout(err)) timeouts += 1;
        rows.push({
          deviceId: device.deviceId,
          deviceLabel: name,
          group: device.groupId,
          kind: step.kind,
          asked: step.asked,
          askedConstraints: step.constraints as Record<string, unknown>,
          ok: false,
          granted: null,
          grantedSettings: null,
          error: errorName(err),
          durationMs: Math.round(performance.now() - stepStart),
          captureSlugs: [],
          duplicates: [],
        });
        continue;
      }

      const track = stream.getVideoTracks()[0] ?? null;
      const settings = track?.getSettings?.() ?? null;
      if (!capabilities && track?.getCapabilities) {
        try {
          capabilities = track.getCapabilities();
        } catch {
          capabilities = null;
        }
      }

      const stepRow = { captureSlugs: [] as string[], duplicates: [] as MatrixRow["duplicates"] };
      let videoDims: { width: number; height: number } | null = null;
      if (step.takeStills && track && stillsAllowed()) {
        const video = await attachVideo(stream);
        if (video) videoDims = { width: video.videoWidth, height: video.videoHeight };

        const platform = await platformStill(track);
        if (platform) {
          await offer(
            (slug) => ({
              slug,
              label: `${name} — ${step.asked} — platform photo pipeline`,
              blob: platform.blob,
              origin: "platform-photo",
              stage: "camera-sweep",
              deviceLabel: name,
              path: "image-capture",
              width: platform.width,
              height: platform.height,
              fileName: null,
              fileLastModified: null,
              fileRelativePath: null,
              asked: step.asked,
              granted: settingsText(settings),
              takenAt: new Date().toISOString(),
            }),
            stepRow,
            "platform"
          );
        }

        if (video) {
          const drawn = await drawVideoStill(video, CANVAS_ENCODE_QUALITY);
          if (drawn) peakCanvasBytes = Math.max(peakCanvasBytes, drawn.canvasBytes);
          if (drawn) {
            await offer(
              (slug) => ({
                slug,
                label: `${name} — ${step.asked} — frame encoded by this app`,
                blob: drawn.blob,
                origin: "app-encoded-frame",
                stage: "camera-sweep",
                deviceLabel: name,
                path: "canvas",
                width: drawn.width,
                height: drawn.height,
                fileName: null,
                fileLastModified: null,
                fileRelativePath: null,
                asked: step.asked,
                granted: settingsText(settings),
                takenAt: new Date().toISOString(),
              }),
              stepRow,
              "canvas"
            );
          }
          detachVideo(video);
        }
      } else if (step.takeStills && track) {
        // Read the video dimensions anyway: it is the one reading that costs no
        // memory, and losing it would make the row less complete than it needs
        // to be just because the photograph was skipped.
        const video = await attachVideo(stream);
        if (video) {
          videoDims = { width: video.videoWidth, height: video.videoHeight };
          detachVideo(video);
        }
      }

      rows.push({
        deviceId: device.deviceId,
        deviceLabel: name,
        group: device.groupId,
        kind: step.kind,
        asked: step.asked,
        askedConstraints: step.constraints as Record<string, unknown>,
        ok: true,
        granted: settingsText(settings),
        grantedSettings: plainSettings(settings),
        error: null,
        durationMs: Math.round(performance.now() - stepStart),
        captureSlugs: stepRow.captureSlugs,
        duplicates: stepRow.duplicates,
      });

      // Read the verbatim JS surface once per camera, on the track that is
      // already open, so this costs no extra prompt and no extra camera cycle.
      if (step.kind === "native-max" && track) {
        try {
          surface.push(await readSurface(device, name, stream, track, performance.now() - stepStart, videoDims));
        } catch (err) {
          notes.push(`${name}: the JS surface could not be read (${errorName(err)}).`);
        }
      }
      stop(stream);
    }

    if (aborted) break;

    // Control modes need one open track they can be applied to in sequence.
    const controls = controlStepsFor(capabilities);
    if (controls.length === 0) {
      notes.push(`${name}: the platform advertised no focus, exposure, white-balance, resize, zoom or torch controls, so there was nothing to apply.`);
    } else {
      let stream: MediaStream | null = null;
      try {
        stream = await openMediaWithDeadline({ audio: false, video: { deviceId: { exact: device.deviceId } } }, { what: `${name} (control-mode reopen)`, onLate: noteLate });
      } catch (err) {
        if (isCameraTimeout(err)) timeouts += 1;
        notes.push(`${name}: could not reopen for control-mode testing (${errorName(err)}).`);
      }
      const track = stream?.getVideoTracks()[0] ?? null;
      for (const control of controls) {
        await options.waitWhilePaused?.();
        if (options.shouldAbort()) {
          aborted = true;
          break;
        }
        done += 1;
        options.onProgress(`${name} — ${control.asked}`, done, total);
        const stepStart = performance.now();
        if (!track) {
          rows.push({
            deviceId: device.deviceId,
            deviceLabel: name,
            group: device.groupId,
            kind: control.kind,
            asked: control.asked,
            askedConstraints: control.constraints as Record<string, unknown>,
            ok: false,
            granted: null,
            grantedSettings: null,
            error: "no track available to apply the constraint to",
            durationMs: 0,
            captureSlugs: [],
            duplicates: [],
          });
          continue;
        }
        try {
          await track.applyConstraints(control.constraints);
          const after = track.getSettings?.() ?? null;
          rows.push({
            deviceId: device.deviceId,
            deviceLabel: name,
            group: device.groupId,
            kind: control.kind,
            asked: control.asked,
            askedConstraints: control.constraints as Record<string, unknown>,
            ok: true,
            granted: settingsText(after),
            grantedSettings: plainSettings(after),
            error: null,
            durationMs: Math.round(performance.now() - stepStart),
            captureSlugs: [],
            duplicates: [],
          });
        } catch (err) {
          rows.push({
            deviceId: device.deviceId,
            deviceLabel: name,
            group: device.groupId,
            kind: control.kind,
            asked: control.asked,
            askedConstraints: control.constraints as Record<string, unknown>,
            ok: false,
            granted: null,
            grantedSettings: null,
            error: errorName(err),
            durationMs: Math.round(performance.now() - stepStart),
            captureSlugs: [],
            duplicates: [],
          });
        }
      }
      // Torch off, always, so the sweep never leaves the flash burning.
      try {
        await track?.applyConstraints(advanced({ torch: false }));
      } catch {
        // torch was never controllable
      }
      stop(stream);
    }
  }

  if (aborted) notes.push("You stopped the sweep before it finished. Every row above really ran; the rows that never ran are simply absent, and the archive is marked partial.");
  if (ledger.droppedCount() > 0) {
    notes.push(
      `${ledger.droppedCount()} of ${stillsTaken} still(s) repeated a byte shape already held for the same camera and the same path, and were not kept — saving ${(ledger.bytesSaved() / 1024 / 1024).toFixed(1)} MB. ` +
        `Each one is named on its own row with the file it matched. Those requests all succeeded; nothing here is a camera failing, and nothing that was dropped is counted as a photograph taken.`
    );
  }
  for (const shared of ledger.sharedShapes()) {
    notes.push(
      `Shape ${shared.id} appeared under more than one scope — ${shared.scopes.join(" and ")}. Each scope kept its own copy, deliberately: one encoder pipeline serving two different lenses or two different paths is a fact about this device, and collapsing it would have destroyed the evidence for it.`
    );
  }
  if (timeouts > 0) {
    notes.push(
      `${timeouts} request(s) passed the ${(CAMERA_OPEN_TIMEOUT_MS / 1000).toFixed(0)}-second camera deadline without answering and were abandoned so the sweep could continue. ` +
        "Those rows say TIMED OUT and mean only that. They are not refusals, they are not limits the camera stated, and nothing about the hardware should be read from them."
    );
  }

  // The shared canvas is no longer needed; drop its last frame rather than
  // leaving it resident through the archive build, which is the other memory-
  // hungry phase of the run.
  releaseScratchCanvas();

  try {
    const after = await navigator.mediaDevices.enumerateDevices();
    devicesAfter = after.map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId ?? "", label: d.label ?? "" }));
  } catch (err) {
    notes.push(`The closing enumerateDevices() call failed: ${errorName(err)}`);
  }

  return {
    report: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      inventory,
      rows,
      stillPolicy: STILL_POLICY,
      notes,
      aborted,
      stillsStoppedForMemory,
      memory: { heldBytes, ceilingBytes, peakCanvasBytes },
      shapes: ledger.groups(),
      sharedShapes: ledger.sharedShapes(),
      consolidation: { taken: stillsTaken, kept: ledger.keptCount(), dropped: ledger.droppedCount(), bytesSaved: ledger.bytesSaved() },
      surface,
      devicesBefore,
      devicesAfter,
    },
    captures,
  };
}

/** The readable asked-versus-granted table that goes into the archive. */
export function matrixText(report: CameraMatrixReport): string {
  const lines: string[] = [
    "CAMERA MATRIX — ASKED VERSUS GRANTED",
    "=".repeat(78),
    `Started  ${report.startedAt}`,
    `Finished ${report.finishedAt} (${(report.durationMs / 1000).toFixed(1)}s)`,
    report.aborted ? "STATUS   PARTIAL — the sweep was stopped early. Rows that never ran are absent, not failed." : "STATUS   Complete.",
    "",
    "HOW TO READ THIS",
    "-".repeat(78),
    "Each row is one request made of one camera. `asked` is the constraint sent; `granted` is what the",
    "track reported back afterwards. They are listed separately on purpose: a request that succeeds while",
    "quietly delivering a different size is far more revealing than one that fails outright.",
    "",
    "A REJECTED row is a result, not an error. OverconstrainedError means the camera stated a limit, which",
    "is exactly what this sweep is for. Nothing here is an app fault, and nothing here is evidence about",
    "you — it is a map of the hardware.",
    "",
    "THE CAMERA DEADLINE",
    "-".repeat(78),
    CAMERA_DEADLINE_POLICY,
    "",
    "STILL POLICY",
    "-".repeat(78),
    ...wrap(report.stillPolicy, 78),
    "",
    ...CONSOLIDATION_POLICY,
    "",
    `  This run: ${report.consolidation.taken} still(s) taken, ${report.consolidation.kept} kept, ${report.consolidation.dropped} dropped as repeats` +
      `${report.consolidation.bytesSaved > 0 ? `, ${(report.consolidation.bytesSaved / 1024 / 1024).toFixed(1)} MB not stored` : ""}.`,
    "",
    `CAMERAS (${report.inventory.length})`,
    "-".repeat(78),
  ];

  for (const [i, d] of report.inventory.entries()) {
    lines.push(
      `  [${i + 1}] ${d.label || "(unnamed — the browser withheld the label)"}`,
      `      deviceId ${d.deviceId ? `${d.deviceId.slice(0, 20)}…` : "(none)"} · groupId ${d.groupId ? `${d.groupId.slice(0, 16)}…` : "(none)"}`
    );
  }

  const byDevice = new Map<string, MatrixRow[]>();
  for (const row of report.rows) {
    const list = byDevice.get(row.deviceLabel) ?? [];
    list.push(row);
    byDevice.set(row.deviceLabel, list);
  }

  for (const [device, deviceRows] of byDevice) {
    const granted = deviceRows.filter((r) => r.ok).length;
    lines.push(
      "",
      "=".repeat(78),
      `${device} — ${granted} granted / ${deviceRows.length - granted} rejected of ${deviceRows.length} requests`,
      "=".repeat(78)
    );
    for (const row of deviceRows) {
      lines.push(
        "",
        `  ${row.ok ? "[GRANTED ]" : "[REJECTED]"} ${row.asked}   (${row.kind}, ${row.durationMs} ms)`,
        row.ok ? `             got: ${row.granted}` : `             ${row.error}`
      );
      if (row.captureSlugs.length > 0) lines.push(`             stills: ${row.captureSlugs.join(", ")}`);
      for (const duplicate of row.duplicates) {
        lines.push(`             repeat: a ${duplicate.path} still was taken here and matched ${duplicate.sameAsSlug} exactly (shape ${duplicate.shapeId}), so it was not kept.`);
      }
    }
  }

  if (report.shapes.length > 0) {
    lines.push(
      "",
      "=".repeat(78),
      `DISTINCT FILE SHAPES (${report.shapes.length})`,
      "=".repeat(78),
      "",
      "One entry per genuinely different file this device produced. Everything the sweep took collapsed",
      "into these; the requests listed under each one all came out of the same pipeline byte-for-byte.",
      ""
    );
    for (const shape of report.shapes) {
      lines.push(
        `  ${shape.id}  ${shape.container} ${shape.width}×${shape.height}`,
        `      scope   ${shape.scope}`,
        `      kept    ${shape.keptSlug} — first seen when asked for: ${shape.keptAsked}`
      );
      if (shape.repeats.length === 0) {
        lines.push("      repeats none — this shape appeared exactly once.");
      } else {
        lines.push(`      repeats ${shape.repeats.length}, ${(shape.bytesSaved / 1024 / 1024).toFixed(1)} MB not stored:`);
        for (const repeat of shape.repeats.slice(0, 12)) lines.push(`                · ${repeat.asked}`);
        if (shape.repeats.length > 12) lines.push(`                · … and ${shape.repeats.length - 12} more`);
      }
      lines.push("");
    }
  }

  if (report.notes.length > 0) {
    lines.push("", "NOTES", "-".repeat(78), ...report.notes.map((n) => `  - ${n}`));
  }
  return lines.join("\n");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
