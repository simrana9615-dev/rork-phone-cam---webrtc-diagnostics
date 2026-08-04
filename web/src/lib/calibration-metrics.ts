/**
 * Raw measurement extraction for threshold calibration.
 *
 * Computes exactly the metrics whose thresholds are marked `uncalibrated` in the
 * registry, with no grading and no verdict — the calibration screen needs the
 * numbers themselves so separation between genuine and fraudulent captures can
 * be measured rather than assumed.
 */

import { analyzeDocumentPixels, computePixelMetrics } from "./pixel-forensics";
import { analyzeRefreshBanding, analyzeScreenLattice } from "./screen-lattice";
import { computeEla } from "./fraud-detection";

export type CalibrationMeasurement = {
  metrics: Record<string, number | null>;
  width: number;
  height: number;
  /** Localization outcome, so a mis-framed sample can be discarded. */
  documentLocated: boolean;
  documentNote: string;
};

function decode(blob: Blob): Promise<HTMLImageElement | null> {
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

function toCanvas(img: HTMLImageElement, maxEdge: number): HTMLCanvasElement | null {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(16, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(16, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Measures one capture. Returns nulls for anything not measurable on this image. */
export async function measureForCalibration(blob: Blob): Promise<CalibrationMeasurement | null> {
  const img = await decode(blob);
  if (!img || !img.naturalWidth) return null;

  const lattice = analyzeScreenLattice(img);
  const bandingCanvas = toCanvas(img, 1440);
  const banding = bandingCanvas ? analyzeRefreshBanding(bandingCanvas) : null;
  const pixels = await computePixelMetrics(blob);
  const ela = await computeEla(blob);
  const doc = await analyzeDocumentPixels(blob);

  return {
    metrics: {
      "screen.lattice.prominence": lattice?.prominence ?? null,
      "screen.lattice.periodRatio": lattice?.periodRatio ?? null,
      "screen.banding.prominence": banding?.prominence ?? null,
      "doc.halftone.prominence": doc?.periodic?.prominence ?? null,
      "doc.textTamperRatio": doc?.textTamperRatio ?? null,
      "doc.backgroundUniformity": doc && doc.backgroundBlockCount >= 6 ? doc.backgroundUniformity : null,
      "pixel.noiseFloor": pixels?.noiseStd ?? null,
      "ela.blockInconsistency": ela?.blockInconsistency ?? null,
    },
    width: img.naturalWidth,
    height: img.naturalHeight,
    documentLocated: doc?.location.found ?? false,
    documentNote: doc?.location.reason ?? "Document analysis unavailable for this format.",
  };
}
