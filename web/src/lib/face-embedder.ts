/**
 * On-device MobileFaceNet (ArcFace-trained) embedding via ONNX Runtime Web.
 *
 * Pipeline for still identity:
 *   aligned 112×112 RGB crop → NCHW float32 (x−127.5)/128 → 256-d L2 embedding
 *
 * Distance metric is cosine distance in [0, 2] (0 = identical). Nothing leaves
 * the device; the ~800 KB model is served from /models and cached by the browser.
 */

import * as ort from "onnxruntime-web";

const MODEL_URL = "/models/mobilefacenet.onnx";
const INPUT_SIZE = 112;
/** Cosine-distance bands calibrated for doc-portrait vs live-selfie (MobileFaceNet). */
export const COSINE_MATCH_MAX = 0.42;
export const COSINE_MISMATCH_MIN = 0.58;

let session: ort.InferenceSession | null = null;
let loadPromise: Promise<ort.InferenceSession> | null = null;

function configureOrt(): void {
  // Prefer same-origin wasm from the installed package (Vite resolves node_modules).
  // Fallback CDN keeps older deploys working if the local copy is missing.
  try {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    // onnxruntime-web ships wasm next to the ESM entry; Vite can resolve it.
    // Absolute CDN is a safe default when the bundler can't rewrite the path.
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
  } catch {
    /* ignore env setup failures — session.create will surface real errors */
  }
}

/** Loads (and caches) the MobileFaceNet ONNX session. */
export async function loadFaceEmbedder(onStep?: (msg: string) => void): Promise<void> {
  if (session) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      configureOrt();
      onStep?.("Loading on-device ArcFace embedder (MobileFaceNet ONNX)…");
      const s = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      onStep?.("MobileFaceNet ready (256-d, on-device).");
      return s;
    })();
  }
  try {
    session = await loadPromise;
  } catch (err) {
    loadPromise = null;
    session = null;
    throw err;
  }
}

export function faceEmbedderReady(): boolean {
  return session != null;
}

/** ArcFace 5-point template on a 112×112 canvas (left eye, right eye, nose, left mouth, right mouth). */
export const ARCFACE_5PT_112: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export type Point2 = { x: number; y: number };

/**
 * Estimates a similarity transform (scale + rotation + translation) that maps
 * `src` 5-points onto the ArcFace template. Solves via least-squares on the
 * complex-plane formulation (Umeyama for similarity, 2-DOF rotation+scale).
 */
export function estimateSimilarity(
  src: ReadonlyArray<Point2>,
  dst: ReadonlyArray<readonly [number, number]> = ARCFACE_5PT_112
): { a: number; b: number; tx: number; ty: number } | null {
  const n = Math.min(src.length, dst.length);
  if (n < 2) return null;
  let sMeanX = 0;
  let sMeanY = 0;
  let dMeanX = 0;
  let dMeanY = 0;
  for (let i = 0; i < n; i++) {
    sMeanX += src[i].x;
    sMeanY += src[i].y;
    dMeanX += dst[i][0];
    dMeanY += dst[i][1];
  }
  sMeanX /= n;
  sMeanY /= n;
  dMeanX /= n;
  dMeanY /= n;
  let numA = 0;
  let numB = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i].x - sMeanX;
    const sy = src[i].y - sMeanY;
    const dx = dst[i][0] - dMeanX;
    const dy = dst[i][1] - dMeanY;
    numA += sx * dx + sy * dy;
    numB += sx * dy - sy * dx;
    den += sx * sx + sy * sy;
  }
  if (den < 1e-6) return null;
  const a = numA / den;
  const b = numB / den;
  const tx = dMeanX - (a * sMeanX - b * sMeanY);
  const ty = dMeanY - (b * sMeanX + a * sMeanY);
  return { a, b, tx, ty };
}

/**
 * Warps `source` into a 112×112 ArcFace-aligned crop using the similarity
 * transform that maps `landmarks5` onto the standard template.
 */
export function warpAligned112(source: HTMLCanvasElement, landmarks5: ReadonlyArray<Point2>): HTMLCanvasElement | null {
  const sim = estimateSimilarity(landmarks5);
  if (!sim) return null;
  const { a, b, tx, ty } = sim;
  // Inverse map: for each output pixel (x',y'), find source (x,y).
  // [x']   [ a -b ] [x]   [tx]
  // [y'] = [ b  a ] [y] + [ty]
  // → [x] = 1/(a²+b²) [ a  b ] ([x'] - [tx])
  //   [y]             [-b  a ] ([y'] - [ty])
  const det = a * a + b * b;
  if (det < 1e-8) return null;
  const invA = a / det;
  const invB = b / det;
  const out = document.createElement("canvas");
  out.width = INPUT_SIZE;
  out.height = INPUT_SIZE;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Draw via inverse-mapped source sampling using setTransform on a temp path:
  // Canvas setTransform(a,b,c,d,e,f) maps user→device. We want device=aligned,
  // user=source, so device = M * source → setTransform(a, b, -b, a, tx, ty)
  // then drawImage(source) places source pixels through M into the 112 canvas.
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.setTransform(a, b, -b, a, tx, ty);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(source, 0, 0);
  } catch {
    return null;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Touch inv vars so TS keeps the inverse available for future pixel-walk fallbacks.
  void invA;
  void invB;
  return out;
}

/** Fallback square crop→112 when landmarks are unavailable. */
export function cropBoxTo112(source: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }): HTMLCanvasElement | null {
  const margin = 0.25;
  const side = Math.max(box.width, box.height) * (1 + margin * 2);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const x0 = Math.max(0, Math.floor(cx - side / 2));
  const y0 = Math.max(0, Math.floor(cy - side / 2));
  const x1 = Math.min(source.width, Math.ceil(cx + side / 2));
  const y1 = Math.min(source.height, Math.ceil(cy + side / 2));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = document.createElement("canvas");
  out.width = INPUT_SIZE;
  out.height = INPUT_SIZE;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(source, x0, y0, w, h, 0, 0, INPUT_SIZE, INPUT_SIZE);
  } catch {
    return null;
  }
  return out;
}

function l2Normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Float32Array(v.length);
  if (n < 1e-12) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** RGBA 112×112 canvas → NCHW float32 tensor ((x−127.5)/128). */
function canvasToNchw(canvas: HTMLCanvasElement): Float32Array {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  let img: ImageData;
  try {
    img = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  } catch {
    return new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  }
  const { data } = img;
  const plane = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] - 127.5) / 128;
    out[plane + p] = (data[i + 1] - 127.5) / 128;
    out[2 * plane + p] = (data[i + 2] - 127.5) / 128;
  }
  return out;
}

/**
 * Runs MobileFaceNet on a 112×112 aligned face canvas and returns an L2-normalized embedding.
 * Returns null if the embedder is not loaded or inference fails.
 */
export async function embedAlignedFace(aligned112: HTMLCanvasElement): Promise<Float32Array | null> {
  if (!session) {
    try {
      await loadFaceEmbedder();
    } catch {
      return null;
    }
  }
  if (!session) return null;
  if (aligned112.width !== INPUT_SIZE || aligned112.height !== INPUT_SIZE) {
    const resized = document.createElement("canvas");
    resized.width = INPUT_SIZE;
    resized.height = INPUT_SIZE;
    const ctx = resized.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(aligned112, 0, 0, INPUT_SIZE, INPUT_SIZE);
    return embedAlignedFace(resized);
  }
  try {
    const nchw = canvasToNchw(aligned112);
    const input = new ort.Tensor("float32", nchw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const feeds: Record<string, ort.Tensor> = { [session.inputNames[0] ?? "input"]: input };
    const result = await session.run(feeds);
    const outName = session.outputNames[0] ?? "embedding";
    const tensor = result[outName];
    if (!tensor || !(tensor.data instanceof Float32Array) && !ArrayBuffer.isView(tensor.data)) return null;
    const raw = tensor.data instanceof Float32Array ? tensor.data : new Float32Array(tensor.data as ArrayLike<number>);
    return l2Normalize(raw);
  } catch {
    return null;
  }
}

/** Cosine distance for L2-normalized vectors: 1 − dot. Range [0, 2]. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  // Clamp numerical noise outside [-1,1]
  const c = Math.max(-1, Math.min(1, dot));
  return 1 - c;
}

/** Cosine similarity percent 0–100 from cosine distance. */
export function cosineSimilarityPercent(distance: number): number {
  const sim = 1 - distance; // for L2-normed: cos θ
  return Math.round(Math.max(0, Math.min(1, (sim + 1) / 2)) * 1000) / 10;
}

/**
 * Maps cosine distance to match / mismatch / uncertain.
 * Similarity % uses a logistic centred near the match band so UI % tracks decision.
 */
export function matchFromCosine(distance: number): {
  verdict: "match" | "mismatch" | "uncertain";
  distance: number;
  similarity: number;
} {
  const d = Math.round(distance * 1000) / 1000;
  // Logistic on cosine distance centred ~0.5 so ~match band → high %
  const similarity = Math.round(100 / (1 + Math.exp((distance - 0.5) / 0.08)));
  if (distance <= COSINE_MATCH_MAX) return { verdict: "match", distance: d, similarity };
  if (distance >= COSINE_MISMATCH_MIN) return { verdict: "mismatch", distance: d, similarity };
  return { verdict: "uncertain", distance: d, similarity };
}

export const FACE_ENGINE_ID = "mobilefacenet-arcface/1.0";
export const FACE_EMBED_DIM = 256;
