/**
 * Threshold registry with provenance.
 *
 * Every number that can change a score must declare WHERE IT CAME FROM. A
 * threshold with no defensible origin is not allowed to accuse anyone: checks
 * marked `uncalibrated` are measured and reported but contribute zero points
 * until real separation between genuine and fraudulent captures has been
 * demonstrated on this device (see calibration.ts).
 */

export type ThresholdProvenance =
  /** Guaranteed by the web platform itself — cannot be otherwise in a real browser. */
  | "browser-invariant"
  /** Fixed by a published specification (ISO 7810, ICAO 9303, EXIF, IPTC, JPEG). */
  | "spec-defined"
  /** A hard physical limit of optics or sensors. */
  | "physical-limit"
  /** Derived from this project's own measured captures. */
  | "calibrated"
  /** Measurable, but no proven separation yet — reported, never scored. */
  | "uncalibrated";

export type ThresholdDirection = "above" | "below";

export type ThresholdDef = {
  id: string;
  label: string;
  /** Plain-language statement of what the number measures. */
  measures: string;
  provenance: ThresholdProvenance;
  /** Citation or reasoning for the value. */
  source: string;
  direction: ThresholdDirection;
  warnAt: number | null;
  failAt: number | null;
  unit?: string;
};

/**
 * Thresholds that can change a score, plus the measurements deliberately kept
 * unscored. Ordered by category for the report ledger.
 */
export const THRESHOLDS: ThresholdDef[] = [
  // ── Physical limits (never need calibration) ──
  {
    id: "exif.iso",
    label: "ISO sensitivity range",
    measures: "Reported sensor sensitivity",
    provenance: "physical-limit",
    source: "No production phone or camera sensor operates below ISO 20 or above ISO 16000; values outside cannot be written by real firmware.",
    direction: "above",
    warnAt: null,
    failAt: 16000,
    unit: "ISO",
  },
  {
    id: "exif.aperture",
    label: "Aperture range",
    measures: "Reported f-number",
    provenance: "physical-limit",
    source: "f/0.9–f/22 bounds real consumer optics; outside this range the value is fabricated.",
    direction: "above",
    warnAt: null,
    failAt: 22,
    unit: "f-number",
  },
  // ── Spec-defined ──
  {
    id: "doc.aspect.id1",
    label: "ID-1 card proportions",
    measures: "Long side ÷ short side of the located document",
    provenance: "spec-defined",
    source: "ISO/IEC 7810 ID-1 is 85.60×53.98mm = 1.586:1. A ±9% tolerance covers hand-held perspective.",
    direction: "above",
    warnAt: null,
    failAt: null,
    unit: ":1",
  },
  {
    id: "doc.aspect.band",
    label: "Plausible document proportions",
    measures: "Long side ÷ short side of the located document",
    provenance: "spec-defined",
    source: "Spans US Letter (1.294:1) to ID-1 (1.586:1) with ±25% for perspective foreshortening → 1.12–2.10.",
    direction: "above",
    warnAt: 2.1,
    failAt: null,
    unit: ":1",
  },
  {
    id: "jpeg.grid.excluded",
    label: "JPEG block periods excluded from lattice search",
    measures: "Spatial periods removed before peak selection",
    provenance: "spec-defined",
    source: "ITU-T T.81 defines 8×8 DCT blocks; 4:2:0 chroma subsampling adds a 16px MCU. Both, plus harmonics, exist in every camera JPEG.",
    direction: "above",
    warnAt: null,
    failAt: null,
    unit: "px",
  },
  // ── Browser invariants ──
  {
    id: "channel.event-trust",
    label: "Event trust on the capture channel",
    measures: "Whether the file-input change event was dispatched by the browser",
    provenance: "browser-invariant",
    source: "The HTML spec sets isTrusted=true only for user-agent-dispatched events; script cannot forge it. A false value cannot occur in a genuine capture.",
    direction: "above",
    warnAt: null,
    failAt: 1,
  },
  {
    id: "channel.device-anchor",
    label: "Track anchored to an enumerated device",
    measures: "Whether the track's deviceId appears in enumerateDevices()",
    provenance: "browser-invariant",
    source: "Within one session and origin the browser guarantees a live camera track's deviceId is present in the device list.",
    direction: "above",
    warnAt: null,
    failAt: 1,
  },
  // ── Uncalibrated: measured, reported, NOT scored until proven ──
  {
    id: "screen.lattice.prominence",
    label: "Display lattice prominence",
    measures: "How far the sharpest non-JPEG spatial peak rises above the surrounding noise floor, at native resolution",
    provenance: "uncalibrated",
    source: "Physically motivated (panel subpixel pitch is a single sharp frequency) but the firing level depends on this camera's optics and pixel pitch. Run calibration to set it.",
    direction: "above",
    warnAt: 6,
    failAt: 12,
    unit: "×noise floor",
  },
  {
    id: "screen.lattice.periodRatio",
    label: "Lattice axis agreement",
    measures: "Ratio between the horizontal and vertical peak periods",
    provenance: "uncalibrated",
    source: "Display lattices are near-square, so a genuine panel shows a ratio close to 1. Corroborating evidence only.",
    direction: "below",
    warnAt: 1.35,
    failAt: null,
    unit: ":1",
  },
  {
    id: "screen.banding.prominence",
    label: "Refresh banding prominence",
    measures: "Spectral prominence of periodic row-brightness oscillation",
    provenance: "uncalibrated",
    source: "Rolling-shutter readout against a refreshing panel is real physics, but the amplitude depends on shutter speed and refresh rate. Calibration required.",
    direction: "above",
    warnAt: 5,
    failAt: 10,
    unit: "×noise floor",
  },
  {
    id: "doc.halftone.prominence",
    label: "Print halftone prominence",
    measures: "Spectral prominence of a regular ink screening pattern inside the document",
    provenance: "uncalibrated",
    source: "Offset/laser screening (133–175 lpi) is resolvable at phone native resolution, but its period can alias with JPEG blocking. Needs printed-copy samples to calibrate.",
    direction: "above",
    warnAt: 6,
    failAt: null,
    unit: "×noise floor",
  },
  {
    id: "doc.textTamperRatio",
    label: "Text vs paper compression ratio",
    measures: "Recompression error of text regions divided by that of blank paper, inside the document only",
    provenance: "uncalibrated",
    source: "Splice detection is well established, but the ratio scales with capture sharpness and JPEG quality. Calibration on genuine documents sets the floor.",
    direction: "above",
    warnAt: 2.6,
    failAt: 4,
    unit: "×",
  },
  {
    id: "doc.backgroundUniformity",
    label: "Paper compression uniformity",
    measures: "Spread of recompression error across blank areas of the document",
    provenance: "uncalibrated",
    source: "Cloned or whitened patches compress differently, but so do lighting gradients and lamination glare. Calibration required before scoring.",
    direction: "above",
    warnAt: 12,
    failAt: null,
  },
  {
    id: "pixel.noiseFloor",
    label: "Sensor noise floor",
    measures: "Median high-frequency energy in flat regions",
    provenance: "uncalibrated",
    source: "Synthetic imagery lacks shot noise, but modern night-mode and HDR stacking removes it too. Kept as a corroborating measurement only.",
    direction: "below",
    warnAt: 0.5,
    failAt: null,
  },
  {
    id: "ela.blockInconsistency",
    label: "Regional compression inconsistency",
    measures: "Variation of recompression error between image blocks",
    provenance: "uncalibrated",
    source: "Classic ELA splice cue, but strongly affected by scene content. Reported for inspection; scored only once calibrated.",
    direction: "above",
    warnAt: 1.9,
    failAt: null,
  },
];

const BY_ID = new Map(THRESHOLDS.map((t) => [t.id, t]));

export function thresholdDef(id: string): ThresholdDef | null {
  return BY_ID.get(id) ?? null;
}

export type ResolvedThreshold = ThresholdDef & {
  /** True when this threshold may reduce the score. */
  scoring: boolean;
  /** Human-readable provenance sentence for the report ledger. */
  provenanceNote: string;
};

const PROVENANCE_NOTES: Record<ThresholdProvenance, string> = {
  "browser-invariant": "Browser guarantee — cannot be otherwise in a genuine capture.",
  "spec-defined": "Fixed by published specification.",
  "physical-limit": "Hard physical limit of real optics/sensors.",
  "calibrated": "Set from measured captures on this device.",
  "uncalibrated": "Measured and reported, but NOT scored — no proven separation yet.",
};

/**
 * Resolves a threshold, applying any calibration override. Uncalibrated
 * thresholds never score; calibrated ones do.
 */
export function resolveThreshold(
  id: string,
  overrides?: Map<string, { warnAt: number | null; failAt: number | null; source: string }>
): ResolvedThreshold | null {
  const def = BY_ID.get(id);
  if (!def) return null;
  const override = overrides?.get(id);
  if (override && def.provenance === "uncalibrated") {
    return {
      ...def,
      warnAt: override.warnAt,
      failAt: override.failAt,
      provenance: "calibrated",
      source: override.source,
      scoring: true,
      provenanceNote: PROVENANCE_NOTES.calibrated,
    };
  }
  return {
    ...def,
    scoring: def.provenance !== "uncalibrated",
    provenanceNote: PROVENANCE_NOTES[def.provenance],
  };
}

/** Formats a threshold for display, e.g. "warn ≥6 · fail ≥12 ×noise floor". */
export function describeThreshold(t: ThresholdDef): string {
  const arrow = t.direction === "above" ? "≥" : "≤";
  const parts: string[] = [];
  if (t.warnAt != null) parts.push(`caution ${arrow}${t.warnAt}`);
  if (t.failAt != null) parts.push(`fail ${arrow}${t.failAt}`);
  if (parts.length === 0) return "reference only";
  return `${parts.join(" · ")}${t.unit ? ` ${t.unit}` : ""}`;
}
