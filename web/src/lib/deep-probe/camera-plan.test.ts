import { describe, expect, it } from "vitest";

import { ceilingFrom, nativeMaxStep, planFor, type CameraCeiling } from "./camera-matrix";

const NO_CEILING: CameraCeiling = { maxWidth: null, maxHeight: null, maxFrameRate: null, aspectRange: null };

function asked(ceiling: CameraCeiling): string[] {
  return planFor("device-1", ceiling).steps.map((step) => step.asked);
}

describe("reading a camera's stated ceiling", () => {
  it("returns nothing but nulls when there is no capability object", () => {
    expect(ceilingFrom(null)).toEqual(NO_CEILING);
  });

  it("reads the maxima a browser actually reports", () => {
    const ceiling = ceilingFrom({ width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 }, aspectRatio: { min: 0.5, max: 2 } } as MediaTrackCapabilities);
    expect(ceiling).toEqual({ maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, aspectRange: { min: 0.5, max: 2 } });
  });

  it("treats a missing field as unstated rather than as zero", () => {
    const ceiling = ceilingFrom({ width: { max: 1920 } } as MediaTrackCapabilities);
    expect(ceiling.maxWidth).toBe(1920);
    expect(ceiling.maxHeight).toBeNull();
    expect(ceiling.maxFrameRate).toBeNull();
    expect(ceiling.aspectRange).toBeNull();
  });

  it("refuses a nonsense range instead of planning against it", () => {
    const ceiling = ceilingFrom({ width: { max: 0 }, aspectRatio: { min: 2, max: 1 } } as MediaTrackCapabilities);
    expect(ceiling.maxWidth).toBeNull();
    expect(ceiling.aspectRange).toBeNull();
  });
});

describe("the plan built for one camera", () => {
  it("asks everything when the camera stated no limits at all", () => {
    const { steps, notes } = planFor("device-1", NO_CEILING);
    expect(steps.filter((step) => step.kind === "resolution" && !step.asked.includes("portrait")).length).toBe(4);
    expect(steps.filter((step) => step.kind === "frame-rate").length).toBe(4);
    expect(notes).toEqual([]);
  });

  it("does not ask a 720p camera for 4K", () => {
    const lines = asked({ ...NO_CEILING, maxWidth: 1280, maxHeight: 720 });
    expect(lines.some((line) => line.includes("4K UHD"))).toBe(false);
  });

  it("keeps exactly one ask above the ceiling, because clamping and refusing are different answers", () => {
    const lines = asked({ ...NO_CEILING, maxWidth: 1280, maxHeight: 720 });
    const over = lines.filter((line) => line.includes("above the ceiling"));
    expect(over).toHaveLength(1);
    expect(over[0]).toContain("1080p");
  });

  it("says which figure shortened the plan, in the camera's own numbers", () => {
    const { notes } = planFor("device-1", { ...NO_CEILING, maxWidth: 1280, maxHeight: 720 });
    expect(notes.join(" ")).toContain("1280×720");
    expect(notes.join(" ")).toContain("clamps to its ceiling or refuses outright");
  });

  it("claims nothing about the rungs it did not send", () => {
    const { notes } = planFor("device-1", { ...NO_CEILING, maxWidth: 1280, maxHeight: 720 });
    expect(notes.join(" ")).toContain("Nothing here is a claim about what they would have returned");
  });

  it("asks portrait once per camera rather than once per rung", () => {
    const lines = asked(NO_CEILING);
    expect(lines.filter((line) => line.includes("portrait"))).toHaveLength(1);
  });

  it("stops at the frame rate the camera advertised, plus one step over", () => {
    const lines = asked({ ...NO_CEILING, maxFrameRate: 30 });
    const rates = lines.filter((line) => line.includes("fps"));
    expect(rates.some((line) => line.startsWith("exactly 15 fps"))).toBe(true);
    expect(rates.some((line) => line.startsWith("exactly 30 fps"))).toBe(true);
    expect(rates.some((line) => line.startsWith("exactly 60 fps"))).toBe(true);
    expect(rates.some((line) => line.startsWith("exactly 120 fps"))).toBe(false);
  });

  it("leaves out a ratio the camera says it cannot produce, and says whose statement that was", () => {
    const { steps, notes } = planFor("device-1", { ...NO_CEILING, aspectRange: { min: 1.3, max: 1.4 } });
    const ratios = steps.filter((step) => step.kind === "aspect-ratio").map((step) => step.asked);
    expect(ratios).toHaveLength(1);
    expect(ratios[0]).toContain("4:3");
    expect(notes.join(" ")).toContain("the camera's own statement about itself, not an assumption");
  });

  it("pins every step to the camera it was built for", () => {
    const { steps } = planFor("device-abc", NO_CEILING);
    for (const step of steps) {
      expect((step.constraints as { deviceId?: { exact?: string } }).deviceId?.exact).toBe("device-abc");
    }
  });

  it("photographs exactly one step per camera, the smallest rung, down the canvas path", () => {
    const { steps } = planFor("device-1", NO_CEILING);
    const photographed = steps.filter((step) => step.still !== "none");
    expect(photographed).toHaveLength(1);
    expect(photographed[0].still).toBe("canvas-small");
    expect(photographed[0].asked).toContain("VGA");
  });

  it("says on every other step that no photograph was taken there, and why", () => {
    const { steps } = planFor("device-1", NO_CEILING);
    for (const step of steps.filter((entry) => entry.still === "none")) {
      expect(step.stillNote).toContain("No photograph was taken at this step");
      expect(step.stillNote).toContain("photographed exactly twice");
    }
  });

  it("still asks every behaviour step in full, photograph or not", () => {
    const { steps } = planFor("device-1", NO_CEILING);
    expect(steps.filter((step) => step.kind === "frame-rate")).toHaveLength(4);
    expect(steps.filter((step) => step.kind === "aspect-ratio")).toHaveLength(3);
    expect(steps.filter((step) => step.kind === "frame-rate").every((step) => step.still === "none")).toBe(true);
  });
});

describe("the step that opens every camera first", () => {
  const step = nativeMaxStep("device-1");

  it("asks for the ceiling rather than assuming one", () => {
    expect(step.kind).toBe("native-max");
    expect(step.asked).toContain("native maximum");
  });

  it("takes the platform photo and not the several-megabyte canvas copy of it", () => {
    expect(step.still).toBe("platform-native-max");
    expect(step.stillNote).toBeUndefined();
  });
});
