/**
 * Verification flow templates: 6 preset flows (passport / driver's licence ×
 * live-browser / native-camera capture modes), a custom-flow resolver, session
 * result types, conservative overall PASS/REVIEW/FAIL fusion, and corrective
 * report export (readable text + structured JSON).
 */

import {
  formatReportText,
  VERDICT_LABELS,
  type AiMediaVerdict,
  type Finding,
  type FindingStatus,
  type MediaFraudReport,
} from "@/lib/fraud-detection";
import {
  compareFaceDescriptions,
  MATCH_DISTANCE_MAX,
  MISMATCH_DISTANCE_MIN,
  type EnsembleMatch,
  type FaceDescription,
  type MatchOutcome,
} from "@/lib/face-vision";
import type { PulseEstimate } from "@/lib/ppg";
import { computeDocConfidence, type DocumentDataCheck } from "@/lib/mrz";
import { crossCheckLicenceData, type LicenceBarcodeCheck } from "@/lib/pdf417";
import type { QuickQuality } from "@/lib/capture-quality";

export type DocType = "passport" | "licence";
export type CaptureMethod = "webrtc" | "native";
export type FaceMode = "liveness" | "native-selfie" | "none";
export type LivenessVerdictKind = "live" | "not-live" | "inconclusive";

export type PageDef = {
  id: "photo-page" | "front" | "back";
  label: string;
  hint: string;
  /** True when this page carries the holder's portrait (used for face match). */
  portrait: boolean;
  /** Width/height aspect of the physical document for the framing guide. */
  guideAspect: number;
};

export type VerificationTemplate = {
  id: string;
  name: string;
  tagline: string;
  doc: DocType;
  docCapture: CaptureMethod;
  faceMode: FaceMode;
  pages: PageDef[];
};

export const PASSPORT_PHOTO_PAGE: PageDef = {
  id: "photo-page",
  label: "Passport photo page",
  hint: "Open the passport on the photo page. Fill the frame, avoid glare on the laminate, keep the MRZ (two bottom code lines) fully visible.",
  portrait: true,
  guideAspect: 125 / 88,
};

export const LICENCE_FRONT: PageDef = {
  id: "front",
  label: "Licence front",
  hint: "Place the licence front-side up on a flat surface. Fill the frame, all four corners visible, no fingers over text or portrait.",
  portrait: true,
  guideAspect: 85.6 / 54,
};

export const LICENCE_BACK: PageDef = {
  id: "back",
  label: "Licence back",
  hint: "Flip the licence to the back. Fill the frame with all four corners visible — barcodes and category table must be sharp.",
  portrait: false,
  guideAspect: 85.6 / 54,
};

export const TEMPLATES: VerificationTemplate[] = [
  {
    id: "passport-webrtc-all",
    name: "Passport — WebRTC All",
    tagline: "Photo page + full liveness, everything captured live in the browser at max resolution/fps",
    doc: "passport",
    docCapture: "webrtc",
    faceMode: "liveness",
    pages: [PASSPORT_PHOTO_PAGE],
  },
  {
    id: "licence-webrtc-all",
    name: "Driver's Licence — WebRTC All",
    tagline: "Front + back + full liveness, everything captured live in the browser at max resolution/fps",
    doc: "licence",
    docCapture: "webrtc",
    faceMode: "liveness",
    pages: [LICENCE_FRONT, LICENCE_BACK],
  },
  {
    id: "passport-native-doc",
    name: "Passport — Native Doc / WebRTC Face",
    tagline: "Photo page via the phone's camera app (full EXIF forensics), face via live browser liveness",
    doc: "passport",
    docCapture: "native",
    faceMode: "liveness",
    pages: [PASSPORT_PHOTO_PAGE],
  },
  {
    id: "licence-native-doc",
    name: "Driver's Licence — Native Doc / WebRTC Face",
    tagline: "Front + back via the phone's camera app (full EXIF forensics), face via live browser liveness",
    doc: "licence",
    docCapture: "native",
    faceMode: "liveness",
    pages: [LICENCE_FRONT, LICENCE_BACK],
  },
  {
    id: "passport-native-all",
    name: "Passport — Native All",
    tagline: "Photo page and selfie both via the phone's camera app with full EXIF/metadata analysis",
    doc: "passport",
    docCapture: "native",
    faceMode: "native-selfie",
    pages: [PASSPORT_PHOTO_PAGE],
  },
  {
    id: "licence-native-all",
    name: "Driver's Licence — Native All",
    tagline: "Front + back and selfie all via the phone's camera app with full EXIF/metadata analysis",
    doc: "licence",
    docCapture: "native",
    faceMode: "native-selfie",
    pages: [LICENCE_FRONT, LICENCE_BACK],
  },
];

/** Resolves a template by id; "custom" is built from URL search params. */
export function getTemplate(id: string, search: URLSearchParams): VerificationTemplate | null {
  if (id !== "custom") return TEMPLATES.find((t) => t.id === id) ?? null;
  const doc: DocType = search.get("doc") === "licence" ? "licence" : "passport";
  const docCapture: CaptureMethod = search.get("capture") === "native" ? "native" : "webrtc";
  const faceParam = search.get("face");
  const faceMode: FaceMode = faceParam === "native-selfie" ? "native-selfie" : faceParam === "none" ? "none" : "liveness";
  let pages: PageDef[];
  if (doc === "passport") {
    pages = [PASSPORT_PHOTO_PAGE];
  } else {
    const wanted = (search.get("pages") ?? "front,back").split(",").map((s) => s.trim());
    pages = [];
    if (wanted.includes("front")) pages.push(LICENCE_FRONT);
    if (wanted.includes("back")) pages.push(LICENCE_BACK);
    if (pages.length === 0) pages = [LICENCE_FRONT];
  }
  return {
    id: "custom",
    name: `Custom — ${doc === "passport" ? "Passport" : "Driver's Licence"}`,
    tagline: `${docCapture === "webrtc" ? "Live browser capture" : "Native camera app"} · ${
      faceMode === "liveness" ? "full liveness face step" : faceMode === "native-selfie" ? "native selfie face step" : "no face step"
    }`,
    doc,
    docCapture,
    faceMode,
    pages,
  };
}

export type PageResult = {
  page: PageDef;
  blob: Blob;
  url: string;
  fileName: string;
  captureMeta: string;
  report: MediaFraudReport;
  portrait: FaceDescription | null;
  /** Optional deep data check (MRZ + ICAO 9303 + zone cross-validation). */
  docData?: DocumentDataCheck | null;
  /** Licence-back PDF417/AAMVA data check (deterministic, local). */
  barcode?: LicenceBarcodeCheck | null;
  /** Instant local sharpness/glare gate computed at capture time. */
  quickQuality?: QuickQuality | null;
};

export type LivenessResult = {
  verdict: LivenessVerdictKind;
  findings: Finding[];
  pulse: PulseEstimate | null;
};

export type FaceStepResult = {
  mode: FaceMode;
  face: FaceDescription | null;
  url: string | null;
  /** Original selfie file blob (kept for AI verdicts and persistence). */
  blob?: Blob | null;
  /** EXIF/forensic report for a native selfie capture. */
  report: MediaFraudReport | null;
  liveness: LivenessResult | null;
  /** Total faces detected in the selfie frame (>1 = coaching/coercion review signal). */
  facesDetected?: number | null;
};

/** AI vision verdicts keyed by page id plus "selfie". */
export type SessionAiVerdicts = Record<string, AiMediaVerdict | null>;

/**
 * Deterministic licence-back barcode ↔ front-OCR cross-check findings for a
 * session (empty when either side is missing). Shared by the fusion and both
 * export formats so they always agree.
 */
export function licenceCrossFindings(pages: PageResult[]): Finding[] {
  const back = pages.find((p) => p.page.id === "back");
  const front = pages.find((p) => p.page.id === "front");
  if (!back?.barcode?.fields || !front?.docData) return [];
  return crossCheckLicenceData(back.barcode.fields, front.docData);
}

export type FaceCompare = {
  outcome: MatchOutcome;
  /** True when a raw mismatch was suppressed by quality gates. */
  gated: boolean;
  reasons: string[];
};

/**
 * Quality-gated face comparison identical to the Fraud Lab Face Match logic:
 * MobileFaceNet ArcFace embeddings (multi-detector, 5-point align, variant
 * ensemble) with the rule that a mismatch is never asserted from low-quality
 * captures.
 */
export function compareFaces(portrait: FaceDescription, live: FaceDescription): FaceCompare {
  const raw = compareFaceDescriptions(portrait, live);
  const issues = [
    ...portrait.quality.issues.map((i) => `Document portrait: ${i}`),
    ...live.quality.issues.map((i) => `Live face: ${i}`),
  ];
  if ((!portrait.quality.ok || !live.quality.ok) && raw.verdict === "mismatch") {
    return {
      outcome: { ...raw, verdict: "uncertain" },
      gated: true,
      reasons: [
        "A mismatch verdict was suppressed because capture quality is insufficient — a blurry, dark, or tiny face can look like a different person. Retake and compare again.",
        ...issues,
      ],
    };
  }
  const reasons =
    raw.verdict === "uncertain"
      ? [`Similarity landed in the ambiguous cosine band (distance ${MATCH_DISTANCE_MAX}–${MISMATCH_DISTANCE_MIN}). Retake both captures frontal, well-lit, without glasses.`, ...issues]
      : issues;
  return { outcome: raw, gated: false, reasons };
}

export type OverallVerdict = "pass" | "review" | "fail";

export type OverallResult = {
  verdict: OverallVerdict;
  reasons: string[];
  correctiveActions: string[];
};

/**
 * Conservative session fusion: FAIL requires a hard, corroborated signal
 * (manipulated/AI document, quality-passed face mismatch, or a not-live
 * verdict). Thin or ambiguous evidence becomes REVIEW with retake guidance —
 * never an accusation.
 */
export function computeOverall(
  template: VerificationTemplate,
  pages: PageResult[],
  face: FaceStepResult | null,
  compare: FaceCompare | null,
  ai?: SessionAiVerdicts
): OverallResult {
  const failReasons: string[] = [];
  const reviewReasons: string[] = [];
  const corrective: string[] = [];

  /**
   * Definitive capture-channel evidence: only findings backed by hard browser
   * guarantees ever reach fail status here (script-dispatched change events,
   * orphaned device anchors, consistent dual-path readback mismatch, files
   * predating the session, impossible round-trips). A wrapped files accessor
   * is a warn unless corroborated by one of those invariants — privacy
   * browsers (DuckDuckGo, Brave) wrap it legitimately — so its fail status
   * here always implies corroboration. Strong-but-explainable anomalies stay
   * warnings and can only reach REVIEW.
   */
  const HARD_CHANNEL_IDS = new Set(["native-event-trust", "native-files-api", "native-file-age", "native-return-speed"]);
  const injectionFailIds = (findings: { id: string; status: string; label: string }[]): string[] =>
    findings.filter((f) => f.status === "fail" && (f.id.startsWith("injection-") || HARD_CHANNEL_IDS.has(f.id))).map((f) => f.label);

  for (const p of pages) {
    const r = p.report;
    const injected = injectionFailIds(r.findings);
    if (injected.length > 0) {
      failReasons.push(`${p.page.label}: capture channel compromised — ${injected.join("; ")}`);
    }
    if (r.verdict === "manipulated" || r.verdict === "ai-generated") {
      failReasons.push(`${p.page.label}: ${r.verdictLabel} (score ${r.score}/100, confidence ${r.confidence}%)`);
    } else if (r.verdict === "suspicious") {
      reviewReasons.push(`${p.page.label}: ${r.verdictLabel} (score ${r.score}/100)`);
    } else if (r.verdict === "needs-more-info") {
      // Live browser frames carry no EXIF by design — low metadata confidence is
      // expected there and must not force a review on its own. Only pixel-level
      // outcomes (retake / recapture) keep their weight for webrtc captures.
      if (template.docCapture === "native") {
        reviewReasons.push(`${p.page.label}: more evidence needed (confidence ${r.confidence}%)`);
      } else if (r.docOutcome === "retake") {
        reviewReasons.push(`${p.page.label}: capture quality insufficient — retake requested`);
      }
    }
    if (r.docOutcome === "screen-recapture") reviewReasons.push(`${p.page.label}: looks like a photo of a screen — original document required`);
    for (const a of r.retakeAdvice) corrective.push(`${p.page.label}: ${a}`);

    // Deep data check (MRZ + ICAO 9303): checksum math is deterministic, but the
    // OCR read is model-based — so only corroborated failures (≥2 check digits,
    // zone mismatches) reach FAIL; single failures become REVIEW with advice.
    if (p.docData) {
      for (const f of p.docData.findings) {
        if (f.status === "fail") {
          failReasons.push(`${p.page.label} data check: ${f.label} — ${f.observed ?? f.detail}`);
        } else if (f.status === "warn") {
          reviewReasons.push(`${p.page.label} data check: ${f.label}${f.observed ? ` (${f.observed})` : ""}`);
          corrective.push(`${p.page.label}: re-run the deep data check with a sharper, glare-free capture of the code lines to rule out an OCR misread.`);
        }
      }
    }

    // Licence-back barcode check (deterministic local decode).
    if (p.barcode) {
      for (const f of p.barcode.findings) {
        if (f.status === "fail") {
          failReasons.push(`${p.page.label} barcode: ${f.label} — ${f.observed ?? f.detail}`);
        } else if (f.status === "warn") {
          reviewReasons.push(`${p.page.label} barcode: ${f.label}${f.observed ? ` (${f.observed})` : ""}`);
        }
      }
    }

    // AI vision verdict: a model opinion is corroborating evidence, never a
    // standalone FAIL — high-confidence non-authentic verdicts force REVIEW.
    const pageAi = ai?.[p.page.id];
    if (pageAi && (pageAi.verdict === "ai-generated" || pageAi.verdict === "manipulated") && pageAi.confidence >= 60) {
      reviewReasons.push(`${p.page.label}: AI vision verdict "${pageAi.verdict}" at ${pageAi.confidence}% confidence`);
      corrective.push(`${p.page.label}: the AI vision model flagged this capture — retake the original physical document and re-run the AI verdict.`);
    }
  }

  // Barcode ↔ front cross-checks (licence equivalent of MRZ↔VIZ).
  for (const f of licenceCrossFindings(pages)) {
    if (f.status === "fail") {
      failReasons.push(`Licence data cross-check: ${f.label} — ${f.observed ?? f.detail}`);
    } else if (f.status === "warn") {
      reviewReasons.push(`Licence data cross-check: ${f.label}${f.observed ? ` (${f.observed})` : ""}`);
      corrective.push("Retake the licence front sharper and re-run the data check — a single barcode/front disagreement is usually an OCR misread.");
    }
  }

  const expectedPages = template.pages.length;
  if (pages.length < expectedPages) {
    reviewReasons.push(`Only ${pages.length}/${expectedPages} document pages captured`);
    corrective.push("Capture every required document page before a final decision.");
  }

  if (template.faceMode !== "none") {
    if (!face) {
      reviewReasons.push("Face step not completed");
      corrective.push("Complete the live face step.");
    } else {
      // Liveness evidence counts whenever a session ran — including the
      // optional in-browser add-on run on top of a native selfie.
      if (face.liveness) {
        if (face.liveness.verdict === "not-live") {
          failReasons.push("Liveness: replay or injected feed suspected (corroborated by multiple signals)");
        } else if (face.liveness.verdict === "inconclusive") {
          reviewReasons.push("Liveness: inconclusive — not enough corroborating evidence");
          corrective.push("Repeat the liveness session in better light; hold still during the pulse phase.");
        }
        const injectedLive = injectionFailIds(face.liveness.findings);
        if (injectedLive.length > 0 && face.liveness.verdict !== "not-live") {
          failReasons.push(`Live face: capture channel compromised — ${injectedLive.join("; ")}`);
        }
      }
      if (face.mode === "native-selfie" && face.report) {
        const injectedSelfie = injectionFailIds(face.report.findings);
        if (injectedSelfie.length > 0) {
          failReasons.push(`Selfie: capture channel compromised — ${injectedSelfie.join("; ")}`);
        }
        if (face.report.verdict === "manipulated" || face.report.verdict === "ai-generated") {
          failReasons.push(`Selfie: ${face.report.verdictLabel} (score ${face.report.score}/100)`);
        } else if (face.report.verdict === "suspicious" || face.report.verdict === "needs-more-info") {
          reviewReasons.push(`Selfie: ${face.report.verdictLabel}`);
        }
        for (const a of face.report.retakeAdvice) corrective.push(`Selfie: ${a}`);
      }
      if (!face.face) {
        reviewReasons.push("No usable face found in the live capture");
        corrective.push("Retake the face capture: frontal, well lit, face ≥90px wide.");
      }
      // Multiple faces in frame — coaching/coercion review signal.
      if (face.facesDetected != null && face.facesDetected > 1) {
        reviewReasons.push(`Multiple faces (${face.facesDetected}) detected in the selfie frame — repeat the capture alone`);
        corrective.push("Retake the selfie with only your own face in the frame.");
      }
      if (face.liveness?.findings.some((f) => f.id === "multiple-faces" && f.status === "warn")) {
        reviewReasons.push("Multiple faces appeared repeatedly during the liveness session — repeat the session alone");
        corrective.push("Run the liveness session again with only your own face in the frame.");
      }
      const selfieAi = ai?.selfie;
      if (selfieAi && (selfieAi.verdict === "ai-generated" || selfieAi.verdict === "manipulated") && selfieAi.confidence >= 60) {
        reviewReasons.push(`Selfie: AI vision verdict "${selfieAi.verdict}" at ${selfieAi.confidence}% confidence`);
        corrective.push("Retake the selfie live and re-run the AI verdict.");
      }
    }

    const portraitPage = pages.find((p) => p.page.portrait);
    if (portraitPage && !portraitPage.portrait) {
      reviewReasons.push("No portrait detected on the document — face match unavailable");
      corrective.push(`Retake ${portraitPage.page.label}: portrait sharp, no glare across the photo.`);
    }

    if (compare) {
      if (compare.outcome.verdict === "mismatch") {
        failReasons.push(`Face match: DIFFERENT PERSON (distance ${compare.outcome.distance}, both captures passed quality gates)`);
      } else if (compare.outcome.verdict === "uncertain") {
        // Uncertain similarity is a coaching outcome, never an accusation — it
        // can only ever contribute to REVIEW, not FAIL.
        reviewReasons.push(`Face match: uncertain (distance ${compare.outcome.distance}${compare.gated ? ", mismatch suppressed by quality gates" : ""})`);
        corrective.push(
          "Face match: retake the selfie closer (face filling the frame), facing the camera straight-on in even light without glasses or a hat — and recapture the document page with the portrait sharp and free of glare, then run the comparison again."
        );
        corrective.push(...compare.reasons);
      }
    }
  }

  const verdict: OverallVerdict = failReasons.length > 0 ? "fail" : reviewReasons.length > 0 ? "review" : "pass";
  const reasons =
    verdict === "fail"
      ? [...failReasons, ...reviewReasons]
      : verdict === "review"
        ? reviewReasons
        : ["All document pages passed forensic screening", ...(template.faceMode !== "none" ? ["Face evidence is consistent"] : [])];
  return { verdict, reasons, correctiveActions: [...new Set(corrective)] };
}

export type CoverageStatus = "ran" | "not-run" | "unavailable";

export type CheckCoverage = {
  id: string;
  label: string;
  status: CoverageStatus;
  /** Short result line when the check ran. */
  result?: string;
  /** Why it has not run / cannot run, and how to run it. */
  note?: string;
};

/**
 * Honest per-check coverage matrix for the session: every check the flow
 * could involve is listed with its real status — ran (with result), not run
 * (with how to run it), or unavailable (with the technical reason). Rendered
 * on the summary screen and embedded in both exports so "n/a" is never
 * ambiguous.
 */
export function buildChecksCoverage(
  template: VerificationTemplate,
  pages: PageResult[],
  face: FaceStepResult | null,
  compare: FaceCompare | null,
  ai: SessionAiVerdicts | undefined,
  aiAvailable: boolean
): CheckCoverage[] {
  const out: CheckCoverage[] = [];
  const byId = new Map(pages.map((p) => [p.page.id, p] as const));
  for (const def of template.pages) {
    const p = byId.get(def.id);
    out.push(
      p
        ? {
            id: `${def.id}-forensics`,
            label: `${def.label} — forensic screening (metadata + pixels + channel)`,
            status: "ran",
            result: `${VERDICT_LABELS[p.report.verdict]} · score ${p.report.score}/100 · confidence ${p.report.confidence}%`,
          }
        : {
            id: `${def.id}-forensics`,
            label: `${def.label} — forensic screening (metadata + pixels + channel)`,
            status: "not-run",
            note: "Capture this page — the full forensic screening runs automatically on capture.",
          }
    );
    const isLicenceBack = template.doc === "licence" && def.id === "back";
    if (isLicenceBack) {
      out.push(
        p?.barcode
          ? {
              id: "barcode",
              label: "Licence barcode — PDF417 / AAMVA decode",
              status: "ran",
              result: `${p.barcode.outcome.toUpperCase()} — ${p.barcode.summary}`,
            }
          : {
              id: "barcode",
              label: "Licence barcode — PDF417 / AAMVA decode",
              status: "not-run",
              note: p ? 'Use "Run All Remaining Checks" — the barcode decodes locally on-device.' : "Capture the licence back first.",
            }
      );
    } else {
      out.push(
        p?.docData
          ? {
              id: `${def.id}-data`,
              label: `${def.label} — deep data check (MRZ + ICAO 9303)`,
              status: "ran",
              result: `${p.docData.outcome.toUpperCase()} — ${p.docData.summary}`,
            }
          : {
              id: `${def.id}-data`,
              label: `${def.label} — deep data check (MRZ + ICAO 9303)`,
              status: aiAvailable ? "not-run" : "unavailable",
              note: aiAvailable
                ? p
                  ? 'Use "Run All Remaining Checks" — the OCR read plus local checksum math takes a few seconds.'
                  : "Capture this page first."
                : "AI toolkit credentials are unavailable in this build, so the vision-model OCR read cannot run.",
            }
      );
    }
    if (def.portrait) {
      out.push(
        p
          ? {
              id: `${def.id}-portrait`,
              label: `${def.label} — portrait detection (on-device)`,
              status: "ran",
              result: p.portrait
                ? `Detected · ${p.portrait.quality.boxWidth}px wide${p.portrait.quality.ok ? "" : " · quality issues"}`
                : "No portrait found — retake the page for the face match",
            }
          : { id: `${def.id}-portrait`, label: `${def.label} — portrait detection (on-device)`, status: "not-run", note: "Capture this page first." }
      );
    }
    const pageAi = ai?.[def.id];
    out.push(
      pageAi
        ? { id: `${def.id}-ai`, label: `${def.label} — AI vision verdict`, status: "ran", result: `${pageAi.verdict} (${pageAi.confidence}% confidence)` }
        : {
            id: `${def.id}-ai`,
            label: `${def.label} — AI vision verdict`,
            status: aiAvailable ? "not-run" : "unavailable",
            note: aiAvailable
              ? p
                ? 'Use "Run All Remaining Checks" to get the vision-model second opinion.'
                : "Capture this page first."
              : "AI toolkit credentials are unavailable in this build.",
          }
    );
  }
  if (template.doc === "licence" && template.pages.some((p) => p.id === "front") && template.pages.some((p) => p.id === "back")) {
    const cross = licenceCrossFindings(pages);
    out.push(
      cross.length > 0
        ? { id: "licence-cross", label: "Licence cross-check — barcode vs front OCR", status: "ran", result: `${cross.length} field comparison(s) evaluated` }
        : {
            id: "licence-cross",
            label: "Licence cross-check — barcode vs front OCR",
            status: "not-run",
            note: "Runs automatically once both the barcode decode and the front deep data check have results.",
          }
    );
  }
  if (template.faceMode !== "none") {
    if (template.faceMode === "native-selfie") {
      out.push(
        face?.report
          ? {
              id: "selfie-forensics",
              label: "Selfie — EXIF + pixel forensics (incl. screen-replay screening)",
              status: "ran",
              result: `${VERDICT_LABELS[face.report.verdict]} · score ${face.report.score}/100 · confidence ${face.report.confidence}%`,
            }
          : {
              id: "selfie-forensics",
              label: "Selfie — EXIF + pixel forensics (incl. screen-replay screening)",
              status: "not-run",
              note: "Take the native selfie — the full forensic screening runs automatically.",
            }
      );
      const selfieAi = ai?.selfie;
      out.push(
        selfieAi
          ? { id: "selfie-ai", label: "Selfie — AI vision verdict", status: "ran", result: `${selfieAi.verdict} (${selfieAi.confidence}% confidence)` }
          : {
              id: "selfie-ai",
              label: "Selfie — AI vision verdict",
              status: aiAvailable ? "not-run" : "unavailable",
              note: aiAvailable ? (face?.blob ? 'Use "Run All Remaining Checks".' : "Take the selfie first.") : "AI toolkit credentials are unavailable in this build.",
            }
      );
    }
    out.push(
      compare
        ? {
            id: "face-match",
            label: "Face match — document portrait vs live face",
            status: "ran",
            result: `${compare.outcome.verdict.toUpperCase()} · similarity ${compare.outcome.similarity}% · fused distance ${compare.outcome.distance}`,
          }
        : {
            id: "face-match",
            label: "Face match — document portrait vs live face",
            status: "not-run",
            note: !pages.some((p) => p.page.portrait && p.portrait)
              ? "Needs a detected document portrait — retake the portrait page sharp and glare-free."
              : face?.face
                ? "The comparison runs automatically as soon as both faces are available."
                : "Needs a usable live face — complete the face step (or repeat it if no face was found).",
          }
    );
    const liveness = face?.liveness ?? null;
    out.push(
      liveness
        ? {
            id: "liveness",
            label: "Liveness — quick smile challenge + replay/virtual-camera checks",
            status: "ran",
            result: `${liveness.verdict.toUpperCase()} · ${liveness.findings.length} evidence findings`,
          }
        : template.faceMode === "liveness"
          ? {
              id: "liveness",
              label: "Liveness — quick smile challenge + replay/virtual-camera checks",
              status: "not-run",
              note: "Complete the live face step to run the full liveness session.",
            }
          : {
              id: "liveness",
              label: "Liveness — quick smile challenge + replay/virtual-camera checks",
              status: "not-run",
              note: "A native selfie is a still photo and cannot prove liveness by itself. Run the optional in-browser Liveness + Pulse add-on from the summary — its result feeds the final verdict.",
            }
    );
    out.push(
      liveness
        ? {
            id: "pulse",
            label: "Pulse (rPPG) — heartbeat from skin color",
            status: "ran",
            result: liveness.pulse
              ? `${liveness.pulse.bpm ?? "—"} BPM · quality ${liveness.pulse.quality} · ${liveness.pulse.seconds}s signal · coherence ${liveness.pulse.coherence}`
              : "No usable pulse signal captured — inconclusive",
          }
        : template.faceMode === "liveness"
          ? {
              id: "pulse",
              label: "Pulse (rPPG) — heartbeat from skin color",
              status: "not-run",
              note: "Measured across the liveness session (signal collected from start, topped up during the short hold).",
            }
          : {
              id: "pulse",
              label: "Pulse (rPPG) — heartbeat from skin color",
              status: "not-run",
              note: "Pulse needs live video — a still photo physically cannot carry it. Run the optional Liveness + Pulse add-on from the summary.",
            }
    );
  }
  return out;
}

const STATUS_TAG: Record<FindingStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", info: "INFO" };

function livenessText(l: LivenessResult): string {
  const lines: string[] = [`Verdict: ${l.verdict.toUpperCase()}`];
  if (l.pulse)
    lines.push(
      `Pulse: ${l.pulse.bpm ?? "—"} BPM (spectral ${l.pulse.bpmSpectral ?? "—"}) · coherence ${l.pulse.coherence} · SNR ${l.pulse.snr} · ${l.pulse.seconds}s signal · quality ${l.pulse.quality}`
    );
  for (const f of l.findings) {
    lines.push(`[${STATUS_TAG[f.status]}] ${f.label}`);
    if (f.observed) lines.push(`  observed: ${f.observed}`);
    if (f.expected) lines.push(`  expected: ${f.expected}`);
    lines.push(`  ${f.detail}`);
  }
  return lines.join("\n");
}

/** Full corrective session report as readable text — usable to harden detection settings. */
function findingText(f: Finding, indent: string): string[] {
  const lines: string[] = [`${indent}[${STATUS_TAG[f.status]}] ${f.label}`];
  if (f.observed) lines.push(`${indent}  observed: ${f.observed}`);
  if (f.expected) lines.push(`${indent}  expected: ${f.expected}`);
  lines.push(`${indent}  ${f.detail}`);
  return lines;
}

export function buildSessionReportText(
  template: VerificationTemplate,
  pages: PageResult[],
  face: FaceStepResult | null,
  compare: FaceCompare | null,
  overall: OverallResult,
  ai?: SessionAiVerdicts,
  aiAvailable: boolean = true
): string {
  const lines: string[] = [
    "=== VERIFICATION SESSION REPORT ===",
    `Template: ${template.name} (${template.id})`,
    `Document capture: ${template.docCapture === "webrtc" ? "live browser (WebRTC, max resolution/fps)" : "native camera app (original EXIF preserved)"}`,
    `Face step: ${template.faceMode}`,
    `Date: ${new Date().toISOString()}`,
    `Device: ${navigator.userAgent}`,
    "",
    `OVERALL: ${overall.verdict.toUpperCase()}`,
    ...overall.reasons.map((r) => `- ${r}`),
  ];
  if (overall.correctiveActions.length > 0) {
    lines.push("", "CORRECTIVE ACTIONS:");
    lines.push(...overall.correctiveActions.map((a) => `- ${a}`));
  }
  lines.push("", "CHECKS COVERAGE (what ran and what didn't):");
  for (const c of buildChecksCoverage(template, pages, face, compare, ai, aiAvailable)) {
    const tag = c.status === "ran" ? "RAN" : c.status === "not-run" ? "NOT RUN" : "UNAVAILABLE";
    lines.push(`- [${tag}] ${c.label}${c.result ? ` — ${c.result}` : ""}${c.note ? ` — ${c.note}` : ""}`);
  }
  for (const p of pages) {
    lines.push("", `━━━ DOCUMENT PAGE: ${p.page.label.toUpperCase()} ━━━`, `Capture: ${p.captureMeta}`);
    if (p.quickQuality) {
      lines.push(
        `Instant quality gate: ${p.quickQuality.ok ? "OK" : "RETAKE ADVISED"} — sharpness ${p.quickQuality.sharpness}, glare ${(p.quickQuality.glareFraction * 100).toFixed(1)}%, shadow ${(p.quickQuality.darkFraction * 100).toFixed(1)}%`
      );
      for (const i of p.quickQuality.issues) lines.push(`  - ${i}`);
    }
    if (p.page.portrait) {
      lines.push(
        p.portrait
          ? `Portrait: detected (${p.portrait.quality.boxWidth}px, detection ${p.portrait.quality.detectionScore}, quality ${p.portrait.quality.ok ? "OK" : p.portrait.quality.issues.join(" / ")})`
          : "Portrait: NOT detected"
      );
    }
    if (p.docData) {
      lines.push("", `DEEP DATA CHECK (MRZ + ICAO 9303): ${p.docData.outcome.toUpperCase()} — ${p.docData.summary}`);
      const conf = computeDocConfidence(p.docData);
      lines.push(`  Data confidence: ${conf.score == null ? conf.label : `${conf.score}%`} — ${conf.note}`);
      for (const part of conf.parts) {
        lines.push(`    ${part.ok ? "✓" : "✗"} ${part.label}: ${part.earned}/${part.max} pts — ${part.observed}`);
      }
      if (p.docData.mrz) {
        const m = p.docData.mrz;
        lines.push(
          `  MRZ: ${m.format} · ${m.documentCode}/${m.issuingState} · ${[m.surname, m.givenNames].filter(Boolean).join(", ")} · no. ${m.documentNumber} · born ${m.birthDateIso ?? "?"} · expires ${m.expiryDateIso ?? "?"}`
        );
        for (const d of m.checkDigits) lines.push(`  ${d.ok ? "✓" : "✗"} ${d.field} check digit: printed ${d.actual}, computed ${d.expected}`);
      }
      for (const f of p.docData.findings) lines.push(...findingText(f, "  "));
    }
    if (p.barcode) {
      lines.push("", `LICENCE BARCODE (PDF417/AAMVA): ${p.barcode.outcome.toUpperCase()} — ${p.barcode.summary}`);
      if (p.barcode.engine) lines.push(`  Decoder: ${p.barcode.engine}`);
      const bf = p.barcode.fields;
      if (bf) {
        lines.push(
          `  Fields: ${[bf.fullName, bf.documentNumber ? `no. ${bf.documentNumber}` : null, bf.birthDate ? `born ${bf.birthDate}` : null, bf.expiryDate ? `expires ${bf.expiryDate}` : null, bf.addressState ? `state ${bf.addressState}` : null].filter(Boolean).join(" · ") || "—"}`
        );
      }
      for (const f of p.barcode.findings) lines.push(...findingText(f, "  "));
    }
    lines.push("", formatReportText(p.report, ai?.[p.page.id] ?? null));
  }
  const crossFindings = licenceCrossFindings(pages);
  if (crossFindings.length > 0) {
    lines.push("", "━━━ LICENCE DATA CROSS-CHECK (barcode vs front OCR) ━━━");
    for (const f of crossFindings) lines.push(...findingText(f, ""));
  }
  if (face) {
    lines.push("", "━━━ LIVE FACE STEP ━━━", `Mode: ${face.mode}`);
    if (face.face) {
      lines.push(
        `Face: ${face.face.quality.boxWidth}px · detection ${face.face.quality.detectionScore} · brightness ${face.face.quality.brightness} · sharpness ${face.face.quality.sharpness}${face.face.quality.ok ? "" : ` · issues: ${face.face.quality.issues.join(" / ")}`}`
      );
    } else {
      lines.push("Face: none captured");
    }
    if (face.facesDetected != null && face.facesDetected > 1) {
      lines.push(`Multiple faces detected in the selfie frame: ${face.facesDetected}`);
    }
    if (face.liveness) lines.push("", livenessText(face.liveness));
    if (face.report) lines.push("", formatReportText(face.report, ai?.selfie ?? null));
  }
  if (compare) {
    const em = compare.outcome as MatchOutcome & Partial<EnsembleMatch>;
    lines.push(
      "",
      "━━━ FACE MATCH (document portrait vs live face) ━━━",
      `Verdict: ${compare.outcome.verdict.toUpperCase()}${compare.gated ? " (mismatch suppressed by quality gates)" : ""}`,
      `Fused cosine distance: ${compare.outcome.distance} (match ≤${MATCH_DISTANCE_MAX} · mismatch ≥${MISMATCH_DISTANCE_MIN})`,
      ...(em.medianDistance != null
        ? [`Ensemble: ${em.pairsCompared} variant pairs · best ${em.bestDistance} · median ${em.medianDistance} · mean ${em.meanDistance}`]
        : []),
      `Similarity: ${compare.outcome.similarity}%`,
      ...compare.reasons.map((r) => `- ${r}`)
    );
  }
  lines.push("", "=== END OF REPORT ===");
  return lines.join("\n");
}

/** Structured JSON export of the whole session (descriptors omitted). */
export function buildSessionJson(
  template: VerificationTemplate,
  pages: PageResult[],
  face: FaceStepResult | null,
  compare: FaceCompare | null,
  overall: OverallResult,
  ai?: SessionAiVerdicts,
  aiAvailable: boolean = true
): string {
  const serializeAi = (v: AiMediaVerdict | null | undefined) =>
    v ? { verdict: v.verdict, confidence: v.confidence, reasoning: v.reasoning, indicators: v.indicators, model: v.model } : null;
  const serializeFindings = (findings: Finding[]) =>
    findings.map((f) => ({ id: f.id, label: f.label, status: f.status, observed: f.observed ?? null, detail: f.detail }));
  const serializeReport = (r: MediaFraudReport) => ({
    fileName: r.fileName,
    kind: r.kind,
    size: r.size,
    verdict: r.verdict,
    verdictLabel: VERDICT_LABELS[r.verdict],
    score: r.score,
    confidence: r.confidence,
    docOutcome: r.docOutcome ?? null,
    categories: r.categories,
    retakeAdvice: r.retakeAdvice,
    findings: r.findings.map((f) => ({
      id: f.id,
      label: f.label,
      status: f.status,
      weight: f.weight,
      category: f.category ?? null,
      observed: f.observed ?? null,
      expected: f.expected ?? null,
      detail: f.detail,
    })),
    // Maximum-detail engine internals for detection-logic debugging: score
    // ledger, confidence math, verdict rule trace, and every raw signal value.
    telemetry: r.telemetry ?? null,
    // Visual heat maps are kept as captions/stats only (images stay in-app).
    visuals: (r.visuals ?? []).map((v) => ({ id: v.id, label: v.label, caption: v.caption })),
    ela: r.ela ? { meanDiff: r.ela.meanDiff, blockInconsistency: r.ela.blockInconsistency } : null,
  });
  return JSON.stringify(
    {
      template: { id: template.id, name: template.name, doc: template.doc, docCapture: template.docCapture, faceMode: template.faceMode },
      date: new Date().toISOString(),
      device: navigator.userAgent,
      overall,
      checksCoverage: buildChecksCoverage(template, pages, face, compare, ai, aiAvailable),
      pages: pages.map((p) => ({
        page: p.page.id,
        label: p.page.label,
        captureMeta: p.captureMeta,
        portraitDetected: p.portrait != null,
        portraitQuality: p.portrait?.quality ?? null,
        quickQuality: p.quickQuality ?? null,
        aiVerdict: serializeAi(ai?.[p.page.id]),
        barcode: p.barcode
          ? {
              outcome: p.barcode.outcome,
              summary: p.barcode.summary,
              engine: p.barcode.engine,
              fields: p.barcode.fields,
              findings: serializeFindings(p.barcode.findings),
            }
          : null,
        docData: p.docData
          ? {
              outcome: p.docData.outcome,
              summary: p.docData.summary,
              confidence: computeDocConfidence(p.docData),
              mrz: p.docData.mrz
                ? {
                    format: p.docData.mrz.format,
                    documentCode: p.docData.mrz.documentCode,
                    issuingState: p.docData.mrz.issuingState,
                    documentNumber: p.docData.mrz.documentNumber,
                    birthDate: p.docData.mrz.birthDateIso,
                    expiryDate: p.docData.mrz.expiryDateIso,
                    checkDigits: p.docData.mrz.checkDigits.map((d) => ({ field: d.field, printed: d.actual, computed: d.expected, ok: d.ok })),
                  }
                : null,
              findings: serializeFindings(p.docData.findings),
            }
          : null,
        report: serializeReport(p.report),
      })),
      licenceCrossCheck: (() => {
        const cross = licenceCrossFindings(pages);
        return cross.length > 0 ? serializeFindings(cross) : null;
      })(),
      face: face
        ? {
            mode: face.mode,
            faceQuality: face.face?.quality ?? null,
            facesDetected: face.facesDetected ?? null,
            aiVerdict: serializeAi(ai?.selfie),
            liveness: face.liveness
              ? {
                  verdict: face.liveness.verdict,
                  pulse: face.liveness.pulse
                    ? {
                        bpm: face.liveness.pulse.bpm,
                        bpmSpectral: face.liveness.pulse.bpmSpectral,
                        coherence: face.liveness.pulse.coherence,
                        snr: face.liveness.pulse.snr,
                        seconds: face.liveness.pulse.seconds,
                        quality: face.liveness.pulse.quality,
                      }
                    : null,
                  findings: serializeFindings(face.liveness.findings),
                }
              : null,
            report: face.report ? serializeReport(face.report) : null,
          }
        : null,
      faceMatch: compare
        ? (() => {
            const em = compare.outcome as MatchOutcome & Partial<EnsembleMatch>;
            return {
              verdict: compare.outcome.verdict,
              distance: compare.outcome.distance,
              similarity: compare.outcome.similarity,
              thresholds: { matchMax: MATCH_DISTANCE_MAX, mismatchMin: MISMATCH_DISTANCE_MIN },
              ensemble:
                em.medianDistance != null
                  ? { pairsCompared: em.pairsCompared, bestDistance: em.bestDistance, medianDistance: em.medianDistance, meanDistance: em.meanDistance }
                  : null,
              gated: compare.gated,
              reasons: compare.reasons,
            };
          })()
        : null,
    },
    null,
    2
  );
}
