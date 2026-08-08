/**
 * Stage four — the photos you take yourself.
 *
 * The automated sweep produces a lot of files and almost no metadata: every
 * browser strips (or never writes) camera EXIF on a `getUserMedia` still. The
 * only way to obtain a file with the camera's own tags in it is to hand off to
 * the operating system's camera app and take the picture there. That is what
 * this module does — and it now does it exactly twice, once for each side of
 * the phone.
 *
 * WHY TWO AND NOT SIX. There are three genuinely different code paths into the
 * camera app, and for a long time all three were offered for both facings: six
 * handoffs, six trips to the camera, six files. On every device seen so far the
 * three routes end at the same camera app and return the same kind of file, so
 * five of those six were a second, third, fourth, fifth and sixth copy of an
 * answer already in hand. What the run actually needs from this stage is ONE
 * environment original and ONE user original, because those two files are the
 * only ones in a whole run the camera itself wrote.
 *
 * So the three routes are no longer three shots. They are one shot with two
 * spares: the first route is tried, and if it fails outright or comes back
 * empty the next is tried for the same side, until the side has its file or the
 * routes run out. A side that exhausts every route reports that plainly, with
 * each attempt named, and nothing is substituted for it.
 *
 * Closing the camera without taking a picture counts as a route that did not
 * answer, so the next one is offered. The way to leave the stage entirely is the
 * skip control, which drops the whole shot rather than moving to the next route.
 *
 * The stage also takes ONE library pick, which is the opposite kind of evidence
 * and is filed as such. A pick cannot promise a fresh photo, so it is never
 * offered as one — but it is the only way to see what an ordinary upload form
 * receives from the photo library, and the brief's central comparison (canvas
 * path = no EXIF, file path = the full tag set) has no second half without it.
 *
 * WHY ONE PICK AND NOT TWO. The pair used to differ only in its `accept`
 * attribute: an ordinary `image/*` upload, then the same photo again with HEIC
 * named explicitly. The second is the revealing half — it is the request that
 * gives a phone no reason to convert — and it is the one kept. The plain
 * `image/*` half is now covered by the multi-pick trip, which sends five photos
 * down an ordinary picker in a single tap, so asking for a sixth by hand was
 * spending one of your taps on an answer already in the archive.
 */

import { CaptureCancelledError, capacitorCapturePhoto, inputAcceptAttr, inputCaptureAttr, type CaptureEngine } from "../capture-engine";
import type { PackOrigin } from "../evidence-pack";

export type ManualShotSpec = {
  id: string;
  /** What the shot is for — shown before the camera opens. */
  purpose: string;
  /**
   * The route tried first. The library picks have exactly one route and this is
   * it; a camera-app shot uses this as the head of `routes`.
   */
  engine: CaptureEngine;
  /**
   * Every route into the camera app for this side, in the order they are tried.
   * A camera-app shot must end with ONE file, so a route that fails or comes
   * back empty hands over to the next rather than losing the side entirely.
   */
  routes: CaptureEngine[];
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

/** One route into the camera app, and what came of it. */
export type RouteAttempt = {
  engine: CaptureEngine;
  outcome: "file" | "cancelled" | "failed";
  detail: string;
};

export type ManualShotResult = {
  file: File;
  origin: PackOrigin;
  /** The declared production path, decided by the spec rather than by the caller. */
  path: "camera-file" | "picker-file";
  /** Whether the change event carried browser trust. Undefined = not observable on this path. */
  changeIsTrusted?: boolean;
  /** The route that actually answered. */
  engine: CaptureEngine;
  /** Every route tried, in order, including the one that answered. */
  attempts: RouteAttempt[];
  /**
   * Only meaningful on the Capacitor route. True when the original File was
   * taken from Capacitor's own input before Capacitor could rewrite it; false
   * when that interception missed and the bytes were rebuilt from a blob URL,
   * in which case the name and timestamp are synthesised and this run says so
   * rather than passing the copy off as the original.
   */
  interceptedOriginal?: boolean;
};

/**
 * Thrown when a side has been offered every route and none of them produced a
 * file. Carries the attempts so the run can say exactly what was tried rather
 * than reporting one anonymous failure.
 */
export class RoutesExhaustedError extends Error {
  readonly attempts: RouteAttempt[];
  /** True when every route was closed without taking a picture, rather than failing. */
  readonly cancelledEverywhere: boolean;

  constructor(attempts: RouteAttempt[]) {
    const cancelledEverywhere = attempts.length > 0 && attempts.every((attempt) => attempt.outcome === "cancelled");
    super(
      cancelledEverywhere
        ? `Every route into the camera app was closed without a picture (${attempts.map((a) => a.engine).join(", ")}).`
        : `Every route into the camera app was tried and none returned a file: ${attempts.map((a) => `${a.engine} — ${a.detail}`).join("; ")}.`
    );
    this.name = "RoutesExhaustedError";
    this.attempts = attempts;
    this.cancelledEverywhere = cancelledEverywhere;
  }
}

/**
 * The three engines that hand off to the phone's own camera app, in the order
 * they are tried. Each is a distinct pipeline: a direct `capture` attribute,
 * the bare boolean form of that attribute, and Capacitor driving its own hidden
 * input. Picker-only engines are deliberately excluded from this stage — they
 * cannot promise a fresh photo, so asking for one here would be misleading.
 *
 * The order is deliberate: the direct attribute is the one nearly every device
 * honours, so it answers first on nearly every device and the other two are
 * never needed. They exist for the devices where it does not.
 */
export const CAMERA_APP_ENGINES: CaptureEngine[] = ["native-camera", "capture-boolean", "capacitor"];

/** Human names for the routes, used in the shot wording and in the fallback notes. */
export const ENGINE_NAME: Record<string, string> = {
  "native-camera": "the direct capture attribute",
  "capture-boolean": "the bare boolean capture attribute",
  capacitor: "Capacitor's camera API",
};

/**
 * Opens the OS camera app through a hidden file input and resolves with the
 * file it returns. The change event's trust flag is captured at event time
 * rather than reconstructed afterwards.
 */
function fileInputCapture(spec: ManualShotSpec, engine: CaptureEngine): Promise<ManualShotResult> {
  const { facing, source } = spec;
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
        attempts: [],
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

/** Runs one shot through one named route, with no fallback of its own. */
async function runOneRoute(spec: ManualShotSpec, engine: CaptureEngine): Promise<ManualShotResult> {
  if (engine === "capacitor" && spec.source === "camera-app") {
    // A null facing is passed straight through as null: this is the shot that
    // names no camera, and substituting a default here would silently answer
    // the question it exists to ask.
    const result = await capacitorCapturePhoto(spec.facing);
    return {
      file: result.file,
      origin: "camera-file",
      path: "camera-file",
      changeIsTrusted: result.changeIsTrusted,
      engine,
      attempts: [],
      interceptedOriginal: result.interceptedOriginal,
    };
  }
  return fileInputCapture(spec, engine);
}

/**
 * Runs one manual shot, walking its routes until one of them answers.
 *
 * `onRoute` is called before each attempt so the page can say which route it is
 * about to open — a second camera opening with no explanation reads as a bug
 * rather than as a fallback.
 *
 * Every attempt is recorded whether or not it succeeded, and the record travels
 * with the file, so "the front camera answered on the second route after the
 * first came back empty" is a fact the archive holds rather than something a
 * reader has to infer from a gap.
 */
export async function runManualShot(spec: ManualShotSpec, onRoute?: (engine: CaptureEngine, index: number, total: number) => void): Promise<ManualShotResult> {
  const routes = spec.routes.length > 0 ? spec.routes : [spec.engine];
  const attempts: RouteAttempt[] = [];
  for (let i = 0; i < routes.length; i += 1) {
    const engine = routes[i];
    onRoute?.(engine, i, routes.length);
    try {
      const result = await runOneRoute(spec, engine);
      attempts.push({ engine, outcome: "file", detail: `returned "${result.file.name || "(unnamed)"}", ${result.file.size.toLocaleString("en-US")} bytes` });
      return { ...result, attempts };
    } catch (err) {
      if (err instanceof CaptureCancelledError) {
        attempts.push({ engine, outcome: "cancelled", detail: "the camera was closed without a picture" });
      } else {
        attempts.push({ engine, outcome: "failed", detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
      // A library pick has one route and no spare. Walking on would open a
      // second picker for a shot that was declined, which is nagging.
      if (spec.source !== "camera-app") break;
    }
  }
  throw new RoutesExhaustedError(attempts);
}

/**
 * The one library pick: the request that names HEIC, so the phone has no reason
 * to convert on the way in.
 *
 * This is the revealing half of what used to be a pair. The plain `image/*`
 * half is exactly what the multi-pick trip sends, five photos at a time, so it
 * is already answered elsewhere in the run and no longer costs a separate tap.
 */
export const LIBRARY_PICK_SHOTS: ManualShotSpec[] = [
  {
    id: "library-original",
    engine: "system-picker",
    routes: ["system-picker"],
    facing: null,
    source: "library",
    accept: "image/*,image/heic,image/heif,.heic,.heif",
    purpose:
      "Pick an existing photo from your library — one this phone's own camera app took, ideally a recent one. Unlike every frame the sweep produced, this file arrives with whatever metadata the camera originally wrote. " +
      "This request names HEIC explicitly, which is the point of it: the phone has no reason to convert, so what comes back is what the library actually holds. If it hands over HEIC here while ordinary upload forms receive JPEG, you have just caught the browser transcoding your photos — the one honest way to separate \"the library holds JPEG\" from \"the library holds HEIC and hides it\". " +
      "Nothing about it is treated as a fresh photo: it is filed as a library pick, because that is all it can be.",
  },
];

/**
 * The camera-app shot that names NO camera at all.
 *
 * Whatever this opens is the phone's own choice, which is a real fact about the
 * device that nothing else in the run measures. Its `facing` is null for the
 * same reason a library pick's is: claiming a side before the file has been
 * read would be inventing the answer this shot exists to find.
 */
export const UNNAMED_CAMERA_SHOT: ManualShotSpec = {
  id: "camera-app-unnamed",
  engine: "capacitor",
  routes: ["capacitor", ...CAMERA_APP_ENGINES.filter((engine) => engine !== "capacitor")],
  facing: null,
  source: "camera-app",
  purpose:
    "Your phone's own camera app, opened WITHOUT naming which camera to use. Whatever opens is this phone's choice, not this app's — and which camera a device picks when a page asks for none is a fact about the device that nothing else in this run measures. " +
    "Take the photo however it opens; do not switch cameras yourself, because the point is what the phone chose. This file is also one of the two in the whole run that the CAMERA wrote, with its own quantisation tables, its own maker note, its own colour profile and its own EXIF. " +
    "To leave this out altogether use skip — closing the camera moves on to the next route into it, skip drops the shot.",
};

/**
 * The second camera-app shot, which asks for a specific side.
 *
 * `facing` is decided by what the FIRST shot's own metadata turned out to say,
 * so the pair covers both sides of the phone and tests the request at the same
 * time. When the first file names no side, the front is asked for: a phone that
 * ignores the request opens the back, so asking for the front is the request
 * most likely to reveal that it was ignored.
 */
export function namedCameraShot(facing: "user" | "environment", becauseUnnamedGave: string): ManualShotSpec {
  const side = facing === "environment" ? "Back" : "Front";
  return {
    id: `camera-app-${facing}`,
    engine: "capacitor",
    routes: ["capacitor", ...CAMERA_APP_ENGINES.filter((engine) => engine !== "capacitor")],
    facing,
    source: "camera-app",
    purpose:
      `${side} camera — and this time the camera IS named. ${becauseUnnamedGave} ` +
      `Asking for the opposite side does two things at once: you end up with one back photo and one front photo, and the run finds out whether this phone actually honours a page's request for a particular camera or accepts it and opens whatever it likes. ` +
      `Again: take the photo however it opens, and do not switch cameras yourself. If the phone gives you the wrong side, that IS the finding, and swapping it by hand would erase it.`,
  };
}

/**
 * Builds the full manual shot list for the run: the two library picks, then the
 * two camera-app shots.
 *
 * The second camera shot is not in this list. It cannot be, because which side
 * it asks for is decided by reading the first shot's own metadata — see
 * `namedCameraShot`, which the run calls once the first file is in hand.
 */
export function buildManualShotList(): ManualShotSpec[] {
  // The library pick leads: it needs no camera, no permission and no good
  // light, and it closes the one requested item that nothing else in the run
  // can.
  return [...LIBRARY_PICK_SHOTS, UNNAMED_CAMERA_SHOT];
}
