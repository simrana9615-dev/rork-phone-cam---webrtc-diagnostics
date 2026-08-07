/**
 * Tests for the memory arithmetic that ended a run.
 *
 * The sweep crashed at 106 photos with 129.75 MB of captures held — a figure low
 * enough to prove the captures were not the cause. These tests pin down the two
 * costs that were never counted, because both were invisible in every number the
 * run displayed while being an order of magnitude larger than the one it did.
 */

import { describe, expect, it } from "vitest";
import {
  CANVAS_BYTES_PER_PIXEL,
  canvasBackingBytes,
  capturePolicyText,
  heldBytesCeiling,
  pixelSizeFromHeader,
} from "./capture-memory";
import type { MemoryHints } from "./hex-budget";

const noHints: MemoryHints = { deviceMemoryGb: null, heapLimitBytes: null };

describe("canvasBackingBytes", () => {
  it("prices a 4K canvas at the 31.6 MiB that broke the sweep", () => {
    const bytes = canvasBackingBytes(3840, 2160);
    expect(bytes).toBe(3840 * 2160 * CANVAS_BYTES_PER_PIXEL);
    expect(bytes / 1024 / 1024).toBeCloseTo(31.64, 1);
  });

  it("prices an 8K canvas above 126 MiB — one canvas, not one run", () => {
    expect(canvasBackingBytes(7680, 4320) / 1024 / 1024).toBeGreaterThan(126);
  });

  it("shows the old one-canvas-per-still cost exceeding any phone's budget", () => {
    // Roughly 14 canvas stills per camera across four cameras, each at 4K.
    const perStill = canvasBackingBytes(3840, 2160);
    const total = perStill * 14 * 4;
    expect(total / 1024 / 1024 / 1024).toBeGreaterThan(1.7);
    // Reusing one canvas holds exactly one frame regardless of the count.
    expect(perStill).toBeLessThan(total / 50);
  });

  it("never returns a negative or fractional size", () => {
    expect(canvasBackingBytes(-10, 100)).toBe(0);
    expect(canvasBackingBytes(0, 0)).toBe(0);
    expect(Number.isInteger(canvasBackingBytes(1920.7, 1080.2))).toBe(true);
  });
});

describe("heldBytesCeiling", () => {
  it("sits well above the 130 MB the crashed run was holding", () => {
    // A ceiling near the observed figure would cut off healthy runs, since the
    // captures were never what killed the tab.
    expect(heldBytesCeiling(noHints)).toBeGreaterThan(130 * 1024 * 1024 * 2);
  });

  it("is still a bound rather than no limit at all", () => {
    expect(heldBytesCeiling({ deviceMemoryGb: 8, heapLimitBytes: null })).toBeLessThan(1024 * 1024 * 1024);
  });

  it("rises with reported memory and never falls", () => {
    const tiers = [2, 4, 6, 8].map((gb) => heldBytesCeiling({ deviceMemoryGb: gb, heapLimitBytes: null }));
    for (let i = 1; i < tiers.length; i += 1) expect(tiers[i]).toBeGreaterThanOrEqual(tiers[i - 1]);
  });

  it("treats an unreported device as smaller than a large one", () => {
    expect(heldBytesCeiling(noHints)).toBeLessThan(heldBytesCeiling({ deviceMemoryGb: 8, heapLimitBytes: null }));
  });
});

/* Header bytes for the formats a browser can hand back. */

function jpegWithSof(width: number, height: number, extraSegments: number[][] = []): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  for (const segment of extraSegments) bytes.push(...segment);
  bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03);
  bytes.push(...new Array(6).fill(0));
  return new Uint8Array(bytes);
}

function app1(payloadBytes: number): number[] {
  const length = payloadBytes + 2;
  return [0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...new Array(payloadBytes).fill(0x41)];
}

describe("pixelSizeFromHeader", () => {
  it("reads JPEG dimensions from SOF, in the height-then-width order the spec uses", () => {
    const size = pixelSizeFromHeader(jpegWithSof(4032, 3024));
    expect(size).toEqual({ width: 4032, height: 3024, source: "jpeg-sof" });
  });

  it("walks past a large EXIF segment to reach the frame header", () => {
    // An iPhone JPEG carries a thumbnail in APP1, so SOF is never at a fixed offset.
    const size = pixelSizeFromHeader(jpegWithSof(3840, 2160, [app1(60_000)]));
    expect(size?.width).toBe(3840);
    expect(size?.height).toBe(2160);
  });

  it("returns null rather than a guess when scan data arrives with no frame header", () => {
    expect(pixelSizeFromHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  it("reads PNG dimensions from IHDR", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    bytes.set([0x00, 0x00, 0x04, 0x00], 16);
    bytes.set([0x00, 0x00, 0x03, 0x00], 20);
    expect(pixelSizeFromHeader(bytes)).toEqual({ width: 1024, height: 768, source: "png-ihdr" });
  });

  it("reads HEIC dimensions from the ispe box", () => {
    const bytes = new Uint8Array(48);
    bytes.set([0x00, 0x00, 0x00, 0x18], 0);
    bytes.set([0x66, 0x74, 0x79, 0x70], 4);
    bytes.set([0x69, 0x73, 0x70, 0x65], 24);
    bytes.set([0x00, 0x00, 0x0f, 0xc0], 32);
    bytes.set([0x00, 0x00, 0x0b, 0xd0], 36);
    expect(pixelSizeFromHeader(bytes)).toEqual({ width: 4032, height: 3024, source: "iso-bmff-ispe" });
  });

  it("reads a GIF header", () => {
    const bytes = new Uint8Array(10);
    bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    bytes.set([0x40, 0x01, 0xf0, 0x00], 6);
    expect(pixelSizeFromHeader(bytes)).toEqual({ width: 320, height: 240, source: "gif" });
  });

  it("declines a container it does not recognise instead of inventing numbers", () => {
    expect(pixelSizeFromHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
  });

  it("survives a truncated file without throwing", () => {
    expect(() => pixelSizeFromHeader(new Uint8Array([0xff, 0xd8]))).not.toThrow();
    expect(pixelSizeFromHeader(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("costs a header slice instead of a full decode", () => {
    // The point of the parse: a 4K photo's dimensions come from a few hundred
    // bytes, where the decode it replaced cost the whole 31.6 MiB frame.
    const header = jpegWithSof(3840, 2160);
    expect(header.byteLength).toBeLessThan(1024);
    expect(canvasBackingBytes(3840, 2160)).toBeGreaterThan(header.byteLength * 30_000);
  });
});

describe("capturePolicyText", () => {
  const facts = { heldBytes: 136_052_736, ceilingBytes: 335_544_320, peakCanvasBytes: 33_177_600, stillsStoppedForMemory: null };

  it("reports this run's real figures rather than the policy in the abstract", () => {
    const text = capturePolicyText(facts, noHints).join("\n");
    expect(text).toContain("129.8 MB");
    expect(text).toContain("320.0 MB");
    expect(text).toContain("31.6 MB");
  });

  it("names both uncounted costs and says the bytes are unaffected", () => {
    const text = capturePolicyText(facts, noHints).join("\n");
    expect(text).toMatch(/canvas/i);
    expect(text).toMatch(/decod/i);
    expect(text).toMatch(/bytes are unaffected/i);
  });

  it("says plainly when stills were not stopped", () => {
    expect(capturePolicyText(facts, noHints).join("\n")).toMatch(/stopped early for memory\s+no/i);
  });

  it("quotes the stop reason in full when stills did stop", () => {
    const stopped = { ...facts, stillsStoppedForMemory: "Capture bytes held reached 320.4 MB, at or above this device's 320 MB ceiling, so the sweep stopped taking stills." };
    const text = capturePolicyText(stopped, noHints).join("\n");
    expect(text).toMatch(/YES/);
    expect(text).toContain("320.4 MB");
  });

  it("keeps the three causes of an empty capture list apart", () => {
    const text = capturePolicyText(facts, noHints).join("\n");
    expect(text).toMatch(/three possible causes/i);
  });

  it("admits when the device reported no memory hint at all", () => {
    expect(capturePolicyText(facts, noHints).join("\n")).toMatch(/not reported/i);
    expect(capturePolicyText(facts, { deviceMemoryGb: 6, heapLimitBytes: null }).join("\n")).toContain("6 GB");
  });
});
