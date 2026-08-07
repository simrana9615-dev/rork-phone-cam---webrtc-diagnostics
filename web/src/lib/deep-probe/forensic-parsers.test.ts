/**
 * Tests for the two deep parsers and the correlation registry.
 *
 * These build real JPEG and TIFF byte structures rather than mocking the
 * parsers' inputs, because the entire value of these modules is that they read
 * bytes correctly — a test against a stubbed reader would prove nothing.
 */

import { describe, expect, it } from "vitest";

import { briefChecklist, briefItems, buildCorrelationBrief, type CorrelationInput } from "./correlation-brief";
import { readExifIfds } from "./exif-ifd";
import { readJpegEncoderBytes } from "./jpeg-encoder";

/* ------------------------------------------------------------------ *
 * Byte builders
 * ------------------------------------------------------------------ */

function seg(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

const ANNEX_K_LUMA_NATURAL: number[] = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22,
  37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const ZIGZAG: number[] = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57,
  50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** Natural-order table to the zig-zag order a file actually stores. */
function zigzagged(natural: number[]): number[] {
  return ZIGZAG.map((naturalIndex) => natural[naturalIndex]);
}

/** Scales the Annex K base table the way libjpeg does for a given quality. */
function scaleLikeLibjpeg(quality: number): number[] {
  const factor = quality < 50 ? 5000 / quality : 200 - quality * 2;
  return ANNEX_K_LUMA_NATURAL.map((v) => Math.min(255, Math.max(1, Math.floor((v * factor + 50) / 100))));
}

const DC_LUMA_BITS: number[] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];

type JpegParts = {
  quantNatural?: number[];
  progressive?: boolean;
  scans?: number;
  restartInterval?: number;
  jfif?: boolean;
  sampling?: [number, number];
  huffBits?: number[];
  trailing?: number[];
  exif?: number[];
};

function buildJpeg(parts: JpegParts = {}): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  if (parts.jfif !== false) {
    bytes.push(...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 2, 0, 0, 1, 0, 1, 0, 0]));
  }
  if (parts.exif) {
    bytes.push(...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...parts.exif]));
  }
  const natural = parts.quantNatural ?? ANNEX_K_LUMA_NATURAL;
  bytes.push(...seg(0xdb, [0x00, ...zigzagged(natural)]));
  if (parts.restartInterval != null) {
    bytes.push(...seg(0xdd, [(parts.restartInterval >> 8) & 0xff, parts.restartInterval & 0xff]));
  }
  const [h, v] = parts.sampling ?? [2, 2];
  bytes.push(
    ...seg(parts.progressive === true ? 0xc2 : 0xc0, [
      8,
      0x01,
      0x40, // height 320
      0x00,
      0xf0, // width 240
      3,
      1,
      (h << 4) | v,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ])
  );
  const bits = parts.huffBits ?? DC_LUMA_BITS;
  const huffVals = new Array<number>(bits.reduce((s, b) => s + b, 0)).fill(0);
  bytes.push(...seg(0xc4, [0x00, ...bits, ...huffVals]));
  for (let i = 0; i < (parts.scans ?? 1); i += 1) {
    bytes.push(...seg(0xda, [1, 1, 0x00, 0, 63, 0]));
    bytes.push(0x12, 0x34, 0x56); // entropy-coded stand-in
  }
  bytes.push(0xff, 0xd9);
  if (parts.trailing) bytes.push(...parts.trailing);
  return new Uint8Array(bytes);
}

/**
 * A TIFF block with IFD0 → ExifIFD, exercising an out-of-line ASCII string, a
 * rational, an inline SHORT and a sub-IFD pointer.
 */
function buildExif(): number[] {
  const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  const entry = (tag: number, type: number, count: number, value: number[]): number[] => [...u16(tag), ...u16(type), ...u32(count), ...value];

  const makeAt = 50;
  const exposureAt = 56;
  const exifIfdAt = 64;

  return [
    0x49,
    0x49, // "II"
    ...u16(42),
    ...u32(8),
    // IFD0 at 8
    ...u16(3),
    ...entry(0x010f, 2, 6, u32(makeAt)), // Make, out of line
    ...entry(0x829a, 5, 1, u32(exposureAt)), // ExposureTime, rational
    ...entry(0x8769, 4, 1, u32(exifIfdAt)), // ExifIFD pointer
    ...u32(0), // no IFD1
    // value area
    0x41,
    0x70,
    0x70,
    0x6c,
    0x65,
    0x00, // "Apple\0" at 50
    ...u32(1),
    ...u32(60), // 1/60 at 56
    // ExifIFD at 64
    ...u16(2),
    ...entry(0xa001, 3, 1, [0xff, 0xff, 0, 0]), // ColorSpace 65535, inline
    ...entry(0x7777, 3, 1, [0x05, 0x00, 0, 0]), // an undocumented tag, inline
    ...u32(0),
  ];
}

/* ------------------------------------------------------------------ *
 * JPEG encoder signature
 * ------------------------------------------------------------------ */

describe("readJpegEncoderBytes", () => {
  it("reads all 64 quantisation coefficients and un-zigzags them correctly", () => {
    const report = readJpegEncoderBytes(buildJpeg());
    expect(report.quantTables).toHaveLength(1);
    const table = report.quantTables[0];
    expect(table.zigzag).toHaveLength(64);
    expect(table.natural).toHaveLength(64);
    // The round trip must land back on the table we wrote, or every comparison
    // downstream is against a scrambled matrix.
    expect(table.natural).toEqual(ANNEX_K_LUMA_NATURAL);
    expect(table.sum).toBe(ANNEX_K_LUMA_NATURAL.reduce((s, v) => s + v, 0));
    expect(table.isAnnexKBase).toBe(true);
  });

  it("recovers a libjpeg quality from a scaled table", () => {
    const report = readJpegEncoderBytes(buildJpeg({ quantNatural: scaleLikeLibjpeg(75) }));
    const estimate = report.quantTables[0].libjpegQualityEstimate;
    expect(estimate).not.toBeNull();
    expect(Math.abs((estimate ?? 0) - 75)).toBeLessThan(3);
  });

  it("withholds a quality estimate for a table that was not scaled from Annex K", () => {
    // Apple's encoder lands here. Inventing a number would describe the
    // estimator rather than the encoder.
    const irregular = ANNEX_K_LUMA_NATURAL.map((_, i) => ((i * 37) % 90) + 3);
    expect(readJpegEncoderBytes(buildJpeg({ quantNatural: irregular })[0] === 0xff ? buildJpeg({ quantNatural: irregular }) : new Uint8Array()).quantTables[0].libjpegQualityEstimate).toBeNull();
  });

  it("identifies a standard Annex K Huffman table and an optimised one", () => {
    expect(readJpegEncoderBytes(buildJpeg()).huffmanTables[0].annexKMatch).toBe("dc-luma");
    const custom = [0, 2, 2, 2, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(readJpegEncoderBytes(buildJpeg({ huffBits: custom })).huffmanTables[0].annexKMatch).toBeNull();
  });

  it("labels chroma subsampling from the sampling factors", () => {
    expect(readJpegEncoderBytes(buildJpeg({ sampling: [2, 2] })).frame?.subsampling).toMatch(/^4:2:0/);
    expect(readJpegEncoderBytes(buildJpeg({ sampling: [2, 1] })).frame?.subsampling).toMatch(/^4:2:2/);
    expect(readJpegEncoderBytes(buildJpeg({ sampling: [1, 1] })).frame?.subsampling).toMatch(/^4:4:4/);
  });

  it("separates baseline from progressive and counts the scans", () => {
    const baseline = readJpegEncoderBytes(buildJpeg());
    expect(baseline.frame?.mode).toMatch(/baseline/);
    expect(baseline.scanCount).toBe(1);
    const progressive = readJpegEncoderBytes(buildJpeg({ progressive: true, scans: 4 }));
    expect(progressive.frame?.mode).toMatch(/progressive/);
    expect(progressive.scanCount).toBe(4);
  });

  it("reads dimensions in the right order — height precedes width in a SOF", () => {
    const frame = readJpegEncoderBytes(buildJpeg()).frame;
    expect(frame?.height).toBe(320);
    expect(frame?.width).toBe(240);
  });

  it("reports the restart interval, and its absence as absence", () => {
    expect(readJpegEncoderBytes(buildJpeg({ restartInterval: 16 })).restartInterval).toBe(16);
    expect(readJpegEncoderBytes(buildJpeg()).restartInterval).toBeNull();
  });

  it("records APP segments in file order, and a missing JFIF header as missing", () => {
    const withJfif = readJpegEncoderBytes(buildJpeg({ exif: buildExif() }));
    expect(withJfif.hasJfif).toBe(true);
    expect(withJfif.appSegments.map((s) => s.marker)).toEqual(["APP0", "APP1"]);
    expect(withJfif.jfifVersion).toBe("1.02");
    const cameraStyle = readJpegEncoderBytes(buildJpeg({ jfif: false, exif: buildExif() }));
    expect(cameraStyle.hasJfif).toBe(false);
    expect(cameraStyle.appSegments.map((s) => s.marker)).toEqual(["APP1"]);
  });

  it("counts bytes after EOI, which nothing should normally write", () => {
    expect(readJpegEncoderBytes(buildJpeg()).trailingBytes).toBe(0);
    const padded = readJpegEncoderBytes(buildJpeg({ trailing: [1, 2, 3, 4, 5] }));
    expect(padded.trailingBytes).toBe(5);
    expect(padded.trailingHex).toBe("01 02 03 04 05");
  });

  it("says plainly that a non-JPEG is not a JPEG instead of reporting empty tables", () => {
    const report = readJpegEncoderBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    expect(report.isJpeg).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/Not a JPEG/);
  });
});

/* ------------------------------------------------------------------ *
 * Raw EXIF directories
 * ------------------------------------------------------------------ */

describe("readExifIfds", () => {
  const report = readExifIfds(buildJpeg({ exif: buildExif() }));

  it("finds the TIFF header inside APP1 and reads its byte order", () => {
    expect(report.found).toBe(true);
    expect(report.byteOrder).toBe("II (little-endian)");
    expect(report.magic).toBe(42);
  });

  it("walks into the Exif sub-IFD and records the directory order", () => {
    expect(report.ifdOrder).toEqual(["IFD0", "ExifIFD"]);
    expect(report.hasIfd1).toBe(false);
  });

  it("keeps a rational as numerator/denominator rather than a decimal", () => {
    // The whole reason this module exists: 1/60 and 0.016667 are the same
    // reading and different bytes.
    const exposure = report.blocks[0].entries.find((e) => e.name === "ExposureTime");
    expect(exposure?.typeName).toBe("RATIONAL");
    expect(exposure?.raw).toBe("1/60");
    expect(exposure?.inline).toBe(false);
  });

  it("reports ASCII length and whether it is NUL-terminated", () => {
    const make = report.blocks[0].entries.find((e) => e.name === "Make");
    expect(make?.raw).toBe('"Apple" (6 bytes, NUL-terminated)');
    expect(make?.count).toBe(6);
  });

  it("marks a short value as inline rather than inventing an offset", () => {
    const colorSpace = report.blocks[1].entries.find((e) => e.name === "ColorSpace");
    expect(colorSpace?.inline).toBe(true);
    expect(colorSpace?.raw).toBe("65535");
  });

  it("surfaces the ColorSpace 65535 marker as a first-class field", () => {
    expect(report.colorSpace).toBe(0xffff);
  });

  it("reports an undocumented tag with a null name rather than dropping it", () => {
    const unknown = report.blocks[1].entries.find((e) => e.tag === 0x7777);
    expect(unknown).toBeDefined();
    expect(unknown?.name).toBeNull();
    expect(unknown?.tagHex).toBe("0x7777");
  });

  it("says a canvas-style JPEG has no EXIF, and says why that is expected", () => {
    const bare = readExifIfds(buildJpeg());
    expect(bare.found).toBe(false);
    expect(bare.warnings.join(" ")).toMatch(/canvas frame that is the only possible outcome/);
  });
});

/* ------------------------------------------------------------------ *
 * Correlation registry
 * ------------------------------------------------------------------ */

function correlationInput(overrides: Partial<CorrelationInput> = {}): CorrelationInput {
  return {
    generatedAt: "2026-08-07T10:00:00.000Z",
    passive: [],
    sensors: [],
    matrix: null,
    captures: [],
    devicesBeforePermission: [],
    permissionStatesBefore: [],
    permissionStatesAfter: [],
    omissions: [],
    ...overrides,
  };
}

describe("correlation brief", () => {
  it("renders the checklist and the full brief from one registry, so they cannot disagree", () => {
    const input = correlationInput();
    const items = briefItems(input);
    const checklist = briefChecklist(input);
    const full = buildCorrelationBrief(input);
    expect(items.length).toBeGreaterThan(30);
    for (const item of items) {
      expect(checklist).toContain(item.ask);
      expect(full).toContain(item.ask);
    }
    expect(checklist).toContain(`All ${items.length} requested items`);
    expect(full).toContain(`${items.length} requested items`);
  });

  it("never merges 'we did not look' with 'it cannot be looked at'", () => {
    const items = briefItems(correlationInput());
    const untouched = items.find((i) => i.section === "0.1");
    expect(untouched?.status).toBe("not-obtainable");
    const canvas = items.find((i) => i.section === "0.4");
    expect(canvas?.status).toBe("not-run");
    expect(buildCorrelationBrief(correlationInput())).toMatch(/different\s+claims/);
  });

  it("puts the capture-path warning at the top of the checklist, before any fact", () => {
    const checklist = briefChecklist(correlationInput());
    const warningAt = checklist.indexOf("no EXIF at all");
    const tableAt = checklist.indexOf("```");
    expect(warningAt).toBeGreaterThan(-1);
    expect(warningAt).toBeLessThan(tableAt);
    expect(checklist).toMatch(/more\* detectable, not less/);
  });

  it("reports the motion precision fix rather than quietly benefiting from it", () => {
    const items = briefItems(
      correlationInput({
        sensors: [
          {
            id: "motion",
            label: "Motion",
            columns: ["ms", "accel_x"],
            rows: [["0", "0.1"], ["10", "0.2"], ["20", "0.3"]],
            requestedHz: null,
            measuredHz: 100,
            durationMs: 30,
            note: "",
          },
        ],
      })
    );
    const motion = items.find((i) => i.section === "7.1");
    expect(motion?.status).toBe("captured");
    expect(motion?.answer).toMatch(/full precision/i);
  });

  it("counts three enumerateDevices snapshots, not two", () => {
    const items = briefItems(correlationInput({ devicesBeforePermission: [{ kind: "videoinput", deviceId: "a", groupId: "g", label: "" }] }));
    const devices = items.find((i) => i.section === "6.1");
    expect(devices?.status).toBe("captured");
    expect(devices?.answer).toMatch(/Three snapshots, not two/);
  });
});
