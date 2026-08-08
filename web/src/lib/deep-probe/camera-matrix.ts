/**
 * Stage three — the camera sweep.
 *
 * For every camera the device names, this asks for the resolution rungs, aspect
 * ratios, frame rates and control modes that camera's own capabilities make a
 * real question, and records ASKED versus GRANTED side by side.
 *
 * It used to send one identical 28-step plan to every camera, which meant
 * asking a 720p front camera for 8K, 4K and 1440p and asking a 30 fps sensor
 * for 60 and 120 — questions the camera had already answered in
 * `getCapabilities()` before the first one was sent, at the price of a camera
 * open each. The plan is now built from that answer. One rung and one frame
 * rate above the ceiling survive on purpose, because clamping and refusing are
 * different behaviours and the capability object does not say which you get.
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
 * That subset is now TWO photographs per camera and no more: the native
 * maximum down the browser's own photo pipeline, and the smallest rung down the
 * path this app encodes. Everything else is still asked for and still recorded;
 * it simply no longer produces a picture, and every such row says so.
 *
 * The time that buys is spent on the impossible round — see `impossible-asks.ts`
 * — which asks each camera for things it cannot do. Succeeding is easy to
 * imitate; refusing correctly is not.
 */

import type { PackOrigin } from "../evidence-pack";
import { type CameraDeviceInfo, classifyCameraLabel } from "../device-camera";
import { CAMERA_DEADLINE_POLICY, CAMERA_OPEN_TIMEOUT_MS, isCameraTimeout, openMediaWithDeadline, withCameraDeadline, type LateArrival } from "./camera-timeout";
import { impossibleAsksFor, impossibleObservations, impossibleText, runImpossibleRound, type ImpossibleAnswer, type ImpossibleTarget } from "./impossible-asks";
import { drawVideoStill, heldBytesCeiling, readPixelSize, releaseScratchCanvas } from "./capture-memory";
import { CONSOLIDATION_POLICY, createShapeLedger, shapeScope, type ShapeGroup } from "./capture-signature";
import { readMemoryHints } from "./hex-budget";
import { budgetReachedText, cameraBudgetMs, createStepTimer, formatDuration, type CameraCost } from "./run-cost";

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
   * Photographs this step did not end up contributing, and why.
   *
   * Two different things live here and `taken` says which. `taken: true` is a
   * still that WAS photographed and then not kept, because its byte shape was
   * already on file for this camera and this path — the identity is the
   * finding, since it says this request and an earlier one came out of one
   * pipeline. `taken: false` is a photograph that was never made, because the
   * size this step was granted had already been photographed on that path; the
   * request still ran and its granted settings are on the row.
   *
   * A row with entries here is always a row where the camera answered — never
   * one where it failed.
   *
   * `notTakenKind` separates the two reasons a photograph was never made,
   * because they are not the same claim. `already-photographed` names a file
   * that already holds that size; `native-max-canvas` names nothing, because
   * nothing was ever encoded at that size — counting them together let the
   * summary promise a file that does not exist.
   */
  duplicates: {
    path: ProbeCapture["path"];
    sameAsSlug: string;
    shapeId: string;
    reason: string;
    taken: boolean;
    notTakenKind?: "already-photographed" | "native-max-canvas";
  }[];
  /**
   * Why no photograph was taken at this step, on the rows where the two-per-
   * camera policy is the reason.
   *
   * Set on every row that was never going to produce a picture, so a reader
   * never has to deduce it from an empty capture list. It is a statement about
   * this app's policy, never about the camera: the request on the row ran in
   * full and its granted settings are complete.
   */
  stillNote?: string;
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

/**
 * A step that never ran because its camera reached its share of the run's time.
 *
 * Kept apart from `rows` on purpose. A row is a request that was made; this is a
 * request that was not. Filing these as rows with `ok: false` would put them in
 * the same column as `OverconstrainedError` — which is a camera stating a real
 * limit — and every count of refusals in the archive would be wrong.
 */
export type UntriedStep = {
  deviceId: string;
  deviceLabel: string;
  /** `impossible` covers the impossible round, whose answers are not matrix rows. */
  kind: MatrixRow["kind"] | "impossible";
  asked: string;
  reason: string;
};

export type CameraMatrixReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inventory: CameraDeviceInfo[];
  rows: MatrixRow[];
  /** Steps a camera never reached, by name. Never counted as refusals. */
  untried: UntriedStep[];
  /** What each camera spent, and whether it ran out of its share. */
  cameraCosts: CameraCost[];
  /** The single longest request in the sweep, measured against the camera deadline. */
  slowestStep: { label: string; ms: number } | null;
  /** The per-camera ceiling this run used, or null when there were no cameras to share it out between. */
  perCameraBudgetMs: number | null;
  /** Steps at which a still was deliberately taken. */
  stillPolicy: string;
  /**
   * The impossible round: every ask designed to be unanswerable, and what came
   * back. Kept apart from `rows` because these are not measurements of a
   * camera's range — they are measurements of how it refuses.
   */
  impossible: ImpossibleAnswer[];
  /** Places where those answers disagree with each other. Observations, never verdicts. */
  impossibleObservations: string[];
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

/**
 * `totalIsExact` is false while any camera's plan is still unread. The bar used
 * to be drawn from a fixed guess that left the control steps out altogether, so
 * it filled up and then sat at the end through roughly a third of each camera;
 * the total is now the real plan, and the flag says when it can be trusted.
 */
export type MatrixProgress = (message: string, done: number, total: number, totalIsExact?: boolean) => void;

/**
 * The resolution ladder, largest first.
 *
 * Four rungs, not seven. 8K went because no phone camera has ever granted it,
 * and the native-maximum row already asks for the ceiling with `ideal`, so an
 * exact 8K ask was one guaranteed rejection per camera recorded a second time.
 * 1440p sits between two rungs that are both still here and resolved to one of
 * them on every device seen. QVGA went because VGA already probes the bottom,
 * and a camera that clamps 320 up clamps 640 up the same way.
 *
 * This is the widest set anything might be asked for. Each camera is only asked
 * the part of it that its own advertised ceiling makes a real question — see
 * `planFor`.
 */
const LADDER: { w: number; h: number; name: string }[] = [
  { w: 3840, h: 2160, name: "4K UHD" },
  { w: 1920, h: 1080, name: "1080p" },
  { w: 1280, h: 720, name: "720p" },
  { w: 640, h: 480, name: "VGA" },
];

/**
 * Three ratios, not six. 4:3 is the sensor's own shape on nearly every phone,
 * 16:9 is what video asks for, and 1:1 is the one that forces a crop. 3:2
 * landed on one of the first two every time; 9:16 is 16:9 turned round, which
 * the one portrait ask covers; and 21:9 is a cinema shape no phone sensor has.
 */
const ASPECTS: { ratio: number; name: string }[] = [
  { ratio: 4 / 3, name: "4:3" },
  { ratio: 16 / 9, name: "16:9" },
  { ratio: 1, name: "1:1" },
];

/**
 * 24 fps went: it sits between 15 and 30, and every camera that granted it
 * granted 30 as well. What is left is filtered per camera against the range the
 * camera itself advertises, plus exactly one ask above that ceiling.
 */
const FRAME_RATES: number[] = [15, 30, 60, 120];

const STILL_POLICY =
  "TWO photographs per camera, and no more. One at the native maximum down the browser's own photo pipeline, and one at the smallest resolution rung that camera accepts, down the path THIS APP encodes from the video track. Those two are opposites — one may carry platform metadata and quantisation tables the camera itself wrote, the other carries none by construction — which is the entire reason for having both, and is also why a third and fourth photograph of the same scene at a different size add nothing. Every other step in the sweep is still ASKED and still recorded in full: what was requested, what came back, how long it took and whether they match. It simply does not produce a picture, and each of those rows says so in its own words rather than leaving an empty list to be interpreted. A still that WAS taken is kept only when its byte shape is new for that camera and that path; one repeating a shape already held is recorded on its row and dropped. So an empty capture list on a row means one of three stated things — no photograph was ever going to be taken there, the granted size had already been photographed on that path, or the file repeated a shape already held — and never that the camera failed. The time this saves is spent on the impossible round instead, which is the part of a camera's behaviour that is hardest to imitate.";

/** Said on every row that was never going to produce a photograph. */
const NO_STILL_PREFIX =
  "No photograph was taken at this step. Each camera in this run is photographed exactly twice — its native maximum down the browser's own photo pipeline, and its smallest rung down the path this app encodes — and this step is neither of those.";

/**
 * Why a control row carries no photograph, said in that row's own terms.
 *
 * Control rows never produced stills, but they used to say nothing about it,
 * which left the reason to be deduced from an empty capture list — the one
 * thing the two-per-camera policy exists to stop. Every row in the sweep now
 * states it.
 */
function controlStillNote(kind: MatrixRow["kind"]): string {
  switch (kind) {
    case "zoom":
      return `${NO_STILL_PREFIX} A zoom row records whether the number moved when it was asked to, which is read back from the track itself. The photograph of a zoomed frame is taken by hand instead, and only on a camera this sweep actually watched move.`;
    case "torch":
      return `${NO_STILL_PREFIX} The flash is fired once in the whole run, and what it changes is the room rather than the file. This row records whether the constraint was accepted.`;
    case "focus":
    case "exposure":
    case "white-balance":
      return `${NO_STILL_PREFIX} A mode applied to a running track is answered by what the track says about itself afterwards, which is on this row in full. A picture of the scene in front of you would not say whether the mode was granted.`;
    default:
      return `${NO_STILL_PREFIX} This row applies a setting to a track that is already open and records what came back — a measurement of the answer, not a picture of it.`;
  }
}

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

/**
 * Which of the two photographs this step is responsible for, if either.
 *
 * `platform-native-max` is the browser's own photo pipeline at the camera's
 * ceiling. `canvas-small` is a frame this app encodes at the smallest rung the
 * camera accepts. `none` is every other step in the sweep, and carries the
 * sentence that will be written onto its row.
 */
export type StepStill = "platform-native-max" | "canvas-small" | "none";

export type StepPlan = {
  kind: MatrixRow["kind"];
  asked: string;
  constraints: MediaTrackConstraints;
  still: StepStill;
  /** Why this step takes no photograph. Always set when `still` is `none`. */
  stillNote?: string;
};

/** What one camera says its own limits are, read off the track it opened first. */
export type CameraCeiling = {
  maxWidth: number | null;
  maxHeight: number | null;
  maxFrameRate: number | null;
  aspectRange: { min: number; max: number } | null;
};

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Reads the ceiling out of `getCapabilities()`.
 *
 * Every field is optional and every one of them is missing on some browser, so
 * an absent figure becomes `null` and means "this camera did not say" — which
 * the plan treats as permission to ask, never as a limit.
 */
export function ceilingFrom(caps: MediaTrackCapabilities | null): CameraCeiling {
  if (!caps) return { maxWidth: null, maxHeight: null, maxFrameRate: null, aspectRange: null };
  const ext = caps as MediaTrackCapabilities & {
    width?: { max?: number };
    height?: { max?: number };
    frameRate?: { max?: number };
    aspectRatio?: { min?: number; max?: number };
  };
  const arMin = numberOr(ext.aspectRatio?.min);
  const arMax = numberOr(ext.aspectRatio?.max);
  return {
    maxWidth: numberOr(ext.width?.max),
    maxHeight: numberOr(ext.height?.max),
    maxFrameRate: numberOr(ext.frameRate?.max),
    aspectRange: arMin != null && arMax != null && arMax >= arMin ? { min: arMin, max: arMax } : null,
  };
}

/** The one step every camera gets first: it returns the ceiling the rest of the plan is built from. */
export function nativeMaxStep(deviceId: string): StepPlan {
  return {
    kind: "native-max",
    asked: "native maximum (8K ideal, no other constraint)",
    constraints: { deviceId: { exact: deviceId }, width: { ideal: 7680 }, height: { ideal: 4320 } } as MediaTrackConstraints,
    still: "platform-native-max",
  };
}

/**
 * Builds the constraint variations for one camera, from what that camera has
 * already said about itself.
 *
 * The sweep used to send an identical 28-step plan to every camera, which meant
 * asking a 720p-capable front camera for 8K, 4K and 1440p, and asking a 30 fps
 * sensor for 60 and 120 — questions whose answers the camera had already given
 * in `getCapabilities()` before the first one was sent. Those rows are not
 * dropped for being uninteresting; they are dropped because the camera answered
 * them already, and asking anyway costs a camera open each.
 *
 * One over-ask survives in each direction, deliberately. Whether a camera
 * CLAMPS to its ceiling or REFUSES outright is a real difference between
 * platforms and cannot be read from the capability object, so exactly one rung
 * above the ceiling and one frame rate above it are still asked. The rungs
 * beyond that would each answer the same way.
 *
 * Order stays coarse-to-fine so an early stop still leaves the useful rows.
 */
export function planFor(deviceId: string, ceiling: CameraCeiling): { steps: StepPlan[]; notes: string[] } {
  const pin = { deviceId: { exact: deviceId } } as MediaTrackConstraints;
  const steps: StepPlan[] = [];
  const notes: string[] = [];

  const fits = (rung: { w: number; h: number }): boolean =>
    (ceiling.maxWidth == null || rung.w <= ceiling.maxWidth) && (ceiling.maxHeight == null || rung.h <= ceiling.maxHeight);

  const within = LADDER.filter(fits);
  const above = LADDER.filter((rung) => !fits(rung));
  // LADDER runs largest first, so the last entry above the ceiling is the one
  // nearest to it — the only over-ask worth a camera open.
  const overAsk = above.length > 0 ? above[above.length - 1] : null;
  if (above.length > 1 && overAsk) {
    notes.push(
      `this camera advertises a ceiling of ${ceiling.maxWidth ?? "?"}×${ceiling.maxHeight ?? "?"}, so ${above.length - 1} rung(s) above it were not asked for. ` +
        `${overAsk.name} was still asked, one rung over the top, because whether a camera clamps to its ceiling or refuses outright is a real difference and cannot be read from the capability object. ` +
        `The rungs beyond it would each answer the same way, and each one costs a camera open. Nothing here is a claim about what they would have returned.`
    );
  }

  // The one canvas frame this camera contributes is taken at the SMALLEST rung
  // it accepts. Small on purpose: the file is one this app encoded rather than
  // anything the camera wrote, so its value is as a specimen of this browser's
  // encoder, and a specimen does not need to be four megabytes.
  const smallest = within.length > 0 ? within[within.length - 1] : null;

  for (const rung of overAsk ? [overAsk, ...within] : within) {
    const isCanvasRung = rung === smallest;
    steps.push({
      kind: "resolution",
      asked:
        rung === overAsk
          ? `${rung.name} landscape — exactly ${rung.w}×${rung.h} (one rung above the ceiling this camera advertised: does it clamp or refuse?)`
          : `${rung.name} landscape — exactly ${rung.w}×${rung.h}`,
      constraints: { ...pin, width: { exact: rung.w }, height: { exact: rung.h } },
      still: isCanvasRung ? "canvas-small" : "none",
      stillNote: isCanvasRung
        ? undefined
        : `${NO_STILL_PREFIX} It is a measurement of what this camera granted, not a picture of it: the request ran in full and the granted settings on this row are complete.`,
    });
  }

  // One portrait ask, not one per rung. Whether a camera accepts a
  // taller-than-wide request is one question about the camera, and it was being
  // asked six more times at sizes that only re-tested the ladder. 720p is used
  // where it fits, because it is modest enough that a refusal means "not
  // portrait" rather than "not that big".
  const portrait = within.find((rung) => rung.name === "720p") ?? within[within.length - 1] ?? null;
  if (portrait) {
    steps.push({
      kind: "resolution",
      asked: `${portrait.name} portrait — exactly ${portrait.h}×${portrait.w} (the one portrait ask)`,
      constraints: { ...pin, width: { exact: portrait.h }, height: { exact: portrait.w } },
      still: "none",
      stillNote: `${NO_STILL_PREFIX} A portrait ask turns the track on its side; it does not change the pipeline that would photograph it, which the two photographs already show.`,
    });
  }

  for (const aspect of ASPECTS) {
    const range = ceiling.aspectRange;
    if (range && (aspect.ratio < range.min - 0.001 || aspect.ratio > range.max + 0.001)) {
      notes.push(
        `${aspect.name} lies outside the aspect-ratio range this camera advertised (${range.min}–${range.max}), so it was not asked for. That is the camera's own statement about itself, not an assumption about it.`
      );
      continue;
    }
    steps.push({
      kind: "aspect-ratio",
      asked: `aspect ratio ${aspect.name} (exact ${Math.round(aspect.ratio * 10000) / 10000})`,
      constraints: { ...pin, aspectRatio: { exact: Math.round(aspect.ratio * 10000) / 10000 } },
      still: "none",
      stillNote: `${NO_STILL_PREFIX} A ratio ask is answered by the size the track reports back, which is on this row; photographing it would produce the same encoder's output at a different crop.`,
    });
  }

  const maxFps = ceiling.maxFrameRate;
  const fpsWithin = FRAME_RATES.filter((fps) => maxFps == null || fps <= maxFps);
  const fpsAbove = FRAME_RATES.filter((fps) => maxFps != null && fps > maxFps);
  // FRAME_RATES runs ascending, so the first above the ceiling is the nearest.
  const fpsOverAsk = fpsAbove.length > 0 ? fpsAbove[0] : null;
  if (fpsAbove.length > 1 && fpsOverAsk != null) {
    notes.push(
      `this camera advertises a maximum of ${maxFps} fps, so ${fpsAbove.length - 1} higher rate(s) were not asked for. ${fpsOverAsk} fps was still asked, one step over, for the same clamp-or-refuse reason as the resolution ladder.`
    );
  }
  for (const fps of fpsOverAsk != null ? [...fpsWithin, fpsOverAsk] : fpsWithin) {
    steps.push({
      kind: "frame-rate",
      asked: fps === fpsOverAsk ? `exactly ${fps} fps (above the rate this camera advertised)` : `exactly ${fps} fps`,
      constraints: { ...pin, frameRate: { exact: fps } },
      still: "none",
      stillNote: `${NO_STILL_PREFIX} A frame rate changes how the track behaves over time, not what a single photograph of it looks like.`,
    });
  }

  return { steps, notes };
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

type ControlCaps = MediaTrackCapabilities & {
  focusMode?: string[];
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  resizeMode?: string[];
  zoom?: { min?: number; max?: number };
  torch?: boolean;
};

/** True when this camera claims a torch, which is the only claim worth checking twice. */
function torchAdvertised(caps: MediaTrackCapabilities | null): boolean {
  return (caps as ControlCaps | null)?.torch === true;
}

/**
 * The control surface a camera advertises, reduced to a comparable string.
 *
 * Used to notice when a second camera lists exactly the same modes, ranges and
 * flags as one already swept. It is a statement about what was ADVERTISED and
 * nothing more — see the note the sweep writes when it acts on this.
 */
function controlSignature(caps: MediaTrackCapabilities | null): string | null {
  if (!caps) return null;
  const ext = caps as ControlCaps;
  const parts = [
    (ext.focusMode ?? []).join(","),
    (ext.exposureMode ?? []).join(","),
    (ext.whiteBalanceMode ?? []).join(","),
    (ext.resizeMode ?? []).join(","),
    ext.zoom?.min != null && ext.zoom.max != null ? `${ext.zoom.min}-${ext.zoom.max}` : "",
    ext.torch === true ? "torch" : "",
  ];
  return parts.every((part) => part === "") ? null : parts.join("|");
}

/**
 * The zoom steps for one camera, on their own.
 *
 * Separated out because zoom is the one control that is never skipped. When a
 * camera advertises the same control surface as an earlier one, the rest of its
 * block is left unwalked as a repeat — but the hand-shot stage READS the zoom
 * rows to decide whether to ask for a zoom photograph, and a camera with no
 * zoom rows was being written up as a camera that showed no zoom range. It
 * showed nothing, because nothing was asked. Two lenses that describe
 * themselves identically are also exactly the pair whose zoom behaviour is most
 * worth having separately, so these rows run on every camera.
 */
export function zoomStepsFor(caps: MediaTrackCapabilities | null): ControlStep[] {
  const ext = caps as ControlCaps | null;
  const range = ext?.zoom;
  if (range?.min == null || range.max == null || range.max <= range.min) return [];
  return [
    { kind: "zoom", asked: `zoom at minimum (${range.min})`, constraints: advanced({ zoom: range.min }) },
    { kind: "zoom", asked: `zoom at maximum (${range.max})`, constraints: advanced({ zoom: range.max }) },
  ];
}

/**
 * Builds the control steps for one camera.
 *
 * `allowTorch` is false once the flash has already been fired somewhere in this
 * run. Every rear camera on a phone drives the same physical LED, so firing it
 * on each of them is one demonstration repeated into the user's face — and the
 * second camera to claim a torch is claiming the first camera's torch.
 */
export function controlStepsFor(caps: MediaTrackCapabilities | null, allowTorch: boolean): ControlStep[] {
  if (!caps) return [];
  const ext = caps as ControlCaps;
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
  steps.push(...zoomStepsFor(caps));
  if (ext.torch === true && allowTorch) {
    steps.push({ kind: "torch", asked: "torch on", constraints: advanced({ torch: true }) });
    steps.push({ kind: "torch", asked: "torch off", constraints: advanced({ torch: false }) });
  }
  return steps;
}

/**
 * True when this camera advertises no control of any kind.
 *
 * Distinct from "nothing was asked of it": a camera whose only control is a
 * torch that has already been fired elsewhere has an empty step list and is NOT
 * a camera without controls. Saying so put two contradictory lines next to each
 * other in the notes — one explaining why the flash was not fired again, and one
 * claiming there was no flash to fire.
 */
function advertisesNoControls(caps: MediaTrackCapabilities | null): boolean {
  return controlStepsFor(caps, true).length === 0;
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

  // The impossible round's answers, and the ids of the asks that are the same
  // question on every camera and so are only sent once in the whole run.
  const impossible: ImpossibleAnswer[] = [];
  const impossibleSeen = new Set<string>();

  // Sizes already photographed, keyed by camera, path and granted size. This is
  // the cheaper half of the same idea as the ledger: the ledger compares bytes
  // AFTER a photograph has been taken, and this stops the photograph being
  // taken at all when the step has been granted a size the camera has already
  // been photographed at on that path. A resolution rung and an aspect ratio
  // that both land on 1920×1080 are one photograph, and the second round trip
  // through ImageCapture and the canvas is time and memory spent on a file that
  // would have been dropped on arrival.
  const photographedSizes = new Map<string, string>();

  // The flash is fired once per run, on the first camera that claims one.
  let torchFiredOn: string | null = null;

  // Advertised control surfaces already walked, so the second camera listing an
  // identical set does not repeat the whole block.
  const controlSurfaces = new Map<string, string>();

  /**
   * Offers a still to the ledger. Kept stills consume a slug and are recorded;
   * repeats are written onto the row and dropped without ever being counted as
   * photographs taken.
   */
  const offer = async (
    build: (slug: string) => ProbeCapture,
    row: { captureSlugs: string[]; duplicates: MatrixRow["duplicates"] },
    prefix: string,
    sizeKey: string | null
  ): Promise<void> => {
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
      row.duplicates.push({ path: capture.path, sameAsSlug: verdict.repeat.sameAsSlug, shapeId: verdict.shape.id, reason: verdict.repeat.reason, taken: true });
      // The size is remembered against the file it matched, so the next step
      // that lands on it does not repeat the round trip either.
      if (sizeKey) photographedSizes.set(sizeKey, verdict.repeat.sameAsSlug);
      return;
    }
    if (sizeKey) photographedSizes.set(sizeKey, capture.slug);
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
        untried: [],
        cameraCosts: [],
        slowestStep: null,
        perCameraBudgetMs: null,
        stillPolicy: STILL_POLICY,
        impossible: [],
        impossibleObservations: [],
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

  notes.push(
    "The plan sent to each camera is built from what that camera advertised on the first open, not from one fixed list. Resolution rungs above the ceiling it stated, frame rates above the rate it stated, " +
      "and aspect ratios outside the range it stated are not asked for — the camera answered those in getCapabilities() before the first request was sent, and asking anyway costs one camera open each. " +
      "Exactly one rung and one frame rate ABOVE the ceiling are still asked, because whether a camera clamps or refuses is a real difference that the capability object does not contain. Portrait is asked once " +
      "per camera rather than once per rung. Where any of this shortened a camera's plan, the camera's own figures are quoted in a note beside it."
  );

  // The progress total is the REAL plan, not a guess. Each camera contributes
  // an exact step count — rungs, ratios, frame rates AND control steps — the
  // moment it has stated its limits on the first open. Cameras not yet reached
  // contribute a placeholder that is REPLACED rather than added to, and until
  // every camera has been planned the total is flagged inexact so the page can
  // say so instead of implying a precision it does not have.
  const PLACEHOLDER_STEPS_PER_CAMERA = LADDER.length + ASPECTS.length + FRAME_RATES.length + 10;
  let plannedCameras = 0;
  let knownSteps = 0;
  const totalNow = (): number => Math.max(1, knownSteps + Math.max(0, inventory.length - plannedCameras) * PLACEHOLDER_STEPS_PER_CAMERA);
  const totalIsExact = (): boolean => plannedCameras >= inventory.length;
  let done = 0;
  const report = (message: string): void => options.onProgress(message, done, Math.max(totalNow(), done), totalIsExact());

  // Every camera gets a share of the run's time. Generous on purpose: this is
  // not a performance target, it is a stop on the one camera that takes fifteen
  // seconds to open and would otherwise consume the whole run on its own.
  const perCameraBudgetMs = inventory.length > 0 ? cameraBudgetMs(inventory.length) : null;
  const stepTimer = createStepTimer();
  const cameraCosts: CameraCost[] = [];
  const untried: UntriedStep[] = [];

  for (const device of inventory) {
    await options.waitWhilePaused?.();
    if (options.shouldAbort()) {
      aborted = true;
      break;
    }
    const name = device.label || `camera ${device.deviceId.slice(0, 8)}`;
    let capabilities: MediaTrackCapabilities | null = null;
    const cameraStart = performance.now();
    let cameraSteps = 0;
    let cameraUntried = 0;
    let hitBudget = false;
    let impossibleDone = false;
    const outOfTime = (): boolean => perCameraBudgetMs != null && performance.now() - cameraStart >= perCameraBudgetMs;

    /**
     * Records the steps this camera never reached. UNTRIED is its own word:
     * these are not refusals, not limits the camera stated and not timeouts,
     * and they are kept out of `rows` so no count of refusals can pick them up.
     */
    const leaveUntried = (steps: { kind: UntriedStep["kind"]; asked: string }[], reason: string): void => {
      for (const step of steps) {
        untried.push({ deviceId: device.deviceId, deviceLabel: name, kind: step.kind, asked: step.asked, reason });
        cameraUntried += 1;
        // The plan total shrinks with them, so the bar reflects what will
        // actually run rather than stalling short of the end.
        knownSteps = Math.max(done, knownSteps - 1);
      }
    };

    // The plan starts as one step — the native maximum — and the rest is
    // appended once that step has read the camera's capabilities. Extending the
    // array the loop is walking is deliberate: it keeps one body for every step
    // and keeps the plan honest, since it is built from a reading rather than
    // from an assumption about what this camera can do.
    let plan: StepPlan[] = [nativeMaxStep(device.deviceId)];
    let planned = false;
    let controlEstimate = 0;
    let impossibleEstimate = 0;
    const impossibleTarget = (): ImpossibleTarget => ({
      deviceId: device.deviceId,
      facingMode: device.facing === "front" ? "user" : device.facing === "back" ? "environment" : null,
      label: name,
      capabilities,
    });
    const extendPlan = (): void => {
      if (planned) return;
      planned = true;
      const built = planFor(device.deviceId, ceilingFrom(capabilities));
      plan = plan.concat(built.steps);
      // The plan is now known exactly for this camera, control steps included.
      // Leaving those out was why the bar used to fill up and then sit at the
      // end through roughly a third of every camera.
      controlEstimate = controlStepsFor(capabilities, torchFiredOn == null).length;
      impossibleEstimate = impossibleAsksFor(impossibleTarget(), "full").length;
      knownSteps += 1 + built.steps.length + controlEstimate + impossibleEstimate;
      plannedCameras += 1;
      for (const note of built.notes) notes.push(`${name}: ${note}`);
      if (!capabilities) {
        notes.push(
          `${name}: no capability object could be read on the first open, so nothing was trimmed from this camera's plan — every rung, ratio and frame rate was asked for. An unreadable ceiling is treated as permission to ask, never as a limit.`
        );
      }
    };

    for (let index = 0; index < plan.length; index += 1) {
      const step = plan[index];
      await options.waitWhilePaused?.();
      if (options.shouldAbort()) {
        aborted = true;
        break;
      }
      if (outOfTime()) {
        hitBudget = true;
        leaveUntried(plan.slice(index), budgetReachedText(name, perCameraBudgetMs ?? 0, plan.length - index));
        break;
      }
      done += 1;
      cameraSteps += 1;
      report(`${name} — ${step.asked}`);

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
        // A camera that could not open on its first step still needs a plan, or
        // the whole camera would silently vanish from the sweep.
        extendPlan();
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

      // What this step was actually GRANTED decides whether a photograph here
      // would be a new one. Two different asks answered with the same size are
      // the same picture of the same scene, and the second is not taken.
      const grantedSize = settings?.width != null && settings.height != null ? `${settings.width}×${settings.height}` : null;
      const sizeKeyFor = (path: ProbeCapture["path"]): string | null => (grantedSize ? `${device.deviceId}|${path}|${grantedSize}` : null);
      const alreadyShot = (path: ProbeCapture["path"]): string | null => {
        const key = sizeKeyFor(path);
        return key ? photographedSizes.get(key) ?? null : null;
      };

      if (step.still !== "none" && track && stillsAllowed()) {
        const priorPlatform = step.still === "platform-native-max" ? alreadyShot("image-capture") : null;
        const priorCanvas = step.still === "canvas-small" ? alreadyShot("canvas") : null;
        const video = await attachVideo(stream);
        if (video) videoDims = { width: video.videoWidth, height: video.videoHeight };

        if (step.still !== "platform-native-max") {
          // Nothing to say here: the platform photograph belongs to the native
          // maximum, which is a different row on this same camera.
        } else if (priorPlatform != null) {
          stepRow.duplicates.push({
            path: "image-capture",
            sameAsSlug: priorPlatform,
            shapeId: "(no file — none was taken)",
            taken: false,
            notTakenKind: "already-photographed",
            reason: `This camera had already been photographed at ${grantedSize} down the platform photo pipeline, and this request was granted that same size, so no second photograph was taken. The request itself ran and its granted settings are on this row; what was skipped is a file that would have been the same picture at the same size.`,
          });
        } else {
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
              "platform",
              sizeKeyFor("image-capture")
            );
          }
        }

        if (step.still === "platform-native-max") {
          stepRow.duplicates.push({
            path: "canvas",
            sameAsSlug: "",
            shapeId: "(no file — none was taken)",
            taken: false,
            notTakenKind: "native-max-canvas",
            reason: `No canvas frame was encoded at the native maximum, and no earlier file holds this size either — nothing in this run was ever encoded at it. At this size that file is several megabytes THIS APP would have produced from the video track rather than anything the camera made, and the one canvas frame this camera contributes is taken at its smallest rung instead, where the same encoder is visible for a fraction of the memory.`,
          });
        } else if (priorCanvas != null) {
          stepRow.duplicates.push({
            path: "canvas",
            sameAsSlug: priorCanvas,
            shapeId: "(no file — none was taken)",
            taken: false,
            notTakenKind: "already-photographed",
            reason: `This camera had already been photographed at ${grantedSize} down the canvas path, and this request was granted that same size, so no second frame was encoded.`,
          });
        } else if (video) {
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
              "canvas",
              sizeKeyFor("canvas")
            );
          }
        }
        if (video) detachVideo(video);
      } else if ((step.still !== "none" || step.kind === "native-max") && track) {
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
        stillNote: step.stillNote,
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
      stepTimer.recordLabelled(`${name} — ${step.asked}`, performance.now() - stepStart);

      // The impossible round runs HERE, immediately after the camera has
      // stated its own limits and before the ladder — first because "beyond
      // the limit it just published" needs that reading to mean anything, and
      // second because a camera that runs out of its share of the run's time
      // should lose the near-identical size rows rather than the round that is
      // hardest to imitate.
      if (step.kind === "native-max" && !impossibleDone) {
        impossibleDone = true;
        extendPlan();
        const answers = await runImpossibleRound(impossibleTarget(), {
          scope: "full",
          askedOnce: impossibleSeen,
          shouldAbort: options.shouldAbort,
          waitWhilePaused: options.waitWhilePaused,
          outOfTime,
          onLate: noteLate,
          onNote: (note) => notes.push(note),
          onUntried: (asks, reason) => {
            hitBudget = hitBudget || outOfTime();
            leaveUntried(
              asks.map((ask) => ({ kind: "impossible" as const, asked: ask.asked })),
              reason
            );
          },
          onProgress: (message) => {
            done += 1;
            cameraSteps += 1;
            report(message);
          },
        });
        impossible.push(...answers);
        if (options.shouldAbort()) {
          aborted = true;
          break;
        }
      }
    }

    if (aborted) {
      cameraCosts.push({ label: name, ms: Math.round(performance.now() - cameraStart), steps: cameraSteps, untried: cameraUntried, hitBudget });
      break;
    }

    // Control modes need one open track they can be applied to in sequence.
    const signature = controlSignature(capabilities);
    const walkedOn = signature ? controlSurfaces.get(signature) : undefined;
    // Zoom is exempt from the repeat rule. The hand-shot stage reads the zoom
    // rows to decide whether to ask for a zoom photograph, so a camera with no
    // zoom rows was being written up as one that showed no zoom range — a
    // statement about a question nobody asked it.
    const zoomOnly = zoomStepsFor(capabilities);
    const controls = walkedOn ? zoomOnly : controlStepsFor(capabilities, torchFiredOn == null);
    const torchHeldBack = torchAdvertised(capabilities) && torchFiredOn != null;
    if (torchHeldBack && !walkedOn) {
      notes.push(
        `${name}: advertises a torch, and the flash was not fired again. It was fired once already, on ${torchFiredOn}, and that row is above. Every rear camera on a phone drives the same physical LED, so a second firing is one demonstration repeated into the room — the torch rows for this camera are absent for that reason and for no other. Nothing is claimed here about whether this camera's torch constraint would have been granted.`
      );
    }
    if (walkedOn && signature) {
      notes.push(
        `${name}: advertises exactly the same control surface as ${walkedOn} — the same focus, exposure, white-balance and resize lists, the same zoom range and the same torch flag — so the focus, exposure, white-balance, resize and torch rows were not walked a second time. They were walked once, on ${walkedOn}, and those rows are above. ` +
          `The ZOOM rows are the exception and were walked here in full: zoom is the one control that genuinely differs lens to lens, two lenses that describe themselves identically are exactly the pair worth measuring separately, and the hand-shot stage reads these rows to decide what to ask you for. ` +
          `The rest is a decision about where the run spends its time, NOT a claim that this camera would have answered the same way: nothing about its focus, exposure, white-balance, resize or torch behaviour beyond the surface it advertises was recorded, and that absence is stated here rather than filled in.`
      );
    } else if (controls.length === 0 && advertisesNoControls(capabilities)) {
      notes.push(
        capabilities
          ? `${name}: the platform advertised no focus, exposure, white-balance, resize, zoom or torch controls, so there was nothing to apply.`
          : `${name}: no capability object could be read for this camera, so no control was asked of it. Nothing here is a statement that the camera has no controls — it is a statement that this browser did not say, and no zoom range was read either, so the hand-shot stage treats its zoom as unknown rather than as absent.`
      );
    }
    if (controls.length > 0) {
      if (signature && !walkedOn) controlSurfaces.set(signature, name);
      let stream: MediaStream | null = null;
      try {
        stream = await openMediaWithDeadline({ audio: false, video: { deviceId: { exact: device.deviceId } } }, { what: `${name} (control-mode reopen)`, onLate: noteLate });
      } catch (err) {
        if (isCameraTimeout(err)) timeouts += 1;
        notes.push(`${name}: could not reopen for control-mode testing (${errorName(err)}).`);
      }
      const track = stream?.getVideoTracks()[0] ?? null;
      // The plan was costed with the estimate taken at extendPlan time; the
      // real list is known now, so the total is corrected rather than left to
      // drift.
      knownSteps += controls.length - controlEstimate;
      for (const [controlIndex, control] of controls.entries()) {
        await options.waitWhilePaused?.();
        if (options.shouldAbort()) {
          aborted = true;
          break;
        }
        if (outOfTime()) {
          hitBudget = true;
          leaveUntried(controls.slice(controlIndex), budgetReachedText(name, perCameraBudgetMs ?? 0, controls.length - controlIndex));
          break;
        }
        done += 1;
        cameraSteps += 1;
        report(`${name} — ${control.asked}`);
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
            stillNote: controlStillNote(control.kind),
          });
          continue;
        }
        try {
          await track.applyConstraints(control.constraints);
          const after = track.getSettings?.() ?? null;
          // The flash counts as fired only here, once the constraint has
          // actually been applied. Marking it before the attempt meant a camera
          // that failed to reopen still told every later camera the flash "was
          // fired already, and that row is above" — pointing at a row that
          // failed, or at no row at all.
          if (control.kind === "torch" && control.asked === "torch on" && torchFiredOn == null) torchFiredOn = name;
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
            stillNote: controlStillNote(control.kind),
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
            stillNote: controlStillNote(control.kind),
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

    if (hitBudget) notes.push(budgetReachedText(name, perCameraBudgetMs ?? 0, cameraUntried));
    cameraCosts.push({ label: name, ms: Math.round(performance.now() - cameraStart), steps: cameraSteps, untried: cameraUntried, hitBudget });
  }

  if (aborted) notes.push("You stopped the sweep before it finished. Every row above really ran; the rows that never ran are simply absent, and the archive is marked partial.");
  if (ledger.droppedCount() > 0) {
    notes.push(
      `${ledger.droppedCount()} of ${stillsTaken} still(s) repeated a byte shape already held for the same camera and the same path, and were not kept — saving ${(ledger.bytesSaved() / 1024 / 1024).toFixed(1)} MB. ` +
        `Each one is named on its own row with the file it matched. Those requests all succeeded; nothing here is a camera failing, and nothing that was dropped is counted as a photograph taken.`
    );
  }
  // Counted apart, because they are not the same claim. One names a file that
  // already holds the size; the other names nothing at all, and counting them
  // together promised a file that does not exist.
  const countNotTaken = (kind: "already-photographed" | "native-max-canvas"): number =>
    rows.reduce((sum, row) => sum + row.duplicates.filter((duplicate) => !duplicate.taken && duplicate.notTakenKind === kind).length, 0);
  const notTakenRepeat = countNotTaken("already-photographed");
  const notTakenNativeMax = countNotTaken("native-max-canvas");
  if (notTakenRepeat > 0) {
    notes.push(
      `${notTakenRepeat} photograph(s) were never taken, on rows where the camera had already been photographed at the size that row was granted. Those rows say so individually, and each one names the file that already holds that size. ` +
        `This is the cheaper half of the same rule as the shapes above: the ledger compares bytes after a photograph exists, and this stops the photograph being made when the size is already answered. Every one of those requests still ran and every asked-versus-granted row is complete.`
    );
  }
  if (notTakenNativeMax > 0) {
    notes.push(
      `${notTakenNativeMax} canvas frame(s) were never encoded at a camera's native maximum, which is a different reason from the one above and names no file: nothing in this run holds that size, because nothing was ever encoded at it. ` +
        `A canvas frame at a 4K-and-above native maximum is several megabytes THIS APP would have produced from the video track rather than anything the camera made, and the canvas path is exercised at every smaller rung on the same camera. The platform photo pipeline still ran at the native maximum, so those rows are not empty.`
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
      untried,
      cameraCosts,
      slowestStep: stepTimer.slowest(),
      perCameraBudgetMs,
      stillPolicy: STILL_POLICY,
      impossible,
      impossibleObservations: impossibleObservations(impossible),
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
      if (row.stillNote) lines.push(...wrap(row.stillNote, 62).map((line) => `             ${line}`));
      for (const duplicate of row.duplicates) {
        if (duplicate.taken) {
          lines.push(`             repeat: a ${duplicate.path} still was taken here and matched ${duplicate.sameAsSlug} exactly (shape ${duplicate.shapeId}), so it was not kept.`);
        } else {
          lines.push(
            `             not taken: no ${duplicate.path} still was made at this step${duplicate.sameAsSlug ? ` — that size was already photographed as ${duplicate.sameAsSlug}` : ""}.`,
            `                        ${duplicate.reason}`
          );
        }
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

  if (report.untried.length > 0) {
    lines.push(
      "",
      "=".repeat(78),
      `UNTRIED (${report.untried.length})`,
      "=".repeat(78),
      "",
      "Requests that were never made, because their camera reached its share of the run's time first.",
      "",
      "UNTRIED is its own word here and means exactly one thing: this was not asked. It is NOT a refusal",
      "(the camera never got the chance to state a limit), NOT a timeout (nothing was waited on), and NOT a",
      "capability claim of any kind. Those three exist separately above and mean different things. Nothing",
      "whatsoever is inferred about what any of these would have returned.",
      ""
    );
    const byCamera = new Map<string, UntriedStep[]>();
    for (const step of report.untried) {
      const list = byCamera.get(step.deviceLabel) ?? [];
      list.push(step);
      byCamera.set(step.deviceLabel, list);
    }
    for (const [camera, steps] of byCamera) {
      lines.push(`  ${camera} — ${steps.length} untried`, `      ${steps[0].reason}`, "");
      for (const step of steps) lines.push(`      · [${step.kind}] ${step.asked}`);
      lines.push("");
    }
  }

  if (report.cameraCosts.length > 0) {
    lines.push(
      "",
      "=".repeat(78),
      "WHAT THE SWEEP COST, PER CAMERA",
      "=".repeat(78),
      "",
      "Wall clock readings from this run on this phone. A slow camera is not a fault — it is one of the more",
      "useful facts in this archive, and it is measured rather than assumed.",
      ""
    );
    for (const cost of report.cameraCosts) {
      lines.push(
        `  ${cost.label}`,
        `      ${formatDuration(cost.ms)} across ${cost.steps} request(s)` +
          (cost.untried > 0 ? `, ${cost.untried} left untried` : "") +
          (cost.hitBudget ? "  ← reached its share of the run's time" : "")
      );
    }
    if (report.slowestStep) {
      lines.push(
        "",
        `  Slowest single request: ${formatDuration(report.slowestStep.ms)} — ${report.slowestStep.label}`,
        `  Measured against the ${(CAMERA_OPEN_TIMEOUT_MS / 1000).toFixed(0)}-second camera deadline, past which a request is abandoned rather than waited on.`
      );
    }
    if (report.perCameraBudgetMs != null) {
      lines.push(
        "",
        `  Each camera was allowed ${formatDuration(report.perCameraBudgetMs)} of its own. The ceiling is generous on purpose: it exists for`,
        "  the one camera on a phone that takes fifteen seconds to open and would otherwise consume the entire",
        "  run, leaving every other camera unmeasured."
      );
    }
  }

  if (report.impossible.length > 0) {
    lines.push("", "", impossibleText(report.impossible, report.impossibleObservations));
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
