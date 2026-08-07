import { describe, expect, it } from "vitest";

import { measureSample, pixelText } from "./pixel-probe";

/**
 * Builds a sample from a per-pixel luma function, so a grid can be planted at a
 * known phase and the reader can be checked against a fact rather than a guess.
 */
function sample(width: number, height: number, luma: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const value = Math.max(0, Math.min(255, Math.round(luma(x, y))));
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return data;
}

/** A step every 8 rows, offset by `shift`, which is what a block grid looks like. */
function banded(shift: number): (x: number, y: number) => number {
  return (_x, y) => (Math.floor((y + shift) / 8) % 2 === 0 ? 90 : 140);
}

/** The same in both directions, which is what a real block grid actually is. */
function blocked(shiftX: number, shiftY: number): (x: number, y: number) => number {
  return (x, y) => (Math.floor((y + shiftY) / 8) % 2 === 0 ? 90 : 140) + (Math.floor((x + shiftX) / 8) % 2 === 0 ? 0 : 24);
}

describe("finding the block grid", () => {
  it("reports an aligned grid when the blocks sit on the 8-pixel boundary", () => {
    const { grid } = measureSample(sample(64, 64, blocked(0, 0)), 64, 64);
    expect(grid.present).toBe(true);
    expect(grid.phaseX).toBe(0);
    expect(grid.phaseY).toBe(0);
    expect(grid.aligned).toBe(true);
  });

  it("calls an aligned grid the non-finding it is", () => {
    const { grid } = measureSample(sample(64, 64, blocked(0, 0)), 64, 64);
    expect(grid.reading).toContain("NOT a finding");
  });

  it("finds the phase of a grid that was shifted down", () => {
    // Shifted by 5 means the step lands where (y + 5) % 8 === 0, i.e. y % 8 === 3.
    const { grid } = measureSample(sample(64, 64, banded(5)), 64, 64);
    expect(grid.phaseY).toBe(3);
    expect(grid.aligned).toBe(false);
  });

  it("finds the phase on both axes independently", () => {
    const { grid } = measureSample(sample(64, 64, blocked(6, 5)), 64, 64);
    expect(grid.phaseY).toBe(3);
    expect(grid.phaseX).toBe(2);
  });

  it("says an offset grid means compression before this one, and says what it cannot tell you", () => {
    const { grid } = measureSample(sample(64, 64, blocked(6, 5)), 64, 64);
    expect(grid.reading).toContain("carried compression BEFORE its current one");
    expect(grid.reading).toContain("does not tell you is who did it or why");
  });

  it("reports no grid at all on a smooth gradient, rather than picking a winner out of noise", () => {
    const { grid } = measureSample(sample(64, 64, (x, y) => 40 + x * 0.6 + y * 0.6), 64, 64);
    expect(grid.present).toBe(false);
    expect(grid.reading).toContain("absence of evidence");
  });

  it("does NOT invent an offset on the axis that showed nothing", () => {
    // Banded horizontally only: the down axis carries a real grid, the across
    // axis carries none. Reporting a phase for the empty axis would be a false
    // accusation of recompression from a picture that showed none.
    const { grid } = measureSample(sample(64, 64, banded(0)), 64, 64);
    expect(grid.phaseY).toBe(0);
    expect(grid.phaseX).toBe(0);
    expect(grid.aligned).toBe(true);
    expect(grid.reading).toContain("the across axis showed none");
  });
});

describe("the sensor pipeline numbers", () => {
  it("measures the channel means and their balance", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 200;
      data[i + 1] = 100;
      data[i + 2] = 50;
      data[i + 3] = 255;
    }
    const { tone } = measureSample(data, 4, 4);
    expect(tone.meanR).toBe(200);
    expect(tone.meanG).toBe(100);
    expect(tone.meanB).toBe(50);
    expect(tone.ratioRG).toBe(2);
    expect(tone.ratioBG).toBe(0.5);
  });

  it("counts clipping at both ends", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < data.length; i += 4) {
      const white = i < data.length / 2;
      data[i] = white ? 255 : 0;
      data[i + 1] = white ? 255 : 0;
      data[i + 2] = white ? 255 : 0;
      data[i + 3] = 255;
    }
    const { tone } = measureSample(data, 4, 4);
    expect(tone.clippedHigh).toBe(0.5);
    expect(tone.clippedLow).toBe(0.5);
  });

  it("counts how many distinct luma values survived, which drops as processing rises", () => {
    const flat = measureSample(sample(32, 32, () => 128), 32, 32);
    const varied = measureSample(sample(32, 32, (x) => x * 8), 32, 32);
    expect(flat.tone.distinctLuma).toBe(1);
    expect(varied.tone.distinctLuma).toBeGreaterThan(flat.tone.distinctLuma);
  });

  it("gives a histogram that accounts for every pixel", () => {
    const { tone } = measureSample(sample(32, 32, (x, y) => (x * 8 + y * 3) % 256), 32, 32);
    expect(tone.histogram).toHaveLength(16);
    expect(tone.histogram.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
  });

  it("reads a higher noise floor from a noisier sample", () => {
    const smooth = measureSample(sample(64, 64, (x, y) => 100 + (x + y) * 0.2), 64, 64);
    const speckled = measureSample(sample(64, 64, (x, y) => 100 + ((x * 37 + y * 91) % 7) * 12), 64, 64);
    expect(speckled.tone.noise).toBeGreaterThan(smooth.tone.noise);
  });
});

describe("how the measurements are presented", () => {
  const report = {
    sample: { x: 0, y: 0, width: 64, height: 64, ofWidth: 4032, ofHeight: 3024 },
    ...measureSample(sample(64, 64, blocked(6, 5)), 64, 64),
    notes: ["a note"],
  };

  it("warns that scene-dependent numbers are scene-dependent", () => {
    const text = pixelText({ ...report, notes: ["Channel means are SCENE-DEPENDENT."] }, null, "camera-file").join("\n");
    expect(text).toContain("SCENE-DEPENDENT");
  });

  it("says a frame this app encoded is a re-encode by definition, so its grid proves nothing", () => {
    const text = pixelText(report, null, "app-encoded-frame").join("\n");
    expect(text).toContain("re-encode by");
    expect(text).toContain("must not be read as a finding");
  });

  it("does not add that caveat to a real camera file, where the same grid would matter", () => {
    const text = pixelText(report, null, "camera-file").join("\n");
    expect(text).not.toContain("must not be read as a finding");
  });

  it("states the reason when nothing could be measured, rather than showing empty numbers", () => {
    const text = pixelText(null, "The picture was too small.", "camera-file").join("\n");
    expect(text).toContain("Not measured. The picture was too small.");
  });

  it("calls a missing reason a fault rather than passing over it", () => {
    expect(pixelText(null, null, "camera-file").join("\n")).toContain("itself a fault");
  });
});
