import {
  SUITE_TESTS,
  type SuiteTestResult,
  formatCapabilities,
  formatSettings,
  stopStream,
  trackCapabilities,
  trackSettings,
} from "./camera-diagnostics";

/**
 * Device Camera Spec Report engine.
 *
 * Runs the complete spec-wise battery against every camera the device exposes:
 * environment + API surface, per-camera maximum-capability probes, the full
 * 19-pattern getUserMedia constraint suite on both facings, measured (not just
 * reported) frame rate, ImageCapture photo capabilities, MediaRecorder codec
 * matrix, and BarcodeDetector format support. Produces an exportable
 * text + JSON report.
 */

export type SpecTone = "ok" | "warn" | "bad" | "neutral";

export type SpecEnvEntry = {
  label: string;
  value: string;
  tone: SpecTone;
};

export type CameraSpec = {
  index: number;
  deviceId: string;
  label: string;
  facingGuess: "front" | "back" | "unknown";
  error?: string;
  openMs?: number;
  grantedSettings?: string;
  grantedWidth?: number;
  grantedHeight?: number;
  grantedFps?: number;
  capabilitiesSummary?: string;
  capabilitiesRaw?: Record<string, unknown>;
  measuredFps?: number | null;
  photoCapabilities?: string;
  zoomRange?: string;
  torchSupported?: boolean;
  focusModes?: string;
  exposureModes?: string;
  whiteBalanceModes?: string;
  resizeModes?: string;
};

export type SuiteFacingRun = {
  facing: "user" | "environment";
  results: SuiteTestResult[];
  passed: number;
  failed: number;
};

export type CodecSupport = {
  mime: string;
  supported: boolean;
};

export type DeviceSpecReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: SpecEnvEntry[];
  cameras: CameraSpec[];
  totalVideoInputs: number;
  suites: SuiteFacingRun[];
  recorderCodecs: CodecSupport[];
  imageCaptureSupported: boolean;
  barcodeDetectorFormats: string[];
  notes: string[];
};

export type SpecProgress = (message: string, percent: number) => void;

const RECORDER_MIME_CANDIDATES: string[] = [
  "video/mp4",
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4;codecs=avc1",
  "video/mp4;codecs=hvc1",
  "video/webm",
  "video/webm;codecs=vp8",
  "video/webm;codecs=vp9",
  "video/webm;codecs=av01",
  "video/webm;codecs=h264",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
];

function toneFor(ok: boolean, warnInstead = false): SpecTone {
  if (ok) return "ok";
  return warnInstead ? "warn" : "bad";
}

function webglRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info") as {
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    if (ext) {
      const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
      return renderer || null;
    }
    return (gl.getParameter(gl.RENDERER) as string) || null;
  } catch {
    return null;
  }
}

async function cameraPermissionState(): Promise<string> {
  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    return status.state;
  } catch {
    return "unsupported";
  }
}

/** Collects the environment + API surface section. */
export async function collectSpecEnvironment(): Promise<SpecEnvEntry[]> {
  const entries: SpecEnvEntry[] = [];
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { platform?: string; mobile?: boolean };
    brave?: unknown;
  };

  entries.push({ label: "User agent", value: navigator.userAgent, tone: "neutral" });
  if (nav.userAgentData?.platform) {
    entries.push({
      label: "UA-CH platform",
      value: `${nav.userAgentData.platform}${nav.userAgentData.mobile ? " (mobile)" : ""}`,
      tone: "neutral",
    });
  }
  entries.push({
    label: "Secure context (HTTPS)",
    value: window.isSecureContext ? "yes" : "NO — getUserMedia unavailable",
    tone: toneFor(window.isSecureContext),
  });
  const hasGUM = !!navigator.mediaDevices?.getUserMedia;
  entries.push({ label: "getUserMedia", value: hasGUM ? "available" : "missing", tone: toneFor(hasGUM) });
  entries.push({
    label: "enumerateDevices",
    value: navigator.mediaDevices?.enumerateDevices ? "available" : "missing",
    tone: toneFor(!!navigator.mediaDevices?.enumerateDevices),
  });
  entries.push({
    label: "Camera permission",
    value: await cameraPermissionState(),
    tone: "neutral",
  });
  entries.push({
    label: "ImageCapture API",
    value: "ImageCapture" in window ? "available" : "not supported (canvas fallback used)",
    tone: toneFor("ImageCapture" in window, true),
  });
  entries.push({
    label: "MediaRecorder API",
    value: "MediaRecorder" in window ? "available" : "not supported",
    tone: toneFor("MediaRecorder" in window, true),
  });
  entries.push({
    label: "BarcodeDetector API",
    value: "BarcodeDetector" in window ? "available" : "not supported (ZXing fallback used)",
    tone: toneFor("BarcodeDetector" in window, true),
  });
  entries.push({
    label: "requestVideoFrameCallback",
    value:
      "requestVideoFrameCallback" in HTMLVideoElement.prototype
        ? "available (precise fps measurement)"
        : "missing (rAF fallback)",
    tone: toneFor("requestVideoFrameCallback" in HTMLVideoElement.prototype, true),
  });
  entries.push({
    label: "Screen",
    value: `${window.screen.width}×${window.screen.height} @ ${window.devicePixelRatio}x DPR`,
    tone: "neutral",
  });
  entries.push({
    label: "Viewport",
    value: `${window.innerWidth}×${window.innerHeight}`,
    tone: "neutral",
  });
  entries.push({
    label: "CPU threads",
    value: String(navigator.hardwareConcurrency ?? "unknown"),
    tone: "neutral",
  });
  if (nav.deviceMemory != null) {
    entries.push({ label: "Device memory (approx)", value: `${nav.deviceMemory} GB`, tone: "neutral" });
  }
  const gpu = webglRenderer();
  if (gpu) entries.push({ label: "GPU (WebGL renderer)", value: gpu, tone: "neutral" });
  entries.push({
    label: "Touch points",
    value: String(navigator.maxTouchPoints ?? 0),
    tone: "neutral",
  });
  entries.push({
    label: "Display mode",
    value: window.matchMedia("(display-mode: standalone)").matches ? "standalone (installed PWA)" : "browser tab",
    tone: "neutral",
  });
  return entries;
}

function guessFacing(label: string, capabilities: MediaTrackCapabilities | null): "front" | "back" | "unknown" {
  const facing = capabilities?.facingMode;
  if (facing?.includes("user")) return "front";
  if (facing?.includes("environment")) return "back";
  const l = label.toLowerCase();
  if (/front|user|face ?time|selfie/.test(l)) return "front";
  if (/back|rear|environment|world/.test(l)) return "back";
  return "unknown";
}

async function measureFps(stream: MediaStream, ms: number): Promise<number | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "true");
  video.style.position = "fixed";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  document.body.appendChild(video);
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    video.remove();
    return null;
  }

  const v = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  };

  const result = await new Promise<number | null>((resolve) => {
    let frames = 0;
    const start = performance.now();
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timeout = setTimeout(() => {
      const elapsed = performance.now() - start;
      finish(frames > 2 ? Math.round((frames * 1000) / elapsed) : null);
    }, ms + 1200);

    if (v.requestVideoFrameCallback) {
      const tick = () => {
        frames += 1;
        const elapsed = performance.now() - start;
        if (elapsed >= ms) {
          clearTimeout(timeout);
          finish(Math.round((frames * 1000) / elapsed));
        } else {
          v.requestVideoFrameCallback?.(tick);
        }
      };
      v.requestVideoFrameCallback(tick);
    } else {
      let lastTime = -1;
      const raf = () => {
        if (video.currentTime !== lastTime) {
          lastTime = video.currentTime;
          frames += 1;
        }
        const elapsed = performance.now() - start;
        if (elapsed >= ms) {
          clearTimeout(timeout);
          finish(frames > 2 ? Math.round((frames * 1000) / elapsed) : null);
        } else {
          requestAnimationFrame(raf);
        }
      };
      requestAnimationFrame(raf);
    }
  });

  video.srcObject = null;
  video.remove();
  return result;
}

function rangeText(range: unknown): string | null {
  const r = range as { min?: number; max?: number; step?: number } | undefined;
  if (!r || (r.min == null && r.max == null)) return null;
  return `${r.min ?? "?"}–${r.max ?? "?"}${r.step ? ` (step ${r.step})` : ""}`;
}

async function probeCameraSpec(
  index: number,
  deviceId: string,
  label: string
): Promise<CameraSpec> {
  const spec: CameraSpec = {
    index,
    deviceId,
    label: label || `Camera ${index + 1}`,
    facingGuess: "unknown",
  };

  const start = performance.now();
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 7680 },
        height: { ideal: 4320 },
      },
    });
  } catch (err) {
    spec.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return spec;
  }
  spec.openMs = Math.round(performance.now() - start);

  const track = stream.getVideoTracks()[0] ?? null;
  const settings = trackSettings(track);
  const caps = trackCapabilities(track);

  spec.label = track?.label || spec.label;
  spec.facingGuess = guessFacing(spec.label, caps);
  spec.grantedSettings = formatSettings(settings);
  spec.grantedWidth = settings?.width;
  spec.grantedHeight = settings?.height;
  spec.grantedFps = settings?.frameRate != null ? Math.round(settings.frameRate) : undefined;
  spec.capabilitiesSummary = formatCapabilities(caps);

  if (caps) {
    try {
      spec.capabilitiesRaw = JSON.parse(JSON.stringify(caps)) as Record<string, unknown>;
    } catch {
      spec.capabilitiesRaw = undefined;
    }
    const extCaps = caps as MediaTrackCapabilities & {
      zoom?: { min?: number; max?: number; step?: number };
      torch?: boolean;
      focusMode?: string[];
      exposureMode?: string[];
      whiteBalanceMode?: string[];
      resizeMode?: string[];
    };
    const zoom = rangeText(extCaps.zoom);
    if (zoom) spec.zoomRange = zoom;
    if (extCaps.torch != null) spec.torchSupported = extCaps.torch;
    if (extCaps.focusMode?.length) spec.focusModes = extCaps.focusMode.join(", ");
    if (extCaps.exposureMode?.length) spec.exposureModes = extCaps.exposureMode.join(", ");
    if (extCaps.whiteBalanceMode?.length) spec.whiteBalanceModes = extCaps.whiteBalanceMode.join(", ");
    if (extCaps.resizeMode?.length) spec.resizeModes = extCaps.resizeMode.join(", ");
  }

  spec.measuredFps = await measureFps(stream, 1200);

  // ImageCapture photo-mode capabilities (still-photo max resolution can exceed video)
  const ImageCaptureCtor = (window as unknown as {
    ImageCapture?: new (t: MediaStreamTrack) => {
      getPhotoCapabilities: () => Promise<{
        imageWidth?: { min?: number; max?: number };
        imageHeight?: { min?: number; max?: number };
        redEyeReduction?: string;
        fillLightMode?: string[];
      }>;
    };
  }).ImageCapture;
  if (ImageCaptureCtor && track) {
    try {
      const photo = await new ImageCaptureCtor(track).getPhotoCapabilities();
      const bits: string[] = [];
      const w = rangeText(photo.imageWidth);
      const h = rangeText(photo.imageHeight);
      if (photo.imageWidth?.max && photo.imageHeight?.max) {
        bits.push(`still max ${photo.imageWidth.max}×${photo.imageHeight.max}`);
      } else if (w || h) {
        bits.push(`w ${w ?? "?"} · h ${h ?? "?"}`);
      }
      if (photo.fillLightMode?.length) bits.push(`fill-light: ${photo.fillLightMode.join("/")}`);
      if (photo.redEyeReduction) bits.push(`red-eye: ${photo.redEyeReduction}`);
      spec.photoCapabilities = bits.join(" · ") || "reported, no ranges";
    } catch {
      spec.photoCapabilities = "getPhotoCapabilities failed";
    }
  }

  stopStream(stream);
  return spec;
}

async function runSuiteForFacing(
  facing: "user" | "environment",
  onProgress: (name: string, i: number, total: number) => void
): Promise<SuiteFacingRun> {
  const results: SuiteTestResult[] = [];
  for (let i = 0; i < SUITE_TESTS.length; i++) {
    const test = SUITE_TESTS[i];
    onProgress(test.name, i, SUITE_TESTS.length);
    const start = performance.now();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: test.build(facing),
      });
      const track = stream.getVideoTracks()[0] ?? null;
      const settings = trackSettings(track);
      results.push({
        id: `${facing}-${i}`,
        name: test.name,
        ok: true,
        granted: formatSettings(settings),
        durationMs: Math.round(performance.now() - start),
      });
      stopStream(stream);
    } catch (err) {
      results.push({
        id: `${facing}-${i}`,
        name: test.name,
        ok: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        durationMs: Math.round(performance.now() - start),
      });
    }
  }
  return {
    facing,
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

function collectRecorderCodecs(): CodecSupport[] {
  if (!("MediaRecorder" in window)) return RECORDER_MIME_CANDIDATES.map((mime) => ({ mime, supported: false }));
  return RECORDER_MIME_CANDIDATES.map((mime) => ({
    mime,
    supported: MediaRecorder.isTypeSupported(mime),
  }));
}

async function collectBarcodeFormats(): Promise<string[]> {
  const Detector = (window as unknown as {
    BarcodeDetector?: { getSupportedFormats?: () => Promise<string[]> };
  }).BarcodeDetector;
  if (!Detector?.getSupportedFormats) return [];
  try {
    return await Detector.getSupportedFormats();
  } catch {
    return [];
  }
}

/**
 * Runs the full device camera spec battery. Requires a user gesture beforehand
 * (camera permission prompt fires on the warm-up open).
 */
export async function runDeviceSpec(onProgress: SpecProgress): Promise<DeviceSpecReport> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const notes: string[] = [];

  onProgress("Collecting environment & API surface…", 2);
  const environment = await collectSpecEnvironment();

  onProgress("Requesting camera permission (warm-up open)…", 6);
  try {
    const warm = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    stopStream(warm);
  } catch (err) {
    notes.push(
      `Warm-up getUserMedia failed (${err instanceof Error ? err.name : "error"}) — camera probes may be blocked; results below reflect that.`
    );
  }

  onProgress("Enumerating cameras…", 10);
  let inputs: MediaDeviceInfo[] = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((d) => d.kind === "videoinput");
  } catch {
    notes.push("enumerateDevices failed — per-camera probing skipped.");
  }
  if (inputs.length === 0) notes.push("No video input devices were enumerated.");

  const cameras: CameraSpec[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const d = inputs[i];
    const pct = 12 + Math.round((i / Math.max(inputs.length, 1)) * 38);
    onProgress(`Probing camera ${i + 1}/${inputs.length} at maximum capability…`, pct);
    cameras.push(await probeCameraSpec(i, d.deviceId, d.label));
  }

  const suites: SuiteFacingRun[] = [];
  for (const facing of ["user", "environment"] as const) {
    const base = facing === "user" ? 52 : 71;
    suites.push(
      await runSuiteForFacing(facing, (name, i, total) => {
        onProgress(`Constraint suite (${facing}): ${name}`, base + Math.round((i / total) * 18));
      })
    );
  }

  onProgress("Checking MediaRecorder codec support…", 92);
  const recorderCodecs = collectRecorderCodecs();

  onProgress("Checking BarcodeDetector formats…", 95);
  const barcodeDetectorFormats = await collectBarcodeFormats();

  onProgress("Building report…", 98);
  const finishedAt = new Date().toISOString();
  const report: DeviceSpecReport = {
    startedAt,
    finishedAt,
    durationMs: Math.round(performance.now() - t0),
    environment,
    cameras,
    totalVideoInputs: inputs.length,
    suites,
    recorderCodecs,
    imageCaptureSupported: "ImageCapture" in window,
    barcodeDetectorFormats,
    notes,
  };
  onProgress("Done", 100);
  return report;
}

/** Readable text export of the full device spec report. */
export function buildDeviceSpecText(report: DeviceSpecReport): string {
  const L: string[] = [];
  const hr = "=".repeat(64);
  const sub = "-".repeat(64);

  L.push(hr);
  L.push("DEVICE CAMERA SPEC REPORT — Verification Hub");
  L.push(hr);
  L.push(`Started:  ${report.startedAt}`);
  L.push(`Finished: ${report.finishedAt}`);
  L.push(`Duration: ${(report.durationMs / 1000).toFixed(1)} s`);
  L.push("");

  L.push("1. ENVIRONMENT & API SURFACE");
  L.push(sub);
  for (const e of report.environment) {
    const flag = e.tone === "bad" ? " [!]" : e.tone === "warn" ? " [~]" : "";
    L.push(`  ${e.label}: ${e.value}${flag}`);
  }
  L.push("");

  L.push(`2. CAMERAS (${report.totalVideoInputs} video input${report.totalVideoInputs === 1 ? "" : "s"})`);
  L.push(sub);
  for (const c of report.cameras) {
    L.push(`  [${c.index + 1}] ${c.label} — facing: ${c.facingGuess}`);
    if (c.error) {
      L.push(`      ERROR: ${c.error}`);
      continue;
    }
    L.push(`      Opened in: ${c.openMs} ms`);
    L.push(`      Granted (max request): ${c.grantedSettings ?? "n/a"}`);
    L.push(`      Capabilities: ${c.capabilitiesSummary ?? "n/a"}`);
    if (c.measuredFps != null) L.push(`      Measured fps (1.2 s sample): ${c.measuredFps}`);
    if (c.zoomRange) L.push(`      Zoom range: ${c.zoomRange}`);
    if (c.torchSupported != null) L.push(`      Torch: ${c.torchSupported ? "supported" : "not supported"}`);
    if (c.focusModes) L.push(`      Focus modes: ${c.focusModes}`);
    if (c.exposureModes) L.push(`      Exposure modes: ${c.exposureModes}`);
    if (c.whiteBalanceModes) L.push(`      White balance modes: ${c.whiteBalanceModes}`);
    if (c.resizeModes) L.push(`      Resize modes: ${c.resizeModes}`);
    if (c.photoCapabilities) L.push(`      ImageCapture photo: ${c.photoCapabilities}`);
    L.push("");
  }

  for (const suite of report.suites) {
    L.push(`3. CONSTRAINT SUITE — facing "${suite.facing}" (${suite.passed} granted / ${suite.failed} rejected of ${suite.results.length})`);
    L.push(sub);
    for (const r of suite.results) {
      if (r.ok) {
        L.push(`  [OK ] ${r.name} (${r.durationMs} ms)`);
        L.push(`        granted: ${r.granted}`);
      } else {
        L.push(`  [REJ] ${r.name} (${r.durationMs} ms)`);
        L.push(`        ${r.error}`);
      }
    }
    L.push("");
  }

  L.push("4. MEDIARECORDER CODEC MATRIX");
  L.push(sub);
  for (const c of report.recorderCodecs) {
    L.push(`  [${c.supported ? "YES" : "no "}] ${c.mime}`);
  }
  L.push("");

  L.push("5. BARCODE DETECTOR");
  L.push(sub);
  L.push(
    report.barcodeDetectorFormats.length
      ? `  Native formats: ${report.barcodeDetectorFormats.join(", ")}`
      : "  Native BarcodeDetector unavailable or reported no formats (app falls back to ZXing)."
  );
  L.push("");

  if (report.notes.length) {
    L.push("6. NOTES");
    L.push(sub);
    for (const n of report.notes) L.push(`  - ${n}`);
    L.push("");
  }

  L.push(hr);
  L.push("Interpretation guide:");
  L.push("- 'Granted (max request)' is what the browser gave for an 8K ideal request —");
  L.push("  this is the effective max video capture resolution for this camera.");
  L.push("- ImageCapture 'still max' can exceed video resolution (full-sensor photos).");
  L.push("- Rejected suite patterns with OverconstrainedError are valid results: they map");
  L.push("  the hard limits of the camera stack, not app bugs.");
  L.push("- Verification flows use: max-res capture (documents), height-640 16:9 (liveness),");
  L.push("  MediaRecorder mp4/webm (silent clips), BarcodeDetector/ZXing (PDF417).");
  L.push(hr);
  return L.join("\n");
}

/** Structured JSON export of the full device spec report. */
export function buildDeviceSpecJson(report: DeviceSpecReport): string {
  return JSON.stringify(
    {
      kind: "device-camera-spec-report",
      version: 1,
      ...report,
    },
    null,
    2
  );
}
