/**
 * What the pixels say, as opposed to what the file says.
 *
 * Everything else in a run reads headers: tables, tags, markers, directories.
 * All of that is what the writer CHOSE to record, and a determined forger
 * chooses differently. The decoded picture is the other kind of evidence — the
 * part nobody edits by hand — and two measurements of it are worth the decode:
 *
 *   • The 8x8 block grid. Every JPEG leaves one. A grid sitting exactly on the
 *     8-pixel boundary is just this file's own compression and means nothing at
 *     all. A grid sitting OFF the boundary means the picture was compressed,
 *     then cropped or shifted, then compressed again — which a photograph
 *     straight out of a camera cannot be.
 *
 *   • The sensor pipeline's fingerprint: channel balance, tone distribution,
 *     clipping at both ends, and a noise floor. These describe how the ISP
 *     turned sensor readings into a picture.
 *
 * The honesty rules here are stricter than anywhere else in the app, because a
 * pixel statistic is the easiest thing in forensics to over-read:
 *
 *   1. Scene-dependent numbers are LABELLED scene-dependent. Channel means and
 *      the tone histogram describe what the lens was pointed at as much as the
 *      camera. They are comparable between two photos of the same scene and are
 *      close to meaningless between two photos of different ones.
 *   2. An aligned grid is reported as the non-finding it is, never dressed up.
 *   3. A frame this app encoded from a video track WILL show recompression,
 *      because that is literally what it is. The report says so itself rather
 *      than leaving a reader to discover it.
 *   4. Nothing here produces a verdict, a score or a probability. It reports
 *      measurements and states what each one can and cannot support.
 */

/**
 * The largest square of real pixels examined. Big enough that the block-grid
 * statistics are stable, small enough that the sample is a megabyte rather than
 * the fifty a full-resolution photo would cost.
 */
export const SAMPLE_EDGE = 512;

/** Beyond this the decode itself is the risk, so the pass declines rather than gambles. */
export const MAX_DECODE_PIXELS = 80_000_000;

export type BlockGridReport = {
  /** Where the strongest 8-pixel periodicity sits, 0-7 on each axis. */
  phaseX: number;
  phaseY: number;
  /** How far the strongest phase stands above the average, as a ratio. 0 = no grid at all. */
  strengthX: number;
  strengthY: number;
  /** True when the grid sits on the 8-pixel boundary, which is where a file's own compression puts it. */
  aligned: boolean;
  /** True when a grid is present at all, at any phase. */
  present: boolean;
  /** What the measurement does and does not support, in words. */
  reading: string;
};

export type ToneReport = {
  /** Mean of each channel across the sample, 0-255. Scene-dependent. */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Red-to-green and blue-to-green balance. Scene-dependent, but the white-balance pipeline shows here. */
  ratioRG: number;
  ratioBG: number;
  /** Fraction of pixels pinned at pure black and pure white. */
  clippedLow: number;
  clippedHigh: number;
  /** Luma spread across 16 buckets, as fractions summing to 1. */
  histogram: number[];
  /** Median absolute Laplacian — a floor for the noise and detail in the sample. */
  noise: number;
  /** Distinct luma values present out of 256. A heavily processed image has fewer. */
  distinctLuma: number;
};

export type PixelReport = {
  /** Where in the picture the sample was taken, so the measurement can be repeated. */
  sample: { x: number; y: number; width: number; height: number; ofWidth: number; ofHeight: number };
  grid: BlockGridReport;
  tone: ToneReport;
  notes: string[];
};

export type PixelPass = {
  report: PixelReport | null;
  /** Why there is no report. Null when there is one. */
  reason: string | null;
  /**
   * True when the reason is a property of the BROWSER rather than of this
   * picture — no decoder, no canvas. A run-wide absence belongs in the run's
   * notes once, not stamped onto every capture as though each had failed
   * individually. Repeating one environmental fact two hundred times is how a
   * warnings list stops being read.
   */
  environmental: boolean;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Finds the 8-pixel periodicity along one axis.
 *
 * For each line, the total absolute difference with its neighbour is the edge
 * energy crossing that line. Block boundaries carry more of it than the lines
 * inside a block, so grouping lines by their position modulo 8 and comparing
 * the groups reveals both whether a grid exists and where it sits.
 *
 * Strength is the winning group's excess over the mean, divided by the mean, so
 * it is a ratio rather than a raw energy and does not move with how busy the
 * picture is.
 */
function periodicity(energyByLine: number[]): { phase: number; strength: number } {
  const sums = new Array<number>(8).fill(0);
  const counts = new Array<number>(8).fill(0);
  for (let i = 0; i < energyByLine.length; i += 1) {
    sums[i % 8] += energyByLine[i];
    counts[i % 8] += 1;
  }
  const means = sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : 0));
  const overall = means.reduce((a, b) => a + b, 0) / 8;
  if (overall <= 0) return { phase: 0, strength: 0 };
  let phase = 0;
  let best = means[0];
  for (let i = 1; i < 8; i += 1) {
    if (means[i] > best) {
      best = means[i];
      phase = i;
    }
  }
  return { phase, strength: round((best - overall) / overall, 4) };
}

/** A grid this weak is indistinguishable from ordinary picture content. */
const GRID_FLOOR = 0.04;

function gridReading(phaseX: number, phaseY: number, strengthX: number, strengthY: number, present: boolean, aligned: boolean, axes: string): string {
  if (!present) {
    return (
      "No 8-pixel periodicity stands out of this sample. Either the picture was never block-compressed, or the sample " +
      "is too flat or too noisy to show it. This is an absence of evidence and nothing more — it does not establish that " +
      "the file was never compressed."
    );
  }
  if (aligned) {
    return (
      `The grid (measured ${axes}) sits exactly on the 8-pixel boundary, which is where a JPEG's own compression puts it. This is the ` +
      "expected result for any JPEG and is NOT a finding: it says the file is compressed, which its own tables already said."
    );
  }
  return (
    `The grid sits at phase (${phaseX}, ${phaseY}) rather than (0, 0), measured ${axes}. A block grid offset from the boundary means ` +
    `the picture carried compression BEFORE its current one, and was cropped or shifted by ${phaseX} across and ${phaseY} down ` +
    `between the two. A frame straight from a camera cannot show this. What it does not tell you is who did it or why — a ` +
    `crop in a gallery app and a deliberate edit look identical here. Strength ${strengthX} across, ${strengthY} down.`
  );
}

/** Measures a decoded sample. Exposed separately so the arithmetic is testable without a canvas. */
export function measureSample(data: Uint8ClampedArray, width: number, height: number): { grid: BlockGridReport; tone: ToneReport } {
  const luma = new Float32Array(width * height);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let clippedLow = 0;
  let clippedHigh = 0;
  const histogram = new Array<number>(16).fill(0);
  const lumaSeen = new Uint8Array(256);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    luma[p] = y;
    const yi = Math.min(255, Math.max(0, Math.round(y)));
    lumaSeen[yi] = 1;
    histogram[yi >> 4] += 1;
    if (r === 0 && g === 0 && b === 0) clippedLow += 1;
    if (r === 255 && g === 255 && b === 255) clippedHigh += 1;
  }

  const pixels = width * height;
  const rowEnergy: number[] = [];
  for (let y = 1; y < height; y += 1) {
    let sum = 0;
    for (let x = 0; x < width; x += 1) sum += Math.abs(luma[y * width + x] - luma[(y - 1) * width + x]);
    rowEnergy.push(sum / width);
  }
  const colEnergy: number[] = [];
  for (let x = 1; x < width; x += 1) {
    let sum = 0;
    for (let y = 0; y < height; y += 1) sum += Math.abs(luma[y * width + x] - luma[y * width + x - 1]);
    colEnergy.push(sum / height);
  }

  // The energy array starts at line 1, so the winning index is one behind the
  // phase it represents. Getting this wrong would report every aligned grid as
  // offset by one, which is the difference between "ordinary JPEG" and
  // "recompressed after a crop" — the single most consequential claim here.
  const vertical = periodicity(rowEnergy);
  const horizontal = periodicity(colEnergy);

  // An axis with no measurable periodicity has NO phase. Taking the winner of
  // eight near-identical numbers and reporting it as a phase would manufacture
  // an offset out of noise — and an offset is this pass's one serious claim.
  // A picture banded purely horizontally used to read as offset across, which
  // is a false accusation of recompression from a picture that showed none.
  const verticalPresent = vertical.strength >= GRID_FLOOR;
  const horizontalPresent = horizontal.strength >= GRID_FLOOR;
  const phaseY = verticalPresent ? (vertical.phase + 1) % 8 : 0;
  const phaseX = horizontalPresent ? (horizontal.phase + 1) % 8 : 0;
  const present = verticalPresent || horizontalPresent;
  const aligned = present && (!verticalPresent || phaseY === 0) && (!horizontalPresent || phaseX === 0);
  const axes = verticalPresent && horizontalPresent ? "on both axes" : verticalPresent ? "down only — the across axis showed none" : "across only — the down axis showed none";

  const laplacian: number[] = [];
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 64));
  for (let y = 1; y < height - 1; y += stepY) {
    for (let x = 1; x < width - 1; x += stepX) {
      const centre = luma[y * width + x];
      const value = 4 * centre - luma[(y - 1) * width + x] - luma[(y + 1) * width + x] - luma[y * width + x - 1] - luma[y * width + x + 1];
      laplacian.push(Math.abs(value));
    }
  }

  return {
    grid: {
      phaseX,
      phaseY,
      strengthX: horizontal.strength,
      strengthY: vertical.strength,
      aligned,
      present,
      reading: gridReading(phaseX, phaseY, horizontal.strength, vertical.strength, present, aligned, axes),
    },
    tone: {
      meanR: round(sumR / pixels, 2),
      meanG: round(sumG / pixels, 2),
      meanB: round(sumB / pixels, 2),
      ratioRG: sumG > 0 ? round(sumR / sumG, 4) : 0,
      ratioBG: sumG > 0 ? round(sumB / sumG, 4) : 0,
      clippedLow: round(clippedLow / pixels, 5),
      clippedHigh: round(clippedHigh / pixels, 5),
      histogram: histogram.map((count) => round(count / pixels, 5)),
      noise: round(median(laplacian), 3),
      distinctLuma: lumaSeen.reduce<number>((sum, seen) => sum + seen, 0),
    },
  };
}

/**
 * Decodes a bounded square from the middle of a capture and measures it.
 *
 * The centre is used rather than a corner because vignetting and lens
 * correction distort the edges of a phone photograph, and both would show up in
 * the channel balance as something the sensor did.
 *
 * Returns null, with a reason, rather than throwing: a picture that will not
 * decode is a fact to record, not a reason to lose the rest of a capture's
 * report.
 */
export async function probePixels(blob: Blob): Promise<PixelPass> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return {
      report: null,
      reason: "This browser exposes no image decoder this pass can use, so no pixel measurements were taken anywhere in this run. Nothing was inferred in their place.",
      environmental: true,
    };
  }
  let bitmap: ImageBitmap | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const full = bitmap.width * bitmap.height;
    if (full > MAX_DECODE_PIXELS) {
      return {
        report: null,
        reason: `The picture is ${bitmap.width}×${bitmap.height}, past the ${(MAX_DECODE_PIXELS / 1_000_000).toFixed(0)} megapixel limit this pass will decode inside a phone browser. Skipped deliberately rather than risking the run for one measurement.`,
        environmental: false,
      };
    }
    const width = Math.min(SAMPLE_EDGE, bitmap.width);
    const height = Math.min(SAMPLE_EDGE, bitmap.height);
    if (width < 32 || height < 32) {
      return {
        report: null,
        reason: `The picture is only ${bitmap.width}×${bitmap.height}, too small for the block-grid statistics to mean anything. No measurement was attempted.`,
        environmental: false,
      };
    }
    // The sample origin is forced onto an 8-pixel boundary. Cropping at an
    // arbitrary offset would introduce exactly the misalignment this pass
    // exists to detect, and the app would then be measuring its own crop.
    const x = Math.floor((bitmap.width - width) / 2 / 8) * 8;
    const y = Math.floor((bitmap.height - height) / 2 / 8) * 8;

    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { report: null, reason: "No 2D drawing context was available, so no picture in this run could be sampled.", environmental: true };
    context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const measured = measureSample(image.data, width, height);

    const notes: string[] = [
      "Channel means, the ratios and the histogram are SCENE-DEPENDENT: they describe what the lens was pointed at as much as the pipeline behind it. Compare them between photographs of the same scene; comparing them across different scenes proves nothing.",
      `Measured on a ${width}×${height} sample from the centre of the picture, taken at an exact 8-pixel offset (${x}, ${y}) so the sampling itself cannot create the misalignment the grid test looks for.`,
    ];

    return { report: { sample: { x, y, width, height, ofWidth: bitmap.width, ofHeight: bitmap.height }, ...measured, notes }, reason: null, environmental: false };
  } catch (err) {
    return {
      report: null,
      reason: `The picture could not be decoded for pixel measurement (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}). Recorded as unmeasured rather than skipped silently.`,
      environmental: false,
    };
  } finally {
    bitmap?.close();
    // The sample canvas is small, but a few hundred of them left to the
    // collector is how a phone browser runs out of room mid-pass.
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/** The readable pixel section for one capture. */
export function pixelText(report: PixelReport | null, reason: string | null, origin: string): string[] {
  const lines: string[] = ["PIXEL MEASUREMENTS", "-".repeat(78)];
  if (!report) {
    lines.push(`  Not measured. ${reason ?? "No reason was recorded, which is itself a fault."}`);
    return lines;
  }
  const selfEncoded = origin === "app-encoded-frame";
  lines.push(
    `  sample              ${report.sample.width}×${report.sample.height} from (${report.sample.x}, ${report.sample.y}) of ${report.sample.ofWidth}×${report.sample.ofHeight}`,
    "",
    "  8x8 BLOCK GRID",
    `    phase             (${report.grid.phaseX}, ${report.grid.phaseY})`,
    `    strength          ${report.grid.strengthX} across, ${report.grid.strengthY} down`,
    `    ${report.grid.reading}`
  );
  if (selfEncoded && report.grid.present) {
    lines.push(
      "",
      "    NOTE: this frame was drawn from a video track and encoded by THIS APP. It is a re-encode by",
      "    definition, so grid evidence here is expected and says nothing about the camera. It is reported",
      "    for completeness and must not be read as a finding."
    );
  }
  lines.push(
    "",
    "  SENSOR PIPELINE",
    `    channel means     R ${report.tone.meanR}  G ${report.tone.meanG}  B ${report.tone.meanB}`,
    `    balance           R/G ${report.tone.ratioRG}  B/G ${report.tone.ratioBG}`,
    `    clipped           ${(report.tone.clippedLow * 100).toFixed(3)}% pure black, ${(report.tone.clippedHigh * 100).toFixed(3)}% pure white`,
    `    noise floor       ${report.tone.noise} (median absolute Laplacian)`,
    `    distinct luma     ${report.tone.distinctLuma} of 256`,
    `    tone histogram    ${report.tone.histogram.map((v) => v.toFixed(3)).join(" ")}`,
    ""
  );
  for (const note of report.notes) lines.push(`  ${note}`);
  return lines;
}
