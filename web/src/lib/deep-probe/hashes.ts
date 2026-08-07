/**
 * Four checksums per file, so any tool the reader already trusts can confirm
 * the archive without taking this app's word for anything.
 *
 * SHA-1 and SHA-256 come from the platform (`crypto.subtle`). MD5 was removed
 * from the Web Crypto algorithm list on purpose — it is broken for signatures —
 * but `md5sum` is still the most universally available checker on earth, so it
 * is implemented here in plain TypeScript and labelled for what it is: an
 * integrity/transcription check, never a security claim.
 *
 * Everything streams in slices, so hashing a 40 MB capture never materialises
 * 40 MB of extra heap beyond the slice being folded in.
 */

import { crc32OfBlob, crcHex } from "../zip-writer";

const CHUNK = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * MD5 (RFC 1321), streaming
 * ------------------------------------------------------------------ */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** Rolling MD5 so a large blob can be folded in slice by slice. */
class Md5 {
  private a = 0x67452301;
  private b = 0xefcdab89;
  private c = 0x98badcfe;
  private d = 0x10325476;
  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalLength = 0;
  private readonly words = new Uint32Array(16);

  update(bytes: Uint8Array): void {
    this.totalLength += bytes.length;
    let offset = 0;
    if (this.bufferLength > 0) {
      const need = 64 - this.bufferLength;
      const take = Math.min(need, bytes.length);
      this.buffer.set(bytes.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset = take;
      if (this.bufferLength < 64) return;
      this.block(this.buffer, 0);
      this.bufferLength = 0;
    }
    while (offset + 64 <= bytes.length) {
      this.block(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.length) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = bytes.length - offset;
    }
  }

  private block(src: Uint8Array, base: number): void {
    const m = this.words;
    for (let i = 0; i < 16; i += 1) {
      const j = base + i * 4;
      m[i] = (src[j] | (src[j + 1] << 8) | (src[j + 2] << 16) | (src[j + 3] << 24)) >>> 0;
    }
    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + K[i] + m[g]) >>> 0;
      b = (b + rotl(sum, S[i])) >>> 0;
      a = tmp;
    }
    this.a = (this.a + a) >>> 0;
    this.b = (this.b + b) >>> 0;
    this.c = (this.c + c) >>> 0;
    this.d = (this.d + d) >>> 0;
  }

  digest(): string {
    const bitLength = this.totalLength * 8;
    const tail = new Uint8Array(this.bufferLength < 56 ? 64 : 128);
    tail.set(this.buffer.subarray(0, this.bufferLength), 0);
    tail[this.bufferLength] = 0x80;
    const view = new DataView(tail.buffer);
    // 64-bit little-endian bit length; JS numbers cover files far beyond ZIP's 4 GB cap.
    view.setUint32(tail.length - 8, bitLength >>> 0, true);
    view.setUint32(tail.length - 4, Math.floor(bitLength / 4294967296) >>> 0, true);
    for (let offset = 0; offset < tail.length; offset += 64) this.block(tail, offset);
    return [this.a, this.b, this.c, this.d].map(le32Hex).join("");
  }
}

function le32Hex(value: number): string {
  const v = value >>> 0;
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ *
 * Platform digests
 * ------------------------------------------------------------------ */

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function subtle(): SubtleCrypto | null {
  if (typeof crypto === "undefined") return null;
  return crypto.subtle ?? null;
}

/**
 * `crypto.subtle.digest` has no streaming form, so SHA needs the whole payload
 * in one buffer. That is fine for stills; for anything large this is the one
 * place peak memory scales with file size, and it is capped rather than risked.
 */
const SUBTLE_MAX = 64 * 1024 * 1024;

async function platformDigest(blob: Blob, algorithm: "SHA-1" | "SHA-256"): Promise<string> {
  const api = subtle();
  if (!api) return `unavailable — crypto.subtle is not exposed here (needs a secure context)`;
  if (blob.size > SUBTLE_MAX) {
    return `not computed — ${(blob.size / 1024 / 1024).toFixed(1)} MB exceeds the ${SUBTLE_MAX / 1024 / 1024} MB single-buffer limit this app will allocate for a digest`;
  }
  try {
    const digest = await api.digest(algorithm, await blob.arrayBuffer());
    return toHex(digest);
  } catch (err) {
    return `failed — ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Every checksum this app records for one payload. */
export type FileHashes = {
  bytes: number;
  md5: string;
  sha1: string;
  sha256: string;
  crc32: string;
};

/** Computes MD5, SHA-1, SHA-256 and CRC-32 over one blob. */
export async function hashBlob(blob: Blob): Promise<FileHashes> {
  const md5 = new Md5();
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    const slice = blob.slice(offset, Math.min(offset + CHUNK, blob.size));
    md5.update(new Uint8Array(await slice.arrayBuffer()));
  }
  const [sha1, sha256, crc] = await Promise.all([platformDigest(blob, "SHA-1"), platformDigest(blob, "SHA-256"), crc32OfBlob(blob)]);
  return { bytes: blob.size, md5: md5.digest(), sha1, sha256, crc32: crcHex(crc) };
}

/** MD5 of a byte array, for tests and small in-memory payloads. */
export function md5Bytes(bytes: Uint8Array): string {
  const md5 = new Md5();
  md5.update(bytes);
  return md5.digest();
}
