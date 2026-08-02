import ExifReader, { type Tags as ExifTags } from "exifreader";

/**
 * Post-capture lens & zoom enforcement for native camera-app captures.
 *
 * HTML background (W3C HTML Media Capture spec): `capture="user" | "environment"`
 * is the ONLY author control that exists — it requests which lens the OS camera
 * opens with, but the spec explicitly provides no control beyond that. No HTML
 * can remove the camera app's flip button or zoom controls. Therefore the lens
 * policy is enforced AFTER capture by reading the photo's own EXIF: which lens
 * actually fired (LensModel) and whether zoom was applied (DigitalZoomRatio,
 * telephoto/ultra-wide lens selection).
 */

export type LensFacing = "front" | "back" | "unknown";

export interface LensEnforcementResult {
  /** Which lens actually took the photo, per EXIF. */
  facing: LensFacing;
  /** The raw lens/model string the decision came from, if any. */
  lensText: string | null;
  /** EXIF DigitalZoomRatio (1 = none). Null when absent. */
  digitalZoom: number | null;
  /** True when digital zoom or a telephoto/ultra-wide lens switch was detected. */
  zoomed: boolean;
  /** True/false when facing is known; null when EXIF is stripped (indeterminate). */
  matchesRequested: boolean | null;
  /** False → the capture must be rejected and retaken. */
  ok: boolean;
  reasons: string[];
}

function tagText(tags: ExifTags, key: string): string | null {
  const tag = tags[key] as { description?: unknown } | undefined;
  if (!tag) return null;
  const desc = tag.description;
  if (typeof desc === "string" && desc.trim() !== "") return desc.trim();
  if (typeof desc === "number") return String(desc);
  return null;
}

function tagNumber(tags: ExifTags, key: string): number | null {
  const tag = tags[key] as { value?: unknown } | undefined;
  if (!tag) return null;
  const v = tag.value;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && typeof v[0] === "number") {
    if (v.length === 2 && typeof v[1] === "number" && Number.isFinite(v[1]) && v[1] !== 0) {
      const q = v[0] / v[1];
      return Number.isFinite(q) ? Math.round(q * 100) / 100 : null;
    }
    return v[0];
  }
  const text = tagText(tags, key);
  if (text) {
    const n = Number(text.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** Digital zoom above this ratio counts as "zoomed" (allows rounding noise). */
const ZOOM_TOLERANCE = 1.03;

/**
 * Reads the photo's EXIF and verifies the requested lens policy: correct
 * camera facing, no digital zoom, no telephoto/ultra-wide lens switch.
 * Missing EXIF (privacy browsers strip it) is indeterminate — never a hard
 * fail on its own, per the recalibration policy.
 */
export async function enforceLensPolicy(
  file: Blob,
  requested: "user" | "environment"
): Promise<LensEnforcementResult> {
  const reasons: string[] = [];
  let tags: ExifTags | null = null;
  try {
    const buffer = await file.arrayBuffer();
    tags = ExifReader.load(buffer, { expanded: false });
  } catch {
    tags = null;
  }

  if (!tags) {
    return {
      facing: "unknown",
      lensText: null,
      digitalZoom: null,
      zoomed: false,
      matchesRequested: null,
      ok: true,
      reasons: ["No readable EXIF — lens facing cannot be confirmed (privacy browsers strip metadata legitimately)"],
    };
  }

  const lensText = tagText(tags, "LensModel") ?? tagText(tags, "Lens") ?? null;
  const lensLower = (lensText ?? "").toLowerCase();

  let facing: LensFacing = "unknown";
  if (/\bfront\b|selfie/.test(lensLower)) facing = "front";
  else if (/\bback\b|\brear\b/.test(lensLower)) facing = "back";

  const digitalZoom = tagNumber(tags, "DigitalZoomRatio");
  let zoomed = false;
  if (digitalZoom != null && digitalZoom > ZOOM_TOLERANCE) {
    zoomed = true;
    reasons.push(`Digital zoom detected: ${digitalZoom.toFixed(2)}× (must be 1×)`);
  }
  if (/telephoto/.test(lensLower)) {
    zoomed = true;
    reasons.push("Telephoto (zoom-in) lens used — retake at 1× on the main lens");
  }
  if (/ultra\s?[- ]?wide/.test(lensLower)) {
    zoomed = true;
    reasons.push("Ultra-wide (0.5×) lens used — retake at 1× on the main lens");
  }

  const requestedFacing: LensFacing = requested === "user" ? "front" : "back";
  const matchesRequested = facing === "unknown" ? null : facing === requestedFacing;
  if (matchesRequested === false) {
    reasons.push(
      `Wrong camera: photo was taken with the ${facing} camera (${lensText ?? "per EXIF"}), but the ${requestedFacing} camera is required`
    );
  }
  if (facing === "unknown") {
    reasons.push("Lens facing not recorded in EXIF — cannot confirm which camera fired (caution, not a fail)");
  }

  return {
    facing,
    lensText,
    digitalZoom,
    zoomed,
    matchesRequested,
    ok: matchesRequested !== false && !zoomed,
    reasons,
  };
}

/** Formats a log line + level for a lens enforcement result. */
export function describeLensCheck(
  r: LensEnforcementResult,
  requested: "user" | "environment"
): { level: "success" | "warn" | "error"; message: string } {
  const want = requested === "user" ? "front" : "back";
  if (!r.ok) {
    return { level: "error", message: `Lens enforcement: REJECTED — ${r.reasons.join(" · ")}` };
  }
  if (r.facing === "unknown") {
    return {
      level: "warn",
      message: `Lens enforcement: indeterminate — ${r.reasons.join(" · ")} (allowed; scored as caution)`,
    };
  }
  return {
    level: "success",
    message: `Lens enforcement: ${want} camera CONFIRMED via EXIF (${r.lensText ?? "lens tag"}) · digital zoom ${r.digitalZoom != null ? `${r.digitalZoom.toFixed(2)}×` : "none recorded"}`,
  };
}
