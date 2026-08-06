/**
 * The evidence pack rests on one claim: a captured file comes out of the archive
 * byte-for-byte identical to what went in. These tests hold that claim to
 * account rather than trusting it — they carve payloads back out of a built
 * archive at the raw offset and compare bytes, and they check the CRC-32
 * implementation against the standard published check value.
 */

import { describe, expect, it } from "vitest";

import { buildZip, crc32OfBlob, crcHex, safeZipPath, verifyBytes } from "./zip-writer";

const LOCAL_SIG = 0x04034b50;
const EOCD_SIG = 0x06054b50;

/** Wraps bytes in an ArrayBuffer-backed Blob (a bare Uint8Array is not a valid BlobPart). */
function blobOf(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer]);
}

/**
 * A payload that would expose any accidental text decoding, re-encoding or
 * truncation: every one of the 256 byte values, a JPEG SOI/APP1 "Exif" header,
 * embedded NUL bytes, and a lone 0xFF (invalid UTF-8) at the end.
 */
function hostileBytes(): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x16, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const all256 = Array.from({ length: 256 }, (_, i) => i);
  const tail = [0x00, 0x00, 0xff, 0xd9, 0xff];
  return new Uint8Array([...head, ...all256, ...all256.slice().reverse(), ...tail]);
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("crc32OfBlob", () => {
  it("matches the standard CRC-32 check value for '123456789'", async () => {
    const crc = await crc32OfBlob(blobOf(new TextEncoder().encode("123456789")));
    expect(crcHex(crc)).toBe("cbf43926");
  });

  it("returns 0 for empty input", async () => {
    expect(await crc32OfBlob(new Blob([]))).toBe(0);
  });

  it("changes when a single byte changes", async () => {
    const a = blobOf(new Uint8Array([1, 2, 3, 4]));
    const b = blobOf(new Uint8Array([1, 2, 3, 5]));
    expect(await crc32OfBlob(a)).not.toBe(await crc32OfBlob(b));
  });
});

describe("buildZip byte identity", () => {
  it("stores payloads uncompressed and carving at dataOffset returns the exact source bytes", async () => {
    const source = hostileBytes();
    const sourceBlob = new Blob([blobOf(source)], { type: "image/jpeg" });
    const { blob, entries } = await buildZip([
      { path: "originals/01-front.jpg", data: sourceBlob },
      { path: "overview.txt", data: "a readable summary" },
    ]);

    const entry = entries.find((e) => e.path === "originals/01-front.jpg");
    expect(entry).toBeDefined();
    if (!entry) return;

    // Size is preserved exactly — no re-encode, no padding.
    expect(entry.size).toBe(source.byteLength);

    // Carve at the raw offset, exactly as the pack's instructions tell a reviewer to.
    const carved = await bytesOf(blob.slice(entry.dataOffset, entry.dataOffset + entry.size));
    expect(carved).toEqual(source);
    expect(await crc32OfBlob(blobOf(carved))).toBe(entry.crc32);
  });

  it("writes a store-method local header whose declared sizes match the payload", async () => {
    const source = hostileBytes();
    const { blob, entries } = await buildZip([{ path: "originals/clip.mp4", data: blobOf(source) }]);
    const entry = entries[0];
    const header = new DataView(await blob.slice(entry.headerOffset, entry.dataOffset).arrayBuffer());

    expect(header.getUint32(0, true)).toBe(LOCAL_SIG);
    expect(header.getUint16(8, true)).toBe(0); // compression method 0 = store
    expect(header.getUint32(14, true)).toBe(entry.crc32);
    expect(header.getUint32(18, true)).toBe(source.byteLength); // compressed size
    expect(header.getUint32(22, true)).toBe(source.byteLength); // uncompressed size
    // Store means the two sizes must agree; a deflate would shrink one of them.
    expect(header.getUint32(18, true)).toBe(header.getUint32(22, true));
  });

  it("produces an archive that ends with a well-formed EOCD naming every entry", async () => {
    const { blob, entries } = await buildZip([
      { path: "a.bin", data: blobOf(new Uint8Array([1, 2, 3])) },
      { path: "b.bin", data: blobOf(new Uint8Array([4, 5])) },
      { path: "c.txt", data: "three" },
    ]);
    const eocd = new DataView(await blob.slice(blob.size - 22).arrayBuffer());
    expect(eocd.getUint32(0, true)).toBe(EOCD_SIG);
    expect(eocd.getUint16(10, true)).toBe(entries.length);
  });

  it("keeps every payload intact when several are archived together", async () => {
    const payloads = [hostileBytes(), new Uint8Array([0]), new Uint8Array(5000).fill(0xab)];
    const { blob, entries } = await buildZip(payloads.map((p, i) => ({ path: `originals/${i}.bin`, data: blobOf(p) })));
    for (let i = 0; i < payloads.length; i += 1) {
      const entry = entries.find((e) => e.path === `originals/${i}.bin`);
      expect(entry).toBeDefined();
      if (!entry) continue;
      const carved = await bytesOf(blob.slice(entry.dataOffset, entry.dataOffset + entry.size));
      expect(carved).toEqual(payloads[i]);
    }
  });

  it("de-duplicates colliding paths instead of dropping a file", async () => {
    const { entries } = await buildZip([
      { path: "originals/x.jpg", data: "first" },
      { path: "originals/x.jpg", data: "second" },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.path)).toEqual(["originals/x.jpg", "originals/x (2).jpg"]);
  });

  it("lets finalize cite the offsets and checksums of the entries above it", async () => {
    const source = hostileBytes();
    let seenPath = "";
    let seenCrc = -1;
    const { blob, entries } = await buildZip([{ path: "originals/01.jpg", data: blobOf(source) }], {
      finalize: (table) => {
        seenPath = table[0].path;
        seenCrc = table[0].crc32;
        return [
          {
            path: "verification/byte-identity.txt",
            data: `${table[0].path} ${crcHex(table[0].crc32)} @${table[0].dataOffset}`,
          },
        ];
      },
    });

    expect(seenPath).toBe("originals/01.jpg");
    expect(seenCrc).toBe(await crc32OfBlob(blobOf(source)));
    const report = entries.find((e) => e.path === "verification/byte-identity.txt");
    expect(report).toBeDefined();
    if (!report) return;

    // The report must name the real offset, and that offset must still carve correctly.
    const text = await blob.slice(report.dataOffset, report.dataOffset + report.size).text();
    const original = entries[0];
    expect(text).toBe(`originals/01.jpg ${crcHex(original.crc32)} @${original.dataOffset}`);
    const carved = await bytesOf(blob.slice(original.dataOffset, original.dataOffset + original.size));
    expect(carved).toEqual(source);
  });

  it("reports progress for every entry, finalize entries included", async () => {
    const seen: string[] = [];
    await buildZip([{ path: "a.txt", data: "a" }], {
      onProgress: (p) => seen.push(p.path),
      finalize: () => [{ path: "b.txt", data: "b" }],
    });
    expect(seen).toEqual(["a.txt", "b.txt"]);
  });
});

describe("verifyBytes", () => {
  it("confirms identical blobs and returns their CRC", async () => {
    const bytes = hostileBytes();
    const result = await verifyBytes(blobOf(bytes), blobOf(bytes));
    expect(result.identical).toBe(true);
    expect(result.firstDifferenceAt).toBeNull();
    expect(result.crc32).toBe(await crc32OfBlob(blobOf(bytes)));
  });

  it("locates a single flipped byte", async () => {
    const a = hostileBytes();
    const b = hostileBytes();
    b[100] = b[100] ^ 0xff;
    const result = await verifyBytes(blobOf(a), blobOf(b));
    expect(result.identical).toBe(false);
    expect(result.firstDifferenceAt).toBe(100);
  });

  it("rejects a truncated payload", async () => {
    const a = hostileBytes();
    const result = await verifyBytes(blobOf(a.slice(0, a.length - 1)), blobOf(a));
    expect(result.identical).toBe(false);
  });

  it("handles payloads larger than one CRC chunk", async () => {
    // 9 MB spans several 4 MB streaming slices, where an off-by-one would hide.
    const big = new Uint8Array(9 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const same = await verifyBytes(blobOf(big), blobOf(big));
    expect(same.identical).toBe(true);

    const mutated = big.slice();
    const at = 6 * 1024 * 1024 + 7;
    mutated[at] = mutated[at] ^ 0x01;
    const differs = await verifyBytes(blobOf(big), blobOf(mutated));
    expect(differs.identical).toBe(false);
    expect(differs.firstDifferenceAt).toBe(at);
  });
});

describe("safeZipPath", () => {
  it("neutralises traversal so no '..' segment can survive", () => {
    const out = safeZipPath("/originals/../../etc/passwd");
    expect(out.startsWith("/")).toBe(false);
    expect(out.split("/")).not.toContain("..");
    // Segments are defused rather than collapsed, so an odd name stays visible.
    expect(out).toBe("originals/_/_/etc/passwd");
  });

  it("leaves ordinary pack paths untouched", () => {
    expect(safeZipPath("originals/01-front.jpg")).toBe("originals/01-front.jpg");
    expect(safeZipPath("processed/01-front/ela-heatmap.png")).toBe("processed/01-front/ela-heatmap.png");
    expect(safeZipPath("verification/byte-identity.txt")).toBe("verification/byte-identity.txt");
  });

  it("keeps non-ASCII names, which the UTF-8 flag makes valid", () => {
    expect(safeZipPath("originals/permis-de-conduire-café.jpg")).toBe("originals/permis-de-conduire-café.jpg");
  });

  it("never returns an empty path", () => {
    expect(safeZipPath("///")).toBe("unnamed");
    expect(safeZipPath("...")).toBe("_");
  });
});
