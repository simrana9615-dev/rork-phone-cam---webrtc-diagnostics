/**
 * Visual forensic evidence renderer: turns pixel-level detections into
 * human-inspectable heat maps and charts. Every map runs fully on-device and
 * is attached to the fraud report for debugging and tuning detection logic.
 *
 * Maps produced:
 *  - noise-map        |Laplacian| residual heat map — shows sensor noise texture
 *  - edge-map         gradient magnitude heat map — shows detail distribution
 *  - glare-map        blown-highlight overlay — localizes specular hotspots
 *  - ela-blocks       per-block ELA energy overlay with text-region outlines
 *  - frequency-profile column/row periodicity chart (moiré grid + refresh banding)
 *  - frame-strip      sampled video frames with inter-frame difference values
 */

import { autocorrelationPeak } from "./pixel-forensics";

export type ForensicVisual = {
  id: string;
  label: string;
  /** Data URL (JPEG for photographic maps, PNG for charts). */
  url: string;
  /** What the map shows and how to read it, with the measured stats inline. */
  caption: string;
};

const MAP_EDGE = 680;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Black → red → yellow → white heat ramp. */
function heatColor(t: number): [number, number, number] {
  const x = clamp01(t);
  return [Math.round(255 * clamp01(x * 3)), Math.round(255 * clamp01(x * 3 - 1)), Math.round(255 * clamp01(x * 3 - 2))];
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

function lumaField(canvas: HTMLCanvasElement): { lum: Float32Array; w: number; h: number } | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { lum, w, h };
}

function percentile(sortedCopyOf: Float32Array, p: number): number {
  const arr = Float32Array.from(sortedCopyOf).sort();
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)));
  return arr[idx];
}

/** Renders a scalar field as a heat-map JPEG data URL. */
function renderHeatField(field: Float32Array, w: number, h: number, normHi: number): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const out = ctx.createImageData(w, h);
  const o = out.data;
  const scale = normHi > 1e-6 ? 1 / normHi : 0;
  for (let p = 0; p < field.length; p++) {
    const [r, g, b] = heatColor(field[p] * scale);
    const i = p * 4;
    o[i] = r;
    o[i + 1] = g;
    o[i + 2] = b;
    o[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.82);
}

/** |Laplacian| residual map — genuine sensors leave grain everywhere; AI/denoised output goes black in flat regions. */
export function noiseMapVisual(canvas: HTMLCanvasElement): ForensicVisual | null {
  const g = lumaField(canvas);
  if (!g) return null;
  const { lum, w, h } = g;
  const field = new Float32Array(w * h);
  let sum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const lap = Math.abs(4 * lum[p] - lum[p + 1] - lum[p - 1] - lum[p + w] - lum[p - w]);
      field[p] = lap;
      sum += lap;
    }
  }
  const mean = sum / ((w - 2) * (h - 2));
  const p98 = percentile(field, 0.98);
  const url = renderHeatField(field, w, h, Math.max(p98, 4));
  if (!url) return null;
  return {
    id: "noise-map",
    label: "Noise residual map (Laplacian)",
    url,
    caption: `Per-pixel |Laplacian| residual, normalized to the 98th percentile (${p98.toFixed(1)}); mean ${mean.toFixed(2)}. Real sensors show fine uniform grain everywhere. Large pure-black flat regions = denoised/AI-rendered; sharp texture seams = spliced content with a different noise history.`,
  };
}

/** Gradient magnitude map — shows where detail lives; uniform faint texture over "flat" areas is a screen recapture cue. */
export function edgeMapVisual(canvas: HTMLCanvasElement): ForensicVisual | null {
  const g = lumaField(canvas);
  if (!g) return null;
  const { lum, w, h } = g;
  const field = new Float32Array(w * h);
  let sum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = Math.abs(lum[p + 1] - lum[p - 1]);
      const gy = Math.abs(lum[p + w] - lum[p - w]);
      field[p] = gx + gy;
      sum += field[p];
    }
  }
  const mean = sum / ((w - 2) * (h - 2));
  const p98 = percentile(field, 0.98);
  const url = renderHeatField(field, w, h, Math.max(p98, 8));
  if (!url) return null;
  return {
    id: "edge-map",
    label: "Edge / detail map (gradient magnitude)",
    url,
    caption: `Per-pixel gradient magnitude, normalized to the 98th percentile (${p98.toFixed(1)}); mean edge energy ${mean.toFixed(2)}. Read: where the detail is. A faint regular lattice across smooth areas = photographed display sub-pixel grid; unnaturally clean text edges = re-rendered/pasted text.`,
  };
}

/** Blown-highlight overlay — localizes specular glare blobs (screen glass, laminate hotspots). */
export function glareMapVisual(canvas: HTMLCanvasElement): ForensicVisual | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width: w, height: h } = canvas;
  const src = ctx.getImageData(0, 0, w, h);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return null;
  const img = octx.createImageData(w, h);
  const a = src.data;
  const o = img.data;
  let hard = 0;
  let soft = 0;
  for (let i = 0; i < a.length; i += 4) {
    const lum = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    if (lum > 250) {
      hard++;
      o[i] = 255;
      o[i + 1] = 40;
      o[i + 2] = 40;
    } else if (lum > 235) {
      soft++;
      o[i] = 255;
      o[i + 1] = 180;
      o[i + 2] = 40;
    } else {
      const dim = lum * 0.35;
      o[i] = dim;
      o[i + 1] = dim;
      o[i + 2] = dim;
    }
    o[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  const n = w * h;
  return {
    id: "glare-map",
    label: "Glare / blown-highlight map",
    url: out.toDataURL("image/jpeg", 0.82),
    caption: `Red = fully blown pixels (luma >250): ${((hard / n) * 100).toFixed(2)}%. Amber = near-saturation (>235): ${((soft / n) * 100).toFixed(2)}%. One large connected red blob = specular reflection off glass/laminate (screen recapture or document glare); scattered tiny red specks = normal highlights.`,
  };
}

/** Per-block ELA energy overlay with text-region outlines — localizes pasted/retyped content. */
export async function elaBlockVisual(canvas: HTMLCanvasElement): Promise<ForensicVisual | null> {
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
  if (bx < 4 || by < 4) return null;
  const energy = new Float64Array(bx * by);
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
      energy[gy * bx + gx] = diff / (count * 3);
      edges[gy * bx + gx] = edge / count;
    }
  }
  const sortedEnergy = Array.from(energy).sort((p, q) => p - q);
  const p95 = sortedEnergy[Math.floor(sortedEnergy.length * 0.95)] || 1;
  const sortedEdges = Array.from(edges).sort((p, q) => p - q);
  const edgeP70 = Math.max(sortedEdges[Math.floor(sortedEdges.length * 0.7)] ?? 0, 8);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.filter = "grayscale(1) brightness(0.45)";
  octx.drawImage(canvas, 0, 0);
  octx.filter = "none";
  let textBlocks = 0;
  for (let gy = 0; gy < by; gy++) {
    for (let gx = 0; gx < bx; gx++) {
      const i = gy * bx + gx;
      const t = clamp01(energy[i] / Math.max(p95, 0.5));
      const [r, g, b] = heatColor(t);
      octx.fillStyle = `rgba(${r},${g},${b},${(0.12 + 0.45 * t).toFixed(2)})`;
      octx.fillRect(gx * block, gy * block, block, block);
      if (edges[i] >= edgeP70) {
        textBlocks++;
        octx.strokeStyle = "rgba(64,224,255,0.75)";
        octx.lineWidth = 1;
        octx.strokeRect(gx * block + 0.5, gy * block + 0.5, block - 1, block - 1);
      }
    }
  }
  return {
    id: "ela-blocks",
    label: "ELA block grid (tamper localization)",
    url: out.toDataURL("image/jpeg", 0.85),
    caption: `Each ${block}px block is colored by its re-compression error, normalized to the 95th percentile (${p95.toFixed(2)}); cyan outlines mark the ${textBlocks} detected text/detail blocks (edge energy ≥ ${edgeP70.toFixed(1)}). Read: hot (red/yellow) blocks confined to specific fields — while paper stays dark — indicate pasted, retyped, or locally re-rendered content. Uniform temperature = single save.`,
  };
}

/** Column/row periodicity chart — visualizes moiré grid and refresh banding profiles with autocorrelation stats. */
export function frequencyProfileVisual(canvas: HTMLCanvasElement): ForensicVisual | null {
  const g = lumaField(canvas);
  if (!g) return null;
  const { lum, w, h } = g;

  const colHp = new Array<number>(w).fill(0);
  for (let x = 1; x < w; x++) {
    let acc = 0;
    for (let y = 0; y < h; y++) acc += Math.abs(lum[y * w + x] - lum[y * w + x - 1]);
    colHp[x] = acc / h;
  }
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
  const gridPeak = autocorrelationPeak(colHp.slice(1), 2, 24);
  const bandPeak = autocorrelationPeak(detrended, 4, Math.min(80, Math.floor(h / 3)));

  const W = 680;
  const H = 300;
  const chart = document.createElement("canvas");
  chart.width = W;
  chart.height = H;
  const ctx = chart.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#0b1016";
  ctx.fillRect(0, 0, W, H);

  const drawPanel = (series: number[], top: number, height: number, color: string, title: string) => {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.strokeRect(8.5, top + 0.5, W - 17, height - 1);
    let min = Infinity;
    let max = -Infinity;
    for (const v of series) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = Math.max(1e-6, max - min);
    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = 10 + ((W - 20) * i) / Math.max(1, series.length - 1);
      const y = top + height - 6 - ((series[i] - min) / span) * (height - 24);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(title, 12, top + 14);
  };

  drawPanel(
    colHp.slice(1),
    6,
    140,
    "#3ee0ff",
    `column high-pass profile · grid autocorr ${gridPeak.strength.toFixed(3)}${gridPeak.lag != null ? ` @ lag ${gridPeak.lag}px` : ""} (weak ≥0.24 · strong ≥0.38)`
  );
  drawPanel(
    detrended,
    152,
    140,
    "#ffc23e",
    `detrended row means · banding autocorr ${bandPeak.strength.toFixed(3)}${bandPeak.lag != null ? ` @ lag ${bandPeak.lag}rows` : ""} (weak ≥0.30 · strong ≥0.45)`
  );

  return {
    id: "frequency-profile",
    label: "Periodicity profiles (moiré grid + refresh banding)",
    url: chart.toDataURL("image/png"),
    caption: `Top (cyan): mean horizontal high-pass energy per column — a photographed display's sub-pixel grid produces a regular comb pattern with a high autocorrelation peak. Bottom (amber): detrended row brightness — rolling-shutter capture of a display refresh produces periodic horizontal bands. Flat/noisy profiles with low autocorrelation are normal for genuine scenes.`,
  };
}

/** Horizontal strip of sampled video frames with inter-frame difference values. */
export function frameStripVisual(frames: HTMLCanvasElement[]): ForensicVisual | null {
  if (frames.length < 2) return null;
  const thumbH = 130;
  const gap = 4;
  const labelH = 18;
  const thumbs = frames.slice(0, 6).map((f) => {
    const scale = thumbH / f.height;
    return { f, w: Math.max(24, Math.round(f.width * scale)) };
  });
  const totalW = thumbs.reduce((acc, t) => acc + t.w, 0) + gap * (thumbs.length - 1);
  const out = document.createElement("canvas");
  out.width = totalW;
  out.height = thumbH + labelH;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#0b1016";
  ctx.fillRect(0, 0, out.width, out.height);

  const diffs: number[] = [];
  for (let i = 1; i < Math.min(frames.length, 6); i++) {
    const g1 = lumaField(frames[i - 1]);
    const g2 = lumaField(frames[i]);
    if (!g1 || !g2) {
      diffs.push(0);
      continue;
    }
    const w = Math.min(g1.w, g2.w);
    const h = Math.min(g1.h, g2.h);
    let acc = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) acc += Math.abs(g1.lum[y * g1.w + x] - g2.lum[y * g2.w + x]);
    }
    diffs.push(acc / (Math.ceil(w / 3) * Math.ceil(h / 3)));
  }

  let x = 0;
  ctx.font = "10px ui-monospace, monospace";
  for (let i = 0; i < thumbs.length; i++) {
    ctx.drawImage(thumbs[i].f, x, 0, thumbs[i].w, thumbH);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(`#${i + 1}`, x + 4, thumbH + 13);
    if (i > 0) {
      const d = diffs[i - 1];
      ctx.fillStyle = d < 1.2 ? "#ff5a5a" : "#3ee0ff";
      ctx.fillText(`Δ${d.toFixed(1)}`, x - 2, thumbH + 13);
    }
    x += thumbs[i].w + gap;
  }
  const staticPairs = diffs.filter((d) => d < 1.2).length;
  return {
    id: "frame-strip",
    label: "Sampled frame strip + inter-frame deltas",
    url: out.toDataURL("image/jpeg", 0.82),
    caption: `${thumbs.length} frames sampled across the timeline; Δ = mean absolute luma difference to the previous frame (red = near-identical, <1.2). ${staticPairs}/${diffs.length} static pairs. Frames that barely change across the whole timeline indicate a replayed still or slideshow posing as live footage.`,
  };
}

/** Builds the full visual evidence set for a still image. Never throws — returns whatever maps succeeded. */
export async function buildImageVisuals(blob: Blob): Promise<ForensicVisual[]> {
  const visuals: ForensicVisual[] = [];
  try {
    const img = await decodeBlob(blob);
    if (!img) return visuals;
    const canvas = toCanvas(img, MAP_EDGE);
    if (!canvas) return visuals;
    const noise = noiseMapVisual(canvas);
    if (noise) visuals.push(noise);
    const edge = edgeMapVisual(canvas);
    if (edge) visuals.push(edge);
    const glare = glareMapVisual(canvas);
    if (glare) visuals.push(glare);
    const freq = frequencyProfileVisual(canvas);
    if (freq) visuals.push(freq);
    const elaBlocks = await elaBlockVisual(canvas);
    if (elaBlocks) visuals.push(elaBlocks);
  } catch {
    // visuals are best-effort evidence — never block the report on a render failure
  }
  return visuals;
}

/** Builds the visual evidence set for a video from already-extracted frames. */
export function buildVideoVisuals(frames: HTMLCanvasElement[]): ForensicVisual[] {
  const visuals: ForensicVisual[] = [];
  try {
    const strip = frameStripVisual(frames);
    if (strip) visuals.push(strip);
    const mid = frames[Math.floor(frames.length / 2)];
    if (mid) {
      const scaled = toCanvas(mid, MAP_EDGE) ?? mid;
      const noise = noiseMapVisual(scaled);
      if (noise) visuals.push({ ...noise, label: `${noise.label} — mid frame` });
      const glare = glareMapVisual(scaled);
      if (glare) visuals.push({ ...glare, label: `${glare.label} — mid frame` });
      const freq = frequencyProfileVisual(scaled);
      if (freq) visuals.push({ ...freq, label: `${freq.label} — mid frame` });
    }
  } catch {
    // best-effort
  }
  return visuals;
}
