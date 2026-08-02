/**
 * On-device face detection, description (128-d descriptors), expression scoring,
 * and identity matching via @vladmandic/face-api (TensorFlow.js). Models are
 * lazy-loaded from CDN on first use; nothing leaves the device.
 *
 * Matching pipeline (document portrait vs live face), tuned for the hard case
 * of a small, laminated ID portrait against a phone selfie:
 *
 * 1. Detection — SSD MobileNet V1 (much higher recall on still photos) with
 *    TinyFaceDetector fallbacks at two input sizes. A portrait on a full
 *    document photo is tiny relative to the frame and is easily missed by a
 *    single fixed-size detector pass. All candidate faces are ranked and the
 *    MAIN portrait (largest confident face) wins — many IDs (incl. every
 *    Australian licence) carry a smaller ghost/secondary portrait that must
 *    not hijack the identity comparison.
 * 2. Enhancement — the detected face is cropped with margin and upscaled with
 *    high-quality interpolation so the recognition net sees ~280px of face
 *    instead of a 100px thumbnail (the net's aligned input is 150px; feeding
 *    it from a smaller source destroys identity detail).
 * 3. Alignment — in-plane rotation (roll) is corrected using the eye
 *    landmarks before descriptor extraction. Documents photographed at an
 *    angle produce rolled faces, and the recognition net loses accuracy fast
 *    beyond a few degrees of roll.
 * 4. Ensemble — descriptors are computed for the aligned crop, its mirror,
 *    a contrast-normalized variant, and (for soft upscaled crops) an
 *    unsharp-masked variant, then fused. Single-shot descriptors from
 *    small/glossy/laminated ID portraits are noisy; the ensemble cancels
 *    much of that noise and pose/lighting bias.
 * 5. Calibration — thresholds follow the dlib/FaceNet standard (same person
 *    typically < 0.6) adapted for doc-vs-selfie pairs: match ≤ 0.55,
 *    mismatch ≥ 0.68, with the band in between explicitly uncertain.
 */

type FaceApi = typeof import("@vladmandic/face-api");

let api: FaceApi | null = null;
let modelsReady = false;
let loadPromise: Promise<void> | null = null;
let ssdReady = false;
let ssdFailed = false;
let ssdPromise: Promise<void> | null = null;

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";

/** Calibrated descriptor-distance thresholds (see module docs). */
export const MATCH_DISTANCE_MAX = 0.55;
export const MISMATCH_DISTANCE_MIN = 0.68;

export type FaceBox = { x: number; y: number; width: number; height: number };

export type FaceQuality = {
  ok: boolean;
  issues: string[];
  /** Face width in the ORIGINAL source pixels (pre-enhancement). */
  boxWidth: number;
  detectionScore: number;
  brightness: number;
  sharpness: number;
  /** Luminance std-dev of the face crop, 0..~80. Very low = flat print/render. */
  contrast: number;
  /** Fraction of the 256 intensity levels present in the crop (Innovatrics minUniqueIntensityLevels analog). */
  uniqueLevels: number;
};

export type FaceDescription = {
  descriptor: Float32Array;
  box: FaceBox;
  detectionScore: number;
  quality: FaceQuality;
  /** Ensemble descriptor variants (enhanced crop / mirror / normalized) when the robust pipeline ran. */
  variants?: Float32Array[];
  /** Human-readable enhancement steps applied before descriptor extraction. */
  enhancement?: string[];
  /** Which detector located the face (ssd-mobilenet-v1 / tiny-608 / tiny-416). */
  detector?: string;
};

export type FaceExpressionSample = {
  happy: number;
  neutral: number;
  /** Horizontal head-pose proxy 0..1 (only meaningful when sampled with `withPose: true`; 0.5 otherwise). */
  yaw: number;
  box: FaceBox;
  detectionScore: number;
};

export type MatchOutcome = {
  verdict: "match" | "mismatch" | "uncertain";
  distance: number;
  similarity: number;
};

/** Ensemble-aware match result with the full distance breakdown for reports. */
export type EnsembleMatch = MatchOutcome & {
  /** Distance between the two fused (mean) descriptors. */
  meanDistance: number;
  /** Best (smallest) distance across all variant pairs. */
  bestDistance: number;
  /** Median distance across all variant pairs. */
  medianDistance: number;
  /** Number of variant pairs compared. */
  pairsCompared: number;
};

/** Loads face-api and its models (detector, landmarks, recognition, expressions). */
export async function loadFaceModels(onStep?: (msg: string) => void): Promise<void> {
  if (modelsReady) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onStep?.("Loading face analysis engine (TensorFlow.js)…");
    api = await import("@vladmandic/face-api");
    onStep?.("Downloading on-device face models (~6 MB, cached after first load)…");
    await Promise.all([
      api.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      api.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      api.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      api.nets.faceExpressionNet.loadFromUri(MODEL_URL),
    ]);
    modelsReady = true;
    onStep?.("Face models ready.");
  })();
  try {
    await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

export function faceModelsReady(): boolean {
  return modelsReady;
}

/**
 * Lazily loads the SSD MobileNet V1 detector (~5.5 MB) used for still photos.
 * Falls back gracefully to TinyFaceDetector if the download fails.
 */
async function ensureStillDetector(): Promise<boolean> {
  if (ssdReady) return true;
  if (ssdFailed || !api) return false;
  if (!ssdPromise) {
    ssdPromise = api.nets.ssdMobilenetv1.loadFromUri(MODEL_URL).then(
      () => {
        ssdReady = true;
      },
      () => {
        ssdFailed = true;
      }
    );
  }
  await ssdPromise;
  return ssdReady;
}

function detectorOptions(a: FaceApi) {
  return new a.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 });
}

function cropStats(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  box: FaceBox
): { brightness: number; sharpness: number; contrast: number; uniqueLevels: number } {
  const canvas = document.createElement("canvas");
  const size = 96;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { brightness: 128, sharpness: 100, contrast: 30, uniqueLevels: 0.5 };
  try {
    ctx.drawImage(input, box.x, box.y, box.width, box.height, 0, 0, size, size);
  } catch {
    return { brightness: 128, sharpness: 100, contrast: 30, uniqueLevels: 0.5 };
  }
  const data = ctx.getImageData(0, 0, size, size).data;
  const lum = new Float32Array(size * size);
  const levels = new Uint8Array(256);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum[p];
    levels[Math.max(0, Math.min(255, Math.round(lum[p])))] = 1;
  }
  const brightness = sum / (size * size);
  let varAcc = 0;
  for (let p = 0; p < lum.length; p++) {
    const d = lum[p] - brightness;
    varAcc += d * d;
  }
  const contrast = Math.sqrt(varAcc / lum.length);
  let levelCount = 0;
  for (let i = 0; i < 256; i++) levelCount += levels[i];
  const uniqueLevels = levelCount / 256;
  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const lap = 4 * lum[y * size + x] - lum[y * size + x + 1] - lum[y * size + x - 1] - lum[(y + 1) * size + x] - lum[(y - 1) * size + x];
      lapSum += lap;
      lapSq += lap * lap;
      count++;
    }
  }
  const mean = lapSum / count;
  const sharpness = lapSq / count - mean * mean;
  return {
    brightness: Math.round(brightness),
    sharpness: Math.round(sharpness),
    contrast: Math.round(contrast * 10) / 10,
    uniqueLevels: Math.round(uniqueLevels * 100) / 100,
  };
}

/**
 * Capture quality gates modelled on Innovatrics DOT auto-capture thresholds
 * (brightness/contrast/sharpness/unique-intensity gates) — recalibrated for
 * this pipeline's 96px crop statistics. The size gate uses the SOURCE face
 * width: the enhancement pipeline upscales before descriptor extraction, so
 * faces down to ~72px source width still produce usable identity evidence.
 */
function assessQuality(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  box: FaceBox,
  score: number,
  sourceBoxWidth?: number
): FaceQuality {
  const issues: string[] = [];
  const srcW = Math.round(sourceBoxWidth ?? box.width);
  const { brightness, sharpness, contrast, uniqueLevels } = cropStats(input, box);
  if (srcW < 72) issues.push(`Face too small (${srcW}px wide in the source — need ≥72px even with enhancement). Move closer or use a higher-resolution photo.`);
  if (score < 0.5) issues.push(`Weak face detection (score ${score.toFixed(2)}) — face may be angled, occluded, or wearing sunglasses.`);
  if (brightness < 55) issues.push(`Face region too dark (brightness ${brightness}/255). Improve lighting.`);
  if (brightness > 225) issues.push(`Face region blown out (brightness ${brightness}/255). Reduce glare/backlight.`);
  if (sharpness < 30) issues.push(`Face region is blurry (sharpness ${sharpness}). Hold steady and refocus.`);
  if (contrast < 15) issues.push(`Face region has very low contrast (${contrast}) — washed-out capture or a flat print. Improve lighting angle.`);
  if (uniqueLevels < 0.2) issues.push(`Face region uses only ${Math.round(uniqueLevels * 256)} of 256 intensity levels — posterized/rendered or heavily processed source.`);
  return {
    ok: issues.length === 0,
    issues,
    boxWidth: srcW,
    detectionScore: Math.round(score * 100) / 100,
    brightness,
    sharpness,
    contrast,
    uniqueLevels,
  };
}

/** Detects the most prominent face and computes its 128-d identity descriptor (fast single-pass; use describeFaceRobust for stills). */
export async function describeFace(input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement): Promise<FaceDescription | null> {
  await loadFaceModels();
  if (!api) return null;
  const result = await api
    .detectSingleFace(input, detectorOptions(api))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!result) return null;
  const box: FaceBox = {
    x: result.detection.box.x,
    y: result.detection.box.y,
    width: result.detection.box.width,
    height: result.detection.box.height,
  };
  return {
    descriptor: result.descriptor,
    box,
    detectionScore: result.detection.score,
    quality: assessQuality(input, box, result.detection.score),
  };
}

function sourceSize(input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement): { w: number; h: number } {
  if (input instanceof HTMLVideoElement) return { w: input.videoWidth, h: input.videoHeight };
  if (input instanceof HTMLImageElement) return { w: input.naturalWidth || input.width, h: input.naturalHeight || input.height };
  return { w: input.width, h: input.height };
}

/** Draws the input onto a working canvas, downscaling very large sources (detectors resize internally anyway). */
function toWorkCanvas(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  maxDim: number
): { canvas: HTMLCanvasElement; scale: number } | null {
  const { w, h } = sourceSize(input);
  if (w < 8 || h < 8) return null;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(input, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  return { canvas, scale };
}

type DetectedBox = { box: FaceBox; score: number; detector: string; candidates: number };

/**
 * Picks the MAIN portrait from a set of detections: the largest confident
 * face. IDs commonly carry a smaller ghost/secondary portrait (all Australian
 * licences, many EU cards); a pure best-score pick can land on the ghost and
 * wreck the match. Size discriminates — the primary portrait is always the
 * biggest face on the document — but only among detections whose confidence
 * is in the same league as the strongest one, so a large low-confidence
 * false positive (hologram blob, face-like texture) can't out-rank the real
 * high-confidence portrait.
 */
function pickMainFace(
  dets: { box: { x: number; y: number; width: number; height: number }; score: number }[],
  detector: string
): DetectedBox | null {
  if (dets.length === 0) return null;
  const topScore = Math.max(...dets.map((d) => d.score));
  const credible = dets.filter((d) => d.score >= topScore * 0.6);
  const best = credible.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  return {
    box: { x: best.box.x, y: best.box.y, width: best.box.width, height: best.box.height },
    score: best.score,
    detector,
    candidates: dets.length,
  };
}

/** Multi-detector face location: SSD first (best recall on stills), then tiny at two input sizes. */
async function detectBestFace(canvas: HTMLCanvasElement): Promise<DetectedBox | null> {
  if (!api) return null;
  if (await ensureStillDetector()) {
    const dets = await api.detectAllFaces(canvas, new api.SsdMobilenetv1Options({ minConfidence: 0.35 }));
    const main = pickMainFace(
      dets.map((d) => ({ box: d.box, score: d.score })),
      "ssd-mobilenet-v1"
    );
    if (main) return main;
  }
  const passes: { inputSize: number; scoreThreshold: number }[] = [
    { inputSize: 608, scoreThreshold: 0.25 },
    { inputSize: 416, scoreThreshold: 0.18 },
  ];
  for (const p of passes) {
    const dets = await api.detectAllFaces(canvas, new api.TinyFaceDetectorOptions(p));
    const main = pickMainFace(
      dets.map((d) => ({ box: d.box, score: d.score })),
      `tiny-${p.inputSize}`
    );
    if (main) return main;
  }
  return null;
}

/** Crops the face with margin and upscales small faces so the recognition net gets real detail. */
function enhanceCrop(source: HTMLCanvasElement, box: FaceBox): { canvas: HTMLCanvasElement; scale: number } | null {
  const margin = 0.45;
  const mx = box.width * margin;
  const my = box.height * margin;
  const x0 = Math.max(0, Math.floor(box.x - mx));
  const y0 = Math.max(0, Math.floor(box.y - my));
  const x1 = Math.min(source.width, Math.ceil(box.x + box.width + mx));
  const y1 = Math.min(source.height, Math.ceil(box.y + box.height + my));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const TARGET_FACE_PX = 280;
  const scale = Math.min(4, Math.max(1, TARGET_FACE_PX / Math.max(1, box.width)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(source, x0, y0, w, h, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  return { canvas, scale };
}

/**
 * Corrects in-plane rotation (roll) using the eye landmarks. The recognition
 * net expects an upright face; document pages photographed at an angle yield
 * rolled portraits that inflate genuine-pair distances. Returns null when the
 * face is already upright (<2.5°), the tilt is implausible (>30°), or
 * landmarks cannot be found.
 */
async function alignByEyes(source: HTMLCanvasElement): Promise<{ canvas: HTMLCanvasElement; rollDeg: number } | null> {
  if (!api) return null;
  const r = await api
    .detectSingleFace(source, new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.2 }))
    .withFaceLandmarks();
  if (!r) return null;
  const pts = r.landmarks.positions;
  // 68-landmark model: 36–41 = left eye, 42–47 = right eye.
  let lx = 0;
  let ly = 0;
  let rx = 0;
  let ry = 0;
  for (let i = 36; i <= 41; i++) {
    lx += pts[i].x;
    ly += pts[i].y;
  }
  for (let i = 42; i <= 47; i++) {
    rx += pts[i].x;
    ry += pts[i].y;
  }
  lx /= 6;
  ly /= 6;
  rx /= 6;
  ry /= 6;
  const angle = Math.atan2(ry - ly, rx - lx);
  const rollDeg = (angle * 180) / Math.PI;
  if (Math.abs(rollDeg) < 2.5 || Math.abs(rollDeg) > 30) return null;
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Neutral fill so the revealed corners don't read as hard edges.
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cx = (lx + rx) / 2;
  const cy = (ly + ry) / 2;
  ctx.translate(cx, cy);
  ctx.rotate(-angle);
  ctx.translate(-cx, -cy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0);
  return { canvas, rollDeg: Math.round(rollDeg * 10) / 10 };
}

/**
 * Unsharp mask (3×3 box blur, amount 0.8) — restores edge detail on crops
 * that had to be heavily upscaled from a small document portrait. Only used
 * as an ensemble variant, never as the primary.
 */
function sharpenCanvas(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx0 = source.getContext("2d", { willReadFrequently: true });
  if (!ctx0) return null;
  let img: ImageData;
  try {
    img = ctx0.getImageData(0, 0, source.width, source.height);
  } catch {
    return null;
  }
  const w = source.width;
  const h = source.height;
  const src = img.data;
  const out = new ImageData(w, h);
  const od = out.data;
  const AMOUNT = 0.8;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1) * w;
    const y1 = y * w;
    const y2 = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x2 = Math.min(w - 1, x + 1);
      for (let c = 0; c < 3; c++) {
        const blur =
          (src[(y0 + x0) * 4 + c] +
            src[(y0 + x) * 4 + c] +
            src[(y0 + x2) * 4 + c] +
            src[(y1 + x0) * 4 + c] +
            src[(y1 + x) * 4 + c] +
            src[(y1 + x2) * 4 + c] +
            src[(y2 + x0) * 4 + c] +
            src[(y2 + x) * 4 + c] +
            src[(y2 + x2) * 4 + c]) /
          9;
        const v = src[(y1 + x) * 4 + c] + AMOUNT * (src[(y1 + x) * 4 + c] - blur);
        od[(y1 + x) * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      od[(y1 + x) * 4 + 3] = 255;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.putImageData(out, 0, 0);
  return canvas;
}

function mirrorCanvas(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

/**
 * Percentile contrast stretch (2–98) applied uniformly to RGB. Rescues faded,
 * glossy, or backlit ID portraits without shifting hue. Returns null when the
 * image already uses the full range (variant would be a duplicate).
 */
function normalizeContrast(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx0 = source.getContext("2d", { willReadFrequently: true });
  if (!ctx0) return null;
  let img: ImageData;
  try {
    img = ctx0.getImageData(0, 0, source.width, source.height);
  } catch {
    return null;
  }
  const data = img.data;
  const hist = new Uint32Array(256);
  const total = source.width * source.height;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.max(0, Math.min(255, Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])));
    hist[lum]++;
  }
  let acc = 0;
  let p2 = 0;
  let p98 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc <= total * 0.02) p2 = v;
    if (acc <= total * 0.98) p98 = v;
  }
  const span = p98 - p2;
  if (span < 10 || (p2 <= 4 && p98 >= 251)) return null;
  const gain = 255 / span;
  const out = new ImageData(source.width, source.height);
  const od = out.data;
  for (let i = 0; i < data.length; i += 4) {
    od[i] = Math.max(0, Math.min(255, (data[i] - p2) * gain));
    od[i + 1] = Math.max(0, Math.min(255, (data[i + 1] - p2) * gain));
    od[i + 2] = Math.max(0, Math.min(255, (data[i + 2] - p2) * gain));
    od[i + 3] = 255;
  }
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.putImageData(out, 0, 0);
  return canvas;
}

type DescribedOn = { descriptor: Float32Array; box: FaceBox; score: number };

/** Landmark-aligned descriptor from a prepared canvas (SSD preferred, tiny fallback). */
async function describeOn(canvas: HTMLCanvasElement, preferSsd: boolean): Promise<DescribedOn | null> {
  if (!api) return null;
  const useSsd = preferSsd && (await ensureStillDetector());
  const opts = useSsd
    ? new api.SsdMobilenetv1Options({ minConfidence: 0.3 })
    : new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.2 });
  const r = await api.detectSingleFace(canvas, opts).withFaceLandmarks().withFaceDescriptor();
  if (!r) return null;
  return {
    descriptor: r.descriptor,
    box: { x: r.detection.box.x, y: r.detection.box.y, width: r.detection.box.width, height: r.detection.box.height },
    score: r.detection.score,
  };
}

function meanDescriptor(list: Float32Array[]): Float32Array {
  const out = new Float32Array(list[0].length);
  for (const d of list) {
    for (let i = 0; i < out.length; i++) out[i] += d[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= list.length;
  return out;
}

/**
 * Robust still-photo face description: multi-detector location, enhanced crop
 * (margin + high-quality upscale), and a descriptor ensemble (crop / mirror /
 * contrast-normalized) fused into one identity embedding. Use this for
 * document portraits, selfies, and any single-frame identity evidence.
 */
export async function describeFaceRobust(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  onStep?: (msg: string) => void
): Promise<FaceDescription | null> {
  await loadFaceModels();
  if (!api) return null;
  const work = toWorkCanvas(input, 2000);
  if (!work) return null;
  onStep?.("Locating the face (multi-detector pass)…");
  const det = await detectBestFace(work.canvas);
  if (!det) return null;
  const sourceBoxWidth = det.box.width / work.scale;
  const inputBox: FaceBox = {
    x: det.box.x / work.scale,
    y: det.box.y / work.scale,
    width: det.box.width / work.scale,
    height: det.box.height / work.scale,
  };

  const crop = enhanceCrop(work.canvas, det.box);
  const enhancement: string[] = [];
  const variants: Float32Array[] = [];
  let cropBox: FaceBox | null = null;
  let bestScore = det.score;

  if (det.candidates > 1) enhancement.push(`main portrait selected from ${det.candidates} detected faces (ghost-portrait guard)`);

  if (crop) {
    enhancement.push(crop.scale > 1.01 ? `face crop upscaled ${crop.scale.toFixed(1)}× (high-quality interpolation)` : "face crop at native scale");

    // Roll alignment: descriptors degrade fast past a few degrees of in-plane
    // tilt, common when a document is photographed at an angle. All ensemble
    // variants derive from the aligned base when alignment succeeds.
    let baseCanvas = crop.canvas;
    const aligned = await alignByEyes(crop.canvas);
    if (aligned) {
      baseCanvas = aligned.canvas;
      enhancement.push(`roll-aligned ${aligned.rollDeg > 0 ? "+" : ""}${aligned.rollDeg}° via eye landmarks`);
    }

    onStep?.("Computing identity descriptors (ensemble)…");
    const primary = await describeOn(baseCanvas, true);
    if (primary) {
      variants.push(primary.descriptor);
      cropBox = primary.box;
      bestScore = Math.max(bestScore, primary.score);
    } else if (aligned) {
      // Alignment can occasionally push the face outside the detector's
      // comfort zone — fall back to the unaligned crop as primary.
      const unaligned = await describeOn(crop.canvas, true);
      if (unaligned) {
        baseCanvas = crop.canvas;
        variants.push(unaligned.descriptor);
        cropBox = unaligned.box;
        bestScore = Math.max(bestScore, unaligned.score);
        enhancement.push("alignment discarded (aligned face not re-detected)");
      }
    }
    const mirrored = mirrorCanvas(baseCanvas);
    if (mirrored) {
      const mir = await describeOn(mirrored, false);
      if (mir) {
        variants.push(mir.descriptor);
        enhancement.push("mirror variant");
      }
    }
    const normalized = normalizeContrast(baseCanvas);
    if (normalized) {
      const nrm = await describeOn(normalized, false);
      if (nrm) {
        variants.push(nrm.descriptor);
        enhancement.push("contrast-normalized variant (2–98 percentile stretch)");
      }
    }
    // Heavily upscaled crops are soft — an unsharp-masked variant recovers
    // edge detail the recognition net keys on.
    if (crop.scale > 1.8) {
      const sharpened = sharpenCanvas(baseCanvas);
      if (sharpened) {
        const shp = await describeOn(sharpened, false);
        if (shp) {
          variants.push(shp.descriptor);
          enhancement.push("unsharp-masked variant (soft upscaled crop)");
        }
      }
    }
    if (variants.length > 0 && cropBox) {
      const quality = assessQuality(baseCanvas, cropBox, bestScore, sourceBoxWidth);
      return {
        descriptor: variants.length > 1 ? meanDescriptor(variants) : variants[0],
        box: inputBox,
        detectionScore: Math.round(bestScore * 100) / 100,
        quality,
        variants,
        enhancement,
        detector: det.detector,
      };
    }
  }

  // Fallback: descriptor straight off the working frame (crop pipeline failed).
  onStep?.("Computing identity descriptor (full-frame fallback)…");
  const full = await describeOn(work.canvas, true);
  if (!full) return null;
  const quality = assessQuality(work.canvas, full.box, full.score, sourceBoxWidth);
  return {
    descriptor: full.descriptor,
    box: inputBox,
    detectionScore: Math.round(full.score * 100) / 100,
    quality,
    variants: [full.descriptor],
    enhancement: ["full-frame fallback (crop pipeline unavailable)"],
    detector: det.detector,
  };
}

/**
 * Fast per-frame expression sample for liveness (happy = smile intensity 0..1).
 *
 * Tuned for reliability at interactive rates: by default it skips the 68-point
 * landmark pass entirely (expressions only need the detection box), runs the
 * detector at a small input size for speed, and retries once at a larger input
 * size with a lower threshold when the fast pass misses — flickery per-frame
 * detection was the main cause of smile challenges "not registering".
 * Pass `withPose: true` to also get the yaw proxy (needs the landmark pass).
 */
export async function sampleExpression(video: HTMLVideoElement, opts?: { withPose?: boolean }): Promise<FaceExpressionSample | null> {
  if (!modelsReady || !api) return null;
  if (opts?.withPose) {
    const result = await api
      .detectSingleFace(video, new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.2 }))
      .withFaceLandmarks()
      .withFaceExpressions();
    if (!result) return null;
    const pts = result.landmarks.positions;
    // 68-landmark model: 0 and 16 are the jaw edges, 30 is the nose tip.
    const jawL = pts[0];
    const jawR = pts[16];
    const nose = pts[30];
    const span = jawR.x - jawL.x;
    const yaw = span > 1 ? Math.max(0, Math.min(1, (nose.x - jawL.x) / span)) : 0.5;
    return {
      happy: result.expressions.happy,
      neutral: result.expressions.neutral,
      yaw: Math.round(yaw * 100) / 100,
      box: { x: result.detection.box.x, y: result.detection.box.y, width: result.detection.box.width, height: result.detection.box.height },
      detectionScore: result.detection.score,
    };
  }
  const passes = [
    { inputSize: 320, scoreThreshold: 0.2 },
    { inputSize: 416, scoreThreshold: 0.15 },
  ];
  for (const p of passes) {
    const result = await api.detectSingleFace(video, new api.TinyFaceDetectorOptions(p)).withFaceExpressions();
    if (result) {
      return {
        happy: result.expressions.happy,
        neutral: result.expressions.neutral,
        yaw: 0.5,
        box: { x: result.detection.box.x, y: result.detection.box.y, width: result.detection.box.width, height: result.detection.box.height },
        detectionScore: result.detection.score,
      };
    }
  }
  return null;
}

export type DetectedFaceBox = { box: FaceBox; score: number };

/**
 * Fast all-faces detection for live overlay drawing and multi-face scans.
 * Returns every confident face box with its detection score, or null when
 * the models are not ready yet. Boxes are in source pixel coordinates.
 */
export async function detectFaceBoxes(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  opts?: { fast?: boolean }
): Promise<DetectedFaceBox[] | null> {
  if (!modelsReady || !api) return null;
  const detections = await api.detectAllFaces(
    input,
    new api.TinyFaceDetectorOptions({ inputSize: opts?.fast ? 320 : 416, scoreThreshold: 0.5 })
  );
  return detections.map((d) => ({
    box: { x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height },
    score: Math.round(d.score * 100) / 100,
  }));
}

/**
 * Counts all faces in a frame (coaching/coercion signal when >1 during a
 * verification capture). Returns -1 when models are not ready yet.
 */
export async function countFaces(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
  opts?: { fast?: boolean }
): Promise<number> {
  if (!modelsReady || !api) return -1;
  const detections = await api.detectAllFaces(
    input,
    new api.TinyFaceDetectorOptions({ inputSize: opts?.fast ? 320 : 416, scoreThreshold: 0.5 })
  );
  return detections.length;
}

export function faceDistance(a: Float32Array, b: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i] - b[i];
    acc += d * d;
  }
  return Math.sqrt(acc);
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Maps descriptor distance to a match outcome. Calibration follows the
 * dlib/FaceNet standard (same person typically < 0.6) adapted for the
 * document-portrait vs live-selfie case: match ≤ 0.55, mismatch ≥ 0.68,
 * in between = uncertain (request better captures rather than guessing).
 * Similarity uses a logistic curve centred on 0.6 so the percentage tracks
 * actual same-person probability instead of a linear guess.
 */
export function matchVerdict(distance: number): MatchOutcome {
  const similarity = Math.round(100 / (1 + Math.exp((distance - 0.6) / 0.09)));
  const d = round3(distance);
  if (distance <= MATCH_DISTANCE_MAX) return { verdict: "match", distance: d, similarity };
  if (distance >= MISMATCH_DISTANCE_MIN) return { verdict: "mismatch", distance: d, similarity };
  return { verdict: "uncertain", distance: d, similarity };
}

/**
 * Ensemble-aware identity comparison. Distances are computed between the fused
 * descriptors AND across every variant pair; the fused verdict uses
 * min(meanDistance, medianPairwise) — noise from any single bad variant cannot
 * push a genuine pair into mismatch territory, while true mismatches stay far
 * above the threshold on every aggregate.
 */
export function compareFaceDescriptions(a: FaceDescription, b: FaceDescription): EnsembleMatch {
  const va = a.variants && a.variants.length > 0 ? a.variants : [a.descriptor];
  const vb = b.variants && b.variants.length > 0 ? b.variants : [b.descriptor];
  const meanDistance = faceDistance(a.descriptor, b.descriptor);
  const pairs: number[] = [];
  for (const x of va) {
    for (const y of vb) pairs.push(faceDistance(x, y));
  }
  pairs.sort((p, q) => p - q);
  const bestDistance = pairs[0];
  const medianDistance = pairs[Math.floor(pairs.length / 2)];
  const fused = Math.min(meanDistance, medianDistance);
  const outcome = matchVerdict(fused);
  return {
    ...outcome,
    meanDistance: round3(meanDistance),
    bestDistance: round3(bestDistance),
    medianDistance: round3(medianDistance),
    pairsCompared: pairs.length,
  };
}
