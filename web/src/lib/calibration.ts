/**
 * Threshold calibration from real captures.
 *
 * A threshold is only allowed to accuse someone if genuine and fraudulent
 * captures actually separate on that measurement. This module stores labelled
 * samples, computes the separation per metric, and derives thresholds only where
 * a real gap exists. Where the classes overlap, the check stays unscored — the
 * honest outcome, rather than a guessed number.
 */

import { THRESHOLDS, type ThresholdDef } from "./thresholds";

export type CalibrationClass = "genuine" | "screen" | "print";

export const CALIBRATION_CLASS_LABELS: Record<CalibrationClass, string> = {
  genuine: "Genuine document in front of the camera",
  screen: "Document shown on a screen",
  print: "Printed photocopy of the document",
};

export type CalibrationSample = {
  id: string;
  klass: CalibrationClass;
  label: string;
  capturedAt: number;
  /** Raw measurements keyed by threshold id. */
  metrics: Record<string, number | null>;
  width: number;
  height: number;
};

export type CalibrationStore = {
  version: 1;
  device: string;
  samples: CalibrationSample[];
  /** Set when the user accepts the derived thresholds. */
  appliedAt: number | null;
};

export type ClassStats = {
  count: number;
  min: number;
  max: number;
  median: number;
  p10: number;
  p90: number;
};

export type MetricSeparation = {
  metricId: string;
  def: ThresholdDef;
  genuine: ClassStats | null;
  suspect: ClassStats | null;
  /** Gap between the classes as a share of the combined range. Negative = overlap. */
  separation: number | null;
  suggestedWarn: number | null;
  suggestedFail: number | null;
  outcome: "separates" | "overlaps" | "insufficient";
  explanation: string;
};

const STORAGE_KEY = "verification-hub.calibration.v1";
const MIN_PER_CLASS = 3;

/** Metrics that a screen recapture should move; calibrated against `screen` + `print`. */
const SUSPECT_CLASSES: Record<string, CalibrationClass[]> = {
  "screen.lattice.prominence": ["screen"],
  "screen.lattice.periodRatio": ["screen"],
  "screen.banding.prominence": ["screen"],
  "doc.halftone.prominence": ["print"],
  "doc.textTamperRatio": ["screen", "print"],
  "doc.backgroundUniformity": ["screen", "print"],
  "pixel.noiseFloor": ["screen", "print"],
  "ela.blockInconsistency": ["screen", "print"],
};

export function calibratableMetricIds(): string[] {
  return THRESHOLDS.filter((t) => t.provenance === "uncalibrated").map((t) => t.id);
}

function emptyStore(): CalibrationStore {
  return {
    version: 1,
    device: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    samples: [],
    appliedAt: null,
  };
}

export function loadCalibration(): CalibrationStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as CalibrationStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.samples)) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

export function saveCalibration(store: CalibrationStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage may be unavailable (private mode). Calibration is optional.
  }
}

export function clearCalibration(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(values: number[]): ClassStats | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Computes, for one metric, whether genuine and fraudulent captures separate and
 * what thresholds that separation supports.
 */
export function analyzeMetric(store: CalibrationStore, metricId: string): MetricSeparation | null {
  const def = THRESHOLDS.find((t) => t.id === metricId);
  if (!def) return null;
  const suspectClasses = SUSPECT_CLASSES[metricId] ?? ["screen", "print"];
  const pick = (classes: CalibrationClass[]): number[] =>
    store.samples
      .filter((s) => classes.includes(s.klass))
      .map((s) => s.metrics[metricId])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const genuine = stats(pick(["genuine"]));
  const suspect = stats(pick(suspectClasses));
  const suspectLabel = suspectClasses.map((c) => (c === "screen" ? "screen recaptures" : "printed copies")).join(" + ");

  if (!genuine || !suspect || genuine.count < MIN_PER_CLASS || suspect.count < MIN_PER_CLASS) {
    return {
      metricId,
      def,
      genuine,
      suspect,
      separation: null,
      suggestedWarn: null,
      suggestedFail: null,
      outcome: "insufficient",
      explanation: `Needs at least ${MIN_PER_CLASS} genuine and ${MIN_PER_CLASS} ${suspectLabel} samples. Have ${genuine?.count ?? 0} and ${suspect?.count ?? 0}.`,
    };
  }

  const higherIsSuspect = def.direction === "above";
  // Use the 90th/10th percentiles so one odd capture cannot set a threshold.
  const genuineEdge = higherIsSuspect ? genuine.p90 : genuine.p10;
  const suspectEdge = higherIsSuspect ? suspect.p10 : suspect.p90;
  const gap = higherIsSuspect ? suspectEdge - genuineEdge : genuineEdge - suspectEdge;
  const range = Math.max(genuine.max, suspect.max) - Math.min(genuine.min, suspect.min);
  const separation = range > 0 ? round(gap / range) : null;

  if (gap <= 0) {
    return {
      metricId,
      def,
      genuine,
      suspect,
      separation,
      suggestedWarn: null,
      suggestedFail: null,
      outcome: "overlaps",
      explanation: `Genuine captures (${round(genuine.min)}–${round(genuine.max)}) overlap ${suspectLabel} (${round(suspect.min)}–${round(suspect.max)}). No threshold can separate them, so this check stays unscored.`,
    };
  }

  const warn = higherIsSuspect ? genuineEdge + gap * 0.3 : genuineEdge - gap * 0.3;
  const fail = higherIsSuspect ? genuineEdge + gap * 0.7 : genuineEdge - gap * 0.7;
  return {
    metricId,
    def,
    genuine,
    suspect,
    separation,
    suggestedWarn: round(warn),
    suggestedFail: def.failAt != null ? round(fail) : null,
    outcome: "separates",
    explanation: `Genuine captures reach ${round(genuineEdge)} at the 90th percentile; ${suspectLabel} start at ${round(suspectEdge)}. Thresholds sit inside that ${round(gap)}-wide gap.`,
  };
}

export function analyzeAllMetrics(store: CalibrationStore): MetricSeparation[] {
  return calibratableMetricIds()
    .map((id) => analyzeMetric(store, id))
    .filter((m): m is MetricSeparation => m !== null);
}

export type ThresholdOverride = { warnAt: number | null; failAt: number | null; source: string };

/**
 * Builds the override map applied to the threshold registry. Only metrics that
 * demonstrably separate produce an override; everything else remains unscored.
 */
export function calibrationOverrides(store?: CalibrationStore): Map<string, ThresholdOverride> {
  const overrides = new Map<string, ThresholdOverride>();
  const s = store ?? loadCalibration();
  if (s.appliedAt == null) return overrides;
  for (const m of analyzeAllMetrics(s)) {
    if (m.outcome !== "separates" || m.suggestedWarn == null) continue;
    overrides.set(m.metricId, {
      warnAt: m.suggestedWarn,
      failAt: m.suggestedFail,
      source: `Calibrated on ${m.genuine?.count ?? 0} genuine and ${m.suspect?.count ?? 0} fraudulent captures from this device. ${m.explanation}`,
    });
  }
  return overrides;
}

export type CalibrationReadiness = {
  genuine: number;
  screen: number;
  print: number;
  /** Enough samples to derive at least one threshold. */
  ready: boolean;
  missing: string[];
};

export function calibrationReadiness(store: CalibrationStore): CalibrationReadiness {
  const count = (k: CalibrationClass): number => store.samples.filter((s) => s.klass === k).length;
  const genuine = count("genuine");
  const screen = count("screen");
  const print = count("print");
  const missing: string[] = [];
  if (genuine < 6) missing.push(`${6 - genuine} more genuine capture${6 - genuine === 1 ? "" : "s"}`);
  if (screen < 4) missing.push(`${4 - screen} more screen recapture${4 - screen === 1 ? "" : "s"}`);
  return {
    genuine,
    screen,
    print,
    ready: genuine >= MIN_PER_CLASS && screen >= MIN_PER_CLASS,
    missing,
  };
}

export function exportCalibration(store: CalibrationStore): string {
  const separations = analyzeAllMetrics(store).map((m) => ({
    metric: m.metricId,
    label: m.def.label,
    outcome: m.outcome,
    separation: m.separation,
    genuine: m.genuine,
    suspect: m.suspect,
    suggestedWarn: m.suggestedWarn,
    suggestedFail: m.suggestedFail,
    explanation: m.explanation,
  }));
  return JSON.stringify({ store, separations, exportedAt: new Date().toISOString() }, null, 2);
}
