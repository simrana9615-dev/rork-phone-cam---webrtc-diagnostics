import { describe, expect, it } from "vitest";

import {
  FAMILY_LABEL,
  IMPOSSIBLE_POLICY,
  impossibleAsksFor,
  impossibleObservations,
  impossibleReading,
  impossibleText,
  PHANTOM_DEVICE_ID,
  type ImpossibleAnswer,
  type ImpossibleAsk,
  type ImpossibleTarget,
} from "./impossible-asks";

const BACK: ImpossibleTarget = {
  deviceId: "camera-back-1",
  facingMode: "environment",
  label: "Back Triple Camera",
  capabilities: { zoom: { min: 1, max: 5 } } as MediaTrackCapabilities,
};

const UNKNOWN: ImpossibleTarget = { deviceId: null, facingMode: "user", label: "Front camera", capabilities: null };

function ask(id: string): ImpossibleAsk {
  const found = impossibleAsksFor(BACK, "full").find((entry) => entry.id === id);
  if (!found) throw new Error(`no ask called ${id}`);
  return found;
}

function answer(overrides: Partial<ImpossibleAnswer> & { askId: string }): ImpossibleAnswer {
  return {
    family: "impossible-size",
    asked: "something impossible",
    expectation: "it cannot be done",
    via: "open",
    deviceLabel: "Back Triple Camera",
    deviceId: "camera-back-1",
    outcome: "refused",
    errorName: "OverconstrainedError",
    errorMessage: "Constraint could not be satisfied",
    blamedConstraint: "width",
    durationMs: 40,
    grantedSettings: null,
    granted: null,
    settingsBefore: null,
    changedLiveTrack: null,
    reading: "",
    notes: [],
    ...overrides,
  };
}

describe("the battery of impossible asks", () => {
  it("covers every family the run promises, on a camera that stated its limits", () => {
    const families = new Set(impossibleAsksFor(BACK, "full").map((entry) => entry.family));
    for (const family of Object.keys(FAMILY_LABEL)) {
      expect(families.has(family as keyof typeof FAMILY_LABEL)).toBe(true);
    }
  });

  it("keeps the short battery a strict subset of the full one", () => {
    const full = impossibleAsksFor(BACK, "full").map((entry) => entry.id);
    const short = impossibleAsksFor(BACK, "short").map((entry) => entry.id);
    expect(short.length).toBeGreaterThan(0);
    expect(short.length).toBeLessThan(full.length);
    for (const id of short) expect(full).toContain(id);
  });

  it("says what ought to happen for every single ask, rather than leaving it implied", () => {
    for (const entry of impossibleAsksFor(BACK, "full")) {
      expect(entry.expectation.length).toBeGreaterThan(40);
      expect(entry.asked.length).toBeGreaterThan(5);
    }
  });

  it("pins the camera it was built for, or names the side when there is no id", () => {
    const pinned = ask("size-one-pixel").constraints as { deviceId?: { exact?: string } };
    expect(pinned.deviceId?.exact).toBe("camera-back-1");
    const bySide = impossibleAsksFor(UNKNOWN, "full").find((entry) => entry.id === "size-one-pixel")?.constraints as { facingMode?: { exact?: string } };
    expect(bySide?.facingMode?.exact).toBe("user");
  });

  it("only sets one camera against the other when it knows which one it is holding", () => {
    expect(impossibleAsksFor(BACK, "full").some((entry) => entry.id === "pin-versus-facing")).toBe(true);
    expect(impossibleAsksFor(UNKNOWN, "full").some((entry) => entry.id === "pin-versus-facing")).toBe(false);
  });

  it("measures zoom against the maximum the camera itself published", () => {
    const zoom = ask("live-zoom-beyond");
    expect(zoom.asked).toContain("20");
    expect(zoom.asked).toContain("5");
    const constraints = zoom.constraints as unknown as { advanced: { zoom: number }[] };
    expect(constraints.advanced[0].zoom).toBe(20);
  });

  it("does not fire a flash the camera advertised — that one is the sweep's job, once", () => {
    expect(impossibleAsksFor(BACK, "full").some((entry) => entry.id === "live-torch-unclaimed")).toBe(true);
    const withTorch: ImpossibleTarget = { ...BACK, capabilities: { torch: true } as MediaTrackCapabilities };
    expect(impossibleAsksFor(withTorch, "full").some((entry) => entry.id === "live-torch-unclaimed")).toBe(false);
  });

  it("asks for a camera that does not exist exactly once in a whole run", () => {
    const phantom = ask("phantom-device");
    expect(phantom.oncePerRun).toBe(true);
    expect((phantom.constraints as { deviceId?: { exact?: string } }).deviceId?.exact).toBe(PHANTOM_DEVICE_ID);
    expect(PHANTOM_DEVICE_ID).toHaveLength(64);
  });

  it("sends the same impossible ask twice, and two spellings of the same possible one", () => {
    expect(ask("repeat-size-absurd").repeatOf).toBe("size-absurd");
    expect(ask("size-absurd").constraints).toEqual(ask("repeat-size-absurd").constraints);
    expect(ask("synonym-min-max").synonymOf).toBe("synonym-exact");
  });

  it("ends the opening block with an ordinary request, so a wedged pipeline is caught", () => {
    const opens = impossibleAsksFor(BACK, "full").filter((entry) => entry.via === "open");
    expect(opens[opens.length - 1].id).toBe("recovery-plain");
    expect(opens[opens.length - 1].family).toBe("recovery");
  });
});

describe("reading one answer back", () => {
  it("treats a refusal as the informative answer and names the setting that was blamed", () => {
    const reading = impossibleReading(ask("size-absurd"), {
      outcome: "refused",
      errorName: "OverconstrainedError",
      errorMessage: "no",
      blamedConstraint: "width",
      granted: null,
      changedLiveTrack: null,
      durationMs: 31,
    });
    expect(reading).toContain("Refused after 31 ms");
    expect(reading).toContain('named "width"');
    expect(reading).toContain("informative answer");
  });

  it("records agreeing to the impossible without concluding anything from it", () => {
    const reading = impossibleReading(ask("size-absurd"), {
      outcome: "granted",
      errorName: null,
      errorMessage: null,
      blamedConstraint: null,
      granted: "1280×720",
      changedLiveTrack: null,
      durationMs: 900,
    });
    expect(reading).toContain("Granted after 900 ms");
    expect(reading).toContain("nothing is concluded from it");
  });

  it("never calls a timeout a refusal", () => {
    const reading = impossibleReading(ask("size-absurd"), {
      outcome: "timed-out",
      errorName: "CameraTimeoutError",
      errorMessage: null,
      blamedConstraint: null,
      granted: null,
      changedLiveTrack: null,
      durationMs: 10_000,
    });
    expect(reading).toContain("not a refusal");
    expect(reading).toContain("not evidence about the hardware");
  });

  it("says a rejected value never reached a camera", () => {
    const reading = impossibleReading(ask("malformed-nan-rate"), {
      outcome: "rejected-value",
      errorName: "TypeError",
      errorMessage: null,
      blamedConstraint: null,
      granted: null,
      changedLiveTrack: null,
      durationMs: 1,
    });
    expect(reading).toContain("before any camera was consulted");
  });
});

describe("where the answers disagree with each other", () => {
  it("notices the same ask refused two different ways on two consecutive attempts", () => {
    const seen = impossibleObservations([
      answer({ askId: "size-absurd" }),
      answer({ askId: "repeat-size-absurd", family: "repeat", errorName: "NotFoundError", blamedConstraint: null }),
    ]);
    expect(seen.join(" ")).toContain("refused two different ways");
    expect(seen.join(" ")).toContain("Nothing about the request changed");
  });

  it("notices identical refusals that took wildly different lengths of time", () => {
    const seen = impossibleObservations([answer({ askId: "size-absurd", durationMs: 20 }), answer({ askId: "repeat-size-absurd", family: "repeat", durationMs: 900 })]);
    expect(seen.join(" ")).toContain("The refusal is stable; the timing is not");
  });

  it("notices two spellings of the same request answered differently", () => {
    const seen = impossibleObservations([
      answer({ askId: "synonym-exact", family: "synonym", outcome: "granted", errorName: null, granted: "640×480" }),
      answer({ askId: "synonym-min-max", family: "synonym", outcome: "refused" }),
    ]);
    expect(seen.join(" ")).toContain("mean the same thing");
  });

  it("records the impossible being granted, and does not call it a fake", () => {
    const seen = impossibleObservations([answer({ askId: "size-absurd", outcome: "granted", errorName: null, granted: "1280×720" })]);
    expect(seen.join(" ")).toContain("granted rather than refused");
    expect(seen.join(" ").toLowerCase()).not.toContain("fake");
    expect(seen.join(" ").toLowerCase()).not.toContain("suspicious");
  });

  it("notices a failed change that moved the running picture anyway", () => {
    const seen = impossibleObservations([
      answer({
        askId: "live-size-impossible",
        family: "live-apply",
        via: "apply-live",
        outcome: "refused",
        settingsBefore: { width: 1280, height: 720 },
        grantedSettings: { width: 640, height: 480 },
        changedLiveTrack: true,
      }),
    ]);
    expect(seen.join(" ")).toContain("supposed to leave the picture exactly as it was");
  });

  it("notices a control that reported success while nothing moved", () => {
    const seen = impossibleObservations([
      answer({ askId: "live-zoom-beyond", family: "beyond-control", via: "apply-live", outcome: "granted", errorName: null, changedLiveTrack: false, asked: "zoom set to 20" }),
    ]);
    expect(seen.join(" ")).toContain("reported success, and the camera's settings did not move");
  });

  it("notices an invented setting being refused, which the standard says should be ignored", () => {
    const seen = impossibleObservations([answer({ askId: "invented-keys", family: "invented-key", outcome: "refused", blamedConstraint: "sparkleMode" })]);
    expect(seen.join(" ")).toContain("supposed to be ignored");
  });

  it("says plainly when the pipeline was already in trouble by the end of the round", () => {
    const seen = impossibleObservations([answer({ askId: "recovery-plain", family: "recovery", outcome: "refused", errorName: "NotReadableError" })]);
    expect(seen.join(" ")).toContain("before reading them as clean results");
  });

  it("notices one ask answered differently by two cameras on the same phone", () => {
    const seen = impossibleObservations([
      answer({ askId: "size-one-pixel", deviceLabel: "Back camera" }),
      answer({ askId: "size-one-pixel", deviceLabel: "Front camera", outcome: "granted", errorName: null, granted: "1×1" }),
    ]);
    expect(seen.join(" ")).toContain("answered differently by different cameras");
  });

  it("says nothing at all when nothing disagreed", () => {
    expect(impossibleObservations([answer({ askId: "size-absurd" }), answer({ askId: "repeat-size-absurd", family: "repeat" })])).toEqual([]);
  });
});

describe("the written record", () => {
  const text = impossibleText([answer({ askId: "size-absurd", reading: "Refused after 40 ms." })], ["Back camera: something disagreed."], ["a note"]);

  it("leads with why an impossible ask is worth sending at all", () => {
    expect(text).toContain(IMPOSSIBLE_POLICY);
    expect(text).toContain("succeeding is easy to imitate and refusing is not");
  });

  it("states that no photograph is taken anywhere in the stage", () => {
    expect(text).toContain("No photograph is taken anywhere in this stage.");
  });

  it("keeps refusal, rejected value, timeout and not-attempted as four separate words", () => {
    expect(text).toContain("REFUSED");
    expect(text).toContain("REJECTED VALUE means");
    expect(text).toContain("NOT ATTEMPTED means");
    expect(text).toContain("TIMED OUT means");
  });

  it("prints what was blamed, what was expected and what it means", () => {
    expect(text).toContain("blamed     width");
    expect(text).toContain("expected");
    expect(text).toContain("reading");
  });

  it("presents the disagreements as observations rather than verdicts", () => {
    expect(text).toContain("WHERE THE ANSWERS DISAGREE WITH EACH OTHER (1)");
    expect(text).toContain("reaches no verdict, scores nothing and accuses nobody");
  });

  it("says so plainly when the round never ran, instead of implying a refusal", () => {
    const empty = impossibleText([], []);
    expect(empty).toContain("Nothing here is a refusal; the round simply did not run.");
  });

  it("calls a clean round an observation rather than a pass mark", () => {
    const clean = impossibleText([answer({ askId: "size-absurd" })], []);
    expect(clean).toContain("That is an observation, not a pass mark.");
  });
});
