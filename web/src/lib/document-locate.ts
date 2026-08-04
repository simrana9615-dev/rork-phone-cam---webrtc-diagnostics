/**
 * Geometric document localization.
 *
 * WHY THIS REPLACES THE OLD MEASURE: "is this a document?" used to mean
 * `paperFraction > 0.35`, i.e. more than 35% of the frame brighter than luma 195.
 * That is a test for *white paper filling the frame*, not for a document:
 *   - a driving licence is a coloured, laminated card, not white paper;
 *   - held over a dark table or a lap, bright pixels can be well under 35%;
 *   - conversely a blank sheet, a bright wall, or an overexposed sky passes it.
 * So genuine IDs were told to "recapture the document flat" while non-documents
 * sailed through, and every downstream text/tamper statistic was averaged over
 * the table behind the card as well as the card itself.
 *
 * The rebuild finds the document as a geometric object: segment it from the
 * frame border's own colour statistics, clean the mask morphologically, take the
 * largest connected region, fit a minimum-area rectangle by rotating calipers,
 * then judge it on rectangularity, frame fill and aspect ratio against real
 * document standards. Downstream analysis is cropped and deskewed to that
 * rectangle, so paper statistics describe the paper only.
 */

export type Point = { x: number; y: number };

export type DocumentQuad = {
  /** Minimum-area rectangle corners, in source-image pixel coordinates. */
  corners: Point[];
  center: Point;
  /** Long side, source pixels. */
  widthPx: number;
  /** Short side, source pixels. */
  heightPx: number;
  /** Rotation of the long side from horizontal, −90..90 degrees. */
  angleDeg: number;
  /** Long side / short side. */
  aspect: number;
  /** Rectangle area as a share of the whole frame. */
  fillFraction: number;
  /** Segmented region area / rectangle area — 1.0 is a perfect rectangle. */
  rectangularity: number;
};

export type DocumentStandard = { id: string; label: string; aspect: number };

/** Real document proportions. ID-1 and TD3 are ISO/ICAO definitions. */
export const DOCUMENT_STANDARDS: DocumentStandard[] = [
  { id: "id-1", label: "ID-1 card (ISO/IEC 7810, 85.6×53.98mm)", aspect: 1.586 },
  { id: "td3", label: "Passport data page (ICAO TD3, 125×88mm)", aspect: 1.42 },
  { id: "a4", label: "A4 / ISO 216 sheet", aspect: 1.414 },
  { id: "letter", label: "US Letter sheet", aspect: 1.294 },
];

export type DocumentLocation = {
  found: boolean;
  quad: DocumentQuad | null;
  /** Closest standard within 9% of the measured aspect, if any. */
  matchedStandard: DocumentStandard | null;
  /** Aspect inside the plausible document band once perspective is allowed for. */
  aspectPlausible: boolean;
  /** Plain-language reason when no document was located. */
  reason: string;
  analysisWidth: number;
  analysisHeight: number;
  /** Share of analysis pixels classified as foreground before cleanup. */
  foregroundFraction: number;
};

/** Perspective foreshortening on a hand-held capture can shift aspect by ~25%. */
const ASPECT_MIN = 1.12;
const ASPECT_MAX = 2.1;
const MIN_RECTANGULARITY = 0.78;
const MIN_FILL = 0.12;
const ANALYSIS_EDGE = 384;

type Mask = { data: Uint8Array; w: number; h: number };

function integralImage(mask: Mask): Int32Array {
  const { data, w, h } = mask;
  const ii = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += data[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + rowSum;
    }
  }
  return ii;
}

function boxSum(ii: Int32Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  const stride = w + 1;
  return (
    ii[(y1 + 1) * stride + x1 + 1] - ii[y0 * stride + x1 + 1] - ii[(y1 + 1) * stride + x0] + ii[y0 * stride + x0]
  );
}

/** Morphological dilate/erode via an integral image — O(pixels) at any radius. */
function morph(mask: Mask, radius: number, mode: "dilate" | "erode"): Mask {
  const { w, h } = mask;
  const ii = integralImage(mask);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const sum = boxSum(ii, w, x0, y0, x1, y1);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      out[y * w + x] = mode === "dilate" ? (sum > 0 ? 1 : 0) : sum === area ? 1 : 0;
    }
  }
  return { data: out, w, h };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Andrew's monotone chain convex hull. */
function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

type RotRect = { center: Point; halfW: number; halfH: number; angle: number; area: number };

/** Minimum-area enclosing rectangle by rotating calipers over hull edges. */
function minAreaRect(hull: Point[]): RotRect | null {
  if (hull.length < 3) return null;
  let best: RotRect | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * cos - p.y * sin;
      const v = p.x * sin + p.y * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;
    if (area <= 0) continue;
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      // Rotate the centre back into image space.
      const cx = cu * Math.cos(angle) - cv * Math.sin(angle);
      const cy = cu * Math.sin(angle) + cv * Math.cos(angle);
      best = { center: { x: cx, y: cy }, halfW: width / 2, halfH: height / 2, angle, area };
    }
  }
  return best;
}

function rectCorners(rect: RotRect, scale: number): Point[] {
  const cos = Math.cos(rect.angle);
  const sin = Math.sin(rect.angle);
  const offsets: Point[] = [
    { x: -rect.halfW, y: -rect.halfH },
    { x: rect.halfW, y: -rect.halfH },
    { x: rect.halfW, y: rect.halfH },
    { x: -rect.halfW, y: rect.halfH },
  ];
  return offsets.map((o) => ({
    x: (rect.center.x + o.x * cos - o.y * sin) * scale,
    y: (rect.center.y + o.x * sin + o.y * cos) * scale,
  }));
}

function notFound(reason: string, w: number, h: number, fg: number): DocumentLocation {
  return {
    found: false,
    quad: null,
    matchedStandard: null,
    aspectPlausible: false,
    reason,
    analysisWidth: w,
    analysisHeight: h,
    foregroundFraction: Math.round(fg * 1000) / 1000,
  };
}

/**
 * Locates the dominant document-shaped object in the frame.
 * Works on colour separation from the frame border plus local texture, so it does
 * not assume the document is white or that the background is dark.
 */
export function locateDocument(source: HTMLImageElement | HTMLCanvasElement): DocumentLocation {
  const srcW = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const srcH = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!srcW || !srcH) return notFound("Image has no decodable dimensions.", 0, 0, 0);

  const scale = Math.min(1, ANALYSIS_EDGE / Math.max(srcW, srcH));
  const w = Math.max(32, Math.round(srcW * scale));
  const h = Math.max(32, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return notFound("Canvas unavailable for analysis.", w, h, 0);
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    r[p] = data[i];
    g[p] = data[i + 1];
    b[p] = data[i + 2];
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // Background model taken from the outer 7% frame — whatever the document is
  // lying on. No assumption that it is dark or light.
  const bandX = Math.max(2, Math.round(w * 0.07));
  const bandY = Math.max(2, Math.round(h * 0.07));
  const bR: number[] = [];
  const bG: number[] = [];
  const bB: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= bandX && x < w - bandX && y >= bandY && y < h - bandY) continue;
      const p = y * w + x;
      bR.push(r[p]);
      bG.push(g[p]);
      bB.push(b[p]);
    }
  }
  const mR = median(bR);
  const mG = median(bG);
  const mB = median(bB);
  const spread = median(bR.map((v, i) => Math.abs(v - mR) + Math.abs(bG[i] - mG) + Math.abs(bB[i] - mB)));

  // Local texture: documents carry print detail; most surfaces they rest on do not.
  const texture = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = Math.abs(lum[p + 1] - lum[p - 1]);
      const gy = Math.abs(lum[p + w] - lum[p - w]);
      texture[p] = gx + gy;
    }
  }
  const textureThreshold = Math.max(14, median(Array.from(texture).filter((v) => v > 0)) * 2.5);
  const colorThreshold = Math.max(26, spread * 2.6);

  const raw = new Uint8Array(w * h);
  let fgCount = 0;
  for (let p = 0; p < raw.length; p++) {
    const dist = Math.abs(r[p] - mR) + Math.abs(g[p] - mG) + Math.abs(b[p] - mB);
    const isFg = dist > colorThreshold || texture[p] > textureThreshold ? 1 : 0;
    raw[p] = isFg;
    fgCount += isFg;
  }
  const foregroundFraction = fgCount / raw.length;
  if (foregroundFraction < 0.04) {
    return notFound(
      "Nothing in the frame separates from the background — the frame looks uniform, with no document-shaped object in it.",
      w,
      h,
      foregroundFraction
    );
  }

  // Close (dilate→erode) joins print detail into a solid card; open (erode→dilate)
  // drops thin clutter such as fingers and table edges.
  const radius = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  let mask: Mask = { data: raw, w, h };
  mask = morph(mask, radius, "dilate");
  mask = morph(mask, radius, "erode");
  mask = morph(mask, Math.max(1, radius - 1), "erode");
  mask = morph(mask, Math.max(1, radius - 1), "dilate");

  // Largest connected component (4-neighbour, iterative to avoid stack overflow).
  const labels = new Int32Array(w * h).fill(-1);
  let bestLabel = -1;
  let bestSize = 0;
  let label = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.data.length; start++) {
    if (mask.data[start] === 0 || labels[start] !== -1) continue;
    let size = 0;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      size += 1;
      const cx = cur % w;
      const cy = (cur - cx) / w;
      if (cx > 0 && mask.data[cur - 1] === 1 && labels[cur - 1] === -1) {
        labels[cur - 1] = label;
        stack.push(cur - 1);
      }
      if (cx < w - 1 && mask.data[cur + 1] === 1 && labels[cur + 1] === -1) {
        labels[cur + 1] = label;
        stack.push(cur + 1);
      }
      if (cy > 0 && mask.data[cur - w] === 1 && labels[cur - w] === -1) {
        labels[cur - w] = label;
        stack.push(cur - w);
      }
      if (cy < h - 1 && mask.data[cur + w] === 1 && labels[cur + w] === -1) {
        labels[cur + w] = label;
        stack.push(cur + w);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
    label += 1;
  }
  if (bestLabel < 0 || bestSize < w * h * 0.03) {
    return notFound(
      "No single connected object large enough to be a document — the frame is either empty or too cluttered to isolate one.",
      w,
      h,
      foregroundFraction
    );
  }

  // Boundary pixels only: enough for a convex hull, far cheaper than every pixel.
  const boundary: Point[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (labels[p] !== bestLabel) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        labels[p - 1] !== bestLabel ||
        labels[p + 1] !== bestLabel ||
        labels[p - w] !== bestLabel ||
        labels[p + w] !== bestLabel;
      if (edge) boundary.push({ x, y });
    }
  }
  const hull = convexHull(boundary);
  const rect = minAreaRect(hull);
  if (!rect) return notFound("Could not fit a rectangle to the detected object.", w, h, foregroundFraction);

  const longSide = Math.max(rect.halfW, rect.halfH) * 2;
  const shortSide = Math.min(rect.halfW, rect.halfH) * 2;
  if (shortSide < 8) return notFound("Detected object is too thin to be a document.", w, h, foregroundFraction);

  const aspect = longSide / shortSide;
  const rectangularity = bestSize / rect.area;
  const fillFraction = rect.area / (w * h);
  const invScale = 1 / scale;
  // Report the long side's rotation, normalised to −90..90.
  let angleDeg = (rect.halfW >= rect.halfH ? rect.angle : rect.angle + Math.PI / 2) * (180 / Math.PI);
  while (angleDeg > 90) angleDeg -= 180;
  while (angleDeg < -90) angleDeg += 180;

  const quad: DocumentQuad = {
    corners: rectCorners(rect, invScale),
    center: { x: rect.center.x * invScale, y: rect.center.y * invScale },
    widthPx: Math.round(longSide * invScale),
    heightPx: Math.round(shortSide * invScale),
    angleDeg: Math.round(angleDeg * 10) / 10,
    aspect: Math.round(aspect * 1000) / 1000,
    fillFraction: Math.round(fillFraction * 1000) / 1000,
    rectangularity: Math.round(Math.min(rectangularity, 1) * 1000) / 1000,
  };

  const matchedStandard =
    DOCUMENT_STANDARDS.find((s) => Math.abs(aspect - s.aspect) / s.aspect <= 0.09) ?? null;
  const aspectPlausible = aspect >= ASPECT_MIN && aspect <= ASPECT_MAX;
  const shapeOk = quad.rectangularity >= MIN_RECTANGULARITY;
  const fillOk = quad.fillFraction >= MIN_FILL;

  const reasons: string[] = [];
  if (!shapeOk) reasons.push(`the detected object fills only ${(quad.rectangularity * 100).toFixed(0)}% of its own bounding rectangle, so it is not rectangular`);
  if (!fillOk) reasons.push(`it covers just ${(quad.fillFraction * 100).toFixed(0)}% of the frame (needs ≥${MIN_FILL * 100}%)`);
  if (!aspectPlausible) reasons.push(`its proportions are ${aspect.toFixed(2)}:1, outside the ${ASPECT_MIN}–${ASPECT_MAX} band that real documents occupy`);

  return {
    found: shapeOk && fillOk && aspectPlausible,
    quad,
    matchedStandard,
    aspectPlausible,
    reason:
      shapeOk && fillOk && aspectPlausible
        ? `Rectangular object located: ${quad.widthPx}×${quad.heightPx}px at ${quad.angleDeg}°, ${(quad.fillFraction * 100).toFixed(0)}% of the frame, ${aspect.toFixed(2)}:1${matchedStandard ? ` — matches ${matchedStandard.label}` : ""}.`
        : `A dominant object was found but ${reasons.join("; ")}.`,
    analysisWidth: w,
    analysisHeight: h,
    foregroundFraction: Math.round(foregroundFraction * 1000) / 1000,
  };
}

/**
 * Crops and deskews the located document into its own canvas so downstream
 * paper/text statistics describe the document instead of the whole scene.
 */
export function cropDocument(
  source: HTMLImageElement | HTMLCanvasElement,
  quad: DocumentQuad,
  maxEdge: number
): HTMLCanvasElement | null {
  const longSide = Math.max(quad.widthPx, quad.heightPx);
  const shortSide = Math.min(quad.widthPx, quad.heightPx);
  if (longSide < 16 || shortSide < 16) return null;
  const scale = Math.min(1, maxEdge / longSide);
  const outW = Math.max(16, Math.round(longSide * scale));
  const outH = Math.max(16, Math.round(shortSide * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((-quad.angleDeg * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.translate(-quad.center.x, -quad.center.y);
  try {
    ctx.drawImage(source, 0, 0);
  } catch {
    ctx.restore();
    return null;
  }
  ctx.restore();
  return canvas;
}
