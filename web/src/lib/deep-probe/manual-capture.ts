/**
 * Stage four — the photos you take yourself.
 *
 * The automated sweep produces a lot of files and almost no metadata: every
 * browser strips (or never writes) camera EXIF on a `getUserMedia` still. The
 * only way to obtain a file with the camera's own tags in it is to hand off to
 * the operating system's camera app and take the picture there. That is what
 * this module does, once per handoff, so the archive contains both kinds of
 * evidence and can show the difference between them.
 *
 * Three separate handoffs are used because they are genuinely different code
 * paths, not three names for one thing — and on some devices they return files
 * that differ in name, timestamp and even encoder. Each returned file is
 * declared `camera-file` only where the engine really does open the camera app;
 * picker-based engines are never allowed to claim that.
 *
 * The stage also takes two LIBRARY picks, which are the opposite kind of
 * evidence and are filed as such. A pick cannot promise a fresh photo, so it is
 * never offered as one — but it is the only way to see what an ordinary upload
 * form receives from the photo library, and the brief's central comparison
 * (canvas path = no EXIF, file path = the full tag set) has no second half
 * without it.
 *
 * The two picks differ only in their `accept` attribute, and that difference is
 * the measurement. iOS transcodes HEIC to JPEG for an input that asks for
 * `image/*`, and hands over the stored bytes to one that names HEIC explicitly.
 * Asking twice for the same photo shows whether this device does that, which is
 * the only direct evidence available for the Photos storage setting — and it
 * separates "the library holds JPEG" from "the library holds HEIC and the
 * browser converted it on the way in", two situations that look identical from
 * a single upload.
 */

import { CaptureCancelledError, capacitorCapturePhoto, inputAcceptAttr, inputCaptureAttr, type CaptureEngine } from "../capture-engine";
import type { PackOrigin } from "../evidence-pack";

export type ManualShotSpec = {
  id: string;
  /** What the shot is for — shown before the camera opens. */
  purpose: string;
  engine: CaptureEngine;
  /** Null on the library picks, where a facing would be a fiction. */
  facing: "user" | "environment" | null;
  /**
   * Where the file comes from. `camera-app` hands off to the OS camera and the
   * file is fresh; `library` opens the picker and the file is whatever was
   * already stored. The two are never filed as each other.
   */
  source: "camera-app" | "library";
  /** Overrides the engine's default accept attribute. The library picks rely on this. */
  accept?: string;
};

export type ManualShotResult = {
  file: File;
  origin: PackOrigin;
  /** The declared production path, decided by the spec rather than by the caller. */
  path: "camera-file" | "picker-file";
  /** Whether the change event carried browser trust. Undefined = not observable on this path. */
  changeIsTrusted?: boolean;
  engine: CaptureEngine;
};

/**
 * The three engines that hand off to the phone's own camera app, in the order
 * they are offered. Each is a distinct pipeline: a direct `capture` attribute,
 * the bare boolean form of that attribute, and Capacitor driving its own hidden
 * input. Picker-only engines are deliberately excluded from this stage — they
 * cannot promise a fresh photo, so asking for one here would be misleading.
 */
export const CAMERA_APP_ENGINES: CaptureEngine[] = ["native-camera", "capture-boolean", "capacitor"];

/**
 * Opens the OS camera app through a hidden file input and resolves with the
 * file it returns. The change event's trust flag is captured at event time
 * rather than reconstructed afterwards.
 */
function fileInputCapture(spec: ManualShotSpec): Promise<ManualShotResult> {
  const { engine, facing, source } = spec;
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = spec.accept ?? inputAcceptAttr(engine);
    // A library pick must never carry a capture attribute: that attribute is
    // what turns the picker into a camera, and this shot is asking for the
    // opposite of a fresh photo.
    const capture = source === "camera-app" && facing != null ? inputCaptureAttr(engine, facing) : undefined;
    if (capture === true) input.setAttribute("capture", "");
    else if (typeof capture === "string") input.setAttribute("capture", capture);
    input.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0";
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => {
      window.removeEventListener("focus", onFocus);
      input.remove();
    };

    const onChange = (ev: Event) => {
      if (settled) return;
      const file = input.files?.[0] ?? null;
      if (!file) return;
      settled = true;
      const trusted = ev.isTrusted === true;
      cleanup();
      resolve({
        file,
        origin: source === "camera-app" ? "camera-file" : "supplied-file",
        path: source === "camera-app" ? "camera-file" : "picker-file",
        changeIsTrusted: trusted,
        engine,
      });
    };

    // Returning to the page with no file means the camera was closed empty.
    let focusGrace: number | null = null;
    const onFocus = () => {
      if (settled) return;
      if (focusGrace != null) window.clearTimeout(focusGrace);
      focusGrace = window.setTimeout(() => {
        if (settled) return;
        if ((input.files?.length ?? 0) === 0) {
          settled = true;
          cleanup();
          reject(new CaptureCancelledError());
        }
      }, 1200);
    };

    input.addEventListener("change", onChange);
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

/** Runs one manual shot through whichever engine the spec names. */
export async function runManualShot(spec: ManualShotSpec): Promise<ManualShotResult> {
  if (spec.engine === "capacitor" && spec.source === "camera-app") {
    const result = await capacitorCapturePhoto(spec.facing ?? "environment");
    return {
      file: result.file,
      origin: "camera-file",
      path: "camera-file",
      changeIsTrusted: result.changeIsTrusted,
      engine: spec.engine,
    };
  }
  return fileInputCapture(spec);
}

/**
 * The two library picks. Same request, different `accept` — the first is what
 * an ordinary upload form asks for, the second names HEIC so the device has no
 * reason to convert. Picking the same photo twice is what makes the pair
 * readable, so the wording asks for exactly that.
 */
export const LIBRARY_PICK_SHOTS: ManualShotSpec[] = [
  {
    id: "library-plain",
    engine: "system-picker",
    facing: null,
    source: "library",
    accept: "image/*",
    purpose:
      "Pick any existing photo from your library — one taken by this phone's camera app, ideally a recent one. This is the plain upload path every website uses, and unlike the sweep's frames the file arrives with whatever metadata the camera originally wrote. Nothing about it is treated as a fresh photo: it is filed as a library pick, because that is all it can be.",
  },
  {
    id: "library-original",
    engine: "system-picker",
    facing: null,
    source: "library",
    accept: "image/*,image/heic,image/heif,.heic,.heif",
    purpose:
      "Now pick the SAME photo again. The only difference is that this request names HEIC, so the phone has no reason to convert it on the way in. If the first file came back JPEG and this one comes back HEIC, you have just watched the browser transcode your photo — which is the one honest way to tell whether the library really holds JPEG or holds HEIC and hides it from ordinary upload forms.",
  },
];

/** Builds the full manual shot list for the run: both facings through every camera-app handoff. */
export function buildManualShotList(): ManualShotSpec[] {
  // Library picks lead: they need no camera, no permission and no good light,
  // and they close the one requested item that nothing else in the run can.
  const shots: ManualShotSpec[] = [...LIBRARY_PICK_SHOTS];
  const engineName: Record<string, string> = {
    "native-camera": "the direct capture attribute",
    "capture-boolean": "the bare boolean capture attribute",
    capacitor: "Capacitor's camera API",
  };
  for (const engine of CAMERA_APP_ENGINES) {
    for (const facing of ["environment", "user"] as const) {
      shots.push({
        id: `${engine}-${facing}`,
        engine,
        facing,
        source: "camera-app",
        purpose: `${facing === "environment" ? "Back" : "Front"} camera via ${engineName[engine] ?? engine}. This one goes through the phone's own camera app, so the file should come back with real camera metadata attached — that is the whole point of taking it by hand.`,
      });
    }
  }
  return shots;
}
