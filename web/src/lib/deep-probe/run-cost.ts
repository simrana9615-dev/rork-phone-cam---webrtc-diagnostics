/**
 * What the run actually costs, measured rather than typed in.
 *
 * The page used to promise "eight to fifteen minutes" and draw a progress bar
 * from a fixed guess: cameras × (rungs + ratios + frame rates + 8). The guess
 * left out the control steps entirely, so on a phone with a rich control
 * surface the bar filled up and then sat at the end while roughly a third of
 * each camera was still running. It also could not be right, because the plan
 * sent to each camera is built from what that camera says about itself and is
 * therefore a different length on every phone.
 *
 * So nothing here is a constant pretending to be a measurement:
 *
 *   • THE BAR is fed the real plan. Each camera contributes an exact step count
 *     the moment it has stated its limits on the first open — resolution rungs,
 *     aspect ratios, frame rates AND control steps — and cameras not yet
 *     reached contribute an estimate that is replaced, not added to. Until
 *     every camera has been planned the total is marked inexact, and the page
 *     says so rather than implying a precision it does not have.
 *
 *   • THE CLOCK is this phone's own step times. A median of the steps already
 *     run is the only honest basis for the ones that have not, and early in a
 *     run there are too few to median, so it says "too early to say" instead of
 *     showing a confident number derived from four samples.
 *
 *   • THE CEILING is per camera. A phone where one camera takes fifteen seconds
 *     to open would otherwise spend the whole run on it; that camera stops at
 *     its share and every step it never reached is listed by name as UNTRIED.
 *     Untried is its own word on purpose — it is not a refusal, not a limit the
 *     camera stated, and not a timeout. Those three already exist, they mean
 *     different things, and nothing is inferred about a step that never ran.
 */

/** Milliseconds the whole camera sweep is allowed to spend, before it is shared out. */
export const SWEEP_TIME_BUDGET_MS = 10 * 60_000;

/**
 * The least any one camera gets, however many cameras there are. A phone with
 * eight enumerated cameras would otherwise hand each of them 75 seconds, which
 * is inside the range a slow camera legitimately needs.
 */
export const MIN_CAMERA_BUDGET_MS = 90_000;

/**
 * How long one camera may spend before its remaining steps are left untried.
 *
 * Deliberately generous: this is not a performance target, it is a stop on the
 * one pathological camera that would otherwise eat the run. A camera behaving
 * normally never comes near it.
 */
export function cameraBudgetMs(cameraCount: number): number {
  if (cameraCount <= 0) return SWEEP_TIME_BUDGET_MS;
  return Math.max(MIN_CAMERA_BUDGET_MS, Math.round(SWEEP_TIME_BUDGET_MS / cameraCount));
}

/** Samples needed before a remaining-time figure is worth showing. */
export const MIN_SAMPLES_FOR_ESTIMATE = 8;

/** A duration in words, at the precision the number deserves. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Collects step durations and answers questions about them.
 *
 * The median rather than the mean, because one camera that timed out at ten
 * seconds should not drag the estimate for two hundred steps that each took
 * eighty milliseconds. A timeout is the outlier this is built to survive.
 */
export type StepTimer = {
  record: (ms: number) => void;
  count: () => number;
  medianMs: () => number;
  totalMs: () => number;
  slowest: () => { label: string; ms: number } | null;
  recordLabelled: (label: string, ms: number) => void;
};

export function createStepTimer(): StepTimer {
  const samples: number[] = [];
  let total = 0;
  let slowestLabel: string | null = null;
  let slowestMs = -1;

  const record = (ms: number): void => {
    if (!Number.isFinite(ms) || ms < 0) return;
    samples.push(ms);
    total += ms;
  };

  return {
    record,
    recordLabelled: (label, ms) => {
      record(ms);
      if (ms > slowestMs) {
        slowestMs = ms;
        slowestLabel = label;
      }
    },
    count: () => samples.length,
    totalMs: () => total,
    slowest: () => (slowestLabel == null ? null : { label: slowestLabel, ms: slowestMs }),
    medianMs: () => {
      if (samples.length === 0) return 0;
      const sorted = [...samples].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
    },
  };
}

/** What the page shows next to the bar. */
export type RemainingEstimate = {
  /** Null until there are enough samples to mean anything. */
  ms: number | null;
  text: string;
  /** False while the figure is either unsampled or built on an inexact total. */
  confident: boolean;
};

/**
 * How much longer, from this phone's own step times.
 *
 * Returns "too early to say" rather than a number until there are enough
 * samples, and marks the figure unconfident while any camera's plan is still
 * unknown — an estimate against a total that is itself an estimate is not a
 * measurement, and showing it as one would be the same mistake as before.
 */
export function remainingEstimate(done: number, total: number, timer: StepTimer, totalIsExact: boolean): RemainingEstimate {
  const left = Math.max(0, total - done);
  if (timer.count() < MIN_SAMPLES_FOR_ESTIMATE) {
    return { ms: null, text: "too early to say", confident: false };
  }
  const ms = left * timer.medianMs();
  return {
    ms,
    text: totalIsExact ? `about ${formatDuration(ms)} left` : `about ${formatDuration(ms)} left, from a plan still being read`,
    confident: totalIsExact,
  };
}

/**
 * The range the setup page offers before anything has been measured.
 *
 * Derived from the number of cameras this device enumerates, because that is
 * the one figure that actually drives the length of a run and it is readable
 * before the run starts. Stated as a range, and stated as an estimate — the
 * run reports what it really was afterwards.
 */
export function expectedMinutes(cameraCount: number | null, promptCount: number): { low: number; high: number; text: string; derivedFrom: string } {
  const promptMinutes = Math.ceil(promptCount * 0.2);
  if (cameraCount == null || cameraCount <= 0) {
    return {
      low: promptMinutes + 6,
      high: promptMinutes + 20,
      text: `${promptMinutes + 6}–${promptMinutes + 20}`,
      derivedFrom:
        "The camera count is not readable yet — browsers withhold the device list until a camera grant exists — so this is the widest honest range: one camera at the bottom, four at the top. It narrows the moment the run can see how many cameras this phone has, and the run reports what it actually took at the end.",
    };
  }
  // Roughly two and a half minutes per camera at the low end and five at the
  // high end, plus the hand-shot stage, plus the prompts. Both ends move with
  // the camera count rather than staying where they were typed.
  const low = promptMinutes + 2 + Math.round(cameraCount * 2.5);
  const high = promptMinutes + 4 + cameraCount * 5;
  return {
    low,
    high,
    text: `${low}–${high}`,
    derivedFrom: `Derived from the ${cameraCount} camera(s) this device enumerates, plus ${promptCount} permission prompt(s) and the shots you take by hand. It is an estimate until the run measures itself; the archive reports what it actually took.`,
  };
}

/** One stage's share of the wall clock. */
export type StageCost = { stage: string; ms: number; detail?: string };

/** One camera's share, and whether it ran out of its own budget. */
export type CameraCost = { label: string; ms: number; steps: number; untried: number; hitBudget: boolean };

export type RunCost = {
  totalMs: number;
  stages: StageCost[];
  cameras: CameraCost[];
  slowestStep: { label: string; ms: number } | null;
  /** The deadline the slowest request was measured against. */
  cameraDeadlineMs: number;
  perCameraBudgetMs: number | null;
};

/** The archive's cost section — what this took, on this phone, per stage and per camera. */
export function costText(cost: RunCost): string {
  const lines: string[] = [
    "WHAT THIS RUN COST",
    "=".repeat(78),
    "",
    "Measured, not estimated. Every figure below is a wall clock reading taken during this run on this",
    "phone. Nothing here is an average of other devices, and nothing is a target — a slow camera is not a",
    "fault, it is a fact about the hardware, and it is one of the more useful facts in the archive.",
    "",
    `TOTAL   ${formatDuration(cost.totalMs)}`,
    "",
    "BY STAGE",
    "-".repeat(78),
  ];
  if (cost.stages.length === 0) {
    lines.push("  No stage completed, so there is nothing to break down. That is an absence, not a zero.");
  }
  for (const stage of cost.stages) {
    const share = cost.totalMs > 0 ? Math.round((stage.ms / cost.totalMs) * 100) : 0;
    lines.push(`  ${stage.stage.padEnd(34)} ${formatDuration(stage.ms).padStart(8)}  ${String(share).padStart(3)}%`);
    if (stage.detail) lines.push(`      ${stage.detail}`);
  }

  lines.push("", "BY CAMERA", "-".repeat(78));
  if (cost.cameras.length === 0) {
    lines.push("  No camera was swept, so there is nothing to break down.");
  }
  for (const camera of cost.cameras) {
    lines.push(
      `  ${camera.label}`,
      `      ${formatDuration(camera.ms)} across ${camera.steps} request(s)` +
        (camera.untried > 0 ? `, ${camera.untried} left untried` : "") +
        (camera.hitBudget ? "  ← reached its share of the run's time" : "")
    );
  }

  if (cost.slowestStep) {
    lines.push(
      "",
      "SLOWEST SINGLE REQUEST",
      "-".repeat(78),
      `  ${formatDuration(cost.slowestStep.ms)} — ${cost.slowestStep.label}`,
      `  Measured against the ${(cost.cameraDeadlineMs / 1000).toFixed(0)}-second camera deadline, which is the point at which a request is`,
      "  abandoned rather than waited on. A request close to that line is a camera that very nearly did not",
      "  answer at all."
    );
  }

  if (cost.perCameraBudgetMs != null) {
    lines.push(
      "",
      "THE PER-CAMERA CEILING",
      "-".repeat(78),
      `  Each camera was allowed ${formatDuration(cost.perCameraBudgetMs)} of its own. A camera that reaches it stops where it is and`,
      "  every step it never got to is listed as UNTRIED — which is its own word here. It is NOT a refusal, NOT",
      "  a limit the camera stated and NOT a timeout: those three exist separately, they mean different things,",
      "  and nothing whatsoever is inferred about a step that never ran.",
      "",
      "  The ceiling is generous on purpose. It exists for the one camera on a phone that takes fifteen seconds",
      "  to open and would otherwise consume the entire run on its own, leaving the other cameras unmeasured."
    );
  }

  return lines.join("\n");
}

/** The sentence the page shows once a camera has run out of its share. */
export function budgetReachedText(deviceLabel: string, budgetMs: number, untried: number): string {
  return (
    `${deviceLabel} reached its ${formatDuration(budgetMs)} share of the run's time with ${untried} request(s) still to go, so it stopped there and the sweep moved to the next camera. ` +
    `Those ${untried} are recorded as UNTRIED, by name. That is not a refusal, not a limit this camera stated and not a timeout — nothing was learned about them, and nothing is being guessed. ` +
    `Every row above for this camera really ran.`
  );
}
