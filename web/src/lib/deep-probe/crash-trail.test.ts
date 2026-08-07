import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearTrail,
  crashTrailText,
  finishTrail,
  FREEZE_GAP_MS,
  HEARTBEAT_MS,
  mark,
  markLeft,
  setHeldBytes,
  startTrail,
  stopHeartbeat,
  takeCrashReport,
} from "./crash-trail";

/** A minimal synchronous localStorage, which is all the trail needs. */
function installStorage(): void {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    removeItem: (key: string): void => void map.delete(key),
    clear: (): void => map.clear(),
    key: (index: number): string | null => Array.from(map.keys())[index] ?? null,
    get length(): number {
      return map.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
}

/** Fakes the heap readings a Chromium-family browser exposes. */
function setHeap(used: number | null, limit: number | null): void {
  const memory = used == null && limit == null ? undefined : { usedJSHeapSize: used ?? 0, jsHeapSizeLimit: limit ?? 0 };
  vi.stubGlobal("performance", { now: () => performanceNow, memory });
}

let performanceNow = 0;

beforeEach(() => {
  performanceNow = 0;
  installStorage();
  setHeap(null, null);
  clearTrail();
});

describe("a clean run", () => {
  it("leaves nothing for the next visit to report", () => {
    startTrail({ scope: "extended" });
    mark("step one");
    mark("step two");
    finishTrail("complete");
    expect(takeCrashReport()).toBeNull();
  });

  it("reports a thrown error as a bug rather than a resource death", () => {
    startTrail({ scope: "extended" });
    mark("step one");
    finishTrail("failed", "boom");
    const report = takeCrashReport();
    expect(report?.cause).toBe("threw");
    expect(report?.verdict).toContain("boom");
    expect(report?.verdict).toContain("never killed");
  });

  it("treats a deliberate reload as what it is", () => {
    startTrail({ scope: "extended" });
    mark("step one");
    markLeft();
    const report = takeCrashReport();
    expect(report?.cause).toBe("left-deliberately");
    expect(report?.verdict).toContain("not a crash");
  });
});

describe("a run that never closed its trail", () => {
  it("names the step that was in flight", () => {
    startTrail({ scope: "extended", captures: 106 });
    mark("Checksumming sweep-01");
    performanceNow = 900;
    mark("Rendering hex for sweep-02");
    stopHeartbeat();
    const report = takeCrashReport();
    expect(report?.diedIn).toBe("Rendering hex for sweep-02");
    expect(report?.diedAtIndex).toBe(2);
    expect(report?.context.captures).toBe(106);
  });

  it("reports the trail exactly once", () => {
    startTrail({ scope: "extended" });
    mark("step one");
    stopHeartbeat();
    expect(takeCrashReport()).not.toBeNull();
    expect(takeCrashReport()).toBeNull();
  });

  it("carries the held-byte figure the caller reported", () => {
    startTrail({ scope: "extended" });
    setHeldBytes(129.75 * 1024 * 1024);
    mark("Rendering hex for sweep-40");
    stopHeartbeat();
    const report = takeCrashReport();
    expect(report?.heldBytes).toBeCloseTo(129.75 * 1024 * 1024, 0);
    setHeldBytes(null);
  });
});

describe("telling the two deaths apart", () => {
  it("calls it a freeze when the heartbeat stops as the step begins", () => {
    startTrail({ scope: "extended" });
    performanceNow = 5_000;
    mark("Rendering hex for sweep-02");
    // No further heartbeat: the thread blocked the moment the step started.
    stopHeartbeat();
    const report = takeCrashReport();
    expect(report?.cause).toBe("unresponsive");
    expect(report?.silenceAfterMs).toBeLessThan(FREEZE_GAP_MS);
    expect(report?.verdict).toContain("Memory was not the cause");
  });

  it("calls it memory when the page kept answering and the heap was near the limit", () => {
    setHeap(80 * 1024 * 1024, 100 * 1024 * 1024);
    startTrail({ scope: "extended" });
    performanceNow = 4_000;
    mark("Assembling 812 entries");
    // The heartbeat kept firing for four seconds into the step, then stopped dead.
    beatAt(8_000);
    stopHeartbeat();
    const report = takeCrashReport();
    expect(report?.cause).toBe("out-of-memory");
    expect(report?.verdict).toContain("80%");
    expect(report?.verdict).toContain("still responding");
  });

  it("refuses to guess when the browser reports no heap at all", () => {
    startTrail({ scope: "extended" });
    performanceNow = 3_000;
    mark("Assembling 812 entries");
    beatAt(9_000);
    stopHeartbeat();
    const report = takeCrashReport();
    expect(report?.cause).toBe("undetermined");
    expect(report?.verdict).toContain("cannot be confirmed");
    expect(report?.verdict).toContain("not frozen");
  });

  it("uses a heartbeat fast enough to time a freeze", () => {
    expect(HEARTBEAT_MS).toBeLessThan(FREEZE_GAP_MS / 4);
  });
});

describe("the pasteable trail", () => {
  it("states the step, the reading and how the reading was reached", () => {
    setHeap(64 * 1024 * 1024, 512 * 1024 * 1024);
    startTrail({ scope: "extended", archiveRequested: true });
    mark("Checksumming sweep-01");
    performanceNow = 1_200;
    mark("Rendering hex for sweep-02");
    stopHeartbeat();
    const report = takeCrashReport();
    expect(report).not.toBeNull();
    const text = crashTrailText(report!);
    expect(text).toContain("Rendering hex for sweep-02");
    expect(text).toContain("HOW THAT IS DECIDED");
    expect(text).toContain("archiveRequested");
    expect(text).toContain("Checksumming sweep-01");
    expect(text).toContain("the run ended here");
  });

  it("keeps the trail bounded without pretending it is complete", () => {
    startTrail({ scope: "extended" });
    for (let i = 0; i < 400; i += 1) {
      performanceNow = i * 10;
      mark(`step ${i}`);
    }
    stopHeartbeat();
    const report = takeCrashReport();
    expect(report).not.toBeNull();
    expect(report!.steps.length).toBeLessThanOrEqual(110);
    expect(report!.dropped).toBeGreaterThan(0);
    // The first steps are always kept: a run's opening is where the baseline is.
    expect(report!.steps[0].step).toBe("step 0");
    // And the last step is the one that matters most.
    expect(report!.diedIn).toBe("step 399");
    expect(crashTrailText(report!)).toContain("dropped to keep this trail small");
  });
});

/**
 * Writes the note the heartbeat interval would have left at that moment. The
 * interval is a real timer and these tests are about the arithmetic that reads
 * its last note, so the note is written directly rather than waited for.
 */
function beatAt(atMs: number): void {
  const raw = localStorage.getItem("deep-probe.trail.v1");
  if (!raw) throw new Error("no trail to beat against");
  const { runId } = JSON.parse(raw) as { runId: string };
  localStorage.setItem("deep-probe.trail-beat.v1", JSON.stringify({ runId, atMs, atEpoch: Date.now() }));
}
