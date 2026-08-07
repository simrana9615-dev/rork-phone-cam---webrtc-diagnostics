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
 *   • THE HANDOFFS. Three engines open the phone's camera app by three
 *     different routes. They are worth trying because on some devices they
 *     genuinely return different files. Once two of them have returned the
 *     SAME byte shape for one facing, the third has been answered: this device
 *     routes them all to one camera app. Asking again would collect a third
 *     copy of a file already held, so the remaining handoffs for that facing
 *     are dropped and the identity is recorded as the finding it is.
 *
 *   • THE ZOOM STEPS. Three of the four viewfinder shots per camera exist to
 *     exercise a zoom range. A camera that exposes no zoom control cannot
 *     exercise one, and the three shots collapse to three identical frames
 *     plus three identical "this camera has no zoom" notes. One shot and one
 *     note say the same thing.
 *
 * What this deliberately does NOT do is guess. Nothing is skipped on the
 * strength of what a device is expected to do, only on what it has already been
 * seen doing in this run — and every skip is recorded with the observation that
 * caused it, so a shorter list is never a quieter one.
 */

export type ManualFacing = "user" | "environment";

/** One camera-app file that came back, reduced to the facts a skip decision needs. */
export type HandoffSighting = {
  engine: string;
  facing: ManualFacing;
  /** The file's forensic shape. Two engines sharing one shape share one pipeline. */
  shapeId: string;
  slug: string;
};

export type HandoffDecision = {
  /** Engines whose remaining shots for this facing are no longer worth taking. */
  skipEngines: string[];
  /** Why, in the words the run log and the archive both use. Null when nothing is skipped. */
  reason: string | null;
};

/**
 * Decides whether the remaining handoffs for one facing have been answered.
 *
 * Requires two DIFFERENT engines to agree. One engine returning one file says
 * nothing about the others, and two shots from the same engine agreeing says
 * only that the engine is consistent with itself.
 */
export function handoffDecision(sightings: HandoffSighting[], facing: ManualFacing, remainingEngines: string[]): HandoffDecision {
  const forFacing = sightings.filter((sighting) => sighting.facing === facing);
  const byShape = new Map<string, HandoffSighting[]>();
  for (const sighting of forFacing) {
    const list = byShape.get(sighting.shapeId) ?? [];
    list.push(sighting);
    byShape.set(sighting.shapeId, list);
  }

  for (const [shapeId, group] of byShape) {
    const engines = [...new Set(group.map((sighting) => sighting.engine))];
    if (engines.length < 2) continue;
    const skipEngines = remainingEngines.filter((engine) => !engines.includes(engine));
    if (skipEngines.length === 0) return { skipEngines: [], reason: null };
    return {
      skipEngines,
      reason:
        `${engines.join(" and ")} both returned byte-shape ${shapeId} for the ${facing === "environment" ? "back" : "front"} camera — same container, same frame, same tables, same metadata layout. ` +
        `Two different routes into the camera app producing one identical file means this device sends them all to the same place, so ${skipEngines.join(" and ")} ` +
        `${skipEngines.length === 1 ? "was" : "were"} not asked for: the answer is already in hand, and a third copy of a file already held is not evidence. ` +
        `This is a skip because it was PROVEN redundant, not because it failed.`,
    };
  }
  return { skipEngines: [], reason: null };
}

/**
 * Why the zoom shots for one camera are not worth taking.
 *
 * Called only after a real zoom step has come back with no zoom applied, which
 * is the camera itself saying it has no range to walk.
 */
export function zoomSkipReason(deviceLabel: string): string {
  return (
    `${deviceLabel} applied no zoom when asked for one, so it exposes no zoom control at all. The remaining zoom shots for this camera would each produce ` +
    `an identical unzoomed frame and an identical note saying so, which is one fact recorded three more times. They were dropped and the fact is kept: this ` +
    `camera has no zoom range. Nothing about the lens is being assumed here — the camera answered, and the answer was "none".`
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
  "Three engines open the phone's camera app by three different routes, and they are all worth trying",
  "because on some devices they return genuinely different files. The moment two of them return the SAME",
  "byte shape for one facing, the third has been answered — this device routes them all to one camera app —",
  "so the rest of that facing's handoffs are dropped and the identity is recorded instead.",
  "",
  "Likewise, three of the four viewfinder shots per camera exist to walk a zoom range. A camera that",
  "applied no zoom when asked has no range to walk, and three more identical unzoomed frames would record",
  "one fact three more times.",
  "",
  "Every one of these is a PROVEN redundancy, never a prediction, and each is listed below with the",
  "observation that caused it. A shot that was skipped is never counted as a shot that was taken, and no",
  "skip here means anything failed.",
];
