import { describe, expect, it } from "vitest";

import { handoffDecision, zoomSkipReason, type HandoffSighting } from "./adaptive-manual";

const ENGINES = ["native-camera", "capture-boolean", "capacitor"];

function sighting(engine: string, shapeId: string, facing: "user" | "environment" = "environment"): HandoffSighting {
  return { engine, facing, shapeId, slug: `${engine}-${facing}` };
}

describe("stopping the camera-app handoffs once they have been answered", () => {
  it("asks for nothing less after only one engine has returned", () => {
    const decision = handoffDecision([sighting("native-camera", "aaaa")], "environment", ["capture-boolean", "capacitor"]);
    expect(decision.skipEngines).toEqual([]);
    expect(decision.reason).toBeNull();
  });

  it("drops the remaining engines once two of them return one shape", () => {
    const seen = [sighting("native-camera", "aaaa"), sighting("capture-boolean", "aaaa")];
    const decision = handoffDecision(seen, "environment", ["capacitor"]);
    expect(decision.skipEngines).toEqual(["capacitor"]);
  });

  it("keeps asking when two engines returned genuinely different files", () => {
    const seen = [sighting("native-camera", "aaaa"), sighting("capture-boolean", "bbbb")];
    const decision = handoffDecision(seen, "environment", ["capacitor"]);
    expect(decision.skipEngines).toEqual([]);
    expect(decision.reason).toBeNull();
  });

  it("will not take one engine agreeing with itself as agreement", () => {
    const seen = [sighting("native-camera", "aaaa"), { ...sighting("native-camera", "aaaa"), slug: "again" }];
    expect(handoffDecision(seen, "environment", ["capture-boolean", "capacitor"]).skipEngines).toEqual([]);
  });

  it("keeps the two facings separate, because one proves nothing about the other", () => {
    const seen = [sighting("native-camera", "aaaa", "environment"), sighting("capture-boolean", "aaaa", "environment")];
    expect(handoffDecision(seen, "user", ENGINES).skipEngines).toEqual([]);
  });

  it("drops the front handoffs on the front camera's own evidence", () => {
    const seen = [sighting("native-camera", "cccc", "user"), sighting("capture-boolean", "cccc", "user")];
    expect(handoffDecision(seen, "user", ["capacitor"]).skipEngines).toEqual(["capacitor"]);
  });

  it("says nothing when the agreeing engines are the only ones left anyway", () => {
    const seen = [sighting("native-camera", "aaaa"), sighting("capture-boolean", "aaaa")];
    expect(handoffDecision(seen, "environment", []).reason).toBeNull();
  });
});

describe("what the skip says for itself", () => {
  const seen = [sighting("native-camera", "aaaa"), sighting("capture-boolean", "aaaa")];
  const reason = handoffDecision(seen, "environment", ["capacitor"]).reason ?? "";

  it("names both engines that agreed and the shape they agreed on", () => {
    expect(reason).toContain("native-camera and capture-boolean");
    expect(reason).toContain("aaaa");
  });

  it("names the engine that was not asked for", () => {
    expect(reason).toContain("capacitor");
  });

  it("states it was proven redundant rather than that anything failed", () => {
    expect(reason).toContain("PROVEN redundant, not because it failed");
  });

  it("explains why a third copy would not have been evidence", () => {
    expect(reason).toContain("third copy of a file already held is not evidence");
  });
});

describe("the zoom skip", () => {
  const reason = zoomSkipReason("Back Ultra Wide Camera");

  it("names the camera that answered", () => {
    expect(reason).toContain("Back Ultra Wide Camera");
  });

  it("keeps the fact it learned rather than only the shots it dropped", () => {
    expect(reason).toContain("this");
    expect(reason).toContain("camera has no zoom range");
  });

  it("makes clear the camera answered, and the answer was none", () => {
    expect(reason).toContain('the answer was "none"');
    expect(reason).toContain("Nothing about the lens is being assumed");
  });
});
