/**
 * Why the camera sweep ran out of memory, and what this module does about it.
 *
 * The sweep died mid-run at 106 photos with 129.75 MB of captures held. The
 * captures were not the problem — 130 MB of blobs is survivable. The problem was
 * invisible in every counter on screen, because it was never counted:
 *
 *  1. **A fresh `<canvas>` per still, never released.** A canvas sized to a 4K
 *     video frame holds 3840 × 2160 × 4 = **31.6 MiB** of backing store, and one
 *     sized to an 8K frame holds **126.6 MiB**. The sweep takes a canvas still at
 *     the native maximum, at every landscape rung and at every aspect ratio —
 *     roughly 14 per camera, so ~56 across a four-camera phone. At 4K that is
 *     **1.77 GiB** of backing store requested in a couple of minutes. A detached
 *     canvas is only reclaimed when the collector gets round to it, and WebKit
 *     additionally caps *total* canvas memory per tab separately from the JS
 *     heap. Nothing in the run gave it a chance to keep up.
 *  2. **A full image decode purely to read width and height.** `blobSize` loaded
 *     every platform still into an `Image` to read `naturalWidth` — a complete 4K
 *     decode, another ~31.6 MiB, cached by the engine well past the read. Two
 *     numbers available in the file's header were being paid for with the whole
 *     image.
 *
 * So this module: one canvas reused for the entire run with its backing store
 * dropped immediately after each encode, dimensions read from the header instead
 * of decoded, and a declared ceiling on bytes held so the run stops photographing
 * before the tab dies rather than after.
 *
 * The ceiling matters for a reason beyond memory. When it is reached the sweep
 * keeps *mapping* — asked-versus-granted rows cost nothing to hold and are the
 * actual product of stage three — and only stops taking stills. Trading the
 * cheap, complete record for the expensive, redundant one would be the wrong way
 * round.
 */

import { type MemoryHints } from "./hex-budget";

/** Bytes of canvas backing store per pixel: RGBA, 8 bits a channel. */
export const CANVAS_BYTES_PER_PIXEL = 4;

/** Backing store a canvas of these dimensions occupies. */
export function canvasBackingBytes(width: number, height: number): number {
  return Math.max(0, Math.floor(width)) * Math.max(0, Math.floor(height)) * CANVAS_BYTES_PER_PIXEL;
}

/**
 * Ceiling on capture bytes held in memory at once.
 *
 * The observed crash happened at 130 MB held, so a ceiling near that would cut
 * off healthy runs that were never the problem. These figures sit above what a
 * full sweep actually produces (~150–250 MB) while still being a bound, because
 * "no limit" is not a design.
 */
export function heldBytesCeiling(hints: MemoryHints): number {
  const gb = hints.deviceMemoryGb;
  if (gb == null) return 320 * 1024 * 1024;
  if (gb >= 8) return 640 * 1024 * 1024;
  if (gb >= 6) return 480 * 1024 * 1024;
  if (gb >= 4) return 384 * 1024 * 1024;
  return 224 * 1024 * 1024;
}

/* ------------------------------------------------------------------ *
 * One canvas, reused, released
 * ------------------------------------------------------------------ */

let scratch: HTMLCanvasElement | null = null;

/**
 * The single canvas every still in the run is drawn on. Reusing one element is
 * what keeps peak canvas memory at one frame instead of one per photo. The sweep
 * is strictly sequential, so there is no risk of two stills sharing it.
 */
function scratchCanvas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (!scratch) scratch = document.createElement("canvas");
  return scratch;
}

/**
 * Frees a canvas's backing store now rather than at the collector's convenience.
 * Setting either dimension to zero is what actually releases the pixels —
 * dropping the reference alone leaves tens of megabytes resident for an
 * unpredictable stretch, which is exactly how the sweep accumulated gigabytes.
 */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // A canvas that refuses to resize is not worth failing a capture over.
  }
}

export type StillResult = {
  blob: Blob;
  width: number;
  height: number;
  /** Backing store this still needed, so the cost is recorded rather than hidden. */
  canvasBytes: number;
};

/**
 * Draws the current video frame and encodes it, then immediately releases the
 * pixels. The encode itself is unchanged — same 2D context, same `drawImage`,
 * same `toBlob` quality — so the bytes produced are identical to before. Only
 * the lifetime of the buffer differs.
 */
export async function drawVideoStill(video: HTMLVideoElement, quality: number): Promise<StillResult | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width <= 0 || height <= 0) return null;

  const canvas = scratchCanvas();
  if (!canvas) return null;

  // Assigning the dimensions also clears the canvas, so a smaller frame can
  // never leave a previous still's pixels around its edges.
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    releaseCanvas(canvas);
    return null;
  }

  try {
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
    });
    return blob ? { blob, width, height, canvasBytes: canvasBackingBytes(width, height) } : null;
  } finally {
    // After the encode has resolved, never before — releasing early would pull
    // the pixels out from under `toBlob`.
    releaseCanvas(canvas);
  }
}

/** Drops the shared canvas entirely, for the end of a run. */
export function releaseScratchCanvas(): void {
  if (!scratch) return;
  releaseCanvas(scratch);
  scratch = null;
}

/* ------------------------------------------------------------------ *
 * Dimensions from the header, not from a decode
 * ------------------------------------------------------------------ */

/** How far into a file the dimension fields are looked for. */
const HEADER_SLICE = 512 * 1024;

export type PixelSize = {
  width: number;
  height: number;
  /** Which field the numbers came from, so the reading is attributable. */
  source: "jpeg-sof" | "png-ihdr" | "iso-bmff-ispe" | "webp" | "gif" | "image-decode";
};

function u16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

/**
 * Walks JPEG segments to the frame header. Every JPEG carries its true pixel
 * dimensions in SOF, so this is exact rather than an approximation of a decode.
 */
function jpegSize(b: Uint8Array): PixelSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1];
    // Padding and standalone markers carry no length field.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    const length = u16(b, at + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (at + 9 >= b.length) return null;
      return { height: u16(b, at + 5), width: u16(b, at + 7), source: "jpeg-sof" };
    }
    if (marker === 0xda) return null; // Scan data reached with no frame header.
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function pngSize(b: Uint8Array): PixelSize | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i += 1) if (b[i] !== sig[i]) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  return { width: u32(b, 16), height: u32(b, 20), source: "png-ihdr" };
}

/**
 * HEIC and friends keep dimensions in an `ispe` box. The box is located by scan
 * rather than by a full box-tree walk because only two numbers are wanted, and
 * the first `ispe` in the file is the primary item's on every encoder that
 * matters here.
 */
function isoBmffSize(b: Uint8Array): PixelSize | null {
  if (b.length < 16) return null;
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) !== "ftyp") return null;
  for (let at = 8; at + 20 < b.length; at += 1) {
    if (b[at] === 0x69 && b[at + 1] === 0x73 && b[at + 2] === 0x70 && b[at + 3] === 0x65) {
      const width = u32(b, at + 8);
      const height = u32(b, at + 12);
      if (width > 0 && height > 0 && width < 100000 && height < 100000) {
        return { width, height, source: "iso-bmff-ispe" };
      }
    }
  }
  return null;
}

function webpSize(b: Uint8Array): PixelSize | null {
  if (b.length < 30) return null;
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== "RIFF") return null;
  if (String.fromCharCode(b[8], b[9], b[10], b[11]) !== "WEBP") return null;
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === "VP8X") {
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height, source: "webp" };
  }
  if (chunk === "VP8 ") {
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, source: "webp" };
  }
  if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, source: "webp" };
  }
  return null;
}

function gifSize(b: Uint8Array): PixelSize | null {
  if (b.length < 10) return null;
  if (String.fromCharCode(b[0], b[1], b[2]) !== "GIF") return null;
  return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), source: "gif" };
}

/** Reads dimensions out of a header slice. Exact for every format a browser produces. */
export function pixelSizeFromHeader(bytes: Uint8Array): PixelSize | null {
  return jpegSize(bytes) ?? pngSize(bytes) ?? isoBmffSize(bytes) ?? webpSize(bytes) ?? gifSize(bytes);
}

/** Last-resort decode, used only for a container no parser above recognised. */
function decodeSize(blob: Blob): Promise<PixelSize | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined" || typeof URL?.createObjectURL !== "function") {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (result: PixelSize | null): void => {
      img.onload = null;
      img.onerror = null;
      // Clearing src lets the engine drop the decoded bitmap rather than keeping
      // it cached against an element that is about to go out of scope.
      img.src = "";
      URL.revokeObjectURL(url);
      resolve(result);
    };
    img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight, source: "image-decode" });
    img.onerror = () => done(null);
    img.src = url;
  });
}

/**
 * Dimensions of an encoded image, from its header where possible.
 *
 * A 4K photo costs ~31.6 MiB to decode and a few hundred bytes to parse, and the
 * parse is the more accurate of the two — it reports what the file declares
 * rather than what the decoder produced after applying orientation.
 */
export async function readPixelSize(blob: Blob): Promise<PixelSize | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, Math.min(HEADER_SLICE, blob.size)).arrayBuffer());
    const parsed = pixelSizeFromHeader(head);
    if (parsed) return parsed;
  } catch {
    // Fall through to the decode.
  }
  return decodeSize(blob);
}

export type CaptureMemoryFacts = {
  heldBytes: number;
  ceilingBytes: number;
  peakCanvasBytes: number;
  stillsStoppedForMemory: string | null;
};

/** The whole policy, in the words the archive uses, with this run's real figures. */
export function capturePolicyText(facts: CaptureMemoryFacts, hints: MemoryHints): string[] {
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return [
    "CAPTURE MEMORY POLICY",
    "=".repeat(78),
    "",
    "THIS RUN",
    "-".repeat(78),
    `  Capture bytes held at the end of the sweep   ${mb(facts.heldBytes)}`,
    `  Ceiling for this device                      ${mb(facts.ceilingBytes)}`,
    `  Largest single canvas backing store used     ${mb(facts.peakCanvasBytes)}`,
    `  Device memory hint                           ${hints.deviceMemoryGb == null ? "not reported (WebKit reports none, so the conservative figure applies)" : `${hints.deviceMemoryGb} GB`}`,
    `  Stills stopped early for memory              ${facts.stillsStoppedForMemory == null ? "no" : "YES \u2014 see the note below and the omissions list"}`,
    ...(facts.stillsStoppedForMemory == null ? [] : ["", ...wrapText(facts.stillsStoppedForMemory, 76).map((l) => `  ${l}`)]),
    "",
    "WHY THERE IS A POLICY AT ALL",
    "-".repeat(78),
    "Two costs in a camera sweep are invisible in any on-screen byte counter, and both were",
    "large enough to end a run:",
    "",
    "  1. Canvas backing store. A canvas sized to a 4K frame holds 3840 x 2160 x 4 =",
    "     31.6 MiB of pixels; an 8K frame holds 126.6 MiB. A sweep takes roughly 14 canvas",
    "     stills per camera, so a four-camera phone asks for ~56 of them. One canvas per",
    "     still is ~1.8 GiB at 4K. This run reuses a single canvas and frees its pixels",
    "     immediately after each encode, holding one frame instead of one per photo.",
    "",
    "  2. Image decoding. Reading a photo's width and height by loading it into an Image",
    "     element decodes the entire picture — another 31.6 MiB at 4K — for two numbers that",
    "     are written in the file's header. Dimensions here are parsed from the header",
    "     (JPEG SOF, PNG IHDR, ISO-BMFF ispe, WebP, GIF), which is both cheaper and more",
    "     accurate: it reports what the file declares rather than what a decoder produced.",
    "",
    "The encoded bytes are unaffected by either change. Same context, same draw, same encode",
    "quality — only the lifetime of the buffer differs.",
    "",
    "If the ceiling is reached, the sweep stops taking stills and keeps mapping asked-versus-",
    "granted rows, which cost nothing to hold and are the actual product of the sweep. That",
    "is recorded as an omission and shown on screen; it is never silent.",
    "",
    "An empty capture list on a row therefore has three possible causes, and they are kept",
    "apart: the step was never meant to produce a still (see the still policy in",
    "camera/matrix.txt), the still was attempted and failed, or stills had already stopped for",
    "memory. Only the last of those is described above.",
  ];
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
