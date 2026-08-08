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
 * Called only where the SWEEP already asked this camera for zoom at its minimum
 * and at its maximum and the settings came back the same both times, or where
 * it advertised no zoom range to ask about. Either way the camera has answered
 * the question the shot exists to ask, and answered it in the run the user is
 * already looking at.
 */
export function zoomNotAskedReason(deviceLabel: string): string {
  return (
    `${deviceLabel} showed no zoom range in the sweep — it either advertised none, or was asked for its minimum and its maximum and reported the same value both ` +
    `times. A zoom shot from it would be an ordinary unzoomed frame with a note saying the zoom did not move, which is a fact the sweep rows already hold. Nothing ` +
    `about the lens is assumed here: the camera answered, and the answer was "none".`
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
  "",
  "Every one of these is a PROVEN redundancy, never a prediction, and each is listed below with the",
  "observation that caused it. A shot that was skipped is never counted as a shot that was taken, and no",
  "skip here means anything failed.",
];
