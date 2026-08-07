/**
 * A deadline on opening a camera.
 *
 * `getUserMedia` has no timeout of its own. When a camera is wedged — held by
 * another app, mid-rotation, or simply confused by the two hundredth constraint
 * change in a row — the promise does not reject. It never settles at all, and
 * every stage waiting behind it waits forever. That is not a hypothetical: it is
 * the shape of a run that appears to freeze on one camera with no error and no
 * way forward.
 *
 * Two rules make a deadline honest rather than merely convenient:
 *
 *   • A timeout is a result, exactly like `OverconstrainedError`. It is written
 *     into the row as what it is — the camera did not answer in time — and it is
 *     never rewritten as a refusal, a capability or a fault in the device.
 *
 *   • The abandoned request is adopted, not orphaned. A `getUserMedia` promise
 *     that resolves after the deadline hands over a LIVE camera, and dropping
 *     the reference leaves the sensor running and the privacy indicator lit for
 *     the rest of the session. Every late stream is stopped the moment it
 *     arrives, and the fact that it arrived late is recorded — a camera that
 *     answers at 12 s is a finding, not litter.
 *
 * The prompt is deliberately given a different, much longer allowance. A person
 * reading a permission dialog is not a hung camera, and capping that at ten
 * seconds would file "you were still reading" as "you said no" — then skip both
 * camera stages on the strength of it. The long allowance exists only so a truly
 * hung prompt cannot strand the run for ever.
 */

/** How long any camera gets to open once the permission answer is already in. */
export const CAMERA_OPEN_TIMEOUT_MS = 10_000;

/**
 * How long a request that shows a permission prompt gets. Long on purpose: this
 * clock is mostly a human reading a dialog, and a short cap here would record
 * refusals nobody made.
 */
export const PROMPT_ANSWER_TIMEOUT_MS = 60_000;

/** Raised when a camera request passes its deadline without settling. */
export class CameraTimeoutError extends Error {
  /** The deadline that expired, in ms. */
  readonly waitedMs: number;
  /** What was being waited on, in words. */
  readonly what: string;

  constructor(what: string, waitedMs: number) {
    super(`${what} did not answer within ${(waitedMs / 1000).toFixed(1)} s and was abandoned. This is a timeout, not a refusal and not a limit the camera stated.`);
    this.name = "CameraTimeoutError";
    this.waitedMs = waitedMs;
    this.what = what;
  }
}

/** A request that answered after its deadline had already passed. */
export type LateArrival = {
  what: string;
  /** The deadline it missed. */
  waitedMs: number;
  /** How long it actually took, measured from the request. */
  arrivedAtMs: number;
  /** True when a live stream came back and had to be closed. */
  streamClosed: boolean;
};

export type DeadlineOptions = {
  timeoutMs?: number;
  /** Named in the error and in the late-arrival record. */
  what?: string;
  /** Called if the request answers after the deadline. Any stream is already stopped. */
  onLate?: (late: LateArrival) => void;
};

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** True for a live stream, without assuming the class exists in this environment. */
function isStream(value: unknown): value is MediaStream {
  return typeof value === "object" && value != null && typeof (value as MediaStream).getTracks === "function";
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }
}

/**
 * Races a promise against a deadline.
 *
 * `onSettleLate` is where the adoption happens: it receives whatever the
 * abandoned promise eventually produced, so a caller holding a resource can
 * release it. Rejections after the deadline are swallowed on purpose — the
 * caller has already been told the request failed, and an unhandled rejection
 * on top of that helps nobody.
 */
function race<T>(work: Promise<T>, timeoutMs: number, what: string, onSettleLate: (value: T, arrivedAtMs: number) => void): Promise<T> {
  const started = now();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      work.then(
        (value) => onSettleLate(value, Math.round(now() - started)),
        () => undefined
      );
      reject(new CameraTimeoutError(what, timeoutMs));
    }, timeoutMs);

    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Opens a camera (or microphone) under a deadline.
 *
 * Rejects with `CameraTimeoutError` when the deadline passes. A stream that
 * arrives afterwards is stopped immediately, so no abandoned request can leave
 * a sensor running behind the rest of the run.
 */
export function openMediaWithDeadline(constraints: MediaStreamConstraints, options: DeadlineOptions = {}): Promise<MediaStream> {
  const timeoutMs = options.timeoutMs ?? CAMERA_OPEN_TIMEOUT_MS;
  const what = options.what ?? "the camera";
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error("NotSupportedError: this browser exposes no navigator.mediaDevices.getUserMedia."));
  }
  return race(navigator.mediaDevices.getUserMedia(constraints), timeoutMs, what, (stream, arrivedAtMs) => {
    stopTracks(stream);
    options.onLate?.({ what, waitedMs: timeoutMs, arrivedAtMs, streamClosed: true });
  });
}

/**
 * Puts a deadline on any other camera call — `takePhoto()` above all, which
 * hangs on the same devices and for the same reasons as the open does.
 */
export function withCameraDeadline<T>(work: Promise<T>, options: DeadlineOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? CAMERA_OPEN_TIMEOUT_MS;
  const what = options.what ?? "the camera";
  return race(work, timeoutMs, what, (value, arrivedAtMs) => {
    const stream = isStream(value);
    if (stream) stopTracks(value);
    options.onLate?.({ what, waitedMs: timeoutMs, arrivedAtMs, streamClosed: stream });
  });
}

/** True when a failure was this deadline rather than anything the device said. */
export function isCameraTimeout(err: unknown): err is CameraTimeoutError {
  return err instanceof CameraTimeoutError;
}

/** The paragraph the archive uses to explain why some rows say "timed out". */
export const CAMERA_DEADLINE_POLICY = [
  `Every camera request in this run had a hard deadline of ${(CAMERA_OPEN_TIMEOUT_MS / 1000).toFixed(0)} seconds. getUserMedia has no timeout of its own: a camera that is`,
  "busy, mid-rotation or confused by a long run of constraint changes simply never answers, and without a",
  "deadline the whole run waits behind it indefinitely.",
  "",
  "A timed-out row means exactly that and nothing more. It is NOT a refusal, NOT a capability the camera",
  "stated, and NOT evidence about the hardware's limits — it is the request being abandoned so the sweep",
  "could carry on. Rows that came back with OverconstrainedError are the opposite: those are real answers.",
  "",
  "An abandoned request is still watched. If the camera answers after the deadline it hands over a LIVE",
  "stream, which is closed immediately — otherwise the sensor would stay on for the rest of the session —",
  "and the late answer is recorded in the notes below with the time it actually took.",
  "",
  `The permission prompt is the one exception: it is allowed ${(PROMPT_ANSWER_TIMEOUT_MS / 1000).toFixed(0)} seconds, because that clock is mostly a person`,
  "reading a dialog. Capping it at ten seconds would file \"still reading\" as \"said no\" and skip both camera",
  "stages on the strength of it.",
].join("\n");
