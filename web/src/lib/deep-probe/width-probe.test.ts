import { describe, expect, it } from "vitest";

import { PROBE_WIDTH } from "./run-mode";
import { FACING_LABEL, widthProbeText, widthReading, widthVerdict, type WidthProbeReport, type WidthProbeRow } from "./width-probe";

function row(overrides: Partial<WidthProbeRow> = {}): WidthProbeRow {
  const base: WidthProbeRow = {
    facing: "environment",
    asked: { video: { width: PROBE_WIDTH, facingMode: "environment" }, audio: false },
    ok: true,
    error: null,
    openMs: 180,
    settings: { width: 640, height: 480, frameRate: 30, facingMode: "environment" },
    capabilities: { width: { min: 1, max: 4032 } },
    constraints: { width: 640, facingMode: "environment" },
    trackLabel: "Back Camera",
    trackId: "t1",
    streamId: "s1",
    chosenDeviceId: "dev-1",
    chosenGroupId: "grp-1",
    videoWidth: 640,
    videoHeight: 480,
    grantedWidth: 640,
    grantedHeight: 480,
    grantedAspect: 4 / 3,
    grantedFrameRate: 30,
    grantedFacing: "environment",
    verdict: "exact",
    captureSlugs: ["width640-environment-canvas"],
    notes: [],
    reading: "",
  };
  const merged = { ...base, ...overrides };
  return { ...merged, reading: widthReading(merged, PROBE_WIDTH) };
}

function report(overrides: Partial<WidthProbeReport> = {}): WidthProbeReport {
  return {
    startedAt: "2026-08-07T10:00:00.000Z",
    finishedAt: "2026-08-07T10:01:00.000Z",
    durationMs: 60_000,
    width: PROBE_WIDTH,
    rows: [row(), row({ facing: "user", grantedWidth: 480, grantedHeight: 640, verdict: "different", trackLabel: "Front Camera" })],
    impossible: [],
    impossibleObservations: [],
    aborted: false,
    devicesBefore: [],
    devicesAfter: [],
    notes: ["Only ONE constraint was sent per open."],
    ...overrides,
  };
}

describe("how the granted width is judged against the one asked for", () => {
  it("calls an exact match exact", () => {
    expect(widthVerdict(640, 640)).toBe("exact");
  });

  it("calls a small substitution near rather than different", () => {
    expect(widthVerdict(640, 656)).toBe("near");
    expect(widthVerdict(640, 608)).toBe("near");
  });

  it("calls a large substitution different, which is the interesting case", () => {
    expect(widthVerdict(640, 1280)).toBe("different");
    expect(widthVerdict(640, 320)).toBe("different");
  });

  it("refuses to judge when the track reported no width at all", () => {
    expect(widthVerdict(640, null)).toBe("unknown");
  });
});

describe("what one row says for itself", () => {
  it("names everything the phone chose that was never asked for", () => {
    const reading = row().reading;
    expect(reading).toContain("none of which were asked for");
    expect(reading).toContain("aspect ratio");
    expect(reading).toContain("fps");
  });

  it("calls a wildly different size the interesting case, and says a bare width is a wish", () => {
    const reading = row({ grantedWidth: 1280, grantedHeight: 720, verdict: "different" }).reading;
    expect(reading).toContain("This is the interesting case");
    expect(reading).toContain("a bare width is a WISH on this device, not an instruction");
  });

  it("treats a refusal as a result rather than a gap, and assumes nothing in its place", () => {
    const reading = row({ ok: false, error: "NotAllowedError: denied", verdict: "unknown" }).reading;
    expect(reading).toContain("That is a result, not a gap");
    expect(reading).toContain("Nothing has been assumed about what it would have returned");
  });

  it("calls a facingMode the track disagrees with a finding rather than an error", () => {
    const reading = row({ grantedFacing: "user" }).reading;
    expect(reading).toContain("honoured loosely, which is a finding rather than an error");
  });

  it("says the side cannot be confirmed when the track reports no facingMode", () => {
    expect(row({ grantedFacing: null }).reading).toContain("the side cannot be confirmed from the track itself");
  });

  it("works out the aspect ratio from the size when the track states none, and says it did", () => {
    const reading = row({ grantedAspect: null }).reading;
    expect(reading).toContain("worked out from the size because the track did not state one");
  });

  it("does not name a camera the track never named", () => {
    expect(row({ trackLabel: null }).reading).toContain("cannot be named from it");
  });
});

describe("the readable report", () => {
  it("states the exact constraint that was sent, so it can be repeated", () => {
    const text = widthProbeText(report());
    expect(text).toContain(`{ video: { width: ${PROBE_WIDTH}, facingMode: "environment" | "user" } }`);
  });

  it("reaches no verdict about whether the behaviour is good", () => {
    expect(widthProbeText(report())).toContain("Nothing below is a judgement about whether the behaviour is good");
  });

  it("names both cameras it opened", () => {
    const text = widthProbeText(report());
    expect(text).toContain(FACING_LABEL.environment);
    expect(text).toContain(FACING_LABEL.user);
  });

  it("prints the browser's own objects verbatim rather than a summary of them", () => {
    const text = widthProbeText(report());
    expect(text).toContain("getSettings()");
    expect(text).toContain("getCapabilities()");
  });

  it("says plainly when nothing was opened, rather than showing an empty table", () => {
    expect(widthProbeText(report({ rows: [] }))).toContain("No camera was opened at all");
  });

  it("shows a refusal as a refusal in the row, with the error name", () => {
    const text = widthProbeText(report({ rows: [row({ ok: false, error: "NotReadableError: busy", verdict: "unknown" })] }));
    expect(text).toContain("REFUSED");
    expect(text).toContain("NotReadableError");
  });
});
