import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, HeartPulse, Loader2, Play, ShieldCheck, ShieldX, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import CameraErrorHelp, { classifyCameraError, type CameraErrorInfo } from "@/components/CameraErrorHelp";
import {
  describeFace,
  describeFaceRobust,
  detectFaceBoxes,
  loadFaceModels,
  sampleExpression,
  type DetectedFaceBox,
  type FaceDescription,
} from "@/lib/face-vision";
import { estimatePulse, sampleForeheadRgb, type PpgSample, type PulseEstimate } from "@/lib/ppg";
import { assessScreenReplayFromCanvas } from "@/lib/pixel-forensics";
import { injectionFindings, runInjectionAudit, type InjectionAuditResult } from "@/lib/injection-guard";
import type { Finding } from "@/lib/fraud-detection";
import { FindingRow } from "@/components/ReportView";
import type { LogLevel } from "@/lib/camera-diagnostics";
import { ledgerBeginFeed, ledgerFeedDenied, ledgerFeedFirstFrame, ledgerFeedGranted, ledgerFeedStopped, ledgerFeedTelemetry } from "@/lib/capture-ledger";

type Phase = "idle" | "loading" | "baseline" | "challenge" | "hold" | "done";

export type LivenessVerdict = "live" | "not-live" | "inconclusive";

export type LivenessSessionResult = {
  verdict: LivenessVerdict;
  findings: Finding[];
  pulse: PulseEstimate;
  /** Best identity face captured during the session (when captureIdentity is set). */
  face: FaceDescription | null;
  faceImageUrl: string | null;
};

const VIRTUAL_LABEL_MARKERS = [
  "obs",
  "virtual",
  "manycam",
  "snap camera",
  "xsplit",
  "splitcam",
  "camtwist",
  "v4l2loopback",
  "droidcam",
  "iriun",
  "epoccam",
  "ndi",
  "avatarify",
  "deepfacelive",
];

/**
 * Short markers ("obs", "ndi") need word boundaries: real HARDWARE camera
 * brands contain them as substrings ("OBSBOT Tiny" ⊃ "obs", "Sandisk" ⊃
 * "ndi") and a raw includes() would flag a genuine webcam as a virtual
 * camera — a definitive-weight false positive. Longer names are unambiguous.
 */
function labelHasMarker(label: string, marker: string): boolean {
  if (marker.length > 4) return label.includes(marker);
  if (!label.includes(marker)) return false;
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`).test(label);
}

/**
 * Quick challenge–response: two escalating smile prompts (smile → smile a bit
 * more) tracked live. The SUSTAINED real-time ramp — neutral baseline, then a
 * smile, then a visibly bigger smile, each held for a beat — defeats static
 * photos and stills; injection/replay hardware checks and the pulse read run
 * in parallel as corroboration. Target duration: ~7–9s when everything is
 * right.
 */
type ChallengeKind = "smile" | "smile-more";

type ChallengeDef = { kind: ChallengeKind; prompt: string; short: string };

type ChallengeResult = ChallengeDef & { latencyMs: number | null };

const CHALLENGE_PROMPTS: Record<ChallengeKind, ChallengeDef> = {
  smile: { kind: "smile", prompt: "SMILE 🙂", short: "smile" },
  "smile-more": { kind: "smile-more", prompt: "Great — now smile a bit MORE! 😁", short: "smile more" },
};

function buildChallengeSequence(): ChallengeDef[] {
  return [CHALLENGE_PROMPTS.smile, CHALLENGE_PROMPTS["smile-more"]];
}

/**
 * Smile gates are absolute OR baseline-relative — per-frame expression scores
 * vary a lot between faces/lighting, and people with naturally smiley resting
 * faces never cleared a fixed high bar. The relative gate (rise above your own
 * neutral baseline) is what actually proves a responsive live expression.
 */
const SMILE_MIN = 0.5;
const SMILE_MORE_MIN = 0.78;
const SMILE_DELTA = 0.35;
const SMILE_MORE_DELTA = 0.6;

/**
 * Relaxes over-constrained getUserMedia video constraints for a retry:
 * `exact`/`min` demands become `ideal` preferences so the camera can still
 * open (the delivered settings are logged either way).
 */
function relaxVideoConstraints(c: MediaTrackConstraints): MediaTrackConstraints {
  const relax = (v: unknown): unknown => {
    if (typeof v === "object" && v !== null) {
      const r = v as Record<string, unknown>;
      const target = r.exact ?? r.min ?? r.ideal;
      if (typeof target === "number" || typeof target === "string") return { ideal: target };
    }
    return v;
  };
  const out = { ...c } as Record<string, unknown>;
  for (const k of ["width", "height", "aspectRatio", "frameRate"] as const) {
    if (out[k] != null) out[k] = relax(out[k]);
  }
  return out as MediaTrackConstraints;
}

const SUSTAIN_MS = 400;
const CHALLENGE_TIMEOUT_MS = 8000;
const BASELINE_MS = 1200;
/** Pulse hold: ends the moment the pulse locks (min) or at max. PPG is collected across ALL phases, so the hold only tops up the signal. */
const HOLD_MIN_MS = 3500;
const HOLD_MAX_MS = 8000;
/** Every Nth expression tick also counts all faces in frame (~1.1s cadence). */
const MULTIFACE_EVERY = 8;

export default function LivenessCheck({
  pushLog,
  captureIdentity = false,
  onResult,
  videoConstraints,
  centerSquare = false,
  autoStart = false,
  onStartError,
}: {
  pushLog: (level: LogLevel, message: string) => void;
  /** Capture the best identity descriptor + snapshot during the session. */
  captureIdentity?: boolean;
  /** Called once per completed session with the full evidence bundle. */
  onResult?: (result: LivenessSessionResult) => void;
  /** Override the getUserMedia video constraints (default: front camera, 640×480 ideal). */
  videoConstraints?: MediaTrackConstraints;
  /** Render only the centre square of the feed — the sides of a wide (16:9) stream are visually cropped out. */
  centerSquare?: boolean;
  /** Start the session automatically on mount (no start-button press needed). */
  autoStart?: boolean;
  /**
   * Called when the camera fails to start (denied / unavailable). When
   * provided, the internal error panel is suppressed so the parent owns the
   * retry / fallback UI (e.g. the EyeDeeKit retry-twice → native fallback).
   */
  onStartError?: (info: CameraErrorInfo) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Capture Feed Ledger id for the live liveness feed. */
  const ledgerFeedIdRef = useRef<string | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const exprTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const pulseTimerRef = useRef<number | null>(null);

  const phaseRef = useRef<Phase>("idle");
  const phaseStartRef = useRef<number>(0);
  const sustainStartRef = useRef<number | null>(null);
  const baselineHappyRef = useRef<number[]>([]);
  const facePresentRef = useRef<number>(0);
  const faceSamplesRef = useRef<number>(0);
  const lastBoxRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  /** Latest all-faces scan (boxes + scores) for the live overlay — refreshed every MULTIFACE_EVERY ticks. */
  const allFacesRef = useRef<{ boxes: DetectedFaceBox[]; at: number } | null>(null);
  /** Motion-artifact gate: PPG samples are discarded while the face box is moving (IDKit-style signal hygiene). */
  const motionFlagRef = useRef<boolean>(false);
  const motionRejectsRef = useRef<number>(0);
  const ppgRef = useRef<PpgSample[]>([]);
  const frameDeltasRef = useRef<number[]>([]);
  const lastFrameTimeRef = useRef<number>(0);
  const identityRef = useRef<{ face: FaceDescription; url: string; canvas?: HTMLCanvasElement } | null>(null);
  const identityAttemptRef = useRef<number>(0);
  const identityBusyRef = useRef<boolean>(false);
  /** Exponential moving average of the happy score — stabilizes flickery per-frame expression reads. */
  const happyEmaRef = useRef<number | null>(null);
  /** Consecutive below-target frames — a single flicker no longer resets the sustain window. */
  const missRef = useRef<number>(0);
  const challengesRef = useRef<ChallengeResult[]>([]);
  const challengeIdxRef = useRef<number>(0);
  const tickCountRef = useRef<number>(0);
  const multiChecksRef = useRef<number>(0);
  const multiHitsRef = useRef<number>(0);
  const maxFacesRef = useRef<number>(0);
  const resultRef = useRef<{
    baselineAvg: number;
    screenReplay: ReturnType<typeof assessScreenReplayFromCanvas> | null;
    virtualLabels: string[];
    trackLabel: string;
    heldFrameChecked: boolean;
    injectionAudit: InjectionAuditResult | null;
  }>({ baselineAvg: 0, screenReplay: null, virtualLabels: [], trackLabel: "", heldFrameChecked: false, injectionAudit: null });

  const [phase, setPhase] = useState<Phase>("idle");
  const [challengeLabel, setChallengeLabel] = useState<string>("");
  const [challengeProgress, setChallengeProgress] = useState<string>("");
  const [signalLevel, setSignalLevel] = useState<number>(0);
  const [faceSeen, setFaceSeen] = useState<boolean>(false);
  const [countdown, setCountdown] = useState<number>(0);
  const [pulse, setPulse] = useState<PulseEstimate | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [verdict, setVerdict] = useState<LivenessVerdict | null>(null);
  const [error, setError] = useState<CameraErrorInfo | null>(null);

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    phaseStartRef.current = performance.now();
    sustainStartRef.current = null;
    setPhase(p);
  }, []);

  const applyChallengeUi = useCallback(() => {
    const idx = challengeIdxRef.current;
    const c = challengesRef.current[idx];
    if (c) {
      setChallengeLabel(c.prompt);
      setChallengeProgress(`challenge ${idx + 1}/${challengesRef.current.length}`);
    }
  }, []);

  const stopAll = useCallback(() => {
    if (exprTimerRef.current != null) window.clearInterval(exprTimerRef.current);
    if (pulseTimerRef.current != null) window.clearInterval(pulseTimerRef.current);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    exprTimerRef.current = null;
    pulseTimerRef.current = null;
    rafRef.current = null;
    const fid = ledgerFeedIdRef.current;
    if (fid && streamRef.current) {
      const deltas = frameDeltasRef.current;
      let fps: number | null = null;
      if (deltas.length > 5) {
        const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
        if (mean > 0) fps = Math.round(1000 / mean);
      }
      ledgerFeedTelemetry(fid, deltas.length > 0 ? deltas.length + 1 : null, fps);
      ledgerFeedStopped(fid);
      ledgerFeedIdRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    const overlay = overlayRef.current;
    if (overlay) overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
  }, []);

  useEffect(() => stopAll, [stopAll]);

  /**
   * Draws detection boxes over the live feed. The canvas shares the video's
   * intrinsic size, CSS mirror, and object-cover, so boxes drawn in raw video
   * coordinates land exactly on the rendered faces. Text is drawn in a
   * counter-mirrored transform so it reads correctly through the CSS flip.
   */
  const drawOverlay = useCallback((main: { x: number; y: number; width: number; height: number } | null, mainScore?: number) => {
    const canvas = overlayRef.current;
    const vid = videoRef.current;
    if (!canvas || !vid) return;
    const w = vid.videoWidth;
    const h = vid.videoHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const drawLabel = (text: string, boxX: number, boxY: number, boxW: number, color: string) => {
      ctx.save();
      // Counter-mirror: convert to display-space so glyphs read correctly after the CSS -scale-x-100.
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      const fontPx = Math.max(11, Math.round(w / 44));
      ctx.font = `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const dx = w - (boxX + boxW);
      const dy = Math.max(fontPx + 4, boxY - 6);
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(dx - 3, dy - fontPx - 2, tw + 6, fontPx + 6);
      ctx.fillStyle = color;
      ctx.fillText(text, dx, dy);
      ctx.restore();
    };

    const strokeBox = (b: { x: number; y: number; width: number; height: number }, color: string, dashed: boolean, lineW: number) => {
      ctx.setLineDash(dashed ? [Math.max(5, w / 90), Math.max(4, w / 130)] : []);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      // Corner ticks for a scanner feel on the primary face.
      if (!dashed) {
        const t = Math.min(b.width, b.height) * 0.18;
        ctx.lineWidth = lineW * 1.8;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y + t);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(b.x + t, b.y);
        ctx.moveTo(b.x + b.width - t, b.y);
        ctx.lineTo(b.x + b.width, b.y);
        ctx.lineTo(b.x + b.width, b.y + t);
        ctx.moveTo(b.x + b.width, b.y + b.height - t);
        ctx.lineTo(b.x + b.width, b.y + b.height);
        ctx.lineTo(b.x + b.width - t, b.y + b.height);
        ctx.moveTo(b.x + t, b.y + b.height);
        ctx.lineTo(b.x, b.y + b.height);
        ctx.lineTo(b.x, b.y + b.height - t);
        ctx.stroke();
      }
    };

    const lineW = Math.max(2, w / 280);
    const scan = allFacesRef.current;
    const scanFresh = scan != null && performance.now() - scan.at < 2600;

    // Secondary faces from the last all-faces scan (amber, dashed) — skip the
    // one overlapping the tracked primary so it isn't double-drawn.
    if (scanFresh && scan) {
      for (const f of scan.boxes) {
        const overlapsMain =
          main != null &&
          Math.abs(f.box.x - main.x) < main.width * 0.5 &&
          Math.abs(f.box.y - main.y) < main.height * 0.5;
        if (overlapsMain) continue;
        strokeBox(f.box, "rgba(251, 191, 36, 0.95)", true, lineW);
        drawLabel(`face ${Math.round(f.score * 100)}%`, f.box.x, f.box.y, f.box.width, "rgb(253, 224, 71)");
      }
    }

    if (main) {
      strokeBox(main, "rgba(52, 211, 153, 0.95)", false, lineW);
      drawLabel(mainScore != null ? `face ${Math.round(mainScore * 100)}%` : "face", main.x, main.y, main.width, "rgb(110, 231, 183)");
    }
  }, []);

  const drawWave = useCallback((trace: number[]) => {
    const canvas = waveRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (trace.length < 4) return;
    const max = Math.max(...trace.map((v) => Math.abs(v)), 0.5);
    ctx.strokeStyle = "hsl(0 84% 60%)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    trace.forEach((v, i) => {
      const x = (i / (trace.length - 1)) * w;
      const y = h / 2 - (v / max) * (h / 2 - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, []);

  const finish = useCallback(async () => {
    stopAll();
    const r = resultRef.current;
    const estimate = estimatePulse(ppgRef.current);
    setPulse(estimate);
    drawWave(estimate.trace);

    const out: Finding[] = [];
    const faceRatio = faceSamplesRef.current > 0 ? facePresentRef.current / faceSamplesRef.current : 0;
    out.push({
      id: "liveness-face",
      label: "Face presence through the session",
      status: faceRatio >= 0.7 ? "pass" : "warn",
      weight: faceRatio >= 0.7 ? 0 : 10,
      category: "device",
      observed: `Face detected in ${(faceRatio * 100).toFixed(0)}% of samples`,
      expected: "≥70% presence",
      detail:
        faceRatio >= 0.7
          ? "A single face stayed in frame for the whole session."
          : "The face left the frame or detection dropped repeatedly — results are degraded. Repeat in better light, face centered.",
    });

    const challenges = challengesRef.current;
    const challengesPassed = challenges.length > 0 && challenges.every((c) => c.latencyMs != null);
    const sequenceText = challenges
      .map((c) => `${c.short} ${c.latencyMs != null ? `✓${(c.latencyMs / 1000).toFixed(1)}s` : "✗ timeout"}`)
      .join(" → ");
    out.push({
      id: "liveness-challenge",
      label: "Smile challenge–response (smile → smile more)",
      status: challengesPassed ? "pass" : "fail",
      weight: challengesPassed ? 0 : 25,
      category: "device",
      observed: `Baseline happy ${r.baselineAvg.toFixed(2)} · sequence: ${sequenceText}`,
      expected: `Both smile prompts achieved within ${CHALLENGE_TIMEOUT_MS / 1000}s each, each held for ${SUSTAIN_MS}ms`,
      detail: challengesPassed
        ? "The expression tracked both escalating prompts in real time — rising from the neutral baseline to a smile and then a visibly bigger smile, each sustained. A static photo or a paused still physically cannot produce that responsive ramp."
        : "Not every smile prompt was achieved. This alone is not proof of a replay (the user may not have cooperated) — corroboration is required before a not-live verdict.",
    });

    if (estimate.quality === "good" && estimate.bpm != null) {
      out.push({
        id: "liveness-ppg",
        label: "Pulse (rPPG) from skin color",
        status: "pass",
        weight: 0,
        category: "pixel",
        observed: `${estimate.bpm} BPM (spectral cross-check ${estimate.bpmSpectral ?? "—"} BPM) · coherence ${estimate.coherence} · SNR ${estimate.snr} · ${estimate.seconds}s of signal (${estimate.samples} samples)`,
        expected: "Coherent 42–180 BPM cardiac rhythm confirmed by two independent estimators",
        detail: "A periodic blood-flow signal is present in the facial skin: the POS chrominance projection shows a clear spectral peak AND a matching autocorrelation period. Screens, printed photos, and most synthetic feeds carry no coherent pulse.",
      });
    } else if (estimate.quality === "weak") {
      out.push({
        id: "liveness-ppg",
        label: "Pulse (rPPG) from skin color",
        status: "warn",
        weight: 8,
        category: "pixel",
        observed: `Coherence ${estimate.coherence} (need ≥0.25) · spectral SNR ${estimate.snr} (need ≥1.8) · autocorr ${estimate.bpm ?? "—"} vs spectral ${estimate.bpmSpectral ?? "—"} BPM · ${estimate.seconds}s of signal`,
        expected: "Coherent 42–180 BPM rhythm agreed by both estimators",
        detail: "No corroborated pulse was extracted (the two independent estimators must agree and the spectral peak must stand clear of noise). Lighting, motion, or camera compression can hide the signal in genuine sessions — treated as missing evidence, never as proof of fakery.",
      });
    } else {
      out.push({
        id: "liveness-ppg",
        label: "Pulse (rPPG) from skin color",
        status: "info",
        weight: 0,
        category: "pixel",
        observed: `${estimate.seconds}s of usable signal`,
        expected: "≥5s of stable forehead tracking (collected across the whole session)",
        detail: "Not enough stable signal to attempt pulse extraction — keep the face centered and well lit through the whole session and repeat.",
      });
    }

    if (multiChecksRef.current >= 3) {
      const multiRatio = multiHitsRef.current / multiChecksRef.current;
      const flagged = multiRatio > 0.15 && multiHitsRef.current >= 2;
      out.push({
        id: "multiple-faces",
        label: "Multiple faces in frame",
        status: flagged ? "warn" : "pass",
        weight: flagged ? 10 : 0,
        category: "device",
        observed: `${multiHitsRef.current}/${multiChecksRef.current} scans saw >1 face (max ${maxFacesRef.current} faces)`,
        expected: "Exactly one face throughout the session",
        detail: flagged
          ? "A second face appeared repeatedly during the session — a common coaching/coercion signal in identity verification. Repeat the session alone; this is a review flag, not an accusation."
          : "Only one face was visible throughout the session.",
      });
    }

    if (r.virtualLabels.length > 0) {
      out.push({
        id: "device-virtual-cam",
        label: "Virtual camera source",
        status: "fail",
        weight: 30,
        category: "device",
        observed: r.virtualLabels.join(", "),
        expected: "A hardware camera label",
        detail: `The video source label matches known virtual-camera / injection tooling (${r.virtualLabels.join(", ")}) — the classic real-time deepfake delivery path.`,
      });
    } else {
      out.push({
        id: "device-virtual-cam",
        label: "Virtual camera source",
        status: "pass",
        weight: 0,
        category: "device",
        observed: r.trackLabel || "unnamed hardware camera",
        expected: "No virtual-camera tool names in device labels",
        detail: "The active camera label does not match any known virtual-camera or face-swap tool.",
      });
    }

    if (r.screenReplay) {
      const sr = r.screenReplay;
      const scorable = sr.verdict === "likely" && sr.signals.some((s) => s.threshold?.scoring === true);
      out.push({
        id: "screen-replay",
        label: "Screen-replay scan of the live feed",
        status: scorable ? "fail" : sr.verdict === "none" ? "pass" : "info",
        weight: scorable ? 25 : 0,
        category: "screen",
        observed: sr.signals
          .map((s) => `${s.label}: ${s.value ?? "n/a"}${s.triggered !== "no" && s.triggered !== "unassessable" ? ` [${s.triggered.toUpperCase()}]` : ""}`)
          .join(" · "),
        expected: "No display lattice and no refresh banding in the live frame",
        detail: sr.rationale,
      });
    }

    const audit = r.injectionAudit;
    if (audit) {
      out.push(...injectionFindings(audit));
    } else {
      out.push({
        id: "injection-audit",
        label: "Capture channel integrity",
        status: "info",
        weight: 0,
        category: "device",
        observed: "Audit did not complete",
        detail: "The capture-channel integrity audit did not finish during this session — no conclusion drawn.",
      });
    }

    if (frameDeltasRef.current.length > 10) {
      const deltas = frameDeltasRef.current;
      const mean = deltas.reduce((a, v) => a + v, 0) / deltas.length;
      const varr = deltas.reduce((a, v) => a + (v - mean) * (v - mean), 0) / deltas.length;
      const jitter = Math.sqrt(varr);
      out.push({
        id: "liveness-frame-timing",
        label: "Frame timing consistency",
        status: "info",
        weight: 0,
        category: "device",
        observed: `${deltas.length} frames · mean interval ${mean.toFixed(1)}ms · jitter ${jitter.toFixed(1)}ms`,
        detail: "Hardware cameras show organic timing jitter; perfectly uniform intervals can indicate an injected synthetic feed. Informational metric.",
      });
    }

    // Definitive channel evidence (cross-realm API hooks delivering a stream,
    // orphaned device anchor, consistent dual-path readback mismatch) is
    // guaranteed tampering and overrides the biological challenges outright.
    const definitiveInjection = audit?.signals.some((s) => s.triggered && s.severity === "definitive") ?? false;
    const injection = r.virtualLabels.length > 0 || r.screenReplay?.verdict === "likely" || audit?.verdict === "injected";
    const pulseGood = estimate.quality === "good";
    // Quick-session verdict: the sustained smile ramp is the primary liveness
    // proof; the pulse SUPPORTS the verdict (findings above) but no longer
    // gates "live" — short well-lit sessions often read weak on genuine skin
    // and that must never block an honest user. Injection evidence still
    // overrides everything.
    let v: LivenessVerdict;
    if (definitiveInjection) v = "not-live";
    else if (injection && (!challengesPassed || !pulseGood)) v = "not-live";
    else if (challengesPassed && !injection) v = "live";
    else v = "inconclusive";
    setVerdict(v);
    setFindings(out);
    setPhaseBoth("done");
    pushLog(
      v === "live" ? "success" : v === "not-live" ? "error" : "warn",
      `Liveness verdict: ${v.toUpperCase()} · challenges ${challengesPassed ? "OK" : "failed"} (${sequenceText}) · pulse ${estimate.bpm ?? "—"} BPM (coherence ${estimate.coherence}, SNR ${estimate.snr}, spectral ${estimate.bpmSpectral ?? "—"}) · injection signals ${injection ? "PRESENT" : "none"}`
    );
    // Post-session identity upgrade: re-run the robust ensemble pipeline
    // (multi-detector + enhanced crop + descriptor ensemble) on the stored
    // identity frame. Runs only after the loop has stopped so it never steals
    // frames from the PPG sampler; the fast in-session descriptor is kept as
    // a fallback if the upgrade fails.
    if (identityRef.current?.canvas) {
      try {
        const upgraded = await describeFaceRobust(identityRef.current.canvas);
        if (upgraded) {
          identityRef.current = { ...identityRef.current, face: upgraded };
          pushLog(
            "debug",
            `Liveness: identity descriptor upgraded \u00b7 ensemble \u00d7${upgraded.variants?.length ?? 1} \u00b7 detector ${upgraded.detector ?? "?"} \u00b7 ${upgraded.enhancement?.join(", ") ?? ""}`
          );
        }
      } catch {
        // best-effort — the fast descriptor already captured is kept
      }
    }
    onResult?.({
      verdict: v,
      findings: out,
      pulse: estimate,
      face: identityRef.current?.face ?? null,
      faceImageUrl: identityRef.current?.url ?? null,
    });
  }, [drawWave, onResult, pushLog, setPhaseBoth, stopAll]);

  /** Returns 0..1 progress toward the current challenge target (absolute OR rise-above-baseline, whichever is closer). */
  const challengeLevel = (c: ChallengeDef, happy: number, baseline: number): number => {
    if (c.kind === "smile") return Math.min(1, Math.max(happy / SMILE_MIN, (happy - baseline) / SMILE_DELTA));
    return Math.min(1, Math.max(happy / SMILE_MORE_MIN, (happy - baseline) / SMILE_MORE_DELTA));
  };

  const challengeMet = (c: ChallengeDef, happy: number, baseline: number): boolean => challengeLevel(c, happy, baseline) >= 1;

  const start = useCallback(async () => {
    setError(null);
    setFindings([]);
    setVerdict(null);
    setPulse(null);
    ppgRef.current = [];
    frameDeltasRef.current = [];
    lastFrameTimeRef.current = 0;
    baselineHappyRef.current = [];
    facePresentRef.current = 0;
    faceSamplesRef.current = 0;
    lastBoxRef.current = null;
    allFacesRef.current = null;
    identityRef.current = null;
    identityAttemptRef.current = 0;
    identityBusyRef.current = false;
    happyEmaRef.current = null;
    missRef.current = 0;
    tickCountRef.current = 0;
    multiChecksRef.current = 0;
    multiHitsRef.current = 0;
    maxFacesRef.current = 0;
    motionRejectsRef.current = 0;
    challengesRef.current = buildChallengeSequence().map((c) => ({ ...c, latencyMs: null }));
    challengeIdxRef.current = 0;
    resultRef.current = { baselineAvg: 0, screenReplay: null, virtualLabels: [], trackLabel: "", heldFrameChecked: false, injectionAudit: null };
    setPhaseBoth("loading");
    pushLog(
      "info",
      `Liveness: starting front camera + loading face models… (quick check: ${challengesRef.current.map((c) => c.short).join(" → ")}, ~7–9s)`
    );
    try {
      const requested: MediaTrackConstraints = videoConstraints ?? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } };
      let feedId = ledgerBeginFeed("Liveness session (front camera — challenge gates + rPPG pulse)", { video: requested, audio: false });
      ledgerFeedIdRef.current = feedId;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: requested, audio: false });
      } catch (gumErr) {
        const name = gumErr instanceof DOMException ? gumErr.name : "";
        if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
          ledgerFeedDenied(feedId, `${name} — over-constrained on this camera; retrying with relaxed (exact→ideal) constraints`);
          pushLog("warn", "Liveness: requested constraints are over-constrained on this camera — retrying with relaxed (exact→ideal) constraints");
          const relaxed = relaxVideoConstraints(requested);
          feedId = ledgerBeginFeed("Liveness session RETRY (relaxed exact→ideal constraints)", { video: relaxed, audio: false });
          ledgerFeedIdRef.current = feedId;
          stream = await navigator.mediaDevices.getUserMedia({ video: relaxed, audio: false });
        } else {
          throw gumErr;
        }
      }
      streamRef.current = stream;
      void ledgerFeedGranted(feedId, stream);
      const video = videoRef.current;
      if (!video) throw new Error("Video element unavailable");
      video.srcObject = stream;
      await video.play();
      ledgerFeedFirstFrame(feedId);

      const track = stream.getVideoTracks()[0];
      const delivered = track?.getSettings?.();
      if (delivered) {
        pushLog(
          "debug",
          `Liveness: stream delivered ${delivered.width ?? "?"}×${delivered.height ?? "?"} @ ${delivered.frameRate ? Math.round(delivered.frameRate) : "?"}fps (aspect ${delivered.width && delivered.height ? (delivered.width / delivered.height).toFixed(2) : "?"})`
        );
      }
      const label = (track?.label ?? "").toLowerCase();
      resultRef.current.trackLabel = track?.label ?? "";
      const labelHits = VIRTUAL_LABEL_MARKERS.filter((m) => labelHasMarker(label, m));
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        for (const d of devices.filter((d) => d.kind === "videoinput")) {
          const dl = d.label.toLowerCase();
          for (const m of VIRTUAL_LABEL_MARKERS) {
            if (labelHasMarker(dl, m) && labelHasMarker(label, m)) labelHits.push(m);
          }
        }
      } catch {
        // enumeration can fail without full permissions — label check above still applies
      }
      resultRef.current.virtualLabels = [...new Set(labelHits)];
      pushLog("debug", `Liveness: camera "${track?.label ?? "?"}" · virtual-cam markers: ${labelHits.length > 0 ? labelHits.join(", ") : "none"}`);

      // Full channel audit: clean-realm API verification, device anchoring and
      // dual-path frame readback — runs in parallel with the challenges.
      void runInjectionAudit({ stream, video, log: (m) => pushLog("debug", `Liveness: ${m}`) })
        .then((a) => {
          resultRef.current.injectionAudit = a;
          pushLog(a.verdict === "clean" ? "debug" : a.verdict === "suspicious" ? "warn" : "error", `Liveness channel audit: ${a.summary}`);
        })
        .catch(() => undefined);

      await loadFaceModels((m) => pushLog("debug", `Liveness: ${m}`));
      if (!scratchRef.current) scratchRef.current = document.createElement("canvas");
      setPhaseBoth("baseline");
      pushLog("info", "Liveness: baseline phase — keep a neutral face (1s)");

      let sampling = false;
      exprTimerRef.current = window.setInterval(() => {
        void (async () => {
          const vid = videoRef.current;
          if (!vid || vid.readyState < 2 || sampling) return;
          sampling = true;
          try {
            const sample = await sampleExpression(vid);
            faceSamplesRef.current += 1;
            tickCountRef.current += 1;
            if (sample) {
              facePresentRef.current += 1;
              const prevBox = lastBoxRef.current;
              motionFlagRef.current = prevBox
                ? Math.abs(sample.box.x - prevBox.x) + Math.abs(sample.box.y - prevBox.y) > sample.box.width * 0.18
                : false;
              lastBoxRef.current = sample.box;
              setFaceSeen(true);
            } else {
              motionFlagRef.current = true;
              setFaceSeen(false);
            }

            // Periodic multi-face scan (coaching/coercion signal) — also feeds
            // the live overlay with every detected face box.
            if (tickCountRef.current % MULTIFACE_EVERY === 0) {
              const all = await detectFaceBoxes(vid, { fast: true });
              if (all) {
                allFacesRef.current = { boxes: all, at: performance.now() };
                multiChecksRef.current += 1;
                if (all.length > 1) {
                  multiHitsRef.current += 1;
                  maxFacesRef.current = Math.max(maxFacesRef.current, all.length);
                }
              }
            }

            drawOverlay(sample?.box ?? null, sample?.detectionScore);

            const now = performance.now();
            const elapsed = now - phaseStartRef.current;
            const p = phaseRef.current;
            if (p === "baseline") {
              if (sample) {
                baselineHappyRef.current.push(sample.happy);
                setSignalLevel(sample.happy);
              }
              setCountdown(Math.max(0, Math.ceil((BASELINE_MS - elapsed) / 1000)));
              if (elapsed >= BASELINE_MS) {
                const arr = baselineHappyRef.current;
                resultRef.current.baselineAvg = arr.length > 0 ? arr.reduce((a, v) => a + v, 0) / arr.length : 0;
                pushLog("debug", `Liveness: baseline happy ${resultRef.current.baselineAvg.toFixed(2)} over ${arr.length} samples`);
                setPhaseBoth("challenge");
                applyChallengeUi();
                pushLog("info", `Liveness: challenge 1 — ${challengesRef.current[0]?.short ?? "?"}`);
              }
            } else if (p === "challenge") {
              const current = challengesRef.current[challengeIdxRef.current];
              if (!current) {
                setPhaseBoth("hold");
              } else {
                const baseline = resultRef.current.baselineAvg;
                if (sample) {
                  happyEmaRef.current = happyEmaRef.current == null ? sample.happy : sample.happy * 0.6 + happyEmaRef.current * 0.4;
                }
                // Use the better of raw vs smoothed — flickery single-frame dips
                // in the expression score must not stall a genuine smile.
                const happy = sample ? Math.max(sample.happy, happyEmaRef.current ?? 0) : 0;
                if (sample) setSignalLevel(challengeLevel(current, happy, baseline));
                if (sample && challengeMet(current, happy, baseline)) {
                  missRef.current = 0;
                  if (sustainStartRef.current == null) sustainStartRef.current = now;
                  if (now - sustainStartRef.current >= SUSTAIN_MS) {
                    current.latencyMs = now - phaseStartRef.current;
                    pushLog("success", `Liveness: "${current.short}" achieved in ${(current.latencyMs / 1000).toFixed(1)}s`);
                    challengeIdxRef.current += 1;
                    phaseStartRef.current = now;
                    sustainStartRef.current = null;
                    if (challengeIdxRef.current >= challengesRef.current.length) {
                      setPhaseBoth("hold");
                      pushLog("info", "Liveness: hold still — reading pulse (a few seconds)");
                    } else {
                      applyChallengeUi();
                      pushLog("info", `Liveness: challenge ${challengeIdxRef.current + 1} — ${challengesRef.current[challengeIdxRef.current].short}`);
                    }
                  }
                } else {
                  missRef.current += 1;
                  if (!sample || missRef.current >= 2) {
                    sustainStartRef.current = null;
                    missRef.current = 0;
                  }
                }
                setCountdown(Math.max(0, Math.ceil((CHALLENGE_TIMEOUT_MS - elapsed) / 1000)));
                if (elapsed >= CHALLENGE_TIMEOUT_MS && current.latencyMs == null) {
                  pushLog("warn", `Liveness: "${current.short}" not achieved within ${CHALLENGE_TIMEOUT_MS / 1000}s`);
                  challengeIdxRef.current += 1;
                  phaseStartRef.current = now;
                  sustainStartRef.current = null;
                  if (challengeIdxRef.current >= challengesRef.current.length) {
                    setPhaseBoth("hold");
                    pushLog("info", "Liveness: hold still — reading pulse (a few seconds)");
                  } else {
                    applyChallengeUi();
                  }
                }
              }
            } else if (p === "hold") {
              if (sample) setSignalLevel(sample.happy);
              setCountdown(Math.max(0, Math.ceil((HOLD_MIN_MS - elapsed) / 1000)));
              if (
                captureIdentity &&
                sample &&
                !identityBusyRef.current &&
                now - identityAttemptRef.current > 1500 &&
                (!identityRef.current || !identityRef.current.face.quality.ok) &&
                vid.videoWidth > 0
              ) {
                identityAttemptRef.current = now;
                identityBusyRef.current = true;
                try {
                  const snap = document.createElement("canvas");
                  const scale = Math.min(1, 720 / vid.videoWidth);
                  snap.width = Math.round(vid.videoWidth * scale);
                  snap.height = Math.round(vid.videoHeight * scale);
                  const sctx = snap.getContext("2d", { willReadFrequently: true });
                  if (sctx) {
                    sctx.drawImage(vid, 0, 0, snap.width, snap.height);
                    const described = await describeFace(snap);
                    if (
                      described &&
                      (!identityRef.current ||
                        (described.quality.ok && !identityRef.current.face.quality.ok) ||
                        (described.quality.ok === identityRef.current.face.quality.ok &&
                          described.detectionScore > identityRef.current.face.detectionScore))
                    ) {
                      identityRef.current = { face: described, url: snap.toDataURL("image/jpeg", 0.85), canvas: snap };
                      pushLog(
                        "debug",
                        `Liveness: identity frame captured · face ${described.quality.boxWidth}px · detection ${described.quality.detectionScore} · quality ${described.quality.ok ? "OK" : described.quality.issues.length + " issue(s)"}`
                      );
                    }
                  }
                } catch {
                  // identity capture is best-effort; the session continues without it
                } finally {
                  identityBusyRef.current = false;
                }
              }
              if (!resultRef.current.heldFrameChecked && elapsed > 1000 && vid.videoWidth > 0) {
                resultRef.current.heldFrameChecked = true;
                const snap = document.createElement("canvas");
                const scale = Math.min(1, 640 / vid.videoWidth);
                snap.width = Math.round(vid.videoWidth * scale);
                snap.height = Math.round(vid.videoHeight * scale);
                const ctx = snap.getContext("2d", { willReadFrequently: true });
                if (ctx) {
                  ctx.drawImage(vid, 0, 0, snap.width, snap.height);
                  const replay = assessScreenReplayFromCanvas(snap);
                  resultRef.current.screenReplay = replay;
                  pushLog(
                    "debug",
                    `Liveness: live-frame screen scan → ${replay.verdict} (lattice ${replay.lattice?.prominence ?? "n/a"}×, banding ${replay.banding?.prominence ?? "n/a"}×)`
                  );
                }
              }
              // Adaptive hold: finish the moment the pulse locks ("good") after
              // the minimum, or at the hard cap — the quick session must not
              // make people stare at the camera for 13 seconds.
              if (elapsed >= HOLD_MIN_MS) {
                const est = estimatePulse(ppgRef.current);
                if (est.quality === "good" || elapsed >= HOLD_MAX_MS) void finish();
              }
            }
          } finally {
            sampling = false;
          }
        })();
      }, 140);

      const rafLoop = (t: number) => {
        const vid = videoRef.current;
        if (vid && vid.readyState >= 2 && scratchRef.current) {
          if (lastFrameTimeRef.current > 0) frameDeltasRef.current.push(t - lastFrameTimeRef.current);
          lastFrameTimeRef.current = t;
          const pp = phaseRef.current;
          // PPG is collected across ALL running phases (motion-gated) — the
          // short adaptive hold only tops up a signal that started at baseline.
          if (pp === "baseline" || pp === "challenge" || pp === "hold") {
            if (motionFlagRef.current) {
              motionRejectsRef.current += 1;
            } else {
              const rgb = sampleForeheadRgb(vid, lastBoxRef.current, scratchRef.current);
              if (rgb) ppgRef.current.push({ t: performance.now(), ...rgb });
            }
          }
        }
        rafRef.current = requestAnimationFrame(rafLoop);
      };
      rafRef.current = requestAnimationFrame(rafLoop);

      pulseTimerRef.current = window.setInterval(() => {
        const pp = phaseRef.current;
        if (pp !== "hold" && pp !== "challenge") return;
        const est = estimatePulse(ppgRef.current);
        setPulse(est);
        drawWave(est.trace);
      }, 1000);
    } catch (err) {
      const info = classifyCameraError(err);
      if (ledgerFeedIdRef.current && !streamRef.current) {
        ledgerFeedDenied(ledgerFeedIdRef.current, `${info.kind}: ${info.message}`);
        ledgerFeedIdRef.current = null;
      }
      setError(info);
      setPhaseBoth("idle");
      stopAll();
      pushLog("error", `Liveness failed to start (${info.kind}): ${info.message}`);
      onStartError?.(info);
    }
  }, [applyChallengeUi, captureIdentity, drawOverlay, drawWave, finish, onStartError, pushLog, setPhaseBoth, stopAll, videoConstraints]);

  // Auto-start once on mount when requested (remount with a new key to re-run).
  const autoStartedRef = useRef<boolean>(false);
  useEffect(() => {
    if (autoStart && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = phase !== "idle" && phase !== "done";

  const promptText =
    phase === "loading"
      ? "Starting camera and loading on-device face models…"
      : phase === "baseline"
        ? "Keep a NEUTRAL face and look at the camera…"
        : phase === "challenge"
          ? challengeLabel
          : phase === "hold"
            ? "Hold still and keep looking at the camera — reading your pulse…"
            : "";

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Quick front-camera check (~7–9s): smile, then smile a bit more — tracked live — then hold still for a few seconds while your
        pulse is read from your skin. Detection boxes are drawn live over every face the detector sees (green = tracked face,
        amber = additional faces). A photo or a paused still cannot produce the responsive smile ramp.
      </p>

      <div
        className={cn("relative overflow-hidden rounded-xl bg-black ring-1 ring-border", centerSquare ? "mx-auto w-full max-w-[340px]" : "")}
        style={{ aspectRatio: centerSquare ? "1 / 1" : "4/3" }}
      >
        <video ref={videoRef} playsInline muted className="h-full w-full -scale-x-100 object-cover" />
        <canvas ref={overlayRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100 object-cover" />
        {running ? (
          <>
            <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent p-3">
              <p className="text-center text-[14px] font-semibold text-white">{promptText}</p>
              {phase !== "loading" ? (
                <p className="mono text-center text-[10px] text-white/70">
                  {phase === "hold"
                    ? `pulse read · ${countdown}s left`
                    : phase === "baseline"
                      ? `baseline · ${countdown}s`
                      : `${challengeProgress} · time left ${countdown}s`}
                </p>
              ) : null}
            </div>
            <div className="absolute inset-x-3 bottom-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-white/80">
                  {phase === "challenge" ? "progress" : "smile"}
                </span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/15">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-150",
                      signalLevel >= 0.95 ? "bg-emerald-400" : signalLevel >= 0.6 ? "bg-lime-400" : "bg-amber-400"
                    )}
                    style={{ width: `${Math.round(Math.min(1, signalLevel) * 100)}%` }}
                  />
                </div>
                <span className="mono w-8 text-right text-[10px] text-white/80">{Math.round(Math.min(1, signalLevel) * 100)}%</span>
              </div>
              {!faceSeen && phase !== "loading" ? (
                <p className="text-center text-[10px] font-medium text-amber-300">No face detected — center your face in the frame</p>
              ) : null}
            </div>
          </>
        ) : null}
        {phase === "idle" ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <HeartPulse className="h-10 w-10 text-white/20" />
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/40 p-2.5">
        <Activity className="h-4 w-4 shrink-0 text-rose-400" />
        <canvas ref={waveRef} width={300} height={54} className="h-[54px] min-w-0 flex-1" />
        <div className="shrink-0 text-right">
          <div className="mono text-lg font-bold leading-none text-rose-300">{pulse?.bpm ?? "—"}</div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">BPM · coh {pulse?.coherence ?? 0} · snr {pulse?.snr ?? 0}</div>
        </div>
      </div>

      {running ? (
        <Button variant="destructive" className="h-11 w-full" onClick={() => finish()}>
          <Square className="mr-2 h-4 w-4" />
          Stop & Evaluate Now
        </Button>
      ) : (
        <Button className="h-12 w-full bg-rose-500 text-rose-950 hover:bg-rose-400" onClick={() => void start()}>
          {phase === "done" ? <Play className="mr-2 h-4 w-4" /> : <HeartPulse className="mr-2 h-4 w-4" />}
          {phase === "done" ? "Run Again" : "Start Liveness + Pulse Check"}
        </Button>
      )}
      {phase === "loading" ? (
        <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          First run downloads ~6 MB of on-device models (cached afterwards).
        </p>
      ) : null}
      {error && !onStartError ? <CameraErrorHelp info={error} onRetry={() => void start()} /> : null}

      {verdict ? (
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-xl border p-3",
            verdict === "live"
              ? "border-emerald-500/40 bg-emerald-500/10"
              : verdict === "not-live"
                ? "border-rose-500/40 bg-rose-500/10"
                : "border-sky-500/40 bg-sky-500/10"
          )}
        >
          {verdict === "not-live" ? (
            <ShieldX className="h-6 w-6 shrink-0 text-rose-400" />
          ) : (
            <ShieldCheck className={cn("h-6 w-6 shrink-0", verdict === "live" ? "text-emerald-400" : "text-sky-400")} />
          )}
          <div>
            <div className={cn("text-[13px] font-bold", verdict === "live" ? "text-emerald-300" : verdict === "not-live" ? "text-rose-300" : "text-sky-300")}>
              {verdict === "live" ? "LIVE PERSON VERIFIED" : verdict === "not-live" ? "NOT LIVE — REPLAY / INJECTION SUSPECTED" : "INCONCLUSIVE — PLEASE REPEAT"}
            </div>
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              {verdict === "live"
                ? "The smile ramp tracked in real time with no replay or injection signals — pulse evidence recorded below."
                : verdict === "not-live"
                  ? "Multiple independent signals point to a replayed or injected feed — see the evidence below."
                  : "Not enough corroborating evidence for a verdict. Improve lighting, hold still during the pulse phase, and repeat — no accusation is made on thin evidence."}
            </p>
          </div>
        </div>
      ) : null}

      {findings.length > 0 ? (
        <div className="space-y-1.5 rounded-xl border border-border/70 bg-black/40 p-2">
          {findings.map((f) => (
            <FindingRow key={f.id} finding={f} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
