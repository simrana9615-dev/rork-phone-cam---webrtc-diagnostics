/**
 * Which traits hold still, and what they move with.
 *
 * A spec that lists one photograph's tables is a description of one
 * photograph. What someone reproducing this device actually needs is the next
 * level up: which of those traits are true of the device no matter what you ask
 * it for, which change the moment you switch production path, which belong to
 * one lens, and which follow the resolution. Hold the wrong one constant and
 * the result is wrong in a way no single-file comparison would ever reveal.
 *
 * Consolidation is what makes this possible. Once near-identical photographs
 * collapse to one file each, what is left is a small set of genuinely different
 * shapes — and the differences between them are readable instead of buried
 * under a hundred repeats.
 *
 * The classification is deliberately conservative, because "always true" is the
 * easiest overclaim in the file:
 *
 *   • A trait is only UNIVERSAL when it held across more than one scope. One
 *     value seen once, or seen ten times down a single path on a single camera,
 *     is not evidence of universality and is reported as unestablished instead.
 *   • Scopes are tested in order of how fundamental they are — path, then
 *     camera, then size — so a trait that fits several is filed under the one
 *     that actually explains it.
 *   • Nothing is extrapolated to a request that was never made. A resolution
 *     the sweep never got is absent from the evidence, not predicted from it.
 */

export type ConstancyClass = "universal" | "per-path" | "per-camera" | "per-size" | "varies" | "unestablished";

export type ConstancyObservation = {
  slug: string;
  deviceLabel: string | null;
  path: string;
  width: number;
  height: number;
  /** Trait name to observed value. A trait absent from this map was not observable on that capture. */
  traits: Record<string, string>;
};

export type ConstancyTrait = {
  name: string;
  classification: ConstancyClass;
  /** Every distinct value observed, with the captures that showed it. */
  values: { value: string; slugs: string[] }[];
  /** How many captures the trait was observable on at all. */
  observations: number;
  /** What a reader should do with it, in words. */
  guidance: string;
};

export type ConstancyReport = {
  traits: ConstancyTrait[];
  /** Distinct production paths, cameras and frame sizes the run actually covered. */
  coverage: { paths: string[]; cameras: string[]; sizes: string[]; captures: number };
  notes: string[];
};

function groupsAreConstant(observations: ConstancyObservation[], trait: string, keyOf: (o: ConstancyObservation) => string): boolean {
  const byKey = new Map<string, Set<string>>();
  for (const observation of observations) {
    const value = observation.traits[trait];
    if (value == null) continue;
    const key = keyOf(observation);
    const set = byKey.get(key) ?? new Set<string>();
    set.add(value);
    byKey.set(key, set);
  }
  if (byKey.size < 2) return false;
  return [...byKey.values()].every((set) => set.size === 1);
}

const GUIDANCE: Record<ConstancyClass, string> = {
  universal: "Hold this constant. It did not move across the paths and cameras this run covered.",
  "per-path": "This follows the production path. A camera-app file and a canvas encode do not share it, so pick the value for the path you are reproducing.",
  "per-camera": "This belongs to the individual lens. Use the value from the camera you are reproducing, not a run-wide average.",
  "per-size": "This moves with the frame size. Take the value that goes with the resolution, and do not carry it to a resolution this run never asked for.",
  varies: "This changed without following path, camera or size. Treat it as unpredictable rather than picking one of its values and calling it typical.",
  unestablished:
    "Only one value was seen, and only within a single scope. That is consistent with a constant but does not establish one — the run never put it in a position to vary.",
};

/**
 * Classifies each trait by what it moves with.
 *
 * Traits absent from every observation are dropped entirely rather than
 * reported as empty: a trait nothing could observe is not a finding about the
 * device, it is a gap in the run, and the omissions list is where gaps belong.
 */
export function buildConstancy(observations: ConstancyObservation[]): ConstancyReport {
  const notes: string[] = [];
  const names = new Set<string>();
  for (const observation of observations) for (const name of Object.keys(observation.traits)) names.add(name);

  const paths = [...new Set(observations.map((o) => o.path))].sort();
  const cameras = [...new Set(observations.map((o) => o.deviceLabel ?? "no camera"))].sort();
  const sizes = [...new Set(observations.map((o) => `${o.width}×${o.height}`))].sort();

  if (observations.length < 2) {
    notes.push(
      "Fewer than two captures survived, so nothing here can be classified. A trait needs at least two observations under different conditions before anything can be said about whether it holds."
    );
  }
  if (paths.length < 2) {
    notes.push(
      `Every capture came down a single production path (${paths[0] ?? "none"}). No trait can be shown to be path-independent from that, so anything reading as universal below is universal only within that one path.`
    );
  }
  if (cameras.length < 2) {
    notes.push(`Only one camera contributed (${cameras[0] ?? "none"}), so no trait can be attributed to a lens rather than to the device as a whole.`);
  }

  const traits: ConstancyTrait[] = [];
  for (const name of [...names].sort()) {
    const byValue = new Map<string, string[]>();
    let observationCount = 0;
    const seen: ConstancyObservation[] = [];
    for (const observation of observations) {
      const value = observation.traits[name];
      if (value == null) continue;
      observationCount += 1;
      seen.push(observation);
      const slugs = byValue.get(value) ?? [];
      slugs.push(observation.slug);
      byValue.set(value, slugs);
    }
    if (observationCount === 0) continue;

    const distinctScopes = new Set(seen.map((o) => `${o.deviceLabel ?? "no camera"}|${o.path}`));
    let classification: ConstancyClass;
    if (byValue.size === 1) {
      classification = observationCount >= 2 && distinctScopes.size >= 2 ? "universal" : "unestablished";
    } else if (groupsAreConstant(seen, name, (o) => o.path)) {
      classification = "per-path";
    } else if (groupsAreConstant(seen, name, (o) => o.deviceLabel ?? "no camera")) {
      classification = "per-camera";
    } else if (groupsAreConstant(seen, name, (o) => `${o.width}×${o.height}`)) {
      classification = "per-size";
    } else {
      classification = "varies";
    }

    traits.push({
      name,
      classification,
      values: [...byValue.entries()].map(([value, slugs]) => ({ value, slugs })).sort((a, b) => b.slugs.length - a.slugs.length),
      observations: observationCount,
      guidance: GUIDANCE[classification],
    });
  }

  return { traits, coverage: { paths, cameras, sizes, captures: observations.length }, notes };
}

const CLASS_ORDER: ConstancyClass[] = ["universal", "per-path", "per-camera", "per-size", "varies", "unestablished"];

const CLASS_HEADING: Record<ConstancyClass, string> = {
  universal: "HELD EVERYWHERE",
  "per-path": "FOLLOWS THE PRODUCTION PATH",
  "per-camera": "BELONGS TO ONE LENS",
  "per-size": "MOVES WITH THE FRAME SIZE",
  varies: "MOVED WITHOUT A PATTERN",
  unestablished: "SEEN ONCE, IN ONE PLACE — NOT ESTABLISHED",
};

/** The readable constancy section. */
export function constancyText(report: ConstancyReport): string {
  const lines: string[] = [
    "WHAT HOLDS, AND WHAT MOVES",
    "=".repeat(78),
    "",
    "Each trait below is classified by what it moves WITH. That is the part a single file cannot tell you",
    "and the part anyone reproducing this device most needs: hold the wrong trait constant and the result",
    "is wrong in a way no one-file comparison would catch.",
    "",
    `Evidence base: ${report.coverage.captures} capture(s), ${report.coverage.paths.length} production path(s), ` +
      `${report.coverage.cameras.length} camera(s), ${report.coverage.sizes.length} frame size(s).`,
    `  paths    ${report.coverage.paths.join(", ") || "none"}`,
    `  cameras  ${report.coverage.cameras.join(", ") || "none"}`,
    `  sizes    ${report.coverage.sizes.join(", ") || "none"}`,
    "",
  ];
  for (const note of report.notes) lines.push(`  ! ${note}`, "");

  if (report.traits.length === 0) {
    lines.push("No traits were observable on any surviving capture, so there is nothing to classify.");
    return lines.join("\n");
  }

  for (const classification of CLASS_ORDER) {
    const group = report.traits.filter((t) => t.classification === classification);
    if (group.length === 0) continue;
    lines.push(CLASS_HEADING[classification], "-".repeat(78), `  ${GUIDANCE[classification]}`, "");
    for (const trait of group) {
      lines.push(`  ${trait.name}  (${trait.observations} observation${trait.observations === 1 ? "" : "s"})`);
      for (const entry of trait.values.slice(0, 8)) {
        lines.push(`      ${entry.value}`, `        seen on ${entry.slugs.slice(0, 6).join(", ")}${entry.slugs.length > 6 ? ` and ${entry.slugs.length - 6} more` : ""}`);
      }
      if (trait.values.length > 8) lines.push(`      … and ${trait.values.length - 8} further value(s)`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
