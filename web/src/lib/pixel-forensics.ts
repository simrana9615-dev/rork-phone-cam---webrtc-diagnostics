/**
 * On-device pixel forensics: screen-replay (recapture) detection, noise/texture
 * statistics, document tamper analysis, and temporal video-frame comparison.
 * Everything runs in canvas — no uploads.
 */

export type ScreenSignal = {
  id: string;
  label: string;
  value: number;
  threshold: number;
  triggered: "strong" | "weak" | "no";
  detail: string;
};

export type ScreenReplayResult = {
  /** 0..1 — combined evidence that this frame shows a display being re-photographed. */
  score: number;
  verdict: "none" | "weak" | "likely";
  signals: ScreenSignal[];
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
  paperFraction: number;
  textBlockCount: number;
  backgroundBlockCount: number;
  backgroundUniformity: number;
  /** ELA energy of text regions relative to background — >2.2 suggests pasted/retyped text. */
  textTamperRatio: number | null;
  halftonePeriodicity: number;
  /** Hasler–Süsstrunk colorfulness — near-zero means a monochrome copy (IDKit "looksLikePhotocopy" analog). */
  colorfulness: number;
  looksLikeDocument: boolean;
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

/**
 * Conservative screen-replay assessment. A "likely" verdict requires multiple
 * independent signals — a single weak cue never condemns a frame.
 */
export function assessScreenReplay(m: PixelMetrics): ScreenReplayResult {
  const signals: ScreenSignal[] = [];
  const push = (id: string, label: string, value: number, weakAt: number, strongAt: number, detail: string) => {
    const triggered: ScreenSignal["triggered"] = value >= strongAt ? "strong" : value >= weakAt ? "weak" : "no";
    signals.push({ id, label, value, threshold: weakAt, triggered, detail });
  };

  push(
    "moire-grid",
    "Pixel-grid / moiré periodicity",
    m.gridPeriodicity,
    0.24,
    0.38,
    `High-frequency detail repeats every ~${m.gridPeriodLag ?? "?"}px (autocorrelation ${m.gridPeriodicity}). Photographed displays leave a periodic sub-pixel grid; natural scenes do not.`
  );
  push(
    "banding",
    "Refresh / brightness banding",
    m.bandingScore,
    0.3,
    0.45,
    `Horizontal luminance bands repeat every ~${m.bandingLag ?? "?"} rows (strength ${m.bandingScore}). Rolling-shutter capture of a display refresh causes this banding.`
  );
  const glareCombined = m.glareFraction >= 0.02 && m.glareBlobFraction >= 0.55 ? m.glareFraction : 0;
  push(
    "glare",
    "Concentrated specular glare",
    Math.round(glareCombined * 10000) / 10000,
    0.02,
    0.06,
    `${(m.glareFraction * 100).toFixed(2)}% of pixels are blown out and ${(m.glareBlobFraction * 100).toFixed(0)}% of them form one blob — a reflection hotspot typical of glass screens under room light.`
  );
  push(
    "cool-cast",
    "Display color cast",
    Math.max(0, m.coolCast),
    10,
    18,
    `Blue channel exceeds red by ${m.coolCast} levels on average. Backlit LCD/OLED panels push a cool cast that camera white balance rarely removes fully.`
  );

  const strong = signals.filter((s) => s.triggered === "strong").length;
  const weak = signals.filter((s) => s.triggered === "weak").length;
  let verdict: ScreenReplayResult["verdict"] = "none";
  if (strong >= 2 || (strong >= 1 && weak >= 2)) verdict = "likely";
  else if (strong === 1 || weak >= 2) verdict = "weak";
  const score = Math.min(1, strong * 0.45 + weak * 0.18);
  return { score: Math.round(score * 100) / 100, verdict, signals };
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
 * Document-focused pixel analysis: separates text regions from paper background,
 * compares ELA energy between them (pasted/retyped text re-compresses differently),
 * and measures paper uniformity and print halftone periodicity.
 */
export async function analyzeDocumentPixels(blob: Blob): Promise<DocumentPixelAnalysis | null> {
  const img = await decodeBlob(blob);
  if (!img) return null;
  const canvas = toCanvas(img, 900);
  if (!canvas) return null;

  const g = grayData(canvas);
  if (!g) return null;
  const { lum, w, h } = g;

  let paperCount = 0;
  for (let p = 0; p < lum.length; p++) if (lum[p] > 195) paperCount++;
  const paperFraction = paperCount / lum.length;

  const grid = await elaBlockGrid(canvas);
  let textTamperRatio: number | null = null;
  let textBlockCount = 0;
  let backgroundBlockCount = 0;
  let backgroundUniformity = 0;
  if (grid) {
    const sortedEdges = Array.from(grid.edges).sort((a, b) => a - b);
    const edgeP70 = sortedEdges[Math.floor(sortedEdges.length * 0.7)] ?? 0;
    const textEla: number[] = [];
    const bgEla: number[] = [];
    const bgMeans: number[] = [];
    for (let i = 0; i < grid.blocks.length; i++) {
      if (grid.edges[i] >= Math.max(edgeP70, 8)) {
        textEla.push(grid.blocks[i]);
      } else if (grid.edges[i] < 4) {
        bgEla.push(grid.blocks[i]);
        bgMeans.push(grid.blocks[i]);
      }
    }
    textBlockCount = textEla.length;
    backgroundBlockCount = bgEla.length;
    if (textEla.length >= 6 && bgEla.length >= 6) {
      const avg = (arr: number[]) => arr.reduce((a, v) => a + v, 0) / arr.length;
      const textAvg = avg(textEla);
      const bgAvg = avg(bgEla);
      textTamperRatio = Math.round((textAvg / (bgAvg + 0.25)) * 100) / 100;
      const bgMean = avg(bgMeans);
      const bgVar = bgMeans.reduce((a, v) => a + (v - bgMean) * (v - bgMean), 0) / bgMeans.length;
      backgroundUniformity = Math.round(Math.sqrt(bgVar) * 100) / 100;
    }
  }

  const colHp = new Array<number>(w).fill(0);
  for (let x = 1; x < w; x++) {
    let acc = 0;
    for (let y = 0; y < h; y++) acc += Math.abs(lum[y * w + x] - lum[y * w + x - 1]);
    colHp[x] = acc / h;
  }
  const halftone = autocorrelationPeak(colHp.slice(1), 2, 10);

  return {
    paperFraction: Math.round(paperFraction * 100) / 100,
    textBlockCount,
    backgroundBlockCount,
    backgroundUniformity,
    textTamperRatio,
    halftonePeriodicity: Math.round(halftone.strength * 1000) / 1000,
    colorfulness: Math.round(computeColorfulness(g) * 10) / 10,
    looksLikeDocument: paperFraction > 0.35,
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
