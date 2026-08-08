import { useSyncExternalStore } from "react";
import { Camera, CameraDirection, CameraResultType, CameraSource } from "@capacitor/camera";

import { auditFileInputIntegrity } from "@/lib/injection-guard";

/**
 * Capture-engine setting: which pipeline launches the phone camera for
 * native (non-getUserMedia) captures. Selected in settings, persisted
 * locally, applied to every native-camera launch point in the app.
 *
 * - "native-camera"  — direct `<input capture>`: the OS camera app opens and
 *   the original file returns; every provenance fact is observed first-hand.
 * - "system-picker"  — plain `<input type=file>` with NO capture attribute:
 *   iOS shows the UIImagePickerController-style sheet (Photo Library /
 *   Take Photo / Choose File). Library picks are allowed and judged by the
 *   file-age + EXIF forensics.
 * - "capacitor"      — Capacitor's `Camera.getPhoto()` with `webUseInput`:
 *   Capacitor drives its own hidden input (#_capacitor-camera-input). The
 *   original File and the change event's trust are intercepted at Capacitor's
 *   input at event time, so EXIF bytes, file name, lastModified and
 *   event-trust provenance all stay first-hand.
 * - "capture-boolean" — bare boolean `capture` attribute (the original HTML
 *   Media Capture form, no facing value): the browser picks which camera UI
 *   to open. Some Android browsers treat it differently from capture="user"/
 *   "environment".
 * - "legacy-accept"   — pre-standard `accept="image/*;capture=camera"` MIME
 *   parameter syntax (old Android/BlackBerry drafts). Modern browsers ignore
 *   the parameter and show the picker — running it documents exactly how the
 *   current device honors the legacy hint.
 * - "fs-picker"       — File System Access API `showOpenFilePicker()`
 *   (Chromium-only): the native OS file picker returns a real file handle;
 *   no camera hint is possible, and no change event exists on this path.
 * - "avfoundation"    — device-level capture: enumerateDevices() names every
 *   camera, getUserMedia opens one specific physical camera by id, and
 *   ImageCapture takes the still. On WebKit this stack is implemented on
 *   AVFoundation and the device names are AVCaptureDevice.localizedName
 *   values. Richest live hardware inventory, poorest file metadata — no
 *   browser writes camera EXIF on this path.
 */
export type CaptureEngine =
  | "native-camera"
  | "system-picker"
  | "capacitor"
  | "capture-boolean"
  | "legacy-accept"
  | "fs-picker"
  | "avfoundation";

const STORAGE_KEY = "vh-capture-engine-v1";

export type CaptureEngineOption = {
  id: CaptureEngine;
  label: string;
  short: string;
  description: string;
};

export const CAPTURE_ENGINE_OPTIONS: CaptureEngineOption[] = [
  {
    id: "native-camera",
    label: "Native camera app",
    short: "native input",
    description:
      "Direct <input capture> — the OS camera app opens, the original file returns with full EXIF, and every provenance fact (trusted change event, files-API integrity, visibility takeover) is observed first-hand. Default.",
  },
  {
    id: "system-picker",
    label: "System picker",
    short: "system picker",
    description:
      "Plain <input type=file> with no capture attribute — iOS shows the UIImagePickerController-style sheet (Photo Library / Take Photo / Choose File). Library picks are allowed here; the file-age and EXIF forensics decide whether the photo is fresh.",
  },
  {
    id: "capacitor",
    label: "Capacitor Camera",
    short: "Capacitor",
    description:
      "Capacitor's Camera.getPhoto() (webUseInput) drives its own hidden input. The original file AND the change event's trust are intercepted at Capacitor's input at event time, so EXIF bytes and provenance stay first-hand while the Capacitor API does the launching.",
  },
  {
    id: "capture-boolean",
    label: "Bare capture attr",
    short: "bare capture",
    description:
      "Bare boolean <input capture> — the original HTML Media Capture form with no facing value. The browser decides which camera UI opens (some Android browsers behave differently from capture=\"user\"/\"environment\"). Lens is still verified after capture via EXIF.",
  },
  {
    id: "legacy-accept",
    label: "Legacy accept hint",
    short: "legacy accept",
    description:
      "Pre-standard accept=\"image/*;capture=camera\" MIME-parameter syntax (old Android/BlackBerry spec drafts), with NO capture attribute. Modern browsers ignore the parameter and show the picker — the observed behavior documents exactly how this device honors the legacy hint.",
  },
  {
    id: "fs-picker",
    label: "FS Access picker",
    short: "showOpenFilePicker",
    description:
      "File System Access API showOpenFilePicker() (Chromium-only) — the native OS file picker returns a real file handle with original bytes, name, and lastModified intact. No camera hint is possible and no change event exists on this path, so event-trust facts are recorded as not observable, never invented.",
  },
  {
    id: "avfoundation",
    label: "AVFoundation (device-level)",
    short: "device-level",
    description:
      "enumerateDevices() names every camera on the device, getUserMedia opens one specific physical camera by id, and ImageCapture takes the still. On iOS and macOS WebKit this stack runs on AVFoundation and the names you see are AVCaptureDevice.localizedName strings. The most hardware information of any engine — and the least file metadata: no browser writes camera EXIF here, so these stills are archived as platform output, never as camera files.",
  },
];

/** How completely an engine delivers one kind of information. */
export type EngineTrait = "full" | "partial" | "none";

/**
 * Exactly what each engine asks of the user and what the website receives in
 * return. Kept as data rather than prose so the comparison UI, the session log
 * and the evidence pack all describe the engines identically — and so a claim
 * only has to be corrected in one place.
 */
export type EngineFacts = {
  /** What the user is prompted with, and who prompts them. */
  permissionPrompt: string;
  /** What the website itself ends up holding once the user agrees. */
  siteGrant: string;
  /** True when the site needs the browser's camera permission and holds a live track. */
  needsCameraPermission: boolean;
  /** Does the site learn which cameras exist, independently of any photo? */
  deviceInventory: EngineTrait;
  /** What hardware naming the site receives, and when. */
  deviceNaming: string;
  /** Live control over the sensor: pinning a lens, resolution, zoom, torch. */
  liveControl: EngineTrait;
  /** How much metadata arrives attached to the bytes. */
  metadata: EngineTrait;
  metadataDetail: string;
  /** Where the bytes come from, in the words the evidence pack uses. */
  bytes: string;
  /** The nearest native iOS equivalent of this pipeline. */
  nativeEquivalent: string;
  /** True when the user can hand over an existing photo instead of taking one. */
  allowsLibraryPick: boolean;
};

const NO_BROWSER_PROMPT =
  "None from the browser. The OS camera app opens and manages its own camera permission, which the user may already have granted to the system.";

export const ENGINE_FACTS: Record<CaptureEngine, EngineFacts> = {
  "native-camera": {
    permissionPrompt: NO_BROWSER_PROMPT,
    siteGrant: "One image file. The website never touches the camera and cannot see a live feed.",
    needsCameraPermission: false,
    deviceInventory: "none",
    deviceNaming:
      "Nothing live. But the returned photo's EXIF usually names the exact lens that fired — e.g. \"iPhone 15 Pro back triple camera 6.765mm f/1.78\" — which identifies the physical optic more precisely than any live label does.",
    liveControl: "none",
    metadata: "full",
    metadataDetail:
      "Full EXIF as the camera wrote it: make, model, lens, focal length, aperture, ISO, exposure, orientation, capture timestamp, and GPS when the user has it enabled.",
    bytes: "A camera file from the OS camera app — archived under originals/.",
    nativeEquivalent: "UIImagePickerController with sourceType .camera — the system camera app, running outside your process.",
    allowsLibraryPick: false,
  },
  "system-picker": {
    permissionPrompt:
      "None from the browser. iOS shows its own sheet offering Photo Library, Take Photo or Choose File; only the Take Photo branch involves the camera.",
    siteGrant: "One image file, which may be a fresh photo or an existing one.",
    needsCameraPermission: false,
    deviceInventory: "none",
    deviceNaming:
      "Nothing live. Whatever EXIF the chosen file happens to carry — which may be a camera's, an editor's, or nothing at all.",
    liveControl: "none",
    metadata: "partial",
    metadataDetail:
      "Whatever the chosen file arrived with. A fresh camera photo brings full EXIF; a screenshot or a re-saved image may bring almost none.",
    bytes: "A file supplied from storage — archived under originals/, with no claim that it is fresh.",
    nativeEquivalent: "PHPickerViewController / UIImagePickerController with sourceType .photoLibrary.",
    allowsLibraryPick: true,
  },
  capacitor: {
    permissionPrompt: NO_BROWSER_PROMPT,
    siteGrant: "One image file, recovered from Capacitor's own hidden input before Capacitor rewrites it.",
    needsCameraPermission: false,
    deviceInventory: "none",
    deviceNaming: "Nothing live — same as the native camera engine, since running as a website this is a file input underneath.",
    liveControl: "none",
    metadata: "full",
    metadataDetail:
      "Full EXIF, provided the original File is intercepted at Capacitor's input. If interception misses, the bytes are rebuilt from a blob URL and the name and timestamp are synthesised — which this app reports rather than hides.",
    bytes: "A camera file from the OS camera app — archived under originals/.",
    nativeEquivalent:
      "In a compiled Capacitor app this plugin calls UIImagePickerController and AVFoundation directly. Running as a website, webUseInput makes it drive a hidden file input instead — so here it is the native-camera path with Capacitor's API on top.",
    allowsLibraryPick: false,
  },
  "capture-boolean": {
    permissionPrompt: NO_BROWSER_PROMPT,
    siteGrant: "One image file, from whichever camera UI the browser decided to open.",
    needsCameraPermission: false,
    deviceInventory: "none",
    deviceNaming: "Nothing live. EXIF after the fact, as with the native camera engine.",
    liveControl: "none",
    metadata: "full",
    metadataDetail: "Full EXIF when the OS camera app supplies the file, exactly as the native-camera engine.",
    bytes: "A camera file from the OS camera app — archived under originals/.",
    nativeEquivalent: "UIImagePickerController with sourceType .camera and no camera-device preference set.",
    allowsLibraryPick: false,
  },
  "legacy-accept": {
    permissionPrompt:
      "None from the browser. Modern browsers ignore the legacy hint and show the ordinary picker, so the user sees the same sheet as the system-picker engine.",
    siteGrant: "One image file, usually chosen rather than taken.",
    needsCameraPermission: false,
    deviceInventory: "none",
    deviceNaming: "Nothing live. Whatever EXIF the chosen file carries.",
    liveControl: "none",
    metadata: "partial",
    metadataDetail: "Whatever the chosen file arrived with — this engine exists to document how the device treats the obsolete hint, not to maximise metadata.",
    bytes: "A file supplied from storage — archived under originals/, with no claim that it is fresh.",
    nativeEquivalent: "No modern equivalent; this mirrors pre-standard Android and BlackBerry drafts.",
    allowsLibraryPick: true,
  },
  "fs-picker": {
    permissionPrompt: "A file-access prompt from the OS file picker. No camera is involved at any point.",
    siteGrant: "A file handle, which this app reads once. No camera access whatsoever.",
    needsCameraPermission: false,
    deviceInventory: "none",
    deviceNaming: "Nothing — this engine cannot reach a camera, only stored files.",
    liveControl: "none",
    metadata: "partial",
    metadataDetail: "Whatever the stored file carries, with its real name and last-modified time intact from the filesystem.",
    bytes: "A file supplied from storage — archived under originals/, with no claim that it is fresh.",
    nativeEquivalent: "UIDocumentPickerViewController.",
    allowsLibraryPick: true,
  },
  avfoundation: {
    permissionPrompt:
      "The browser's own camera prompt — \"Allow this site to use your camera?\". This is the only engine that asks for it, and the only one where the website itself holds a live camera track.",
    siteGrant:
      "A live video track plus the full camera inventory: every camera's name, a stable per-site id for each, which hardware group each belongs to, the resolution and frame-rate ranges each supports, and zoom or torch control where the platform allows it.",
    needsCameraPermission: true,
    deviceInventory: "full",
    deviceNaming:
      "Every camera by name, live and before any photo is taken — on iOS these are AVCaptureDevice.localizedName strings such as \"Back Dual Wide Camera\", \"Back Ultra Wide Camera\", \"Back Telephoto Camera\", \"Front Camera\" and \"Desk View Camera\"; on Android, entries like \"camera2 0, facing back\"; on desktop, the USB product name. Names appear only after permission is granted — before that the browser reports a count with the labels blanked.",
    liveControl: "full",
    metadata: "none",
    metadataDetail:
      "No camera EXIF at all. No browser writes make, model, lens, GPS or a capture timestamp onto a getUserMedia still, so every EXIF-based check has nothing to read. This app records that as unavailable rather than counting it against the capture — but it does mean the metadata half of the forensics goes quiet on this engine.",
    bytes:
      "A platform still from ImageCapture.takePhoto() — archived under originals/. If this browser has no ImageCapture (Safari), the frame is encoded by this app instead and archived under rendered-frames/, never presented as camera output.",
    nativeEquivalent:
      "AVCaptureDevice.DiscoverySession + AVCaptureSession + AVCapturePhotoOutput. On WebKit this really is that stack underneath — but the web platform withholds the format list, lens switch-over factors, exposure and ISO ranges, RAW and depth.",
    allowsLibraryPick: false,
  },
};

export function engineFacts(engine: CaptureEngine): EngineFacts {
  return ENGINE_FACTS[engine] ?? ENGINE_FACTS["native-camera"];
}

/** True when this engine opens a live camera the site can inspect, rather than handing off to a picker. */
export function isDeviceLevelEngine(engine: CaptureEngine): boolean {
  return engine === "avfoundation";
}

/** Compact one-line description of the permission/information trade, for logs and the evidence pack. */
export function engineTradeSummary(engine: CaptureEngine): string {
  const f = engineFacts(engine);
  const inventory =
    f.deviceInventory === "full" ? "names every camera" : f.deviceInventory === "partial" ? "names some cameras" : "no camera inventory";
  const meta = f.metadata === "full" ? "full EXIF" : f.metadata === "partial" ? "whatever EXIF the file carries" : "no camera EXIF";
  return `${engineOption(engine).label}: ${f.needsCameraPermission ? "browser camera permission required" : "no browser camera permission"} · ${inventory} · ${meta}`;
}

function isEngine(v: unknown): v is CaptureEngine {
  return CAPTURE_ENGINE_OPTIONS.some((o) => o.id === v);
}

/**
 * The `capture` attribute value a hidden input should carry for this engine.
 * true = bare boolean attribute; undefined = no attribute (picker paths).
 */
export function inputCaptureAttr(engine: CaptureEngine, facing: "user" | "environment"): boolean | "user" | "environment" | undefined {
  switch (engine) {
    case "native-camera":
      return facing;
    case "capture-boolean":
      return true;
    default:
      return undefined;
  }
}

/**
 * True when this engine bypasses the hidden file input entirely and runs its
 * own capture pipeline. Callers must branch on it before clicking an input.
 */
export function usesOwnPipeline(engine: CaptureEngine): boolean {
  return engine === "capacitor" || engine === "fs-picker" || engine === "avfoundation";
}

/** The `accept` attribute for this engine — the legacy engine embeds the pre-standard capture=camera MIME parameter. */
export function inputAcceptAttr(engine: CaptureEngine): string {
  return engine === "legacy-accept" ? "image/*;capture=camera" : "image/*";
}

/** Human note describing what launching a hidden input does under this engine — used in logs and ledger steps. */
export function engineLaunchNote(engine: CaptureEngine, facing: "user" | "environment"): string {
  switch (engine) {
    case "native-camera":
      return `OS camera opening (capture="${facing}")`;
    case "system-picker":
      return "system picker opening (no capture attribute; UIImagePickerController-style sheet)";
    case "capture-boolean":
      return "bare boolean capture attribute — the browser chooses the camera UI (no facing value in HTML; lens verified after capture via EXIF)";
    case "legacy-accept":
      return 'legacy accept="image/*;capture=camera" hint (no capture attribute) — modern browsers are expected to ignore the parameter and show the picker; the observed behavior is the finding';
    case "capacitor":
      return "Capacitor Camera.getPhoto() (webUseInput)";
    case "fs-picker":
      return "File System Access showOpenFilePicker() — native OS file picker, no camera hint possible";
    case "avfoundation":
      return `device-level capture — enumerateDevices() names every camera, then one specific ${facing === "user" ? "front" : "back"} camera is opened by deviceId and the still comes from the browser's photo pipeline (no camera EXIF exists on this path)`;
  }
}

function load(): CaptureEngine {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isEngine(raw) ? raw : "native-camera";
  } catch {
    return "native-camera";
  }
}

let current: CaptureEngine = load();
const listeners = new Set<() => void>();

export function getCaptureEngine(): CaptureEngine {
  return current;
}

export function setCaptureEngine(engine: CaptureEngine): void {
  current = engine;
  try {
    window.localStorage.setItem(STORAGE_KEY, engine);
  } catch {
    // private mode — setting still applies for this session
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: the currently selected capture engine (re-renders on change from anywhere). */
export function useCaptureEngine(): CaptureEngine {
  return useSyncExternalStore(subscribe, getCaptureEngine, getCaptureEngine);
}

export function engineOption(engine: CaptureEngine): CaptureEngineOption {
  return CAPTURE_ENGINE_OPTIONS.find((o) => o.id === engine) ?? CAPTURE_ENGINE_OPTIONS[0];
}

/** Thrown when the user closes the camera/picker without taking a photo. */
export class CaptureCancelledError extends Error {
  constructor() {
    super("Capture cancelled — the camera/picker was closed without a photo.");
    this.name = "CaptureCancelledError";
  }
}

export type CapacitorCaptureResult = {
  /** The captured File — original bytes when interceptedOriginal is true. */
  file: File;
  /** isTrusted of the change event observed on Capacitor's own hidden input. undefined = interception missed (not observable). */
  changeIsTrusted?: boolean;
  /** files-API integrity audited on Capacitor's input at event time. undefined = interception missed. */
  filesApiNative?: boolean;
  filesApiObserved?: string;
  /** true = original File taken straight from #_capacitor-camera-input (EXIF bytes, name, lastModified intact). false = reconstructed from webPath (name/lastModified synthesized). */
  interceptedOriginal: boolean;
  format: string | null;
};

const CAPACITOR_INPUT_ID = "_capacitor-camera-input";

type FsFileHandle = { getFile: () => Promise<File> };
type FsPickerFn = (options?: {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FsFileHandle[]>;

/** True when this browser exposes the File System Access API picker (Chromium-only, secure context). */
export function isFsPickerSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";
}

export type FsPickerCaptureResult = {
  /** Original File from the OS file handle — bytes, name, and lastModified intact. */
  file: File;
};

/**
 * Launches the File System Access API picker (showOpenFilePicker) for a
 * single image. The returned File comes straight from the OS file handle, so
 * EXIF bytes, name, and lastModified are first-hand. There is no change
 * event on this path — callers must record event-trust facts as not
 * observable rather than inventing them. Cancellation (AbortError) maps to
 * CaptureCancelledError; unsupported browsers get an explicit error.
 */
export async function fsPickerCapturePhoto(onStep?: (step: string, note?: string) => void): Promise<FsPickerCaptureResult> {
  if (!isFsPickerSupported()) {
    throw new Error(
      "showOpenFilePicker is not supported in this browser — the File System Access API is Chromium-only (Chrome/Edge, secure context). Switch the capture engine to another option."
    );
  }
  const picker = (window as unknown as { showOpenFilePicker: FsPickerFn }).showOpenFilePicker;
  onStep?.("showOpenFilePicker() invoked", "File System Access API · single image · no camera hint exists on this API");
  try {
    const handles = await picker({
      multiple: false,
      types: [
        {
          description: "Images",
          accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp", ".tif", ".tiff"] },
        },
      ],
    });
    const handle = handles[0];
    if (!handle) throw new CaptureCancelledError();
    const file = await handle.getFile();
    onStep?.(
      "File handle resolved to original File",
      `"${file.name}" · ${file.size.toLocaleString("en-US")} bytes · lastModified ${new Date(file.lastModified).toISOString()} — no change event exists on this path; event-trust facts not observable`
    );
    return { file };
  } catch (err) {
    if (err instanceof CaptureCancelledError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") throw new CaptureCancelledError();
    throw err;
  }
}

/**
 * Launches Capacitor's Camera.getPhoto() (webUseInput) and intercepts the
 * change event on Capacitor's own hidden input in the capture phase, BEFORE
 * Capacitor's listener runs. This recovers the original File object (full
 * EXIF bytes, real name, real lastModified) plus the event-trust and
 * files-API facts the forensic engine needs — nothing is inferred.
 *
 * Cancellation (Capacitor rejects with "User cancelled photos app") maps to
 * CaptureCancelledError.
 */
export async function capacitorCapturePhoto(
  facing: "user" | "environment" | null,
  onStep?: (step: string, note?: string) => void
): Promise<CapacitorCaptureResult> {
  let intercepted: { file: File | null; trusted: boolean; filesApiNative: boolean; observed: string } | null = null;
  const onChange = (ev: Event) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "file" || t.id !== CAPACITOR_INPUT_ID) return;
    const audit = auditFileInputIntegrity(t);
    intercepted = {
      file: t.files?.[0] ?? null,
      trusted: ev.isTrusted === true,
      filesApiNative: audit.native,
      observed: audit.observed,
    };
    onStep?.(
      "Change event intercepted on Capacitor's hidden input (#_capacitor-camera-input)",
      `isTrusted=${ev.isTrusted === true} · files API ${audit.native ? "native" : `wrapped (${audit.observed})`}`
    );
  };
  document.addEventListener("change", onChange, true);
  onStep?.(
    "Capacitor Camera.getPhoto() invoked",
    `webUseInput=true · direction=${facing == null ? "NOT SENT — the phone chooses" : facing === "user" ? "FRONT" : "REAR"} · source=CAMERA · resultType=uri`
  );
  try {
    // A null facing omits `direction` entirely rather than defaulting to the
    // rear. Sending a default here would silently answer the question the
    // unnamed shot exists to ask — which camera this phone opens when a page
    // asks for none.
    const photo = await Camera.getPhoto({
      quality: 100,
      allowEditing: false,
      correctOrientation: false,
      resultType: CameraResultType.Uri,
      source: CameraSource.Camera,
      ...(facing == null ? {} : { direction: facing === "user" ? CameraDirection.Front : CameraDirection.Rear }),
      webUseInput: true,
      saveToGallery: false,
    });
    const hit: { file: File | null; trusted: boolean; filesApiNative: boolean; observed: string } | null = intercepted;
    if (hit?.file) {
      onStep?.(
        "Original file recovered from Capacitor's input",
        `"${hit.file.name}" · ${hit.file.size.toLocaleString("en-US")} bytes — EXIF bytes, name and lastModified intact`
      );
      return {
        file: hit.file,
        changeIsTrusted: hit.trusted,
        filesApiNative: hit.filesApiNative,
        filesApiObserved: hit.observed,
        interceptedOriginal: true,
        format: photo.format ?? null,
      };
    }
    if (photo.webPath) {
      onStep?.(
        "Interception missed — reconstructing the file from Camera.getPhoto's webPath",
        "Image bytes are Capacitor's blob of the original; name/lastModified are synthesized and event-trust facts were NOT observable"
      );
      const blob = await fetch(photo.webPath).then((r) => r.blob());
      const ext = photo.format === "png" ? "png" : photo.format === "gif" ? "gif" : "jpg";
      const file = new File([blob], `capacitor-photo-${Date.now()}.${ext}`, { type: blob.type || "image/jpeg" });
      return { file, interceptedOriginal: false, format: photo.format ?? null };
    }
    throw new Error("Capacitor Camera returned no usable photo data (no webPath).");
  } catch (err) {
    if (err instanceof Error && /cancell?ed/i.test(err.message)) throw new CaptureCancelledError();
    throw err;
  } finally {
    document.removeEventListener("change", onChange, true);
  }
}
