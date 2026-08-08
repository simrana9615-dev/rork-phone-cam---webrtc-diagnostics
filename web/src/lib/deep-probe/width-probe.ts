/**
 * The 640-only investigation.
 *
 * One question, asked twice: what does this phone do when a website asks for
 * `{ video: { width: 640, facingMode } }` and NOTHING else?
 *
 * That is the request real sites actually send. Video-chat pages, scanners,
 * document uploaders and half the WebRTC examples on the internet send a bare
 * width and let the platform fill in the rest — and what the platform fills in
 * is entirely undocumented. Which physical camera opens? What height comes
 * back? What aspect ratio does it pick? What frame rate does it settle on? Is
 * 640 even honoured, or quietly rounded to the nearest thing the sensor likes?
 *
 * The full sweep cannot answer this, and not by accident: it pins the device by
 * `deviceId` and states both dimensions exactly, because it is measuring the
 * RANGE a camera supports. This measures the DEFAULT a camera falls back to,
 * which is a different fact and needs the opposite kind of request.
 *
 * Deliberate limits, so the mode stays the one-minute thing it claims to be:
 *
 *   • Two opens. One `facingMode: environment`, one `facingMode: user`. No
 *     constraint family sweep, no ladder, no ratios, no control modes.
 *   • Two stills per side, down the two paths that exist: the browser's own
 *     photo pipeline, and a frame this app encodes from the video track. Those
 *     two paths are opposites — one may carry platform metadata, the other
 *     carries none by construction — so having both is what makes the files
 *     readable against each other.
 *   • No verdict. The report says what was asked, what arrived, and whether
 *     they match. Whether that is good behaviour is not this app's opinion to
 *     have.
 *
 * The honesty rules are the same as everywhere else. A refusal is recorded as a
 * refusal and never retried. A timeout is not a refusal. A still that did not
 * arrive says why. `facingMode` not being honoured is a finding, not an error.
 */

import { readPixelSize } from "./capture-memory";
import { openMediaWithDeadline, withCameraDeadline } from "./camera-timeout";
import { CANVAS_ENCODE_QUALITY, type ProbeCapture } from "./camera-matrix";
import { PROBE_WIDTH } from "./run-mode";

export type ProbeFacing = "environment" | "user";

export const PROBE_FACINGS: ProbeFacing[] = ["environment", "user"];

export const FACING_LABEL: Record<ProbeFacing, string> = {
  environment: "Back camera",
  user: "Front camera",
};

/** How the granted width compares with the 640 that was asked for. */
export type WidthVerdict = "exact" | "near" | "different" | "unknown";

/**
 * One camera opened with a bare width, and everything it said for itself.
 *
 * Every field is either something the browser returned or null with a stated
 * reason. Nothing here is derived from what a device is expected to do.
 */
export type WidthProbeRow = {
  facing: ProbeFacing;
  /** The constraint object exactly as it was passed to getUserMedia. */
  asked: Record<string, unknown>;
  /** Whether the open succeeded at all. */
  ok: boolean;
  /** The error name when it did not. Null when it did. */
  error: string | null;
  openMs: number;

  /** `track.getSettings()`, verbatim, key order intact. */
  settings: Record<string, unknown> | null;
  /** `track.getCapabilities()`, verbatim, ranges intact. */
  capabilities: Record<string, unknown> | null;
  /** `track.getConstraints()` after the open — what the browser thinks it was asked. */
  constraints: Record<string, unknown> | null;

  /** The label of the camera that actually opened. This is the "which one did it pick" answer. */
  trackLabel: string | null;
  trackId: string | null;
  streamId: string | null;
  /** The device the browser chose, which was never named in the request. */
  chosenDeviceId: string | null;
  chosenGroupId: string | null;

  /** What a `<video>` element reads for this track, which can differ from the settings. */
  videoWidth: number | null;
  videoHeight: number | null;

  grantedWidth: number | null;
  grantedHeight: number | null;
  grantedAspect: number | null;
  grantedFrameRate: number | null;
  /** The facing the track reports. Absent on desktop and on some Android builds. */
  grantedFacing: string | null;

  /** How the granted width compares with the one asked for. */
  verdict: WidthVerdict;
  /** Slugs of the stills taken through this open. */
  captureSlugs: string[];
  /** Anything that could not be read, named rather than dropped. */
  notes: string[];
  /** The reading, in words, of what this phone decided. */
  reading: string;
};

export type WidthProbeReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  width: number;
  rows: WidthProbeRow[];
  /** True when the run was stopped before both facings had been tried. */
  aborted: boolean;
  /** `enumerateDevices()` before and after, so the chosen device can be named. */
  devicesBefore: { kind: string; deviceId: string; groupId: string; label: string }[];
  devicesAfter: { kind: string; deviceId: string; groupId: string; label: string }[];
  notes: string[];
};

export type WidthProbeOptions = {
  onProgress?: (message: string, done: number, total: number) => void;
  onCapture?: (capture: ProbeCapture) => void;
  shouldAbort?: () => boolean;
  waitWhilePaused?: () => Promise<void>;
};

/** Within this many pixels of 640 counts as "near" rather than "different". */
const NEAR_TOLERANCE = 32;

function errorName(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message || "no message"}`;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Copies a browser-produced object without touching key order or values.
 *
 * `getCapabilities()` returns nested `{min, max}` ranges that a naive spread
 * would flatten, and key order in `getSettings()` is itself an engine trait.
 */
function verbatim(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Where the granted width stands relative to the 640 that was asked for. */
export function widthVerdict(asked: number, granted: number | null): WidthVerdict {
  if (granted == null) return "unknown";
  if (granted === asked) return "exact";
  return Math.abs(granted - asked) <= NEAR_TOLERANCE ? "near" : "different";
}

/** What one row means, said plainly and without an opinion about whether it is good. */
export function widthReading(row: Pick<WidthProbeRow, "facing" | "ok" | "error" | "grantedWidth" | "grantedHeight" | "grantedAspect" | "grantedFrameRate" | "grantedFacing" | "trackLabel" | "verdict">, asked: number): string {
  const side = FACING_LABEL[row.facing].toLowerCase();
  if (!row.ok) {
    return (
      `Asking for ${asked} wide on the ${side} was refused: ${row.error ?? "no error name was reported, which is itself a fault"}. ` +
      "That is a result, not a gap — it says this device will not open that camera on a bare width request. Nothing has been assumed about what it would have returned."
    );
  }
  const size = row.grantedWidth != null && row.grantedHeight != null ? `${row.grantedWidth}×${row.grantedHeight}` : "a size the track did not report";
  const shape =
    row.grantedAspect != null
      ? `an aspect ratio of ${Math.round(row.grantedAspect * 1000) / 1000}`
      : row.grantedWidth != null && row.grantedHeight != null && row.grantedHeight > 0
        ? `an aspect ratio of ${Math.round((row.grantedWidth / row.grantedHeight) * 1000) / 1000}, worked out from the size because the track did not state one`
        : "no stateable aspect ratio";
  const rate = row.grantedFrameRate != null ? `${Math.round(row.grantedFrameRate * 100) / 100} fps` : "a frame rate the track did not report";
  const which = row.trackLabel && row.trackLabel.length > 0 ? `It opened "${row.trackLabel}".` : "The track carries no label, so which physical camera opened cannot be named from it.";
  const facingNote =
    row.grantedFacing == null
      ? " The track reports no facingMode at all, so the side cannot be confirmed from the track itself — only from what was asked."
      : row.grantedFacing === row.facing
        ? ` The track confirms facingMode "${row.grantedFacing}".`
        : ` The track reports facingMode "${row.grantedFacing}" although "${row.facing}" was asked for — the request was honoured loosely, which is a finding rather than an error.`;

  const head =
    row.verdict === "exact"
      ? `Asked for ${asked} wide and nothing else; got exactly ${size}.`
      : row.verdict === "near"
        ? `Asked for ${asked} wide and nothing else; got ${size} — near the request but not it. The platform picked the nearest size the sensor scaler likes rather than the number asked for.`
        : row.verdict === "different"
          ? `Asked for ${asked} wide and nothing else; got ${size}, which is not close to the request. This is the interesting case: a bare width is a WISH on this device, not an instruction, and a site sending one gets whatever the platform prefers.`
          : `Asked for ${asked} wide and nothing else; the track reported no width, so whether the request was honoured cannot be said.`;

  return `${head} The phone also chose ${shape} and ${rate}, none of which were asked for. ${which}${facingNote}`;
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

type ImageCaptureLike = { takePhoto: () => Promise<Blob> };
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

function imageCaptureCtor(): ImageCaptureCtor | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture ?? null;
}

/** The browser's own photo pipeline, which is the path that may carry platform metadata. */
async function platformStill(track: MediaStreamTrack): Promise<{ blob: Blob; width: number; height: number } | null> {
  const Ctor = imageCaptureCtor();
  if (!Ctor || track.readyState !== "live") return null;
  try {
    const capture = new Ctor(track);
    const blob = await withCameraDeadline(capture.takePhoto(), { what: "the platform photo pipeline" });
    const size = await readPixelSize(blob);
    return { blob, width: size?.width ?? 0, height: size?.height ?? 0 };
  } catch {
    return null;
  }
}

/** A frame this app draws and encodes itself, which carries no camera metadata by construction. */
async function canvasStill(video: HTMLVideoElement): Promise<{ blob: Blob; width: number; height: number } | null> {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  try {
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", CANVAS_ENCODE_QUALITY));
    if (!blob) return null;
    return { blob, width: canvas.width, height: canvas.height };
  } catch {
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function enumerate(): Promise<{ kind: string; deviceId: string; groupId: string; label: string }[]> {
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    return devices.map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId ?? "", label: d.label ?? "" }));
  } catch {
    return [];
  }
}

/**
 * Runs the 640-only investigation: one open per facing, two stills per open.
 *
 * Pausing is honoured between facings and between stills, and a stop request is
 * checked at every one of those points, so both controls behave here exactly as
 * they do in the full sweep. A facing that never ran because the run was
 * stopped is simply absent from the rows, and the report says it was aborted
 * rather than presenting a half-run as a whole one.
 */
export async function runWidthProbe(options: WidthProbeOptions = {}): Promise<WidthProbeReport> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const rows: WidthProbeRow[] = [];
  const notes: string[] = [];
  const devicesBefore = await enumerate();
  let aborted = false;

  const total = PROBE_FACINGS.length;
  for (let i = 0; i < PROBE_FACINGS.length; i += 1) {
    const facing = PROBE_FACINGS[i];
    await options.waitWhilePaused?.();
    if (options.shouldAbort?.() === true) {
      aborted = true;
      break;
    }
    options.onProgress?.(`Asking the ${FACING_LABEL[facing].toLowerCase()} for ${PROBE_WIDTH} wide, and nothing else`, i, total);

    // The whole point of the mode. No height, no aspectRatio, no frameRate, no
    // deviceId — anything else here would be answering a different question.
    const asked: MediaStreamConstraints = { video: { width: PROBE_WIDTH, facingMode: facing }, audio: false };
    const askedPlain = { video: { width: PROBE_WIDTH, facingMode: facing }, audio: false } as Record<string, unknown>;

    const rowNotes: string[] = [];
    const openStart = performance.now();
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    try {
      stream = await openMediaWithDeadline(asked, { what: `the ${FACING_LABEL[facing].toLowerCase()} at ${PROBE_WIDTH} wide` });
      const openMs = performance.now() - openStart;
      const track = stream.getVideoTracks()[0] ?? null;
      if (!track) {
        rows.push(emptyRow(facing, askedPlain, openMs, "The stream opened but carried no video track at all.", rowNotes));
        continue;
      }

      const settings = verbatim(track.getSettings?.() ?? null);
      let capabilities: Record<string, unknown> | null = null;
      try {
        capabilities = track.getCapabilities ? verbatim(track.getCapabilities()) : null;
        if (!track.getCapabilities) rowNotes.push("track.getCapabilities is not implemented here, so no capability ranges could be read. That is an absence, not an empty range.");
      } catch (err) {
        rowNotes.push(`track.getCapabilities() threw: ${errorName(err)}`);
      }
      let constraints: Record<string, unknown> | null = null;
      try {
        constraints = track.getConstraints ? verbatim(track.getConstraints()) : null;
      } catch (err) {
        rowNotes.push(`track.getConstraints() threw: ${errorName(err)}`);
      }

      video = await attachVideo(stream);
      if (!video) rowNotes.push("No <video> element could be attached, so videoWidth/videoHeight were not read and no canvas still could be taken.");

      const grantedWidth = num(settings?.width);
      const grantedHeight = num(settings?.height);
      const chosenDeviceId = typeof settings?.deviceId === "string" ? settings.deviceId : null;
      const chosenGroupId = typeof settings?.groupId === "string" ? settings.groupId : null;
      const verdict = widthVerdict(PROBE_WIDTH, grantedWidth);

      const partial = {
        facing,
        ok: true,
        error: null,
        grantedWidth,
        grantedHeight,
        grantedAspect: num(settings?.aspectRatio),
        grantedFrameRate: num(settings?.frameRate),
        grantedFacing: typeof settings?.facingMode === "string" ? settings.facingMode : null,
        trackLabel: track.label || null,
        verdict,
      } as const;

      const captureSlugs: string[] = [];
      // Two paths, because they are opposites: one may carry the platform's own
      // metadata, the other carries none by construction. Having both is what
      // makes the pair readable against each other.
      const stills: { path: ProbeCapture["path"]; shot: { blob: Blob; width: number; height: number } | null; origin: ProbeCapture["origin"]; how: string }[] = [];
      await options.waitWhilePaused?.();
      if (options.shouldAbort?.() !== true) {
        options.onProgress?.(`${FACING_LABEL[facing]} — taking a still down the platform photo path`, i, total);
        stills.push({ path: "image-capture", shot: await platformStill(track), origin: "platform-photo", how: "the browser's own photo pipeline (ImageCapture.takePhoto)" });
      }
      await options.waitWhilePaused?.();
      if (options.shouldAbort?.() !== true && video) {
        options.onProgress?.(`${FACING_LABEL[facing]} — taking a still down the canvas path`, i, total);
        stills.push({ path: "canvas", shot: await canvasStill(video), origin: "app-encoded-frame", how: "a frame this app drew from the video track and encoded as JPEG" });
      }

      for (const still of stills) {
        if (!still.shot) {
          rowNotes.push(
            still.path === "image-capture"
              ? "No still came back from the browser's own photo pipeline. On iOS Safari that is because ImageCapture does not exist there at all; elsewhere it means takePhoto did not return. Either way it is recorded as absent rather than substituted."
              : "No still could be encoded from the video track."
          );
          continue;
        }
        const slug = `width640-${facing}-${still.path}`;
        captureSlugs.push(slug);
        options.onCapture?.({
          slug,
          label: `${FACING_LABEL[facing]} at ${PROBE_WIDTH} wide — ${still.path === "image-capture" ? "platform photo path" : "canvas path"}`,
          blob: still.shot.blob,
          origin: still.origin,
          stage: "camera-sweep",
          deviceLabel: track.label || null,
          path: still.path,
          width: still.shot.width,
          height: still.shot.height,
          fileName: null,
          fileLastModified: null,
          fileRelativePath: null,
          asked: `{ video: { width: ${PROBE_WIDTH}, facingMode: "${facing}" } } — width was the only size constraint sent`,
          granted: `${grantedWidth ?? "?"}×${grantedHeight ?? "?"} track · still via ${still.how} at ${still.shot.width}×${still.shot.height}`,
          takenAt: new Date().toISOString(),
        });
      }

      rows.push({
        ...partial,
        asked: askedPlain,
        openMs: Math.round(openMs),
        settings,
        capabilities,
        constraints,
        trackId: track.id,
        streamId: stream.id,
        chosenDeviceId,
        chosenGroupId,
        videoWidth: video?.videoWidth ?? null,
        videoHeight: video?.videoHeight ?? null,
        captureSlugs,
        notes: rowNotes,
        reading: widthReading(partial, PROBE_WIDTH),
      });
    } catch (err) {
      rows.push(emptyRow(facing, askedPlain, performance.now() - openStart, errorName(err), rowNotes));
    } finally {
      detachVideo(video);
      stream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // already stopped
        }
      });
    }
  }

  const devicesAfter = await enumerate();
  if (aborted) notes.push("You stopped the run before both cameras had been asked. The rows above really ran; the missing facing was never attempted and nothing has been guessed in its place.");
  notes.push(
    "Only ONE constraint was sent per open: a plain width. No height, no aspect ratio, no frame rate and no device were named, which is the whole point — this measures what the phone falls back to, not what it is capable of. The full run measures the second thing."
  );
  notes.push(
    "Neither camera was pinned by deviceId, so which physical camera opened was the platform's choice. Where a track label came back, it names that choice; where none did, the choice cannot be named from the track and is left unstated rather than guessed at from the device list."
  );

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    width: PROBE_WIDTH,
    rows,
    aborted,
    devicesBefore,
    devicesAfter,
    notes,
  };
}

function emptyRow(facing: ProbeFacing, asked: Record<string, unknown>, openMs: number, error: string, notes: string[]): WidthProbeRow {
  const partial = {
    facing,
    ok: false,
    error,
    grantedWidth: null,
    grantedHeight: null,
    grantedAspect: null,
    grantedFrameRate: null,
    grantedFacing: null,
    trackLabel: null,
    verdict: "unknown" as const,
  };
  return {
    ...partial,
    asked,
    openMs: Math.round(openMs),
    settings: null,
    capabilities: null,
    constraints: null,
    trackId: null,
    streamId: null,
    chosenDeviceId: null,
    chosenGroupId: null,
    videoWidth: null,
    videoHeight: null,
    captureSlugs: [],
    notes,
    reading: widthReading(partial, PROBE_WIDTH),
  };
}

/** The readable report for the 640-only run. */
export function widthProbeText(report: WidthProbeReport): string {
  const lines: string[] = [
    `WHAT THIS PHONE DOES WHEN A SITE ASKS FOR ${report.width} WIDE AND NOTHING ELSE`,
    "=".repeat(78),
    "",
    "This run sent one constraint per camera — a plain width — and recorded what the phone decided on its",
    "own for everything else. That is the request most real websites actually send, and what a platform",
    "fills in around it is undocumented. Nothing below is a judgement about whether the behaviour is good.",
    "",
    `Asked for: { video: { width: ${report.width}, facingMode: "environment" | "user" } }`,
    `Ran: ${report.startedAt} → ${report.finishedAt} (${(report.durationMs / 1000).toFixed(1)}s)`,
    "",
  ];

  if (report.rows.length === 0) {
    lines.push("No camera was opened at all, so there is nothing to report. The omissions list says why.");
    return lines.join("\n");
  }

  for (const row of report.rows) {
    lines.push(`── ${FACING_LABEL[row.facing]} ──`, `   asked           ${JSON.stringify(row.asked)}`, `   open            ${row.ok ? `succeeded in ${row.openMs} ms` : `REFUSED after ${row.openMs} ms — ${row.error}`}`);
    if (row.ok) {
      lines.push(
        `   granted size    ${row.grantedWidth ?? "?"}×${row.grantedHeight ?? "?"}`,
        `   width verdict   ${row.verdict === "exact" ? `exactly the ${report.width} asked for` : row.verdict === "near" ? `${row.grantedWidth} — near ${report.width} but not it` : row.verdict === "different" ? `${row.grantedWidth} — nowhere near ${report.width}` : "the track reported no width"}`,
        `   aspect ratio    ${row.grantedAspect ?? "not reported by the track"}`,
        `   frame rate      ${row.grantedFrameRate ?? "not reported by the track"}`,
        `   facingMode      ${row.grantedFacing ?? "not reported by the track"}`,
        `   camera opened   ${row.trackLabel ?? "the track carries no label"}`,
        `   device chosen   ${row.chosenDeviceId ?? "the track reports no deviceId"}${row.chosenGroupId ? ` (group ${row.chosenGroupId})` : ""}`,
        `   <video> reads   ${row.videoWidth ?? "?"}×${row.videoHeight ?? "?"}`,
        `   stills          ${row.captureSlugs.length > 0 ? row.captureSlugs.join(", ") : "none — the notes say why"}`
      );
      if (row.settings) lines.push(`   getSettings()   ${JSON.stringify(row.settings)}`);
      if (row.constraints) lines.push(`   getConstraints()${JSON.stringify(row.constraints)}`);
      if (row.capabilities) lines.push(`   getCapabilities() ${JSON.stringify(row.capabilities)}`);
    }
    lines.push(`   ${row.reading}`);
    for (const note of row.notes) lines.push(`   · ${note}`);
    lines.push("");
  }

  lines.push("HOW TO READ THIS", "-".repeat(78));
  for (const note of report.notes) lines.push(`  ${note}`);
  return lines.join("\n");
}
