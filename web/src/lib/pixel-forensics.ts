/**
 * On-device pixel forensics: screen-replay (recapture) detection, noise/texture
 * statistics, document tamper analysis, and temporal video-frame comparison.
 * Everything runs in canvas — no uploads.
 */

import {
  analyzeRefreshBanding,
  analyzeScreenLattice,
  type BandingResult,
  type ScreenLatticeResult,
} from "./screen-lattice";
import { cropDocument, locateDocument, type DocumentLocation } from "./document-locate";
import { resolveThreshold, type ResolvedThreshold } from "./thresholds";

export type ScreenSignal = {
  id: string;
  label: string;
  /** Raw measured value, or null when the measurement could not be taken. */
  value: number | null;
  /** Registry id so the report can cite where the threshold came from. */
  thresholdId: string;
  threshold: ResolvedThreshold | null;
  triggered: "strong" | "weak" | "no" | "unassessable";
  detail: string;
};

export type ScreenReplayResult = {
  /** 0..1 — combined evidence that this frame shows a display being re-photographed. */
  score: number;
  /**
   * - `likely`        two independent signals agree → scored
   * - `single-signal` one signal fired with no corroboration → reported, never scored
   * - `none`          measured, nothing fired
   * - `unassessable`  the image is too small/flat for the measurement to mean anything
   */
  verdict: "none" | "single-signal" | "likely" | "unassessable";
  signals: ScreenSignal[];
  /** Why this verdict was reached, in plain language. */
  rationale: string;
  lattice: ScreenLatticeResult | null;
  banding: BandingResult | null;
};

export type PixelMetrics = {
  width: number;
  height: number;
  gridPeriodicity: number;
  gridPeriodLag: number | null;
  bandingScore: number;
  bandingLag: number | null;
  glareFraction: number;
  glareBlobFraction: number;
  coolCast: number;
  meanLuma: number;
  noiseStd: number;
  flatBlockCount: number;
  edgeDensity: number;
};

export type DocumentPixelAnalysis = {
  /** Geometric localization result — replaces the old bright-pixel guess. */
  location: DocumentLocation;
  looksLikeDocument: boolean;
  /** Bright-pixel share INSIDE the located document. Informational only. */
  brightFraction: number;
  textBlockCount: number;
  backgroundBlockCount: number;
  backgroundUniformity: number;
  /** ELA energy of text regions relative to blank paper, measured inside the document only. */
  textTamperRatio: number | null;
  /** Regular periodic pattern inside the document (print screening or a display lattice). */
  periodic: { periodPx: number | null; prominence: number } | null;
  /** Hasler–Süsstrunk colorfulness of the document itself. */
  colorfulness: number;
  /** Pixel size of the crop that was actually analysed. */
  cropWidth: number;
  cropHeight: number;
};

export type TemporalMetrics = {
  frames: number;
  meanFrameDiff: number;
  diffJumpiness: number;
  lumaFlicker: number;
  avgNoiseStd: number;
  staticFrameRatio: number;
};

function toCanvas(source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, maxEdge: number): HTMLCanvasElement | null {
  const srcW =
    source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const srcH =
    source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!srcW || !srcH) return null;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.max(16, Math.round(srcW * scale));
  const h = Math.max(16, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

function decodeBlob(blob: Blob): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Normalized autocorrelation peak of a 1D signal within a lag window. */
export function autocorrelationPeak(signal: number[], minLag: number, maxLag: number): { lag: number | null; strength: number } {
  const n = signal.length;
  if (n < minLag * 3) return { lag: null, strength: 0 };
  const mean = signal.reduce((a, v) => a + v, 0) / n;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = signal[i] - mean;
  let denom = 0;
  for (let i = 0; i < n; i++) denom += s[i] * s[i];
  denom += 1e-9;
  let bestLag: number | null = null;
  let best = 0;
  const cap = Math.min(maxLag, n - 2);
  for (let lag = minLag; lag <= cap; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += s[i] * s[i + lag];
    const norm = acc / denom;
    if (norm > best) {
      best = norm;
      bestLag = lag;
    }
  }
  return { lag: bestLag, strength: Math.max(0, best) };
}

type GrayData = { lum: Float32Array; r: Float32Array; g: Float32Array; b: Float32Array; w: number; h: number };

function grayData(canvas: HTMLCanvasElement): GrayData | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    r[p] = data[i];
    g[p] = data[i + 1];
    b[p] = data[i + 2];
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { lum, r, g, b, w, h };
}

/** Hasler–Süsstrunk colorfulness metric: sqrt(σ²rg+σ²yb) + 0.3·sqrt(µ²rg+µ²yb). */
function computeColorfulness(gd: GrayData): number {
  const n = gd.lum.length;
  if (n === 0) return 0;
  let rgSum = 0;
  let rgSq = 0;
  let ybSum = 0;
  let ybSq = 0;
  for (let p = 0; p < n; p++) {
    const rg = gd.r[p] - gd.g[p];
    const yb = (gd.r[p] + gd.g[p]) / 2 - gd.b[p];
    rgSum += rg;
    rgSq += rg * rg;
    ybSum += yb;
    ybSq += yb * yb;
  }
  const rgMean = rgSum / n;
  const ybMean = ybSum / n;
  const rgStd = Math.sqrt(Math.max(0, rgSq / n - rgMean * rgMean));
  const ybStd = Math.sqrt(Math.max(0, ybSq / n - ybMean * ybMean));
  return Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean);
}

/**
 * Computes screen-replay and texture statistics for a decoded frame.
 * Uses up to a 900px working copy to preserve moiré/grid frequencies.
 */
export function computePixelMetricsFromCanvas(canvas: HTMLCanvasElement): PixelMetrics | null {
  const g = grayData(canvas);
  if (!g) return null;
  const { lum, r, b, w, h } = g;

  const colHp = new Array<number>(w).fill(0);
  for (let x = 1; x < w; x++) {
    let acc = 0;
    for (let y = 0; y < h; y++) acc += Math.abs(lum[y * w + x] - lum[y * w + x - 1]);
    colHp[x] = acc / h;
  }
  const rowHp = new Array<number>(h).fill(0);
  for (let y = 1; y < h; y++) {
    let acc = 0;
    for (let x = 0; x < w; x++) acc += Math.abs(lum[y * w + x] - lum[(y - 1) * w + x]);
    rowHp[y] = acc / w;
  }
  const colPeak = autocorrelationPeak(colHp.slice(1), 2, 24);
  const rowPeak = autocorrelationPeak(rowHp.slice(1), 2, 24);
  const gridPeriodicity = Math.max(colPeak.strength, rowPeak.strength);
  const gridPeriodLag = colPeak.strength >= rowPeak.strength ? colPeak.lag : rowPeak.lag;

  const rowMeans = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = 0; x < w; x++) acc += lum[y * w + x];
    rowMeans[y] = acc / w;
  }
  const detrended = rowMeans.map((v, i) => {
    const lo = Math.max(0, i - 6);
    const hi = Math.min(h - 1, i + 6);
    let acc = 0;
    for (let k = lo; k <= hi; k++) acc += rowMeans[k];
    return v - acc / (hi - lo + 1);
  });
  const bandPeak = autocorrelationPeak(detrended, 4, Math.min(80, Math.floor(h / 3)));

  let brightCount = 0;
  let lumSum = 0;
  let rSum = 0;
  let bSum = 0;
  for (let p = 0; p < lum.length; p++) {
    lumSum += lum[p];
    rSum += r[p];
    bSum += b[p];
    if (lum[p] > 250) brightCount++;
  }
  const glareFraction = brightCount / lum.length;
  const meanLuma = lumSum / lum.length;
  const coolCast = bSum / lum.length - rSum / lum.length;

  const cell = 16;
  const cellsX = Math.floor(w / cell);
  const cellsY = Math.floor(h / cell);
  const brightCells: boolean[] = new Array(cellsX * cellsY).fill(false);
  let brightCellCount = 0;
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      let cnt = 0;
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        for (let x = cx * cell; x < (cx + 1) * cell; x++) {
          if (lum[y * w + x] > 250) cnt++;
        }
      }
      if (cnt > cell * cell * 0.5) {
        brightCells[cy * cellsX + cx] = true;
        brightCellCount++;
      }
    }
  }
  let largestBlob = 0;
  if (brightCellCount > 0) {
    const visited = new Array<boolean>(brightCells.length).fill(false);
    for (let i = 0; i < brightCells.length; i++) {
      if (!brightCells[i] || visited[i]) continue;
      let size = 0;
      const stack = [i];
      visited[i] = true;
      while (stack.length) {
        const cur = stack.pop() as number;
        size++;
        const cx = cur % cellsX;
        const cy = Math.floor(cur / cellsX);
        const neighbors = [
          cx > 0 ? cur - 1 : -1,
          cx < cellsX - 1 ? cur + 1 : -1,
          cy > 0 ? cur - cellsX : -1,
          cy < cellsY - 1 ? cur + cellsX : -1,
        ];
        for (const nb of neighbors) {
          if (nb >= 0 && brightCells[nb] && !visited[nb]) {
            visited[nb] = true;
            stack.push(nb);
          }
        }
      }
      largestBlob = Math.max(largestBlob, size);
    }
  }
  const glareBlobFraction = brightCellCount > 0 ? largestBlob / brightCellCount : 0;

  const block = 16;
  const flatNoises: number[] = [];
  let edgeSum = 0;
  let edgeBlocks = 0;
  for (let by = 0; by + block <= h; by += block) {
    for (let bx = 0; bx + block <= w; bx += block) {
      let edgeEnergy = 0;
      let lapAbs = 0;
      let count = 0;
      for (let y = by + 1; y < by + block - 1; y++) {
        for (let x = bx + 1; x < bx + block - 1; x++) {
          const c = lum[y * w + x];
          const gx = Math.abs(lum[y * w + x + 1] - lum[y * w + x - 1]);
          const gy = Math.abs(lum[(y + 1) * w + x] - lum[(y - 1) * w + x]);
          edgeEnergy += gx + gy;
          const lap = 4 * c - lum[y * w + x + 1] - lum[y * w + x - 1] - lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
          lapAbs += Math.abs(lap);
          count++;
        }
      }
      const meanEdge = edgeEnergy / count;
      edgeSum += meanEdge;
      edgeBlocks++;
      if (meanEdge < 6) flatNoises.push(lapAbs / count);
    }
  }
  flatNoises.sort((a, c) => a - c);
  const noiseStd = flatNoises.length > 0 ? flatNoises[Math.floor(flatNoises.length / 2)] : 0;

  return {
    width: w,
    height: h,
    gridPeriodicity: Math.round(gridPeriodicity * 1000) / 1000,
    gridPeriodLag,
    bandingScore: Math.round(bandPeak.strength * 1000) / 1000,
    bandingLag: bandPeak.lag,
    glareFraction: Math.round(glareFraction * 10000) / 10000,
    glareBlobFraction: Math.round(glareBlobFraction * 100) / 100,
    coolCast: Math.round(coolCast * 10) / 10,
    meanLuma: Math.round(meanLuma * 10) / 10,
    noiseStd: Math.round(noiseStd * 100) / 100,
    flatBlockCount: flatNoises.length,
    edgeDensity: edgeBlocks > 0 ? Math.round((edgeSum / edgeBlocks) * 10) / 10 : 0,
  };
}

export async function computePixelMetrics(blob: Blob): Promise<PixelMetrics | null> {
  const img = await decodeBlob(blob);
  if (!img) return null;
  const canvas = toCanvas(img, 900);
  if (!canvas) return null;
  return computePixelMetricsFromCanvas(canvas);
}

type Overrides = Map<string, { warnAt: number | null; failAt: number | null; source: string }>;

function gradeSignal(
  id: string,
  label: string,
  value: number | null,
  thresholdId: string,
  detail: string,
  overrides?: Overrides
): ScreenSignal {
  const threshold = resolveThreshold(thresholdId, overrides);
  if (value == null || !threshold) {
    return { id, label, value, thresholdId, threshold, triggered: "unassessable", detail };
  }
  const above = threshold.direction === "above";
  const hit = (limit: number | null): boolean =>
    limit != null && (above ? value >= limit : value <= limit);
  const triggered: ScreenSignal["triggered"] = hit(threshold.failAt) ? "strong" : hit(threshold.warnAt) ? "weak" : "no";
  return { id, label, value, thresholdId, threshold, triggered, detail };
}

/**
 * Screen-replay assessment from real spectral measurements.
 *
 * Two independent physical signals are measured: the display's spatial lattice
 * and its temporal refresh banding. A scoring verdict requires BOTH to agree —
 * one signal alone is reported as an unscored observation, because a single
 * sharp spatial frequency also occurs in fabric weave, window blinds and
 * security printing, and banding alone occurs under fluorescent lighting.
 */
export function assessScreenReplay(
  lattice: ScreenLatticeResult | null,
  banding: BandingResult | null,
  overrides?: Overrides
): ScreenReplayResult {
  const latticeDetail = lattice
    ? `Sharpest non-compression spatial peak stands ${lattice.prominence}× above the local noise floor at a period of ${lattice.x.periodPx ?? "?"}px horizontally / ${lattice.y.periodPx ?? "?"}px vertically, measured on ${lattice.tilesUsed} native-resolution tile(s) of a ${lattice.nativeWidth}×${lattice.nativeHeight} image. JPEG block periods (${lattice.excludedPeriods}) were excluded from the search.`
    : "Image is too small or too flat at native resolution for a display lattice to be measurable — no claim made.";
  const bandingDetail = banding
    ? `Periodic row-brightness oscillation stands ${banding.prominence}× above the noise floor with a period of ${banding.periodRows ?? "?"} rows across ${banding.rowsAnalysed} analysed rows.`
    : "Not enough image height to measure refresh banding — no claim made.";

  const signals: ScreenSignal[] = [
    gradeSignal("screen-lattice", "Display pixel lattice", lattice?.prominence ?? null, "screen.lattice.prominence", latticeDetail, overrides),
    gradeSignal("screen-banding", "Refresh banding", banding?.prominence ?? null, "screen.banding.prominence", bandingDetail, overrides),
  ];
  if (lattice) {
    signals.push(
      gradeSignal(
        "screen-axis-agreement",
        "Lattice axis agreement",
        lattice.periodRatio,
        "screen.lattice.periodRatio",
        lattice.periodRatio != null
          ? `Horizontal and vertical peak periods differ by a factor of ${lattice.periodRatio}. Display lattices are near-square (close to 1); incidental texture is not.`
          : "Only one axis produced a peak, so squareness could not be tested.",
        overrides
      )
    );
  }

  const scoringSignals = signals.filter((s) => s.threshold?.scoring === true);
  const primary = signals.filter((s) => s.id === "screen-lattice" || s.id === "screen-banding");
  const firedPrimary = primary.filter((s) => s.triggered === "strong" || s.triggered === "weak");
  const strongPrimary = primary.filter((s) => s.triggered === "strong");
  const allUnassessable = primary.every((s) => s.triggered === "unassessable");

  let verdict: ScreenReplayResult["verdict"];
  let rationale: string;
  if (allUnassessable) {
    verdict = "unassessable";
    rationale = "Neither the display lattice nor refresh banding could be measured on this image, so no screen-replay claim is made in either direction.";
  } else if (firedPrimary.length >= 2 && strongPrimary.length >= 1) {
    verdict = "likely";
    rationale = `Both independent screen signals fired (${firedPrimary.map((s) => s.label).join(" + ")}), at least one strongly. A spatial lattice and a temporal refresh pattern occurring together is specific to a photographed display.`;
  } else if (firedPrimary.length >= 1) {
    verdict = "single-signal";
    rationale = `Only ${firedPrimary.map((s) => s.label).join(" and ")} fired, with no corroborating second signal. One signal alone is not evidence of a screen — fabric weave, blinds, security printing and fluorescent lighting each produce one of these on genuine photos — so this is recorded without affecting the score.`;
  } else {
    verdict = "none";
    rationale = "Neither the display lattice nor refresh banding fired.";
  }
  if (scoringSignals.length === 0 && verdict === "likely") {
    // Thresholds still uncalibrated: report the agreement, do not score it.
    rationale += " Thresholds for these measurements are not yet calibrated on this device, so the finding is reported without a score deduction — run calibration to enable scoring.";
  }

  const score = verdict === "likely" ? 0.9 : verdict === "single-signal" ? 0.35 : 0;
  return { score, verdict, signals, rationale, lattice, banding };
}

/** Runs the lattice + banding measurements on a canvas and grades them. */
export function assessScreenReplayFromCanvas(canvas: HTMLCanvasElement, overrides?: Overrides): ScreenReplayResult {
  return assessScreenReplay(analyzeScreenLattice(canvas), analyzeRefreshBanding(canvas), overrides);
}

/** Runs the lattice + banding measurements on an original image at native resolution. */
export async function assessScreenReplayFromBlob(blob: Blob, overrides?: Overrides): Promise<ScreenReplayResult> {
  const img = await decodeBlob(blob);
  if (!img) return assessScreenReplay(null, null, overrides);
  const lattice = analyzeScreenLattice(img);
  // Banding survives moderate downscaling (its period is tens of rows), so a
  // capped canvas keeps memory sane on large phone photos.
  const bandingCanvas = toCanvas(img, 1440);
  const banding = bandingCanvas ? analyzeRefreshBanding(bandingCanvas) : null;
  return assessScreenReplay(lattice, banding, overrides);
}

/** Per-block ELA grid used for document text-tamper localization. */
async function elaBlockGrid(canvas: HTMLCanvasElement): Promise<{ blocks: Float64Array; edges: Float64Array; bx: number; by: number } | null> {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width: w, height: h } = canvas;
  const srcData = ctx.getImageData(0, 0, w, h);

  const resaved = await new Promise<Blob | null>((resolve) => canvas.toBlob((bb) => resolve(bb), "image/jpeg", 0.75));
  if (!resaved) return null;
  const resavedImg = await decodeBlob(resaved);
  if (!resavedImg) return null;
  const cmp = document.createElement("canvas");
  cmp.width = w;
  cmp.height = h;
  const cmpCtx = cmp.getContext("2d", { willReadFrequently: true });
  if (!cmpCtx) return null;
  cmpCtx.drawImage(resavedImg, 0, 0, w, h);
  const cmpData = cmpCtx.getImageData(0, 0, w, h);

  const block = 24;
  const bx = Math.floor(w / block);
  const by = Math.floor(h / block);
  const blocks = new Float64Array(bx * by);
  const edges = new Float64Array(bx * by);
  const a = srcData.data;
  const c = cmpData.data;
  for (let gy = 0; gy < by; gy++) {
    for (let gx = 0; gx < bx; gx++) {
      let diff = 0;
      let edge = 0;
      let count = 0;
      for (let y = gy * block + 1; y < (gy + 1) * block - 1; y++) {
        for (let x = gx * block + 1; x < (gx + 1) * block - 1; x++) {
          const i = (y * w + x) * 4;
          diff += Math.abs(a[i] - c[i]) + Math.abs(a[i + 1] - c[i + 1]) + Math.abs(a[i + 2] - c[i + 2]);
          const lumC = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
          const iR = (y * w + x + 1) * 4;
          const lumR = a[iR] * 0.299 + a[iR + 1] * 0.587 + a[iR + 2] * 0.114;
          edge += Math.abs(lumC - lumR);
          count++;
        }
      }
      blocks[gy * bx + gx] = diff / (count * 3);
      edges[gy * bx + gx] = edge / count;
    }
  }
  return { blocks, edges, bx, by };
}

/**
 * Document-focused pixel analysis.
 *
 * The document is first LOCATED geometrically, then every statistic is computed
 * inside that rectangle. Previously these numbers were averaged over the entire
 * frame, so the table, hand and background all contributed to "paper
 * uniformity" and "text tamper" — which made the results untrustworthy in both
 * directions.
 */
export async function analyzeDocumentPixels(blob: Blob): Promise<DocumentPixelAnalysis | null> {
  const img = await decodeBlob(blob);
  if (!img) return null;

  const location = locateDocument(img);
  // Analyse the located card when found; otherwise fall back to the whole frame
  // purely so the raw numbers still get reported (they are not scored in that case).
  const nativeCrop =
    location.found && location.quad ? cropDocument(img, location.quad, Math.min(location.quad.widthPx, 2400)) : null;
  const analysisCanvas = nativeCrop
    ? toCanvas(nativeCrop, 900)
    : toCanvas(img, 900);
  if (!analysisCanvas) return null;

  const g = grayData(analysisCanvas);
  if (!g) return null;
  const { lum } = g;

  let brightCount = 0;
  for (let p = 0; p < lum.length; p++) if (lum[p] > 195) brightCount++;
  const brightFraction = brightCount / lum.length;

  const grid = await elaBlockGrid(analysisCanvas);
  let textTamperRatio: number | null = null;
  let textBlockCount = 0;
  let backgroundBlockCount = 0;
  let backgroundUniformity = 0;
  if (grid) {
    const sortedEdges = Array.from(grid.edges).sort((a, b) => a - b);
    const edgeP70 = sortedEdges[Math.floor(sortedEdges.length * 0.7)] ?? 0;
    const textEla: number[] = [];
    const bgEla: number[] = [];
    for (let i = 0; i < grid.blocks.length; i++) {
      if (grid.edges[i] >= Math.max(edgeP70, 8)) textEla.push(grid.blocks[i]);
      else if (grid.edges[i] < 4) bgEla.push(grid.blocks[i]);
    }
    textBlockCount = textEla.length;
    backgroundBlockCount = bgEla.length;
    if (textEla.length >= 6 && bgEla.length >= 6) {
      const avg = (arr: number[]): number => arr.reduce((a, v) => a + v, 0) / arr.length;
      const textAvg = avg(textEla);
      const bgAvg = avg(bgEla);
      textTamperRatio = Math.round((textAvg / (bgAvg + 0.25)) * 100) / 100;
      const bgMean = avg(bgEla);
      const bgVar = bgEla.reduce((a, v) => a + (v - bgMean) * (v - bgMean), 0) / bgEla.length;
      backgroundUniformity = Math.round(Math.sqrt(bgVar) * 100) / 100;
    }
  }

  // Periodic ink/panel pattern, measured at the document's NATIVE resolution.
  // At 900px the screening frequency of a printed copy is below Nyquist and the
  // measurement is meaningless — which is why the old halftone number was noise.
  const periodicSource = nativeCrop ?? img;
  const periodicLattice = analyzeScreenLattice(periodicSource);
  const periodic = periodicLattice
    ? {
        periodPx: periodicLattice.x.periodPx ?? periodicLattice.y.periodPx,
        prominence: periodicLattice.prominence,
      }
    : null;

  return {
    location,
    looksLikeDocument: location.found,
    brightFraction: Math.round(brightFraction * 1000) / 1000,
    textBlockCount,
    backgroundBlockCount,
    backgroundUniformity,
    textTamperRatio,
    periodic,
    colorfulness: Math.round(computeColorfulness(g) * 10) / 10,
    cropWidth: analysisCanvas.width,
    cropHeight: analysisCanvas.height,
  };
}

/** Extracts evenly spaced frames from a video as canvases for pixel analysis. */
export async function extractFrameCanvases(blob: Blob, count: number, maxEdge: number): Promise<HTMLCanvasElement[]> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Video metadata load timed out")), 15000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Browser cannot decode this video"));
      };
    });
    if (!video.videoWidth || !video.videoHeight) throw new Error("No decodable video track");
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    // Dedupe targets: with an unknown duration every fraction collapses to the
    // same timestamp, and a seek to the current position may never fire
    // "seeked" — each identical target would stall until its 10s timeout.
    const targets = [...new Set(Array.from({ length: count }, (_, i) => (duration > 0 ? Math.max(0.05, duration * (0.06 + (0.88 * i) / Math.max(1, count - 1))) : 0.05)))];
    const frames: HTMLCanvasElement[] = [];
    for (const target of targets) {
      if (Math.abs(video.currentTime - target) > 0.01) {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error("Seek timed out")), 10000);
          const onSeeked = () => {
            window.clearTimeout(timeout);
            video.removeEventListener("seeked", onSeeked);
            resolve();
          };
          video.addEventListener("seeked", onSeeked);
          video.currentTime = target;
        });
      }
      const canvas = toCanvas(video, maxEdge);
      if (canvas) frames.push(canvas);
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}

/** Compares consecutive frames: identity drift, flicker, static ratio, texture. */
export function compareFrames(frames: HTMLCanvasElement[]): TemporalMetrics | null {
  if (frames.length < 2) return null;
  const grays: GrayData[] = [];
  for (const f of frames) {
    const g = grayData(f);
    if (!g) return null;
    grays.push(g);
  }
  const w = Math.min(...grays.map((g) => g.w));
  const h = Math.min(...grays.map((g) => g.h));
  const diffs: number[] = [];
  const lumas: number[] = [];
  let staticPairs = 0;
  for (let i = 0; i < grays.length; i++) {
    let lsum = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lsum += grays[i].lum[y * grays[i].w + x];
    lumas.push(lsum / (w * h));
  }
  for (let i = 1; i < grays.length; i++) {
    let acc = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        acc += Math.abs(grays[i].lum[y * grays[i].w + x] - grays[i - 1].lum[y * grays[i - 1].w + x]);
      }
    }
    const d = acc / ((w / 2) * (h / 2));
    diffs.push(d);
    if (d < 1.2) staticPairs++;
  }
  const meanDiff = diffs.reduce((a, v) => a + v, 0) / diffs.length;
  const diffVar = diffs.reduce((a, v) => a + (v - meanDiff) * (v - meanDiff), 0) / diffs.length;
  const lumaMean = lumas.reduce((a, v) => a + v, 0) / lumas.length;
  const lumaVar = lumas.reduce((a, v) => a + (v - lumaMean) * (v - lumaMean), 0) / lumas.length;

  let noiseAcc = 0;
  let noiseCount = 0;
  for (const f of frames) {
    const m = computePixelMetricsFromCanvas(f);
    if (m) {
      noiseAcc += m.noiseStd;
      noiseCount++;
    }
  }

  return {
    frames: frames.length,
    meanFrameDiff: Math.round(meanDiff * 100) / 100,
    diffJumpiness: Math.round(Math.sqrt(diffVar) * 100) / 100,
    lumaFlicker: Math.round(Math.sqrt(lumaVar) * 100) / 100,
    avgNoiseStd: noiseCount > 0 ? Math.round((noiseAcc / noiseCount) * 100) / 100 : 0,
    staticFrameRatio: Math.round((staticPairs / diffs.length) * 100) / 100,
  };
}
