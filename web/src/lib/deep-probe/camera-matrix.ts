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
  "A still was taken at the native maximum, at every landscape resolution rung, and at every aspect ratio — down BOTH available paths at each of those steps (the browser's own photo pipeline, and a frame this app encoded from the video track). Portrait variants, frame-rate steps and control-mode steps deliberately produce no still: they change how the track behaves, not what a photo of it looks like, and taking hundreds of near-identical frames would pad the archive without adding evidence. Rows with an empty capture list were never expected to have one.";

type PhotoCaps = { imageWidth?: { max?: number }; imageHeight?: { max?: number } };
type ImageCaptureLike = { takePhoto: (s?: { imageWidth?: number; imageHeight?: number }) => Promise<Blob>; getPhotoCapabilities: () => Promise<PhotoCaps> };
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

async function canvasStill(video: HTMLVideoElement): Promise<{ blob: Blob; width: number; height: number } | null> {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95));
  return blob ? { blob, width: canvas.width, height: canvas.height } : null;
}

async function platformStill(track: MediaStreamTrack): Promise<{ blob: Blob; width: number; height: number } | null> {
  const Ctor = imageCaptureCtor();
  if (!Ctor || track.readyState !== "live") return null;
  try {
    const capture = new Ctor(track);
    const blob = await capture.takePhoto();
    const size = await blobSize(blob);
    return { blob, width: size.width, height: size.height };
  } catch {
    return null;
  }
}

function blobSize(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0 });
    };
    img.src = url;
  });
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

  if (!navigator.mediaDevices?.getUserMedia) {
    notes.push("This browser exposes no navigator.mediaDevices, so no camera could be opened. Nothing below is a refusal — the API is simply absent.");
    return {
      report: { startedAt, finishedAt: new Date().toISOString(), durationMs: 0, inventory: [], rows, stillPolicy: STILL_POLICY, notes, aborted },
      captures,
    };
  }

  let inventory: CameraDeviceInfo[] = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
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

  const nextSlug = (prefix: string): string => {
    counter += 1;
    return `${String(counter).padStart(3, "0")}-${prefix}`;
  };

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
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: step.constraints });
      } catch (err) {
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

      const captureSlugs: string[] = [];
      if (step.takeStills && track) {
        const video = await attachVideo(stream);

        const platform = await platformStill(track);
        if (platform) {
          const slug = nextSlug("platform");
          captureSlugs.push(slug);
          const capture: ProbeCapture = {
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
            asked: step.asked,
            granted: settingsText(settings),
            takenAt: new Date().toISOString(),
          };
          captures.push(capture);
          options.onCapture(capture);
        }

        if (video) {
          const drawn = await canvasStill(video);
          if (drawn) {
            const slug = nextSlug("canvas");
            captureSlugs.push(slug);
            const capture: ProbeCapture = {
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
              asked: step.asked,
              granted: settingsText(settings),
              takenAt: new Date().toISOString(),
            };
            captures.push(capture);
            options.onCapture(capture);
          }
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
        captureSlugs,
      });
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: device.deviceId } } });
      } catch (err) {
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
    "STILL POLICY",
    "-".repeat(78),
    ...wrap(report.stillPolicy, 78),
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
