import { describe, expect, it } from "vitest";

import { buildConstancy, constancyText, type ConstancyObservation } from "./constancy";

function observation(overrides: Partial<ConstancyObservation> = {}): ConstancyObservation {
  return {
    slug: "001",
    deviceLabel: "Back Camera",
    path: "canvas",
    width: 1920,
    height: 1080,
    traits: {},
    ...overrides,
  };
}

function classOf(observations: ConstancyObservation[], name: string): string | undefined {
  return buildConstancy(observations).traits.find((trait) => trait.name === name)?.classification;
}

describe("classifying what a trait moves with", () => {
  it("calls a trait universal only once it has held across more than one scope", () => {
    const classification = classOf(
      [
        observation({ slug: "a", path: "canvas", traits: { container: "jpeg" } }),
        observation({ slug: "b", path: "camera-file", traits: { container: "jpeg" } }),
      ],
      "container"
    );
    expect(classification).toBe("universal");
  });

  it("refuses to call a trait universal when it never had a chance to vary", () => {
    // One value, ten times, down one path on one camera. Consistent with a
    // constant; evidence of nothing.
    const observations = Array.from({ length: 10 }, (_, i) => observation({ slug: `s${i}`, traits: { container: "jpeg" } }));
    expect(classOf(observations, "container")).toBe("unestablished");
  });

  it("attributes a trait to the production path when it is constant within each path", () => {
    const classification = classOf(
      [
        observation({ slug: "a", path: "canvas", deviceLabel: "Back", traits: { "colour profile": "sRGB" } }),
        observation({ slug: "b", path: "canvas", deviceLabel: "Front", traits: { "colour profile": "sRGB" } }),
        observation({ slug: "c", path: "camera-file", deviceLabel: "Back", traits: { "colour profile": "Display P3" } }),
        observation({ slug: "d", path: "camera-file", deviceLabel: "Front", traits: { "colour profile": "Display P3" } }),
      ],
      "colour profile"
    );
    expect(classification).toBe("per-path");
  });

  it("attributes a trait to one lens when it is constant within each camera", () => {
    const classification = classOf(
      [
        observation({ slug: "a", path: "canvas", deviceLabel: "Back", traits: { lens: "wide" } }),
        observation({ slug: "b", path: "camera-file", deviceLabel: "Back", traits: { lens: "wide" } }),
        observation({ slug: "c", path: "canvas", deviceLabel: "Front", traits: { lens: "selfie" } }),
        observation({ slug: "d", path: "camera-file", deviceLabel: "Front", traits: { lens: "selfie" } }),
      ],
      "lens"
    );
    expect(classification).toBe("per-camera");
  });

  it("attributes a trait to the frame size when it follows the resolution", () => {
    const classification = classOf(
      [
        observation({ slug: "a", path: "canvas", deviceLabel: "Back", width: 1920, height: 1080, traits: { thumb: "160x90" } }),
        observation({ slug: "b", path: "camera-file", deviceLabel: "Front", width: 1920, height: 1080, traits: { thumb: "160x90" } }),
        observation({ slug: "c", path: "canvas", deviceLabel: "Front", width: 1280, height: 720, traits: { thumb: "120x68" } }),
        observation({ slug: "d", path: "camera-file", deviceLabel: "Back", width: 1280, height: 720, traits: { thumb: "120x68" } }),
      ],
      "thumb"
    );
    expect(classification).toBe("per-size");
  });

  it("says a trait moved without a pattern rather than picking one value and calling it typical", () => {
    const classification = classOf(
      [
        observation({ slug: "a", path: "canvas", deviceLabel: "Back", width: 1920, height: 1080, traits: { drift: "one" } }),
        observation({ slug: "b", path: "canvas", deviceLabel: "Back", width: 1920, height: 1080, traits: { drift: "two" } }),
        observation({ slug: "c", path: "camera-file", deviceLabel: "Front", width: 1280, height: 720, traits: { drift: "three" } }),
      ],
      "drift"
    );
    expect(classification).toBe("varies");
  });

  it("prefers the path explanation over the camera one when a trait fits both", () => {
    // Two cameras, each only ever seen down its own path: the split is real but
    // the path is the more fundamental of the two explanations.
    const classification = classOf(
      [
        observation({ slug: "a", path: "canvas", deviceLabel: "Back", traits: { tables: "0.95 quality" } }),
        observation({ slug: "b", path: "camera-file", deviceLabel: "Front", traits: { tables: "camera tables" } }),
      ],
      "tables"
    );
    expect(classification).toBe("per-path");
  });
});

describe("what a trait is not asked to explain", () => {
  it("leaves out a trait no capture could observe, instead of reporting it empty", () => {
    const report = buildConstancy([observation({ slug: "a", traits: { container: "jpeg" } }), observation({ slug: "b", traits: {} })]);
    expect(report.traits.map((trait) => trait.name)).toEqual(["container"]);
  });

  it("only counts the captures a trait was observable on", () => {
    const report = buildConstancy([
      observation({ slug: "a", path: "canvas", traits: { "maker note": "Apple" } }),
      observation({ slug: "b", path: "camera-file", traits: { "maker note": "Apple" } }),
      observation({ slug: "c", path: "picker-file", traits: {} }),
    ]);
    expect(report.traits[0].observations).toBe(2);
  });
});

describe("saying what the evidence could not cover", () => {
  it("warns when a single capture cannot classify anything", () => {
    const report = buildConstancy([observation({ traits: { container: "jpeg" } })]);
    expect(report.notes.join(" ")).toContain("Fewer than two captures");
  });

  it("warns when every capture came down one path", () => {
    const report = buildConstancy([
      observation({ slug: "a", path: "canvas", traits: { container: "jpeg" } }),
      observation({ slug: "b", path: "canvas", traits: { container: "jpeg" } }),
    ]);
    expect(report.notes.join(" ")).toContain("single production path");
  });

  it("warns when only one camera contributed", () => {
    const report = buildConstancy([
      observation({ slug: "a", path: "canvas", deviceLabel: "Back", traits: { container: "jpeg" } }),
      observation({ slug: "b", path: "camera-file", deviceLabel: "Back", traits: { container: "jpeg" } }),
    ]);
    expect(report.notes.join(" ")).toContain("Only one camera contributed");
  });

  it("records the coverage the classification actually rests on", () => {
    const report = buildConstancy([
      observation({ slug: "a", path: "canvas", deviceLabel: "Back", width: 1920, height: 1080, traits: { c: "x" } }),
      observation({ slug: "b", path: "camera-file", deviceLabel: "Front", width: 1280, height: 720, traits: { c: "x" } }),
    ]);
    expect(report.coverage.paths).toEqual(["camera-file", "canvas"]);
    expect(report.coverage.cameras).toEqual(["Back", "Front"]);
    expect(report.coverage.sizes).toHaveLength(2);
  });
});

describe("how it reads", () => {
  const report = buildConstancy([
    observation({ slug: "a", path: "canvas", deviceLabel: "Back", traits: { container: "jpeg", profile: "sRGB" } }),
    observation({ slug: "b", path: "camera-file", deviceLabel: "Front", traits: { container: "jpeg", profile: "Display P3" } }),
  ]);

  it("tells the reader what to hold constant", () => {
    expect(constancyText(report)).toContain("Hold this constant");
  });

  it("tells the reader what follows the path", () => {
    expect(constancyText(report)).toContain("FOLLOWS THE PRODUCTION PATH");
  });

  it("states the evidence base rather than leaving the classification unqualified", () => {
    expect(constancyText(report)).toContain("Evidence base: 2 capture(s)");
  });

  it("says plainly when there is nothing to classify", () => {
    expect(constancyText(buildConstancy([]))).toContain("nothing to classify");
  });
});
