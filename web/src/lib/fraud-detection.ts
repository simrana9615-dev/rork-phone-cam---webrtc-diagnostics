import ExifReader, { type Tags as ExifTags } from "exifreader";

import {
  analyzeDocumentPixels,
  assessScreenReplay,
  compareFrames,
  computePixelMetrics,
  computePixelMetricsFromCanvas,
  extractFrameCanvases,
} from "./pixel-forensics";
import { buildImageVisuals, buildVideoVisuals, type ForensicVisual } from "./visual-forensics";
import { detectPrivacyBrowser } from "./injection-guard";

export type { ForensicVisual } from "./visual-forensics";

/** Engine identifier stamped into telemetry so exported reports are traceable to detection-logic versions. */
const FORENSIC_ENGINE = "verification-hub-forensics/2.4";

const CONFIDENCE_FORMULA =
  "confidence = clamp(base 25 + pixels decoded 25 + pixel forensics ran 10 + tags(\u22658: 25, \u22653: 12) + known format 8 + timestamp 7, 0, 100)";

export type FindingStatus = "pass" | "warn" | "fail" | "info";

export type FindingCategory = "metadata" | "pixel" | "device" | "screen" | "ai" | "document";

export type Finding = {
  id: string;
  label: string;
  status: FindingStatus;
  detail: string;
  /** Penalty weight applied to the authenticity score when status is fail (full) or warn (40%). */
  weight: number;
  /** Explicit category; if omitted it is inferred from the id prefix. */
  category?: FindingCategory;
  /** What was actually measured/found in the file. */
  observed?: string;
  /** What a genuine capture would look like. */
  expected?: string;
};

export type FraudVerdict = "authentic" | "suspicious" | "manipulated" | "ai-generated" | "needs-more-info";

export type DocOutcome = "genuine-original" | "edited" | "screen-recapture" | "retake";

export type CategoryScore = {
  id: FindingCategory;
  label: string;
  score: number;
  findings: number;
  fails: number;
  warns: number;
};

export type ElaResult = {
  /** PNG data URL of the amplified error-level heat map. */
  url: string;
  /** Downscaled preview of the source used for the side-by-side. */
  sourceUrl: string;
  meanDiff: number;
  /** Normalized std-dev of per-block mean diffs. High = regions saved at different compression levels. */
  blockInconsistency: number;
};

export type MetricState = "ok" | "weak" | "strong" | "info";

/** One raw measured signal with its decision threshold — the debugging currency of the engine. */
export type MetricEntry = {
  group: string;
  name: string;
  value: string;
  threshold?: string;
  state: MetricState;
};

/** Exact arithmetic contribution of one finding to the authenticity score. */
export type ScoreTraceEntry = {
  id: string;
  label: string;
  category: FindingCategory;
  status: FindingStatus;
  weight: number;
  multiplier: number;
  penalty: number;
};

/** Maximum-detail technical breakdown attached to every report for debugging detection logic. */
export type ReportTelemetry = {
  engine: string;
  scoring: { base: number; entries: ScoreTraceEntry[]; totalPenalty: number; finalScore: number; formula: string };
  confidence: { parts: { label: string; observed: string; points: number }[]; final: number; formula: string };
  verdictTrace: string[];
  metrics: MetricEntry[];
};

export type MediaFraudReport = {
  kind: "image" | "video";
  fileName: string;
  mimeType: string;
  size: number;
  score: number;
  /** 0..100 — how much evidence was actually available. Low confidence never accuses. */
  confidence: number;
  verdict: FraudVerdict;
  verdictLabel: string;
  findings: Finding[];
  categories: CategoryScore[];
  /** Concrete instructions when a repeat capture would resolve ambiguity. */
  retakeAdvice: string[];
  /** Only set in document mode. */
  docOutcome?: DocOutcome;
  ela?: ElaResult;
  /** Rendered heat maps and charts localizing every visual detection. */
  visuals?: ForensicVisual[];
  /** Score ledger, confidence math, verdict derivation trace, and raw signal values. */
  telemetry?: ReportTelemetry;
  generatedAt: string;
};

export type AiMediaVerdict = {
  verdict: "authentic" | "ai-generated" | "manipulated" | "uncertain";
  confidence: number;
  reasoning: string;
  indicators: string[];
  framesAnalyzed?: number;
  model: string;
};

export type NativeCaptureContext = {
  /** Epoch ms when the user pressed the native capture button. */
  pressedAt: number;
  facing: "user" | "environment";
  /** Max sensor resolution reported by getCapabilities for this device, if known. */
  deviceMaxPixels: number | null;
  /** Whether the file-input change event was dispatched by the user agent (true) or by script (false). */
  changeIsTrusted?: boolean;
  /** ms between shutter-button press and the file arriving via the change event. */
  elapsedSincePressMs?: number;
  /** Epoch ms when this page session started — files older than this predate the session. */
  pageLoadedAt?: number;
  /** Whether HTMLInputElement's files accessor was native at capture time. */
  filesApiNative?: boolean;
  /** Whether the shutter-button press event was user-agent-dispatched (false = scripted click chain). */
  pressIsTrusted?: boolean;
  /** Whether the page lost visibility during the camera round-trip (native camera UI covers the page on phones). undefined = not tracked. */
  pageHiddenDuring?: boolean;
};

export const VERDICT_LABELS: Record<FraudVerdict, string> = {
  authentic: "Likely Authentic Camera Capture",
  suspicious: "Suspicious — Mixed Signals",
  manipulated: "Likely Manipulated / Re-encoded",
  "ai-generated": "Likely AI-Generated",
  "needs-more-info": "More Information Needed — Repeat Capture",
};

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  metadata: "Metadata & Container",
  pixel: "Pixel Forensics",
  device: "Device Consistency",
  screen: "Screen Replay",
  ai: "AI Signatures",
  document: "Document Integrity",
};

export const DOC_OUTCOME_LABELS: Record<DocOutcome, string> = {
  "genuine-original": "Likely Genuine Original Document",
  edited: "Likely Edited / Tampered Document",
  "screen-recapture": "Document Recaptured From a Screen",
  retake: "Inconclusive — Recapture the Document",
};

/** Category a finding belongs to (explicit or inferred from its id). */
export function categoryOf(f: Finding): FindingCategory {
  if (f.category) return f.category;
  if (f.id.startsWith("ai-")) return "ai";
  if (f.id.startsWith("doc-")) return "document";
  if (f.id.startsWith("screen-") || f.id === "video-screen-replay") return "screen";
  if (f.id.startsWith("native-") || f.id.startsWith("device-") || f.id === "video-virtual-cam") return "device";
  if (
    f.id === "ela" ||
    f.id.startsWith("pixel-") ||
    f.id === "video-static" ||
    f.id === "video-flicker" ||
    f.id === "video-noise" ||
    f.id === "video-temporal"
  )
    return "pixel";
  return "metadata";
}

/** Exact points this finding removes from the 100-point authenticity score. */
export function findingImpact(f: Finding): number {
  if (f.status === "fail") return f.weight;
  if (f.status === "warn") return Math.round(f.weight * 0.4 * 10) / 10;
  return 0;
}

function buildCategoryScores(findings: Finding[]): CategoryScore[] {
  const map = new Map<FindingCategory, Finding[]>();
  for (const f of findings) {
    const c = categoryOf(f);
    map.set(c, [...(map.get(c) ?? []), f]);
  }
  const order: FindingCategory[] = ["metadata", "pixel", "device", "screen", "ai", "document"];
  const out: CategoryScore[] = [];
  for (const id of order) {
    const list = map.get(id);
    if (!list || list.length === 0) continue;
    let penalty = 0;
    for (const f of list) penalty += findingImpact(f);
    // Same scale as the overall authenticity score — do NOT double the penalty.
    // Doubling made honest browser-stripped EXIF look "suspicious" on the category bar
    // even when the overall verdict was clean.
    out.push({
      id,
      label: CATEGORY_LABELS[id],
      score: Math.max(0, Math.min(100, Math.round(100 - penalty))),
      findings: list.length,
      fails: list.filter((f) => f.status === "fail").length,
      warns: list.filter((f) => f.status === "warn").length,
    });
  }
  return out;
}

/** Virtual camera / feed-injection fingerprints inside video containers. */
const VIRTUAL_CAM_MARKERS: { marker: string; name: string }[] = [
  { marker: "obs virtual", name: "OBS Virtual Camera" },
  { marker: "obs-camera", name: "OBS Virtual Camera" },
  { marker: "obs studio", name: "OBS Studio" },
  { marker: "manycam", name: "ManyCam" },
  { marker: "snap camera", name: "Snap Camera" },
  { marker: "snapcamera", name: "Snap Camera" },
  { marker: "xsplit", name: "XSplit" },
  { marker: "splitcam", name: "SplitCam" },
  { marker: "camtwist", name: "CamTwist" },
  { marker: "v4l2loopback", name: "v4l2loopback" },
  { marker: "droidcam", name: "DroidCam" },
  { marker: "iriun", name: "Iriun Webcam" },
  { marker: "epoccam", name: "EpocCam" },
  { marker: "virtualcam", name: "Virtual camera plugin" },
  { marker: "avatarify", name: "Avatarify" },
  { marker: "deepfacelive", name: "DeepFaceLive" },
];

export type DeviceProfile = { os: string; ua: string; screen: string; platform: string };

/** Snapshot of the device actually running this analysis. */
export function currentDeviceProfile(): DeviceProfile {
  const ua = navigator.userAgent;
  const os = /iphone|ipad|ipod/i.test(ua)
    ? "iOS"
    : /android/i.test(ua)
      ? "Android"
      : /mac os x/i.test(ua)
        ? "macOS"
        : /windows/i.test(ua)
          ? "Windows"
          : /linux/i.test(ua)
            ? "Linux"
            : "Unknown";
  return {
    os,
    ua: ua.slice(0, 160),
    screen: `${window.screen.width}\u00d7${window.screen.height} @${window.devicePixelRatio}x`,
    platform: navigator.platform || "unknown",
  };
}

const ANDROID_MAKES = ["samsung", "google", "xiaomi", "huawei", "oneplus", "oppo", "vivo", "motorola", "nokia", "realme", "honor", "sony", "lg", "asus", "zte", "tecno", "infinix"];
const DEDICATED_CAMERA_MAKES = ["canon", "nikon", "fujifilm", "panasonic", "olympus", "om digital", "leica", "gopro", "dji", "ricoh", "hasselblad", "pentax", "sigma"];

/**
 * Compares the file's claimed camera make/model against the device actually
 * running the test (user agent, platform, screen). Hard-scored only for
 * supposedly fresh native captures; informational for uploads (files may
 * legitimately be transferred between devices).
 */
function deviceConsistencyFindings(make: string | null, model: string | null, isNativeCapture: boolean): Finding[] {
  const findings: Finding[] = [];
  const profile = currentDeviceProfile();
  findings.push({
    id: "device-profile",
    label: "This device (analysis environment)",
    status: "info",
    weight: 0,
    category: "device",
    observed: `${profile.os} \u00b7 ${profile.platform} \u00b7 screen ${profile.screen}`,
    expected: "Used as the reference for metadata-vs-device comparison",
    detail: `User agent: ${profile.ua}`,
  });
  if (!make) return findings;

  const makeLc = make.toLowerCase();
  const claimed = `${make} ${model ?? ""}`.trim();
  if (DEDICATED_CAMERA_MAKES.some((m) => makeLc.includes(m))) {
    findings.push({
      id: "device-origin",
      label: "Claimed capture device vs this device",
      status: isNativeCapture ? "fail" : "info",
      weight: isNativeCapture ? 20 : 0,
      category: "device",
      observed: `Claimed: ${claimed} (dedicated camera)`,
      expected: isNativeCapture ? `A fresh capture on this ${profile.os} phone` : "Any origin is plausible for an uploaded file",
      detail: isNativeCapture
        ? `The file claims to come from a dedicated camera (${claimed}) but was supposedly just captured with this ${profile.os} phone \u2014 impossible for a fresh native capture.`
        : `File originates from a dedicated camera (${claimed}); it was transferred to this ${profile.os} device. Normal for uploads.`,
    });
    return findings;
  }

  const isAppleMake = makeLc.includes("apple");
  const isAndroidMake = ANDROID_MAKES.some((m) => makeLc.includes(m));
  let mismatch = false;
  if (isAppleMake && profile.os === "Android") mismatch = true;
  if (isAndroidMake && !isAppleMake && profile.os === "iOS") mismatch = true;

  if (mismatch) {
    findings.push({
      id: "device-origin",
      label: "Claimed capture device vs this device",
      status: isNativeCapture ? "fail" : "warn",
      weight: isNativeCapture ? 22 : 4,
      category: "device",
      observed: `Claimed: ${claimed} \u00b7 Actual device: ${profile.os} (${profile.platform})`,
      expected: isNativeCapture ? "Claimed make/model matching the phone that just took the photo" : "Matching origin (soft signal for uploads)",
      detail: isNativeCapture
        ? `Metadata claims a ${claimed} capture, but this test is running on ${profile.os}. A photo taken seconds ago on this phone cannot carry another platform's camera identity \u2014 the file was substituted or its metadata forged.`
        : `Metadata claims ${claimed} while this analysis device is ${profile.os}. For an uploaded file this only proves it was transferred between devices \u2014 noted, not penalized heavily.`,
    });
  } else {
    findings.push({
      id: "device-origin",
      label: "Claimed capture device vs this device",
      status: "pass",
      weight: 0,
      category: "device",
      observed: `Claimed: ${claimed} \u00b7 This device: ${profile.os}`,
      expected: "No platform contradiction",
      detail: `The claimed capture device (${claimed}) is consistent with this ${profile.os} environment.`,
    });
  }
  return findings;
}

/** Builds concrete retake / repeat-capture instructions from triggered findings. */
function buildRetakeAdvice(findings: Finding[], verdict: FraudVerdict, documentMode: boolean): string[] {
  const advice: string[] = [];
  const has = (id: string, statuses: FindingStatus[] = ["fail", "warn"]) =>
    findings.some((f) => f.id === id && statuses.includes(f.status));

  // Only coach on EXIF when it actually failed — soft warns on trusted native/live paths are expected.
  if (has("exif-presence", ["fail"])) {
    const pb = detectPrivacyBrowser();
    advice.push(
      pb.detected
        ? `Metadata is missing and this session runs in ${pb.name}, which can strip or re-encode photo metadata as a privacy feature. Recapture in a standard browser (Safari or Chrome) with the phone's native camera app so full EXIF metadata is preserved.`
        : "Retake with the phone's native camera app and re-upload the original file (not a screenshot, messaging-app forward, or in-app export) so full EXIF metadata is preserved."
    );
  }
  if (has("screen-replay") || has("video-screen-replay") || has("doc-recapture"))
    advice.push("Move away from any screen or monitor \u2014 capture the real physical subject directly, not a displayed copy.");
  if (has("native-freshness", ["fail"]))
    advice.push("Press the capture button and take the photo immediately when prompted \u2014 do not pick an existing file from the gallery.");
  if (has("pixel-too-small"))
    advice.push("Provide a higher-resolution image (at least ~1000px on the long edge) so pixel forensics can run reliably.");
  if (findings.some((f) => f.id === "ela" && f.status === "info"))
    advice.push("This format could not be pixel-analyzed in the browser (e.g. HEIC) \u2014 export as JPEG and re-run for full analysis.");
  if (documentMode) {
    if (has("doc-structure"))
      advice.push("Recapture the document flat on a table, filling most of the frame, in even light without glare.");
    if (has("doc-glare") || findings.some((f) => f.id === "screen-replay" && f.status !== "pass"))
      advice.push("Tilt the document slightly or move away from direct light to remove glare hotspots before recapturing.");
  }
  if (verdict === "needs-more-info" && advice.length === 0)
    advice.push("Evidence is too thin for a reliable verdict \u2014 capture the subject again with the native camera app in good light and re-run the analysis.");
  return [...new Set(advice)];
}

/**
 * Evidence-based confidence: how much analyzable signal was actually available.
 * Low confidence caps accusations \u2014 the verdict becomes "needs more info" instead.
 */
function computeConfidence(input: {
  decoded: boolean;
  pixelAnalyzed: boolean;
  tagCount: number;
  formatKnown: boolean;
  hasTimestamp: boolean;
}): { final: number; parts: { label: string; observed: string; points: number }[] } {
  const parts: { label: string; observed: string; points: number }[] = [
    { label: "Baseline", observed: "every analysis starts here", points: 25 },
    {
      label: "Pixels decodable",
      observed: input.decoded ? "decoded in-browser" : "browser could not decode pixels",
      points: input.decoded ? 25 : 0,
    },
    {
      label: "Pixel forensics ran",
      observed: input.pixelAnalyzed ? "texture/replay metrics computed" : "not available",
      points: input.pixelAnalyzed ? 10 : 0,
    },
    {
      label: "Metadata richness",
      observed: `${input.tagCount} meaningful tags (\u22658 \u2192 +25, \u22653 \u2192 +12)`,
      points: input.tagCount >= 8 ? 25 : input.tagCount >= 3 ? 12 : 0,
    },
    { label: "Container format recognized", observed: input.formatKnown ? "known format" : "unrecognized format", points: input.formatKnown ? 8 : 0 },
    { label: "Capture timestamp present", observed: input.hasTimestamp ? "yes" : "no", points: input.hasTimestamp ? 7 : 0 },
  ];
  const final = Math.max(0, Math.min(100, parts.reduce((a, p) => a + p.points, 0)));
  return { final, parts };
}

/** Full arithmetic ledger of how findings turn into the 0\u2013100 authenticity score. */
function buildScoreTrace(findings: Finding[]): ReportTelemetry["scoring"] {
  const entries: ScoreTraceEntry[] = findings.map((f) => {
    const multiplier = f.status === "fail" ? 1 : f.status === "warn" ? 0.4 : 0;
    return {
      id: f.id,
      label: f.label,
      category: categoryOf(f),
      status: f.status,
      weight: f.weight,
      multiplier,
      penalty: Math.round(f.weight * multiplier * 10) / 10,
    };
  });
  let exactPenalty = 0;
  for (const f of findings) {
    if (f.status === "fail") exactPenalty += f.weight;
    else if (f.status === "warn") exactPenalty += f.weight * 0.4;
  }
  return {
    base: 100,
    entries,
    totalPenalty: Math.round(exactPenalty * 10) / 10,
    finalScore: Math.max(0, Math.min(100, Math.round(100 - exactPenalty))),
    formula: "score = clamp(100 \u2212 \u03a3(weight \u00d7 multiplier), 0, 100) \u00b7 multiplier: fail = 1.0, warn = 0.4, pass/info = 0",
  };
}

/** Known AI generator fingerprints found inside file metadata/XMP/text chunks. */
const AI_MARKERS: { marker: string; name: string }[] = [
  { marker: "midjourney", name: "Midjourney" },
  { marker: "dall-e", name: "DALL·E" },
  { marker: "dall\u00b7e", name: "DALL·E" },
  { marker: "dalle-3", name: "DALL·E 3" },
  { marker: "stable diffusion", name: "Stable Diffusion" },
  { marker: "stablediffusion", name: "Stable Diffusion" },
  { marker: "sdxl", name: "Stable Diffusion XL" },
  { marker: "comfyui", name: "ComfyUI" },
  { marker: "invokeai", name: "InvokeAI" },
  { marker: "novelai", name: "NovelAI" },
  { marker: "leonardo.ai", name: "Leonardo AI" },
  { marker: "adobe firefly", name: "Adobe Firefly" },
  { marker: "firefly image", name: "Adobe Firefly" },
  { marker: "flux.1", name: "FLUX" },
  { marker: "black-forest-labs", name: "FLUX (Black Forest Labs)" },
  { marker: "ideogram", name: "Ideogram" },
  { marker: "recraft", name: "Recraft" },
  { marker: "imagen 3", name: "Google Imagen" },
  { marker: "imagen-3", name: "Google Imagen" },
  { marker: "gemini image", name: "Google Gemini" },
  { marker: "grok imagine", name: "Grok Imagine" },
  { marker: "bing image creator", name: "Bing Image Creator" },
  { marker: "gpt-image", name: "OpenAI GPT Image" },
  { marker: "openai api", name: "OpenAI" },
  { marker: "runwayml", name: "Runway" },
  { marker: "runway gen", name: "Runway" },
  { marker: "sora", name: "OpenAI Sora" },
  { marker: "kling ai", name: "KlingAI" },
  { marker: "klingai", name: "KlingAI" },
  { marker: "pika labs", name: "Pika" },
  { marker: "pika.art", name: "Pika" },
  { marker: "lumalabs", name: "Luma" },
  { marker: "dream machine", name: "Luma Dream Machine" },
  { marker: "seedance", name: "Seedance" },
  { marker: "veo-3", name: "Google Veo" },
  { marker: "google veo", name: "Google Veo" },
  { marker: "synthesia", name: "Synthesia" },
  { marker: "heygen", name: "HeyGen" },
  { marker: "wan-ai", name: "Wan" },
  { marker: "hailuo", name: "Hailuo/MiniMax" },
];

/** Editing/export software fingerprints (not AI, but proof the file was processed after capture). */
const EDITOR_MARKERS: { marker: string; name: string }[] = [
  { marker: "adobe photoshop", name: "Adobe Photoshop" },
  { marker: "photoshop", name: "Adobe Photoshop" },
  { marker: "lightroom", name: "Adobe Lightroom" },
  { marker: "adobe premiere", name: "Adobe Premiere" },
  { marker: "after effects", name: "Adobe After Effects" },
  { marker: "gimp", name: "GIMP" },
  { marker: "affinity photo", name: "Affinity Photo" },
  { marker: "pixelmator", name: "Pixelmator" },
  { marker: "snapseed", name: "Snapseed" },
  { marker: "picsart", name: "Picsart" },
  { marker: "canva", name: "Canva" },
  { marker: "capcut", name: "CapCut" },
  { marker: "inshot", name: "InShot" },
  { marker: "facetune", name: "Facetune" },
  { marker: "handbrake", name: "HandBrake" },
  { marker: "lavf", name: "FFmpeg (Lavf)" },
  { marker: "x264", name: "x264 encoder" },
  { marker: "x265", name: "x265 encoder" },
  { marker: "davinci resolve", name: "DaVinci Resolve" },
  { marker: "final cut", name: "Final Cut Pro" },
  { marker: "kdenlive", name: "Kdenlive" },
  { marker: "shotcut", name: "Shotcut" },
  { marker: "openshot", name: "OpenShot" },
];

/** IPTC DigitalSourceType values that explicitly declare synthetic media. */
const SYNTHETIC_SOURCE_MARKERS = [
  "trainedalgorithmicmedia",
  "compositewithtrainedalgorithmicmedia",
  "algorithmicmedia",
  "computergeneratedimage",
];

function toAscii(bytes: Uint8Array): string {
  let out = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

async function readAsciiWindow(blob: Blob, start: number, length: number): Promise<string> {
  const end = Math.min(blob.size, start + length);
  const safeStart = Math.max(0, Math.min(start, blob.size));
  if (end <= safeStart) return "";
  const buf = await blob.slice(safeStart, end).arrayBuffer();
  return toAscii(new Uint8Array(buf)).toLowerCase();
}

function tagText(tags: ExifTags, key: string): string | null {
  const tag = tags[key];
  if (!tag) return null;
  const desc = (tag as { description?: unknown }).description;
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
    // ExifReader stores EXIF rationals as [numerator, denominator] (e.g. FocalLength
    // [619, 100] = 6.19mm). Taking the raw numerator would flag genuine captures as
    // physically implausible — divide instead.
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

/**
 * Parses EXIF "YYYY:MM:DD HH:MM:SS" into epoch ms.
 * When `offset` is present (EXIF OffsetTimeOriginal / OffsetTime, e.g. "+10:00"
 * or "-05:30"), the stamp is interpreted in that fixed offset — otherwise it is
 * treated as the device's local wall clock (EXIF without offset has no TZ).
 * Using the offset prevents false freshness fails when the analysis device's
 * JS timezone disagrees with the camera's written offset, and when the phone
 * wrote UTC-style times with an explicit +00:00.
 */
export function parseExifDate(value: string | null, offset?: string | null): number | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const off = offset?.trim() ?? "";
  const om = off.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (om) {
    const sign = om[1] === "-" ? -1 : 1;
    const offMin = sign * (Number(om[2]) * 60 + Number(om[3]));
    // Build as UTC components then subtract the written offset → absolute epoch.
    const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const t = utcMs - offMin * 60_000;
    return Number.isFinite(t) ? t : null;
  }
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const t = date.getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Walks the JPEG segment table properly to find an Adobe APP14 marker. A raw
 * FF EE byte scan false-positives on ~6% of genuine photos (random pairs inside
 * EXIF MakerNote binary); real segment headers only occur between segments.
 */
function jpegHasApp14(bytes: Uint8Array): boolean {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / entropy-coded scan begins
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    if (marker === 0xee) return true;
    i += 2 + len;
  }
  return false;
}

function decodeImage(blob: Blob): Promise<HTMLImageElement | null> {
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

/**
 * Error Level Analysis: re-saves the image at a known JPEG quality and amplifies the
 * per-pixel difference. Regions edited/spliced after the original save re-compress
 * differently and light up against the rest of the frame.
 */
export async function computeEla(blob: Blob): Promise<ElaResult | null> {
  const img = await decodeImage(blob);
  if (!img || !img.naturalWidth) return null;

  const maxEdge = 900;
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(8, Math.round(img.naturalWidth * scale));
  const h = Math.max(8, Math.round(img.naturalHeight * scale));

  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const srcCtx = src.getContext("2d");
  if (!srcCtx) return null;
  srcCtx.drawImage(img, 0, 0, w, h);
  const srcData = srcCtx.getImageData(0, 0, w, h);

  const resaved = await new Promise<Blob | null>((resolve) => {
    src.toBlob((b) => resolve(b), "image/jpeg", 0.75);
  });
  if (!resaved) return null;
  const resavedImg = await decodeImage(resaved);
  if (!resavedImg) return null;

  const cmp = document.createElement("canvas");
  cmp.width = w;
  cmp.height = h;
  const cmpCtx = cmp.getContext("2d");
  if (!cmpCtx) return null;
  cmpCtx.drawImage(resavedImg, 0, 0, w, h);
  const cmpData = cmpCtx.getImageData(0, 0, w, h);

  const out = srcCtx.createImageData(w, h);
  const a = srcData.data;
  const b = cmpData.data;
  const o = out.data;
  const amplify = 14;
  let sum = 0;

  const blockSize = 32;
  const blocksX = Math.ceil(w / blockSize);
  const blocksY = Math.ceil(h / blockSize);
  const blockSums = new Float64Array(blocksX * blocksY);
  const blockCounts = new Float64Array(blocksX * blocksY);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = Math.abs(a[i] - b[i]);
      const dg = Math.abs(a[i + 1] - b[i + 1]);
      const db = Math.abs(a[i + 2] - b[i + 2]);
      const lum = (dr + dg + db) / 3;
      sum += lum;
      const bi = Math.floor(y / blockSize) * blocksX + Math.floor(x / blockSize);
      blockSums[bi] += lum;
      blockCounts[bi] += 1;
      o[i] = Math.min(255, dr * amplify);
      o[i + 1] = Math.min(255, dg * amplify);
      o[i + 2] = Math.min(255, db * amplify);
      o[i + 3] = 255;
    }
  }

  const meanDiff = sum / (w * h);
  const blockMeans: number[] = [];
  for (let i = 0; i < blockSums.length; i++) {
    if (blockCounts[i] > 0) blockMeans.push(blockSums[i] / blockCounts[i]);
  }
  const blockAvg = blockMeans.reduce((acc, v) => acc + v, 0) / Math.max(blockMeans.length, 1);
  const variance =
    blockMeans.reduce((acc, v) => acc + (v - blockAvg) * (v - blockAvg), 0) / Math.max(blockMeans.length, 1);
  const blockInconsistency = Math.sqrt(variance) / (blockAvg + 0.35);

  const heat = document.createElement("canvas");
  heat.width = w;
  heat.height = h;
  const heatCtx = heat.getContext("2d");
  if (!heatCtx) return null;
  heatCtx.putImageData(out, 0, 0);

  return {
    url: heat.toDataURL("image/png"),
    sourceUrl: src.toDataURL("image/jpeg", 0.85),
    meanDiff: Math.round(meanDiff * 100) / 100,
    blockInconsistency: Math.round(blockInconsistency * 100) / 100,
  };
}

function scoreFindings(findings: Finding[]): number {
  let penalty = 0;
  for (const f of findings) {
    if (f.status === "fail") penalty += f.weight;
    else if (f.status === "warn") penalty += f.weight * 0.4;
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

/**
 * Conservative verdict fusion: an accusation requires corroboration.
 * - "ai-generated" only on explicit generator evidence (signature, declared
 *   synthetic source, or embedded prompt block).
 * - "manipulated" requires a hard fail (weight \u2265 20) or fails across \u2265 2
 *   independent categories \u2014 a pile of weak warnings alone cannot condemn.
 * - Thin evidence (low confidence) yields "needs-more-info" instead of a verdict.
 */
function deriveVerdict(findings: Finding[], score: number, confidence: number): { verdict: FraudVerdict; steps: string[] } {
  const steps: string[] = [];
  const aiFails = findings.filter(
    (f) => f.status === "fail" && (f.id === "ai-signature" || f.id === "ai-source-type" || f.id === "ai-parameters")
  );
  if (aiFails.length > 0) {
    steps.push(
      `Rule 1 \u2014 explicit AI evidence: FIRED [${aiFails.map((f) => f.id).join(", ")}] \u2192 "ai-generated". Only direct generator fingerprints can produce this verdict.`
    );
    return { verdict: "ai-generated", steps };
  }
  steps.push('Rule 1 \u2014 explicit AI evidence (ai-signature / ai-source-type / ai-parameters fail): none \u2192 cannot be "ai-generated".');
  // Definitive capture-channel invariant: only a script-dispatched change event
  // qualifies — browsers guarantee isTrusted exclusively for their own events.
  // A wrapped file-input accessor is NOT definitive on its own: verified privacy
  // browsers (DuckDuckGo, Brave) wrap DOM accessors as a product feature; it
  // reaches fail status only when corroborated by another hard channel signal.
  const injection = findings.filter((f) => f.status === "fail" && f.id === "native-event-trust");
  if (injection.length > 0) {
    steps.push(
      `Rule 2 \u2014 definitive capture-channel injection: FIRED [${injection.map((f) => f.id).join(", ")}] \u2192 "manipulated". Browsers set isTrusted=true only on events they dispatch themselves \u2014 this cannot occur in any genuine capture.`
    );
    return { verdict: "manipulated", steps };
  }
  steps.push("Rule 2 \u2014 definitive capture-channel injection (native-event-trust fail): none. (A wrapped files accessor alone never fires this rule \u2014 privacy browsers wrap it legitimately.)");
  const hardFails = findings.filter((f) => f.status === "fail" && f.weight >= 20);
  const failCategories = new Set(findings.filter((f) => f.status === "fail").map((f) => categoryOf(f)));
  const nonMetadataFails = findings.filter((f) => f.status === "fail" && categoryOf(f) !== "metadata");
  steps.push(
    `Rule 3 \u2014 corroboration inputs: hard fails (fail with weight \u226520): ${hardFails.length}${hardFails.length > 0 ? ` [${hardFails.map((f) => f.id).join(", ")}]` : ""} \u00b7 categories containing fails: ${failCategories.size}${failCategories.size > 0 ? ` [${[...failCategories].join(", ")}]` : ""} \u00b7 non-metadata fails: ${nonMetadataFails.length}.`
  );
  if (score < 50) {
    if ((hardFails.length > 0 || failCategories.size >= 2) && nonMetadataFails.length > 0) {
      steps.push(
        `Rule 4 \u2014 score ${score} < 50 WITH corroboration (hard fail OR fails in \u22652 independent categories, including \u22651 non-metadata fail) \u2192 "manipulated".`
      );
      return { verdict: "manipulated", steps };
    }
    if (hardFails.length > 0 || failCategories.size >= 2) {
      steps.push(
        `Rule 4 \u2014 score ${score} < 50 but ALL fails are metadata-level: metadata can be stripped or re-encoded by privacy browsers and messengers without any tampering, so without pixel- or device-level evidence the verdict is "needs-more-info", never "manipulated".`
      );
      return { verdict: "needs-more-info", steps };
    }
    const v: FraudVerdict = confidence < 55 ? "needs-more-info" : "suspicious";
    steps.push(
      `Rule 4 \u2014 score ${score} < 50 WITHOUT corroboration: confidence ${confidence}% ${confidence < 55 ? '< 55 \u2192 "needs-more-info" (thin evidence never accuses)' : '\u2265 55 \u2192 "suspicious"'}.`
    );
    return { verdict: v, steps };
  }
  if (score >= 75) {
    steps.push(`Rule 4 \u2014 score ${score} \u2265 75 \u2192 "authentic".`);
    return { verdict: "authentic", steps };
  }
  // Soft mid-band: if there are zero hard fails and every fail/warn is metadata-only
  // (browser stripping, thin EXIF), do not brand the capture "suspicious" — that word
  // wrongly accuses genuine iPhone camera returns. Prefer authentic (≥65) or needs-more-info.
  const anyNonMetaIssue = findings.some(
    (f) => (f.status === "fail" || f.status === "warn") && categoryOf(f) !== "metadata" && f.weight > 0
  );
  if (hardFails.length === 0 && !anyNonMetaIssue) {
    if (score >= 65) {
      steps.push(
        `Rule 4b \u2014 score ${score} in the mid band but ONLY soft metadata cautions (browser EXIF stripping / thin tags) and zero hard fails \u2192 "authentic". Genuine phone-browser captures often land here.`
      );
      return { verdict: "authentic", steps };
    }
    steps.push(
      `Rule 4b \u2014 score ${score} with only metadata-level cautions and no hard fails \u2192 "needs-more-info" (never "suspicious" for metadata-only softness).`
    );
    return { verdict: "needs-more-info", steps };
  }
  const v: FraudVerdict = confidence < 45 && hardFails.length === 0 ? "needs-more-info" : "suspicious";
  steps.push(
    `Rule 4 \u2014 score ${score} in the 50\u201374 band: confidence ${confidence}%${confidence < 45 && hardFails.length === 0 ? ' < 45 with no hard fails \u2192 "needs-more-info"' : ' \u2192 "suspicious"'}.`
  );
  return { verdict: v, steps };
}

/**
 * Marker matcher hardened against binary false positives: the scan text is raw
 * file bytes read as ASCII, so a chance 4-byte sequence like "sora" or "x264"
 * inside compressed pixel data must not trigger an accusation. Short markers
 * (<6 chars) therefore require non-letter boundaries on both sides; long
 * markers are specific enough for plain substring search.
 */
function markerHit(text: string, marker: string): boolean {
  if (marker.length >= 6) return text.includes(marker);
  if (!text.includes(marker)) return false;
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z])${esc}(?:[^a-z]|$)`).test(text);
}

function markerFindings(ascii: string, kind: "image" | "video"): Finding[] {
  const findings: Finding[] = [];

  const aiHits = AI_MARKERS.filter((m) => markerHit(ascii, m.marker)).map((m) => m.name);
  const uniqueAi = [...new Set(aiHits)];
  if (uniqueAi.length > 0) {
    findings.push({
      id: "ai-signature",
      label: "AI-generator signature",
      status: "fail",
      weight: 35,
      detail: `Generator name embedded in the file: ${uniqueAi.join(", ")}. This is a direct fingerprint left by the AI tool.`,
    });
  } else {
    findings.push({
      id: "ai-signature",
      label: "AI-generator signature",
      status: "pass",
      weight: 0,
      detail: "No known AI tool names (Midjourney, DALL·E, Stable Diffusion, Sora, Veo, Kling, …) found in metadata.",
    });
  }

  const synthetic = SYNTHETIC_SOURCE_MARKERS.filter((m) => ascii.includes(m));
  if (synthetic.length > 0) {
    findings.push({
      id: "ai-source-type",
      label: "Declared synthetic source type",
      status: "fail",
      weight: 35,
      detail: `IPTC DigitalSourceType declares computer-generated media (${synthetic[0]}). The file itself says it is synthetic.`,
    });
  }

  if (markerHit(ascii, "c2pa") || ascii.includes("contentauth") || markerHit(ascii, "jumbf")) {
    // iOS 16+ Camera / Photos can embed Content Credentials on genuine optical
    // captures. C2PA alone is provenance metadata, not proof of synthesis — only
    // note it. AI generators still trip explicit ai-signature / source-type fails.
    findings.push({
      id: "ai-c2pa",
      label: "Content Credentials (C2PA) manifest",
      status: "info",
      weight: 0,
      detail:
        "A C2PA/Content Credentials block is embedded. Modern phone cameras (iOS Camera/Photos) and some editors attach these to genuine photos as well as AI tools — recorded for provenance review, not scored as fraud.",
    });
  }

  if (kind === "image" && (ascii.includes('"prompt"') || ascii.includes("negative prompt") || /parameters\x00?steps:/.test(ascii))) {
    findings.push({
      id: "ai-parameters",
      label: "Generation parameter block",
      status: "fail",
      weight: 35,
      detail:
        "A Stable Diffusion / ComfyUI style parameter or prompt block is embedded in the file — prompts, steps, seeds. Unambiguous AI-generation trace.",
    });
  }

  const editorHits = EDITOR_MARKERS.filter((m) => markerHit(ascii, m.marker)).map((m) => m.name);
  const uniqueEditors = [...new Set(editorHits)];
  if (uniqueEditors.length > 0) {
    findings.push({
      id: "editor-fingerprint",
      label: "Editing/export software fingerprint",
      status: "fail",
      weight: 14,
      detail: `Processed by: ${uniqueEditors.join(", ")}. The file was re-saved after capture — not a straight-from-camera original.`,
    });
  } else {
    findings.push({
      id: "editor-fingerprint",
      label: "Editing/export software fingerprint",
      status: "pass",
      weight: 0,
      detail: "No editor or transcode tool names (Photoshop, FFmpeg, CapCut, HandBrake, …) found in the file.",
    });
  }

  return findings;
}

/**
 * Full forensic analysis of a still image. Runs entirely on-device.
 * Pass `native` when the image came from a forced native-camera capture to
 * additionally run capture-context mismatch checks.
 */
/**
 * How the bytes reached the analyzer. Metadata expectations differ sharply:
 * - `live-frame` — canvas / WebRTC still; EXIF is never present by design.
 * - `native-file` — phone camera app via `<input capture>` / Capacitor; browsers
 *   often strip MakerNote/thumbnail/optical params while keeping Make/Model/time.
 * - `upload` — user-picked or unknown origin; full metadata expectations apply.
 */
export type CaptureSource = "live-frame" | "native-file" | "upload";

export async function analyzeImageFraud(
  blob: Blob,
  fileName: string,
  options?: {
    native?: NativeCaptureContext;
    fileLastModified?: number;
    /** Document mode: adds text-tamper, paper and recapture checks tuned for IDs/paperwork. */
    document?: boolean;
    /** Pre-computed findings (e.g. capture-channel injection audit) merged before scoring. */
    extraFindings?: Finding[];
    /** Step-by-step progress logging into the live console. */
    onStep?: (message: string) => void;
    /**
     * Capture path. Inferred when omitted: native context → native-file, else upload.
     * Pass `live-frame` for WebRTC/canvas stills so missing EXIF is not scored as fraud.
     */
    captureSource?: CaptureSource;
  }
): Promise<MediaFraudReport> {
  const findings: Finding[] = [];
  const metrics: MetricEntry[] = [];
  const pushMetric = (group: string, name: string, value: string, state: MetricState, threshold?: string) => {
    metrics.push({ group, name, value, threshold, state });
  };
  const step = (m: string) => options?.onStep?.(m);
  const captureSource: CaptureSource =
    options?.captureSource ?? (options?.native ? "native-file" : "upload");
  const isLiveFrame = captureSource === "live-frame";
  const isNativeFile = captureSource === "native-file";
  // Trusted native round-trip: browser-mediated EXIF stripping is expected and must
  // not tank the score. Untrusted/scripted paths keep full metadata scrutiny.
  const trustedNativeChannel =
    isNativeFile &&
    options?.native != null &&
    options.native.changeIsTrusted !== false &&
    options.native.pressIsTrusted !== false &&
    (options.native.elapsedSincePressMs == null || options.native.elapsedSincePressMs >= 300);
  step(`Reading ${Math.round(blob.size / 1024)} KB \u00b7 scanning binary markers and metadata\u2026`);
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const headAscii = toAscii(bytes.subarray(0, Math.min(bytes.length, 512 * 1024))).toLowerCase();
  const tailAscii =
    bytes.length > 512 * 1024 ? toAscii(bytes.subarray(bytes.length - 64 * 1024)).toLowerCase() : "";
  const ascii = headAscii + tailAscii;

  const isJpeg = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng =
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isWebp = bytes.length >= 12 && toAscii(bytes.subarray(8, 12)) === "WEBP";
  const ftypHead = ascii.slice(0, 64);
  const isHeic = ["ftypheic", "ftypheif", "ftypheix", "ftyphevc", "ftypmif1"].some((b) => ftypHead.includes(b));

  const format = isJpeg ? "JPEG" : isPng ? "PNG" : isWebp ? "WebP" : isHeic ? "HEIC" : blob.type || "unknown";

  if (isJpeg || isHeic) {
    findings.push({
      id: "container-format",
      label: "Container format",
      status: "pass",
      weight: 0,
      detail: `${format} — consistent with a real camera capture pipeline.`,
    });
  } else if (isPng || isWebp) {
    // Live-frame path can legitimately be PNG if a caller encodes that way; still prefer JPEG.
    findings.push({
      id: "container-format",
      label: "Container format",
      status: isLiveFrame ? "info" : "warn",
      weight: isLiveFrame ? 0 : 10,
      detail: isLiveFrame
        ? `${format} live-frame encode — container choice is the app's, not the camera's.`
        : `${format} — phone cameras never save ${format}. Typical of screenshots, app exports, and AI generators.`,
    });
  } else {
    findings.push({
      id: "container-format",
      label: "Container format",
      status: "warn",
      weight: 6,
      detail: `Unrecognized image container (${format}).`,
    });
  }

  let tags: ExifTags | null = null;
  try {
    tags = ExifReader.load(buffer, { expanded: false });
  } catch {
    tags = null;
  }

  const make = tags ? tagText(tags, "Make") : null;
  const model = tags ? tagText(tags, "Model") : null;
  const dateOriginal = tags ? tagText(tags, "DateTimeOriginal") : null;
  const dateOffset =
    (tags ? tagText(tags, "OffsetTimeOriginal") : null) ?? (tags ? tagText(tags, "OffsetTime") : null);
  const software = tags ? tagText(tags, "Software") : null;
  // ExifReader always injects several structural keys (FileType, bits, etc.). Count only
  // tags that carry real camera/provenance signal so a stripped file isn't "rich".
  const STRUCTURAL_TAG_RE =
    /^(Thumbnail|FileType|Bits Per Sample|Image Height|Image Width|Color Components|SubSec|Exif|GPS Info|Interoperability|Makernote|about|jfif|pngFile|xmp|iptc|icc)/i;
  const meaningfulTagCount = tags
    ? Object.keys(tags).filter((k) => !STRUCTURAL_TAG_RE.test(k) && !k.startsWith("Thumbnail")).length
    : 0;

  pushMetric("File", "Size", `${(blob.size / 1024).toFixed(1)} KB`, "info");
  pushMetric("File", "Container format", format, isJpeg || isHeic ? "ok" : isLiveFrame && isJpeg ? "ok" : "weak", "camera pipeline formats: JPEG / HEIC · live frames are canvas JPEG by design");
  pushMetric(
    "Metadata",
    "Meaningful EXIF tags",
    String(meaningfulTagCount),
    isLiveFrame || trustedNativeChannel
      ? "info"
      : meaningfulTagCount >= 3
        ? "ok"
        : "strong",
    isLiveFrame
      ? "live-frame path — EXIF never expected"
      : trustedNativeChannel
        ? "trusted native — thin EXIF is expected browser mediation (info only)"
        : "\u22653 preferred · stripped uploads raise scrutiny"
  );
  pushMetric("Capture path", "Source", captureSource, "info", "live-frame | native-file | upload");

  // Expected browser mediation (live-frame / trusted native / privacy browser) is
  // always info weight-0 — never amber risk, never a score hit (engine 2.4).
  const browserMediated = isLiveFrame || trustedNativeChannel;

  if (isLiveFrame) {
    // Canvas / WebRTC stills are re-encoded in the page — zero EXIF is the honest baseline.
    findings.push({
      id: "exif-presence",
      label: "Metadata presence",
      status: "pass",
      weight: 0,
      detail:
        "Live-frame capture (in-page canvas / WebRTC still). EXIF is never written on this path — absence is expected and not scored as stripping or fraud. Authenticity rests on the capture-channel audit and pixel forensics.",
    });
  } else if (!tags || meaningfulTagCount < 3) {
    const pb = detectPrivacyBrowser();
    if (trustedNativeChannel || pb.detected) {
      findings.push({
        id: "exif-presence",
        label: "Metadata presence",
        status: "info",
        weight: 0,
        category: "metadata",
        observed: `${meaningfulTagCount} meaningful EXIF tags`,
        expected: "Browser-mediated native captures often arrive thin or empty",
        detail: pb.detected
          ? `Little or no EXIF (${meaningfulTagCount} tags) after a native capture in ${pb.name}. Privacy browsers and WebViews commonly strip camera metadata — expected browser mediation, not fraud. Not scored.`
          : `Little or no EXIF (${meaningfulTagCount} tags) on a trusted native-camera return. Mobile browsers (especially Safari) often deliver a JPEG with stripped or reduced metadata even for genuine optical captures. Expected browser mediation — not scored. Channel trust and pixel checks carry authenticity.`,
      });
    } else {
      findings.push({
        id: "exif-presence",
        label: "Metadata presence",
        status: "fail",
        weight: 14,
        detail:
          "No meaningful EXIF metadata. Either stripped (messaging apps, editors, screenshots) or it never existed (canvas re-encode, AI output).",
      });
    }
  } else {
    findings.push({
      id: "exif-presence",
      label: "Metadata presence",
      status: "pass",
      weight: 0,
      detail: `${meaningfulTagCount} metadata tags present.`,
    });
  }

  if (make && model) {
    findings.push({
      id: "camera-identity",
      label: "Camera make & model",
      status: "pass",
      weight: 0,
      detail: `${make} ${model}`,
    });
  } else if (!isLiveFrame && tags && meaningfulTagCount >= 3) {
    findings.push({
      id: "camera-identity",
      label: "Camera make & model",
      status: browserMediated ? "info" : "warn",
      // Safari regularly keeps DateTime/orientation but drops Make/Model on <input capture>.
      weight: browserMediated ? 0 : 10,
      category: "metadata",
      detail: browserMediated
        ? "Metadata exists but camera make/model is missing. Common on browser-mediated phone captures (Safari/WebView strip identity tags) — expected, not scored."
        : "Metadata exists but the camera make/model is missing — real camera files usually identify the device; exports and generators often do not.",
    });
  }

  if (tags && !isLiveFrame) {
    const exposureKeys = ["LensModel", "FocalLength", "FNumber", "ExposureTime", "ISOSpeedRatings", "WhiteBalance"];
    const present = exposureKeys.filter((k) => tagText(tags as ExifTags, k) != null);
    if (present.length >= 3) {
      findings.push({
        id: "capture-params",
        label: "Optical capture parameters",
        status: "pass",
        weight: 0,
        detail: `Lens/exposure data present (${present.join(", ")}). Hard for fakes to fabricate consistently.`,
      });
    } else if (meaningfulTagCount >= 3) {
      findings.push({
        id: "capture-params",
        label: "Optical capture parameters",
        status: browserMediated ? "info" : "warn",
        weight: browserMediated ? 0 : 6,
        category: "metadata",
        detail: browserMediated
          ? "Lens/exposure tags mostly absent after browser-mediated native capture — iOS/Android WebViews commonly strip optical EXIF while keeping the JPEG. Expected, not scored."
          : "Lens, exposure, ISO and shutter data mostly missing — typical of exported or generated images.",
      });
    }

    const iso = tagNumber(tags, "ISOSpeedRatings");
    const fnum = tagNumber(tags, "FNumber");
    const focal = tagNumber(tags, "FocalLength");
    const physicalIssues: string[] = [];
    if (iso != null && (iso < 20 || iso > 16000)) physicalIssues.push(`ISO ${iso} is outside any phone sensor's real range (20\u201316000)`);
    if (fnum != null && (fnum < 0.9 || fnum > 22)) physicalIssues.push(`f/${fnum} is not a physically plausible aperture`);
    if (focal != null && (focal < 0.5 || focal > 500)) physicalIssues.push(`${focal}mm focal length is implausible for the claimed device class`);
    if (physicalIssues.length > 0) {
      findings.push({
        id: "capture-physical",
        label: "Physical plausibility of capture parameters",
        status: "fail",
        weight: 14,
        observed: physicalIssues.join("; "),
        expected: "ISO 20\u201316000, aperture f/0.9\u2013f/22, focal length 0.5\u2013500mm",
        detail: `Capture parameters are physically inconsistent: ${physicalIssues.join("; ")}. Real camera firmware cannot write these values \u2014 fabricated metadata.`,
      });
    } else if (iso != null || fnum != null || focal != null) {
      findings.push({
        id: "capture-physical",
        label: "Physical plausibility of capture parameters",
        status: "pass",
        weight: 0,
        observed: [iso != null ? `ISO ${iso}` : null, fnum != null ? `f/${fnum}` : null, focal != null ? `${focal}mm` : null].filter(Boolean).join(" \u00b7 "),
        expected: "Values within real optics/sensor ranges",
        detail: "Exposure, aperture and focal length are all physically consistent with a real camera.",
      });
    }

    const gps = tagText(tags, "GPSLatitude");
    findings.push({
      id: "gps",
      label: "GPS location",
      status: "info",
      weight: 0,
      detail: gps ? `GPS present (${gps}, …)` : "No GPS — normal when location permission is off; not incriminating alone.",
    });
  }

  const now = Date.now();
  const originalMs = parseExifDate(dateOriginal, dateOffset);
  if (originalMs != null) {
    // Allow a full day of skew for wrong TZ / travel clocks before calling it "future".
    if (originalMs > now + 26 * 3600 * 1000) {
      findings.push({
        id: "timestamp-future",
        label: "Capture timestamp sanity",
        status: "fail",
        weight: 15,
        detail: `DateTimeOriginal is in the future (${dateOriginal}${dateOffset ? ` ${dateOffset}` : ""}). Forged or corrupted clock data.`,
      });
    } else {
      findings.push({
        id: "timestamp-future",
        label: "Capture timestamp sanity",
        status: "pass",
        weight: 0,
        detail: `Captured ${dateOriginal}${dateOffset ? ` (${dateOffset})` : ""}.`,
      });
    }
    const lastModified = options?.fileLastModified;
    if (lastModified != null && lastModified > 0) {
      const gapMs = lastModified - originalMs;
      if (gapMs > 45 * 24 * 3600 * 1000) {
        findings.push({
          id: "timestamp-gap",
          label: "Capture vs file-modified gap",
          status: browserMediated ? "info" : "warn",
          weight: browserMediated ? 0 : 5,
          category: "metadata",
          detail: `File was written ${Math.round(gapMs / (24 * 3600 * 1000))} days after the claimed capture — re-saved, exported, or transferred long after capture.${browserMediated ? " Noted on trusted path; not scored alone." : ""}`,
        });
      } else if (gapMs < -6 * 3600 * 1000) {
        // >6h file-before-capture is real inconsistency. Smaller negative gaps are often
        // TZ/offset parse noise or iOS rewriting lastModified on handoff.
        findings.push({
          id: "timestamp-gap",
          label: "Capture vs file-modified gap",
          status: browserMediated ? "info" : "warn",
          weight: browserMediated ? 0 : 6,
          category: "metadata",
          detail: "File-modified time predates the claimed capture time by more than 6 hours — inconsistent clocks or edited metadata." + (browserMediated ? " Soft note on trusted native path (clock/TZ noise common); not scored." : ""),
        });
      } else {
        findings.push({
          id: "timestamp-gap",
          label: "Capture vs file-modified gap",
          status: "pass",
          weight: 0,
          detail: "File-modified time is consistent with the claimed capture time.",
        });
      }
    }
  } else if (!isLiveFrame && tags && meaningfulTagCount >= 3) {
    findings.push({
      id: "timestamp-missing",
      label: "Capture timestamp",
      status: browserMediated ? "info" : "warn",
      weight: browserMediated ? 0 : 6,
      category: "metadata",
      detail: browserMediated
        ? "No DateTimeOriginal after browser-mediated native capture — common when the WebView re-encodes the still. Freshness falls back to the file timestamp and press clock. Not scored."
        : "No DateTimeOriginal — camera originals usually record the capture moment; exports and generators often drop it.",
    });
  }

  const dateDigitized = tags ? tagText(tags, "DateTimeDigitized") : null;
  const digitizedOffset = (tags ? tagText(tags, "OffsetTimeDigitized") : null) ?? dateOffset;
  const digitizedMs = parseExifDate(dateDigitized, digitizedOffset);
  if (originalMs != null && digitizedMs != null) {
    const gap = Math.abs(digitizedMs - originalMs);
    // iOS computational photography / Live Photo finalize can legitimately separate
    // Original vs Digitized by many seconds. Only large multi-minute gaps are interesting.
    if (gap > 15 * 60 * 1000) {
      findings.push({
        id: "timestamp-agreement",
        label: "Timestamp field agreement",
        status: "warn",
        weight: 5,
        observed: `DateTimeOriginal ${dateOriginal} vs DateTimeDigitized ${dateDigitized} (Δ ${Math.round(gap / 1000)}s)`,
        expected: "Usually within minutes (cameras write both near the capture instant)",
        detail: `DateTimeOriginal and DateTimeDigitized differ by ${Math.round(gap / 60000)} min — large gaps can mean a re-save or metadata rewrite. Small gaps from iOS computational photography are normal and no longer flagged.`,
      });
    } else {
      findings.push({
        id: "timestamp-agreement",
        label: "Timestamp field agreement",
        status: "pass",
        weight: 0,
        observed: gap <= 5000 ? "DateTimeOriginal \u2261 DateTimeDigitized" : `DateTimeOriginal ≈ DateTimeDigitized (Δ ${Math.round(gap / 1000)}s)`,
        expected: "Near-agreement of capture timestamp fields",
        detail:
          gap <= 5000
            ? "All capture timestamp fields agree — consistent with an untouched camera file."
            : `Timestamp fields differ by ${Math.round(gap / 1000)}s — within the normal window for phone computational photography / Live Photo finalize. Not scored as rewrite.`,
      });
    }
  }

  step("Decoding pixels\u2026");
  const img = await decodeImage(blob);
  const actualW = img?.naturalWidth ?? null;
  const actualH = img?.naturalHeight ?? null;
  if (actualW && actualH) pushMetric("Pixels", "Decoded dimensions", `${actualW}\u00d7${actualH}`, "info");
  if (tags && actualW && actualH && !isLiveFrame) {
    // Prefer Exif Image IFD PixelX/YDimension — Image Width/Height often describe
    // the primary IFD or an embedded preview and false-mismatch genuine iPhone JPEGs.
    const pixelX = tagNumber(tags, "PixelXDimension");
    const pixelY = tagNumber(tags, "PixelYDimension");
    const claimedW = pixelX ?? tagNumber(tags, "ImageWidth") ?? tagNumber(tags, "Image Width");
    const claimedH = pixelY ?? tagNumber(tags, "ImageHeight") ?? tagNumber(tags, "Image Height");
    if (claimedW && claimedH) {
      const near = (a: number, b: number) => Math.abs(a - b) <= 2;
      const direct = near(claimedW, actualW) && near(claimedH, actualH);
      // Browsers apply the EXIF Orientation tag on decode, so a portrait photo
      // (sensor writes landscape + rotation flag) legitimately reports swapped
      // width/height — that is normal camera behavior, never tampering.
      const swapped = !direct && near(claimedW, actualH) && near(claimedH, actualW);
      // iOS sometimes keeps full-sensor PixelX/Y while the delivered file is a
      // slightly different processed still (HEIC→JPEG, portrait crop). Treat large
      // but same-aspect disagreements as warn, not fail, on trusted native paths.
      const aspectClaim = claimedW / Math.max(1, claimedH);
      const aspectActual = actualW / Math.max(1, actualH);
      const aspectOk = Math.abs(aspectClaim - aspectActual) < 0.04 || Math.abs(aspectClaim - 1 / aspectActual) < 0.04;
      const areaRatio =
        (claimedW * claimedH) / Math.max(1, actualW * actualH);
      if (direct || swapped) {
        findings.push({
          id: "dimension-claim",
          label: "Claimed vs actual dimensions",
          status: "pass",
          weight: 0,
          detail: swapped
            ? `Metadata (${claimedW}×${claimedH}) matches decoded pixels (${actualW}×${actualH}) after EXIF portrait/landscape rotation — cameras store the sensor frame plus an Orientation flag and browsers rotate on decode; this is expected for portrait captures.`
            : `Metadata (${claimedW}×${claimedH}) matches decoded pixels (${actualW}×${actualH}).`,
        });
      } else if (trustedNativeChannel && aspectOk && areaRatio > 0.5 && areaRatio < 2.5) {
        findings.push({
          id: "dimension-claim",
          label: "Claimed vs actual dimensions",
          status: "info",
          weight: 0,
          detail: `Metadata claims ${claimedW}×${claimedH} while decoded pixels are ${actualW}×${actualH}. On a trusted native-camera return this is typical of browser HEIC→JPEG conversion or iOS computational crop — aspect agrees, not scored as a resize-forgery.`,
        });
      } else {
        findings.push({
          id: "dimension-claim",
          label: "Claimed vs actual dimensions",
          status: trustedNativeChannel ? "info" : "fail",
          weight: trustedNativeChannel ? 0 : 12,
          category: "metadata",
          detail: `Metadata claims ${claimedW}×${claimedH} but the actual pixels are ${actualW}×${actualH} — often a resize/re-save that kept old tags${trustedNativeChannel ? ". On a trusted native return this is typically HEIC→JPEG / computational crop mediation — noted, not scored." : "."}`,
        });
      }
    }
  }

  if (isJpeg && tags && make && !isLiveFrame) {
    const hasMakerNote =
      !!(tags as Record<string, unknown>)["MakerNote"] ||
      !!(tags as Record<string, unknown>)["makerNote"] ||
      Object.keys(tags).some((k) => /makernote/i.test(k));
    // Embedded EXIF thumbnails start with a second FF D8 SOI marker. Scan the raw
    // bytes: the lowercased ASCII copy maps 0xD8 to 0xF8, so a string search there
    // can never match.
    let hasSecondSoi = false;
    const soiScanEnd = Math.min(bytes.length - 1, 256 * 1024);
    for (let i = 4; i < soiScanEnd; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8) {
        hasSecondSoi = true;
        break;
      }
    }
    const hasThumb = !!(tags as Record<string, unknown>)["Thumbnail"] || hasSecondSoi;
    if (!hasMakerNote) {
      // Safari / Chrome on iOS almost always strip MakerNote from <input capture> JPEGs.
      findings.push({
        id: "makernote",
        label: "Manufacturer maker-note block",
        status: browserMediated ? "info" : "warn",
        weight: browserMediated ? 0 : 5,
        category: "metadata",
        detail: browserMediated
          ? `Claims ${make} but MakerNote is absent after browser-mediated capture. iOS/Android WebViews routinely strip the proprietary block while keeping Make/Model — expected, not scored.`
          : `Claims ${make} but the proprietary MakerNote block is gone — editors and exporters strip it; full camera originals usually include it.`,
      });
    } else {
      findings.push({
        id: "makernote",
        label: "Manufacturer maker-note block",
        status: "pass",
        weight: 0,
        detail: "Proprietary MakerNote present — strong straight-from-camera indicator.",
      });
    }
    if (!hasThumb) {
      findings.push({
        id: "thumbnail",
        label: "Embedded EXIF thumbnail",
        status: browserMediated ? "info" : "warn",
        weight: browserMediated ? 0 : 3,
        category: "metadata",
        detail: browserMediated
          ? "No embedded thumbnail after browser-mediated capture — common and not scored."
          : "No embedded thumbnail — camera originals often include one; soft signal only.",
      });
    }
  }

  if (isJpeg) {
    if (jpegHasApp14(bytes)) {
      findings.push({
        id: "adobe-app14",
        label: "Adobe APP14 segment",
        status: "warn",
        weight: 8,
        detail: "APP14 'Adobe' segment present — this JPEG was written by an Adobe pipeline, not a camera.",
      });
    }
  }

  if (software && !EDITOR_MARKERS.some((m) => software.toLowerCase().includes(m.marker))) {
    // iPhone writes bare version strings ("18.5", "26.0"), "Iridium", "HDR+", vendor UI names, etc.
    const looksLikeFirmware =
      /^(hdr\+|\d|ios|ipados|android|one ui|miui|emui|coloros|iridium|camera|apple)/i.test(software.trim()) ||
      (!!make && !/photoshop|lightroom|gimp|snapseed|picsart|canva|facetune/i.test(software));
    findings.push({
      id: "software-tag",
      label: "Software tag",
      status: looksLikeFirmware || browserMediated ? "info" : "warn",
      weight: looksLikeFirmware || browserMediated ? 0 : 6,
      category: "metadata",
      detail: `Software: "${software}"${looksLikeFirmware ? " (camera firmware / OS imaging pipeline — normal)" : browserMediated ? " — noted on trusted capture path; not scored without an editor fingerprint." : " — unknown processor wrote this file."}`,
    });
  }

  findings.push(...deviceConsistencyFindings(make, model, !!options?.native));

  findings.push(...markerFindings(ascii, "image"));

  step("Running Error Level Analysis\u2026");
  let ela: ElaResult | undefined;
  if (img) {
    const elaResult = await computeEla(blob);
    if (elaResult) {
      ela = elaResult;
      pushMetric("ELA", "Mean re-compression diff", String(elaResult.meanDiff), "info");
      pushMetric(
        "ELA",
        "Block inconsistency (\u03c3/\u03bc of block means)",
        String(elaResult.blockInconsistency),
        elaResult.blockInconsistency > 1.9 ? "weak" : "ok",
        ">1.9 = regional splice/edit signal"
      );
      if (elaResult.blockInconsistency > 1.9) {
        findings.push({
          id: "ela",
          label: "Error Level Analysis",
          status: "warn",
          weight: 10,
          detail: `High regional compression inconsistency (${elaResult.blockInconsistency}). Some areas were saved at a different compression level — classic splice/local-edit signal. Inspect the heat map.`,
        });
      } else {
        findings.push({
          id: "ela",
          label: "Error Level Analysis",
          status: "pass",
          weight: 0,
          detail: `Compression error levels are uniform across the frame (inconsistency ${elaResult.blockInconsistency}, mean ${elaResult.meanDiff}).`,
        });
      }
    }
  } else {
    findings.push({
      id: "ela",
      label: "Error Level Analysis",
      status: "info",
      weight: 0,
      detail: "Browser cannot decode this format for pixel analysis (common for HEIC). Metadata checks still apply.",
    });
  }

  step("Running screen-replay & texture forensics\u2026");
  let pixelAnalyzed = false;
  let pixelMetrics: Awaited<ReturnType<typeof computePixelMetrics>> = null;
  if (img) {
    pixelMetrics = await computePixelMetrics(blob);
    if (pixelMetrics) {
      pixelAnalyzed = true;
      const pm = pixelMetrics;
      pushMetric("Texture", "Analysis canvas", `${pm.width}\u00d7${pm.height}`, "info");
      pushMetric("Texture", "Flat-region noise (median |Laplacian|)", String(pm.noiseStd), pm.noiseStd < 0.5 ? "weak" : "ok", "<0.5 = denoised / synthetic cue");
      pushMetric("Texture", "Flat blocks sampled", String(pm.flatBlockCount), "info");
      pushMetric("Texture", "Edge density (mean gradient/block)", String(pm.edgeDensity), "info");
      pushMetric("Texture", "Mean luma", String(pm.meanLuma), "info");
      if (actualW && actualH && Math.max(actualW, actualH) < 420) {
        findings.push({
          id: "pixel-too-small",
          label: "Resolution for pixel forensics",
          status: "warn",
          weight: 6,
          category: "pixel",
          observed: `${actualW}\u00d7${actualH}`,
          expected: "\u22651000px long edge",
          detail: "Image is very small \u2014 moir\u00e9, noise and ELA checks lose reliability at this size. Provide a higher-resolution original.",
        });
      }
      const replay = assessScreenReplay(pm);
      for (const s of replay.signals) {
        pushMetric("Screen replay", s.label, String(s.value), s.triggered === "no" ? "ok" : s.triggered, `weak \u2265${s.threshold}`);
      }
      pushMetric(
        "Screen replay",
        "Fused replay evidence",
        `${Math.round(replay.score * 100)}% (${replay.verdict})`,
        replay.verdict === "likely" ? "strong" : replay.verdict === "weak" ? "weak" : "ok",
        "likely requires \u22652 strong OR 1 strong + 2 weak signals"
      );
      const signalText = replay.signals
        .map((s) => `${s.label}: ${s.value}${s.triggered !== "no" ? ` [${s.triggered.toUpperCase()}]` : ""}`)
        .join(" \u00b7 ");
      if (replay.verdict === "likely") {
        findings.push({
          id: "screen-replay",
          label: "Photo-of-a-screen detection",
          status: "fail",
          weight: 22,
          category: "screen",
          observed: signalText,
          expected: "No periodic pixel grid, refresh banding, or concentrated panel glare",
          detail: `Multiple independent recapture signals fired (evidence ${Math.round(replay.score * 100)}%): ${replay.signals.filter((s) => s.triggered !== "no").map((s) => s.detail).join(" ")}`,
        });
      } else if (replay.verdict === "weak") {
        findings.push({
          id: "screen-replay",
          label: "Photo-of-a-screen detection",
          status: "warn",
          weight: 8,
          category: "screen",
          observed: signalText,
          expected: "No recapture signals",
          detail: `One weak recapture cue present \u2014 not conclusive on its own (single signals also occur in genuine photos of textiles, blinds, or bright windows). ${replay.signals.filter((s) => s.triggered !== "no").map((s) => s.detail).join(" ")}`,
        });
      } else {
        findings.push({
          id: "screen-replay",
          label: "Photo-of-a-screen detection",
          status: "pass",
          weight: 0,
          category: "screen",
          observed: signalText,
          expected: "No periodic grid, banding, or panel glare",
          detail: "No moir\u00e9/pixel-grid periodicity, refresh banding, concentrated glare, or display color cast \u2014 no evidence this is a photographed screen.",
        });
      }
      if (pm.noiseStd < 0.5 && pm.flatBlockCount >= 10 && !make) {
        findings.push({
          id: "pixel-smooth",
          label: "Sensor noise floor",
          status: "warn",
          weight: 8,
          category: "pixel",
          observed: `Flat-region noise ${pm.noiseStd} across ${pm.flatBlockCount} blocks`,
          expected: "Real sensors leave measurable shot noise (>0.5) in flat regions",
          detail: "Flat areas are unnaturally clean and no camera identity is present \u2014 consistent with AI rendering or aggressive denoising/beauty filters. Soft signal; corroboration required.",
        });
      } else {
        findings.push({
          id: "pixel-noise",
          label: "Sensor noise floor",
          status: "pass",
          weight: 0,
          category: "pixel",
          observed: `Flat-region noise ${pm.noiseStd} (${pm.flatBlockCount} flat blocks) \u00b7 edge density ${pm.edgeDensity}`,
          expected: "Measurable, uniform sensor noise",
          detail:
            pm.noiseStd < 0.5
              ? "Flat regions are heavily denoised, but a camera identity is present \u2014 consistent with modern computational photography (night mode, HDR stacking), not synthesis."
              : "Natural sensor noise texture present in flat regions.",
        });
      }
    }
  }

  if (options?.document) {
    step("Analyzing document structure (paper, text regions, tamper)\u2026");
    const doc = img ? await analyzeDocumentPixels(blob) : null;
    if (doc) {
      pushMetric("Document pixels", "Paper coverage", `${(doc.paperFraction * 100).toFixed(0)}%`, doc.looksLikeDocument ? "ok" : "weak", "\u226535% to qualify as a flat document");
      pushMetric("Document pixels", "Text / background blocks", `${doc.textBlockCount} / ${doc.backgroundBlockCount}`, "info", "\u22656 of each required for the tamper ratio");
      pushMetric(
        "Document pixels",
        "Text ELA tamper ratio",
        doc.textTamperRatio != null ? `${doc.textTamperRatio}\u00d7` : "n/a",
        doc.textTamperRatio == null ? "info" : doc.textTamperRatio > 2.6 ? "strong" : doc.textTamperRatio > 1.9 ? "weak" : "ok",
        "warn >1.9\u00d7 \u00b7 fail >2.6\u00d7"
      );
      pushMetric("Document pixels", "Background ELA uniformity", String(doc.backgroundUniformity), doc.backgroundUniformity > 9 ? "weak" : "ok", "\u22649 = untouched paper");
      pushMetric("Document pixels", "Halftone periodicity", String(doc.halftonePeriodicity), doc.halftonePeriodicity > 0.3 ? "weak" : "ok", ">0.3 = printed-copy ink pattern");
      pushMetric(
        "Document pixels",
        "Colorfulness (Hasler\u2013S\u00fcsstrunk)",
        String(doc.colorfulness),
        doc.looksLikeDocument && doc.colorfulness < 6 ? "weak" : "ok",
        "<6 = near-monochrome / photocopy cue"
      );
    }
    if (!doc) {
      findings.push({
        id: "doc-structure",
        label: "Document structure",
        status: "warn",
        weight: 6,
        detail: "Document pixel analysis unavailable \u2014 the browser could not decode this format. Export as JPEG and re-run.",
      });
    } else {
      findings.push({
        id: "doc-structure",
        label: "Document structure",
        status: doc.looksLikeDocument ? "pass" : "warn",
        weight: doc.looksLikeDocument ? 0 : 8,
        observed: `Paper coverage ${(doc.paperFraction * 100).toFixed(0)}% \u00b7 ${doc.textBlockCount} text blocks \u00b7 ${doc.backgroundBlockCount} background blocks`,
        expected: "\u226535% bright paper background with distinct text regions",
        detail: doc.looksLikeDocument
          ? "Frame is dominated by a bright, uniform paper background with distinct text regions \u2014 consistent with a flat document capture."
          : "Frame does not look like a flat document (low paper coverage). Recapture the document flat, filling most of the frame.",
      });
      if (doc.textTamperRatio != null) {
        if (doc.textTamperRatio > 2.6) {
          findings.push({
            id: "doc-text-tamper",
            label: "Text-region tamper analysis",
            status: "fail",
            weight: 20,
            observed: `Text ELA energy ${doc.textTamperRatio}\u00d7 the background`,
            expected: "\u22641.9\u00d7 (single-save documents compress text and paper together)",
            detail: `Text regions carry ${doc.textTamperRatio}\u00d7 the compression error of the paper background \u2014 strong indicator that text was pasted, retyped, or re-rendered after the original save.`,
          });
        } else if (doc.textTamperRatio > 1.9) {
          findings.push({
            id: "doc-text-tamper",
            label: "Text-region tamper analysis",
            status: "warn",
            weight: 10,
            observed: `Text ELA energy ${doc.textTamperRatio}\u00d7 the background`,
            expected: "\u22641.9\u00d7",
            detail: `Text regions re-compress moderately differently from the paper (${doc.textTamperRatio}\u00d7). Can indicate edited text \u2014 or just heavy sharpening. Inspect the ELA heat map around suspicious fields.`,
          });
        } else {
          findings.push({
            id: "doc-text-tamper",
            label: "Text-region tamper analysis",
            status: "pass",
            weight: 0,
            observed: `Text ELA energy ${doc.textTamperRatio}\u00d7 the background`,
            expected: "\u22641.9\u00d7",
            detail: "Text and paper share the same compression history \u2014 no sign of pasted or retyped text.",
          });
        }
      } else {
        findings.push({
          id: "doc-text-tamper",
          label: "Text-region tamper analysis",
          status: "info",
          weight: 0,
          detail: "Not enough text/background contrast to compare compression histories \u2014 capture the document sharper and closer.",
        });
      }
      if (doc.backgroundBlockCount >= 6) {
        findings.push({
          id: "doc-background",
          label: "Paper background uniformity",
          status: doc.backgroundUniformity > 9 ? "warn" : "pass",
          weight: doc.backgroundUniformity > 9 ? 8 : 0,
          observed: `Background ELA variation ${doc.backgroundUniformity}`,
          expected: "\u22649 (untouched paper compresses uniformly)",
          detail:
            doc.backgroundUniformity > 9
              ? "The paper background compresses inconsistently across regions \u2014 patches may have been cloned or whitened to cover content."
              : "Paper background is uniform \u2014 no cloned/whitened patches detected.",
        });
      }
      if (doc.halftonePeriodicity > 0.3) {
        findings.push({
          id: "doc-halftone",
          label: "Print halftone pattern",
          status: "info",
          weight: 0,
          observed: `Halftone periodicity ${doc.halftonePeriodicity}`,
          detail: "A fine periodic ink pattern suggests this is a photo/scan of a printed copy rather than an original digital document \u2014 not fraud by itself, but provenance is one generation removed.",
        });
      }
      if (doc.looksLikeDocument && doc.colorfulness < 6) {
        findings.push({
          id: "doc-photocopy",
          label: "Photocopy / monochrome check",
          status: "info",
          weight: 0,
          category: "document",
          observed: `Colorfulness ${doc.colorfulness} (Hasler\u2013S\u00fcsstrunk)`,
          expected: "Government IDs are printed in colour (guilloche, coloured portrait, holo laminate)",
          detail:
            "The capture is near-monochrome. Normal for B/W statements and paperwork \u2014 but if this should be a passport or licence, a black-and-white image points to a photocopy of the original (IDKit's looksLikePhotocopy signal). Ask for the physical colour document.",
        });
      }
      if (pixelMetrics && pixelMetrics.glareFraction > 0.05) {
        findings.push({
          id: "doc-glare",
          label: "Glare over document",
          status: "warn",
          weight: 5,
          observed: `${(pixelMetrics.glareFraction * 100).toFixed(1)}% blown-out pixels`,
          expected: "<5%",
          detail: "Strong glare obscures part of the document \u2014 fields under the hotspot cannot be verified. Recapture tilted away from the light.",
        });
      }
    }
  }

  if (options?.native) {
    step("Cross-checking native capture context (freshness, device, resolution)\u2026");
    findings.push(...nativeMismatchFindings(options.native, originalMs, options.fileLastModified ?? null, actualW, actualH, make, model));
    const n = options.native;
    pushMetric(
      "Capture channel",
      "change event isTrusted",
      n.changeIsTrusted == null ? "unknown" : String(n.changeIsTrusted),
      n.changeIsTrusted === false ? "strong" : n.changeIsTrusted === true ? "ok" : "info",
      "false = script-dispatched (definitive injection)"
    );
    pushMetric(
      "Capture channel",
      "input.files accessor native",
      n.filesApiNative == null ? "unknown" : String(n.filesApiNative),
      n.filesApiNative === false ? "strong" : n.filesApiNative === true ? "ok" : "info",
      "false = hooked accessor controls the returned file"
    );
    pushMetric(
      "Capture channel",
      "shutter press isTrusted",
      n.pressIsTrusted == null ? "unknown" : String(n.pressIsTrusted),
      n.pressIsTrusted === false ? "strong" : n.pressIsTrusted === true ? "ok" : "info",
      "false = script-fired press (automation chain)"
    );
    pushMetric(
      "Capture channel",
      "page hidden during camera round-trip",
      n.pageHiddenDuring == null ? "not tracked" : String(n.pageHiddenDuring),
      n.pageHiddenDuring === false ? "weak" : n.pageHiddenDuring === true ? "ok" : "info",
      "the native camera UI covers the page on phones — corroboration only"
    );
    if (n.elapsedSincePressMs != null && n.elapsedSincePressMs >= 0) {
      pushMetric(
        "Capture channel",
        "Press \u2192 file round-trip",
        `${Math.round(n.elapsedSincePressMs)}ms`,
        n.elapsedSincePressMs < 300 ? "strong" : n.elapsedSincePressMs < 1200 ? "weak" : "ok",
        "<300ms physically impossible \u00b7 <1200ms atypical \u00b7 recorded timings include the enforced 1\u20132s securing hold"
      );
    }
    if (n.deviceMaxPixels != null && n.deviceMaxPixels > 0) {
      pushMetric("Capture channel", "Device camera max (WebRTC caps)", `${(n.deviceMaxPixels / 1e6).toFixed(1)} MP`, "info", "stills >2.2\u00d7 this raise a soft flag");
    }
  }

  if (options?.extraFindings && options.extraFindings.length > 0) {
    step("Merging capture-channel integrity audit\u2026");
    findings.push(...options.extraFindings);
  }

  step("Rendering forensic visual heat maps\u2026");
  const visuals = img ? await buildImageVisuals(blob) : [];

  step("Fusing category scores and deriving the verdict\u2026");
  const score = scoreFindings(findings);
  // Live frames never carry EXIF — don't punish confidence for expected absence.
  // Trusted native with thin tags still has channel evidence; give partial metadata credit.
  const confidenceTagCount = isLiveFrame
    ? 8
    : trustedNativeChannel && meaningfulTagCount < 3
      ? Math.max(meaningfulTagCount, 3)
      : meaningfulTagCount;
  const confidenceTrace = computeConfidence({
    decoded: !!img,
    pixelAnalyzed,
    tagCount: confidenceTagCount,
    formatKnown: isJpeg || isPng || isWebp || isHeic,
    hasTimestamp: isLiveFrame || originalMs != null || (trustedNativeChannel && (options?.fileLastModified ?? 0) > 0),
  });
  const confidence = confidenceTrace.final;
  const verdictTraced = deriveVerdict(findings, score, confidence);
  const verdict = verdictTraced.verdict;
  let docOutcome: DocOutcome | undefined;
  if (options?.document) {
    const screenFail = findings.some((f) => f.id === "screen-replay" && f.status === "fail");
    const textTamper = findings.some((f) => f.id === "doc-text-tamper" && f.status === "fail");
    if (screenFail) docOutcome = "screen-recapture";
    else if (textTamper || verdict === "manipulated" || verdict === "ai-generated") docOutcome = "edited";
    else if (verdict === "authentic") docOutcome = "genuine-original";
    else docOutcome = "retake";
  }

  return {
    kind: "image",
    fileName,
    mimeType: blob.type || format,
    size: blob.size,
    score,
    confidence,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    findings,
    categories: buildCategoryScores(findings),
    retakeAdvice: buildRetakeAdvice(findings, verdict, options?.document ?? false),
    docOutcome,
    ela,
    visuals,
    telemetry: {
      engine: FORENSIC_ENGINE,
      scoring: buildScoreTrace(findings),
      confidence: { parts: confidenceTrace.parts, final: confidence, formula: CONFIDENCE_FORMULA },
      verdictTrace: verdictTraced.steps,
      metrics,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Cross-checks a supposed fresh native capture against the actual device and press moment.
 * Detects gallery picks, edited files, and generated images posing as new captures.
 */
function nativeMismatchFindings(
  ctx: NativeCaptureContext,
  exifCaptureMs: number | null,
  fileLastModified: number | null,
  width: number | null,
  height: number | null,
  make: string | null,
  model: string | null
): Finding[] {
  const findings: Finding[] = [];
  const windowMs = 3 * 60 * 1000;

  // Hard channel invariants that CAN corroborate a wrapped files accessor:
  // a script-dispatched change event, a script-fired shutter press, a
  // physically impossible sub-300ms camera round-trip, or a file written
  // before this page session started.
  const scriptEvent = ctx.changeIsTrusted === false;
  const scriptPress = ctx.pressIsTrusted === false;
  const instantReturn = ctx.elapsedSincePressMs != null && ctx.elapsedSincePressMs >= 0 && ctx.elapsedSincePressMs < 300;
  const preSessionFile =
    ctx.pageLoadedAt != null && fileLastModified != null && fileLastModified > 0 && fileLastModified < ctx.pageLoadedAt - 90 * 1000;
  const hardChannelCorroboration = scriptEvent || scriptPress || instantReturn || preSessionFile;
  const privacyBrowser = detectPrivacyBrowser();

  if (privacyBrowser.detected) {
    findings.push({
      id: "privacy-browser-context",
      label: "Privacy browser / in-app browser context",
      status: "info",
      weight: 0,
      category: "device",
      observed: `${privacyBrowser.name} — ${privacyBrowser.observed}`,
      expected: "Context note only — zero score weight",
      detail: `This capture was made in ${privacyBrowser.name}, whose tracker/fingerprinting protection legitimately wraps DOM APIs and may strip or re-encode photo metadata. Wrapped-API observations are expected here and are excluded from hard scoring. To clear channel cautions entirely, recapture in a standard browser (Safari or Chrome).`,
    });
  }

  if (ctx.changeIsTrusted != null) {
    findings.push(
      ctx.changeIsTrusted
        ? {
            id: "native-event-trust",
            label: "Capture event provenance (isTrusted)",
            status: "pass",
            weight: 0,
            category: "device",
            observed: "Trusted user-agent event",
            expected: "change event dispatched by the browser itself",
            detail: "The file arrived through a change event the browser dispatched — the selection came from the OS picker/camera UI, not from a script.",
          }
        : {
            id: "native-event-trust",
            label: "Capture event provenance (isTrusted)",
            status: "fail",
            weight: 40,
            category: "device",
            observed: "isTrusted = false — the change event was dispatched by JavaScript",
            expected: "isTrusted = true (only the user agent can set this)",
            detail:
              "This file was injected into the input programmatically (DataTransfer + synthetic event). Browsers guarantee isTrusted=true exclusively for events they dispatch themselves — a script cannot forge it. This is definitive evidence of automated file injection, not a real camera capture.",
          }
    );
  }

  // Shutter-press provenance: the browser sets isTrusted=true ONLY on events
  // it dispatched itself. A script-fired press means the whole capture flow
  // was driven by automation, not a person.
  if (ctx.pressIsTrusted != null) {
    findings.push(
      ctx.pressIsTrusted
        ? {
            id: "native-press-trust",
            label: "Shutter press provenance (isTrusted)",
            status: "pass",
            weight: 0,
            category: "device",
            observed: "Trusted user-agent press event",
            expected: "The capture button pressed by a real pointer/touch event",
            detail: "The shutter button was pressed by a genuine user-agent-dispatched event — a person, not a script, initiated this capture.",
          }
        : {
            id: "native-press-trust",
            label: "Shutter press provenance (isTrusted)",
            status: "fail",
            weight: 35,
            category: "device",
            observed: "isTrusted = false — the shutter press was fired by JavaScript",
            expected: "isTrusted = true (only the user agent can set this)",
            detail:
              "The event that opened the camera was dispatched programmatically (element.click() or a synthetic event). Browsers guarantee isTrusted=true exclusively for events they dispatch themselves — a scripted press means the capture flow was driven by automation, which is how injection attacks are executed at scale.",
          }
    );
  }

  // Camera-app visibility: on phones the native camera UI covers the browser,
  // so the page reports hidden during a genuine round-trip. Some in-app
  // browsers and split-screen setups legitimately keep the page visible, so
  // this NEVER condemns alone — corroboration-only.
  if (ctx.pageHiddenDuring != null) {
    findings.push(
      ctx.pageHiddenDuring
        ? {
            id: "native-page-hidden",
            label: "Camera app covered the page",
            status: "pass",
            weight: 0,
            category: "device",
            observed: "The page lost visibility during the capture round-trip",
            expected: "The native camera UI covers the browser on phones",
            detail: "The page went hidden between the shutter press and the file arriving — consistent with the OS camera app genuinely taking over the screen.",
          }
        : {
            id: "native-page-hidden",
            label: "Camera app covered the page",
            status: "warn",
            weight: 8,
            category: "device",
            observed: "The file arrived without the page ever losing visibility",
            expected: "On phones, opening the native camera hides the page (visibilitychange → hidden)",
            detail:
              "The capture completed while the page stayed fully visible — atypical for a genuine camera-app round-trip on a phone, and characteristic of scripted file injection that never opens a camera. Some in-app browsers, floating-window and split-screen modes legitimately keep the page visible, so this is corroborating evidence only, never standalone proof.",
          }
    );
  }

  if (ctx.filesApiNative === false) {
    if (hardChannelCorroboration) {
      const corroborators = [
        scriptEvent ? "script-dispatched change event" : null,
        scriptPress ? "script-fired shutter press" : null,
        instantReturn ? "physically impossible sub-300ms camera round-trip" : null,
        preSessionFile ? "file written before this session started" : null,
      ].filter(Boolean);
      findings.push({
        id: "native-files-api",
        label: "File input API integrity",
        status: "fail",
        weight: 28,
        category: "device",
        observed: `HTMLInputElement files/value accessor replaced by script — corroborated by: ${corroborators.join("; ")}`,
        expected: "Native browser accessor with a genuine capture timeline",
        detail:
          "The accessor this app uses to read the selected file has been overridden by JavaScript AND an independent hard channel invariant failed in the same capture. A wrapped accessor alone can be a privacy browser; combined with a definitive timeline violation it means a script controlled what file was returned — automated injection.",
      });
    } else {
      findings.push({
        id: "native-files-api",
        label: "File input API integrity",
        status: "warn",
        weight: 6,
        category: "device",
        observed: `HTMLInputElement files/value accessor is wrapped by a script${privacyBrowser.detected ? ` (running in ${privacyBrowser.name})` : ""}`,
        expected: "Native browser accessor",
        detail: `The accessor this app uses to read the selected file is wrapped by JavaScript. Verified privacy browsers (DuckDuckGo, Brave, Firefox Focus) and in-app browsers wrap DOM accessors as a product feature, so this is NOT proof of tampering on its own${privacyBrowser.detected ? ` — and this session runs in ${privacyBrowser.name}, where it is expected` : ""}. Every hard timeline invariant of this capture (trusted event, round-trip time, file age) passed. To clear this caution entirely, recapture in a standard browser (Safari or Chrome).`,
      });
    }
  }

  if (ctx.elapsedSincePressMs != null && ctx.elapsedSincePressMs >= 0) {
    const el = ctx.elapsedSincePressMs;
    if (el < 300) {
      findings.push({
        id: "native-return-speed",
        label: "Capture round-trip time",
        status: "fail",
        weight: 25,
        category: "device",
        observed: `File arrived ${Math.round(el)}ms after the shutter press`,
        expected: "Several seconds: camera UI must open, focus, capture and encode — and every genuine return additionally carries the enforced 1–2s securing hold",
        detail:
          "A real camera app (or even the fastest human file pick) physically cannot return a photo in under ~0.3s — and this app holds every genuine capture for a 1–2s bell-curve securing delay before the round-trip is recorded, so honest timings are always well above this line. A sub-0.3s recorded return means software answered the capture request directly — automated injection.",
      });
    } else if (el < 1200) {
      findings.push({
        id: "native-return-speed",
        label: "Capture round-trip time",
        status: "warn",
        weight: 6,
        category: "device",
        observed: `File arrived ${Math.round(el)}ms after the shutter press`,
        expected: "Several seconds for a genuine camera round-trip",
        detail: "Unusually fast for opening a camera, framing and shooting — possible but atypical. Soft signal only.",
      });
    } else {
      findings.push({
        id: "native-return-speed",
        label: "Capture round-trip time",
        status: "pass",
        weight: 0,
        category: "device",
        observed: `${(el / 1000).toFixed(1)}s from press to file`,
        expected: "Consistent with a real camera round-trip",
        detail: "The time between the shutter press and the file arriving matches a genuine camera-app round-trip.",
      });
    }
  }

  if (ctx.pageLoadedAt != null && fileLastModified != null && fileLastModified > 0 && fileLastModified < ctx.pageLoadedAt - 90 * 1000) {
    findings.push({
      id: "native-file-age",
      label: "File age vs this session",
      status: "fail",
      weight: 22,
      category: "device",
      observed: `File written ${Math.round((ctx.pageLoadedAt - fileLastModified) / 60000)} min BEFORE this page session started`,
      expected: "A fresh capture is written after the shutter press, always inside the session",
      detail:
        "The file's timestamp predates this verification session entirely — it existed before the page was even opened. That is a pre-existing file (gallery pick, download, or injected asset) presented as a fresh capture.",
    });
  }

  if (exifCaptureMs != null) {
    const delta = Math.abs(exifCaptureMs - ctx.pressedAt);
    // EXIF is whole-second + optional offset; allow a generous window so TZ edge
    // cases and multi-minute camera-app framing never false-fail a real shot.
    const softWindowMs = 15 * 60 * 1000;
    if (delta <= windowMs) {
      findings.push({
        id: "native-freshness",
        label: "Native capture freshness (EXIF vs shutter press)",
        status: "pass",
        weight: 0,
        detail: `EXIF capture time is ${Math.round(delta / 1000)}s from the moment you pressed the button — genuinely fresh.`,
      });
    } else if (delta <= softWindowMs) {
      findings.push({
        id: "native-freshness",
        label: "Native capture freshness (EXIF vs shutter press)",
        status: "warn",
        weight: 4,
        detail: `EXIF capture time is ${Math.round(delta / 60000)} min from the shutter press — still inside a normal camera-app session window (framing, retakes, clock skew). Soft caution only.`,
      });
    } else {
      findings.push({
        id: "native-freshness",
        label: "Native capture freshness (EXIF vs shutter press)",
        status: "fail",
        weight: 22,
        detail: `EXIF capture time differs from the button press by ${Math.round(delta / 60000)} min — this photo was NOT taken in this capture attempt. Likely picked from disk or metadata was forged.`,
      });
    }
  } else if (fileLastModified != null && fileLastModified > 0) {
    const delta = Math.abs(fileLastModified - ctx.pressedAt);
    if (delta <= windowMs) {
      findings.push({
        id: "native-freshness",
        label: "Native capture freshness (file time vs shutter press)",
        status: "pass",
        weight: 0,
        detail: `No EXIF timestamp (common after browser re-encode), but the file was written ${Math.round(delta / 1000)}s from the press — consistent with a fresh capture.`,
      });
    } else if (delta <= 15 * 60 * 1000) {
      findings.push({
        id: "native-freshness",
        label: "Native capture freshness (file time vs shutter press)",
        status: "warn",
        weight: 4,
        detail: `No EXIF timestamp; file mtime is ${Math.round(delta / 60000)} min from the press — possible retake/session skew. Soft caution.`,
      });
    } else {
      findings.push({
        id: "native-freshness",
        label: "Native capture freshness (file time vs shutter press)",
        status: "fail",
        weight: 18,
        detail: `File timestamp is ${Math.round(delta / 60000)} min away from the button press — this is an old file, not a fresh capture.`,
      });
    }
  } else {
    findings.push({
      id: "native-freshness",
      label: "Native capture freshness",
      status: "info",
      weight: 0,
      detail:
        "No capture or file timestamp available to cross-check freshness. Channel trust (isTrusted, round-trip time, page visibility) still applies — absence of a clock is not itself fraud.",
    });
  }

  if (ctx.deviceMaxPixels != null && ctx.deviceMaxPixels > 0 && width && height) {
    const photoPixels = width * height;
    // Still capture routinely exceeds the WebRTC video-track max (esp. iPhone).
    // Only flag absurd multiples; never hard-fail.
    if (photoPixels > ctx.deviceMaxPixels * 4) {
      findings.push({
        id: "native-resolution",
        label: "Resolution vs this device's camera",
        status: "warn",
        weight: 4,
        detail: `Photo is ${width}×${height} (${(photoPixels / 1e6).toFixed(1)} MP) while this device's camera track reports max ~${(ctx.deviceMaxPixels / 1e6).toFixed(1)} MP via WebRTC. Native stills can exceed the video pipeline — soft signal only at extreme multiples.`,
      });
    } else {
      findings.push({
        id: "native-resolution",
        label: "Resolution vs this device's camera",
        status: "pass",
        weight: 0,
        detail: `${width}×${height} is plausible for this device (stills may exceed the WebRTC video max).`,
      });
    }
  }

  if (!make && !model) {
    const pb = detectPrivacyBrowser();
    findings.push({
      id: "native-device-identity",
      label: "Device identity on native capture",
      status: "info",
      weight: 0,
      detail: pb.detected
        ? `No Make/Model tags — expected in ${pb.name}, which strips camera identity. Channel trust carries this capture; not scored as suspicious.`
        : "No Make/Model tags on this native return. Mobile browsers (Safari especially) frequently strip camera identity from <input capture> files even for genuine shots — recorded, not scored. Channel trust and pixel checks decide authenticity.",
    });
  }

  return findings;
}

// ─────────────────────────── Video forensics ───────────────────────────

type Mp4Box = { type: string; start: number; size: number; headerSize: number };

async function readBoxHeader(blob: Blob, offset: number): Promise<Mp4Box | null> {
  if (offset + 8 > blob.size) return null;
  const buf = await blob.slice(offset, offset + 16).arrayBuffer();
  if (buf.byteLength < 8) return null;
  const view = new DataView(buf);
  let size = view.getUint32(0);
  const type = toAscii(new Uint8Array(buf, 4, 4));
  let headerSize = 8;
  if (size === 1 && buf.byteLength >= 16) {
    const hi = view.getUint32(8);
    const lo = view.getUint32(12);
    size = hi * 4294967296 + lo;
    headerSize = 16;
  } else if (size === 0) {
    size = blob.size - offset;
  }
  if (size < headerSize) return null;
  return { type, start: offset, size, headerSize };
}

async function listTopLevelBoxes(blob: Blob, limit = 40): Promise<Mp4Box[]> {
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset + 8 <= blob.size && boxes.length < limit) {
    const box = await readBoxHeader(blob, offset);
    if (!box || !/^[\x20-\x7e]{4}$/.test(box.type)) break;
    boxes.push(box);
    offset = box.start + box.size;
  }
  return boxes;
}

function listChildBoxes(view: DataView, start: number, end: number): { type: string; start: number; size: number; headerSize: number }[] {
  const out: { type: string; start: number; size: number; headerSize: number }[] = [];
  let offset = start;
  while (offset + 8 <= end && out.length < 64) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );
    let headerSize = 8;
    if (size === 1 && offset + 16 <= end) {
      size = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || !/^[\x20-\x7e]{4}$/.test(type)) break;
    out.push({ type, start: offset, size, headerSize });
    offset += size;
  }
  return out;
}

const MP4_EPOCH_OFFSET_MS = 2082844800000; // 1904-01-01 → 1970-01-01

/**
 * Full forensic analysis of a video container. Parses MP4/MOV boxes (ftyp, moov,
 * mvhd, trak, udta) and scans for encoder/AI fingerprints. Runs entirely on-device.
 */
export async function analyzeVideoFraud(
  blob: Blob,
  fileName: string,
  options?: { fileLastModified?: number; onStep?: (message: string) => void }
): Promise<MediaFraudReport> {
  const findings: Finding[] = [];
  const metrics: MetricEntry[] = [];
  const pushMetric = (group: string, name: string, value: string, state: MetricState, threshold?: string) => {
    metrics.push({ group, name, value, threshold, state });
  };
  const step = (m: string) => options?.onStep?.(m);
  step(`Reading container structure (${Math.round(blob.size / 1024)} KB)\u2026`);
  pushMetric("File", "Size", `${(blob.size / 1024).toFixed(1)} KB`, "info");
  const head = await blob.slice(0, 4).arrayBuffer();
  const headBytes = new Uint8Array(head);
  const isEbml =
    headBytes.length >= 4 &&
    headBytes[0] === 0x1a &&
    headBytes[1] === 0x45 &&
    headBytes[2] === 0xdf &&
    headBytes[3] === 0xa3;

  const headAscii = await readAsciiWindow(blob, 0, 256 * 1024);
  const tailAscii = blob.size > 256 * 1024 ? await readAsciiWindow(blob, blob.size - 512 * 1024, 512 * 1024) : "";
  let scanText = headAscii + tailAscii;

  if (isEbml) {
    findings.push({
      id: "container-format",
      label: "Container format",
      status: "warn",
      weight: 12,
      detail:
        "WebM/Matroska container — phone camera apps never record WebM. This is browser MediaRecorder output, a screen recording, or a transcode.",
    });
  } else {
    const boxes = await listTopLevelBoxes(blob);
    const ftyp = boxes.find((b) => b.type === "ftyp");
    const moov = boxes.find((b) => b.type === "moov");

    if (!ftyp) {
      findings.push({
        id: "container-format",
        label: "Container format",
        status: "warn",
        weight: 10,
        detail: "No MP4 'ftyp' box found — unrecognized or malformed video container.",
      });
    } else {
      const ftypBuf = await blob.slice(ftyp.start + 8, ftyp.start + Math.min(ftyp.size, 64)).arrayBuffer();
      const brandText = toAscii(new Uint8Array(ftypBuf));
      const major = brandText.slice(0, 4).trim();
      const cameraBrands = ["qt", "mp42", "isom", "3gp4", "3gp5", "heic", "hevc", "avc1"];
      const isCameraBrand = cameraBrands.some((b) => major.toLowerCase().startsWith(b.toLowerCase()));
      findings.push({
        id: "container-format",
        label: "Container brand",
        status: isCameraBrand ? "pass" : "warn",
        weight: isCameraBrand ? 0 : 6,
        detail: `Major brand '${major}' (compat: ${brandText.slice(8, 32).trim() || "—"}). ${
          major.toLowerCase().startsWith("qt")
            ? "QuickTime brand — matches iPhone camera recordings."
            : isCameraBrand
              ? "Standard camera/encoder brand."
              : "Unusual brand for a phone camera recording."
        }`,
      });
    }

    if (moov && moov.size <= 12 * 1024 * 1024) {
      const moovBuf = await blob.slice(moov.start, moov.start + moov.size).arrayBuffer();
      const moovView = new DataView(moovBuf);
      const moovAscii = toAscii(new Uint8Array(moovBuf)).toLowerCase();
      scanText += moovAscii;

      const children = listChildBoxes(moovView, 8, moovBuf.byteLength);
      const mvhd = children.find((c) => c.type === "mvhd");
      if (mvhd) {
        const version = moovView.getUint8(mvhd.start + mvhd.headerSize);
        let creationMs: number | null = null;
        if (version === 0) {
          creationMs = moovView.getUint32(mvhd.start + mvhd.headerSize + 4) * 1000 - MP4_EPOCH_OFFSET_MS;
        } else if (version === 1) {
          const hi = moovView.getUint32(mvhd.start + mvhd.headerSize + 4);
          const lo = moovView.getUint32(mvhd.start + mvhd.headerSize + 8);
          creationMs = (hi * 4294967296 + lo) * 1000 - MP4_EPOCH_OFFSET_MS;
        }
        const now = Date.now();
        if (creationMs == null || creationMs <= -MP4_EPOCH_OFFSET_MS + 1000 || creationMs === 0 - MP4_EPOCH_OFFSET_MS) {
          findings.push({
            id: "video-creation-time",
            label: "Container creation time",
            status: "warn",
            weight: 10,
            detail: "Creation time is zeroed — cameras stamp real times; re-encoders (FFmpeg, web exports, AI pipelines) often write zero.",
          });
        } else if (creationMs < 946684800000) {
          findings.push({
            id: "video-creation-time",
            label: "Container creation time",
            status: "warn",
            weight: 10,
            detail: `Creation time is implausibly old (${new Date(creationMs).toISOString().slice(0, 10)}) — typical of re-encodes with blank clocks.`,
          });
        } else if (creationMs > now + 26 * 3600 * 1000) {
          findings.push({
            id: "video-creation-time",
            label: "Container creation time",
            status: "fail",
            weight: 15,
            detail: `Creation time is in the future (${new Date(creationMs).toISOString()}) — forged or corrupted.`,
          });
        } else {
          findings.push({
            id: "video-creation-time",
            label: "Container creation time",
            status: "pass",
            weight: 0,
            detail: `Recorded ${new Date(creationMs).toLocaleString()}.`,
          });
          const lastModified = options?.fileLastModified;
          if (lastModified != null && lastModified > 0 && Math.abs(lastModified - creationMs) > 60 * 24 * 3600 * 1000) {
            findings.push({
              id: "video-time-gap",
              label: "Creation vs file-modified gap",
              status: "info",
              weight: 0,
              detail: "File-modified time is far from the recording time — transferred or exported later.",
            });
          }
        }
      }

      const trakCount = children.filter((c) => c.type === "trak").length;
      const hasSoun = moovAscii.includes("soun");
      const hasVide = moovAscii.includes("vide");
      findings.push({
        id: "video-tracks",
        label: "Track layout",
        status: "info",
        weight: 0,
        detail: `${trakCount} track(s) — video:${hasVide ? "yes" : "no"}, audio:${hasSoun ? "yes" : "no"}.${
          trakCount === 1 && !hasSoun ? " Single silent video track — common for exports/AI clips; camera recordings normally include audio." : ""
        }`,
      });
      if (trakCount === 1 && !hasSoun && hasVide) {
        findings.push({
          id: "video-silent",
          label: "Missing audio track",
          status: "warn",
          weight: 5,
          detail: "No audio track — phone camera recordings virtually always carry one.",
        });
      }

      const deviceTagHit =
        moovAscii.includes("com.apple.quicktime.make") ||
        moovAscii.includes("com.apple.quicktime.model") ||
        moovAscii.includes("com.android.version") ||
        moovAscii.includes("com.android.manufacturer");
      if (deviceTagHit) {
        findings.push({
          id: "video-device-tags",
          label: "Camera-origin device tags",
          status: "pass",
          weight: 0,
          detail: "Manufacturer/device tags found in the container (Apple QuickTime keys or Android version tags) — strong camera-origin indicator.",
        });
      } else {
        findings.push({
          id: "video-device-tags",
          label: "Camera-origin device tags",
          status: "warn",
          weight: 10,
          detail: "No device make/model tags in the container — real phone recordings carry them; exports and AI clips do not.",
        });
      }

      if (moovAscii.includes("com.apple.quicktime.location") || moovAscii.includes("\xa9xyz")) {
        findings.push({
          id: "video-location",
          label: "Location tag",
          status: "info",
          weight: 0,
          detail: "GPS location tag present in container.",
        });
      }
    } else if (moov) {
      findings.push({
        id: "video-moov",
        label: "Movie metadata box",
        status: "info",
        weight: 0,
        detail: "moov box is unusually large — skipped deep parse; string scan still applied.",
      });
    } else {
      findings.push({
        id: "video-moov",
        label: "Movie metadata box",
        status: "warn",
        weight: 8,
        detail: "No moov box found in scanned ranges — fragmented/streaming output, not a normal camera file.",
      });
    }
  }

  findings.push(...markerFindings(scanText, "video"));

  const virtualHits = [...new Set(VIRTUAL_CAM_MARKERS.filter((m) => markerHit(scanText, m.marker)).map((m) => m.name))];
  if (virtualHits.length > 0) {
    findings.push({
      id: "video-virtual-cam",
      label: "Virtual camera / feed-injection fingerprint",
      status: "fail",
      weight: 25,
      category: "device",
      observed: virtualHits.join(", "),
      expected: "No virtual-camera or face-swap tool names in the container",
      detail: `Injection tooling fingerprint found in the container: ${virtualHits.join(", ")}. This video passed through a virtual camera / face-swap pipeline \u2014 the classic delivery method for real-time deepfakes.`,
    });
  } else {
    findings.push({
      id: "video-virtual-cam",
      label: "Virtual camera / feed-injection fingerprint",
      status: "pass",
      weight: 0,
      category: "device",
      observed: "No injection-tool markers",
      expected: "No virtual-camera tool names",
      detail: "No OBS Virtual Camera, ManyCam, DeepFaceLive, Avatarify or similar injection-tool fingerprints in the container.",
    });
  }

  step("Extracting frames for pixel & temporal analysis\u2026");
  let pixelAnalyzed = false;
  let visuals: ForensicVisual[] = [];
  try {
    const frames = await extractFrameCanvases(blob, 6, 480);
    step("Rendering forensic visual heat maps from sampled frames\u2026");
    visuals = buildVideoVisuals(frames);
    const temporal = compareFrames(frames);
    if (temporal) {
      pixelAnalyzed = true;
      pushMetric("Temporal", "Frames sampled", String(temporal.frames), "info");
      pushMetric("Temporal", "Mean inter-frame diff", String(temporal.meanFrameDiff), "info");
      pushMetric("Temporal", "Diff jumpiness (\u03c3)", String(temporal.diffJumpiness), "info");
      pushMetric("Temporal", "Static frame pairs", `${(temporal.staticFrameRatio * 100).toFixed(0)}%`, temporal.staticFrameRatio >= 0.8 ? "weak" : "ok", "\u226580% = replayed still cue");
      pushMetric("Temporal", "Global luma flicker", String(temporal.lumaFlicker), temporal.lumaFlicker > 18 ? "weak" : "ok", ">18 = display refresh beat");
      pushMetric("Temporal", "Average flat-region noise", String(temporal.avgNoiseStd), temporal.avgNoiseStd < 0.4 ? "weak" : "ok", "<0.4 = denoised / AI cue");
      findings.push({
        id: "video-temporal",
        label: "Temporal frame statistics",
        status: "info",
        weight: 0,
        observed: `mean frame diff ${temporal.meanFrameDiff} \u00b7 jumpiness ${temporal.diffJumpiness} \u00b7 luma flicker ${temporal.lumaFlicker} \u00b7 static pairs ${(temporal.staticFrameRatio * 100).toFixed(0)}%`,
        detail: `Sampled ${temporal.frames} frames across the timeline for motion, flicker and texture statistics.`,
      });
      if (temporal.staticFrameRatio >= 0.8) {
        findings.push({
          id: "video-static",
          label: "Motion plausibility",
          status: "warn",
          weight: 8,
          observed: `${(temporal.staticFrameRatio * 100).toFixed(0)}% of sampled frame pairs are near-identical`,
          expected: "Natural motion between frames sampled seconds apart",
          detail: "Frames sampled across the whole timeline barely change \u2014 consistent with a replayed still image or a slideshow posing as live footage.",
        });
      }
      if (temporal.lumaFlicker > 18) {
        findings.push({
          id: "video-flicker",
          label: "Global luminance flicker",
          status: "warn",
          weight: 8,
          observed: `Luma flicker ${temporal.lumaFlicker}`,
          expected: "\u226418 for stable camera footage",
          detail: "Strong global brightness oscillation between frames \u2014 typical of filming a display (refresh beat) or unstable re-projection.",
        });
      }
      if (temporal.avgNoiseStd < 0.4) {
        findings.push({
          id: "video-noise",
          label: "Frame noise floor",
          status: "warn",
          weight: 6,
          observed: `Average flat-region noise ${temporal.avgNoiseStd}`,
          expected: "Real sensors leave >0.4 noise in flat regions",
          detail: "Frames are unnaturally clean \u2014 consistent with AI-rendered video or heavy denoising. Soft signal; corroboration required.",
        });
      }
      const mid = frames[Math.floor(frames.length / 2)];
      const pm = computePixelMetricsFromCanvas(mid);
      if (pm) {
        const replay = assessScreenReplay(pm);
        for (const s of replay.signals) {
          pushMetric("Screen replay (mid frame)", s.label, String(s.value), s.triggered === "no" ? "ok" : s.triggered, `weak \u2265${s.threshold}`);
        }
        pushMetric(
          "Screen replay (mid frame)",
          "Fused replay evidence",
          `${Math.round(replay.score * 100)}% (${replay.verdict})`,
          replay.verdict === "likely" ? "strong" : replay.verdict === "weak" ? "weak" : "ok",
          "likely requires \u22652 strong OR 1 strong + 2 weak signals"
        );
        const signalText = replay.signals
          .map((s) => `${s.label}: ${s.value}${s.triggered !== "no" ? ` [${s.triggered.toUpperCase()}]` : ""}`)
          .join(" \u00b7 ");
        findings.push({
          id: "video-screen-replay",
          label: "Screen-replay detection (sampled frame)",
          status: replay.verdict === "likely" ? "fail" : replay.verdict === "weak" ? "warn" : "pass",
          weight: replay.verdict === "likely" ? 20 : replay.verdict === "weak" ? 8 : 0,
          category: "screen",
          observed: signalText,
          expected: "No periodic grid, banding, or panel glare in frames",
          detail:
            replay.verdict === "likely"
              ? `Multiple recapture signals in the sampled frame (evidence ${Math.round(replay.score * 100)}%): ${replay.signals.filter((s) => s.triggered !== "no").map((s) => s.detail).join(" ")}`
              : replay.verdict === "weak"
                ? "One weak recapture cue in the sampled frame \u2014 not conclusive alone."
                : "No evidence the footage was filmed off a display.",
        });
      }
    }
  } catch (err) {
    findings.push({
      id: "video-pixels",
      label: "Frame pixel analysis",
      status: "info",
      weight: 0,
      detail: `Frames could not be decoded in this browser (${err instanceof Error ? err.message : String(err)}) \u2014 container and marker checks still apply.`,
    });
  }

  step("Fusing category scores and deriving the verdict\u2026");
  const score = scoreFindings(findings);
  const confidenceTrace = computeConfidence({
    decoded: pixelAnalyzed,
    pixelAnalyzed,
    tagCount: findings.some((f) => f.id === "video-device-tags" && f.status === "pass") ? 8 : 3,
    formatKnown: findings.some((f) => f.id === "container-format" && f.status === "pass"),
    hasTimestamp: findings.some((f) => f.id === "video-creation-time" && f.status === "pass"),
  });
  const confidence = confidenceTrace.final;
  const verdictTraced = deriveVerdict(findings, score, confidence);
  const verdict = verdictTraced.verdict;

  return {
    kind: "video",
    fileName,
    mimeType: blob.type || "video/*",
    size: blob.size,
    score,
    confidence,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    findings,
    categories: buildCategoryScores(findings),
    retakeAdvice: buildRetakeAdvice(findings, verdict, false),
    visuals,
    telemetry: {
      engine: FORENSIC_ENGINE,
      scoring: buildScoreTrace(findings),
      confidence: { parts: confidenceTrace.parts, final: confidence, formula: CONFIDENCE_FORMULA },
      verdictTrace: verdictTraced.steps,
      metrics,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Merges the on-device forensic score with an AI vision verdict into one final
 * assessment. Conservative by design: a lone medium-confidence AI opinion
 * cannot condemn a file that forensics found clean — corroboration is required.
 */
export function mergeAssessment(report: MediaFraudReport, ai: AiMediaVerdict): { verdict: FraudVerdict; label: string; summary: string } {
  if (ai.verdict === "ai-generated") {
    if (ai.confidence >= 70) {
      return {
        verdict: "ai-generated",
        label: VERDICT_LABELS["ai-generated"],
        summary: `AI vision model flags this as AI-generated with high confidence (${ai.confidence}%)${report.verdict === "ai-generated" ? " and forensic signatures agree" : ` while the forensic score is ${report.score}/100`}.`,
      };
    }
    if (ai.confidence >= 55 && report.score < 75) {
      return {
        verdict: "ai-generated",
        label: VERDICT_LABELS["ai-generated"],
        summary: `AI vision model suspects generation (${ai.confidence}%) and forensics corroborate with a weak score of ${report.score}/100.`,
      };
    }
    if (ai.confidence >= 55) {
      return {
        verdict: "suspicious",
        label: VERDICT_LABELS.suspicious,
        summary: `AI vision model suspects generation (${ai.confidence}%) but on-device forensics found clean provenance (${report.score}/100). One uncorroborated signal \u2014 downgraded to suspicious to avoid a false positive; verify at the source.`,
      };
    }
  }
  if (ai.verdict === "manipulated" && ai.confidence >= 55 && report.score < 80) {
    return {
      verdict: "manipulated",
      label: VERDICT_LABELS.manipulated,
      summary: `AI vision model sees manipulation (${ai.confidence}% confidence) and forensics score only ${report.score}/100 \u2014 two independent layers agree.`,
    };
  }
  if (ai.verdict === "authentic" && ai.confidence >= 65) {
    if (report.verdict === "authentic") {
      return {
        verdict: "authentic",
        label: VERDICT_LABELS.authentic,
        summary: `Both forensics (${report.score}/100, confidence ${report.confidence}%) and the AI vision model (${ai.confidence}%) point to an authentic capture.`,
      };
    }
    if (report.verdict === "needs-more-info" && ai.confidence >= 75) {
      return {
        verdict: "authentic",
        label: VERDICT_LABELS.authentic,
        summary: `Metadata evidence was thin (confidence ${report.confidence}%), but the AI vision model sees no synthesis or manipulation artifacts (${ai.confidence}%). Probably authentic with unverified provenance.`,
      };
    }
  }
  return {
    verdict: report.verdict,
    label: report.verdictLabel,
    summary: `Forensic verdict kept (${report.score}/100, confidence ${report.confidence}%); AI model says "${ai.verdict}" at ${ai.confidence}% — signals are mixed, verify manually.`,
  };
}

/** Formats a full report (plus optional AI verdict) as shareable plain text. */
export function formatReportText(report: MediaFraudReport, ai?: AiMediaVerdict | null): string {
  const lines: string[] = [
    "═══ FRAUD LAB REPORT ═══",
    `File: ${report.fileName} (${report.mimeType}, ${(report.size / 1024).toFixed(1)} KB)`,
    `Kind: ${report.kind}`,
    `Analyzed: ${report.generatedAt}`,
    `Forensic score: ${report.score}/100 · evidence confidence: ${report.confidence}%`,
    `Verdict: ${report.verdictLabel}`,
    ...(report.docOutcome ? [`Document outcome: ${DOC_OUTCOME_LABELS[report.docOutcome]}`] : []),
    "",
    "── Category scores ──",
    ...report.categories.map((c) => `${c.label}: ${c.score}/100 (${c.fails} fail, ${c.warns} warn, ${c.findings} checks)`),
    "",
    "── Findings (evidence trail) ──",
  ];
  for (const f of report.findings) {
    const impact = findingImpact(f);
    lines.push(`[${f.status.toUpperCase()}${impact > 0 ? ` −${impact} pts` : ""}] (${CATEGORY_LABELS[categoryOf(f)]}) ${f.label}`);
    if (f.observed) lines.push(`    observed: ${f.observed}`);
    if (f.expected) lines.push(`    expected: ${f.expected}`);
    lines.push(`    ${f.detail}`);
  }
  if (report.retakeAdvice.length > 0) {
    lines.push("", "── Requested repeat / retake ──", ...report.retakeAdvice.map((a) => `• ${a}`));
  }
  if (report.ela) {
    lines.push("", `── ELA ── mean diff ${report.ela.meanDiff}, block inconsistency ${report.ela.blockInconsistency}`);
  }
  if (ai) {
    lines.push(
      "",
      "── AI Vision Verdict ──",
      `Model: ${ai.model}`,
      `Verdict: ${ai.verdict} (${ai.confidence}% confidence)${ai.framesAnalyzed ? ` · ${ai.framesAnalyzed} frames` : ""}`,
      `Reasoning: ${ai.reasoning}`,
      ...(ai.indicators.length ? [`Indicators: ${ai.indicators.join("; ")}`] : [])
    );
    const merged = mergeAssessment(report, ai);
    lines.push("", `── FINAL ASSESSMENT ── ${merged.label}`, merged.summary);
  }
  if (report.telemetry) {
    const t = report.telemetry;
    lines.push("", `═══ TECHNICAL APPENDIX (engine ${t.engine}) ═══`);
    lines.push("", "── Score ledger ──", t.scoring.formula, `Base score: ${t.scoring.base}`);
    for (const e of t.scoring.entries) {
      if (e.penalty > 0) {
        lines.push(`  −${e.penalty.toFixed(1)} pts · [${e.status.toUpperCase()}] ${e.id} (${CATEGORY_LABELS[e.category]}) — weight ${e.weight} × ${e.multiplier}`);
      }
    }
    const zeroImpact = t.scoring.entries.filter((e) => e.penalty === 0).length;
    lines.push(`  (${zeroImpact} checks passed or informational — zero penalty)`);
    lines.push(`  Total penalty ${t.scoring.totalPenalty} → final score ${t.scoring.finalScore}/100`);
    lines.push("", "── Confidence ledger ──", t.confidence.formula);
    for (const p of t.confidence.parts) lines.push(`  +${p.points} · ${p.label}: ${p.observed}`);
    lines.push(`  Final evidence confidence: ${t.confidence.final}%`);
    lines.push("", "── Verdict derivation trace ──");
    for (const s of t.verdictTrace) lines.push(`  ${s}`);
    if (t.metrics.length > 0) {
      lines.push("", "── Raw signal measurements ──");
      let lastGroup = "";
      for (const m of t.metrics) {
        if (m.group !== lastGroup) {
          lines.push(`  [${m.group}]`);
          lastGroup = m.group;
        }
        lines.push(`    ${m.name}: ${m.value}${m.threshold ? ` · threshold: ${m.threshold}` : ""} — ${m.state === "ok" ? "OK" : m.state === "info" ? "INFO" : `${m.state.toUpperCase()} TRIGGER`}`);
      }
    }
    if (report.visuals && report.visuals.length > 0) {
      lines.push("", "── Visual evidence rendered (inspect images in the app) ──");
      for (const v of report.visuals) lines.push(`  • ${v.label} — ${v.caption}`);
    }
  }
  return lines.join("\n");
}

/**
 * Copy of a report safe for JSON export: bulky data-URL images are replaced by
 * their stats/captions while every finding, metric, ledger and trace is kept.
 */
export function exportableReport(r: MediaFraudReport): Record<string, unknown> {
  return {
    ...r,
    ela: r.ela ? { meanDiff: r.ela.meanDiff, blockInconsistency: r.ela.blockInconsistency, note: "heat map image omitted from JSON export" } : null,
    visuals: (r.visuals ?? []).map((v) => ({ id: v.id, label: v.label, caption: v.caption, note: "image omitted from JSON export" })),
  };
}
