/**
 * How much of a run may be rendered as hex, and why the number is what it is.
 *
 * A hex dump is not a cheap derivative. One source byte becomes 4.94 characters
 * of text, so the dumps are the largest thing in the archive by a wide margin —
 * larger than the photos they describe. A 150-photo sweep at 3 MB a photo is
 * 450 MB of source, which is 2.2 GB of hex text. No phone browser survives
 * that: iOS Safari terminates a tab somewhere around 1–1.5 GB of resident
 * memory, and the dumps are alive as blobs at the same time as the captures
 * they came from, the deflate output, and the assembled archive.
 *
 * So there is a budget, and this module is the whole of it. Two rules:
 *
 *  1. **The budget is shared out per capture, not first-come.** Spending it in
 *     arrival order gave the first ~60 photos complete dumps and windowed the
 *     rest, which makes the completeness of a dump a fact about when a photo was
 *     taken rather than about the photo. An equal share is both smaller and more
 *     honest.
 *  2. **A window is never silent.** `hexDumpBlob` already states the skipped
 *     range in the file itself, and every windowed capture is listed in the
 *     archive's warnings. The complete file is always present in `captures/`
 *     regardless — the dump is a convenience, not the evidence.
 *
 * What is lost is worth naming precisely: the middle of a JPEG is entropy-coded
 * scan data. It is incompressible noise that no one reads by eye, and it is the
 * one region of the file with nothing structural in it. Everything a forensic
 * reader wants — SOI, the APP segments, EXIF in full, the quantisation and
 * Huffman tables, the ICC profile, the thumbnail, SOF, the first SOS, and the
 * trailing bytes after EOI — lives in the head and the tail, which is exactly
 * what a window keeps.
 */

/**
 * Characters of text produced per source byte, from `hexLines`: 8 offset digits,
 * two spaces, a 49-column hex field, a space, and 16 ASCII characters inside
 * pipes, then a newline — 79 characters for every 16 bytes.
 */
export const HEX_CHARS_PER_SOURCE_BYTE = 79 / 16;

/** Smallest window worth writing: enough for every JPEG header structure plus the tail. */
export const HEX_MIN_PER_CAPTURE = 96 * 1024;

/** Above this, a single capture is windowed even when the budget could cover it. */
export const HEX_MAX_PER_CAPTURE = 4 * 1024 * 1024;

/** Ceiling on the total, whatever the device claims it can afford. */
export const HEX_MAX_TOTAL = 32 * 1024 * 1024;

/** Floor on the total, so a device that reports very little still gets usable dumps. */
export const HEX_MIN_TOTAL = 6 * 1024 * 1024;

/**
 * Text bytes a given number of source bytes will become. Used for the estimate
 * on the setup screen, so the figure shown is derived from the real line format
 * rather than guessed at.
 */
export function hexTextBytesFor(sourceBytes: number): number {
  return Math.round(sourceBytes * HEX_CHARS_PER_SOURCE_BYTE);
}

export type MemoryHints = {
  /** `navigator.deviceMemory`, in GiB. Absent on Safari, which reports nothing. */
  deviceMemoryGb: number | null;
  /** `performance.memory.jsHeapSizeLimit`. Chrome only. */
  heapLimitBytes: number | null;
};

/**
 * Reads what the browser will admit about its own memory. Both values are
 * absent on WebKit, which is the case the conservative default exists for.
 */
export function readMemoryHints(): MemoryHints {
  const nav =
    typeof navigator === "undefined" ? null : (navigator as Navigator & { deviceMemory?: number });
  const perf =
    typeof performance === "undefined"
      ? null
      : (performance as Performance & { memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number } });
  const deviceMemory = typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null;
  const heapLimit = typeof perf?.memory?.jsHeapSizeLimit === "number" ? perf.memory.jsHeapSizeLimit : null;
  return { deviceMemoryGb: deviceMemory, heapLimitBytes: heapLimit };
}

/**
 * Total source bytes allowed a hex rendering for this device.
 *
 * The unknown case is deliberately not the largest: WebKit reports neither
 * hint and is also the strictest about killing a tab, so "we could not measure"
 * has to mean "assume little", never "assume plenty".
 */
export function hexBudgetForDevice(hints: MemoryHints): number {
  const { deviceMemoryGb, heapLimitBytes } = hints;
  let budget: number;
  if (deviceMemoryGb == null) {
    budget = 16 * 1024 * 1024;
  } else if (deviceMemoryGb >= 8) {
    budget = HEX_MAX_TOTAL;
  } else if (deviceMemoryGb >= 4) {
    budget = 20 * 1024 * 1024;
  } else if (deviceMemoryGb >= 2) {
    budget = 12 * 1024 * 1024;
  } else {
    budget = HEX_MIN_TOTAL;
  }
  if (heapLimitBytes != null && heapLimitBytes > 0) {
    // Hex text may claim at most 6% of the heap ceiling. The dumps are not the
    // only large thing alive at build time, and the ceiling is not a target.
    const fromHeap = Math.floor((heapLimitBytes * 0.06) / HEX_CHARS_PER_SOURCE_BYTE);
    budget = Math.min(budget, fromHeap);
  }
  return Math.max(HEX_MIN_TOTAL, Math.min(HEX_MAX_TOTAL, budget));
}

/**
 * The equal share one capture may spend. Clamped at both ends: the floor keeps
 * every capture's structure readable no matter how many there are, and the
 * ceiling stops a single large file from consuming a share it cannot justify.
 */
export function perCaptureHexBudget(totalBudget: number, captureCount: number): number {
  if (captureCount <= 0) return 0;
  const share = Math.floor(totalBudget / captureCount);
  return Math.max(HEX_MIN_PER_CAPTURE, Math.min(HEX_MAX_PER_CAPTURE, share));
}

/**
 * Current heap use as a fraction of the limit, or null where the browser does
 * not say. Only Chrome answers; a null means the fixed budget is the only
 * protection in play.
 */
export function memoryPressure(): number | null {
  const perf =
    typeof performance === "undefined"
      ? null
      : (performance as Performance & { memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number } });
  const used = perf?.memory?.usedJSHeapSize;
  const limit = perf?.memory?.jsHeapSizeLimit;
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
  return used / limit;
}

/** Heap fraction past which hex rendering drops to the minimum window. */
export const HEX_PRESSURE_LIMIT = 0.7;

/** A human-readable statement of the policy, written into the archive. */
export function hexPolicyText(totalBudget: number, perCapture: number, captureCount: number): string[] {
  const textTotal = hexTextBytesFor(Math.min(totalBudget, perCapture * Math.max(captureCount, 1)));
  return [
    "HEX DUMP BUDGET",
    "-".repeat(78),
    `A hex dump costs ${HEX_CHARS_PER_SOURCE_BYTE.toFixed(2)} characters per source byte, so rendering every byte of`,
    "every capture would make this archive several times larger than the photos in it and",
    "would exhaust the browser's memory before the archive finished building. There is",
    "therefore a budget, and it is stated here rather than applied quietly:",
    "",
    `  Captures in this run       ${captureCount}`,
    `  Total source-byte budget   ${totalBudget.toLocaleString("en-US")} bytes`,
    `  Equal share per capture    ${perCapture.toLocaleString("en-US")} bytes`,
    `  Upper bound on hex text    ~${textTotal.toLocaleString("en-US")} bytes`,
    "",
    "The share is equal per capture rather than first-come. Spending the budget in arrival",
    "order would mean the completeness of a dump told you when a photo was taken and nothing",
    "about the photo itself.",
    "",
    "A capture smaller than its share is dumped COMPLETE. A larger one is WINDOWED: the head",
    "and the last 8 KB are rendered and the skipped byte range is named in the dump itself.",
    "What a window omits is entropy-coded scan data — incompressible noise with no structure",
    "in it. Every structural region (SOI, all APP segments, EXIF in full, the quantisation and",
    "Huffman tables, the ICC profile, the embedded thumbnail, SOF, the first SOS, and any bytes",
    "after EOI) lives in the head or the tail and is always rendered.",
    "",
    "The complete file is present and byte-identical in captures/ or rendered-frames/ either",
    "way. For any range a window omits, dump it yourself:",
    "",
    "  xxd -s <start> -l <length> captures/<file>",
    "",
  ];
}
