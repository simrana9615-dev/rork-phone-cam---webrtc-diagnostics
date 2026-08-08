/**
 * Stopping early when the answer is already in.
 *
 * The manual stage is the only part of a run that spends the user's attention
 * rather than the device's time. Sixteen shots on a four-camera phone is several
 * minutes of standing still holding a handset, and a good share of those shots
 * were provably going to be the same file as one already taken.
 *
 * So the list shortens as evidence arrives. Two rules, both of which only ever
 * fire on something the run has actually observed:
 *
 *   • THE SPARE ROUTES. Three engines open the phone's camera app by three
 *     different routes, and each side of the phone is asked for ONE file. The
 *     first route is tried, and the other two exist only as spares for the case
 *     where it fails. When the first route answers, the spares were never
 *     needed — which is a different thing from being skipped, and is recorded
 *     as exactly that: the side has its file, so nothing was left undone.
 *
 *   • THE ZOOM SHOT. Each camera used to be photographed four times: once at
 *     full frame and once at each of the minimum, middle and maximum of its
 *     zoom range. Three of those four were asking one question — does this
 *     lens crop or does it move? — and the middle of a range is answered by
 *     its ends. So there is one zoom shot now, at the maximum, and it is only
 *     asked for on cameras the SWEEP already showed to have a range. A camera
 *     that reported the same zoom at both ends of its own range is not asked
 *     to demonstrate that again by hand.
 *
 * What this deliberately does NOT do is guess. Nothing is skipped on the
 * strength of what a device is expected to do, only on what it has already been
 * seen doing in this run — and every skip is recorded with the observation that
 * caused it, so a shorter list is never a quieter one.
 */

export type ManualFacing = "user" | "environment";

function sideName(facing: ManualFacing): string {
  return facing === "environment" ? "back" : "front";
}

/**
 * Why the spare routes into the camera app were never opened.
 *
 * Called only once a side already HAS its file, so this is never a claim about
 * what the untried routes would have done — it is a statement that the question
 * they exist to answer has been answered. If the first route had failed, they
 * would each have been tried in turn.
 */
export function routesNotNeededReason(facing: ManualFacing, answered: string, skipped: string[]): string {
  return (
    `The ${sideName(facing)} camera returned its file on the first route that was tried (${answered}), so ${skipped.join(" and ")} ` +
    `${skipped.length === 1 ? "was" : "were"} never opened. They are spares, not separate shots: this stage needs ONE file the camera itself wrote for each side of the phone, ` +
    `and it has one. Had ${answered} failed or come back empty, each spare would have been offered in turn until the side had its file. ` +
    `Nothing here is a claim about what those routes would have returned — only that the side is not missing anything.`
  );
}

/**
 * What the run says when a side had to fall back.
 *
 * Every attempt is named with what came of it, because "the front camera
 * answered on the second route after the first came back empty" is a fact about
 * this device and is worth more than the file alone.
 */
export function fallbackReason(facing: ManualFacing, attempts: { engine: string; outcome: string; detail: string }[]): string {
  const failed = attempts.filter((attempt) => attempt.outcome !== "file");
  const answered = attempts.find((attempt) => attempt.outcome === "file");
  const list = failed.map((attempt) => `${attempt.engine} (${attempt.detail})`).join(", then ");
  if (!answered) {
    return (
      `The ${sideName(facing)} camera was offered every route and none produced a file: ${list}. There is no original for this side, and nothing has been ` +
      `substituted for it — a sweep frame is a canvas encode and a library pick is not a photo taken just now.`
    );
  }
  return (
    `The ${sideName(facing)} camera fell back: ${list}. It answered on ${answered.engine}. That fallback is itself a fact about this device — the routes into a ` +
    `camera app are not interchangeable here, and a site using only the first one would have got nothing from this side.`
  );
}

/**
 * Why a camera was not asked for a zoom shot at all.
 *
 * Two different situations end in the same absent shot, and they are NOT the
 * same statement, so they do not share wording.
 *
 *   • ANSWERED. The sweep asked this camera for zoom at its minimum and at its
 *     maximum and the settings came back the same both times, or it advertised
 *     no range to ask about. The camera answered the question the shot exists
 *     to ask, in the run the user is already looking at.
 *
 *   • NEVER ASKED. No zoom row exists for this camera at all — its capability
 *     object could not be read, so there was no range to ask against. Writing
 *     that up as "showed no zoom range" would report an answer nobody
 *     collected, which is the one thing this app must not do.
 */
export function zoomNotAskedReason(deviceLabel: string, asked: boolean = true): string {
  if (!asked) {
    return (
      `${deviceLabel} was never asked about zoom, so nothing is known about it either way. Its capability object could not be read on this browser, which means there was no ` +
      `advertised range to ask against — and a zoom shot with no range to aim at would be an ordinary frame dressed up as a measurement. This is an ABSENCE, not an answer: ` +
      `the camera did not say it has no zoom, and this run did not find out.`
    );
  }
  return (
    `${deviceLabel} showed no zoom range in the sweep — it either advertised none, or was asked for its minimum and its maximum and reported the same value both ` +
    `times. A zoom shot from it would be an ordinary unzoomed frame with a note saying the zoom did not move, which is a fact the sweep rows already hold. Nothing ` +
    `about the lens is assumed here: the camera answered, and the answer was "none".`
  );
}

/**
 * Why a camera got no viewfinder shot of its own.
 *
 * The viewfinder shot is one per RUN now, not one per camera. What it exists to
 * show is a frame from the `getUserMedia` path — no camera metadata, because no
 * browser writes any there — and that is a property of the PATH rather than of
 * the lens: the same encoder, the same absence of tags, on every camera the
 * phone has. Both sides of the phone are covered anyway by the two camera-app
 * trips, which produce the only files in a run the camera itself wrote.
 *
 * The sweep still opens every camera and still records every row for it. This
 * is a statement about one photograph not being taken by hand, and nothing at
 * all about the camera.
 */
export function viewfinderNotAskedReason(deviceLabel: string, takenOn: string): string {
  return (
    `${deviceLabel} was not photographed by hand. One viewfinder shot is taken for the whole run — it was taken on ${takenOn} — because what that shot shows is a property of the getUserMedia path rather than of the lens: ` +
    `a frame this app encoded, carrying no camera metadata, which is true on every camera this phone has. Both sides of the phone are covered separately by the two trips to the camera app, and those files are the only ones in the run the camera itself wrote. ` +
    `${deviceLabel} was still opened by the sweep and every one of its rows is above. Nothing here is a claim about what a hand shot from it would have looked like — only that it would have shown the same path a second time.`
  );
}

/** A shot the run decided not to ask for, and the observation that decided it. */
export type AdaptiveSkip = {
  stepId: string;
  title: string;
  reason: string;
};

/** The adaptive rule, said once, in the words the archive uses. */
export const ADAPTIVE_POLICY: string[] = [
  "WHY YOU WERE ASKED FOR FEWER SHOTS THAN THE LIST SHOWED",
  "-".repeat(78),
  "The manual list shortens as evidence arrives, and only ever on something this run observed.",
  "",
  "The camera-app stage asks for exactly TWO files: one the back camera wrote and one the front camera",
  "wrote. Those two are the only files in an entire run that the camera itself produced, which is why they",
  "are taken by hand at all. Three different routes into the phone's camera app exist, and each side is",
  "given all three — but as spares, tried in turn, not as three separate trips. When the first route",
  "answers, the spares were never needed, and that is recorded as what it is rather than as a skip.",
  "",
  "Each camera used to be photographed four times: full frame, then the minimum, middle and maximum of its",
  "zoom range. Three of those asked one question, and the middle of a range is answered by its two ends. One",
  "zoom shot is taken now, at the maximum, and only on cameras the SWEEP already showed to have a range — a",
  "camera that reported the same zoom at both ends of its own range is not asked to demonstrate that by hand.",
  "Every camera is asked the zoom questions in the sweep, including one whose other control rows were skipped",
  "as a repeat of an earlier camera's: zoom is the one control that genuinely differs lens to lens, and it is",
  "the one this stage reads. Where a camera could not be asked at all, the skip says it was never asked — not",
  "that it answered \"none\".",
  "",
  "The full-frame viewfinder shot is taken ONCE for the whole run rather than once per camera. What it shows",
  "is a property of the getUserMedia path — a frame this app encoded, carrying no camera metadata, because no",
  "browser writes any there — and that is the same on every lens the phone has. Both sides of the phone are",
  "covered by the two camera-app trips, whose files are the only ones in the run the camera itself wrote.",
  "Every other camera is still opened and still measured by the sweep; only the hand shot is not repeated.",
  "",
  "Every one of these is a PROVEN redundancy, never a prediction, and each is listed below with the",
  "observation that caused it. A shot that was skipped is never counted as a shot that was taken, and no",
  "skip here means anything failed.",
];
