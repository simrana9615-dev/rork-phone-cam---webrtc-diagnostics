/**
 * Instant capture quality gate: fast, fully-local sharpness / glare / exposure
 * screening that runs the moment a document page is captured, so obviously
 * unusable frames get a "retake now" prompt before the user moves on.
 *
 * Thresholds are deliberately conservative — only clearly degraded captures
 * trigger the gate, matching the project's no-false-positives policy.
 */

export type QuickQuality = {
  ok: boolean;
  issues: string[];
  /** Laplacian variance of the downscaled luminance (higher = sharper). */
  sharpness: number;
  /** Fraction of pixels at near-saturation (specular glare / blown highlights). */
  glareFraction: number;
  /** Fraction of pixels in deep shadow. */
  darkFraction: number;
  width: number;
  height: number;
};

const ANALYZE_EDGE = 640;
const SHARPNESS_MIN = 35;
const GLARE_MAX = 0.1;
const DARK_MAX = 0.55;

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Cannot decode image for quality gate"));
    };
    img.src = url;
  });
}

/** Runs the instant quality gate on a captured document photo. Returns null when the image cannot be decoded. */
export async function assessCaptureQuality(blob: Blob): Promise<QuickQuality | null> {
  try {
    const img = await loadImage(blob);
    const scale = Math.min(1, ANALYZE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(16, Math.round(img.naturalWidth * scale));
    const h = Math.max(16, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const lum = new Float32Array(w * h);
    let glare = 0;
    let dark = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      lum[p] = y;
      if (y >= 250 && Math.max(r, g, b) - Math.min(r, g, b) < 22) glare++;
      if (y <= 32) dark++;
    }
    const total = w * h;

    let lapSum = 0;
    let lapSq = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const lap = 4 * lum[y * w + x] - lum[y * w + x + 1] - lum[y * w + x - 1] - lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
        lapSum += lap;
        lapSq += lap * lap;
        count++;
      }
    }
    const mean = lapSum / count;
    const sharpness = Math.round(lapSq / count - mean * mean);
    const glareFraction = Math.round((glare / total) * 1000) / 1000;
    const darkFraction = Math.round((dark / total) * 1000) / 1000;

    const issues: string[] = [];
    if (sharpness < SHARPNESS_MIN) {
      issues.push(`Image looks blurry (sharpness ${sharpness}, need ≥${SHARPNESS_MIN}) — hold steady, tap to focus, and retake.`);
    }
    if (glareFraction > GLARE_MAX) {
      issues.push(`Strong glare covers ${(glareFraction * 100).toFixed(0)}% of the frame — tilt the document away from the light source and retake.`);
    }
    if (darkFraction > DARK_MAX) {
      issues.push(`Frame is mostly dark (${(darkFraction * 100).toFixed(0)}% deep shadow) — move to better light and retake.`);
    }
    return { ok: issues.length === 0, issues, sharpness, glareFraction, darkFraction, width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return null;
  }
}
