/**
 * What the pixels say, as opposed to what the file says.
 *
 * Everything else in a run reads headers: tables, tags, markers, directories.
 * All of that is what the writer CHOSE to record, and a determined forger
 * chooses differently. The decoded picture is the other kind of evidence — the
 * part nobody edits by hand — and several measurements of it earn the decode:
 *
 *   • The 8x8 block grid. Every JPEG leaves one. A grid sitting exactly on the
 *     8-pixel boundary is just this file's own compression and means nothing at
 *     all. A grid sitting OFF the boundary means the picture was compressed,
 *     then cropped or shifted, then compressed again — which a photograph
 *     straight out of a camera cannot be.
 *
 *   • The 2x2 colour-filter rhythm. A picture that came off a real sensor was
 *     demosaiced: three quarters of the red and blue in it were interpolated
 *     from neighbours, and that interpolation leaves a faint four-phase
 *     structure nothing else produces.
 *
 *   • The sensor pipeline's fingerprint: channel balance, tone distribution,
 *     clipping per channel, a noise floor measured where the picture is flat,
 *     and the falloff from the middle of the frame to its corners.
 *
 *   • Whether the tone range has been stretched after capture, which leaves
 *     evenly spaced empty levels a camera never writes.
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
 *   4. Absence is never proof. No colour-filter rhythm can mean a synthetic
 *      picture, or simply a picture compressed hard enough to erase it, and the
 *      report says both every time.
 *   5. Nothing here produces a verdict, a score or a probability. It reports
 *      measurements and states what each one can and cannot support.
 *
 * And one rule about the decode itself, which used to be silently broken:
 * a browser will happily rotate a photo to its EXIF orientation and convert its
 * colours to the display profile BEFORE handing over any pixels. Measuring that
 * is measuring the browser. Both are switched off where the browser understands
 * how, and where it does not, the report says which measurement is standing on
 * unknown ground rather than pretending it is not.
 */

/**
 * The largest square of real pixels examined. Big enough that the block-grid
 * statistics are stable, small enough that the sample is a megabyte rather than
 * the fifty a full-resolution photo would cost.
 */
export const SAMPLE_EDGE = 512;

/** Beyond this the decode itself is the risk, so the pass declines rather than gambles. */
export const MAX_DECODE_PIXELS = 80_000_000;

/** Edge of each corner/centre patch used for the falloff measurement. */
export const FIELD_PATCH = 96;

/** The colour-filter test walks every pixel, so it works on a bounded square. */
const CFA_EDGE = 256;

/** Side of the tiles the flat-noise search divides the sample into. */
const FLAT_TILE = 32;

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

/**
 * The noise floor, measured where the picture is flat.
 *
 * The old figure was taken across the whole patch, which made it a DETAIL floor
 * rather than a noise floor: point the lens at a bookshelf and it rose, point it
 * at a wall and it fell, and neither movement had anything to do with the
 * sensor. Restricting it to the flattest tiles removes most of the scene from
 * the number, and splitting it by channel exposes the thing that is genuinely a
 * device trait — red and blue are interpolated far more heavily than green in
 * every Bayer pipeline, so their floors sit above green's by an amount that
 * belongs to the camera rather than to the subject.
 */
export type FlatNoise = {
  r: number;
  g: number;
  b: number;
  luma: number;
  /** Tiles used, and how many the sample was divided into. */
  tiles: number;
  ofTiles: number;
  /** Mean of the red and blue floors over green's. Above 1 is the ordinary direction. */
  chromaRatio: number | null;
};

/**
 * Empty levels inside the occupied range.
 *
 * Brightening or contrast-stretching an 8-bit picture after capture spreads its
 * levels apart and leaves regularly spaced holes where nothing lands. A camera
 * writing its own JPEG does not produce that comb.
 */
export type GapReport = {
  /** Levels actually present, per channel, out of 256. */
  levels: { r: number; g: number; b: number };
  /** Empty levels sitting inside the occupied range, per channel. */
  empty: { r: number; g: number; b: number };
  /** True only when the surviving levels are evenly spaced, which is the signature. */
  comb: boolean;
  /** Spacing between surviving levels when the comb is regular. */
  spacing: number | null;
  /** True when too few levels were present for the question to be asked at all. */
  undecidable: boolean;
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
  /** Fraction of pixels pinned at pure black and pure white in ALL three channels at once. */
  clippedLow: number;
  clippedHigh: number;
  /** The same per channel, which is where a blown sky or a crushed shadow actually shows. */
  clippedLowR: number;
  clippedLowG: number;
  clippedLowB: number;
  clippedHighR: number;
  clippedHighG: number;
  clippedHighB: number;
  /** Luma spread across 16 buckets, as fractions summing to 1. */
  histogram: number[];
  /** Median absolute Laplacian across the whole sample — a floor for noise AND detail. */
  noise: number;
  /** The same measured only where the picture is flat, per channel. */
  flat: FlatNoise;
  /** Distinct luma values present out of 256. A heavily processed image has fewer. */
  distinctLuma: number;
  /** Whether the tone range carries the comb a post-capture stretch leaves. */
  gaps: GapReport;
};

/**
 * The four-phase structure a demosaic leaves behind.
 *
 * Every colour filter array puts one colour over each photosite, so three
 * quarters of the red and blue in a finished picture were guessed from
 * neighbours. The guessing error is not the same at each of the four positions
 * in the 2x2 tile, and comparing those four positions is the closest thing in
 * this whole app to asking "was this ever a photograph".
 *
 * What it cannot do is prove the negative. Enough compression, any resize, and
 * a screenshot at a non-integer scale all erase it, and the reading says so.
 */
export type CfaReport = {
  /** Mean absolute high-frequency residual at each of the four 2x2 positions. */
  phases: number[];
  /** Which channel showed the structure most strongly. */
  channel: "red" | "green" | "blue";
  /** Spread across the four phases as a fraction of their mean. 0 = no structure. */
  strength: number;
  present: boolean;
  reading: string;
};

/**
 * The frame from the middle out.
 *
 * Every phone lens is darker in the corners than in the centre, and every phone
 * corrects for it by some amount that is a property of that model. Measuring
 * only the middle — which is what this pass used to do — threw the whole trait
 * away, and threw away the check on whether the noise floor is even across the
 * frame, which heavy corner correction visibly is not.
 */
export type FieldReport = {
  patch: number;
  centreLuma: number;
  /** Top-left, top-right, bottom-left, bottom-right. */
  cornerLuma: number[];
  /** Mean corner luma over centre luma. Below 1 is the ordinary direction for a lens. */
  falloff: number;
  centreNoise: number;
  cornerNoise: number[];
  reading: string;
};

/**
 * What the browser did to the picture before this pass ever saw it.
 *
 * Both of these were unasked-for and unrecorded until now, and both change the
 * answers: an EXIF rotation moves the block grid onto the other axis, which is
 * the difference between an ordinary photograph and an accusation of
 * recompression, and a colour conversion rewrites every channel mean in the
 * report as partly the browser's arithmetic.
 */
export type DecodeFidelity = {
  /** True when the browser understands being told not to apply EXIF rotation. */
  storedOrientation: boolean | null;
  /** True when the browser understands being told not to convert colour. */
  storedColour: boolean | null;
  /** The colour space the pixels were actually read in, when the browser names it. */
  colourSpace: string | null;
  note: string;
};

export type PixelReport = {
  /** Where in the picture the sample was taken, so the measurement can be repeated. */
  sample: { x: number; y: number; width: number; height: number; ofWidth: number; ofHeight: number };
  grid: BlockGridReport;
  tone: ToneReport;
  cfa: CfaReport;
  /** Null when the picture is too small to hold five separate patches. */
  field: FieldReport | null;
  decode: DecodeFidelity;
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

/** Below this the four 2x2 phases are simply four measurements of the same thing. */
const CFA_FLOOR = 0.06;

/** Fewer surviving levels than this and a comb cannot be told from a flat subject. */
const GAP_MIN_LEVELS = 24;

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

function cfaReading(present: boolean, strength: number, channel: string, phases: number[]): string {
  if (!present) {
    return (
      `No 2x2 colour-filter structure stands out of this sample (spread ${strength} across the four positions, measured on the ${channel} channel). ` +
      "A picture that came off a sensor normally carries one, because three quarters of its red and blue were interpolated from neighbours. " +
      "This absence is NOT proof of a synthetic picture: a hard JPEG re-compression, any resize, and a screenshot at a non-integer scale all " +
      "erase the same structure. It says only that this sample cannot show you a demosaic — not that there never was one."
    );
  }
  return (
    `A 2x2 structure is present on the ${channel} channel, spread ${strength} across the four positions ` +
    `(${phases.map((p) => p.toFixed(3)).join(", ")}). That four-phase pattern is what interpolating three quarters of a channel from its ` +
    "neighbours leaves behind, so this sample is consistent with having been demosaiced from a colour-filter array — i.e. with having come " +
    "off a real sensor. It is consistent with, not proof of: a picture rendered from a demosaiced source, or one deliberately given the " +
    "pattern, would read the same. It also does not say WHICH sensor."
  );
}

function gapReading(comb: boolean, spacing: number | null, undecidable: boolean, empty: { r: number; g: number; b: number }): string {
  if (undecidable) {
    return (
      "Too few distinct levels are present in this sample for the question to be asked. A flat subject, a small patch or a heavy " +
      "compression all leave a sparse histogram that looks like a stretch and is not one, so nothing is claimed either way."
    );
  }
  if (!comb) {
    return (
      `The occupied levels run continuously (${empty.r}, ${empty.g}, ${empty.b} empty levels inside the occupied range for R, G, B), with no regular ` +
      "spacing between them. That is what a picture written once by a camera looks like. It does not rule out an edit — a re-compression after " +
      "an edit fills the holes back in — it only says this histogram carries no comb."
    );
  }
  return (
    `The surviving levels are evenly spaced about ${spacing} apart, with ${empty.r}, ${empty.g}, ${empty.b} empty levels inside the occupied range for R, G, B. ` +
    "Regularly spaced holes in an 8-bit histogram are what stretching brightness or contrast after capture leaves behind: the levels are pulled " +
    "apart and nothing lands between them. What this does not tell you is who stretched it, by how much, or whether it was a gallery app's " +
    "auto-enhance rather than a person."
  );
}

function fieldReading(falloff: number, centreNoise: number, cornerNoise: number[]): string {
  const evenness = centreNoise > 0 ? round(median(cornerNoise) / centreNoise, 3) : null;
  const direction =
    falloff < 0.92
      ? `The corners are ${((1 - falloff) * 100).toFixed(1)}% darker than the centre, which is the ordinary direction for a lens and is only partly corrected on most phones.`
      : falloff > 1.08
        ? `The corners are BRIGHTER than the centre by ${((falloff - 1) * 100).toFixed(1)}%, which a lens does not do on its own — that is shading correction overshooting, or a subject that is simply brighter at the edges.`
        : "The corners and the centre are within a few percent of each other, which on a phone means the shading correction is doing its job rather than that the lens is perfect.";
  return (
    `${direction} Corner-to-centre luma ratio ${falloff}. ` +
    (evenness == null
      ? "The centre carried no measurable noise floor, so evenness across the frame could not be compared."
      : `The noise floor in the corners sits at ${evenness}× the centre's; well above 1 is what heavy corner amplification looks like.`) +
    " Both figures move with the subject as well as the lens: they are strongest as a comparison between two photographs from the same camera, and weakest as a statement about one photograph on its own."
  );
}

/**
 * Median absolute Laplacian of one channel inside one rectangle.
 *
 * Sub-sampled on a stride so the cost does not scale with the patch, and taken
 * on the interior only so the rectangle's own edges never enter the figure.
 */
function laplacianMedian(data: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number, channel: number, stride: number): number {
  const values: number[] = [];
  for (let y = y0 + 1; y < y1 - 1; y += stride) {
    for (let x = x0 + 1; x < x1 - 1; x += stride) {
      const at = (y * width + x) * 4 + channel;
      const up = ((y - 1) * width + x) * 4 + channel;
      const down = ((y + 1) * width + x) * 4 + channel;
      const left = (y * width + x - 1) * 4 + channel;
      const right = (y * width + x + 1) * 4 + channel;
      values.push(Math.abs(4 * data[at] - data[up] - data[down] - data[left] - data[right]));
    }
  }
  return median(values);
}

/** Same, on luma rather than one channel. */
function lumaLaplacianMedian(luma: Float32Array, width: number, x0: number, y0: number, x1: number, y1: number, stride: number): number {
  const values: number[] = [];
  for (let y = y0 + 1; y < y1 - 1; y += stride) {
    for (let x = x0 + 1; x < x1 - 1; x += stride) {
      const at = y * width + x;
      values.push(Math.abs(4 * luma[at] - luma[at - width] - luma[at + width] - luma[at - 1] - luma[at + 1]));
    }
  }
  return median(values);
}

/**
 * Finds the flattest tiles and measures the noise floor inside them.
 *
 * "Flattest" is by luma variance, so a tile of sky or wall wins and a tile of
 * text or foliage loses. The quietest quarter is used, with a floor of four
 * tiles so a small sample still produces a figure rather than an empty one.
 */
function flatNoise(data: Uint8ClampedArray, luma: Float32Array, width: number, height: number): FlatNoise {
  const tilesX = Math.max(1, Math.floor(width / FLAT_TILE));
  const tilesY = Math.max(1, Math.floor(height / FLAT_TILE));
  const tiles: { x0: number; y0: number; x1: number; y1: number; variance: number }[] = [];
  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      const x0 = tx * FLAT_TILE;
      const y0 = ty * FLAT_TILE;
      const x1 = Math.min(width, x0 + FLAT_TILE);
      const y1 = Math.min(height, y0 + FLAT_TILE);
      let sum = 0;
      let sumSq = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const v = luma[y * width + x];
          sum += v;
          sumSq += v * v;
          count += 1;
        }
      }
      const mean = count > 0 ? sum / count : 0;
      tiles.push({ x0, y0, x1, y1, variance: count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0 });
    }
  }
  tiles.sort((a, b) => a.variance - b.variance);
  const take = Math.max(1, Math.min(tiles.length, Math.max(4, Math.round(tiles.length / 4))));
  const chosen = tiles.slice(0, take);

  const collect = (channel: number): number => {
    const values: number[] = [];
    for (const tile of chosen) {
      const value = laplacianMedian(data, width, tile.x0, tile.y0, tile.x1, tile.y1, channel, 1);
      values.push(value);
    }
    return round(median(values), 3);
  };
  const lumaValues: number[] = [];
  for (const tile of chosen) lumaValues.push(lumaLaplacianMedian(luma, width, tile.x0, tile.y0, tile.x1, tile.y1, 1));

  const r = collect(0);
  const g = collect(1);
  const b = collect(2);
  return {
    r,
    g,
    b,
    luma: round(median(lumaValues), 3),
    tiles: chosen.length,
    ofTiles: tiles.length,
    chromaRatio: g > 0 ? round((r + b) / 2 / g, 3) : null,
  };
}

/**
 * Measures the 2x2 colour-filter structure.
 *
 * The high-frequency residual at each pixel — its value minus the average of
 * its four neighbours — is grouped by the pixel's position within the 2x2 tile.
 * A demosaiced picture puts systematically different interpolation error at
 * different positions; a rendered or rescaled one does not.
 *
 * All three channels are measured and the strongest is reported, because which
 * one carries the structure depends on the filter pattern and on what the
 * pipeline did afterwards.
 */
export function measureCfa(data: Uint8ClampedArray, width: number, height: number): CfaReport {
  const edge = Math.min(CFA_EDGE, width, height);
  // An even origin. The 2x2 phase is only meaningful relative to the original
  // frame, and an odd offset would rotate every phase by one for no reason.
  const x0 = Math.max(0, Math.floor((width - edge) / 2 / 2) * 2);
  const y0 = Math.max(0, Math.floor((height - edge) / 2 / 2) * 2);

  const forChannel = (channel: number): { phases: number[]; strength: number } => {
    const sums = new Array<number>(4).fill(0);
    const counts = new Array<number>(4).fill(0);
    for (let y = y0 + 1; y < y0 + edge - 1; y += 1) {
      for (let x = x0 + 1; x < x0 + edge - 1; x += 1) {
        const at = (y * width + x) * 4 + channel;
        const neighbours =
          (data[((y - 1) * width + x) * 4 + channel] +
            data[((y + 1) * width + x) * 4 + channel] +
            data[(y * width + x - 1) * 4 + channel] +
            data[(y * width + x + 1) * 4 + channel]) /
          4;
        const slot = (y % 2) * 2 + (x % 2);
        sums[slot] += Math.abs(data[at] - neighbours);
        counts[slot] += 1;
      }
    }
    const phases = sums.map((sum, i) => (counts[i] > 0 ? round(sum / counts[i], 4) : 0));
    const mean = phases.reduce((a, b) => a + b, 0) / 4;
    if (mean <= 0) return { phases, strength: 0 };
    const strength = round((Math.max(...phases) - Math.min(...phases)) / mean, 4);
    return { phases, strength };
  };

  const measured: { channel: CfaReport["channel"]; phases: number[]; strength: number }[] = [
    { channel: "red", ...forChannel(0) },
    { channel: "green", ...forChannel(1) },
    { channel: "blue", ...forChannel(2) },
  ];
  const best = measured.reduce((a, b) => (b.strength > a.strength ? b : a));
  const present = best.strength >= CFA_FLOOR;
  return {
    phases: best.phases,
    channel: best.channel,
    strength: best.strength,
    present,
    reading: cfaReading(present, best.strength, best.channel, best.phases),
  };
}

/**
 * Looks for the comb a post-capture tone stretch leaves in the histogram.
 *
 * Only the levels inside the occupied range count: a picture that never reaches
 * pure white has 40 empty levels at the top, and calling those a gap would flag
 * every indoor photograph ever taken.
 */
export function measureGaps(histR: Uint32Array, histG: Uint32Array, histB: Uint32Array): GapReport {
  const analyse = (hist: Uint32Array): { levels: number; empty: number; spacings: number[] } => {
    const occupied: number[] = [];
    for (let i = 0; i < 256; i += 1) if (hist[i] > 0) occupied.push(i);
    if (occupied.length < 2) return { levels: occupied.length, empty: 0, spacings: [] };
    const empty = occupied[occupied.length - 1] - occupied[0] + 1 - occupied.length;
    const spacings: number[] = [];
    for (let i = 1; i < occupied.length; i += 1) spacings.push(occupied[i] - occupied[i - 1]);
    return { levels: occupied.length, empty, spacings };
  };

  const r = analyse(histR);
  const g = analyse(histG);
  const b = analyse(histB);
  const levels = { r: r.levels, g: g.levels, b: b.levels };
  const empty = { r: r.empty, g: g.empty, b: b.empty };

  const undecidable = Math.max(r.levels, g.levels, b.levels) < GAP_MIN_LEVELS;
  if (undecidable) {
    return { levels, empty, comb: false, spacing: null, undecidable: true, reading: gapReading(false, null, true, empty) };
  }

  // A comb needs holes AND regularity. Holes alone are what a sparse subject
  // gives you; regularity alone is what an unstretched picture gives you.
  let comb = false;
  let spacing: number | null = null;
  for (const channel of [r, g, b]) {
    if (channel.spacings.length < 8 || channel.empty < 8) continue;
    const mean = channel.spacings.reduce((a, c) => a + c, 0) / channel.spacings.length;
    if (mean <= 1.15) continue;
    const variance = channel.spacings.reduce((a, c) => a + (c - mean) ** 2, 0) / channel.spacings.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv < 0.35) {
      comb = true;
      spacing = round(mean, 2);
      break;
    }
  }
  return { levels, empty, comb, spacing, undecidable: false, reading: gapReading(comb, spacing, false, empty) };
}

/** Measures a decoded sample. Exposed separately so the arithmetic is testable without a canvas. */
export function measureSample(data: Uint8ClampedArray, width: number, height: number): { grid: BlockGridReport; tone: ToneReport; cfa: CfaReport } {
  const luma = new Float32Array(width * height);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let clippedLow = 0;
  let clippedHigh = 0;
  let lowR = 0;
  let lowG = 0;
  let lowB = 0;
  let highR = 0;
  let highG = 0;
  let highB = 0;
  const histogram = new Array<number>(16).fill(0);
  const lumaSeen = new Uint8Array(256);
  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    histR[r] += 1;
    histG[g] += 1;
    histB[b] += 1;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    luma[p] = y;
    const yi = Math.min(255, Math.max(0, Math.round(y)));
    lumaSeen[yi] = 1;
    histogram[yi >> 4] += 1;
    if (r === 0 && g === 0 && b === 0) clippedLow += 1;
    if (r === 255 && g === 255 && b === 255) clippedHigh += 1;
    // Per channel as well as together: a blown sky clips blue long before it
    // clips all three, and the three-channel count reports it as nothing.
    if (r === 0) lowR += 1;
    if (g === 0) lowG += 1;
    if (b === 0) lowB += 1;
    if (r === 255) highR += 1;
    if (g === 255) highG += 1;
    if (b === 255) highB += 1;
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
      clippedLowR: round(lowR / pixels, 5),
      clippedLowG: round(lowG / pixels, 5),
      clippedLowB: round(lowB / pixels, 5),
      clippedHighR: round(highR / pixels, 5),
      clippedHighG: round(highG / pixels, 5),
      clippedHighB: round(highB / pixels, 5),
      histogram: histogram.map((count) => round(count / pixels, 5)),
      noise: round(median(laplacian), 3),
      flat: flatNoise(data, luma, width, height),
      distinctLuma: lumaSeen.reduce<number>((sum, seen) => sum + seen, 0),
      gaps: measureGaps(histR, histG, histB),
    },
    cfa: measureCfa(data, width, height),
  };
}

/** Mean luma and noise floor of one small patch. Used for the corner/centre comparison. */
export function measurePatch(data: Uint8ClampedArray, width: number, height: number): { meanLuma: number; noise: number } {
  const luma = new Float32Array(width * height);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    luma[p] = y;
    sum += y;
  }
  return {
    meanLuma: round(sum / (width * height), 2),
    noise: round(lumaLaplacianMedian(luma, width, 0, 0, width, height, 1), 3),
  };
}

/** A 1x1 PNG, used only to ask the decoder what options it understands. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function tinyBlob(): Blob | null {
  try {
    const binary = atob(TINY_PNG);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  } catch {
    return null;
  }
}

let decodeSupport: Promise<{ orientation: boolean | null; colour: boolean | null }> | null = null;

/**
 * Asks the browser which decode options it actually understands.
 *
 * There is no flag to read, so this uses the one behaviour the specification
 * guarantees: an options bag member that the browser knows and whose value is
 * not a legal one throws a TypeError, and a member it has never heard of is
 * ignored in silence. A throw therefore means the option is real and this pass
 * is measuring the stored picture; a clean resolve means the option went
 * nowhere and the browser rotated or converted the picture regardless.
 *
 * Anything else — a browser that throws something other than a TypeError, or no
 * decoder at all — returns null, which is recorded as "not established" and
 * never as either answer.
 */
async function probeDecodeSupport(): Promise<{ orientation: boolean | null; colour: boolean | null }> {
  const blob = tinyBlob();
  if (blob == null || typeof createImageBitmap !== "function") return { orientation: null, colour: null };
  const recognises = async (key: "imageOrientation" | "colorSpaceConversion"): Promise<boolean | null> => {
    try {
      const bitmap = await createImageBitmap(blob, { [key]: "deep-probe-not-a-value" } as unknown as ImageBitmapOptions);
      bitmap.close();
      return false;
    } catch (err) {
      return err instanceof TypeError ? true : null;
    }
  };
  const [orientation, colour] = await Promise.all([recognises("imageOrientation"), recognises("colorSpaceConversion")]);
  return { orientation, colour };
}

/** Cached, because the answer is a property of the browser and every capture asks. */
function decodeSupportOnce(): Promise<{ orientation: boolean | null; colour: boolean | null }> {
  decodeSupport ??= probeDecodeSupport();
  return decodeSupport;
}

/** Test seam. Clears the cached answer so a fresh probe runs. */
export function resetDecodeSupport(): void {
  decodeSupport = null;
}

function decodeNote(support: { orientation: boolean | null; colour: boolean | null }, colourSpace: string | null): string {
  const parts: string[] = [];
  if (support.orientation === true) {
    parts.push(
      "The decoder was told not to apply EXIF orientation and understands that instruction, so every measurement below was taken on the picture AS STORED."
    );
  } else if (support.orientation === false) {
    parts.push(
      "This browser does not understand being told to skip EXIF orientation, so if the file carries a rotation tag the picture was TURNED before it was measured. " +
        "That matters: a quarter turn swaps the block grid's two axes, so an across-phase here may really be a down-phase in the stored file. Read the grid's axes with that in mind."
    );
  } else {
    parts.push("Whether this browser applied EXIF orientation before the measurement could not be established, so the frame's stored rotation is unknown ground.");
  }
  if (support.colour === true) {
    parts.push("It was also told not to convert colour, and understands that, so the channel figures are the file's own numbers.");
  } else if (support.colour === false) {
    parts.push(
      "It does not understand being told to skip colour conversion, so a wide-gamut photo may have been flattened to the display profile on the way in. " +
        "The channel means and balance below are then partly the browser's arithmetic rather than the camera's."
    );
  } else {
    parts.push("Whether colour was converted on the way in could not be established.");
  }
  parts.push(colourSpace != null ? `The pixels were read in the ${colourSpace} space.` : "The browser did not name the space the pixels were read in.");
  return parts.join(" ");
}

/**
 * Decodes a bounded square from the middle of a capture and measures it, then
 * samples the four corners for the falloff comparison.
 *
 * The centre carries the detailed measurements because vignetting and lens
 * correction distort the edges, and both would otherwise show up in the channel
 * balance as something the sensor did. The corners are then measured separately
 * and ON PURPOSE, because that distortion is itself a device trait.
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
    const support = await decodeSupportOnce();
    // Asked for unconditionally. A browser that does not know these members
    // ignores them, which is exactly the case `support` records — so the ask is
    // free and the report never claims an instruction was obeyed.
    const options = { imageOrientation: "none", colorSpaceConversion: "none", premultiplyAlpha: "none" } as unknown as ImageBitmapOptions;
    try {
      bitmap = await createImageBitmap(blob, options);
    } catch {
      bitmap = await createImageBitmap(blob);
    }
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
    // exists to detect, and the app would then be measuring its own crop. Eight
    // is even, so the 2x2 colour-filter phase survives the crop as well.
    const x = Math.floor((bitmap.width - width) / 2 / 8) * 8;
    const y = Math.floor((bitmap.height - height) / 2 / 8) * 8;

    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { report: null, reason: "No 2D drawing context was available, so no picture in this run could be sampled.", environmental: true };
    context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const colourSpace = (image as ImageData & { colorSpace?: string }).colorSpace ?? null;
    const measured = measureSample(image.data, width, height);
    const field = measureField(bitmap, canvas, context);

    const notes: string[] = [
      "Channel means, the ratios and the histogram are SCENE-DEPENDENT: they describe what the lens was pointed at as much as the pipeline behind it. Compare them between photographs of the same scene; comparing them across different scenes proves nothing.",
      `Measured on a ${width}×${height} sample from the centre of the picture, taken at an exact 8-pixel offset (${x}, ${y}) so the sampling itself cannot create the misalignment the grid test looks for, and so the 2x2 colour-filter phase is the file's own rather than the crop's.`,
      "The flat-region noise floor is measured only in the quietest tiles of the sample, which removes most of the subject from it. It is still not scene-free — a picture with no flat area anywhere has no quiet tiles to find.",
    ];

    return {
      report: {
        sample: { x, y, width, height, ofWidth: bitmap.width, ofHeight: bitmap.height },
        ...measured,
        field,
        decode: {
          storedOrientation: support.orientation,
          storedColour: support.colour,
          colourSpace,
          note: decodeNote(support, colourSpace),
        },
        notes,
      },
      reason: null,
      environmental: false,
    };
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

/**
 * Samples the centre and the four corners for the falloff comparison.
 *
 * Reuses the caller's canvas one patch at a time rather than allocating five,
 * because five more canvases per capture across two hundred captures is the
 * memory problem this module already fought once.
 *
 * Returns null when the picture is too small to hold five patches that do not
 * overlap — a measurement of a patch against itself is not a measurement.
 */
function measureField(bitmap: ImageBitmap, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): FieldReport | null {
  const patch = FIELD_PATCH;
  if (bitmap.width < patch * 3 || bitmap.height < patch * 3) return null;
  const inset = Math.round(patch / 2);
  const spots: { x: number; y: number }[] = [
    { x: Math.floor((bitmap.width - patch) / 2), y: Math.floor((bitmap.height - patch) / 2) },
    { x: inset, y: inset },
    { x: bitmap.width - patch - inset, y: inset },
    { x: inset, y: bitmap.height - patch - inset },
    { x: bitmap.width - patch - inset, y: bitmap.height - patch - inset },
  ];

  const previousWidth = canvas.width;
  const previousHeight = canvas.height;
  canvas.width = patch;
  canvas.height = patch;
  const measurements: { meanLuma: number; noise: number }[] = [];
  try {
    for (const spot of spots) {
      context.clearRect(0, 0, patch, patch);
      context.drawImage(bitmap, spot.x, spot.y, patch, patch, 0, 0, patch, patch);
      const data = context.getImageData(0, 0, patch, patch);
      measurements.push(measurePatch(data.data, patch, patch));
    }
  } catch {
    return null;
  } finally {
    canvas.width = previousWidth;
    canvas.height = previousHeight;
  }

  const centre = measurements[0];
  const corners = measurements.slice(1);
  const cornerLuma = corners.map((m) => m.meanLuma);
  const cornerNoise = corners.map((m) => m.noise);
  const meanCorner = cornerLuma.reduce((a, b) => a + b, 0) / cornerLuma.length;
  const falloff = centre.meanLuma > 0 ? round(meanCorner / centre.meanLuma, 3) : 0;
  return {
    patch,
    centreLuma: centre.meanLuma,
    cornerLuma,
    falloff,
    centreNoise: centre.noise,
    cornerNoise,
    reading: fieldReading(falloff, centre.noise, cornerNoise),
  };
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
    "  HOW THE PICTURE WAS DECODED",
    `    stored rotation   ${report.decode.storedOrientation === true ? "kept — measured as stored" : report.decode.storedOrientation === false ? "NOT kept — the browser may have turned it first" : "not established"}`,
    `    colour conversion ${report.decode.storedColour === true ? "suppressed — the file's own numbers" : report.decode.storedColour === false ? "NOT suppressed — the browser may have converted first" : "not established"}`,
    `    colour space      ${report.decode.colourSpace ?? "not named by the browser"}`,
    `    ${report.decode.note}`,
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
    "  2x2 COLOUR-FILTER RHYTHM",
    `    channel           ${report.cfa.channel}`,
    `    phase energies    ${report.cfa.phases.map((p) => p.toFixed(3)).join("  ")}`,
    `    spread            ${report.cfa.strength}`,
    `    ${report.cfa.reading}`
  );
  if (selfEncoded) {
    lines.push(
      "",
      "    NOTE: this frame came off a video track, which is chroma-subsampled and re-encoded before this app",
      "    ever touched it. Whatever demosaic structure the sensor left has been through two more codecs since,",
      "    so neither its presence nor its absence here says anything about the camera."
    );
  }
  lines.push(
    "",
    "  SENSOR PIPELINE",
    `    channel means     R ${report.tone.meanR}  G ${report.tone.meanG}  B ${report.tone.meanB}`,
    `    balance           R/G ${report.tone.ratioRG}  B/G ${report.tone.ratioBG}`,
    `    clipped (all 3)   ${(report.tone.clippedLow * 100).toFixed(3)}% pure black, ${(report.tone.clippedHigh * 100).toFixed(3)}% pure white`,
    `    clipped low       R ${(report.tone.clippedLowR * 100).toFixed(3)}%  G ${(report.tone.clippedLowG * 100).toFixed(3)}%  B ${(report.tone.clippedLowB * 100).toFixed(3)}%`,
    `    clipped high      R ${(report.tone.clippedHighR * 100).toFixed(3)}%  G ${(report.tone.clippedHighG * 100).toFixed(3)}%  B ${(report.tone.clippedHighB * 100).toFixed(3)}%`,
    `    detail floor      ${report.tone.noise} (median absolute Laplacian across the whole sample — scene as much as sensor)`,
    `    noise floor       R ${report.tone.flat.r}  G ${report.tone.flat.g}  B ${report.tone.flat.b}  luma ${report.tone.flat.luma}`,
    `                      measured in the ${report.tone.flat.tiles} flattest of ${report.tone.flat.ofTiles} tiles`,
    `    chroma over green ${report.tone.flat.chromaRatio ?? "green floor was zero, so the ratio is undefined"}`,
    `    distinct luma     ${report.tone.distinctLuma} of 256`,
    `    tone histogram    ${report.tone.histogram.map((v) => v.toFixed(3)).join(" ")}`,
    "",
    "  TONE RANGE",
    `    levels present    R ${report.tone.gaps.levels.r}  G ${report.tone.gaps.levels.g}  B ${report.tone.gaps.levels.b} of 256`,
    `    empty inside      R ${report.tone.gaps.empty.r}  G ${report.tone.gaps.empty.g}  B ${report.tone.gaps.empty.b}`,
    `    comb              ${report.tone.gaps.comb ? `yes, spacing ${report.tone.gaps.spacing}` : report.tone.gaps.undecidable ? "not decidable from this sample" : "no"}`,
    `    ${report.tone.gaps.reading}`
  );
  if (report.field) {
    lines.push(
      "",
      "  ACROSS THE FRAME",
      `    patch             ${report.field.patch}×${report.field.patch} at the centre and each corner`,
      `    centre luma       ${report.field.centreLuma}`,
      `    corner luma       ${report.field.cornerLuma.join("  ")} (top-left, top-right, bottom-left, bottom-right)`,
      `    falloff           ${report.field.falloff}`,
      `    centre noise      ${report.field.centreNoise}`,
      `    corner noise      ${report.field.cornerNoise.join("  ")}`,
      `    ${report.field.reading}`
    );
  } else {
    lines.push("", "  ACROSS THE FRAME", "    Not measured: the picture is too small to hold five patches that do not overlap each other.");
  }
  lines.push("");
  for (const note of report.notes) lines.push(`  ${note}`);
  return lines;
}
