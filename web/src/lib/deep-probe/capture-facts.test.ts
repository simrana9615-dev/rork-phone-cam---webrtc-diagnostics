/**
 * Tests for the facts pass and the yield that keeps it alive.
 *
 * Two properties matter more than the rest. First, the pass must let go of the
 * bytes when no archive was asked for — that is the whole reason the sheet-only
 * path is cheap, and a pass that quietly held on would look identical from the
 * outside until the tab died. Second, a capture the parsers cannot read has to
 * come back as a warning attached to a real record, never as a thrown error that
 * takes the other hundred captures down with it.
 */

import { describe, expect, it, vi } from "vitest";

import { breathe, breatheEvery, BREATHE_INTERVAL_MS } from "./breathe";
import { extensionFor, folderFor, readCaptureFacts, tagDumpFromBytes, ORIGIN_TEXT } from "./capture-facts";
import type { ProbeCapture } from "./camera-matrix";

function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00], 0);
  for (let i = 7; i < size - 2; i += 1) bytes[i] = i % 251;
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  return bytes;
}

function blobOf(bytes: Uint8Array, type = "image/jpeg"): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type });
}

function capture(overrides: Partial<ProbeCapture> = {}): ProbeCapture {
  return {
    slug: "sweep-01",
    label: "Back camera",
    blob: blobOf(jpegBytes(4096)),
    origin: "platform-photo",
    stage: "camera-sweep",
    deviceLabel: "Back Triple Camera",
    path: "image-capture",
    width: 1920,
    height: 1080,
    fileName: null,
    fileLastModified: null,
    fileRelativePath: null,
    asked: "1920×1080",
    granted: "1920×1080",
    takenAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

describe("extensionFor", () => {
  it("trusts the delivered file name over the MIME type", () => {
    expect(extensionFor(blobOf(jpegBytes(64), "image/jpeg"), "IMG_0042.HEIC")).toBe("heic");
  });

  it("falls back to the MIME type when there is no file name", () => {
    expect(extensionFor(blobOf(jpegBytes(64), "image/jpeg"), null)).toBe("jpg");
    expect(extensionFor(blobOf(jpegBytes(64), "image/webp"), null)).toBe("webp");
  });

  it("says bin rather than guessing at an unknown type", () => {
    expect(extensionFor(blobOf(jpegBytes(64), "application/octet-stream"), null)).toBe("bin");
  });
});

describe("folderFor", () => {
  it("keeps frames this app encoded out of the captures folder", () => {
    expect(folderFor({ origin: "app-encoded-frame" })).toBe("rendered-frames");
    expect(folderFor({ origin: "camera-file" })).toBe("captures");
    expect(folderFor({ origin: "platform-photo" })).toBe("captures");
  });

  it("never describes a canvas encode as a camera file", () => {
    expect(ORIGIN_TEXT["app-encoded-frame"]).toContain("It is not a camera file");
    expect(ORIGIN_TEXT["camera-file"]).toContain("camera's own bytes");
  });
});

describe("tagDumpFromBytes", () => {
  it("explains an empty tag set instead of leaving it looking like a failure", () => {
    // A bare SOI/EOI pair: a JPEG with no metadata whatsoever, which is exactly
    // what a canvas encode produces.
    const dump = tagDumpFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "a canvas frame");
    expect(dump.metadataCount).toBe(0);
    expect(dump.text).toContain("Absence here is not evidence of anything");
  });

  it("does not count the parser naming the container as metadata", () => {
    // exifreader reports a synthetic `file.FileType` group for anything it can
    // read at all. Counting it meant a frame with genuinely no metadata never
    // registered as one, and the reassurance above could never fire.
    const dump = tagDumpFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "a canvas frame");
    expect(dump.count).toBeGreaterThan(0);
    expect(dump.metadataCount).toBe(0);
    expect(dump.text).toContain("not the file's metadata");
  });

  it("reports a parser refusal rather than throwing", () => {
    const dump = tagDumpFromBytes(new Uint8Array([1, 2, 3]), "nonsense");
    expect(dump.count).toBe(0);
    expect(dump.text.length).toBeGreaterThan(0);
  });
});

describe("readCaptureFacts", () => {
  it("reads every capture once and reports the bytes it walked", async () => {
    const captures = [capture(), capture({ slug: "sweep-02", blob: blobOf(jpegBytes(2048)) })];
    const result = await readCaptureFacts(captures, { release: false });
    expect(result.facts).toHaveLength(2);
    expect(result.bytesRead).toBe(4096 + 2048);
    expect(result.released).toBe(false);
  });

  it("leaves the caller's list alone when the archive was asked for", async () => {
    const captures = [capture(), capture({ slug: "sweep-02" })];
    await readCaptureFacts(captures, { release: false });
    expect(captures).toHaveLength(2);
    expect(captures[0].blob.size).toBe(4096);
  });

  it("drains the caller's list when no archive was asked for, so each blob can be collected", async () => {
    const captures = [capture(), capture({ slug: "sweep-02" }), capture({ slug: "sweep-03" })];
    const seen: number[] = [];
    const result = await readCaptureFacts(captures, {
      release: true,
      onProgress: () => seen.push(captures.length),
    });
    expect(result.released).toBe(true);
    expect(result.facts).toHaveLength(3);
    // The array shrinks as the pass proceeds rather than all at the end: that is
    // what makes each blob collectable at the moment its facts are read.
    expect(seen).toEqual([2, 1, 0]);
    expect(captures).toHaveLength(0);
  });

  it("counts the held bytes down as it releases them", async () => {
    const captures = [capture(), capture({ slug: "sweep-02", blob: blobOf(jpegBytes(2048)) })];
    const held: number[] = [];
    await readCaptureFacts(captures, { release: true, onHeldBytes: (bytes) => held.push(bytes) });
    expect(held).toEqual([2048, 0]);
  });

  it("does not report a held figure at all when nothing is being released", async () => {
    const held: number[] = [];
    await readCaptureFacts([capture()], { release: false, onHeldBytes: (bytes) => held.push(bytes) });
    expect(held).toEqual([]);
  });

  it("puts a frame this app encoded outside the captures folder", async () => {
    const result = await readCaptureFacts([capture({ origin: "app-encoded-frame", slug: "manual-01" })], { release: false });
    expect(result.facts[0].archivePath).toBe("rendered-frames/manual-01.jpg");
  });

  it("carries four checksums per capture", async () => {
    const result = await readCaptureFacts([capture()], { release: false });
    const { hashes } = result.facts[0];
    expect(hashes.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(hashes.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(hashes.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.crc32).toMatch(/^[0-9a-f]{8}$/i);
    expect(hashes.bytes).toBe(4096);
  });

  it("fills both the spec and brief shapes from the one walk", async () => {
    const result = await readCaptureFacts([capture()], { release: false });
    const fact = result.facts[0];
    expect(fact.spec.slug).toBe(fact.slug);
    expect(fact.brief.archivePath).toBe(fact.archivePath);
    expect(fact.spec.container).toBe(fact.structure.container);
    expect(fact.brief.iccMd5).toBe(fact.iccMd5);
  });

  it("names every step it is about to take, so a crash can be located", async () => {
    const steps: string[] = [];
    await readCaptureFacts([capture()], { release: false, onStep: (step) => steps.push(step) });
    expect(steps.some((s) => s.startsWith("Checksumming sweep-01"))).toBe(true);
    expect(steps.some((s) => s.startsWith("Parsing sweep-01"))).toBe(true);
    expect(steps.some((s) => s.startsWith("Mapping the structure of sweep-01"))).toBe(true);
  });

  it("survives a capture whose bytes cannot be read, and says which one", async () => {
    const broken = capture({ slug: "broken-01" });
    // A blob that refuses to yield an ArrayBuffer is exactly what a revoked or
    // evicted file behaves like on a phone under memory pressure.
    vi.spyOn(broken.blob, "arrayBuffer").mockRejectedValue(new Error("NotReadableError"));
    const result = await readCaptureFacts([broken, capture({ slug: "fine-02" })], { release: false });
    expect(result.facts).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("broken-01");
    expect(result.warnings.join(" ")).toContain("NotReadableError");
    expect(result.facts[0].warnings).toHaveLength(1);
    expect(result.facts[1].warnings).toHaveLength(0);
  });

  it("returns an empty result for an empty run rather than inventing one", async () => {
    const result = await readCaptureFacts([], { release: true });
    expect(result.facts).toEqual([]);
    expect(result.bytesRead).toBe(0);
  });
});

describe("breathe", () => {
  it("returns control and resumes", async () => {
    let resumed = false;
    await breathe();
    resumed = true;
    expect(resumed).toBe(true);
  });

  it("yields on a cadence rather than on every item", async () => {
    const breather = breatheEvery(10_000);
    for (let i = 0; i < 50; i += 1) await breather.tick();
    // A 10-second cadence cannot fire inside a synchronous loop, which is the
    // point: breathing is not free and must not scale with the item count.
    expect(breather.yields()).toBe(0);
  });

  it("does yield once enough time has passed", async () => {
    const breather = breatheEvery(0);
    await breather.tick();
    await breather.tick();
    expect(breather.yields()).toBeGreaterThan(0);
  });

  it("keeps the default cadence short enough to stay inside a frame or two", () => {
    expect(BREATHE_INTERVAL_MS).toBeLessThanOrEqual(32);
    expect(BREATHE_INTERVAL_MS).toBeGreaterThan(0);
  });
});
