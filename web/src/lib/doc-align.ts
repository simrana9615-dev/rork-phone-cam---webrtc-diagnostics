/**
 * Live document-alignment analysis for the WebRTC viewfinder.
 *
 * Every ~200ms a downscaled frame is inspected against the framing guide:
 * - edge coverage: strong luminance gradients must sit near all four guide
 *   borders (the physical document edges lining up with the overlay)
 * - corner lock: each guide corner is "locked" when both adjacent document
 *   edges are detected near that corner
 * - perspective skew: each detected edge is line-fitted; converging opposite
 *   edges (trapezoid) mean the phone is tilted relative to the document —
 *   the skew percentage and a directional tilt hint coach the user flat
 * - sharpness: Laplacian variance inside the guide (focus indicator)
 * - brightness: interior mean luminance (too dark / blown-out glare)
 * - steadiness: mean abs frame difference vs the previous analysis frame
 *
 * All work happens on a 160px-wide canvas, costing well under a millisecond
 * per tick — cheap enough to run continuously alongside the fps meter.
 */

export type CornerLocks = { tl: boolean; tr: boolean; br: boolean; bl: boolean };

export type AlignmentSnapshot = {
  /** Strong edges found along all four guide borders. */
  docDetected: boolean;
  sharp: boolean;
  bright: boolean;
  steady: boolean;
  /**
   * Low perspective distortion: opposite document edges are parallel enough.
   * True when skew is unmeasurable (never blocks on missing evidence).
   */
  flat: boolean;
  /** Everything passed — the frame is capture-worthy right now. */
  ready: boolean;
  /** Single actionable instruction for the user, priority-ordered. */
  hint: string;
  sharpness: number;
  brightness: number;
  motion: number;
  /** Trapezoid convergence of opposite edges as a percentage; null = not measurable this tick. */
  skewPct: number | null;
  /** Per-corner lock state — both adjacent document edges detected near the corner. */
  corners: CornerLocks;
  coverage: { top: number; right: number; bottom: number; left: number };
};

const ANALYSIS_WIDTH = 160;
const EDGE_SAMPLES = 24;
const SHARPNESS_MIN = 30;
const BRIGHT_MIN = 55;
const BRIGHT_MAX = 235;
const MOTION_MAX = 6;
/** Skew above this % of edge convergence = meaningful perspective distortion. */
const FLAT_MAX_PCT = 7;
/** Minimum edge hits (of EDGE_SAMPLES) and spread needed to trust a line fit. */
const FIT_MIN_HITS = 6;
const FIT_MIN_SPREAD = 0.4;

type EdgeScan = {
  coverage: number;
  /** Detected edge points: fraction along the side (0→1) and the perpendicular coordinate. */
  points: { f: number; p: number }[];
};

type LineFit = { a: number; b: number } | null;

/** Least-squares fit p = a + b·f over the detected edge points; null when too thin to trust. */
function fitEdge(points: { f: number; p: number }[]): LineFit {
  if (points.length < FIT_MIN_HITS) return null;
  const fs = points.map((pt) => pt.f);
  if (Math.max(...fs) - Math.min(...fs) < FIT_MIN_SPREAD) return null;
  const n = points.length;
  let sf = 0;
  let sp = 0;
  let sff = 0;
  let sfp = 0;
  for (const pt of points) {
    sf += pt.f;
    sp += pt.p;
    sff += pt.f * pt.f;
    sfp += pt.f * pt.p;
  }
  const denom = n * sff - sf * sf;
  if (Math.abs(denom) < 1e-6) return null;
  const b = (n * sfp - sf * sp) / denom;
  const a = (sp - b * sf) / n;
  return { a, b };
}

/** True when the side has an edge hit within the given fraction range. */
function hasHitIn(points: { f: number; p: number }[], lo: number, hi: number): boolean {
  return points.some((pt) => pt.f >= lo && pt.f <= hi);
}

/**
 * Reusable analyzer holding the offscreen canvas and the previous frame for
 * motion estimation. Create once per viewfinder session.
 */
export class DocAlignmentAnalyzer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private prevGray: Float32Array | null = null;
  private prevW = 0;
  private prevH = 0;

  /** Drops the previous-frame reference (call when the stream restarts). */
  reset(): void {
    this.prevGray = null;
  }

  analyze(video: HTMLVideoElement, guideAspect: number): AlignmentSnapshot | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const w = ANALYSIS_WIDTH;
    const h = Math.max(40, Math.round((w * vh) / vw));
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return null;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    let data: Uint8ClampedArray;
    try {
      ctx.drawImage(video, 0, 0, w, h);
      data = ctx.getImageData(0, 0, w, h).data;
    } catch {
      return null;
    }
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }

    // Motion vs previous analysis frame (255 on the very first tick so the
    // session never auto-fires before a stability baseline exists).
    let motion = 255;
    if (this.prevGray && this.prevW === w && this.prevH === h) {
      let acc = 0;
      let n = 0;
      for (let i = 0; i < gray.length; i += 4) {
        acc += Math.abs(gray[i] - this.prevGray[i]);
        n++;
      }
      motion = n > 0 ? acc / n : 255;
    }
    this.prevGray = gray;
    this.prevW = w;
    this.prevH = h;

    // Guide rectangle — mirrors the overlay geometry (padded, centered,
    // width- or height-bound depending on which axis binds).
    const pad = Math.max(3, Math.round(0.06 * Math.min(w, h)));
    const availW = w - 2 * pad;
    const availH = h - 2 * pad;
    let gw: number;
    let gh: number;
    if (availW / availH <= guideAspect) {
      gw = availW;
      gh = gw / guideAspect;
    } else {
      gh = availH;
      gw = gh * guideAspect;
    }
    const gx = (w - gw) / 2;
    const gy = (h - gh) / 2;

    const grad = (x: number, y: number, horizontal: boolean): number => {
      const xi = Math.min(w - 2, Math.max(1, Math.round(x)));
      const yi = Math.min(h - 2, Math.max(1, Math.round(y)));
      return horizontal
        ? Math.abs(gray[yi * w + xi + 1] - gray[yi * w + xi - 1])
        : Math.abs(gray[(yi + 1) * w + xi] - gray[(yi - 1) * w + xi]);
    };

    // Adaptive edge threshold: a busy scene raises the bar so background
    // clutter doesn't read as document edges.
    let gAcc = 0;
    let gN = 0;
    for (let y = 1; y < h - 1; y += 3) {
      for (let x = 1; x < w - 1; x += 3) {
        gAcc += Math.abs(gray[y * w + x + 1] - gray[y * w + x - 1]) + Math.abs(gray[(y + 1) * w + x] - gray[(y - 1) * w + x]);
        gN++;
      }
    }
    const thresh = Math.max(14, (gAcc / Math.max(1, gN)) * 2.2);

    const band = Math.max(3, Math.round(Math.min(gw, gh) * 0.1));
    /**
     * Scans one guide side: at each sample, finds the strongest perpendicular
     * gradient within the band and records WHERE the edge actually sits —
     * the recorded positions feed the perspective line fits.
     */
    const scanSide = (side: "top" | "bottom" | "left" | "right"): EdgeScan => {
      const points: { f: number; p: number }[] = [];
      let hit = 0;
      for (let s = 0; s < EDGE_SAMPLES; s++) {
        const f = 0.08 + (0.84 * s) / (EDGE_SAMPLES - 1);
        let best = 0;
        let bestPos = 0;
        if (side === "top" || side === "bottom") {
          const x = gx + gw * f;
          const yc = side === "top" ? gy : gy + gh;
          for (let dy = -band; dy <= band; dy++) {
            const g = grad(x, yc + dy, false);
            if (g > best) {
              best = g;
              bestPos = yc + dy;
            }
          }
        } else {
          const y = gy + gh * f;
          const xc = side === "left" ? gx : gx + gw;
          for (let dx = -band; dx <= band; dx++) {
            const g = grad(xc + dx, y, true);
            if (g > best) {
              best = g;
              bestPos = xc + dx;
            }
          }
        }
        if (best >= thresh) {
          hit++;
          points.push({ f, p: bestPos });
        }
      }
      return { coverage: hit / EDGE_SAMPLES, points };
    };

    const top = scanSide("top");
    const right = scanSide("right");
    const bottom = scanSide("bottom");
    const left = scanSide("left");
    const coverage = { top: top.coverage, right: right.coverage, bottom: bottom.coverage, left: left.coverage };
    const covs = [coverage.top, coverage.right, coverage.bottom, coverage.left];
    const minCov = Math.min(...covs);
    const avgCov = covs.reduce((a, b) => a + b, 0) / 4;
    const docDetected = minCov >= 0.3 && avgCov >= 0.5;

    // Corner locks: both adjacent edges detected near the corner. For
    // top/bottom sides f runs left→right; for left/right sides f runs top→bottom.
    const corners: CornerLocks = {
      tl: hasHitIn(top.points, 0, 0.34) && hasHitIn(left.points, 0, 0.34),
      tr: hasHitIn(top.points, 0.66, 1) && hasHitIn(right.points, 0, 0.34),
      br: hasHitIn(bottom.points, 0.66, 1) && hasHitIn(right.points, 0.66, 1),
      bl: hasHitIn(bottom.points, 0, 0.34) && hasHitIn(left.points, 0.66, 1),
    };

    // Perspective skew: line-fit each detected edge and compare apparent
    // document width at the top vs bottom (and height left vs right). A
    // trapezoid means the sensor plane is tilted relative to the document.
    const leftFit = fitEdge(left.points);
    const rightFit = fitEdge(right.points);
    const topFit = fitEdge(top.points);
    const bottomFit = fitEdge(bottom.points);

    let skewX: number | null = null; // + = top wider than bottom
    if (leftFit && rightFit) {
      const widthTop = rightFit.a - leftFit.a;
      const widthBottom = rightFit.a + rightFit.b - (leftFit.a + leftFit.b);
      const avg = (widthTop + widthBottom) / 2;
      if (avg > gw * 0.5) skewX = (widthTop - widthBottom) / avg;
    }
    let skewY: number | null = null; // + = left taller than right
    if (topFit && bottomFit) {
      const heightLeft = bottomFit.a - topFit.a;
      const heightRight = bottomFit.a + bottomFit.b - (topFit.a + topFit.b);
      const avg = (heightLeft + heightRight) / 2;
      if (avg > gh * 0.5) skewY = (heightLeft - heightRight) / avg;
    }
    const skewAbs = Math.max(Math.abs(skewX ?? 0), Math.abs(skewY ?? 0));
    const skewPct = skewX == null && skewY == null ? null : Math.round(skewAbs * 100);
    // Unmeasurable skew never blocks — only measured, corroborated convergence does.
    const flat = skewPct == null || skewPct <= FLAT_MAX_PCT;

    /** Directional coaching for the dominant tilt axis. */
    const tiltHint = (): string => {
      const xDominant = Math.abs(skewX ?? 0) >= Math.abs(skewY ?? 0);
      if (xDominant && skewX != null) {
        return skewX < 0
          ? "Tilt the top of your phone down — the top edge looks smaller"
          : "Tilt the bottom of your phone down — the bottom edge looks smaller";
      }
      if (skewY != null) {
        return skewY < 0
          ? "Lower the left side of your phone — the left edge looks smaller"
          : "Lower the right side of your phone — the right edge looks smaller";
      }
      return "Hold the phone directly above the document, parallel to it";
    };

    // Interior sharpness (Laplacian variance) and mean brightness.
    const ix0 = Math.max(1, Math.round(gx + gw * 0.15));
    const ix1 = Math.min(w - 1, Math.round(gx + gw * 0.85));
    const iy0 = Math.max(1, Math.round(gy + gh * 0.15));
    const iy1 = Math.min(h - 1, Math.round(gy + gh * 0.85));
    let lapAcc = 0;
    let lapSq = 0;
    let briAcc = 0;
    let ln = 0;
    for (let y = iy0; y < iy1; y += 2) {
      for (let x = ix0; x < ix1; x += 2) {
        const c = gray[y * w + x];
        const lap = 4 * c - gray[y * w + x - 1] - gray[y * w + x + 1] - gray[(y - 1) * w + x] - gray[(y + 1) * w + x];
        lapAcc += lap;
        lapSq += lap * lap;
        briAcc += c;
        ln++;
      }
    }
    const sharpness = ln > 0 ? lapSq / ln - (lapAcc / ln) ** 2 : 0;
    const brightness = ln > 0 ? briAcc / ln : 0;

    const sharp = sharpness >= SHARPNESS_MIN;
    const bright = brightness >= BRIGHT_MIN && brightness <= BRIGHT_MAX;
    const steady = motion <= MOTION_MAX;
    const ready = docDetected && sharp && bright && steady && flat;

    const hint = !bright
      ? brightness < BRIGHT_MIN
        ? "Too dark — add light or turn on the torch"
        : "Too bright — tilt away from the glare"
      : !docDetected
        ? avgCov >= 0.32
          ? "Almost — line the edges up with the frame"
          : "Fit the document inside the frame"
        : !flat
          ? tiltHint()
          : !steady
            ? "Hold still…"
            : !sharp
              ? "Hold steady — focusing…"
              : "Perfect — hold it there";

    return {
      docDetected,
      sharp,
      bright,
      steady,
      flat,
      ready,
      hint,
      sharpness: Math.round(sharpness),
      brightness: Math.round(brightness),
      motion: Math.round(motion * 10) / 10,
      skewPct,
      corners,
      coverage: {
        top: Math.round(coverage.top * 100) / 100,
        right: Math.round(coverage.right * 100) / 100,
        bottom: Math.round(coverage.bottom * 100) / 100,
        left: Math.round(coverage.left * 100) / 100,
      },
    };
  }
}
