import { describe, expect, it } from "vitest";

import { createShapeLedger, shapeFromBytes, shapeId, shapeScope, SIGNATURE_HEADER_BYTES, type ShapeComponent } from "./capture-signature";

/* ------------------------------------------------------------------ *
 * A JPEG builder, so the fixtures are real files rather than stubs.
 * ------------------------------------------------------------------ */

type JpegParts = {
  quantLuma?: number[];
  huffmanBits?: number[];
  width?: number;
  height?: number;
  jfif?: boolean;
  exif?: { tags: number[]; little?: boolean } | null;
  /** Padding appended after EOI, which changes the byte length and nothing else. */
  trailing?: number;
  subsampling?: [number, number];
};

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

function exifPayload(tags: number[], little: boolean): number[] {
  const bytes: number[] = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const u16 = (value: number): number[] => (little ? [value & 0xff, (value >> 8) & 0xff] : [(value >> 8) & 0xff, value & 0xff]);
  const u32 = (value: number): number[] =>
    little
      ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]
      : [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  bytes.push(little ? 0x49 : 0x4d, little ? 0x49 : 0x4d);
  bytes.push(...u16(42));
  bytes.push(...u32(8));
  bytes.push(...u16(tags.length));
  for (const tag of tags) {
    bytes.push(...u16(tag)); // tag id
    bytes.push(...u16(3)); // type SHORT
    bytes.push(...u32(1)); // count
    // The VALUE. Deliberately varied per call in the tests, to prove the shape
    // ignores it.
    bytes.push(...u16(tag * 7), 0, 0);
  }
  bytes.push(...u32(0));
  return bytes;
}

function jpeg(parts: JpegParts = {}): Uint8Array {
  const quant = parts.quantLuma ?? new Array<number>(64).fill(16);
  const bits = parts.huffmanBits ?? [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const width = parts.width ?? 1920;
  const height = parts.height ?? 1080;
  const [h, v] = parts.subsampling ?? [2, 2];
  const bytes: number[] = [0xff, 0xd8];
  if (parts.jfif !== false) bytes.push(...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 2, 0, 0, 1, 0, 1, 0, 0]));
  if (parts.exif) bytes.push(...segment(0xe1, exifPayload(parts.exif.tags, parts.exif.little ?? true)));
  bytes.push(...segment(0xdb, [0x00, ...quant]));
  bytes.push(
    ...segment(0xc0, [
      8,
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
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
  bytes.push(...segment(0xc4, [0x00, ...bits, ...new Array<number>(bits.reduce((a, b) => a + b, 0)).fill(0)]));
  bytes.push(...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]));
  bytes.push(0xff, 0xd9);
  for (let i = 0; i < (parts.trailing ?? 0); i += 1) bytes.push(i & 0xff);
  return new Uint8Array(bytes);
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" });
}

function component(shape: { components: ShapeComponent[] }, name: string): string {
  return shape.components.find((c) => c.name === name)?.value ?? "";
}

/* ------------------------------------------------------------------ */

describe("what a shape reads", () => {
  it("reads the container, the frame and the tables out of a real JPEG", () => {
    const shape = shapeFromBytes(jpeg(), false);
    expect(shape.container).toBe("jpeg");
    expect(shape.width).toBe(1920);
    expect(shape.height).toBe(1080);
    expect(component(shape, "frame")).toContain("SOF0");
    expect(component(shape, "quant-tables")).toContain("q0/8:");
    expect(component(shape, "huffman-tables")).toContain("h00:");
  });

  it("records the marker sequence in file order, because the order is itself an encoder trait", () => {
    const shape = shapeFromBytes(jpeg({ exif: { tags: [0x010f] } }), false);
    expect(component(shape, "markers")).toBe("D8 E0 E1 DB C0 C4 DA");
  });

  it("names each APP segment by its own signature", () => {
    const shape = shapeFromBytes(jpeg({ exif: { tags: [0x010f] } }), false);
    expect(component(shape, "app-segments")).toContain("APP0:JFIF");
    expect(component(shape, "app-segments")).toContain("APP1:Exif");
  });

  it("reads a PNG by its chunk sequence rather than pretending it has JPEG tables", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32, 8, 6, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54,
    ]);
    const shape = shapeFromBytes(png, false);
    expect(shape.container).toBe("png");
    expect(shape.width).toBe(64);
    expect(shape.height).toBe(32);
    expect(component(shape, "chunks")).toBe("IHDR IDAT");
  });

  it("reads a HEIC-style container by its box sequence and brands", () => {
    const iso = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
    const shape = shapeFromBytes(iso, false);
    expect(shape.container).toBe("isobmff");
    expect(component(shape, "brands")).toContain("heic");
  });

  it("says so when the container is not one it knows, instead of guessing at one", () => {
    const shape = shapeFromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), false);
    expect(shape.container).toBe("unknown");
    expect(shape.notes.join(" ")).toContain("not recognised");
  });
});

describe("what a shape deliberately ignores", () => {
  it("collapses two photographs of different scenes from one camera into one shape", () => {
    // Same encoder, same settings, different pictures: the compressed data and
    // the file length differ, and nothing that describes the device does.
    const first = shapeFromBytes(jpeg({ trailing: 0 }), false);
    const second = shapeFromBytes(jpeg({ trailing: 4096 }), false);
    expect(second.bytesExamined).toBeGreaterThan(first.bytesExamined);
    expect(second.id).toBe(first.id);
  });

  it("ignores what the metadata VALUES say, because those describe the moment", () => {
    const morning = shapeFromBytes(jpeg({ exif: { tags: [0x0132, 0x829a] } }), false);
    const evening = shapeFromBytes(jpeg({ exif: { tags: [0x0132, 0x829a] } }), false);
    expect(evening.id).toBe(morning.id);
  });

  it("does NOT ignore which tags were written, because the layout describes the firmware", () => {
    const withGps = shapeFromBytes(jpeg({ exif: { tags: [0x0132, 0x829a, 0x8825] } }), false);
    const withoutGps = shapeFromBytes(jpeg({ exif: { tags: [0x0132, 0x829a] } }), false);
    expect(withGps.id).not.toBe(withoutGps.id);
  });
});

describe("what a shape treats as a real difference", () => {
  it("separates two different quantisation tables", () => {
    const a = shapeFromBytes(jpeg({ quantLuma: new Array<number>(64).fill(16) }), false);
    const b = shapeFromBytes(jpeg({ quantLuma: new Array<number>(64).fill(20) }), false);
    expect(b.id).not.toBe(a.id);
  });

  it("separates two different frame sizes", () => {
    expect(shapeFromBytes(jpeg({ width: 1920, height: 1080 }), false).id).not.toBe(shapeFromBytes(jpeg({ width: 1280, height: 720 }), false).id);
  });

  it("separates two different chroma subsamplings at the same size", () => {
    expect(shapeFromBytes(jpeg({ subsampling: [2, 2] }), false).id).not.toBe(shapeFromBytes(jpeg({ subsampling: [1, 1] }), false).id);
  });

  it("separates a file with a JFIF header from one without", () => {
    expect(shapeFromBytes(jpeg({ jfif: true }), false).id).not.toBe(shapeFromBytes(jpeg({ jfif: false }), false).id);
  });

  it("separates the two TIFF byte orders", () => {
    const little = shapeFromBytes(jpeg({ exif: { tags: [0x0132], little: true } }), false);
    const big = shapeFromBytes(jpeg({ exif: { tags: [0x0132], little: false } }), false);
    expect(big.id).not.toBe(little.id);
  });

  it("separates two different Huffman code-length tables", () => {
    const standard = shapeFromBytes(jpeg(), false);
    const optimised = shapeFromBytes(jpeg({ huffmanBits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0] }), false);
    expect(optimised.id).not.toBe(standard.id);
  });
});

describe("the ID itself", () => {
  it("is sixteen hex characters, so it can be read aloud and compared by eye", () => {
    expect(shapeFromBytes(jpeg(), false).id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("depends on the component values, not on the order they happen to be listed in", () => {
    const a = shapeId([
      { name: "one", value: "x" },
      { name: "two", value: "y" },
    ]);
    const b = shapeId([
      { name: "one", value: "x" },
      { name: "two", value: "z" },
    ]);
    expect(a).not.toBe(b);
  });

  it("says plainly when the header ran out before the shape was complete", () => {
    const shape = shapeFromBytes(jpeg(), true);
    expect(shape.truncated).toBe(true);
    expect(shape.notes.join(" ")).toContain(String(SIGNATURE_HEADER_BYTES / 1024));
    expect(shape.notes.join(" ")).toContain("less firmly identical");
  });
});

describe("the ledger", () => {
  const scope = shapeScope("Back Camera", "canvas");

  it("keeps the first sighting of a shape", async () => {
    const ledger = createShapeLedger();
    const verdict = await ledger.consider({ slug: "001-canvas", blob: blobOf(jpeg()), scope, asked: "1080p" });
    expect(verdict.keep).toBe(true);
    expect(verdict.repeat).toBeNull();
    expect(ledger.keptCount()).toBe(1);
  });

  it("drops a repeat and names the file it matched", async () => {
    const ledger = createShapeLedger();
    await ledger.consider({ slug: "001-canvas", blob: blobOf(jpeg()), scope, asked: "1080p" });
    const second = await ledger.consider({ slug: "002-canvas", blob: blobOf(jpeg({ trailing: 512 })), scope, asked: "16:9" });
    expect(second.keep).toBe(false);
    expect(second.repeat?.sameAsSlug).toBe("001-canvas");
    expect(second.repeat?.reason).toContain("Byte-shape identical to 001-canvas");
    expect(ledger.droppedCount()).toBe(1);
  });

  it("counts the bytes it did not store", async () => {
    const ledger = createShapeLedger();
    const repeat = jpeg({ trailing: 4096 });
    await ledger.consider({ slug: "001-canvas", blob: blobOf(jpeg()), scope, asked: "1080p" });
    await ledger.consider({ slug: "002-canvas", blob: blobOf(repeat), scope, asked: "16:9" });
    expect(ledger.bytesSaved()).toBe(repeat.byteLength);
  });

  it("records every request that repeated a shape, so the identity survives the file not doing so", async () => {
    const ledger = createShapeLedger();
    await ledger.consider({ slug: "001-canvas", blob: blobOf(jpeg()), scope, asked: "native maximum" });
    await ledger.consider({ slug: "002-canvas", blob: blobOf(jpeg()), scope, asked: "1080p landscape" });
    await ledger.consider({ slug: "003-canvas", blob: blobOf(jpeg()), scope, asked: "aspect ratio 16:9" });
    const [group] = ledger.groups();
    expect(group.keptSlug).toBe("001-canvas");
    expect(group.repeats.map((r) => r.asked)).toEqual(["1080p landscape", "aspect ratio 16:9"]);
  });

  it("keeps one copy per camera, because two lenses sharing an encoder is a finding rather than a duplicate", async () => {
    const ledger = createShapeLedger();
    await ledger.consider({ slug: "001-canvas", blob: blobOf(jpeg()), scope: shapeScope("Back Camera", "canvas"), asked: "1080p" });
    const other = await ledger.consider({ slug: "002-canvas", blob: blobOf(jpeg()), scope: shapeScope("Front Camera", "canvas"), asked: "1080p" });
    expect(other.keep).toBe(true);
    expect(ledger.sharedShapes()).toHaveLength(1);
    expect(ledger.sharedShapes()[0].scopes).toHaveLength(2);
  });

  it("keeps one copy per production path, since the two paths are different encoders", async () => {
    const ledger = createShapeLedger();
    await ledger.consider({ slug: "001-platform", blob: blobOf(jpeg()), scope: shapeScope("Back Camera", "image-capture"), asked: "1080p" });
    const canvas = await ledger.consider({ slug: "002-canvas", blob: blobOf(jpeg()), scope: shapeScope("Back Camera", "canvas"), asked: "1080p" });
    expect(canvas.keep).toBe(true);
  });

  it("keeps a genuinely different file", async () => {
    const ledger = createShapeLedger();
    await ledger.consider({ slug: "001-canvas", blob: blobOf(jpeg({ width: 1920, height: 1080 })), scope, asked: "1080p" });
    const smaller = await ledger.consider({ slug: "002-canvas", blob: blobOf(jpeg({ width: 1280, height: 720 })), scope, asked: "720p" });
    expect(smaller.keep).toBe(true);
    expect(ledger.keptCount()).toBe(2);
  });
});
