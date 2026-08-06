/**
 * Device-level camera access — the browser's closest analogue to AVFoundation.
 *
 * Every other capture engine in this app hands control to an OS picker or
 * camera app and waits for a file. This module does the opposite: it asks the
 * platform to name every camera it has, opens one specific physical camera by
 * id, reads back what that camera can actually do, and takes the still itself.
 *
 * Why "AVFoundation-class": on iOS/macOS WebKit, `getUserMedia` and
 * `enumerateDevices` are implemented on top of AVFoundation, and the strings
 * that come back in `MediaDeviceInfo.label` are `AVCaptureDevice.localizedName`
 * values — "Back Dual Wide Camera", "Back Ultra Wide Camera", "Front Camera".
 * So this path surfaces the same device inventory an
 * `AVCaptureDevice.DiscoverySession` would, minus the parts the web platform
 * deliberately withholds (no format list, no per-lens switch-over factors, no
 * RAW). It is a shim over AVFoundation, not AVFoundation itself, and this
 * module never pretends otherwise.
 *
 * The trade the user is making is explicit and recorded: this path yields the
 * richest live hardware inventory of any engine, and the *poorest* file
 * metadata — a browser still carries little or no EXIF, so the origin the
 * evidence pack records is "platform-photo" (or "app-encoded-frame" when the
 * canvas fallback runs), never "camera-file".
 */

/** Which side of the device a camera sits on, as far as the label reveals. */
export type CameraFacing = "front" | "back" | "external" | "unknown";

/**
 * The lens class a device label maps to. Named after AVFoundation's device
 * types so the mapping to native is legible.
 */
export type CameraLensClass =
  | "ultra-wide"
  | "wide"
  | "telephoto"
  | "dual-wide"
  | "dual"
  | "triple"
  | "truedepth"
  | "desk-view"
  | "continuity"
  | "external"
  | "unknown";

/** The AVFoundation device type each lens class corresponds to. */
export const AV_DEVICE_TYPE: Record<CameraLensClass, string> = {
  "ultra-wide": "AVCaptureDevice.DeviceType.builtInUltraWideCamera",
  wide: "AVCaptureDevice.DeviceType.builtInWideAngleCamera",
  telephoto: "AVCaptureDevice.DeviceType.builtInTelephotoCamera",
  "dual-wide": "AVCaptureDevice.DeviceType.builtInDualWideCamera (virtual: ultra-wide + wide)",
  dual: "AVCaptureDevice.DeviceType.builtInDualCamera (virtual: wide + telephoto)",
  triple: "AVCaptureDevice.DeviceType.builtInTripleCamera (virtual: ultra-wide + wide + telephoto)",
  truedepth: "AVCaptureDevice.DeviceType.builtInTrueDepthCamera",
  "desk-view": "AVCaptureDevice.DeviceType.deskViewCamera",
  continuity: "AVCaptureDevice.DeviceType.continuityCamera",
  external: "AVCaptureDevice.DeviceType.external",
  unknown: "no confident mapping from this label",
};

/** Lens classes that AVFoundation calls virtual — several physical lenses fused into one device. */
const VIRTUAL_CLASSES: ReadonlySet<CameraLensClass> = new Set<CameraLensClass>(["dual-wide", "dual", "triple"]);

export type CameraDeviceInfo = {
  deviceId: string;
  groupId: string;
  /** Exactly what the platform reported. Empty string when the label was withheld. */
  label: string;
  facing: CameraFacing;
  lensClass: CameraLensClass;
  /** True when the label maps to an AVFoundation virtual (fused multi-lens) device. */
  isVirtual: boolean;
  /**
   * False when the label was blank or unrecognised, so facing/lensClass are
   * defaults rather than observations. Never present a guess as a reading.
   */
  classified: boolean;
};

/**
 * Best-effort classification of a platform camera label. English and the
 * Android `camera2 N, facing back` form are recognised; anything else stays
 * `unknown` with `classified: false` rather than being forced into a bucket.
 */
export function classifyCameraLabel(label: string): Pick<CameraDeviceInfo, "facing" | "lensClass" | "isVirtual" | "classified"> {
  const l = label.toLowerCase().trim();
  if (!l) return { facing: "unknown", lensClass: "unknown", isVirtual: false, classified: false };

  let facing: CameraFacing = "unknown";
  if (/\bfront\b|facing front|selfie|truedepth|user-facing/.test(l)) facing = "front";
  else if (/\bback\b|\brear\b|facing back|environment/.test(l)) facing = "back";
  else if (/\busb\b|external|webcam|brio|logitech|obs|virtual/.test(l)) facing = "external";

  let lensClass: CameraLensClass = "unknown";
  if (/desk view/.test(l)) lensClass = "desk-view";
  else if (/continuity/.test(l)) lensClass = "continuity";
  else if (/triple/.test(l)) lensClass = "triple";
  else if (/dual wide|dual-wide/.test(l)) lensClass = "dual-wide";
  else if (/\bdual\b/.test(l)) lensClass = "dual";
  else if (/ultra[\s-]?wide/.test(l)) lensClass = "ultra-wide";
  else if (/telephoto|\btele\b/.test(l)) lensClass = "telephoto";
  else if (/truedepth/.test(l)) lensClass = "truedepth";
  else if (facing === "external") lensClass = "external";
  else if (/camera/.test(l)) lensClass = "wide";

  const classified = facing !== "unknown" || lensClass !== "unknown";
  return { facing, lensClass, isVirtual: VIRTUAL_CLASSES.has(lensClass), classified };
}

/** A short human name for a lens class, for chips and summaries. */
export function lensClassLabel(lensClass: CameraLensClass): string {
  switch (lensClass) {
    case "ultra-wide":
      return "Ultra-wide";
    case "wide":
      return "Wide";
    case "telephoto":
      return "Telephoto";
    case "dual-wide":
      return "Dual wide (virtual)";
    case "dual":
      return "Dual (virtual)";
    case "triple":
      return "Triple (virtual)";
    case "truedepth":
      return "TrueDepth";
    case "desk-view":
      return "Desk View";
    case "continuity":
      return "Continuity";
    case "external":
      return "External";
    case "unknown":
      return "Unclassified";
  }
}

function toDeviceInfo(d: MediaDeviceInfo): CameraDeviceInfo {
  const label = d.label ?? "";
  return { deviceId: d.deviceId, groupId: d.groupId ?? "", label, ...classifyCameraLabel(label) };
}

/** True when this browser can enumerate media devices at all. */
export function isDeviceCameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof navigator.mediaDevices.enumerateDevices === "function"
  );
}

/** Lists video inputs as the platform currently reports them (labels may be blank pre-permission). */
export async function enumerateVideoInputs(): Promise<CameraDeviceInfo[]> {
  if (!isDeviceCameraSupported()) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput").map(toDeviceInfo);
}

/**
 * What the site learned about the camera hardware, before and after the
 * permission grant. The before/after pair is the point: it shows exactly how
 * much the browser withholds until the user says yes.
 */
export type CameraInventory = {
  supported: boolean;
  secureContext: boolean;
  /** Video inputs visible BEFORE any grant, and how many of them carried a name. */
  before: { count: number; labelled: number };
  /** Video inputs visible AFTER the grant — this is the real inventory. */
  after: CameraDeviceInfo[];
  /** Distinct groupIds, i.e. how many physical modules the platform admits to. */
  groupCount: number;
  /** True when permission was granted during this probe. */
  granted: boolean;
  error: string | null;
};

const EMPTY_INVENTORY: CameraInventory = {
  supported: false,
  secureContext: false,
  before: { count: 0, labelled: 0 },
  after: [],
  groupCount: 0,
  granted: false,
  error: null,
};

export type StepFn = (step: string, note?: string) => void;

/**
 * Enumerates before the prompt, requests permission, then enumerates again.
 * The temporary grant stream is stopped immediately — this probe exists to
 * read the device list, not to hold the camera open.
 */
export async function probeCameraInventory(facing: "user" | "environment", onStep?: StepFn): Promise<CameraInventory> {
  if (!isDeviceCameraSupported()) {
    return { ...EMPTY_INVENTORY, error: "This browser does not expose navigator.mediaDevices — device-level capture is unavailable." };
  }
  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  let before: { count: number; labelled: number } = { count: 0, labelled: 0 };
  try {
    const pre = await enumerateVideoInputs();
    before = { count: pre.length, labelled: pre.filter((d) => d.label !== "").length };
    onStep?.(
      "enumerateDevices() called BEFORE any permission grant",
      `${before.count} video input${before.count === 1 ? "" : "s"} visible · ${before.labelled} carried a name — browsers blank the label until a grant exists, so a zero here is the privacy rule working, not a missing camera`
    );
  } catch {
    onStep?.("enumerateDevices() failed before the grant", "continuing to the permission request");
  }

  let granted = false;
  try {
    onStep?.("getUserMedia() requested", `facingMode ideal "${facing}" — this is the prompt the user sees; the site holds a live camera track only while the sheet is open`);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing } } });
    granted = true;
    stream.getTracks().forEach((t) => t.stop());
    onStep?.("Permission granted", "grant stream stopped immediately — it existed only to unlock the device list");
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "Error";
    return {
      supported: true,
      secureContext,
      before,
      after: [],
      groupCount: 0,
      granted: false,
      error: `Camera permission was not granted (${name}). Device-level capture needs it; the file-picker engines do not.`,
    };
  }

  const after = await enumerateVideoInputs();
  const groupCount = new Set(after.map((d) => d.groupId).filter(Boolean)).size;
  onStep?.(
    "enumerateDevices() called AFTER the grant",
    `${after.length} camera${after.length === 1 ? "" : "s"} now named: ${after.map((d) => d.label || "(still unnamed)").join(" · ")}`
  );
  return { supported: true, secureContext, before, after, groupCount, granted, error: null };
}

/** Photo-pipeline capabilities, when the browser implements ImageCapture. */
export type PhotoCapabilityReport = {
  supported: boolean;
  maxImageWidth: number | null;
  maxImageHeight: number | null;
  redEyeReduction: string | null;
  fillLightModes: string[];
  error: string | null;
};

type PhotoRange = { min?: number; max?: number; step?: number };
type PhotoCaps = {
  imageWidth?: PhotoRange;
  imageHeight?: PhotoRange;
  redEyeReduction?: string;
  fillLightMode?: string[];
};
type ImageCaptureLike = {
  takePhoto: (settings?: { imageWidth?: number; imageHeight?: number }) => Promise<Blob>;
  getPhotoCapabilities: () => Promise<PhotoCaps>;
};
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

function imageCaptureCtor(): ImageCaptureCtor | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture ?? null;
}

/** An open device-level session: the stream plus everything the platform said about it. */
export type DeviceSession = {
  stream: MediaStream;
  track: MediaStreamTrack;
  device: CameraDeviceInfo | null;
  settings: MediaTrackSettings | null;
  capabilities: MediaTrackCapabilities | null;
  photo: PhotoCapabilityReport;
  /** The track's own label — on WebKit this is the AVCaptureDevice localizedName. */
  trackLabel: string;
};

/**
 * Opens one specific camera by deviceId (or by facing when no id is known),
 * then pushes it to its own reported maximum resolution. Reads back settings,
 * capabilities and photo capabilities so the caller can show — and archive —
 * what the hardware actually granted rather than what was asked for.
 */
export async function openDeviceSession(
  target: { deviceId?: string; facing: "user" | "environment" },
  inventory: CameraDeviceInfo[],
  onStep?: StepFn
): Promise<DeviceSession> {
  const video: MediaTrackConstraints = target.deviceId
    ? { deviceId: { exact: target.deviceId } }
    : { facingMode: { ideal: target.facing } };
  onStep?.(
    "Opening the camera",
    target.deviceId
      ? `deviceId exact — this pins one specific physical camera, the web equivalent of instantiating a single AVCaptureDevice`
      : `facingMode ideal "${target.facing}" — no specific device chosen, the platform picks its default for that side`
  );

  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("The camera opened but produced no video track.");
  }

  // Push to the device's own maximum, then re-read what was actually granted.
  let capabilities: MediaTrackCapabilities | null = null;
  try {
    capabilities = track.getCapabilities?.() ?? null;
  } catch {
    capabilities = null;
  }
  const maxW = (capabilities?.width as PhotoRange | undefined)?.max;
  const maxH = (capabilities?.height as PhotoRange | undefined)?.max;
  if (maxW && maxH) {
    try {
      await track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH } });
      onStep?.("Requested the device maximum", `${maxW}×${maxH} per getCapabilities() — the granted size is read back below, not assumed`);
    } catch {
      onStep?.("Maximum-resolution request refused", "keeping the default granted size");
    }
  }

  let settings: MediaTrackSettings | null = null;
  try {
    settings = track.getSettings?.() ?? null;
  } catch {
    settings = null;
  }

  const activeId = settings?.deviceId ?? target.deviceId ?? null;
  const device = activeId ? (inventory.find((d) => d.deviceId === activeId) ?? null) : null;

  const photo = await readPhotoCapabilities(track);
  onStep?.(
    "Camera open",
    `track "${track.label || "(unnamed)"}" · granted ${settings?.width ?? "?"}×${settings?.height ?? "?"} @ ${settings?.frameRate ? Math.round(settings.frameRate) : "?"}fps · still pipeline ${photo.supported ? `up to ${photo.maxImageWidth ?? "?"}×${photo.maxImageHeight ?? "?"}` : "unavailable (ImageCapture not implemented here)"}`
  );

  return { stream, track, device, settings, capabilities, photo, trackLabel: track.label ?? "" };
}

async function readPhotoCapabilities(track: MediaStreamTrack): Promise<PhotoCapabilityReport> {
  const Ctor = imageCaptureCtor();
  if (!Ctor) {
    return {
      supported: false,
      maxImageWidth: null,
      maxImageHeight: null,
      redEyeReduction: null,
      fillLightModes: [],
      error: "ImageCapture is not implemented in this browser (notably Safari) — stills fall back to a canvas encode.",
    };
  }
  try {
    const caps = await new Ctor(track).getPhotoCapabilities();
    return {
      supported: true,
      maxImageWidth: caps.imageWidth?.max ?? null,
      maxImageHeight: caps.imageHeight?.max ?? null,
      redEyeReduction: caps.redEyeReduction ?? null,
      fillLightModes: caps.fillLightMode ?? [],
      error: null,
    };
  } catch (err) {
    return {
      supported: false,
      maxImageWidth: null,
      maxImageHeight: null,
      redEyeReduction: null,
      fillLightModes: [],
      error: `getPhotoCapabilities() failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** How the still was produced — decides the evidence pack's origin and folder. */
export type StillPath = "image-capture" | "canvas";

export type DeviceStill = {
  blob: Blob;
  path: StillPath;
  width: number;
  height: number;
  /** Why the canvas fallback ran, when it did. */
  fallbackReason: string | null;
};

/**
 * Takes one still. Prefers the platform photo pipeline
 * (`ImageCapture.takePhoto`, the rough analogue of `AVCapturePhotoOutput`),
 * which returns bytes the platform encoded. Falls back to drawing the video
 * frame onto a canvas — bytes this app encoded, which the caller MUST record
 * as such.
 */
export async function takeDeviceStill(session: DeviceSession, video: HTMLVideoElement | null, onStep?: StepFn): Promise<DeviceStill> {
  const Ctor = imageCaptureCtor();
  if (Ctor && session.track.readyState === "live") {
    try {
      const capture = new Ctor(session.track);
      const w = session.photo.maxImageWidth;
      const h = session.photo.maxImageHeight;
      let blob: Blob | null = null;
      if (w && h) {
        try {
          blob = await capture.takePhoto({ imageWidth: w, imageHeight: h });
        } catch {
          onStep?.("takePhoto() rejected the explicit size — retrying at the pipeline default");
        }
      }
      if (!blob) blob = await capture.takePhoto();
      const dims = await readBlobDimensions(blob);
      onStep?.(
        "Still produced by ImageCapture.takePhoto()",
        `${blob.size.toLocaleString("en-US")} bytes · ${dims.width}×${dims.height} · these are the platform's bytes, copied into the archive untouched`
      );
      return { blob, path: "image-capture", width: dims.width, height: dims.height, fallbackReason: null };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      onStep?.("ImageCapture.takePhoto() failed — falling back to a canvas encode", reason);
      return canvasStill(video, reason, onStep);
    }
  }
  return canvasStill(video, session.photo.error ?? "ImageCapture is not available in this browser.", onStep);
}

async function canvasStill(video: HTMLVideoElement | null, reason: string, onStep?: StepFn): Promise<DeviceStill> {
  if (!video || !video.videoWidth || !video.videoHeight) {
    throw new Error("No frame is available to capture yet — wait for the preview to start.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D canvas context to encode the frame.");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95));
  if (!blob) throw new Error("canvas.toBlob() returned nothing.");
  onStep?.(
    "Still encoded by this app from the video frame",
    `${blob.size.toLocaleString("en-US")} bytes · ${canvas.width}×${canvas.height} · NOT a camera file: it is filed under rendered-frames and carries no EXIF by nature`
  );
  return { blob, path: "canvas", width: canvas.width, height: canvas.height, fallbackReason: reason };
}

function readBlobDimensions(blob: Blob): Promise<{ width: number; height: number }> {
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

export function stopSession(session: DeviceSession | null): void {
  if (!session) return;
  session.stream.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      // already stopped
    }
  });
}

/** One-line summary of a camera for chips, logs and the ledger. */
export function describeDevice(d: CameraDeviceInfo): string {
  const name = d.label || "(unnamed camera)";
  if (!d.classified) return `${name} — label withheld or unrecognised, so no lens class is claimed`;
  return `${name} — ${lensClassLabel(d.lensClass)}${d.isVirtual ? ", fused multi-lens" : ""}, ${d.facing} · ${AV_DEVICE_TYPE[d.lensClass]}`;
}

/**
 * The full device-inventory write-up for the evidence pack and the log. States
 * what was learned before the grant, after it, and what the web platform
 * withholds compared with native AVFoundation.
 */
export function inventoryReport(inv: CameraInventory, session: DeviceSession | null, still: DeviceStill | null): string {
  const lines: string[] = [
    "DEVICE-LEVEL CAMERA INVENTORY",
    "=".repeat(70),
    `Read at ${new Date().toISOString()}`,
    "",
    "WHAT THIS PATH IS",
    "  navigator.mediaDevices.enumerateDevices() + getUserMedia() + MediaStreamTrack",
    "  .getCapabilities() + ImageCapture. On iOS and macOS WebKit these are",
    "  implemented on top of AVFoundation, and the device names below are",
    "  AVCaptureDevice.localizedName strings. This is a shim over AVFoundation,",
    "  not AVFoundation itself: no format list, no lens switch-over factors, no",
    "  RAW, no depth data. Those exist only in a native app.",
    "",
    "BEFORE THE PERMISSION PROMPT",
    `  Video inputs visible: ${inv.before.count}`,
    `  Of those, carrying a name: ${inv.before.labelled}`,
    "  Browsers blank device labels until a grant exists, to prevent silent",
    "  hardware fingerprinting. A count without names is the privacy rule",
    "  working as designed, not a fault.",
    "",
  ];

  if (!inv.granted) {
    lines.push("AFTER THE PERMISSION PROMPT", `  Not granted. ${inv.error ?? "No reason reported."}`, "");
    return lines.join("\n");
  }

  lines.push(
    "AFTER THE PERMISSION PROMPT",
    `  Cameras named: ${inv.after.length}`,
    `  Distinct hardware groups (groupId): ${inv.groupCount}`,
    ""
  );
  inv.after.forEach((d, i) => {
    lines.push(
      `  [${i + 1}] ${d.label || "(still unnamed)"}`,
      `      facing        : ${d.facing}${d.classified ? "" : " (not stated by the label — not a reading)"}`,
      `      lens class    : ${lensClassLabel(d.lensClass)}${d.isVirtual ? " — virtual device fusing several physical lenses" : ""}`,
      `      AVFoundation  : ${AV_DEVICE_TYPE[d.lensClass]}`,
      `      deviceId      : ${d.deviceId ? `${d.deviceId.slice(0, 16)}… (origin-scoped, resets when cookies are cleared)` : "(none)"}`,
      `      groupId       : ${d.groupId ? `${d.groupId.slice(0, 16)}…` : "(none)"}`,
      ""
    );
  });

  if (session) {
    const s = session.settings;
    const caps = session.capabilities as (MediaTrackCapabilities & { zoom?: PhotoRange; torch?: boolean }) | null;
    lines.push(
      "THE CAMERA THAT WAS USED",
      `  Track label   : ${session.trackLabel || "(unnamed)"}`,
      `  Granted size  : ${s?.width ?? "?"}×${s?.height ?? "?"} @ ${s?.frameRate ? `${Math.round(s.frameRate)}fps` : "? fps"}`,
      `  Reported max  : ${(caps?.width as PhotoRange | undefined)?.max ?? "?"}×${(caps?.height as PhotoRange | undefined)?.max ?? "?"}`,
      `  facingMode    : ${s?.facingMode ?? "not reported"}`,
      `  Zoom range    : ${caps?.zoom ? `${caps.zoom.min ?? "?"}–${caps.zoom.max ?? "?"}` : "not exposed"}`,
      `  Torch         : ${caps?.torch === true ? "controllable" : "not exposed"}`,
      `  Photo pipeline: ${session.photo.supported ? `ImageCapture up to ${session.photo.maxImageWidth ?? "?"}×${session.photo.maxImageHeight ?? "?"}` : `unavailable — ${session.photo.error ?? "no reason reported"}`}`,
      ""
    );
  }

  if (still) {
    lines.push(
      "HOW THE STILL WAS PRODUCED",
      still.path === "image-capture"
        ? "  ImageCapture.takePhoto() — the browser's own photo pipeline encoded these"
        : "  Canvas encode — THIS APP drew the video frame and encoded the JPEG",
      still.path === "image-capture"
        ? "  bytes. Archived under originals/ as a platform still. Browsers usually"
        : "  bytes. Archived under rendered-frames/, never originals/, because the",
      still.path === "image-capture"
        ? "  write little or no EXIF on this path, so sparse metadata here is normal."
        : "  app authored them. A canvas encode cannot carry camera EXIF at all.",
      `  Pixels: ${still.width}×${still.height} · ${still.blob.size.toLocaleString("en-US")} bytes`,
      still.fallbackReason ? `  Fallback reason: ${still.fallbackReason}` : "",
      ""
    );
  }

  lines.push(
    "WHAT THIS PATH CANNOT GIVE YOU",
    "  - Camera EXIF. No browser writes Make/Model/LensModel/GPS on a",
    "    getUserMedia still, so the EXIF-based lens and timestamp checks that",
    "    run on OS-camera-app files have nothing to read here. That is a",
    "    property of the web platform, not evidence about this capture.",
    "  - Sensor-native resolution. Video tracks are typically capped well below",
    "    the still-photo sensor size the camera app would use.",
    "  - Per-format detail: supported photo dimensions per lens, switch-over",
    "    zoom factors, ISO/exposure duration ranges, RAW, depth. AVFoundation",
    "    exposes these to native apps; the web platform does not expose them.",
    ""
  );
  return lines.join("\n");
}
