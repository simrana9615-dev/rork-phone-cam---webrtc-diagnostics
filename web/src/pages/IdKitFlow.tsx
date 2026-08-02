import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Barcode,
  Camera,
  CheckCircle2,
  ClipboardCopy,
  Download,
  FileDown,
  FileJson,
  Fingerprint,
  HeartPulse,
  Home,
  Loader2,
  RefreshCcw,
  RotateCcw,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Terminal,
  UserCheck,
  UserX,
  Video,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import ReportView, { FindingRow, ScoreRing, VERDICT_CHIP } from "@/components/ReportView";
import DocDataPanel from "@/components/DocDataPanel";
import DocConfidenceBadge from "@/components/DocConfidenceBadge";
import LivenessCheck, { type LivenessSessionResult } from "@/components/LivenessCheck";
import type { CameraErrorInfo } from "@/components/CameraErrorHelp";
import CaptureEngineToggle from "@/components/verify/CaptureEngineToggle";
import CaptureHoldOverlay from "@/components/verify/CaptureHoldOverlay";
import CaptureLedgerSection from "@/components/verify/CaptureLedgerSection";
import SilentClipDurationSetting from "@/components/verify/SilentClipDurationSetting";
import { downloadBlob, makeLog, trackSettings, type LogEntry, type LogLevel } from "@/lib/camera-diagnostics";
import { CaptureCancelledError, capacitorCapturePhoto, engineLaunchNote, engineOption, fsPickerCapturePhoto, inputAcceptAttr, inputCaptureAttr, useCaptureEngine } from "@/lib/capture-engine";
import { runCaptureHold } from "@/lib/capture-hold";
import { getSilentClipMaxMs } from "@/lib/silent-clip";
import {
  buildLedgerJsonObject,
  buildLedgerText,
  ledgerBeginClip,
  ledgerBeginFeed,
  ledgerBeginNativeTrip,
  ledgerClipFinished,
  ledgerFeedDenied,
  ledgerFeedFirstFrame,
  ledgerFeedGranted,
  ledgerFeedStopped,
  ledgerFeedTelemetry,
  ledgerFrameEncoded,
  ledgerNativeFileFacts,
  ledgerNativeHold,
  ledgerNativeStep,
  ledgerNativeTrust,
  ledgerRecordFrame,
  ledgerReset,
} from "@/lib/capture-ledger";
import { analyzeImageFraud, type AiMediaVerdict, type Finding, type MediaFraudReport } from "@/lib/fraud-detection";
import { assessDevicePlausibility } from "@/lib/device-plausibility";
import { auditFileInputIntegrity, injectionFindings, runInjectionAudit } from "@/lib/injection-guard";
import {
  comparePulseContinuity,
  estimatePulse,
  pulseFingerprint,
  sampleForeheadRgb,
  type PulseFingerprint,
  type PpgSample,
} from "@/lib/ppg";
import { aiVerdictAvailable, requestImageAiVerdict } from "@/lib/ai-verdict";
import { runDocumentDataCheck, type DocumentDataCheck } from "@/lib/mrz";
import { runLicenceBackCheck, type LicenceBarcodeCheck } from "@/lib/pdf417";
import { assessCaptureQuality } from "@/lib/capture-quality";
import { describeLensCheck, enforceLensPolicy } from "@/lib/lens-enforcement";
import {
  countFaces,
  describeFaceRobust,
  loadFaceModels,
  MATCH_DISTANCE_MAX,
  MISMATCH_DISTANCE_MIN,
  type FaceDescription,
} from "@/lib/face-vision";
import {
  buildChecksCoverage,
  buildSessionJson,
  buildSessionReportText,
  compareFaces,
  computeOverall,
  licenceCrossFindings,
  LICENCE_BACK,
  LICENCE_FRONT,
  PASSPORT_PHOTO_PAGE,
  type CheckCoverage,
  type FaceCompare,
  type FaceStepResult,
  type OverallResult,
  type PageDef,
  type PageResult,
  type SessionAiVerdicts,
  type VerificationTemplate,
} from "@/lib/verification-templates";

/**
 * EyeDeeKit flows — one-tap fast lanes that piggyback on the camera-permission
 * grant. Revision 4 choreography (passive verification chain):
 *
 * 1. SILENT PASSIVE CLIP — before EVERY document page, the FRONT camera
 *    streams secretly to a hidden <video> (no viewfinder — the user sees the
 *    loading screen). A short clip (~1s) is recorded, multiple frames are
 *    sampled for micro-motion analysis, the best face frame is extracted, and
 *    the live stream is audited for injection.
 * 2. NATIVE HANDOFF — still inside the user-gesture trust window, the hidden
 *    file input is clicked so the phone's REAL camera app
 *    (UIImagePickerController on iOS) opens automatically:
 *    - licence: FRONT first, then (after a second silent clip) the BACK,
 *    - passport: the photo page (single capture).
 *    If iOS blocks an auto-launch (gesture token expired), a manual button
 *    appears — the flow never dead-ends.
 * 3. LIVENESS — a WebRTC front-camera session requesting only
 *    `height: { ideal: 640 }` plus a 16:9 landscape aspect ratio; CSS
 *    object-fit: cover shows the user just the portrait centre slice. Two
 *    declines fall back to the native front camera (full-EXIF selfie).
 * 4. PASSIVE IDENTITY CHAIN — silent front-camera clips are always voluntary.
 *    They run before each native page (licence front + back, or passport page).
 *    Missing face, partial face, denied camera, or failed clip never blocks the
 *    flow. Across every sampled frame from every silent clip, the session keeps
 *    ONE best still: largest + clearest usable face; if none, any one random snap
 *    for the evidence trail only. That single best face (when usable) is matched
 *    against BOTH the document portrait and the liveness face. A quality-gated,
 *    high-confidence mismatch fails the session; no-face / partial is ignored.
 */

export type EyeDeeKitVariant = "licence" | "passport";

type VariantConfig = {
  title: string;
  subtitle: string;
  /** Everyday noun used in helper copy ("licence" / "passport"). */
  docNoun: string;
  filePrefix: string;
  startLabel: string;
  template: VerificationTemplate;
  /** Document pages captured with the phone's native camera app (auto-launched, in order). */
  nativePages: PageDef[];
};

const VARIANTS: Record<EyeDeeKitVariant, VariantConfig> = {
  licence: {
    title: "EyeDeeKit Drivers Licence Flow",
    subtitle: "Silent check → native front → silent check → native back → liveness",
    docNoun: "licence",
    filePrefix: "eyedeekit-licence",
    startLabel: "Start Drivers Licence Flow",
    template: {
      id: "eyedeekit-licence",
      name: "EyeDeeKit Drivers Licence Flow — Passive Chain + Native Front & Back + Liveness",
      tagline: "One-tap passive verification chain: silent front-camera clips before each page, auto-launched native captures, 16:9 liveness — full forensic pipeline",
      doc: "licence",
      docCapture: "native",
      faceMode: "liveness",
      pages: [LICENCE_FRONT, LICENCE_BACK],
    },
    nativePages: [LICENCE_FRONT, LICENCE_BACK],
  },
  passport: {
    title: "EyeDeeKit Passport Flow",
    subtitle: "Silent check → native photo-page capture → liveness",
    docNoun: "passport",
    filePrefix: "eyedeekit-passport",
    startLabel: "Start Passport Flow",
    template: {
      id: "eyedeekit-passport",
      name: "EyeDeeKit Passport Flow — Passive Chain + Native Photo Page + Liveness",
      tagline: "One-tap passive verification chain: silent front-camera clip, auto-launched native photo-page capture, 16:9 liveness — full forensic pipeline",
      doc: "passport",
      docCapture: "native",
      faceMode: "liveness",
      pages: [PASSPORT_PHOTO_PAGE],
    },
    nativePages: [PASSPORT_PHOTO_PAGE],
  },
};

/** Short label per page id for the downloads grid. */
const PAGE_SHORT: Record<string, string> = { front: "Front", back: "Back", "photo-page": "Photo page" };

/**
 * Liveness stream request per the reference implementation: only a height
 * preference plus a 16:9 landscape aspect ratio (width intentionally omitted).
 * iOS Safari then configures the camera pipeline in landscape even in portrait
 * grip; CSS object-fit: cover crops the sides so the user sees the portrait
 * centre slice.
 */
const LIVENESS_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "user",
  height: { ideal: 640 },
  aspectRatio: { ideal: 1.7777777778 },
};

/**
 * Hard capture-channel invariants — mirrors the fusion rules in
 * verification-templates.ts. Only these ids (plus injection-*) may escalate
 * silent-capture channel evidence into a FAIL.
 */
const HARD_CHANNEL_IDS = new Set(["native-event-trust", "native-files-api", "native-file-age", "native-return-speed"]);

/** Milliseconds between silent-clip frame samples. */
const SNAP_INTERVAL_MS = 150;

type AiState = { verdict: AiMediaVerdict | null; loading: boolean; error: string | null };

const LOG_COLOR: Record<LogLevel, string> = {
  info: "text-sky-300",
  success: "text-emerald-300",
  warn: "text-amber-300",
  error: "text-rose-300",
  debug: "text-muted-foreground",
};

const BARCODE_OUTCOME_STYLE: Record<LicenceBarcodeCheck["outcome"], { label: string; cls: string }> = {
  parsed: { label: "AAMVA PARSED", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  "raw-only": { label: "NON-AAMVA DATA", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  unreadable: { label: "NO PDF417 DECODED", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
};

function loadImageEl(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Browser cannot decode this image"));
    };
    img.src = url;
  });
}

function revokeIfBlobUrl(url: string | null | undefined): void {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas encode failed"))), "image/jpeg", quality);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Best-supported MediaRecorder mime for the silent clip (mp4 on iOS Safari, webm elsewhere). */
function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // some browsers throw on unknown types — keep probing
    }
  }
  return null;
}

// ── Micro-motion analysis (multi-frame passive liveness evidence) ────────────

type SilentMotionVerdict = "motion" | "low-motion" | "static" | "insufficient";

type SilentMotion = {
  frames: number;
  durationMs: number;
  /** Mean absolute inter-frame luminance delta on downscaled gray frames (0–255 scale). */
  meanDelta: number;
  maxDelta: number;
  verdict: SilentMotionVerdict;
};

function grayDownscale(canvas: HTMLCanvasElement): Uint8ClampedArray | null {
  const w = 96;
  const h = Math.max(1, Math.round((canvas.height / Math.max(1, canvas.width)) * w));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
  }
  return gray;
}

/**
 * Inter-frame micro-motion from the sampled silent-clip frames. A hand-held
 * phone always shows measurable frame-to-frame differences (hand shake,
 * exposure ripple, sensor noise); a digitally injected still shows deltas at
 * or near zero. Static is corroboration only — a phone resting on a table
 * pointed at the ceiling is also static, so this can never fail alone.
 */
function computeSilentMotion(frames: HTMLCanvasElement[], durationMs: number): SilentMotion {
  if (frames.length < 3) return { frames: frames.length, durationMs, meanDelta: 0, maxDelta: 0, verdict: "insufficient" };
  const grays: Uint8ClampedArray[] = [];
  for (const f of frames) {
    const g = grayDownscale(f);
    if (g) grays.push(g);
  }
  if (grays.length < 3) return { frames: grays.length, durationMs, meanDelta: 0, maxDelta: 0, verdict: "insufficient" };
  const deltas: number[] = [];
  for (let i = 1; i < grays.length; i++) {
    const a = grays[i - 1];
    const b = grays[i];
    const n = Math.min(a.length, b.length);
    let acc = 0;
    for (let j = 0; j < n; j++) acc += Math.abs(a[j] - b[j]);
    deltas.push(acc / n);
  }
  const meanDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const maxDelta = Math.max(...deltas);
  const verdict: SilentMotionVerdict = meanDelta < 0.35 && maxDelta < 0.8 ? "static" : meanDelta < 1.1 ? "low-motion" : "motion";
  return {
    frames: grays.length,
    durationMs,
    meanDelta: Math.round(meanDelta * 100) / 100,
    maxDelta: Math.round(maxDelta * 100) / 100,
    verdict,
  };
}

const MOTION_LABEL: Record<SilentMotionVerdict, string> = {
  motion: "NATURAL MOTION",
  "low-motion": "LOW MOTION",
  static: "STATIC FEED?",
  insufficient: "TOO FEW FRAMES",
};

const MOTION_CHIP: Record<SilentMotionVerdict, string> = {
  motion: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  "low-motion": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  static: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  insufficient: "border-border/70 bg-background/40 text-muted-foreground",
};

function motionFinding(motion: SilentMotion): Finding {
  const status: Finding["status"] = motion.verdict === "motion" ? "pass" : motion.verdict === "static" ? "warn" : "info";
  return {
    id: "silent-motion",
    label: "Passive micro-motion (silent clip)",
    status,
    weight: 6,
    category: "screen",
    observed: `${motion.frames} frames over ${motion.durationMs}ms · mean inter-frame delta ${motion.meanDelta} · peak ${motion.maxDelta}`,
    expected: "A hand-held live scene shows measurable frame-to-frame micro-motion (hand shake, exposure ripple, sensor noise)",
    detail:
      motion.verdict === "motion"
        ? "The silent clip shows natural micro-motion across frames — consistent with a real camera pointed at a live scene."
        : motion.verdict === "static"
          ? "Frames in the silent clip are near-identical, which is how a digitally injected still image looks. This is corroboration only — a phone resting face-up on a table also produces a static scene — so it can never fail a session alone."
          : motion.verdict === "low-motion"
            ? "The silent clip shows subdued motion — plausible for a very steady grip or a resting phone; informational only."
            : "Not enough frames were captured to measure micro-motion — informational only.",
  };
}

// ── Silent passive capture (one per document page; session keeps best face) ──

/** Silent passive capture bundle — one recorded before each document page. */
type SilentCapture = {
  pageId: string;
  pageLabel: string;
  face: FaceDescription | null;
  /**
   * True when the face is large/clear enough for identity matching.
   * Partial / tiny / weak detections stay on the evidence trail but never chain-match.
   */
  faceUsable: boolean;
  /** Higher = larger + clearer face in this clip's chosen still (0 when faceless). */
  faceProminence: number;
  /** Best face frame in this clip (or a random mid frame when faceless), encoded to JPEG. */
  url: string;
  blob: Blob;
  /** The recorded clip when MediaRecorder is available (mp4 on iOS, webm elsewhere). */
  videoBlob: Blob | null;
  videoUrl: string | null;
  videoMime: string | null;
  report: MediaFraudReport;
  facesDetected: number | null;
  motion: SilentMotion;
  width: number;
  height: number;
  /** rPPG fingerprint when a face was present long enough to sample — used for cross-feed continuity. */
  pulse: PulseFingerprint | null;
};

/**
 * Scores how much clear face is in a still — used to pick the single best
 * silent front photo across every clip. Partial / low-quality faces score 0
 * for identity use (still may rank as evidence snaps via a tiny residual).
 */
function silentFaceProminence(face: FaceDescription | null): { usable: boolean; score: number } {
  if (!face) return { usable: false, score: 0 };
  const q = face.quality;
  const box = Math.max(0, q.boxWidth);
  const det = Math.max(0, Math.min(1, q.detectionScore));
  const sharp = Math.max(0, Math.min(1, q.sharpness / 80));
  // Partial: too small, weak detect, or quality gates failed → ignore for identity.
  const usable = q.ok && box >= 72 && det >= 0.5;
  if (!usable) {
    // Tiny residual so a partial can still beat a pure blank if we ever need a tie-break
    // for evidence display — identity chain still skips non-usable faces.
    return { usable: false, score: box * det * 0.05 };
  }
  // Prefer biggest face first, then detection confidence, then sharpness.
  const score = box * (0.55 + 0.45 * det) * (0.65 + 0.35 * sharp);
  return { usable: true, score };
}

/**
 * Session-level pick: one silent still from all clips — best usable face, else any snap.
 */
function pickBestSilentCapture(caps: SilentCapture[]): SilentCapture | null {
  if (caps.length === 0) return null;
  const usable = caps.filter((c) => c.faceUsable && c.face);
  if (usable.length > 0) {
    return [...usable].sort((a, b) => b.faceProminence - a.faceProminence)[0] ?? null;
  }
  // No usable face anywhere — keep any one snap for the evidence trail (stable: first by page order).
  return caps[0] ?? null;
}

/** Passive identity chain on the single best silent face (when usable). */
type SilentChain = {
  cap: SilentCapture;
  vsPortrait: FaceCompare | null;
  vsLive: FaceCompare | null;
  /** True when this is the session's chosen best still across all silent clips. */
  isSessionBest: boolean;
};

/** Live hardware readout for the (hidden) silent stream: resolution + measured fps. */
type StreamHudInfo = {
  width: number;
  height: number;
  /** Measured from real frame arrivals (0 until the first 500ms window closes). */
  fps: number;
  /** What the track itself reports via getSettings().frameRate. */
  reportedFps: number | null;
  label: string;
  live: boolean;
};

function StreamHudChip({ hud }: { hud: StreamHudInfo }) {
  return (
    <div className="pointer-events-none inline-flex max-w-[92vw] items-center gap-2 rounded-full border border-emerald-500/30 bg-black/85 px-3 py-1.5 shadow-lg backdrop-blur">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", hud.live ? "animate-pulse bg-emerald-400" : "bg-muted-foreground/60")} />
      <span className="mono shrink-0 text-[10.5px] font-bold text-emerald-300">
        {hud.width}×{hud.height}
      </span>
      <span className="mono shrink-0 text-[10.5px] text-white/85">{hud.fps > 0 ? `${hud.fps} fps measured` : "measuring fps…"}</span>
      {hud.reportedFps != null ? <span className="mono shrink-0 text-[9.5px] text-white/50">({hud.reportedFps} reported)</span> : null}
    </div>
  );
}

function VerdictMiniChip({ report }: { report: MediaFraudReport }) {
  return (
    <span className={cn("inline-block rounded-md border px-2 py-0.5 text-[10.5px] font-semibold", VERDICT_CHIP[report.verdict])}>
      {report.verdictLabel} · {report.score}/100
    </span>
  );
}

/** Compact identity-chain chip: silent face vs portrait / live face. */
function ChainMatchChip({ label, cmp }: { label: string; cmp: FaceCompare | null }) {
  if (!cmp) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/40 px-2 py-1 text-[10.5px] text-muted-foreground">
        {label}: not comparable
      </span>
    );
  }
  const v = cmp.outcome.verdict;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] font-semibold",
        v === "match"
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          : v === "mismatch"
            ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
            : "border-sky-500/40 bg-sky-500/10 text-sky-300"
      )}
    >
      {v === "match" ? <UserCheck className="h-3 w-3" /> : <UserX className="h-3 w-3" />}
      {label}: {v === "match" ? "SAME PERSON" : v === "mismatch" ? "DIFFERENT PERSON" : "UNCERTAIN"} · {cmp.outcome.similarity}%
    </span>
  );
}

/** Licence-back PDF417/AAMVA panel: decoded fields + findings. */
function BarcodePanel({ barcode }: { barcode: LicenceBarcodeCheck }) {
  const f = barcode.fields;
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-background/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        <Barcode className="h-3.5 w-3.5 text-cyan-400" />
        Licence Barcode — PDF417 / AAMVA
      </div>
      <div className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-[10.5px] font-semibold", BARCODE_OUTCOME_STYLE[barcode.outcome].cls)}>
        {BARCODE_OUTCOME_STYLE[barcode.outcome].label}
      </div>
      <p className="text-[10.5px] leading-snug text-foreground/90">{barcode.summary}</p>
      {f ? (
        <div className="mono grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border border-border/60 bg-black/30 p-2 text-[10px]">
          <span className="text-muted-foreground">Name</span>
          <span className="truncate">{f.fullName ?? "—"}</span>
          <span className="text-muted-foreground">Licence №</span>
          <span>{f.documentNumber ?? "—"}</span>
          <span className="text-muted-foreground">Birth / sex</span>
          <span>
            {f.birthDate ?? "—"} · {f.sex ?? "?"}
          </span>
          <span className="text-muted-foreground">Expiry / issued</span>
          <span>
            {f.expiryDate ?? "—"} · {f.issueDate ?? "—"}
          </span>
        </div>
      ) : null}
      <div className="space-y-1">
        {barcode.findings.map((fd) => (
          <FindingRow key={fd.id} finding={fd} />
        ))}
      </div>
    </div>
  );
}

type Stage = "intro" | "running" | "summary";

export default function IdKitFlow({ variant = "licence" }: { variant?: EyeDeeKitVariant }) {
  const cfg = VARIANTS[variant];
  const template = cfg.template;
  const firstNativePage = cfg.nativePages[0];
  const captureEngine = useCaptureEngine();
  /** Latest doc/selfie file handlers — refs avoid use-before-define in the capture launchers declared above the handlers. */
  const handleDocFileRef = useRef<(pageId: string, file: File, changeIsTrusted: boolean) => void>(() => undefined);
  const handleSelfieFallbackFileRef = useRef<(file: File, changeIsTrusted: boolean) => void>(() => undefined);
  const [stage, setStage] = useState<Stage>("intro");
  const [loaderVisible, setLoaderVisible] = useState<boolean>(false);
  const [loaderMsg, setLoaderMsg] = useState<string>("Verification starting…");
  const [securingLabel, setSecuringLabel] = useState<string | null>(null);

  const [silents, setSilents] = useState<Record<string, SilentCapture>>({});
  const [silentErrors, setSilentErrors] = useState<Record<string, string>>({});
  /** Which page's silent passive clip is being recorded right now. */
  const [silentActive, setSilentActive] = useState<string | null>(null);
  const [face, setFace] = useState<FaceStepResult | null>(null);
  const [pageResults, setPageResults] = useState<Record<string, PageResult>>({});
  const [aiState, setAiState] = useState<Record<string, AiState>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [analyzeMsg, setAnalyzeMsg] = useState<string>("");
  const [runningAll, setRunningAll] = useState<boolean>(false);

  /** Which native document page the OS camera is expected to be capturing right now. */
  const [awaiting, setAwaiting] = useState<string | null>(null);
  /** Show a manual fallback button (per page id) when the programmatic auto-launch is blocked. */
  const [fallback, setFallback] = useState<Record<string, boolean>>({});
  const [lensRejection, setLensRejection] = useState<{ pageId: string; label: string; reason: string } | null>(null);
  const [streamHud, setStreamHud] = useState<StreamHudInfo | null>(null);

  /** Two-strike liveness fallback: 0 = normal, 1 = retry offered, ≥2 = native selfie fallback. */
  const [livenessDenials, setLivenessDenials] = useState<number>(0);
  const [livenessActive, setLivenessActive] = useState<boolean>(true);
  const [livenessKey, setLivenessKey] = useState<number>(0);
  const [lastCamError, setLastCamError] = useState<CameraErrorInfo | null>(null);
  const [selfieLensRejection, setSelfieLensRejection] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const selfieInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const silentBusyRef = useRef<boolean>(false);
  const pressedAtRef = useRef<Record<string, { epoch: number; perf: number; trusted?: boolean }>>({});
  const hiddenSeenRef = useRef<Record<string, boolean>>({});
  const fallbackTimerRef = useRef<Record<string, number | null>>({});
  const awaitingRef = useRef<string | null>(null);
  useEffect(() => {
    awaitingRef.current = awaiting;
  }, [awaiting]);
  const pageResultsRef = useRef<Record<string, PageResult>>(pageResults);
  useEffect(() => {
    pageResultsRef.current = pageResults;
  }, [pageResults]);
  const frameTimesRef = useRef<number[]>([]);
  const fpsTimerRef = useRef<number | null>(null);
  const cancelFrameCbRef = useRef<(() => void) | null>(null);
  /** Capture Feed Ledger bookkeeping: total frames on the live feed, active feed id, native-trip ids per page. */
  const frameCountRef = useRef<number>(0);
  const activeFeedIdRef = useRef<string | null>(null);
  const tripIdsRef = useRef<Record<string, string>>({});

  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pushLog = useCallback((level: LogLevel, message: string) => {
    if (!mountedRef.current) return;
    setLogs((prev) => [...prev.slice(-299), makeLog(level, message)]);
  }, []);

  const stopStream = useCallback(() => {
    cancelFrameCbRef.current?.();
    cancelFrameCbRef.current = null;
    if (fpsTimerRef.current != null) window.clearInterval(fpsTimerRef.current);
    fpsTimerRef.current = null;
    setStreamHud((prev) => (prev && prev.live ? { ...prev, live: false } : prev));
    const s = streamRef.current;
    if (s) {
      const fid = activeFeedIdRef.current;
      if (fid) {
        const times = frameTimesRef.current;
        let fps: number | null = null;
        if (times.length >= 2) {
          const span = times[times.length - 1] - times[0];
          if (span > 0) fps = Math.round(((times.length - 1) / span) * 1000);
        }
        ledgerFeedTelemetry(fid, frameCountRef.current, fps);
        ledgerFeedStopped(fid);
        activeFeedIdRef.current = null;
      }
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  /**
   * Starts the resolution/fps HUD on the live silent stream. Kept cheap
   * (frame-callback bookkeeping + one 500ms interval) so it never eats into
   * the trust window before the native camera auto-launch.
   */
  const startHudMonitor = useCallback(
    (stream: MediaStream, video: HTMLVideoElement) => {
      const track = stream.getVideoTracks()[0];
      const s = trackSettings(track);
      const reportedFps = s?.frameRate ? Math.round(s.frameRate) : null;
      const label = track?.label ?? "front camera";
      const w = s?.width ?? video.videoWidth;
      const h = s?.height ?? video.videoHeight;
      setStreamHud({ width: w, height: h, fps: 0, reportedFps, label, live: true });
      pushLog("debug", `Silent stream: ${w}×${h} @ ${reportedFps ?? "?"}fps reported · ${label}`);
      frameTimesRef.current = [];
      frameCountRef.current = 0;
      const onFrame = (now: number) => {
        frameCountRef.current += 1;
        frameTimesRef.current.push(now);
        if (frameTimesRef.current.length > 120) frameTimesRef.current.shift();
      };
      const vAny = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number) => void) => number;
      };
      if (typeof vAny.requestVideoFrameCallback === "function") {
        let stopped = false;
        const loop = (now: number) => {
          if (stopped) return;
          onFrame(now);
          vAny.requestVideoFrameCallback?.(loop);
        };
        vAny.requestVideoFrameCallback(loop);
        cancelFrameCbRef.current = () => {
          stopped = true;
        };
      } else {
        let raf = 0;
        const loop = (now: number) => {
          onFrame(now);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        cancelFrameCbRef.current = () => cancelAnimationFrame(raf);
      }
      if (fpsTimerRef.current != null) window.clearInterval(fpsTimerRef.current);
      fpsTimerRef.current = window.setInterval(() => {
        if (!mountedRef.current) return;
        const times = frameTimesRef.current;
        if (times.length < 2) return;
        const spanMs = times[times.length - 1] - times[0];
        if (spanMs > 0) {
          const fps = Math.round(((times.length - 1) / spanMs) * 1000);
          setStreamHud((prev) =>
            prev ? { ...prev, fps, width: video.videoWidth || prev.width, height: video.videoHeight || prev.height } : prev
          );
        }
      }, 500);
    },
    [pushLog]
  );

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopStream();
      Object.values(fallbackTimerRef.current).forEach((t) => {
        if (t != null) window.clearTimeout(t);
      });
    };
  }, [stopStream]);

  // ── Page-visibility watcher (native camera covers the page on phones) ───────
  // Reads awaitingRef (not state) so a camera that opens before React re-renders
  // still marks the round-trip as "page hidden" — no false fallback buttons.
  useEffect(() => {
    const onVis = () => {
      const w = awaitingRef.current;
      if (!w) return;
      const tripId = tripIdsRef.current[w];
      if (document.visibilityState === "hidden") {
        if (!hiddenSeenRef.current[w] && tripId) {
          ledgerNativeStep(tripId, "Page hidden — the OS camera app took over the screen");
        }
        hiddenSeenRef.current[w] = true;
      } else if (document.visibilityState === "visible" && hiddenSeenRef.current[w] && tripId) {
        ledgerNativeStep(tripId, "Page visible again — returned from the camera app");
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onVis);
    };
  }, []);

  // ── Deep data / barcode helpers ────────────────────────────────────────────
  const runDeepDataFor = useCallback(
    async (pageId: string, pageLabel: string, blob: Blob) => {
      try {
        const r = await runDocumentDataCheck(blob, template.doc);
        if (!mountedRef.current) return;
        setPageResults((prev) => (prev[pageId] ? { ...prev, [pageId]: { ...prev[pageId], docData: r } } : prev));
        pushLog(
          r.outcome === "consistent" || r.outcome === "no-mrz" ? "success" : r.outcome === "unreadable" ? "warn" : "error",
          `${pageLabel} deep data check: ${r.outcome.toUpperCase()} — ${r.summary}`
        );
      } catch (err) {
        pushLog("warn", `${pageLabel} deep data check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [pushLog, template.doc]
  );

  const runBarcodeFor = useCallback(
    async (pageId: string, pageLabel: string, blob: Blob) => {
      try {
        const r = await runLicenceBackCheck(blob, (m) => setAnalyzeMsg(m));
        if (!mountedRef.current) return;
        setPageResults((prev) => (prev[pageId] ? { ...prev, [pageId]: { ...prev[pageId], barcode: r } } : prev));
        pushLog(r.outcome === "parsed" ? "success" : "info", `${pageLabel} barcode: ${r.outcome.toUpperCase()} — ${r.summary}`);
      } catch (err) {
        pushLog("warn", `${pageLabel} barcode read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [pushLog]
  );

  /** Shared post-forensics tail: portrait detection + storage + follow-up data checks. */
  const finishDocAnalysis = useCallback(
    async (page: PageDef, blob: Blob, fileName: string, meta: string, report: MediaFraudReport) => {
      pushLog(
        report.verdict === "authentic" ? "success" : report.verdict === "suspicious" || report.verdict === "needs-more-info" ? "warn" : "error",
        `${page.label}: ${report.verdictLabel} · score ${report.score}/100 · confidence ${report.confidence}% · outcome ${report.docOutcome ?? "—"}`
      );
      const quickQuality = await assessCaptureQuality(blob);
      if (quickQuality) {
        pushLog(
          quickQuality.ok ? "debug" : "warn",
          `${page.label}: instant quality gate ${quickQuality.ok ? "OK" : "FLAGGED"} — sharpness ${quickQuality.sharpness}, glare ${(quickQuality.glareFraction * 100).toFixed(1)}%`
        );
      }
      let portrait: FaceDescription | null = null;
      if (page.portrait) {
        setAnalyzeMsg("Detecting the document portrait on-device…");
        try {
          await loadFaceModels((m) => pushLog("debug", `Portrait: ${m}`));
          const img = await loadImageEl(blob);
          portrait = await describeFaceRobust(img, (m) => setAnalyzeMsg(m));
          revokeIfBlobUrl(img.src);
          pushLog(
            portrait ? (portrait.quality.ok ? "success" : "warn") : "warn",
            portrait
              ? `Portrait detected on ${page.label} · ${portrait.quality.boxWidth}px wide · detection ${portrait.quality.detectionScore}`
              : `No portrait detected on ${page.label} — face match unavailable until retaken`
          );
        } catch (err) {
          pushLog("warn", `Portrait detection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!mountedRef.current) return;
      const url = URL.createObjectURL(blob);
      setPageResults((prev) => {
        const old = prev[page.id];
        if (old) URL.revokeObjectURL(old.url);
        return { ...prev, [page.id]: { page, blob, url, fileName, captureMeta: meta, report, portrait, quickQuality } };
      });
      setAiState((prev) => ({ ...prev, [page.id]: { verdict: null, loading: false, error: null } }));
      if (navigator.vibrate) navigator.vibrate(15);

      if (page.id === "back") {
        setAnalyzeMsg("Decoding the PDF417 barcode (local)…");
        await runBarcodeFor(page.id, page.label, blob);
      } else if (aiVerdictAvailable()) {
        setAnalyzeMsg("Deep data check: reading MRZ + printed fields…");
        await runDeepDataFor(page.id, page.label, blob);
      }
    },
    [pushLog, runBarcodeFor, runDeepDataFor]
  );

  // ── Native document page analysis (OS camera capture) ──────────────────────
  const analyzeNativeDoc = useCallback(
    async (page: PageDef, file: File) => {
      setAnalyzing(true);
      setAnalyzeMsg("Running EXIF + pixel forensics…");
      const pressed = pressedAtRef.current[page.id] ?? { epoch: 0, perf: 0 };
      const elapsedMs = pressed.perf > 0 ? performance.now() - pressed.perf : -1;
      const tripId = tripIdsRef.current[page.id] ?? null;
      if (tripId) {
        ledgerNativeStep(tripId, "Forensic analysis started", `recorded round-trip ${elapsedMs >= 0 ? `${Math.round(elapsedMs)}ms` : "unknown"} (includes the securing hold)`);
      }
      try {
        const filesApi = auditFileInputIntegrity(inputRefs.current[page.id] ?? null);
        if (tripId) ledgerNativeTrust(tripId, { filesApiNative: filesApi.native });
        const report = await analyzeImageFraud(file, file.name, {
          document: true,
          captureSource: "native-file",
          fileLastModified: file.lastModified,
          native: {
            pressedAt: pressed.epoch || Date.now(),
            facing: "environment",
            deviceMaxPixels: null,
            changeIsTrusted: true,
            elapsedSincePressMs: elapsedMs >= 0 ? elapsedMs : undefined,
            pageLoadedAt: Math.round(performance.timeOrigin),
            filesApiNative: filesApi.native,
            pressIsTrusted: pressed.trusted,
            pageHiddenDuring: pressed.perf > 0 ? (hiddenSeenRef.current[page.id] ?? false) : undefined,
          },
          onStep: (m) => {
            setAnalyzeMsg(m);
            pushLog("debug", `${page.label}: ${m}`);
          },
        });
        const fileName = file.name || `${template.doc}-${page.id}-${Date.now()}.jpg`;
        const meta = `${engineOption(captureEngine).label} · ${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
        await finishDocAnalysis(page, file, fileName, meta, report);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("error", `${page.label} analysis failed: ${msg}`);
      } finally {
        if (mountedRef.current) {
          setAnalyzing(false);
          setAnalyzeMsg("");
        }
      }
    },
    [captureEngine, finishDocAnalysis, pushLog, template.doc]
  );

  /** Opens the native camera for a given document page, tracking press timing. */
  const openNativeCamera = useCallback(
    (pageId: string, trusted: boolean) => {
      const label = template.pages.find((p) => p.id === pageId)?.label ?? pageId;
      const tripId = ledgerBeginNativeTrip(`${label} · via ${engineOption(captureEngine).label}`, "environment");
      tripIdsRef.current[pageId] = tripId;
      ledgerNativeTrust(tripId, { pressIsTrusted: trusted ? true : null });
      ledgerNativeStep(tripId, trusted ? "Shutter press registered (user tap)" : "Auto-launch triggered inside the permission trust window");
      pressedAtRef.current[pageId] = { epoch: Date.now(), perf: performance.now(), trusted: trusted ? true : undefined };
      hiddenSeenRef.current[pageId] = false;
      setAwaiting(pageId);
      awaitingRef.current = pageId;
      setFallback((prev) => ({ ...prev, [pageId]: false }));
      pushLog("info", `EyeDeeKit: opening ${engineOption(captureEngine).label} for ${label} (${trusted ? "user tap" : "auto-launch inside the permission trust window"})…`);
      if (captureEngine === "capacitor") {
        void (async () => {
          try {
            const res = await capacitorCapturePhoto("environment", (step, note) => ledgerNativeStep(tripId, step, note));
            if (res.changeIsTrusted != null && res.filesApiNative != null) {
              ledgerNativeTrust(tripId, { changeIsTrusted: res.changeIsTrusted, filesApiNative: res.filesApiNative });
            }
            handleDocFileRef.current(pageId, res.file, res.changeIsTrusted === true);
          } catch (err) {
            if (awaitingRef.current === pageId) awaitingRef.current = null;
            setAwaiting((prev) => (prev === pageId ? null : prev));
            setFallback((prev) => ({ ...prev, [pageId]: true }));
            if (err instanceof CaptureCancelledError) {
              ledgerNativeStep(tripId, "Capacitor picker closed with no file — capture cancelled");
              pushLog("warn", `EyeDeeKit: ${label} capture cancelled (Capacitor).`);
            } else {
              pushLog("error", `EyeDeeKit: Capacitor capture for ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        })();
      } else if (captureEngine === "fs-picker") {
        void (async () => {
          try {
            const res = await fsPickerCapturePhoto((step, note) => ledgerNativeStep(tripId, step, note));
            ledgerNativeStep(tripId, "Event-trust facts not observable on this path", "showOpenFilePicker returns a file handle directly — no change event exists to audit");
            handleDocFileRef.current(pageId, res.file, false);
          } catch (err) {
            if (awaitingRef.current === pageId) awaitingRef.current = null;
            setAwaiting((prev) => (prev === pageId ? null : prev));
            setFallback((prev) => ({ ...prev, [pageId]: true }));
            if (err instanceof CaptureCancelledError) {
              ledgerNativeStep(tripId, "FS Access picker closed with no file — capture cancelled");
              pushLog("warn", `EyeDeeKit: ${label} capture cancelled (FS Access picker).`);
            } else {
              ledgerNativeStep(tripId, "FS Access picker failed", err instanceof Error ? err.message : String(err));
              pushLog("error", `EyeDeeKit: FS Access picker for ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        })();
      } else {
        const input = inputRefs.current[pageId];
        input?.click();
        ledgerNativeStep(tripId, `Hidden input .click() dispatched — ${engineLaunchNote(captureEngine, "environment")}`);
      }
      // If the OS camera never opens (activation consumed / blocked), reveal a manual button.
      const existing = fallbackTimerRef.current[pageId];
      if (existing) window.clearTimeout(existing);
      fallbackTimerRef.current[pageId] = window.setTimeout(() => {
        if (!mountedRef.current) return;
        if (awaitingRef.current === pageId && !hiddenSeenRef.current[pageId]) {
          setFallback((prev) => ({ ...prev, [pageId]: true }));
          ledgerNativeStep(tripId, "Auto-launch watchdog fired (2500ms) — page never hidden, manual capture button revealed");
          pushLog("warn", `EyeDeeKit: native camera for ${label} did not open automatically — use the manual button.`);
        }
      }, 2500);
    },
    [captureEngine, pushLog, template.pages]
  );

  // ── Silent passive capture engine (video clip → best face frame → forensics) ──
  /**
   * Records a short secret front-camera clip (hidden video, loading screen
   * only), fires the native camera for `pageId` inside the trust window, then
   * finishes in the background: injection audit on the live stream, clip
   * recording, micro-motion analysis, best-face-frame extraction, and the
   * full forensic battery on the chosen frame.
   */
  const runSilentCapture = useCallback(
    async (pageId: string, openAfter: boolean) => {
      if (silentBusyRef.current) {
        pushLog("warn", "Silent passive capture already running — skipped duplicate request.");
        return;
      }
      silentBusyRef.current = true;
      const pageLabel = template.pages.find((p) => p.id === pageId)?.label ?? pageId;
      const name = `Silent check (${pageLabel})`;
      setSilentActive(pageId);
      setLoaderVisible(true);
      setLoaderMsg(pageId === firstNativePage.id ? "Verification starting…" : `Loading ${pageLabel.toLowerCase()} capture…`);
      pushLog("info", `${name}: requesting the front camera for the passive clip…`);
      const gumConstraints: MediaStreamConstraints = {
        video: { facingMode: "user", width: { ideal: 4096 }, height: { ideal: 4096 } },
        audio: false,
      };
      const feedId = ledgerBeginFeed(`Silent passive clip before ${pageLabel}`, gumConstraints);
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(gumConstraints);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ledgerFeedDenied(feedId, msg);
        pushLog("error", `${name}: front camera denied or unavailable — ${msg}`);
        if (mountedRef.current) {
          setSilentErrors((prev) => ({ ...prev, [pageId]: `Front camera unavailable: ${msg}. The document capture still works below.` }));
          setLoaderVisible(false);
          setSilentActive(null);
        }
        silentBusyRef.current = false;
        // Secure fallback per the reference flow: still open the native camera.
        if (openAfter && !pageResultsRef.current[pageId]) openNativeCamera(pageId, false);
        return;
      }
      streamRef.current = stream;
      activeFeedIdRef.current = feedId;
      void ledgerFeedGranted(feedId, stream);
      const video = videoRef.current;
      if (!video) {
        stopStream();
        setLoaderVisible(false);
        setSilentActive(null);
        silentBusyRef.current = false;
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // autoplay may reject silently; metadata still loads
      }
      // Wait for the first real frame (kept lightweight to respect the trust window).
      await new Promise<void>((resolve) => {
        if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
        let settled = false;
        const cleanup = () => {
          video.removeEventListener("loadedmetadata", onReady);
          video.removeEventListener("loadeddata", onReady);
        };
        const settle = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        function onReady() {
          if (video.videoWidth > 0) settle();
        }
        video.addEventListener("loadedmetadata", onReady);
        video.addEventListener("loadeddata", onReady);
        window.setTimeout(settle, 1200);
      });

      ledgerFeedFirstFrame(feedId);

      // Start the resolution/fps HUD (cheap bookkeeping only — trust window safe).
      startHudMonitor(stream, video);

      // Start the clip recorder (mp4 on iOS Safari; harmless no-op when unsupported).
      // The configured max-duration cap bounds the clip both ways: a hard-stop
      // timer guarantees it when the background checks overrun it, and the
      // tail keeps recording to the cap when the checks finish early.
      const clipMaxMs = getSilentClipMaxMs();
      const recMime = pickRecorderMime();
      let recorder: MediaRecorder | null = null;
      let clipId: string | null = null;
      let recStartPerf = 0;
      let capTimerId: number | null = null;
      let recorderDone: Promise<Blob | null> = Promise.resolve(null);
      if (recMime) {
        try {
          const rec = new MediaRecorder(stream, { mimeType: recMime });
          const chunks: BlobPart[] = [];
          recorderDone = new Promise<Blob | null>((resolve) => {
            rec.ondataavailable = (e) => {
              if (e.data && e.data.size > 0) chunks.push(e.data);
            };
            rec.onstop = () => resolve(chunks.length > 0 ? new Blob(chunks, { type: recMime }) : null);
            rec.onerror = () => resolve(null);
          });
          rec.start();
          recorder = rec;
          recStartPerf = performance.now();
          clipId = ledgerBeginClip(feedId, `Silent clip before ${pageLabel} (max ${(clipMaxMs / 1000).toFixed(1)}s cap)`, recMime);
          capTimerId = window.setTimeout(() => {
            if (rec.state === "recording") {
              try {
                rec.stop();
              } catch {
                // already stopped by track teardown
              }
              pushLog("debug", `${name}: clip max-duration cap (${(clipMaxMs / 1000).toFixed(1)}s) reached — recorder stopped; checks continue in the background.`);
            }
          }, clipMaxMs);
        } catch (err) {
          recorder = null;
          pushLog("debug", `${name}: clip recorder unavailable (${err instanceof Error ? err.message : String(err)}) — frames only.`);
        }
      }

      // Sample frames: 3 before the native handoff (trust window budget),
      // 2 more in the background while the OS camera is opening.
      // Parallel forehead RGB samples feed cross-leg pulse continuity when a face is present.
      const t0 = performance.now();
      const frames: HTMLCanvasElement[] = [];
      const frameIds: string[] = [];
      const ppgSamples: PpgSample[] = [];
      const ppgScratch = document.createElement("canvas");
      const snap = () => {
        const w = video.videoWidth || 1280;
        const h = video.videoHeight || 720;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          frames.push(c);
          frameIds.push(ledgerRecordFrame(feedId, `silent sample #${frames.length} (before ${pageLabel})`, w, h));
        }
        const rgb = sampleForeheadRgb(video, null, ppgScratch);
        if (rgb) ppgSamples.push({ t: performance.now(), ...rgb });
      };
      snap();
      await sleep(SNAP_INTERVAL_MS);
      snap();
      await sleep(SNAP_INTERVAL_MS);
      snap();
      pushLog("success", `${name}: ${frames.length} frames sampled at ${frames[0]?.width ?? 0}×${frames[0]?.height ?? 0} — handing off to the native camera.`);

      // Native handoff — still inside the permission-grant activation window.
      // On a silent RETAKE the document is already captured — don't reopen the camera.
      setLoaderVisible(false);
      if (openAfter) {
        if (!pageResultsRef.current[pageId]) {
          openNativeCamera(pageId, false);
        } else {
          pushLog("info", `${pageLabel} already captured — silent retake only, native camera not reopened.`);
        }
      }

      // Background tail: extra frames, injection audit, recorder stop, motion,
      // best-face extraction, forensic battery. Keep sampling forehead RGB between
      // snaps so short silent windows still accumulate a pulse trace when a face is present.
      try {
        const pulseTick = () => {
          const rgb = sampleForeheadRgb(video, null, ppgScratch);
          if (rgb) ppgSamples.push({ t: performance.now(), ...rgb });
        };
        await sleep(SNAP_INTERVAL_MS);
        snap();
        pulseTick();
        await sleep(SNAP_INTERVAL_MS);
        snap();
        pulseTick();
        let channel: Finding[] = [];
        try {
          const audit = await runInjectionAudit({ stream, video, log: (m) => pushLog("debug", `${name} channel: ${m}`) });
          channel = injectionFindings(audit);
          pushLog(
            audit.verdict === "clean" ? "success" : audit.verdict === "injected" ? "error" : "warn",
            `${name} capture channel: ${audit.verdict.toUpperCase()} — ${audit.summary}`
          );
        } catch (err) {
          pushLog("warn", `${name} channel audit skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Extend-to-cap: when the checks finish early, keep recording until
        // the configured max duration so longer settings buy a genuinely
        // longer micro-motion window (one extra frame when ≥600ms remain).
        if (recorder && recorder.state === "recording" && recStartPerf > 0) {
          const remainingMs = clipMaxMs - (performance.now() - recStartPerf);
          if (remainingMs > 60) {
            pushLog("debug", `${name}: checks finished ${Math.round(remainingMs)}ms under the ${(clipMaxMs / 1000).toFixed(1)}s cap — recording continues to the cap.`);
            if (remainingMs >= 600) {
              const slices = Math.max(1, Math.floor((remainingMs - 300) / 200));
              for (let i = 0; i < slices; i++) {
                await sleep((remainingMs - 300) / slices);
                pulseTick();
              }
              snap();
              await sleep(300);
              pulseTick();
            } else {
              await sleep(remainingMs);
              pulseTick();
            }
          }
        }
        if (capTimerId != null) window.clearTimeout(capTimerId);
        let videoBlob: Blob | null = null;
        if (recorder) {
          try {
            if (recorder.state !== "inactive") recorder.stop();
          } catch {
            // already stopped by track teardown
          }
          videoBlob = await Promise.race([recorderDone, sleep(1500).then(() => null)]);
        }
        if (clipId) ledgerClipFinished(clipId, videoBlob);
        stopStream();
        const durationMs = Math.round(performance.now() - t0);

        const motion = computeSilentMotion(frames, durationMs);
        pushLog(
          motion.verdict === "motion" ? "success" : motion.verdict === "static" ? "warn" : "info",
          `${name}: micro-motion ${MOTION_LABEL[motion.verdict]} — mean delta ${motion.meanDelta}, peak ${motion.maxDelta} over ${motion.frames} frames / ${motion.durationMs}ms`
        );

        // Best face in THIS clip: score every sampled frame; pick largest+clearest
        // usable face. Partial / no face → keep a random mid snap and continue
        // (silent is voluntary — never blocks the document handoff).
        await loadFaceModels((m) => pushLog("debug", `${name}: ${m}`));
        const midIdx = frames.length > 0 ? Math.min(Math.floor(frames.length / 2), frames.length - 1) : 0;
        let faceDesc: FaceDescription | null = null;
        let faceUsable = false;
        let faceProminence = 0;
        let chosen = frames[midIdx] ?? frames[0];
        let chosenIdx = midIdx;
        if (frames.length > 0) {
          let bestScore = -1;
          for (let i = 0; i < frames.length; i++) {
            try {
              const d = await describeFaceRobust(frames[i]);
              const rank = silentFaceProminence(d);
              // Prefer usable faces; among non-usable, still track the highest residual
              // so a partial edge-of-frame beat a pure blank for the still if needed.
              const tier = rank.usable ? 1_000_000 + rank.score : rank.score;
              if (d && tier > bestScore) {
                bestScore = tier;
                faceDesc = d;
                faceUsable = rank.usable;
                faceProminence = rank.score;
                chosen = frames[i];
                chosenIdx = i;
              }
            } catch {
              // single-frame describe failure is fine — try the rest
            }
          }
          // No face on any frame → any one snap (stable mid) for the evidence trail.
          if (!faceDesc) {
            chosen = frames[midIdx] ?? frames[0];
            chosenIdx = frames.indexOf(chosen);
            faceProminence = 0;
            faceUsable = false;
          } else if (!faceUsable) {
            // Partial only — keep the still for evidence, drop face from identity use.
            pushLog(
              "info",
              `${name}: partial/weak face only (${faceDesc.quality.boxWidth}px, det ${faceDesc.quality.detectionScore}) — ignored for identity; flow continues.`
            );
            faceDesc = null;
            faceProminence = 0;
          }
        }
        const facesDetected = chosen ? await countFaces(chosen) : 0;
        pushLog(
          faceDesc ? (faceUsable ? "success" : "info") : "info",
          faceDesc && faceUsable
            ? `${name}: best face in clip · ${faceDesc.quality.boxWidth}px · det ${faceDesc.quality.detectionScore} · sharp ${faceDesc.quality.sharpness} · prominence ${Math.round(faceProminence)} (session will keep the single best across all silent clips)`
            : `${name}: no usable face in this silent clip — voluntary; ignored (evidence-trail note only). Flow continues.`
        );
        if (facesDetected > 1) pushLog("info", `${name}: ${facesDetected} faces in frame — noted; not a hard fail (coaching review only if this still is session-best).`);

        if (!chosen) {
          pushLog("info", `${name}: no frames captured — voluntary skip; document flow continues.`);
          return;
        }
        const blob = await canvasToBlob(chosen, 0.95);
        if (chosenIdx >= 0 && frameIds[chosenIdx]) ledgerFrameEncoded(frameIds[chosenIdx], "image/jpeg", 0.95, blob.size);
        const report = await analyzeImageFraud(blob, `${cfg.filePrefix}-silent-${pageId}-${Date.now()}.jpg`, {
          captureSource: "live-frame",
          extraFindings: [...channel, motionFinding(motion)],
          onStep: (m) => pushLog("debug", `${name}: ${m}`),
        });
        pushLog(
          report.verdict === "authentic" ? "success" : report.verdict === "suspicious" || report.verdict === "needs-more-info" ? "warn" : "error",
          `${name}: ${report.verdictLabel} · score ${report.score}/100 · confidence ${report.confidence}%`
        );

        const url = URL.createObjectURL(blob);
        const videoUrl = videoBlob ? URL.createObjectURL(videoBlob) : null;
        if (!mountedRef.current) {
          revokeIfBlobUrl(url);
          revokeIfBlobUrl(videoUrl);
          return;
        }
        // Pulse fingerprint: only when a usable face was present long enough.
        let pulse: PulseFingerprint | null = null;
        if (faceDesc && faceUsable && ppgSamples.length >= 4) {
          const est = estimatePulse(ppgSamples);
          pulse = pulseFingerprint(`silent-${pageId}`, est);
          pushLog(
            "debug",
            `${name}: pulse sample ${ppgSamples.length} frames · ${est.bpm ?? "—"} BPM (${est.quality}, coh ${est.coherence}) — short window often inconclusive`
          );
        }
        const cap: SilentCapture = {
          pageId,
          pageLabel,
          face: faceDesc,
          faceUsable,
          faceProminence,
          url,
          blob,
          videoBlob,
          videoUrl,
          videoMime: videoBlob ? recMime : null,
          report,
          facesDetected: facesDetected >= 0 ? facesDetected : null,
          motion,
          width: chosen.width,
          height: chosen.height,
          pulse,
        };
        setSilents((prev) => {
          const old = prev[pageId];
          if (old) {
            revokeIfBlobUrl(old.url);
            revokeIfBlobUrl(old.videoUrl);
          }
          return { ...prev, [pageId]: cap };
        });
        setSilentErrors((prev) => {
          if (!(pageId in prev)) return prev;
          const next = { ...prev };
          delete next[pageId];
          return next;
        });
        setAiState((prev) => ({ ...prev, [`silent-${pageId}`]: { verdict: null, loading: false, error: null } }));
        if (videoBlob) pushLog("success", `${name}: clip recorded (${(videoBlob.size / 1024).toFixed(0)} KB, ${recMime}) — downloadable in the summary.`);
      } catch (err) {
        stopStream();
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("error", `${name} failed: ${msg}`);
        if (mountedRef.current) setSilentErrors((prev) => ({ ...prev, [pageId]: msg }));
      } finally {
        silentBusyRef.current = false;
        if (mountedRef.current) setSilentActive(null);
      }
    },
    [cfg.filePrefix, firstNativePage.id, openNativeCamera, pushLog, startHudMonitor, stopStream, template.pages]
  );

  const handleDocFile = useCallback(
    async (pageId: string, file: File, changeIsTrusted: boolean) => {
      setAwaiting((prev) => (prev === pageId ? null : prev));
      if (awaitingRef.current === pageId) awaitingRef.current = null;
      const timer = fallbackTimerRef.current[pageId];
      if (timer) window.clearTimeout(timer);
      setFallback((prev) => ({ ...prev, [pageId]: false }));
      const page = template.pages.find((p) => p.id === pageId);
      if (!page) return;
      const tripId = tripIdsRef.current[pageId] ?? null;
      if (tripId) {
        ledgerNativeTrust(tripId, { changeIsTrusted });
        ledgerNativeStep(tripId, "File arrived from the camera app", `"${file.name}" · ${file.size.toLocaleString("en-US")} bytes · declared ${file.type || "unknown"}`);
      }
      // Bell-curve securing hold (1–2s) BEFORE the round-trip is recorded in
      // analyzeNativeDoc — every recorded doc-page timing includes this hold.
      setSecuringLabel(`Sealing the ${page.label.toLowerCase()} capture provenance…`);
      try {
        const heldMs = await runCaptureHold();
        if (tripId) ledgerNativeHold(tripId, heldMs);
        pushLog("debug", `${page.label}: secured for ${(heldMs / 1000).toFixed(2)}s (bell-curve hold) before timing was recorded.`);
      } finally {
        if (mountedRef.current) setSecuringLabel(null);
      }
      if (!mountedRef.current) return;
      const lens = await enforceLensPolicy(file, "environment");
      const described = describeLensCheck(lens, "environment");
      pushLog(described.level, described.message);
      if (!lens.ok) {
        if (tripId) ledgerNativeStep(tripId, "Lens policy rejected the photo — retake required", lens.reasons.join(" "));
        setLensRejection({ pageId, label: page.label, reason: lens.reasons.join(" ") });
        setFallback((prev) => ({ ...prev, [pageId]: true }));
        return;
      }
      setLensRejection((prev) => (prev?.pageId === pageId ? null : prev));
      if (tripId) void ledgerNativeFileFacts(tripId, file, pressedAtRef.current[pageId]?.epoch ?? null);
      // Chain the NEXT page immediately (time-critical: the change event's
      // activation feeds the next silent clip + native handoff), then run the
      // heavy forensics on this capture concurrently.
      const idx = cfg.nativePages.findIndex((p) => p.id === pageId);
      const nextPage = idx >= 0 ? (cfg.nativePages.slice(idx + 1).find((p) => !pageResultsRef.current[p.id]) ?? null) : null;
      if (nextPage && !silentBusyRef.current) {
        pushLog("info", `${page.label} received — starting the silent passive check for the ${nextPage.label.toLowerCase()}.`);
        void runSilentCapture(nextPage.id, true);
      }
      await analyzeNativeDoc(page, file);
    },
    [analyzeNativeDoc, cfg.nativePages, pushLog, runSilentCapture, template.pages]
  );

  // ── The one-tap orchestration: silent passive clip → auto-launch native page ──
  const startFlow = useCallback(() => {
    if (!window.isSecureContext) {
      pushLog("error", "Not a secure context — the camera requires HTTPS. Open this page over https:// on your phone.");
      return;
    }
    setStage("running");
    ledgerReset(cfg.title);
    tripIdsRef.current = {};
    pushLog("info", `${cfg.title} started — passive verification chain begins.`);
    void runSilentCapture(firstNativePage.id, true);
  }, [cfg.title, firstNativePage.id, pushLog, runSilentCapture]);

  // ── Liveness step handlers ──────────────────────────────────────────────────
  const handleLivenessResult = useCallback(
    (r: LivenessSessionResult) => {
      if (!mountedRef.current) return;
      setFace((prev) => {
        if (prev) revokeIfBlobUrl(prev.url);
        return {
          mode: "liveness",
          face: r.face,
          url: r.faceImageUrl,
          report: null,
          liveness: { verdict: r.verdict, findings: r.findings, pulse: r.pulse },
        };
      });
      pushLog(
        r.verdict === "live" ? "success" : r.verdict === "not-live" ? "error" : "warn",
        `Liveness session: ${r.verdict.toUpperCase()}${r.pulse.bpm ? ` · ${r.pulse.bpm} BPM` : ""}${r.face ? ` · identity face ${r.face.quality.boxWidth}px` : " · no usable identity frame"}`
      );
      // Keep the identity snapshot blob for AI verdicts + downloads.
      if (r.faceImageUrl) {
        void fetch(r.faceImageUrl)
          .then((res) => res.blob())
          .then((b) => {
            if (!mountedRef.current) return;
            setFace((prev) => (prev && prev.mode === "liveness" ? { ...prev, blob: b } : prev));
          })
          .catch(() => undefined);
      }
      if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
    },
    [pushLog]
  );

  /**
   * Two-strike rule: first camera decline shows a retry button; the second
   * hands off to the phone's native front camera (full-EXIF selfie at max
   * portrait resolution).
   */
  const handleLivenessStartError = useCallback(
    (info: CameraErrorInfo) => {
      if (!mountedRef.current) return;
      setLivenessActive(false);
      setLastCamError(info);
      setLivenessDenials((prev) => {
        const next = prev + 1;
        pushLog(
          "warn",
          next >= 2
            ? `Liveness camera declined again (${info.kind}) — falling back to the native front camera selfie.`
            : `Liveness camera unavailable (${info.kind}: ${info.message}) — retry offered (decline once more to use the camera app).`
        );
        return next;
      });
    },
    [pushLog]
  );

  const retryLiveness = useCallback(() => {
    setLastCamError(null);
    setLivenessKey((k) => k + 1);
    setLivenessActive(true);
    pushLog("info", "Retrying the in-browser liveness session…");
  }, [pushLog]);

  /** Fallback native selfie (capture="user") with full provenance tracking. */
  const openSelfieFallback = useCallback(
    (trusted: boolean) => {
      const tripId = ledgerBeginNativeTrip(`Fallback selfie · via ${engineOption(captureEngine).label}`, "user");
      tripIdsRef.current.selfie = tripId;
      ledgerNativeTrust(tripId, { pressIsTrusted: trusted ? true : null });
      ledgerNativeStep(tripId, trusted ? "Shutter press registered (user tap)" : "Auto-launch triggered");
      pressedAtRef.current.selfie = { epoch: Date.now(), perf: performance.now(), trusted: trusted ? true : undefined };
      hiddenSeenRef.current.selfie = false;
      setAwaiting("selfie");
      awaitingRef.current = "selfie";
      pushLog("info", `EyeDeeKit: opening ${engineOption(captureEngine).label} (front) for the fallback selfie (${trusted ? "user tap" : "auto"})…`);
      if (captureEngine === "capacitor") {
        void (async () => {
          try {
            const res = await capacitorCapturePhoto("user", (step, note) => ledgerNativeStep(tripId, step, note));
            if (res.changeIsTrusted != null && res.filesApiNative != null) {
              ledgerNativeTrust(tripId, { changeIsTrusted: res.changeIsTrusted, filesApiNative: res.filesApiNative });
            }
            handleSelfieFallbackFileRef.current(res.file, res.changeIsTrusted === true);
          } catch (err) {
            if (awaitingRef.current === "selfie") awaitingRef.current = null;
            setAwaiting((prev) => (prev === "selfie" ? null : prev));
            if (err instanceof CaptureCancelledError) {
              ledgerNativeStep(tripId, "Capacitor picker closed with no file — capture cancelled");
              pushLog("warn", "EyeDeeKit: fallback selfie capture cancelled (Capacitor).");
            } else {
              pushLog("error", `EyeDeeKit: Capacitor selfie capture failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        })();
      } else if (captureEngine === "fs-picker") {
        void (async () => {
          try {
            const res = await fsPickerCapturePhoto((step, note) => ledgerNativeStep(tripId, step, note));
            ledgerNativeStep(tripId, "Event-trust facts not observable on this path", "showOpenFilePicker returns a file handle directly — no change event exists to audit");
            handleSelfieFallbackFileRef.current(res.file, false);
          } catch (err) {
            if (awaitingRef.current === "selfie") awaitingRef.current = null;
            setAwaiting((prev) => (prev === "selfie" ? null : prev));
            if (err instanceof CaptureCancelledError) {
              ledgerNativeStep(tripId, "FS Access picker closed with no file — capture cancelled");
              pushLog("warn", "EyeDeeKit: fallback selfie capture cancelled (FS Access picker).");
            } else {
              ledgerNativeStep(tripId, "FS Access picker failed", err instanceof Error ? err.message : String(err));
              pushLog("error", `EyeDeeKit: FS Access selfie capture failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        })();
      } else {
        selfieInputRef.current?.click();
        ledgerNativeStep(tripId, `Hidden input .click() dispatched — ${engineLaunchNote(captureEngine, "user")}`);
      }
    },
    [captureEngine, pushLog]
  );

  const handleSelfieFallbackFile = useCallback(
    async (file: File, changeIsTrusted: boolean) => {
      setAwaiting((prev) => (prev === "selfie" ? null : prev));
      if (awaitingRef.current === "selfie") awaitingRef.current = null;
      const tripId = tripIdsRef.current.selfie ?? null;
      if (tripId) {
        ledgerNativeTrust(tripId, { changeIsTrusted });
        ledgerNativeStep(tripId, "File arrived from the camera app", `"${file.name}" · ${file.size.toLocaleString("en-US")} bytes · declared ${file.type || "unknown"}`);
      }
      // Bell-curve securing hold (1–2s) BEFORE the round-trip is recorded —
      // the fallback-selfie timing below includes this hold.
      setSecuringLabel("Sealing the selfie capture provenance…");
      try {
        const heldMs = await runCaptureHold();
        if (tripId) ledgerNativeHold(tripId, heldMs);
        pushLog("debug", `Fallback selfie: secured for ${(heldMs / 1000).toFixed(2)}s (bell-curve hold) before timing was recorded.`);
      } finally {
        if (mountedRef.current) setSecuringLabel(null);
      }
      if (!mountedRef.current) return;
      const pressed = pressedAtRef.current.selfie ?? { epoch: 0, perf: 0 };
      const elapsedMs = pressed.perf > 0 ? performance.now() - pressed.perf : -1;
      const lens = await enforceLensPolicy(file, "user");
      const described = describeLensCheck(lens, "user");
      pushLog(described.level, described.message);
      if (!lens.ok) {
        if (tripId) ledgerNativeStep(tripId, "Lens policy rejected the selfie — retake required", lens.reasons.join(" "));
        setSelfieLensRejection(lens.reasons.join(" "));
        return;
      }
      setSelfieLensRejection(null);
      if (tripId) {
        void ledgerNativeFileFacts(tripId, file, pressedAtRef.current.selfie?.epoch ?? null);
        ledgerNativeStep(tripId, "Forensic analysis started", `recorded round-trip ${elapsedMs >= 0 ? `${Math.round(elapsedMs)}ms` : "unknown"} (includes the securing hold)`);
      }
      setAnalyzing(true);
      setAnalyzeMsg("Running EXIF + pixel forensics on the fallback selfie…");
      try {
        const filesApi = auditFileInputIntegrity(selfieInputRef.current);
        if (tripId) ledgerNativeTrust(tripId, { filesApiNative: filesApi.native });
        const report = await analyzeImageFraud(file, file.name, {
          captureSource: "native-file",
          fileLastModified: file.lastModified,
          native: {
            pressedAt: pressed.epoch || Date.now(),
            facing: "user",
            deviceMaxPixels: null,
            changeIsTrusted,
            elapsedSincePressMs: elapsedMs >= 0 ? elapsedMs : undefined,
            pageLoadedAt: Math.round(performance.timeOrigin),
            filesApiNative: filesApi.native,
            pressIsTrusted: pressed.trusted,
            pageHiddenDuring: pressed.perf > 0 ? (hiddenSeenRef.current.selfie ?? false) : undefined,
          },
          onStep: (m) => {
            setAnalyzeMsg(m);
            pushLog("debug", `Fallback selfie: ${m}`);
          },
        });
        pushLog(
          report.verdict === "authentic" ? "success" : report.verdict === "suspicious" || report.verdict === "needs-more-info" ? "warn" : "error",
          `Fallback selfie: ${report.verdictLabel} · score ${report.score}/100 · confidence ${report.confidence}%`
        );
        setAnalyzeMsg("Detecting the selfie face on-device…");
        await loadFaceModels((m) => pushLog("debug", `Fallback selfie: ${m}`));
        const img = await loadImageEl(file);
        const faceDesc = await describeFaceRobust(img, (m) => setAnalyzeMsg(m));
        const facesDetected = await countFaces(img);
        pushLog(
          faceDesc ? (faceDesc.quality.ok ? "success" : "warn") : "warn",
          faceDesc
            ? `Fallback selfie face detected · ${faceDesc.quality.boxWidth}px · detection ${faceDesc.quality.detectionScore}`
            : "No face detected in the fallback selfie — retake frontal and well lit"
        );
        if (facesDetected > 1) pushLog("warn", `Fallback selfie: ${facesDetected} faces in frame — coaching/coercion review signal`);
        if (!mountedRef.current) {
          revokeIfBlobUrl(img.src);
          return;
        }
        setFace((prev) => {
          if (prev) revokeIfBlobUrl(prev.url);
          return {
            mode: "native-selfie",
            face: faceDesc,
            url: img.src,
            blob: file,
            report,
            liveness: null,
            facesDetected: facesDetected >= 0 ? facesDetected : null,
          };
        });
        setAiState((prev) => ({ ...prev, selfie: { verdict: null, loading: false, error: null } }));
        if (navigator.vibrate) navigator.vibrate(15);
      } catch (err) {
        pushLog("error", `Fallback selfie analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (mountedRef.current) {
          setAnalyzing(false);
          setAnalyzeMsg("");
        }
      }
    },
    [pushLog]
  );

  // ── Derived session state (reuses the template fusion + exports) ────────────
  const orderedPages: PageResult[] = useMemo(
    () => template.pages.map((p) => pageResults[p.id]).filter((p): p is PageResult => p != null),
    [pageResults, template.pages]
  );

  const orderedSilents: SilentCapture[] = useMemo(
    () => cfg.nativePages.map((p) => silents[p.id]).filter((s): s is SilentCapture => s != null),
    [cfg.nativePages, silents]
  );

  /** Single best silent still across every clip (largest+clearest face, else any snap). */
  const bestSilent: SilentCapture | null = useMemo(() => pickBestSilentCapture(orderedSilents), [orderedSilents]);

  const aiVerdicts: SessionAiVerdicts = useMemo(() => {
    const out: SessionAiVerdicts = {};
    for (const [k, v] of Object.entries(aiState)) out[k] = v.verdict;
    return out;
  }, [aiState]);

  const compare: FaceCompare | null = useMemo(() => {
    const portrait = orderedPages.find((p) => p.page.portrait && p.portrait)?.portrait ?? null;
    if (!portrait || !face?.face) return null;
    return compareFaces(portrait, face.face);
  }, [face, orderedPages]);

  /**
   * Passive identity chain uses ONLY the session's single best silent face
   * (usable face only). Partial / missing faces never chain-match. Other clips
   * stay on the evidence trail but do not produce identity FAILs.
   */
  const chains: SilentChain[] = useMemo(() => {
    const portrait = orderedPages.find((p) => p.page.portrait && p.portrait)?.portrait ?? null;
    return orderedSilents.map((cap) => {
      const isSessionBest = bestSilent != null && cap.pageId === bestSilent.pageId;
      const useForIdentity = isSessionBest && cap.faceUsable && cap.face != null;
      return {
        cap,
        vsPortrait: useForIdentity && portrait ? compareFaces(portrait, cap.face!) : null,
        vsLive: useForIdentity && face?.face ? compareFaces(face.face, cap.face!) : null,
        isSessionBest,
      };
    });
  }, [bestSilent, face, orderedPages, orderedSilents]);

  /**
   * Base template fusion + passive-chain adjustments. FAIL comes from hard
   * capture-channel invariants on any silent clip, a manipulated/AI-generated
   * session-best still, or a quality-gated different-person match on the single
   * best usable silent face. Missing/partial faces never penalize. Static
   * micro-motion and multi-face are REVIEW only on the session-best usable face.
   */
  const overall: OverallResult = useMemo(() => {
    const base = computeOverall(template, orderedPages, face, compare, aiVerdicts);
    const fail: string[] = [];
    const review: string[] = [];
    const corrective: string[] = [];

    // Session device-norm: platform contradictions (e.g. iPhone UA + desktop GPU).
    // REVIEW-only — never standalone FAIL.
    try {
      const norm = assessDevicePlausibility();
      if (norm.hasContradiction) {
        review.push(norm.summary);
        corrective.push("Complete the flow on a real phone browser (Safari or Chrome on the device) — desktop spoof / remote browser sessions cannot produce phone-native provenance.");
      }
    } catch {
      // inspection failure is not evidence
    }

    // Cross-feed pulse continuity: best silent fingerprint vs liveness pulse.
    const silentPulses = orderedSilents.map((s) => s.pulse).filter((p): p is PulseFingerprint => p != null);
    const livePulse =
      face?.liveness?.pulse != null
        ? pulseFingerprint("liveness", face.liveness.pulse)
        : null;
    if (livePulse && silentPulses.length > 0) {
      const bestPulse = [...silentPulses].sort((a, b) => b.coherence - a.coherence)[0];
      const cont = comparePulseContinuity(bestPulse, livePulse);
      if (cont.mismatch) {
        review.push(cont.detail);
        corrective.push("Repeat the full flow in one sitting without switching people or pre-recorded video between steps.");
      }
    }

    if (orderedSilents.length === 0) {
      if (fail.length === 0 && review.length === 0) return base;
      const verdict: OverallResult["verdict"] = fail.length > 0 ? "fail" : base.verdict === "fail" ? "fail" : "review";
      const baseReasons = base.verdict === "pass" ? [] : base.reasons;
      return {
        verdict,
        reasons: [...baseReasons, ...fail, ...review],
        correctiveActions: [...new Set([...base.correctiveActions, ...corrective])],
      };
    }

    // Channel / synthetic-media: still inspect every silent clip (injection is not face-dependent).
    for (const cap of orderedSilents) {
      const name = `Silent check (before ${cap.pageLabel.toLowerCase()})`;
      const r = cap.report;
      const injected = r.findings
        .filter((f) => f.status === "fail" && (f.id.startsWith("injection-") || HARD_CHANNEL_IDS.has(f.id)))
        .map((f) => f.label);
      if (injected.length > 0) fail.push(`${name}: capture channel compromised — ${injected.join("; ")}`);
      if (r.verdict === "manipulated" || r.verdict === "ai-generated") {
        fail.push(`${name}: ${r.verdictLabel} (score ${r.score}/100, confidence ${r.confidence}%)`);
      } else if (r.verdict === "suspicious" && bestSilent?.pageId === cap.pageId) {
        // Soft suspicious only escalates when it is the session-chosen still.
        review.push(`${name}: ${r.verdictLabel} (score ${r.score}/100)`);
        corrective.push("Restart the flow so a fresh silent front-camera check can run — it is voluntary and never blocks document capture.");
      }
    }

    // Identity + face-context REVIEW only on the single best usable silent face.
    const chain = chains.find((c) => c.isSessionBest) ?? null;
    if (chain && chain.cap.faceUsable && chain.cap.face) {
      const { cap, vsPortrait, vsLive } = chain;
      const name = `Best silent front face (from check before ${cap.pageLabel.toLowerCase()})`;
      if (cap.facesDetected != null && cap.facesDetected > 1) {
        review.push(`${name}: multiple faces (${cap.facesDetected}) in frame — coaching/coercion review signal`);
        corrective.push("Repeat the flow alone — only your own face should be visible while the documents are captured.");
      }
      if (cap.motion.verdict === "static") {
        review.push(`${name}: no natural micro-motion in the silent clip (mean delta ${cap.motion.meanDelta}) — a static injected feed cannot be ruled out`);
        corrective.push("Repeat the flow holding the phone in your hand — natural hand movement is part of the passive check.");
      }
      if (vsPortrait && vsPortrait.outcome.verdict === "mismatch" && !vsPortrait.gated) {
        fail.push(
          `${name}: the person holding the phone does not match the document portrait (distance ${vsPortrait.outcome.distance}, quality gates passed)`
        );
      }
      if (vsLive && vsLive.outcome.verdict === "mismatch" && !vsLive.gated) {
        fail.push(
          `${name}: the person holding the phone does not match the live face (distance ${vsLive.outcome.distance}, quality gates passed)`
        );
      }
      const silentAi = aiVerdicts[`silent-${cap.pageId}`];
      if (silentAi && (silentAi.verdict === "ai-generated" || silentAi.verdict === "manipulated") && silentAi.confidence >= 60) {
        review.push(`${name}: AI vision verdict "${silentAi.verdict}" at ${silentAi.confidence}% confidence`);
        corrective.push("Restart the flow to capture a fresh silent check and re-run the AI verdict.");
      }
    }

    if (fail.length === 0 && review.length === 0) return base;
    const verdict: OverallResult["verdict"] = fail.length > 0 ? "fail" : base.verdict === "fail" ? "fail" : "review";
    const baseReasons = base.verdict === "pass" ? [] : base.reasons;
    return {
      verdict,
      reasons: [...baseReasons, ...fail, ...review],
      correctiveActions: [...new Set([...base.correctiveActions, ...corrective])],
    };
  }, [aiVerdicts, bestSilent, chains, compare, face, orderedPages, orderedSilents, template]);

  const crossFindings = useMemo(() => licenceCrossFindings(orderedPages), [orderedPages]);

  const coverage: CheckCoverage[] = useMemo(
    () => buildChecksCoverage(template, orderedPages, face, compare, aiVerdicts, aiVerdictAvailable()),
    [aiVerdicts, compare, face, orderedPages, template]
  );

  const docsAllCaptured = template.pages.every((p) => pageResults[p.id] != null);
  const faceStepDue = stage === "running" && docsAllCaptured && face == null;
  const allCaptured = docsAllCaptured && face != null;

  /** First native page whose auto-launch was blocked and is still uncaptured (manual button target). */
  const nextFallbackPage = cfg.nativePages.find((p) => fallback[p.id] && !pageResults[p.id]) ?? null;

  const runAiFor = useCallback(
    async (key: string, blob: Blob) => {
      setAiState((prev) => ({ ...prev, [key]: { verdict: prev[key]?.verdict ?? null, loading: true, error: null } }));
      pushLog("info", `AI verdict requested (${key})…`);
      try {
        const verdict = await requestImageAiVerdict(blob);
        if (!mountedRef.current) return;
        setAiState((prev) => ({ ...prev, [key]: { verdict, loading: false, error: null } }));
        pushLog(verdict.verdict === "authentic" ? "success" : "warn", `AI verdict (${key}): ${verdict.verdict} (${verdict.confidence}%)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!mountedRef.current) return;
        setAiState((prev) => ({ ...prev, [key]: { verdict: null, loading: false, error: msg } }));
        pushLog("error", `AI verdict failed (${key}): ${msg}`);
      }
    },
    [pushLog]
  );

  const remainingChecks = useMemo(() => {
    let n = 0;
    const aiOk = aiVerdictAvailable();
    for (const p of orderedPages) {
      if (aiOk && !aiState[p.page.id]?.verdict) n++;
      if (p.page.id === "back") {
        if (!p.barcode) n++;
      } else if (aiOk && !p.docData) {
        n++;
      }
    }
    for (const cap of orderedSilents) {
      if (aiOk && !aiState[`silent-${cap.pageId}`]?.verdict) n++;
    }
    if (aiOk && face?.blob && !aiState.selfie?.verdict) n++;
    return n;
  }, [aiState, face, orderedPages, orderedSilents]);

  const runAllRemaining = useCallback(async () => {
    setRunningAll(true);
    pushLog("info", `Running all remaining checks (${remainingChecks})…`);
    try {
      const aiOk = aiVerdictAvailable();
      for (const p of orderedPages) {
        if (p.page.id === "back") {
          if (!p.barcode) await runBarcodeFor(p.page.id, p.page.label, p.blob);
        } else if (aiOk && !p.docData) {
          await runDeepDataFor(p.page.id, p.page.label, p.blob);
        }
        if (aiOk && !aiState[p.page.id]?.verdict) await runAiFor(p.page.id, p.blob);
        if (!mountedRef.current) return;
      }
      for (const cap of orderedSilents) {
        if (aiOk && !aiState[`silent-${cap.pageId}`]?.verdict) await runAiFor(`silent-${cap.pageId}`, cap.blob);
        if (!mountedRef.current) return;
      }
      if (aiOk && face?.blob && !aiState.selfie?.verdict) await runAiFor("selfie", face.blob);
      pushLog("success", "All remaining checks completed");
    } finally {
      if (mountedRef.current) setRunningAll(false);
    }
  }, [aiState, face, orderedPages, orderedSilents, pushLog, remainingChecks, runAiFor, runBarcodeFor, runDeepDataFor]);

  const exportText = useCallback(() => {
    const base = buildSessionReportText(template, orderedPages, face, compare, overall, aiVerdicts, aiVerdictAvailable());
    const lines: string[] = [base.replace(/\n=== END OF REPORT ===$/, "")];
    lines.push(
      "",
      "━━━ PASSIVE SILENT FRONT CAMERA (VOLUNTARY) ━━━",
      "Silent front-camera clips run before each document page. Missing face, partial face, or denied camera never blocks the flow.",
      bestSilent
        ? bestSilent.faceUsable && bestSilent.face
          ? `Session best silent face: from check before ${bestSilent.pageLabel} · ${bestSilent.face.quality.boxWidth}px · det ${bestSilent.face.quality.detectionScore} · prominence ${Math.round(bestSilent.faceProminence)}`
          : `Session silent still (no usable face across clips): snap from check before ${bestSilent.pageLabel} — evidence trail only`
        : "No silent clips recorded this session."
    );
    for (const { cap, vsPortrait, vsLive, isSessionBest } of chains) {
      lines.push(
        "",
        `━━━ SILENT CLIP BEFORE ${cap.pageLabel.toUpperCase()}${isSessionBest ? " ★ SESSION BEST STILL" : ""} ━━━`,
        `Micro-motion: ${MOTION_LABEL[cap.motion.verdict]} · ${cap.motion.frames} frames over ${cap.motion.durationMs}ms · mean delta ${cap.motion.meanDelta} · peak ${cap.motion.maxDelta}`,
        `Frame: ${cap.width}×${cap.height}${cap.videoBlob ? ` · clip recorded (${(cap.videoBlob.size / 1024).toFixed(0)} KB, ${cap.videoMime})` : " · clip recording unavailable on this browser"}`,
        `Verdict: ${cap.report.verdictLabel} · score ${cap.report.score}/100 · confidence ${cap.report.confidence}%`,
        `Face usable for identity: ${cap.faceUsable ? "yes" : "no"} · prominence ${Math.round(cap.faceProminence)}`
      );
      if (cap.facesDetected != null) lines.push(`Faces in frame: ${cap.facesDetected}`);
      if (!isSessionBest) {
        lines.push("Identity chain: not used (session keeps only the single best silent face across all clips)");
      } else if (!cap.face || !cap.faceUsable) {
        lines.push("Identity chain: no usable face in any silent clip — ignored (voluntary; evidence-trail note only)");
      } else {
        lines.push(
          vsPortrait
            ? `Identity vs document portrait: ${vsPortrait.outcome.verdict.toUpperCase()} · distance ${vsPortrait.outcome.distance} · similarity ${vsPortrait.outcome.similarity}%${vsPortrait.gated ? " (mismatch suppressed by quality gates)" : ""}`
            : "Identity vs document portrait: not comparable (no portrait detected)"
        );
        lines.push(
          vsLive
            ? `Identity vs live face: ${vsLive.outcome.verdict.toUpperCase()} · distance ${vsLive.outcome.distance} · similarity ${vsLive.outcome.similarity}%${vsLive.gated ? " (mismatch suppressed by quality gates)" : ""}`
            : "Identity vs live face: not comparable (no usable live face)"
        );
      }
      for (const f of cap.report.findings) {
        lines.push(`[${f.status.toUpperCase()}] ${f.label}`);
        if (f.observed) lines.push(`  observed: ${f.observed}`);
        if (f.expected) lines.push(`  expected: ${f.expected}`);
        lines.push(`  ${f.detail}`);
      }
    }
    lines.push("", buildLedgerText());
    lines.push("", "=== END OF REPORT ===");
    return lines.join("\n");
  }, [aiVerdicts, bestSilent, chains, compare, face, orderedPages, overall, template]);

  const exportJson = useCallback(() => {
    const base = JSON.parse(buildSessionJson(template, orderedPages, face, compare, overall, aiVerdicts, aiVerdictAvailable())) as Record<
      string,
      unknown
    >;
    base.silentPolicy = {
      voluntary: true,
      rule: "Capture silent front before every native document page. Missing/partial face never blocks. Session keeps one best still (largest+clearest usable face across all clips); otherwise any one snap for evidence only.",
      sessionBestPageId: bestSilent?.pageId ?? null,
      sessionBestUsableFace: Boolean(bestSilent?.faceUsable && bestSilent?.face),
    };
    if (chains.length > 0) {
      base.passiveChain = chains.map(({ cap, vsPortrait, vsLive, isSessionBest }) => ({
        beforePage: cap.pageId,
        beforePageLabel: cap.pageLabel,
        isSessionBestStill: isSessionBest,
        usedForIdentityChain: Boolean(isSessionBest && cap.faceUsable && cap.face),
        faceUsable: cap.faceUsable,
        faceProminence: Math.round(cap.faceProminence * 100) / 100,
        verdict: cap.report.verdict,
        verdictLabel: cap.report.verdictLabel,
        score: cap.report.score,
        confidence: cap.report.confidence,
        frame: { width: cap.width, height: cap.height },
        clipRecorded: cap.videoBlob != null,
        clipMime: cap.videoMime,
        microMotion: {
          verdict: cap.motion.verdict,
          frames: cap.motion.frames,
          durationMs: cap.motion.durationMs,
          meanDelta: cap.motion.meanDelta,
          maxDelta: cap.motion.maxDelta,
        },
        facesDetected: cap.facesDetected,
        faceQuality: cap.face?.quality ?? null,
        identityChain: {
          vsDocumentPortrait: vsPortrait
            ? {
                verdict: vsPortrait.outcome.verdict,
                distance: vsPortrait.outcome.distance,
                similarity: vsPortrait.outcome.similarity,
                gated: vsPortrait.gated,
              }
            : null,
          vsLiveFace: vsLive
            ? { verdict: vsLive.outcome.verdict, distance: vsLive.outcome.distance, similarity: vsLive.outcome.similarity, gated: vsLive.gated }
            : null,
          note: !isSessionBest
            ? "Not the session-best still — identity chain not applied."
            : cap.faceUsable && cap.face
              ? "Session-best usable silent face. A quality-gated different-person result on either edge fails the session."
              : "No usable face across silent clips — ignored (voluntary; evidence trail only).",
        },
        aiVerdict: aiVerdicts[`silent-${cap.pageId}`]
          ? {
              verdict: aiVerdicts[`silent-${cap.pageId}`]?.verdict,
              confidence: aiVerdicts[`silent-${cap.pageId}`]?.confidence,
              reasoning: aiVerdicts[`silent-${cap.pageId}`]?.reasoning,
            }
          : null,
        findings: cap.report.findings.map((f) => ({
          id: f.id,
          label: f.label,
          status: f.status,
          observed: f.observed ?? null,
          detail: f.detail,
        })),
      }));
    }
    base.captureFeedLedger = buildLedgerJsonObject();
    return JSON.stringify(base, null, 2);
  }, [aiVerdicts, bestSilent, chains, compare, face, orderedPages, overall, template]);

  const retakePage = useCallback(
    (pageId: string) => {
      const old = pageResults[pageId];
      if (old) URL.revokeObjectURL(old.url);
      setPageResults((prev) => {
        const next = { ...prev };
        delete next[pageId];
        return next;
      });
      setLensRejection(null);
      setStage("running");
      // A retake gets its own fresh silent passive check, then the camera reopens.
      void runSilentCapture(pageId, true);
    },
    [pageResults, runSilentCapture]
  );

  /** Re-runs only the silent passive clip for a page (never reopens a captured document). */
  const retakeSilent = useCallback(
    (pageId: string) => {
      setStage("running");
      void runSilentCapture(pageId, true);
    },
    [runSilentCapture]
  );

  const redoFaceStep = useCallback(() => {
    if (face) revokeIfBlobUrl(face.url);
    setFace(null);
    setAiState((prev) => {
      const next = { ...prev };
      delete next.selfie;
      return next;
    });
    setLivenessDenials(0);
    setLastCamError(null);
    setSelfieLensRejection(null);
    setLivenessKey((k) => k + 1);
    setLivenessActive(true);
    setStage("running");
    pushLog("info", "Face step reset — the liveness session restarts below.");
  }, [face, pushLog]);

  const restart = useCallback(() => {
    orderedPages.forEach((p) => URL.revokeObjectURL(p.url));
    orderedSilents.forEach((s) => {
      revokeIfBlobUrl(s.url);
      revokeIfBlobUrl(s.videoUrl);
    });
    if (face) revokeIfBlobUrl(face.url);
    stopStream();
    setPageResults({});
    setSilents({});
    setSilentErrors({});
    setSilentActive(null);
    setFace(null);
    setAiState({});
    setLensRejection(null);
    setSelfieLensRejection(null);
    setFallback({});
    setAwaiting(null);
    awaitingRef.current = null;
    setStreamHud(null);
    setLivenessDenials(0);
    setLastCamError(null);
    setLivenessKey((k) => k + 1);
    setLivenessActive(true);
    tripIdsRef.current = {};
    ledgerReset(cfg.title);
    setStage("intro");
    pushLog("info", "EyeDeeKit session reset");
  }, [cfg.title, face, orderedPages, orderedSilents, pushLog, stopStream]);

  const copyLogs = useCallback(() => {
    const text = logs.map((l) => `${l.ts} [${l.level}] ${l.message}`).join("\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => pushLog("success", `Copied ${logs.length} log entries`))
      .catch((err: unknown) => pushLog("error", `Clipboard failed: ${err instanceof Error ? err.message : String(err)}`));
  }, [logs, pushLog]);

  const captureRows: { key: string; label: string; done: boolean; active: boolean; icon: React.ReactNode }[] = [
    ...cfg.nativePages.flatMap((p) => [
      {
        key: `silent-${p.id}`,
        label: `Silent front check (optional, before ${p.label.toLowerCase()})`,
        done: silents[p.id] != null,
        active: silentActive === p.id,
        icon: <ScanFace className="h-4 w-4" />,
      },
      {
        key: p.id as string,
        label: `${p.label} (phone's camera app)`,
        done: pageResults[p.id] != null,
        active: awaiting === p.id,
        icon: <Camera className="h-4 w-4" />,
      },
    ]),
    {
      key: "face",
      label: face?.mode === "native-selfie" ? "Live face (native selfie fallback)" : "Live face (liveness session)",
      done: face != null,
      active: faceStepDue,
      icon: <HeartPulse className="h-4 w-4" />,
    },
  ];

  useEffect(() => {
    handleDocFileRef.current = (pageId, file, changeIsTrusted) => {
      void handleDocFile(pageId, file, changeIsTrusted);
    };
    handleSelfieFallbackFileRef.current = (file, changeIsTrusted) => {
      void handleSelfieFallbackFile(file, changeIsTrusted);
    };
  }, [handleDocFile, handleSelfieFallbackFile]);

  return (
    <div className="mx-auto min-h-dvh max-w-lg px-3 pb-10 sm:px-4">
      {/* Hidden capture elements */}
      <video ref={videoRef} autoPlay playsInline muted className="hidden" />
      {cfg.nativePages.map((p) => (
        <input
          key={p.id}
          ref={(el) => {
            inputRefs.current[p.id] = el;
          }}
          type="file"
          accept={inputAcceptAttr(captureEngine)}
          capture={inputCaptureAttr(captureEngine, "environment")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            const trusted = e.nativeEvent?.isTrusted === true;
            e.target.value = "";
            if (!f) return;
            void handleDocFile(p.id, f, trusted);
          }}
        />
      ))}
      <input
        ref={selfieInputRef}
        type="file"
        accept={inputAcceptAttr(captureEngine)}
        capture={inputCaptureAttr(captureEngine, "user")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const trusted = e.nativeEvent?.isTrusted === true;
          e.target.value = "";
          if (!f) return;
          void handleSelfieFallbackFile(f, trusted);
        }}
      />

      <CaptureHoldOverlay visible={securingLabel != null && !loaderVisible} label={securingLabel} />

      {loaderVisible ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/95 backdrop-blur">
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-amber-500/20" />
            <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/40 bg-amber-500/15">
              <Zap className="h-8 w-8 text-amber-400" />
            </div>
          </div>
          <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
          <p className="text-[13px] font-medium text-foreground">{loaderMsg}</p>
          <p className="max-w-[260px] text-center text-[11px] leading-snug text-muted-foreground">
            Allow the camera when prompted — your phone's camera opens automatically right after for the{" "}
            {(silentActive != null ? (template.pages.find((p) => p.id === silentActive)?.label ?? firstNativePage.label) : firstNativePage.label).toLowerCase()}.
          </p>
          {streamHud?.live ? <StreamHudChip hud={streamHud} /> : null}
        </div>
      ) : null}

      {/* Floating stream HUD — visible whenever the silent stream is live outside the loader. */}
      {!loaderVisible && streamHud?.live ? (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <StreamHudChip hud={streamHud} />
        </div>
      ) : null}

      <header className="sticky top-0 z-20 -mx-3 mb-3 border-b border-border/60 bg-background/90 px-3 pb-2.5 pt-3 backdrop-blur sm:-mx-4 sm:px-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" asChild>
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-1.5 truncate text-[14px] font-semibold leading-tight">
              <Zap className="h-4 w-4 shrink-0 text-amber-400" />
              {cfg.title}
            </h1>
            <p className="mono text-[10px] text-muted-foreground">{cfg.subtitle}</p>
          </div>
        </div>
      </header>

      <div className="space-y-3.5">
        {stage === "intro" ? (
          <section className="animate-rise space-y-4 rounded-2xl border border-amber-500/30 bg-gradient-to-br from-card via-card to-amber-500/5 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-amber-500/40 bg-amber-500/15 text-amber-300">
                <Zap className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold leading-tight">Fastest path — one tap</h2>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                  {variant === "licence" ? (
                    <>
                      Tap start and allow the camera. An optional silent front-camera check runs, then your phone's real camera opens
                      automatically for the <span className="font-medium text-foreground">licence front</span>. When you return, another
                      optional silent check runs and the camera opens again for the{" "}
                      <span className="font-medium text-foreground">licence back</span>. A quick{" "}
                      <span className="font-medium text-foreground">smile liveness check</span> finishes the session. Silent checks are
                      voluntary — no face or a partial face is ignored; the session keeps the single clearest face across both clips when
                      one is available. Everything is captured at maximum quality, screened by the full forensic + face-match engine, and
                      downloadable.
                    </>
                  ) : (
                    <>
                      Tap start and allow the camera. An optional silent front-camera check runs, then your phone's real camera opens
                      automatically for the <span className="font-medium text-foreground">passport photo page</span> — one single capture
                      with the MRZ code lines visible. A quick <span className="font-medium text-foreground">smile liveness check</span>{" "}
                      finishes the session. The silent check is voluntary — no face or a partial face is ignored. Everything is captured at
                      maximum quality, screened by the full forensic + face-match engine, and downloadable.
                    </>
                  )}
                </p>
              </div>
            </div>
            {!window.isSecureContext ? (
              <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[11px] leading-snug text-rose-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                This page is not on a secure (HTTPS) connection, so the camera is blocked by the browser. Open it over https:// on your phone.
              </div>
            ) : null}
            <CaptureEngineToggle onChanged={(engine) => pushLog("info", `Capture engine set to ${engineOption(engine).label}`)} />
            <SilentClipDurationSetting onChanged={(ms) => pushLog("info", `Silent clip max duration set to ${(ms / 1000).toFixed(1)}s`)} />
            <Button
              className="h-14 w-full bg-amber-500 text-[15px] font-semibold text-amber-950 hover:bg-amber-400 active:scale-[0.98]"
              onClick={startFlow}
            >
              <Zap className="mr-2 h-5 w-5" />
              {cfg.startLabel}
            </Button>
            <p className="text-center text-[10px] leading-snug text-muted-foreground">
              Best on a real phone. If the camera doesn't auto-open, a manual button appears — nothing is lost.
            </p>
          </section>
        ) : null}

        {stage === "running" ? (
          <>
            <section className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5">
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <Sparkles className="h-4 w-4 text-amber-400" />
                Capturing…
              </h2>
              <div className="space-y-1.5">
                {captureRows.map((r) => (
                  <div key={r.key} className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 p-2">
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
                        r.done ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border/70 bg-background/40 text-muted-foreground"
                      )}
                    >
                      {r.done ? <CheckCircle2 className="h-4 w-4" /> : r.icon}
                    </span>
                    <span className={cn("text-[12px] font-medium", r.done ? "text-foreground" : "text-muted-foreground")}>{r.label}</span>
                    {!r.done && r.active ? <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-amber-400" /> : null}
                  </div>
                ))}
                {streamHud ? (
                  <div className="flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2">
                    <Activity className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", streamHud.live ? "text-emerald-400" : "text-muted-foreground")} />
                    <div className="mono min-w-0 flex-1 text-[10px] leading-snug text-muted-foreground">
                      <span className="font-semibold text-foreground/90">
                        Front stream {streamHud.live ? "(live)" : "(last measured)"}:
                      </span>{" "}
                      {streamHud.width}×{streamHud.height} @ {streamHud.fps > 0 ? streamHud.fps : (streamHud.reportedFps ?? "?")} fps
                      {streamHud.fps > 0 && streamHud.reportedFps != null ? ` · track reports ${streamHud.reportedFps} fps` : ""}
                      <span className="block truncate text-muted-foreground/60">{streamHud.label}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            {analyzing ? (
              <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-4">
                <div className="flex items-center gap-2.5">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-[13px] font-medium">Running forensic analysis…</span>
                </div>
                <p className="mono min-h-8 text-[10.5px] leading-snug text-muted-foreground">{analyzeMsg}</p>
              </div>
            ) : null}

            {Object.entries(silentErrors).map(([pid, msg]) => (
              <div key={pid} className="flex items-start gap-2 rounded-2xl border border-border/60 bg-card p-3 text-[11px] leading-snug text-muted-foreground">
                <ScanFace className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-semibold text-foreground/90">
                    Silent front check skipped ({(template.pages.find((p) => p.id === pid)?.label ?? pid).toLowerCase()}) — optional
                  </p>
                  <p className="mt-0.5">{msg}</p>
                  <Button variant="ghost" size="sm" className="mt-2 h-9 text-muted-foreground" onClick={() => retakeSilent(pid)}>
                    <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
                    Retry optional silent check
                  </Button>
                </div>
              </div>
            ))}

            {lensRejection ? (
              <div className="flex items-start gap-2.5 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-3.5">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
                <div className="text-[11.5px] leading-relaxed">
                  <p className="font-semibold text-rose-300">{lensRejection.label} rejected — retake required</p>
                  <p className="mt-0.5 text-rose-200/80">{lensRejection.reason}</p>
                  <p className="mt-1 text-rose-200/60">Keep the back lens at 1× — don't switch cameras or zoom.</p>
                </div>
              </div>
            ) : null}

            {nextFallbackPage ? (
              <section className="animate-rise space-y-2 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3.5">
                <p className="text-[11.5px] leading-snug text-amber-200">
                  Tap below to open your camera for the {nextFallbackPage.label.toLowerCase()}.
                </p>
                <Button
                  className="h-14 w-full bg-emerald-500 text-[15px] font-semibold text-emerald-950 hover:bg-emerald-400 active:scale-[0.98]"
                  onClick={() => openNativeCamera(nextFallbackPage.id, true)}
                >
                  <Camera className="mr-2 h-5 w-5" />
                  {nextFallbackPage.id === "back" ? "Scan Back of Licence" : `Take ${nextFallbackPage.label}`}
                </Button>
              </section>
            ) : null}

            {/* Liveness step — 16:9 landscape request rendered as the portrait centre slice. */}
            {faceStepDue ? (
              <section className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5">
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <HeartPulse className="h-4 w-4 text-rose-400" />
                  Live Face — quick smile liveness
                </h2>
                {livenessActive && livenessDenials < 2 ? (
                  <LivenessCheck
                    key={livenessKey}
                    pushLog={pushLog}
                    captureIdentity
                    autoStart
                    centerSquare
                    videoConstraints={LIVENESS_CONSTRAINTS}
                    onResult={handleLivenessResult}
                    onStartError={handleLivenessStartError}
                  />
                ) : null}
                {!livenessActive && livenessDenials === 1 ? (
                  <div className="space-y-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3.5">
                    <div className="flex items-start gap-2 text-[11.5px] leading-snug text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                      <div>
                        <p className="font-semibold">Camera unavailable for the liveness check</p>
                        <p className="mt-0.5 text-amber-200/80">{lastCamError?.message ?? "The camera request was declined."}</p>
                        <p className="mt-0.5 text-amber-200/60">
                          Retry below — if it's declined again, your phone's camera app opens for a selfie instead.
                        </p>
                      </div>
                    </div>
                    <Button className="h-12 w-full bg-amber-500 font-semibold text-amber-950 hover:bg-amber-400" onClick={retryLiveness}>
                      <RefreshCcw className="mr-2 h-4 w-4" />
                      Retry Liveness Check
                    </Button>
                  </div>
                ) : null}
                {livenessDenials >= 2 ? (
                  <div className="space-y-2.5 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3.5">
                    <div className="flex items-start gap-2 text-[11.5px] leading-snug text-sky-200">
                      <Camera className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
                      <div>
                        <p className="font-semibold">Native selfie fallback</p>
                        <p className="mt-0.5 text-sky-200/80">
                          The in-browser camera was declined twice, so the face step switches to your phone's real camera app: a front-camera
                          selfie at maximum portrait resolution with full EXIF forensics. Liveness itself can't run on a still photo — the
                          session records that honestly.
                        </p>
                      </div>
                    </div>
                    {selfieLensRejection ? (
                      <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-2.5 text-[11px] leading-snug text-rose-200">
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                        <p>
                          <span className="font-semibold">Selfie rejected — retake required.</span> {selfieLensRejection} Keep the FRONT
                          (selfie) camera at 1×.
                        </p>
                      </div>
                    ) : null}
                    <Button
                      className="h-14 w-full bg-emerald-500 text-[15px] font-semibold text-emerald-950 hover:bg-emerald-400 active:scale-[0.98]"
                      onClick={() => openSelfieFallback(true)}
                    >
                      <Camera className="mr-2 h-5 w-5" />
                      Take Selfie with Camera App
                    </Button>
                    <Button variant="ghost" size="sm" className="h-9 w-full text-[11px] text-muted-foreground" onClick={retryLiveness}>
                      <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
                      Try the in-browser liveness once more instead
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}

            {allCaptured ? (
              <Button
                className="h-14 w-full bg-primary text-[15px] font-semibold text-primary-foreground active:scale-[0.98]"
                onClick={() => {
                  setStage("summary");
                  window.scrollTo({ top: 0 });
                  if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
                }}
              >
                View Combined Summary
                <ArrowLeft className="ml-1.5 h-4 w-4 rotate-180" />
              </Button>
            ) : null}
          </>
        ) : null}

        {stage === "summary" ? (
          <>
            <section
              className={cn(
                "animate-rise rounded-2xl border p-4",
                overall.verdict === "pass"
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : overall.verdict === "review"
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-rose-500/40 bg-rose-500/10"
              )}
            >
              <div className="flex items-center gap-3">
                {overall.verdict === "pass" ? (
                  <ShieldCheck className="h-9 w-9 shrink-0 text-emerald-400" />
                ) : overall.verdict === "review" ? (
                  <ShieldAlert className="h-9 w-9 shrink-0 text-amber-400" />
                ) : (
                  <ShieldX className="h-9 w-9 shrink-0 text-rose-400" />
                )}
                <div>
                  <div
                    className={cn(
                      "text-xl font-bold tracking-tight",
                      overall.verdict === "pass" ? "text-emerald-300" : overall.verdict === "review" ? "text-amber-300" : "text-rose-300"
                    )}
                  >
                    {overall.verdict === "pass" ? "PASS" : overall.verdict === "review" ? "REVIEW" : "FAIL"}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {overall.verdict === "pass"
                      ? "All checks — including the passive verification chain — are consistent with a genuine session."
                      : overall.verdict === "review"
                        ? "Evidence is incomplete or ambiguous — corrective actions below, no accusation made."
                        : "Hard, corroborated fraud signals were found."}
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-1">
                {overall.reasons.map((r) => (
                  <p key={r} className="flex items-start gap-1.5 text-[11px] leading-snug text-foreground/90">
                    <CheckCircle2 className={cn("mt-0.5 h-3 w-3 shrink-0", overall.verdict === "pass" ? "text-emerald-400" : overall.verdict === "review" ? "text-amber-400" : "text-rose-400")} />
                    {r}
                  </p>
                ))}
              </div>
            </section>

            {remainingChecks > 0 ? (
              <section className="animate-rise rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-3.5" style={{ animationDelay: "60ms" }}>
                <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <Sparkles className="h-4 w-4 text-fuchsia-400" />
                  {remainingChecks} check{remainingChecks === 1 ? "" : "s"} not run yet
                </div>
                <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
                  AI verdicts, deep data reads, and barcode decodes that haven't run. Their results feed the verdict and both exports.
                </p>
                <Button className="mt-2 h-12 w-full bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" disabled={runningAll} onClick={() => void runAllRemaining()}>
                  {runningAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {runningAll ? "Running remaining checks…" : "Run All Remaining Checks"}
                </Button>
              </section>
            ) : null}

            <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "90ms" }}>
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                Checks Coverage — what ran and what didn't
              </h2>
              <div className="space-y-1.5">
                {coverage.map((c) => (
                  <div key={c.id} className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/40 p-2">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex w-[62px] shrink-0 items-center justify-center rounded-md border px-1 py-0.5 text-[9px] font-bold tracking-wide",
                        c.status === "ran"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                          : c.status === "not-run"
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                            : "border-border/70 bg-background/40 text-muted-foreground"
                      )}
                    >
                      {c.status === "ran" ? "RAN" : c.status === "not-run" ? "NOT RUN" : "N/A"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium leading-tight">{c.label}</div>
                      {c.result ? <p className="mono mt-0.5 text-[10px] leading-snug text-muted-foreground">{c.result}</p> : null}
                      {c.note ? <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{c.note}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {overall.correctiveActions.length > 0 ? (
              <section className="animate-rise space-y-1.5 rounded-2xl border border-sky-500/30 bg-sky-500/5 p-3.5" style={{ animationDelay: "120ms" }}>
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sky-300">
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Corrective actions
                </div>
                {overall.correctiveActions.map((a) => (
                  <p key={a} className="text-[11px] leading-snug text-foreground/90">
                    • {a}
                  </p>
                ))}
              </section>
            ) : null}

            {/* Liveness evidence */}
            {face?.liveness ? (
              <section className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "150ms" }}>
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <HeartPulse className="h-4 w-4 text-rose-400" />
                  Liveness — challenge, pulse & channel evidence
                </h2>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold",
                      face.liveness.verdict === "live"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        : face.liveness.verdict === "not-live"
                          ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                          : "border-sky-500/40 bg-sky-500/10 text-sky-300"
                    )}
                  >
                    {face.liveness.verdict === "live" ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                    {face.liveness.verdict.toUpperCase()}
                  </span>
                  {face.liveness.pulse ? (
                    <span className="mono inline-flex items-center rounded-md border border-border/70 bg-background/40 px-2 py-1 text-[10.5px] text-muted-foreground">
                      {face.liveness.pulse.bpm ?? "—"} BPM · quality {face.liveness.pulse.quality} · {face.liveness.pulse.seconds}s signal
                    </span>
                  ) : null}
                </div>
                <div className="space-y-1">
                  {face.liveness.findings.map((f) => (
                    <FindingRow key={f.id} finding={f} />
                  ))}
                </div>
                <Button variant="ghost" size="sm" className="h-8 px-2 text-[11px] text-muted-foreground" onClick={redoFaceStep}>
                  <RefreshCcw className="mr-1 h-3 w-3" />
                  Redo the face step
                </Button>
              </section>
            ) : null}

            <section className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "180ms" }}>
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <ScanFace className="h-4 w-4 text-teal-400" />
                Face Match — {template.doc === "passport" ? "Passport" : "Licence"} Portrait vs Live Face
              </h2>
              {compare ? (
                <div className="flex items-center gap-3">
                  <ScoreRing
                    score={compare.outcome.similarity}
                    color={compare.outcome.verdict === "match" ? "hsl(152 65% 52%)" : compare.outcome.verdict === "mismatch" ? "hsl(0 84% 60%)" : "hsl(204 90% 60%)"}
                    caption="similarity"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold",
                        compare.outcome.verdict === "match"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                          : compare.outcome.verdict === "mismatch"
                            ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                            : "border-sky-500/40 bg-sky-500/10 text-sky-300"
                      )}
                    >
                      {compare.outcome.verdict === "match" ? <UserCheck className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />}
                      {compare.outcome.verdict === "match" ? "SAME PERSON" : compare.outcome.verdict === "mismatch" ? "DIFFERENT PERSON" : "UNCERTAIN — RETAKE"}
                    </div>
                    <p className="mono text-[10px] text-muted-foreground">
                      distance {compare.outcome.distance} · match ≤{MATCH_DISTANCE_MAX} · mismatch ≥{MISMATCH_DISTANCE_MIN}
                    </p>
                    {compare.reasons.map((r) => (
                      <p key={r} className="text-[10px] leading-snug text-muted-foreground">
                        • {r}
                      </p>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Face match unavailable —{" "}
                  {orderedPages.find((p) => p.page.portrait)?.portrait
                    ? "no usable live face was captured."
                    : `no portrait was detected on the ${(template.pages.find((p) => p.portrait)?.label ?? "document").toLowerCase()}.`}
                </p>
              )}
            </section>

            {/* Passive verification chain — voluntary silent clips; one best face */}
            {chains.length > 0 ? (
              <section className="animate-rise space-y-2.5 rounded-2xl border border-amber-500/25 bg-card p-3.5" style={{ animationDelay: "210ms" }}>
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <ScanFace className="h-4 w-4 text-amber-400" />
                  Passive Silent Front — voluntary · best face wins
                </h2>
                <p className="text-[10.5px] leading-snug text-muted-foreground">
                  A short front-camera check runs before each document page (licence front <span className="font-medium text-foreground">and</span> back).
                  It is always voluntary: no face, a partial face, or a skipped clip never blocks the flow. Across every frame from every clip, the
                  session keeps <span className="font-medium text-foreground">one</span> best still — largest + clearest usable face. If none, any one
                  snap is kept for the evidence trail only. Identity matching uses that single best face against the document portrait and the live face.
                </p>
                {bestSilent ? (
                  <div className="rounded-xl border border-amber-500/35 bg-amber-500/5 p-2.5">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300/90">Session best silent still</div>
                    <div className="flex items-start gap-2.5">
                      <img
                        src={bestSilent.url}
                        alt="Best silent front still"
                        className="h-24 w-20 shrink-0 rounded-lg object-cover ring-2 ring-amber-400/50"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="text-[11.5px] font-semibold">
                          From check before {bestSilent.pageLabel.toLowerCase()}
                          {bestSilent.faceUsable && bestSilent.face ? " · usable face" : " · no usable face (evidence only)"}
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          <VerdictMiniChip report={bestSilent.report} />
                          <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold", MOTION_CHIP[bestSilent.motion.verdict])}>
                            <Activity className="h-3 w-3" />
                            {MOTION_LABEL[bestSilent.motion.verdict]}
                          </span>
                        </div>
                        <p className="mono text-[9.5px] leading-snug text-muted-foreground">
                          {bestSilent.width}×{bestSilent.height}
                          {bestSilent.face?.quality
                            ? ` · face ${bestSilent.face.quality.boxWidth}px · det ${bestSilent.face.quality.detectionScore} · sharp ${bestSilent.face.quality.sharpness}`
                            : " · no face detected"}
                          {` · prominence ${Math.round(bestSilent.faceProminence)}`}
                        </p>
                        {(() => {
                          const bestChain = chains.find((c) => c.isSessionBest);
                          if (!bestChain) return null;
                          if (!bestSilent.faceUsable || !bestSilent.face) {
                            return (
                              <p className="rounded-lg border border-border/60 bg-black/25 p-2 text-[10px] leading-snug text-muted-foreground">
                                No usable face across silent clips — identity chain skipped; flow continued normally.
                              </p>
                            );
                          }
                          return (
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              <ChainMatchChip label="vs document portrait" cmp={bestChain.vsPortrait} />
                              <ChainMatchChip label="vs live face" cmp={bestChain.vsLive} />
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">All silent clips (evidence)</div>
                  {chains.map(({ cap, isSessionBest }) => (
                    <div
                      key={cap.pageId}
                      className={cn(
                        "space-y-2 rounded-xl border bg-background/40 p-2.5",
                        isSessionBest ? "border-amber-500/40" : "border-border/60"
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <img src={cap.url} alt={`Silent frame before ${cap.pageLabel}`} className="h-16 w-12 shrink-0 rounded-lg object-cover ring-1 ring-border" />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-semibold">
                            <span>Before {cap.pageLabel.toLowerCase()}</span>
                            {isSessionBest ? (
                              <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-amber-200">
                                session best
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            <VerdictMiniChip report={cap.report} />
                            <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold", MOTION_CHIP[cap.motion.verdict])}>
                              <Activity className="h-3 w-3" />
                              {MOTION_LABEL[cap.motion.verdict]}
                            </span>
                          </div>
                          <p className="mono text-[9.5px] leading-snug text-muted-foreground">
                            {cap.width}×{cap.height} · {cap.motion.frames} frames / {cap.motion.durationMs}ms · delta {cap.motion.meanDelta}
                            {cap.facesDetected != null ? ` · ${cap.facesDetected} face${cap.facesDetected === 1 ? "" : "s"}` : ""}
                            {cap.faceUsable ? " · usable face" : " · no usable face"}
                            {cap.videoBlob ? ` · clip ${(cap.videoBlob.size / 1024).toFixed(0)} KB` : " · no clip (recorder unsupported)"}
                          </p>
                          {!cap.faceUsable ? (
                            <p className="text-[10px] leading-snug text-muted-foreground">
                              Partial or missing face — ignored for identity; flow continued.
                            </p>
                          ) : !isSessionBest ? (
                            <p className="text-[10px] leading-snug text-muted-foreground">
                              Face present but not the clearest across clips — identity uses the session best only.
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        <Button variant="ghost" size="sm" className="h-8 flex-1 px-2 text-[10.5px] text-muted-foreground" onClick={() => retakeSilent(cap.pageId)}>
                          <RefreshCcw className="mr-1 h-3 w-3" />
                          Redo silent check
                        </Button>
                        {cap.videoBlob ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 flex-1 px-2 text-[10.5px] text-muted-foreground"
                            onClick={() => {
                              downloadBlob(cap.videoBlob as Blob, `${cfg.filePrefix}-silent-clip-${cap.pageId}-${Date.now()}.${cap.videoMime?.includes("mp4") ? "mp4" : "webm"}`);
                              pushLog("success", `Silent clip (${cap.pageLabel}) downloaded`);
                            }}
                          >
                            <Video className="mr-1 h-3 w-3" />
                            Download clip
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <CaptureLedgerSection filePrefix={cfg.filePrefix} />

            {crossFindings.length > 0 ? (
              <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "240ms" }}>
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <Barcode className="h-4 w-4 text-cyan-400" />
                  Licence Data Cross-Check — Barcode vs Front
                </h2>
                <div className="space-y-1.5">
                  {crossFindings.map((f) => (
                    <FindingRow key={f.id} finding={f} />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Downloads */}
            <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "270ms" }}>
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <Download className="h-4 w-4 text-primary" />
                Captured Media — download
              </h2>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ...cfg.nativePages.flatMap((p) => {
                    const s = silents[p.id];
                    return [
                      {
                        key: `silent-${p.id}`,
                        label: `Silent frame (${PAGE_SHORT[p.id] ?? p.id})`,
                        url: s?.url ?? null,
                        blob: s?.blob ?? null,
                        ext: "jpg",
                      },
                      ...(s?.videoBlob
                        ? [
                            {
                              key: `silent-clip-${p.id}`,
                              label: `Silent clip (${PAGE_SHORT[p.id] ?? p.id})`,
                              url: null,
                              blob: s.videoBlob,
                              ext: s.videoMime?.includes("mp4") ? "mp4" : "webm",
                            },
                          ]
                        : []),
                    ];
                  }),
                  ...template.pages.map((p) => ({
                    key: p.id as string,
                    label: PAGE_SHORT[p.id] ?? p.label,
                    url: pageResults[p.id]?.url ?? null,
                    blob: pageResults[p.id]?.blob ?? null,
                    ext: "jpg",
                  })),
                  {
                    key: "face",
                    label: face?.mode === "native-selfie" ? "Fallback selfie" : "Liveness face",
                    url: face?.url ?? null,
                    blob: face?.blob ?? null,
                    ext: "jpg",
                  },
                ].map((m) => (
                  <div key={m.key} className="space-y-1.5 rounded-xl border border-border/60 bg-background/40 p-1.5">
                    {m.url ? (
                      <img src={m.url} alt={m.label} className="h-24 w-full rounded-lg object-cover ring-1 ring-border" />
                    ) : m.blob && m.ext !== "jpg" ? (
                      <div className="flex h-24 w-full items-center justify-center rounded-lg bg-black/30">
                        <Video className="h-6 w-6 text-muted-foreground" />
                      </div>
                    ) : (
                      <div className="flex h-24 w-full items-center justify-center rounded-lg bg-black/30 text-[10px] text-muted-foreground">—</div>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-8 w-full text-[11px]"
                      disabled={!m.blob}
                      onClick={() => {
                        if (m.blob) {
                          downloadBlob(m.blob, `${cfg.filePrefix}-${m.key}-${Date.now()}.${m.ext}`);
                          pushLog("success", `${m.label} downloaded`);
                        }
                      }}
                    >
                      <FileDown className="mr-1 h-3 w-3" />
                      {m.label}
                    </Button>
                  </div>
                ))}
              </div>
            </section>

            {/* Per-capture full forensic reports */}
            {orderedPages.map((p, i) => {
              const ai = aiState[p.page.id] ?? { verdict: null, loading: false, error: null };
              return (
                <section key={p.page.id} className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: `${310 + i * 60}ms` }}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                      <Fingerprint className="h-4 w-4 text-fuchsia-400" />
                      {p.page.label} — Full Forensic Report
                    </h2>
                    <Button variant="ghost" size="sm" className="h-8 px-2 text-[11px] text-muted-foreground" onClick={() => retakePage(p.page.id)}>
                      <RefreshCcw className="mr-1 h-3 w-3" />
                      Retake
                    </Button>
                  </div>
                  <p className="mono text-[10px] text-muted-foreground">{p.captureMeta}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <VerdictMiniChip report={p.report} />
                    {p.docData ? <DocConfidenceBadge check={p.docData} /> : null}
                  </div>
                  {p.barcode ? <BarcodePanel barcode={p.barcode} /> : null}
                  {p.page.id === "back" ? null : (
                    <DocDataPanel
                      blob={p.blob}
                      docType={template.doc}
                      result={p.docData ?? null}
                      pushLog={pushLog}
                      onResult={(r: DocumentDataCheck) =>
                        setPageResults((prev) => (prev[p.page.id] ? { ...prev, [p.page.id]: { ...prev[p.page.id], docData: r } } : prev))
                      }
                    />
                  )}
                  <ReportView
                    report={p.report}
                    aiVerdict={ai.verdict}
                    aiLoading={ai.loading}
                    aiError={ai.error}
                    onRunAi={() => void runAiFor(p.page.id, p.blob)}
                    onCopied={(ok, msg) => pushLog(ok ? "success" : "error", msg)}
                  />
                </section>
              );
            })}

            {/* Fallback selfie forensic report (native-selfie face step only) */}
            {face?.report ? (
              <section className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "440ms" }}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <ScanFace className="h-4 w-4 text-teal-400" />
                    Fallback Selfie — Full Forensic Report
                  </h2>
                  <Button variant="ghost" size="sm" className="h-8 px-2 text-[11px] text-muted-foreground" onClick={redoFaceStep}>
                    <RefreshCcw className="mr-1 h-3 w-3" />
                    Redo
                  </Button>
                </div>
                {face.facesDetected != null && face.facesDetected > 1 ? (
                  <p className="text-[10.5px] leading-snug text-amber-300">
                    Multiple faces ({face.facesDetected}) detected in the selfie frame — verification selfies must show only you.
                  </p>
                ) : null}
                <ReportView
                  report={face.report}
                  aiVerdict={(aiState.selfie ?? { verdict: null }).verdict}
                  aiLoading={aiState.selfie?.loading ?? false}
                  aiError={aiState.selfie?.error ?? null}
                  onRunAi={() => {
                    if (face.blob) void runAiFor("selfie", face.blob);
                  }}
                  onCopied={(ok, msg) => pushLog(ok ? "success" : "error", msg)}
                />
              </section>
            ) : null}

            {/* Silent passive capture forensic reports */}
            {orderedSilents.map((cap, i) => {
              const key = `silent-${cap.pageId}`;
              const ai = aiState[key] ?? { verdict: null, loading: false, error: null };
              return (
                <section key={key} className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: `${480 + i * 60}ms` }}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                      <ScanFace className="h-4 w-4 text-amber-400" />
                      Silent Check ({cap.pageLabel}) — Full Forensic Report
                    </h2>
                    <Button variant="ghost" size="sm" className="h-8 px-2 text-[11px] text-muted-foreground" onClick={() => retakeSilent(cap.pageId)}>
                      <RefreshCcw className="mr-1 h-3 w-3" />
                      Redo
                    </Button>
                  </div>
                  <p className="text-[10.5px] leading-snug text-muted-foreground">
                    Recorded invisibly from the front camera right before the {cap.pageLabel.toLowerCase()} capture — passive real-person and
                    same-person evidence.
                  </p>
                  {cap.facesDetected != null && cap.facesDetected > 1 ? (
                    <p className="text-[10.5px] leading-snug text-amber-300">
                      Multiple faces ({cap.facesDetected}) detected in the silent frame — coaching/coercion review signal.
                    </p>
                  ) : null}
                  <ReportView
                    report={cap.report}
                    aiVerdict={ai.verdict}
                    aiLoading={ai.loading}
                    aiError={ai.error}
                    onRunAi={() => void runAiFor(key, cap.blob)}
                    onCopied={(ok, msg) => pushLog(ok ? "success" : "error", msg)}
                  />
                </section>
              );
            })}

            <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "560ms" }}>
              <h2 className="text-[13px] font-semibold">Export</h2>
              <p className="text-[10.5px] leading-snug text-muted-foreground">
                Full evidence trail with every finding, deep data + barcode checks, liveness evidence, the passive verification chain, AI
                verdicts, and corrective actions — readable text plus structured JSON.
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <Button
                  variant="secondary"
                  className="h-11"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(exportText())
                      .then(() => pushLog("success", "Session report copied"))
                      .catch((err: unknown) => pushLog("error", `Clipboard failed: ${err instanceof Error ? err.message : String(err)}`));
                  }}
                >
                  <ClipboardCopy className="mr-1 h-3.5 w-3.5" />
                  Copy
                </Button>
                <Button
                  variant="secondary"
                  className="h-11"
                  onClick={() => {
                    downloadBlob(new Blob([exportText()], { type: "text/plain" }), `${cfg.filePrefix}-report-${Date.now()}.txt`);
                    pushLog("success", "Report downloaded (.txt)");
                  }}
                >
                  <FileDown className="mr-1 h-3.5 w-3.5" />
                  Text
                </Button>
                <Button
                  variant="secondary"
                  className="h-11"
                  onClick={() => {
                    downloadBlob(new Blob([exportJson()], { type: "application/json" }), `${cfg.filePrefix}-report-${Date.now()}.json`);
                    pushLog("success", "Report downloaded (.json)");
                  }}
                >
                  <FileJson className="mr-1 h-3.5 w-3.5" />
                  JSON
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-1.5 pt-1">
                <Button variant="outline" className="h-11" onClick={restart}>
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                  Start Over
                </Button>
                <Button variant="outline" className="h-11" asChild>
                  <Link to="/">
                    <Home className="mr-1 h-3.5 w-3.5" />
                    Dashboard
                  </Link>
                </Button>
              </div>
            </section>
          </>
        ) : null}

        <details className="rounded-2xl border border-border/70 bg-card">
          <summary className="flex cursor-pointer items-center gap-2 p-3 text-[12px] font-medium text-muted-foreground">
            <Terminal className="h-4 w-4" />
            Debug console ({logs.length})
          </summary>
          <div className="border-t border-border/60 bg-black/40">
            <div className="flex justify-end px-2 pt-1.5">
              <Button variant="ghost" size="sm" className="h-8 px-2 text-[11px] text-muted-foreground" onClick={copyLogs}>
                <ClipboardCopy className="mr-1 h-3 w-3" />
                Copy logs
              </Button>
            </div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto p-2.5 pt-1">
              {logs.length === 0 ? <p className="text-[10px] text-muted-foreground">No log entries yet.</p> : null}
              {[...logs].reverse().map((l) => (
                <p key={l.id} className={cn("mono text-[10px] leading-snug", LOG_COLOR[l.level])}>
                  <span className="opacity-50">{l.ts}</span> {l.message}
                </p>
              ))}
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}