import { describe, expect, it } from "vitest";

import { fallbackReason, routesNotNeededReason, zoomNotAskedReason } from "./adaptive-manual";

describe("the spare routes into the camera app", () => {
  const reason = routesNotNeededReason("environment", "native-camera", ["capture-boolean", "capacitor"]);

  it("names the route that answered and the ones that were never opened", () => {
    expect(reason).toContain("native-camera");
    expect(reason).toContain("capture-boolean and capacitor");
  });

  it("says the side has its file, rather than that shots were dropped", () => {
    expect(reason).toContain("ONE file the camera itself wrote for each side");
    expect(reason).toContain("the side is not missing anything");
  });

  it("makes no claim about what the untried routes would have returned", () => {
    expect(reason).toContain("Nothing here is a claim about what those routes would have returned");
  });

  it("states the spares would have been offered had the first failed", () => {
    expect(reason).toMatch(/Had native-camera failed or come back empty/);
  });

  it("uses the right word for a single spare", () => {
    expect(routesNotNeededReason("user", "native-camera", ["capacitor"])).toContain("capacitor was never opened");
  });

  it("names the side it is talking about", () => {
    expect(routesNotNeededReason("user", "native-camera", ["capacitor"])).toContain("front camera");
    expect(routesNotNeededReason("environment", "native-camera", ["capacitor"])).toContain("back camera");
  });
});

describe("what the run says when a side had to fall back", () => {
  const attempts = [
    { engine: "native-camera", outcome: "cancelled", detail: "the camera was closed without a picture" },
    { engine: "capture-boolean", outcome: "file", detail: 'returned "IMG_0002.HEIC", 3,101,244 bytes' },
  ];

  it("names every route tried and the one that finally answered", () => {
    const reason = fallbackReason("user", attempts);
    expect(reason).toContain("native-camera");
    expect(reason).toContain("It answered on capture-boolean");
  });

  it("treats the fallback itself as a fact about the device", () => {
    expect(fallbackReason("user", attempts)).toContain("the routes into a camera app are not interchangeable here");
  });

  it("says plainly when no route produced anything, and substitutes nothing", () => {
    const nothing = fallbackReason("environment", [
      { engine: "native-camera", outcome: "cancelled", detail: "closed empty" },
      { engine: "capture-boolean", outcome: "failed", detail: "NotAllowedError" },
      { engine: "capacitor", outcome: "failed", detail: "not installed" },
    ]);
    expect(nothing).toContain("none produced a file");
    expect(nothing).toContain("nothing has been substituted for it");
    expect(nothing).toContain("a library pick is not a photo taken just now");
  });
});

describe("the zoom shot that was not asked for", () => {
  const reason = zoomNotAskedReason("Back Ultra Wide Camera");

  it("names the camera that answered", () => {
    expect(reason).toContain("Back Ultra Wide Camera");
  });

  it("points at the sweep rows that already hold the answer", () => {
    expect(reason).toContain("showed no zoom range in the sweep");
    expect(reason).toContain("the sweep rows already hold");
  });

  it("makes clear the camera answered, and the answer was none", () => {
    expect(reason).toContain('the answer was "none"');
    expect(reason).toContain("Nothing");
    expect(reason).toContain("about the lens is assumed here");
  });

  it("never claims an answer for a camera that was not asked", () => {
    const unasked = zoomNotAskedReason("Back Telephoto Camera", false);
    expect(unasked).toContain("was never asked about zoom");
    expect(unasked).toContain("This is an ABSENCE, not an answer");
    expect(unasked).toContain("did not say it has no zoom");
    expect(unasked).not.toContain("showed no zoom range");
  });
});

describe("the policy note the archive carries", () => {
  it("explains the two-file goal rather than the old six-shot list", async () => {
    const { ADAPTIVE_POLICY } = await import("./adaptive-manual");
    const text = ADAPTIVE_POLICY.join("\n");
    expect(text).toContain("exactly TWO files");
    expect(text).toContain("as spares, tried in turn, not as three separate trips");
  });

  it("states that zoom is asked of every camera, repeat control surface or not", async () => {
    const { ADAPTIVE_POLICY } = await import("./adaptive-manual");
    const text = ADAPTIVE_POLICY.join("\n");
    expect(text).toContain("Every camera is asked the zoom questions in the sweep");
    expect(text).toContain("it was never asked");
  });
});
