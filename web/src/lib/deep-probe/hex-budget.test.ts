import { describe, expect, it } from "vitest";

import {
  HEX_CHARS_PER_SOURCE_BYTE,
  HEX_MAX_PER_CAPTURE,
  HEX_MAX_TOTAL,
  HEX_MIN_PER_CAPTURE,
  HEX_MIN_TOTAL,
  hexBudgetForDevice,
  hexPolicyText,
  hexTextBytesFor,
  perCaptureHexBudget,
} from "./hex-budget";
import { hexLines } from "./raw-bytes";

describe("hex cost", () => {
  it("matches the real output of hexLines rather than an assumed line width", () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    // dumpRange pushes `${hexLines(...)}\n`, so one trailing newline joins the slices.
    const rendered = `${hexLines(bytes, 0)}\n`.length;
    const predicted = hexTextBytesFor(bytes.length);
    expect(Math.abs(rendered - predicted)).toBeLessThanOrEqual(1);
  });

  it("is the ratio that made a full-run dump impossible", () => {
    expect(HEX_CHARS_PER_SOURCE_BYTE).toBeCloseTo(4.9375, 4);
    // The number that broke the run: 192 MB of source became this much text.
    expect(hexTextBytesFor(192 * 1024 * 1024)).toBeGreaterThan(900 * 1024 * 1024);
  });
});

describe("hexBudgetForDevice", () => {
  it("does not treat an unmeasurable device as a generous one", () => {
    const unknown = hexBudgetForDevice({ deviceMemoryGb: null, heapLimitBytes: null });
    const large = hexBudgetForDevice({ deviceMemoryGb: 8, heapLimitBytes: null });
    expect(unknown).toBeLessThan(large);
  });

  it("scales with reported device memory", () => {
    const low = hexBudgetForDevice({ deviceMemoryGb: 2, heapLimitBytes: null });
    const mid = hexBudgetForDevice({ deviceMemoryGb: 4, heapLimitBytes: null });
    const high = hexBudgetForDevice({ deviceMemoryGb: 8, heapLimitBytes: null });
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("lets a small heap limit override a large memory claim", () => {
    const budget = hexBudgetForDevice({ deviceMemoryGb: 8, heapLimitBytes: 512 * 1024 * 1024 });
    expect(budget).toBeLessThan(HEX_MAX_TOTAL);
    // 6% of the heap, expressed in source bytes.
    expect(hexTextBytesFor(budget)).toBeLessThanOrEqual(512 * 1024 * 1024 * 0.06 + 1024);
  });

  it("never returns anything outside its own bounds", () => {
    const cases = [
      { deviceMemoryGb: null, heapLimitBytes: null },
      { deviceMemoryGb: 0.25, heapLimitBytes: 1 },
      { deviceMemoryGb: 64, heapLimitBytes: Number.MAX_SAFE_INTEGER },
      { deviceMemoryGb: 4, heapLimitBytes: 0 },
    ];
    for (const hints of cases) {
      const budget = hexBudgetForDevice(hints);
      expect(budget).toBeGreaterThanOrEqual(HEX_MIN_TOTAL);
      expect(budget).toBeLessThanOrEqual(HEX_MAX_TOTAL);
    }
  });

  it("keeps the worst case survivable on a phone", () => {
    // Even the most generous device must not let hex text alone approach the
    // point where a mobile tab is killed.
    const worst = hexTextBytesFor(HEX_MAX_TOTAL);
    expect(worst).toBeLessThan(200 * 1024 * 1024);
  });
});

describe("perCaptureHexBudget", () => {
  it("shares the budget equally instead of first-come", () => {
    const total = 16 * 1024 * 1024;
    const share = perCaptureHexBudget(total, 20);
    expect(share).toBe(Math.floor(total / 20));
    expect(share * 20).toBeLessThanOrEqual(total);
  });

  it("holds a floor so a big run on a small budget still shows every file's structure", () => {
    // The tightest real combination: the smallest budget against the largest
    // expected capture count. An equal share alone would fall to ~41 KB.
    const share = perCaptureHexBudget(HEX_MIN_TOTAL, 150);
    expect(Math.floor(HEX_MIN_TOTAL / 150)).toBeLessThan(HEX_MIN_PER_CAPTURE);
    expect(share).toBe(HEX_MIN_PER_CAPTURE);
  });

  it("spends the floor knowingly, accepting a small overrun to stay readable", () => {
    // The floor can exceed the equal share, so the total may pass the budget.
    // That is a deliberate trade and the overrun is bounded, not open-ended.
    const count = 150;
    const share = perCaptureHexBudget(HEX_MIN_TOTAL, count);
    expect(share * count).toBeGreaterThan(HEX_MIN_TOTAL);
    expect(hexTextBytesFor(share * count)).toBeLessThan(80 * 1024 * 1024);
  });

  it("caps a single capture even when the budget could cover more", () => {
    expect(perCaptureHexBudget(HEX_MAX_TOTAL, 1)).toBe(HEX_MAX_PER_CAPTURE);
  });

  it("keeps the floor wide enough for a JPEG's whole header region", () => {
    // headBytes in hexDumpBlob is max(64 KiB, 75% of the allowance) — EXIF, the
    // quantisation and Huffman tables and the ICC profile all sit well inside it.
    expect(HEX_MIN_PER_CAPTURE).toBeGreaterThanOrEqual(64 * 1024);
  });

  it("returns zero for no captures rather than dividing by zero", () => {
    expect(perCaptureHexBudget(16 * 1024 * 1024, 0)).toBe(0);
  });

  it("bounds the total text even at the floor with a very large run", () => {
    const count = 150;
    const share = perCaptureHexBudget(hexBudgetForDevice({ deviceMemoryGb: null, heapLimitBytes: null }), count);
    expect(hexTextBytesFor(share * count)).toBeLessThan(120 * 1024 * 1024);
  });
});

describe("hexPolicyText", () => {
  it("states the budget, the share and how to recover a skipped range", () => {
    const text = hexPolicyText(16 * 1024 * 1024, HEX_MIN_PER_CAPTURE, 150).join("\n");
    expect(text).toContain("HEX DUMP BUDGET");
    expect(text).toContain("150");
    expect(text).toContain("xxd -s");
    expect(text).toContain("byte-identical");
  });

  it("says what a window omits, so the gap is never left to inference", () => {
    const text = hexPolicyText(16 * 1024 * 1024, HEX_MIN_PER_CAPTURE, 40).join("\n");
    expect(text).toContain("entropy-coded scan data");
    expect(text).toMatch(/quantisation/);
  });
});
