/**
 * Display-lattice and refresh-banding forensics.
 *
 * WHY THIS REPLACES THE OLD MEASURE: the previous "moiré periodicity" signal ran
 * a normalized autocorrelation over a 900px downscale of the image and fired at
 * 0.24. Two fatal problems:
 *
 *  1. SCALE. A photographed phone/laptop screen leaves a lattice whose period is
 *     roughly 2–8 px at the camera's native resolution. Downscaling a 4032px
 *     photo to 900px shrinks that period below 2 px — under the Nyquist limit,
 *     so the evidence is destroyed before it is measured. Whatever the old
 *     number was, it could not have been a display lattice.
 *  2. SELECTIVITY. Autocorrelation strength rises for ANY self-similar detail:
 *     printed text lines, the guilloche security pattern on a licence, fabric
 *     weave, and the 8×8 JPEG block grid present in every JPEG ever saved. A
 *     broadband "0.83" therefore says nothing about screens.
 *
 * The rebuild measures the property that actually distinguishes a screen: a
 * NARROW, SHARP spectral peak that stands far above the local noise floor, at
 * native resolution, with the JPEG block grid explicitly excluded, and present
 * on both axes with comparable spacing (real panels have a near-square subpixel
 * lattice, natural texture does not).
 */

export type LatticeAxis = {
  axis: "horizontal" | "vertical";
  /** Spatial period of the dominant peak, in native-resolution pixels. */
  periodPx: number | null;
  /** Peak power divided by the median power of the surrounding band. 1.0 = no peak. */
  prominence: number;
  /** Share of in-band energy held by the single peak bin. */
  peakShare: number;
};

export type ScreenLatticeResult = {
  tilesUsed: number;
  tilesRejected: number;
  nativeWidth: number;
  nativeHeight: number;
  x: LatticeAxis;
  y: LatticeAxis;
  /** Both axes peaked and their periods agree within 35% — a square-ish lattice. */
  axisAgreement: boolean;
  periodRatio: number | null;
  /** Best prominence across the two axes. */
  prominence: number;
  excludedPeriods: string;
};

export type BandingResult = {
  /** Period of the dominant row-luminance oscillation, in analysed rows. */
  periodRows: number | null;
  prominence: number;
  rowsAnalysed: number;
};

const TILE = 256;
const PERIOD_MIN = 2.4;
const PERIOD_MAX = 18;

/**
 * JPEG writes an 8×8 DCT block grid, and 4:2:0 chroma subsampling adds a 16px
 * MCU grid. Those periods (and their harmonics) exist in every camera JPEG, so
 * they are excluded from the search band — otherwise compression would be
 * mistaken for a display.
 */
const JPEG_PERIODS = [16, 8, 4, 8 / 3];

type BinTable = { ks: number[]; periods: number[]; cos: Float64Array[]; sin: Float64Array[]; excluded: boolean[] };

function buildBinTable(n: number): BinTable {
  const kMin = Math.max(2, Math.ceil(n / PERIOD_MAX));
  const kMax = Math.min(Math.floor(n / 2) - 1, Math.floor(n / PERIOD_MIN));
  const ks: number[] = [];
  const periods: number[] = [];
  const cos: Float64Array[] = [];
  const sin: Float64Array[] = [];
  const excluded: boolean[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const period = n / k;
    const c = new Float64Array(n);
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * k * i) / n;
      c[i] = Math.cos(a);
      s[i] = Math.sin(a);
    }
    ks.push(k);
    periods.push(period);
    cos.push(c);
    sin.push(s);
    // Exclude a bin when its period sits within one bin-width of a JPEG grid period.
    const binWidth = period - n / (k + 1);
    excluded.push(JPEG_PERIODS.some((p) => Math.abs(period - p) <= Math.max(binWidth, p * 0.06)));
  }
  return { ks, periods, cos, sin, excluded };
}

/** Hann window suppresses spectral leakage that would otherwise fake a peak. */
function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Locates the strongest non-JPEG peak and measures how far it stands above the
 * local noise floor. Prominence is a ratio, so it is invariant to exposure,
 * contrast and overall texture level — unlike the old autocorrelation value.
 */
function peakProminence(power: Float64Array, table: BinTable): { periodPx: number | null; prominence: number; peakShare: number } {
  let peakIdx = -1;
  let peakVal = 0;
  let total = 0;
  for (let i = 0; i < power.length; i++) {
    total += power[i];
    if (table.excluded[i]) continue;
    if (power[i] > peakVal) {
      peakVal = power[i];
      peakIdx = i;
    }
  }
  if (peakIdx < 0 || peakVal <= 0 || total <= 0) return { periodPx: null, prominence: 1, peakShare: 0 };
  const background: number[] = [];
  for (let i = 0; i < power.length; i++) {
    if (table.excluded[i]) continue;
    if (Math.abs(i - peakIdx) <= 3) continue;
    background.push(power[i]);
  }
  const floor = median(background);
  const prominence = floor > 0 ? peakVal / floor : peakVal > 0 ? 999 : 1;
  return {
    periodPx: Math.round(table.periods[peakIdx] * 100) / 100,
    prominence: Math.round(Math.min(prominence, 999) * 100) / 100,
    peakShare: Math.round((peakVal / total) * 1000) / 1000,
  };
}

type TileGray = { lum: Float64Array; size: number };

/** High-pass residual: luma minus its 3×3 box mean. Removes scene content, keeps grids. */
function residual(lum: Float64Array, size: number): Float64Array {
  const out = new Float64Array(size * size);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) sum += lum[(y + dy) * size + x + dx];
      }
      out[y * size + x] = lum[y * size + x] - sum / 9;
    }
  }
  return out;
}

function readTile(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  ctx: CanvasRenderingContext2D
): TileGray | null {
  ctx.clearRect(0, 0, TILE, TILE);
  try {
    ctx.drawImage(source, sx, sy, TILE, TILE, 0, 0, TILE, TILE);
  } catch {
    return null;
  }
  const data = ctx.getImageData(0, 0, TILE, TILE).data;
  const lum = new Float64Array(TILE * TILE);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { lum, size: TILE };
}

/**
 * Analyses up to nine native-resolution tiles for a display lattice.
 * Returns null when the image is too small for the measurement to mean anything —
 * an honest "cannot assess" rather than a fabricated number.
 */
export function analyzeScreenLattice(source: HTMLImageElement | HTMLCanvasElement): ScreenLatticeResult | null {
  const nativeWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const nativeHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (nativeWidth < TILE * 2 || nativeHeight < TILE * 2) return null;

  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const table = buildBinTable(TILE);
  const win = hann(TILE);
  const powerX = new Float64Array(table.ks.length);
  const powerY = new Float64Array(table.ks.length);
  let tilesUsed = 0;
  let tilesRejected = 0;

  const fractions = [0.2, 0.5, 0.8];
  for (const fy of fractions) {
    for (const fx of fractions) {
      const sx = Math.min(nativeWidth - TILE, Math.max(0, Math.round(nativeWidth * fx - TILE / 2)));
      const sy = Math.min(nativeHeight - TILE, Math.max(0, Math.round(nativeHeight * fy - TILE / 2)));
      const tile = readTile(source, sx, sy, ctx);
      if (!tile) {
        tilesRejected += 1;
        continue;
      }
      let lumSum = 0;
      for (let p = 0; p < tile.lum.length; p++) lumSum += tile.lum[p];
      const meanLuma = lumSum / tile.lum.length;
      const res = residual(tile.lum, TILE);
      let absSum = 0;
      for (let p = 0; p < res.length; p++) absSum += Math.abs(res[p]);
      const meanAbs = absSum / res.length;
      // Blown-out or pitch-black tiles carry no lattice; neither do perfectly
      // smooth ones. Rejecting them is honest, not selective.
      if (meanLuma > 250 || meanLuma < 8 || meanAbs < 0.45) {
        tilesRejected += 1;
        continue;
      }
      tilesUsed += 1;

      // Horizontal axis: periodicity along x, averaged over rows.
      const stride = 8;
      for (let y = 1; y < TILE - 1; y += stride) {
        for (let bi = 0; bi < table.ks.length; bi++) {
          const c = table.cos[bi];
          const s = table.sin[bi];
          let re = 0;
          let im = 0;
          for (let x = 0; x < TILE; x++) {
            const v = res[y * TILE + x] * win[x];
            re += v * c[x];
            im += v * s[x];
          }
          powerX[bi] += re * re + im * im;
        }
      }
      // Vertical axis: periodicity along y, averaged over columns.
      for (let x = 1; x < TILE - 1; x += stride) {
        for (let bi = 0; bi < table.ks.length; bi++) {
          const c = table.cos[bi];
          const s = table.sin[bi];
          let re = 0;
          let im = 0;
          for (let y = 0; y < TILE; y++) {
            const v = res[y * TILE + x] * win[y];
            re += v * c[y];
            im += v * s[y];
          }
          powerY[bi] += re * re + im * im;
        }
      }
    }
  }

  if (tilesUsed === 0) return null;

  const px = peakProminence(powerX, table);
  const py = peakProminence(powerY, table);
  const ratio =
    px.periodPx != null && py.periodPx != null && px.periodPx > 0 && py.periodPx > 0
      ? Math.max(px.periodPx, py.periodPx) / Math.min(px.periodPx, py.periodPx)
      : null;

  return {
    tilesUsed,
    tilesRejected,
    nativeWidth,
    nativeHeight,
    x: { axis: "horizontal", ...px },
    y: { axis: "vertical", ...py },
    axisAgreement: ratio != null && ratio <= 1.35,
    periodRatio: ratio != null ? Math.round(ratio * 100) / 100 : null,
    prominence: Math.max(px.prominence, py.prominence),
    excludedPeriods: JPEG_PERIODS.map((p) => `${Math.round(p * 100) / 100}px`).join(", "),
  };
}

/**
 * Rolling-shutter refresh banding: a display refreshing at 60/120Hz while the
 * camera reads out row-by-row imprints a sharp horizontal-band frequency.
 * Measured as spectral prominence of the detrended row-mean profile, so smooth
 * scene gradients (which the old autocorrelation counted) contribute nothing.
 */
export function analyzeRefreshBanding(canvas: HTMLCanvasElement): BandingResult | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width: w, height: h } = canvas;
  if (h < 160) return null;
  const data = ctx.getImageData(0, 0, w, h).data;
  const rowMeans = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    rowMeans[y] = sum / w;
  }
  // Detrend with a wide moving average so lighting gradients cannot masquerade
  // as banding; only oscillations faster than the window survive.
  const half = 12;
  const detrended = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const lo = Math.max(0, y - half);
    const hi = Math.min(h - 1, y + half);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += rowMeans[k];
    detrended[y] = rowMeans[y] - sum / (hi - lo + 1);
  }

  const n = Math.min(512, h - (h % 2));
  const start = Math.floor((h - n) / 2);
  const win = hann(n);
  const kMin = Math.max(2, Math.ceil(n / 80));
  const kMax = Math.min(Math.floor(n / 2) - 1, Math.floor(n / 4));
  const periods: number[] = [];
  const power = new Float64Array(kMax - kMin + 1);
  for (let k = kMin; k <= kMax; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const v = detrended[start + i] * win[i];
      const a = (2 * Math.PI * k * i) / n;
      re += v * Math.cos(a);
      im += v * Math.sin(a);
    }
    power[k - kMin] = re * re + im * im;
    periods.push(n / k);
  }
  const table: BinTable = {
    ks: periods.map((_, i) => kMin + i),
    periods,
    cos: [],
    sin: [],
    excluded: periods.map(() => false),
  };
  const peak = peakProminence(power, table);
  return {
    periodRows: peak.periodPx,
    prominence: peak.prominence,
    rowsAnalysed: n,
  };
}
