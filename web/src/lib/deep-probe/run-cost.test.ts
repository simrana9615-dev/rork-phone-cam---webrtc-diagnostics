import { describe, expect, it } from "vitest";

import {
  budgetReachedText,
  cameraBudgetMs,
  costText,
  createStepTimer,
  expectedMinutes,
  formatDuration,
  MIN_CAMERA_BUDGET_MS,
  MIN_SAMPLES_FOR_ESTIMATE,
  remainingEstimate,
  SWEEP_TIME_BUDGET_MS,
} from "./run-cost";

describe("durations in words", () => {
  it("uses seconds below a minute and minutes above it", () => {
    expect(formatDuration(9_400)).toBe("9s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("refuses to render a number it was not given", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("the share of the run each camera gets", () => {
  it("divides the sweep budget between the cameras that exist", () => {
    expect(cameraBudgetMs(4)).toBe(SWEEP_TIME_BUDGET_MS / 4);
  });

  it("never drops below the floor, however many cameras a phone enumerates", () => {
    expect(cameraBudgetMs(20)).toBe(MIN_CAMERA_BUDGET_MS);
  });

  it("is generous enough that a camera behaving normally never meets it", () => {
    // A four-camera phone spending 2.5 minutes on one camera is already far
    // outside anything observed; the ceiling exists for the pathological case.
    expect(cameraBudgetMs(4)).toBeGreaterThan(120_000);
  });
});

describe("how much longer, from this phone's own step times", () => {
  const timerWith = (samples: number[]) => {
    const timer = createStepTimer();
    for (const sample of samples) timer.record(sample);
    return timer;
  };

  it("says it is too early rather than showing a number built on four samples", () => {
    const estimate = remainingEstimate(4, 100, timerWith([80, 90, 100, 110]), true);
    expect(estimate.ms).toBeNull();
    expect(estimate.text).toBe("too early to say");
    expect(estimate.confident).toBe(false);
  });

  it("uses the median, so one timed-out step cannot drag the whole estimate", () => {
    const samples = [80, 82, 85, 90, 95, 100, 105, 10_000];
    const timer = timerWith(samples);
    expect(timer.count()).toBeGreaterThanOrEqual(MIN_SAMPLES_FOR_ESTIMATE);
    expect(timer.medianMs()).toBeLessThan(200);
    const estimate = remainingEstimate(8, 108, timer, true);
    expect(estimate.ms).toBeLessThan(30_000);
  });

  it("refuses to call an estimate confident while the plan is still being read", () => {
    const estimate = remainingEstimate(10, 100, timerWith(Array(12).fill(500)), false);
    expect(estimate.confident).toBe(false);
    expect(estimate.text).toContain("still being read");
  });

  it("names the slowest step it saw, which is the one worth reporting", () => {
    const timer = createStepTimer();
    timer.recordLabelled("Front Camera — 720p", 120);
    timer.recordLabelled("Back Camera — native maximum", 9_400);
    expect(timer.slowest()).toEqual({ label: "Back Camera — native maximum", ms: 9_400 });
  });
});

describe("the range offered before anything has been measured", () => {
  it("moves with the number of cameras rather than staying where it was typed", () => {
    const one = expectedMinutes(1, 10);
    const five = expectedMinutes(5, 10);
    expect(five.low).toBeGreaterThan(one.low);
    expect(five.high).toBeGreaterThan(one.high);
  });

  it("says what it was derived from", () => {
    expect(expectedMinutes(3, 12).derivedFrom).toContain("3 camera(s)");
    expect(expectedMinutes(3, 12).derivedFrom).toContain("12 permission prompt(s)");
  });

  it("says plainly that it cannot see the cameras yet rather than inventing a count", () => {
    const blind = expectedMinutes(null, 10);
    expect(blind.derivedFrom).toContain("not readable yet");
    expect(blind.derivedFrom).toContain("widest honest range");
  });

  it("never presents itself as a measurement", () => {
    expect(expectedMinutes(4, 10).derivedFrom).toContain("It is an estimate until the run measures itself");
  });
});

describe("the cost section the archive carries", () => {
  const text = costText({
    totalMs: 480_000,
    stages: [
      { stage: "Permissions", ms: 60_000 },
      { stage: "Camera sweep", ms: 300_000 },
    ],
    cameras: [
      { label: "Back Triple Camera", ms: 200_000, steps: 41, untried: 0, hitBudget: false },
      { label: "Back Telephoto Camera", ms: 150_000, steps: 12, untried: 9, hitBudget: true },
    ],
    slowestStep: { label: "Back Telephoto Camera — native maximum", ms: 9_800 },
    cameraDeadlineMs: 10_000,
    perCameraBudgetMs: 150_000,
  });

  it("states plainly that every figure was measured on this phone", () => {
    expect(text).toContain("Measured, not estimated");
    expect(text).toContain("an average of other devices");
    expect(text).toContain("wall clock reading taken during this run on this");
  });

  it("breaks the run down by stage and by camera", () => {
    expect(text).toContain("Permissions");
    expect(text).toContain("Back Triple Camera");
    expect(text).toContain("41 request(s)");
  });

  it("marks the camera that ran out of its share, and counts what it left", () => {
    expect(text).toContain("9 left untried");
    expect(text).toContain("reached its share of the run's time");
  });

  it("measures the slowest request against the deadline it was racing", () => {
    expect(text).toContain("SLOWEST SINGLE REQUEST");
    expect(text).toContain("10-second camera deadline");
  });

  it("keeps untried separate from refused, stated, and timed out", () => {
    expect(text).toContain("NOT a refusal");
    expect(text).toContain("a limit the camera stated");
    expect(text).toContain("NOT a timeout");
    expect(text).toContain("nothing whatsoever is inferred about a step that never ran");
  });

  it("says a slow camera is a fact rather than a fault", () => {
    expect(text.replace(/\s+/g, " ")).toContain("a slow camera is not a fault");
  });
});

describe("what the run says when a camera runs out of its share", () => {
  const text = budgetReachedText("Back Ultra Wide Camera", 150_000, 9);

  it("names the camera, the ceiling and how much was left", () => {
    expect(text).toContain("Back Ultra Wide Camera");
    expect(text).toContain("2m 30s");
    expect(text).toContain("9 request(s)");
  });

  it("refuses to let untried be read as any of the three things it is not", () => {
    expect(text).toContain("not a refusal, not a limit this camera stated and not a timeout");
    expect(text).toContain("nothing is being guessed");
  });

  it("confirms the rows that do exist really ran", () => {
    expect(text).toContain("Every row above for this camera really ran");
  });
});
