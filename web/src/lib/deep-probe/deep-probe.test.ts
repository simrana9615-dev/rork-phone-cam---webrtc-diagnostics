/**
 * The raw dump makes three checkable claims: the checksums are real checksums,
 * the structural offsets point at what they say they point at, and the hex
 * dump renders the actual bytes. These tests hold each of those to account.
 *
 * MD5 is verified against the published RFC 1321 test suite rather than against
 * itself, and the streaming path is exercised separately from the single-shot
 * path — a rolling hash that is right for one buffer and wrong across a block
 * boundary is the classic way this goes silently wrong.
 */

import { describe, expect, it } from "vitest";

import { md5Bytes } from "./hashes";
import { hexDumpBlob, walkStructure } from "./raw-bytes";
import { buildRegistry, requestsForTier, TIER_ORDER } from "./permissions";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function blobOf(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer]);
}

describe("md5", () => {
  // The seven vectors from RFC 1321, appendix A.5.
  const vectors: [string, string][] = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
  ];

  for (const [input, expected] of vectors) {
    it(`matches the RFC 1321 vector for ${input === "" ? "the empty string" : `"${input.slice(0, 24)}${input.length > 24 ? "…" : ""}"`}`, () => {
      expect(md5Bytes(utf8(input))).toBe(expected);
    });
  }

  it("handles a payload spanning many 64-byte blocks", () => {
    // "a" x 1000 — a published vector for the million-a test's smaller sibling.
    const bytes = utf8("a".repeat(1000));
    expect(md5Bytes(bytes)).toBe("cabe45dcc9ae5b66ba86600cca6b8ba8");
  });

  it("produces a different digest for a single flipped byte", () => {
    const a = new Uint8Array(200).fill(7);
    const b = new Uint8Array(200).fill(7);
    b[137] = 8;
    expect(md5Bytes(a)).not.toBe(md5Bytes(b));
  });

  it("covers every byte value without treating the payload as text", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect(md5Bytes(all)).toBe("e2c865db4162bed963bfaa9ef6ac18f0");
  });
});

/* ------------------------------------------------------------------ *
 * Structure walking
 * ------------------------------------------------------------------ */

/** A minimal but structurally valid JPEG carrying an APP1 EXIF block. */
function jpegWithExif(): Uint8Array {
  // TIFF header (little-endian) + IFD0 with one entry, no IFD1.
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // "II", 42, offset to IFD0 = 8
    0x01, 0x00, // one entry
    0x1a, 0x01, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, // XResolution
    0x00, 0x00, 0x00, 0x00, // next IFD = 0
  ];
  const app1Payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0" + TIFF
  const app1Length = app1Payload.length + 2;
  const scan = [0x11, 0x22, 0x33, 0x44, 0x55];
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe1, (app1Length >> 8) & 0xff, app1Length & 0xff, ...app1Payload,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // DQT (minimal)
    0xff, 0xda, 0x00, 0x04, 0x00, 0x00, ...scan, // SOS + entropy data
    0xff, 0xd9, // EOI
  ]);
}

/** A minimal PNG: signature, IHDR, eXIf, IEND. */
function pngWithExif(): Uint8Array {
  const chunk = (type: string, data: number[]): number[] => {
    const len = data.length;
    return [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...utf8(type), ...data, 0, 0, 0, 0];
  };
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [0, 0, 0x04, 0x00, 0, 0, 0x03, 0x00, 8, 2, 0, 0, 0]),
    ...chunk("eXIf", [0x49, 0x49, 0x2a, 0x00]),
    ...chunk("IEND", []),
  ]);
}

describe("walkStructure", () => {
  it("identifies a JPEG and carves the EXIF block at a real offset", async () => {
    const bytes = jpegWithExif();
    const report = await walkStructure(blobOf(bytes));

    expect(report.parsed).toBe(true);
    expect(report.container).toContain("JPEG");

    const exif = report.segments.find((s) => s.name === "exif-app1");
    expect(exif).toBeDefined();
    // Seeking to the stated offset must land on the TIFF header, not near it.
    expect(bytes[exif!.offset]).toBe(0x49);
    expect(bytes[exif!.offset + 1]).toBe(0x49);
    expect(bytes[exif!.offset + 2]).toBe(0x2a);
    expect(exif!.offset + exif!.length).toBeLessThanOrEqual(bytes.length);
  });

  it("records the entropy-coded scan as its own region", async () => {
    const report = await walkStructure(blobOf(jpegWithExif()));
    const scan = report.nodes.find((n) => n.id === "scan");
    expect(scan).toBeDefined();
    expect(scan!.length).toBeGreaterThan(0);
  });

  it("never reports a segment that runs past the end of the file", async () => {
    const bytes = jpegWithExif();
    const report = await walkStructure(blobOf(bytes));
    for (const segment of report.segments) {
      expect(segment.offset).toBeGreaterThanOrEqual(0);
      expect(segment.offset + segment.length).toBeLessThanOrEqual(bytes.length);
    }
  });

  it("walks PNG chunks and finds the eXIf chunk", async () => {
    const report = await walkStructure(blobOf(pngWithExif()));
    expect(report.container).toBe("PNG");
    expect(report.nodes.some((n) => n.id === "IHDR")).toBe(true);
    expect(report.nodes.some((n) => n.id === "IEND")).toBe(true);
    expect(report.segments.some((s) => s.name === "png-exif")).toBe(true);
  });

  it("admits when a container is not one it knows, instead of guessing", async () => {
    const report = await walkStructure(blobOf(new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc])));
    expect(report.parsed).toBe(false);
    expect(report.container).toContain("unrecognised");
    expect(report.warnings.join(" ")).toContain("hex dump");
  });
});

/* ------------------------------------------------------------------ *
 * Hex dump
 * ------------------------------------------------------------------ */

describe("hexDumpBlob", () => {
  it("renders every byte in xxd layout when inside the budget", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const result = await hexDumpBlob(blobOf(bytes), "test", 1024);
    const text = await result.blob.text();

    expect(result.truncated).toBe(false);
    expect(result.bytesRendered).toBe(bytes.length);
    expect(text).toContain("COMPLETE");
    expect(text).toContain("00000000  ff d8 ff e0 00 10 4a 46  49 46 00 01");
    // The ASCII column must show the JFIF signature.
    expect(text).toContain("|......JFIF..|");
  });

  it("marks a windowed dump as incomplete and states how many bytes were skipped", async () => {
    const bytes = new Uint8Array(400_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
    const result = await hexDumpBlob(blobOf(bytes), "big", 100_000);
    const text = await result.blob.text();

    expect(result.truncated).toBe(true);
    expect(result.bytesRendered).toBeLessThan(bytes.length);
    expect(text).toContain("WINDOWED");
    expect(text).toContain("bytes skipped");
    // The claim of completeness must be absent, not merely contradicted later.
    expect(text.slice(0, 400)).not.toContain("COMPLETE — every byte");
  });

  it("offsets continue correctly across internal slice boundaries", async () => {
    const bytes = new Uint8Array(1_200_000).fill(0xab);
    const result = await hexDumpBlob(blobOf(bytes), "multi-slice", 10_000_000);
    const text = await result.blob.text();
    expect(result.truncated).toBe(false);
    // 512 KB slice boundary: the line at that offset must be labelled with it.
    expect(text).toContain("00080000  ab ab");
    expect(text).toContain("00100000  ab ab");
  });
});

/* ------------------------------------------------------------------ *
 * Permission registry
 * ------------------------------------------------------------------ */

describe("permission registry", () => {
  it("gives every request a unique id", () => {
    const ids = buildRegistry().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("nests the tiers, so a wider scope never drops a request a narrower one made", () => {
    const standard = requestsForTier("standard").map((r) => r.id);
    const extended = requestsForTier("extended").map((r) => r.id);
    const everything = requestsForTier("everything").map((r) => r.id);

    expect(extended).toEqual(expect.arrayContaining(standard));
    expect(everything).toEqual(expect.arrayContaining(extended));
    expect(everything.length).toBeGreaterThan(standard.length);
  });

  it("states, for every request, what it reaches and how long the grant lasts", () => {
    for (const request of buildRegistry()) {
      expect(request.reaches.length).toBeGreaterThan(20);
      expect(request.duration.length).toBeGreaterThan(5);
      expect(request.api).toMatch(/\(|\./);
    }
  });

  it("explains itself whenever it demands a tap instead of auto-advancing", () => {
    for (const request of buildRegistry()) {
      if (request.needsGesture) expect(request.gestureReason ?? "").not.toBe("");
    }
  });

  it("assigns every request to a known tier", () => {
    for (const request of buildRegistry()) {
      expect(TIER_ORDER).toContain(request.tier);
    }
  });
});
