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
 */

import { CaptureCancelledError, capacitorCapturePhoto, inputAcceptAttr, inputCaptureAttr, type CaptureEngine } from "../capture-engine";
import type { PackOrigin } from "../evidence-pack";

export type ManualShotSpec = {
  id: string;
  /** What the shot is for — shown before the camera opens. */
  purpose: string;
  engine: CaptureEngine;
  facing: "user" | "environment";
};

export type ManualShotResult = {
  file: File;
  origin: PackOrigin;
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
function fileInputCapture(engine: CaptureEngine, facing: "user" | "environment"): Promise<ManualShotResult> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = inputAcceptAttr(engine);
    const capture = inputCaptureAttr(engine, facing);
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
      resolve({ file, origin: "camera-file", changeIsTrusted: trusted, engine });
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
  if (spec.engine === "capacitor") {
    const result = await capacitorCapturePhoto(spec.facing);
    return {
      file: result.file,
      origin: "camera-file",
      changeIsTrusted: result.changeIsTrusted,
      engine: spec.engine,
    };
  }
  return fileInputCapture(spec.engine, spec.facing);
}

/** Builds the full manual shot list for the run: both facings through every camera-app handoff. */
export function buildManualShotList(): ManualShotSpec[] {
  const shots: ManualShotSpec[] = [];
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
        purpose: `${facing === "environment" ? "Back" : "Front"} camera via ${engineName[engine] ?? engine}. This one goes through the phone's own camera app, so the file should come back with real camera metadata attached — that is the whole point of taking it by hand.`,
      });
    }
  }
  return shots;
}
