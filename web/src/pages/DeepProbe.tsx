import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  Download,
  Fingerprint,
  Hand,
  Images,
  Loader2,
  Minus,
  FileCode,
  FileText,
  FolderOpen,
  ListChecks,
  Package,
  Pause,
  Play,
  Radio,
  ShieldQuestion,
  Square,
  Thermometer,
  X,
} from "lucide-react";

import { CrashBanner } from "@/components/deep-probe/CrashBanner";
import { CAMERA_OPEN_TIMEOUT_MS } from "@/lib/deep-probe/camera-timeout";
import { probeManualShot, type ZoomTarget } from "@/components/deep-probe/ProbeViewfinder";
import { SheetViewer } from "@/components/deep-probe/SheetViewer";
import { Button } from "@/components/ui/button";
import { downloadBlob, formatBytes, makeLog, type LogEntry, type LogLevel } from "@/lib/camera-diagnostics";
import { CaptureCancelledError } from "@/lib/capture-engine";
import { enumerateVideoInputs, type CameraDeviceInfo } from "@/lib/device-camera";
import { fallbackReason, routesNotNeededReason, viewfinderNotAskedReason, zoomNotAskedReason, type AdaptiveSkip, type ManualFacing } from "@/lib/deep-probe/adaptive-manual";
import { runCameraSweep, type CameraMatrixReport, type ProbeCapture } from "@/lib/deep-probe/camera-matrix";
import { runImpossibleProbe, type ImpossibleReport } from "@/lib/deep-probe/impossible-asks";
import { readCaptureFacts, type CaptureFacts } from "@/lib/deep-probe/capture-facts";
import { readShape } from "@/lib/deep-probe/capture-signature";
import { finishTrail, mark, markLeft, setHeldBytes, startTrail, stopHeartbeat, takeCrashReport, type CrashReport } from "@/lib/deep-probe/crash-trail";
import { useExportChoice, type ExportChoice } from "@/lib/deep-probe/export-choice";
import { hexBudgetForDevice, hexTextBytesFor, readMemoryHints } from "@/lib/deep-probe/hex-budget";
import { buildManualShotList, ENGINE_NAME, namedCameraShot, RoutesExhaustedError, runManualShot, UNNAMED_CAMERA_SHOT, type ManualShotSpec } from "@/lib/deep-probe/manual-capture";
import {
  capturePhotoForm,
  claimedExifText,
  CONTRADICTION_PURPOSE,
  contradictionReading,
  pickContradictoryPhoto,
  MULTI_PICK_LIMIT,
  MULTI_PICK_PURPOSE,
  oppositeOf,
  PHOTO_FORM_LABEL,
  pickSeveralPhotos,
  readCameraRequestFinding,
  readCapacitorSelfReport,
  readFacingFromExif,
  readForm,
  type CameraRequestFinding,
  type CapacitorSelfReport,
  type FacingReading,
  type FormReading,
  type PhotoForm,
} from "@/lib/deep-probe/capacitor-pass";
import {
  collectOriginals,
  FACING_LABEL,
  missingOriginalReason,
  ORIGINAL_FACINGS,
  originalKeepSlugs,
  originalsPolicyText,
  type KeptOriginal,
  type OriginalCandidate,
} from "@/lib/deep-probe/originals";
import { collectPassive, type PassiveGroup } from "@/lib/deep-probe/passive";
import {
  OUTCOME_LABEL,
  queryAllPermissions,
  requestsForTier,
  runRequest,
  skippedRecord,
  TIER_INFO,
  TIER_ORDER,
  type PermissionOutcome,
  type PermissionRecord,
  type PermissionTier,
  type ProbeRequest,
} from "@/lib/deep-probe/permissions";
import { buildRawPack, downloadRawPack, type RawPackResult } from "@/lib/deep-probe/raw-pack";
import { PROBE_WIDTH, RUN_MODE_INFO, useRunMode, type RunMode } from "@/lib/deep-probe/run-mode";
import { createStepTimer, expectedMinutes, formatDuration, remainingEstimate, type RemainingEstimate } from "@/lib/deep-probe/run-cost";
import { FACING_LABEL as WIDTH_FACING_LABEL, runWidthProbe, type WidthProbeReport } from "@/lib/deep-probe/width-probe";
import { buildSheets, type RunFacts, type SheetSet, type StageOmission } from "@/lib/deep-probe/sheets";
import {
  recordGenericSensor,
  recordGeolocation,
  recordMicrophoneLevel,
  recordMotion,
  recordOrientation,
  type SensorSeries,
} from "@/lib/deep-probe/sensors";
import { cn } from "@/lib/utils";

type Phase = "setup" | "permissions" | "sensors" | "camera" | "manual" | "exports" | "reading" | "building" | "done";

const STAGES: { phase: Phase; label: string; icon: typeof ShieldQuestion }[] = [
  { phase: "permissions", label: "Permissions", icon: ShieldQuestion },
  { phase: "sensors", label: "Sensors", icon: Radio },
  { phase: "camera", label: "Camera sweep", icon: Camera },
  { phase: "manual", label: "Your shots", icon: Hand },
  { phase: "reading", label: "Sheets", icon: ListChecks },
  { phase: "building", label: "Archive", icon: Package },
];

/** Phases where the run is working through the bytes rather than waiting on you. */
const WORKING: Phase[] = ["exports", "reading", "building"];

/**
 * How a stage ended, once it has ended. A stage that was refused, stopped or
 * failed must not wear the same green tick as one that ran — the strip is the
 * only at-a-glance account of the run's shape, and a uniform row of ticks at
 * the end would misreport a run that skipped half of itself.
 */
type StageMark = "done" | "skipped" | "stopped" | "failed";

const STAGE_MARK_STYLE: Record<StageMark, string> = {
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  skipped: "border-border/60 bg-background/40 text-muted-foreground",
  stopped: "border-amber-500/45 bg-amber-500/10 text-amber-300",
  failed: "border-rose-500/45 bg-rose-500/10 text-rose-300",
};

const STAGE_MARK_ICON: Record<StageMark, typeof Check> = {
  done: Check,
  skipped: Minus,
  stopped: Square,
  failed: X,
};

const STAGE_MARK_TITLE: Record<StageMark, string> = {
  done: "This stage ran.",
  skipped: "This stage never ran, and the sheets say why.",
  stopped: "You stopped before or during this stage.",
  failed: "This stage was attempted and failed. The failure is reported, not hidden.",
};

const COUNTDOWN_SECONDS = 4;
/** How often a paused stage re-checks whether you have resumed. */
const PAUSE_POLL_MS = 200;
/**
 * Source bytes allowed a hex rendering, sized to what this device can actually
 * survive. A hex dump is 4.94 characters per source byte, so this figure is the
 * single biggest lever on peak memory during the build — see `hex-budget.ts`.
 */
const HEX_BUDGET = hexBudgetForDevice(readMemoryHints());

const OUTCOME_STYLE: Record<PermissionOutcome, string> = {
  granted: "border-emerald-500/45 bg-emerald-500/10 text-emerald-300",
  denied: "border-rose-500/45 bg-rose-500/10 text-rose-300",
  dismissed: "border-amber-500/45 bg-amber-500/10 text-amber-200",
  unavailable: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  skipped: "border-border bg-muted/50 text-muted-foreground",
  error: "border-rose-500/45 bg-rose-500/10 text-rose-300",
};

function levelFor(outcome: PermissionOutcome): LogLevel {
  switch (outcome) {
    case "granted":
      return "success";
    case "denied":
    case "error":
      return "warn";
    case "unavailable":
      return "debug";
    default:
      return "info";
  }
}

type ManualStep = {
  id: string;
  kind: "viewfinder" | "camera-app" | "library" | "multi-pick" | "photo-form" | "contradiction";
  title: string;
  purpose: string;
  deviceId: string | null;
  deviceLabel: string;
  zoom: ZoomTarget;
  spec?: ManualShotSpec;
  /** Set on the alternate-form steps only — which of Capacitor's three shapes to ask for. */
  form?: PhotoForm;
};

/**
 * Appends a suspension summary to the session log at build time. Backgrounding is
 * expected during the camera-app handoff, so the archive states plainly that the
 * gaps in the timeline were the page being suspended and that the run continued
 * across them — an unexplained gap would otherwise look like missing evidence.
 */
function suspensionLogs(logs: LogEntry[], suspensions: { phase: Phase; seconds: number; at: string }[]): LogEntry[] {
  if (suspensions.length === 0) return logs;
  const total = suspensions.reduce((sum, s) => sum + s.seconds, 0);
  const longest = suspensions.reduce((max, s) => Math.max(max, s.seconds), 0);
  return [
    ...logs,
    makeLog(
      "debug",
      `This page was suspended ${suspensions.length} time(s) during the run, for ${total.toFixed(1)}s in total (longest ${longest.toFixed(1)}s). That is normal — handing off to the phone's camera app backgrounds the page. Each gap in the timeline above corresponds to one of these, and the run resumed intact every time.`
    ),
  ];
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/50 px-2.5 py-2">
      <div className="mono text-[15px] font-semibold leading-none tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-[9px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
    </div>
  );
}

/** Deep Probe — the maximal-demand run and its raw dump archive. */
export default function DeepProbe() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [tier, setTier] = useState<PermissionTier>("extended");
  const [mode, setMode] = useRunMode();
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [queue, setQueue] = useState<ProbeRequest[]>([]);
  const [index, setIndex] = useState<number>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [firing, setFiring] = useState<boolean>(false);
  const [records, setRecords] = useState<PermissionRecord[]>([]);

  const [sensors, setSensors] = useState<SensorSeries[]>([]);
  const [sensorMessage, setSensorMessage] = useState<string>("");

  const [sweepMessage, setSweepMessage] = useState<string>("");
  const [sweepPct, setSweepPct] = useState<number>(0);
  /**
   * How much longer, from this phone's own step times rather than an average of
   * other phones. Null until there are enough samples for the figure to mean
   * anything, which the page says out loud instead of showing a confident
   * number derived from four steps.
   */
  const [sweepRemaining, setSweepRemaining] = useState<RemainingEstimate | null>(null);
  const [matrix, setMatrix] = useState<CameraMatrixReport | null>(null);
  const [widthProbe, setWidthProbe] = useState<WidthProbeReport | null>(null);
  const [impossible, setImpossible] = useState<ImpossibleReport | null>(null);
  const [thermal, setThermal] = useState<string | null>(null);

  const [manualSteps, setManualSteps] = useState<ManualStep[]>([]);
  const [manualIndex, setManualIndex] = useState<number>(0);
  const [manualBusy, setManualBusy] = useState<boolean>(false);
  const [manualNotes, setManualNotes] = useState<string[]>([]);
  /** Shots the run proved redundant and stopped asking for. */
  const [adaptiveSkips, setAdaptiveSkips] = useState<AdaptiveSkip[]>([]);

  const [buildMessage, setBuildMessage] = useState<string>("");
  const [buildPct, setBuildPct] = useState<number>(0);
  const [pack, setPack] = useState<RawPackResult | null>(null);
  const [sheets, setSheets] = useState<SheetSet | null>(null);
  /** The camera-app files held back from the release, offered as raw downloads. */
  const [originals, setOriginals] = useState<KeptOriginal[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [archiveFatal, setArchiveFatal] = useState<string | null>(null);
  /**
   * Shared with the dashboard card and persisted, so the choice is made on the
   * way in rather than discovered twenty minutes later — and survives the run
   * that kills the tab, which is the run most likely to need it again.
   */
  const [choice, setChoice] = useExportChoice();
  const [crash, setCrash] = useState<CrashReport | null>(null);
  const [stageMarks, setStageMarks] = useState<Partial<Record<Phase, StageMark>>>({});

  const [paused, setPaused] = useState<boolean>(false);
  const [photoCount, setPhotoCount] = useState<number>(0);
  const [byteCount, setByteCount] = useState<number>(0);
  const [elapsed, setElapsed] = useState<number>(0);

  const capturesRef = useRef<ProbeCapture[]>([]);
  /**
   * Which manual shots could become an original, declared as each one lands.
   * Recorded here rather than worked out later from a slug, because the facing
   * and the production path are only known for certain at the moment of capture.
   */
  const originalCandidatesRef = useRef<OriginalCandidate[]>([]);
  const adaptiveSkipsRef = useRef<AdaptiveSkip[]>([]);
  /** The 640-only investigation's report. Null on a full run, which is most runs. */
  const widthProbeRef = useRef<WidthProbeReport | null>(null);
  const impossibleRef = useRef<ImpossibleReport | null>(null);
  const passiveRef = useRef<PassiveGroup[]>([]);
  const statesBeforeRef = useRef<{ name: string; state: string | null }[]>([]);
  const statesAfterRef = useRef<{ name: string; state: string | null }[]>([]);
  /**
   * `enumerateDevices()` before a single permission has been requested. This is
   * the only moment the genuinely pre-grant state is observable, so it is taken
   * here rather than reconstructed later from the camera sweep's own snapshots.
   */
  const devicesBeforeRef = useRef<{ kind: string; deviceId: string; groupId: string; label: string }[]>([]);
  const omissionsRef = useRef<StageOmission[]>([]);
  const startedAtRef = useRef<string>("");
  const startedMsRef = useRef<number>(0);
  /** Stage boundaries, so the cost section is a measurement rather than a guess. */
  const stageCostsRef = useRef<{ stage: string; ms: number }[]>([]);
  const stageClockRef = useRef<number | null>(null);
  /**
   * The untouched original the alternate forms are measured against, taken
   * before Capacitor could rewrite anything. Null when the interception missed,
   * which the readings then state rather than estimate around.
   */
  const formBaselineRef = useRef<{ bytes: number; mime: string; hasExif: boolean } | null>(null);
  const formReadingsRef = useRef<FormReading[]>([]);
  /** What the camera itself said about the shot that named no camera. */
  const unnamedFacingRef = useRef<FacingReading | null>(null);
  /** Everything Capacitor will say about itself, read once and kept. */
  const capacitorReportRef = useRef<CapacitorSelfReport | null>(null);
  /** Whether this phone honours a page's request for a particular camera. */
  const cameraRequestRef = useRef<CameraRequestFinding | null>(null);
  const abortRef = useRef<boolean>(false);
  const pausedRef = useRef<boolean>(false);
  const suspensionsRef = useRef<{ phase: Phase; seconds: number; at: string }[]>([]);
  const ranRef = useRef<Set<string>>(new Set());
  const factsRef = useRef<CaptureFacts[]>([]);
  const sheetsRef = useRef<SheetSet | null>(null);
  const finishedAtRef = useRef<string>("");
  const choiceRef = useRef<ExportChoice>(choice);
  const tickerRef = useRef<HTMLDivElement | null>(null);

  const addLog = useCallback((level: LogLevel, message: string): void => {
    setLogs((prev) => [...prev.slice(-299), makeLog(level, message)]);
  }, []);

  const markStage = useCallback((stage: Phase, mark: StageMark): void => {
    setStageMarks((prev) => (prev[stage] ? prev : { ...prev, [stage]: mark }));
  }, []);

  /**
   * Wall clock per stage, closed as each stage hands over. Measured rather than
   * estimated: a run that describes its own cost from a constant is making a
   * claim it never took a reading for.
   */
  const closeStageCost = useCallback((stage: string): void => {
    const now = performance.now();
    const from = stageClockRef.current;
    stageClockRef.current = now;
    if (from == null) return;
    stageCostsRef.current.push({ stage, ms: Math.max(0, Math.round(now - from)) });
  }, []);

  /**
   * The one door out of the gathering stages.
   *
   * Three routes used to jump straight to the archive builder instead — a
   * refused camera, a stop during the sensors, a stop during the sweep. The
   * builder cannot run at that point because the sheets it copies in have not
   * been written, so all three dead-ended on an error card and the export
   * choice was never shown. Every exit now comes through here, and it is
   * idempotent so a stage that notices the abort after the fact cannot drag the
   * run backwards out of a later phase.
   */
  const toExports = useCallback((...extra: StageOmission[]): void => {
    if (ranRef.current.has("exports")) return;
    ranRef.current.add("exports");
    for (const omission of extra) omissionsRef.current.push(omission);
    if (finishedAtRef.current === "") finishedAtRef.current = new Date().toISOString();
    setPhase("exports");
  }, []);

  useEffect(() => {
    tickerRef.current?.scrollTo({ top: tickerRef.current.scrollHeight, behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    choiceRef.current = choice;
  }, [choice]);

  /**
   * Reads whatever the last run left behind, once, on arrival.
   *
   * A tab killed by the operating system runs no handler and writes no console
   * line, so the only way to learn anything about the death is to read the notes
   * the run left on disk before it happened. `pagehide` marks an ordinary
   * departure, which is how a deliberate reload is told apart from a kill.
   */
  useEffect(() => {
    setCrash(takeCrashReport());
    const onHide = (): void => markLeft();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      stopHeartbeat();
    };
  }, []);

  /** Everything the run gathered, in the shape both the sheets and the archive read. */
  const runFacts = useCallback(
    (): RunFacts => ({
      startedAt: startedAtRef.current,
      finishedAt: finishedAtRef.current || new Date().toISOString(),
      tier,
      permissions: records,
      passive: passiveRef.current,
      permissionStatesBefore: statesBeforeRef.current,
      permissionStatesAfter: statesAfterRef.current.length > 0 ? statesAfterRef.current : statesBeforeRef.current,
      sensors,
      matrix,
      widthProbe: widthProbeRef.current,
      impossible: impossibleRef.current,
      logs: suspensionLogs(logs, suspensionsRef.current),
      omissions: omissionsRef.current,
      devicesBeforePermission: devicesBeforeRef.current,
      capacitor:
        capacitorReportRef.current || formReadingsRef.current.length > 0 || cameraRequestRef.current
          ? { selfReport: capacitorReportRef.current, cameraRequest: cameraRequestRef.current, forms: formReadingsRef.current }
          : null,
      cost: {
        totalMs: Math.max(0, performance.now() - startedMsRef.current),
        stages: stageCostsRef.current.map((entry) => ({ stage: entry.stage, ms: entry.ms })),
        cameras: matrix?.cameraCosts ?? [],
        slowestStep: matrix?.slowestStep ?? null,
        cameraDeadlineMs: CAMERA_OPEN_TIMEOUT_MS,
        perCameraBudgetMs: matrix?.perCameraBudgetMs ?? null,
      },
    }),
    [tier, records, sensors, matrix, logs]
  );

  /* ---------------- elapsed clock ---------------- */
  useEffect(() => {
    if (phase === "setup" || phase === "done") return;
    const id = window.setInterval(() => setElapsed(Math.round((performance.now() - startedMsRef.current) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  /**
   * Awaited at every stage boundary. A pause therefore always lands between
   * steps, never inside one — a half-recorded sensor window or a half-applied
   * camera constraint would produce a row describing a paused device rather
   * than the setting under test.
   */
  const waitWhilePaused = useCallback(async (): Promise<void> => {
    while (pausedRef.current && !abortRef.current) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, PAUSE_POLL_MS));
    }
  }, []);

  const togglePause = useCallback((): void => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    addLog(
      "info",
      next
        ? "Paused. The current step finishes, then nothing further starts until you resume — pausing mid-step would leave a reading that describes a paused device."
        : "Resumed."
    );
  }, [addLog]);

  /**
   * Stage four hands off to the phone's camera app, which backgrounds this page
   * — an entirely normal occurrence. Each suspension is timed and logged so the
   * archive shows the run continued across it rather than leaving an unexplained
   * gap in the timeline.
   */
  useEffect(() => {
    if (phase === "setup" || phase === "done") return;
    let hiddenAt = 0;
    const onVisibility = (): void => {
      if (document.hidden) {
        hiddenAt = performance.now();
        return;
      }
      if (hiddenAt === 0) return;
      const seconds = Math.round((performance.now() - hiddenAt) / 100) / 10;
      hiddenAt = 0;
      suspensionsRef.current.push({ phase, seconds, at: new Date().toISOString() });
      addLog("debug", `The page was in the background for ${seconds}s during the ${phase} stage and resumed with the run intact. Nothing was lost.`);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [phase, addLog]);

  /* ---------------- thermal / pressure watch ---------------- */
  useEffect(() => {
    if (phase !== "camera") return;
    type PressureRecord = { state: string; source: string };
    type PressureObserverCtor = new (cb: (records: PressureRecord[]) => void) => { observe: (source: string) => Promise<void>; disconnect: () => void };
    const Ctor = (window as unknown as { PressureObserver?: PressureObserverCtor }).PressureObserver;
    if (!Ctor) return;
    const observer = new Ctor((entries) => {
      const latest = entries[entries.length - 1];
      if (!latest) return;
      if (latest.state === "serious" || latest.state === "critical") {
        setThermal(
          `Your device reports "${latest.state}" processor pressure. That is a load reading, not a temperature — but a long camera sweep is a plausible cause. You can carry on or stop and keep everything gathered so far.`
        );
      } else {
        setThermal(null);
      }
    });
    void observer.observe("cpu").catch(() => undefined);
    return () => observer.disconnect();
  }, [phase]);

  /* ---------------- start ---------------- */
  const start = useCallback(async (): Promise<void> => {
    startedAtRef.current = new Date().toISOString();
    startedMsRef.current = performance.now();
    abortRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    ranRef.current = new Set();
    capturesRef.current = [];
    omissionsRef.current = [];
    suspensionsRef.current = [];
    factsRef.current = [];
    sheetsRef.current = null;
    finishedAtRef.current = "";
    setStageMarks({});
    setSheets(null);
    setPack(null);
    setFatal(null);
    setArchiveFatal(null);
    setRecords([]);
    setSensors([]);
    setLogs([]);
    setPhotoCount(0);
    setByteCount(0);
    widthProbeRef.current = null;
    impossibleRef.current = null;
    setImpossible(null);
    addLog(
      "info",
      mode === "width-640"
        ? `Deep Probe started in the ${PROBE_WIDTH}-only mode. One constraint per camera — a plain width — and nothing else.`
        : mode === "impossible"
          ? "Deep Probe started in the impossible-asks mode. Each side of the phone is asked for things no camera can do, and how it refuses is the whole reading. No photograph is taken anywhere in this run."
          : `Deep Probe started at the ${TIER_INFO[tier].label} scope.`
    );
    addLog("debug", "Reading everything available without a prompt first, so the passive baseline predates every request.");
    statesBeforeRef.current = await queryAllPermissions();
    try {
      const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      devicesBeforeRef.current = devices.map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId ?? "", label: d.label ?? "" }));
      const named = devicesBeforeRef.current.filter((d) => d.label !== "").length;
      addLog(
        "debug",
        `enumerateDevices() before any prompt: ${devicesBeforeRef.current.length} device(s), ${named} of them named. Blank labels here are the privacy rule working, not a fault.`
      );
    } catch {
      devicesBeforeRef.current = [];
    }
    passiveRef.current = await collectPassive();
    const total = passiveRef.current.reduce((sum, g) => sum + g.rows.length, 0);
    addLog("warn", `${total} facts were readable with no prompt, no indicator and no way to decline.`);
    // The 640-only mode has one thing to ask for. Walking the whole permission
    // tier to reach a camera would make a one-minute run cost twenty prompts,
    // and every one of them would be answering a question this mode never asks.
    const requests = mode === "full" ? requestsForTier(tier) : requestsForTier("standard").filter((r) => r.id === "camera");
    if (mode !== "full") {
      addLog("debug", "Only the camera is requested in this mode. The other permissions are not refused and not skipped by you — they are simply not part of the question being asked, and the omissions list says so.");
    }
    setQueue(requests);
    setIndex(0);
    setPhase("permissions");
  }, [addLog, tier, mode]);

  /* ---------------- stage one: permissions ---------------- */
  const fire = useCallback(
    async (request: ProbeRequest): Promise<void> => {
      setCountdown(null);
      setFiring(true);
      addLog("info", `Asking for ${request.label} — ${request.api}`);
      const record = await runRequest(request);
      setRecords((prev) => [...prev, record]);
      addLog(levelFor(record.outcome), `${request.label}: ${OUTCOME_LABEL[record.outcome]}. ${record.detail}`);
      setFiring(false);
      setIndex((i) => i + 1);
    },
    [addLog]
  );

  const skip = useCallback(
    (request: ProbeRequest): void => {
      setCountdown(null);
      setRecords((prev) => [...prev, skippedRecord(request)]);
      addLog("info", `${request.label}: skipped before it fired — nothing was asked.`);
      setIndex((i) => i + 1);
    },
    [addLog]
  );

  const current = phase === "permissions" ? queue[index] : undefined;

  useEffect(() => {
    if (phase !== "permissions" || !current || firing) return;
    if (current.needsGesture) {
      setCountdown(null);
      return;
    }
    let remaining = COUNTDOWN_SECONDS;
    setCountdown(remaining);
    const id = window.setInterval(() => {
      // Hold while the page is hidden or you have paused, so a prompt never fires
      // where you cannot see it or have asked it not to.
      if (document.hidden || pausedRef.current) return;
      remaining -= 1;
      setCountdown(remaining);
      if (remaining <= 0) {
        window.clearInterval(id);
        void fire(current);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, current, firing, fire]);

  useEffect(() => {
    if (phase !== "permissions" || queue.length === 0 || index < queue.length) return;
    void (async () => {
      statesAfterRef.current = await queryAllPermissions();
      addLog("success", "Every request at this scope has been made. Nothing was retried.");
      markStage("permissions", "done");
      setPhase("sensors");
    })();
  }, [phase, index, queue.length, addLog, markStage]);

  /* ---------------- stage two: sensors ---------------- */
  const grantedIds = useMemo(() => new Set(records.filter((r) => r.outcome === "granted").map((r) => r.id)), [records]);

  useEffect(() => {
    if (phase !== "sensors" || ranRef.current.has("sensors")) return;
    ranRef.current.add("sensors");
    void (async () => {
      // The short modes ask one question each, and ask it of the camera.
      // Recording sensors here would be collecting data nobody asked for, so
      // the stage is named as deliberately absent rather than left to look
      // like a failure.
      if (mode !== "full") {
        const which = mode === "width-640" ? `the ${PROBE_WIDTH}-only investigation` : "the impossible-asks run";
        addLog("debug", `Sensor recordings are not part of ${which}, so the stage was not run. Nothing was refused and nothing failed.`);
        omissionsRef.current.push({
          stage: "Sensor recordings",
          reason: `This run was ${which}, which asks its question of the two cameras and nothing of the sensors. The stage was deliberately not run — it was not refused, and it did not fail. A full run records every granted sensor.`,
        });
        markStage("sensors", "skipped");
        setPhase("camera");
        return;
      }
      const collected: SensorSeries[] = [];
      const push = (series: SensorSeries): void => {
        collected.push(series);
        setSensors([...collected]);
        addLog(series.rows.length > 0 ? "success" : "warn", `${series.label}: ${series.note}`);
      };

      const stopped = (): boolean => abortRef.current;
      const planned: { id: string; message: string; run: () => Promise<SensorSeries> }[] = [];

      if (grantedIds.has("motion")) {
        planned.push({
          id: "motion",
          message: "Recording motion — hold the phone naturally, or move it around.",
          run: () => recordMotion(5000, setSensorMessage, stopped),
        });
      }
      if (grantedIds.has("orientation")) {
        planned.push({
          id: "orientation",
          message: "Recording orientation and compass — try tilting the phone.",
          run: () => recordOrientation(5000, setSensorMessage, stopped),
        });
      }
      if (grantedIds.has("geolocation")) {
        planned.push({
          id: "geolocation",
          message: "Watching your location until the accuracy figure settles.",
          run: () => recordGeolocation(25000, setSensorMessage, stopped),
        });
      }
      if (grantedIds.has("microphone")) {
        planned.push({
          id: "microphone",
          message: "Sampling microphone loudness — no audio is recorded, only the level.",
          run: () => recordMicrophoneLevel(4000, setSensorMessage, stopped),
        });
      }
      if (grantedIds.has("ambient-light")) {
        planned.push({
          id: "ambient-light",
          message: "Sampling ambient light.",
          run: () => recordGenericSensor("AmbientLightSensor", "Ambient light", ["lux"], 10, 4000, setSensorMessage, stopped),
        });
      }
      if (grantedIds.has("magnetometer")) {
        planned.push({
          id: "magnetometer",
          message: "Sampling the magnetic field.",
          run: () => recordGenericSensor("Magnetometer", "Magnetometer", ["x_ut", "y_ut", "z_ut"], 10, 4000, setSensorMessage, stopped),
        });
      }

      for (const item of planned) {
        await waitWhilePaused();
        if (abortRef.current) break;
        setSensorMessage(item.message);
        push(await item.run());
      }

      setSensorMessage("");

      if (abortRef.current) {
        const remaining = planned.length - collected.length;
        if (remaining > 0) {
          omissionsRef.current.push({
            stage: "Sensor recordings (partially)",
            reason: `You stopped the run. ${remaining} recording(s) never started. The ones that did are real, and any window cut short says so in its own note rather than scaling its rate up to the window that was planned.`,
          });
        }
        ranRef.current.add("camera");
        markStage("sensors", "stopped");
        markStage("camera", "stopped");
        markStage("manual", "stopped");
        toExports({ stage: "Camera sweep and manual shots", reason: "You stopped the run before these stages." });
        return;
      }

      if (collected.length === 0) {
        addLog("info", "No sensor recordings ran, because nothing that produces a time series was granted. Recorded as such, not as a failure.");
        omissionsRef.current.push({
          stage: "Sensor recordings",
          reason: "Nothing that produces a time series was granted, so there was nothing to record. This is a consequence of the permission answers, not a fault.",
        });
      }
      markStage("sensors", collected.length === 0 ? "skipped" : "done");
      setPhase("camera");
    })();
  }, [phase, grantedIds, addLog, waitWhilePaused, markStage, toExports, mode]);

  /* ---------------- stage three: camera sweep ---------------- */
  useEffect(() => {
    if (phase !== "camera" || ranRef.current.has("camera")) return;
    ranRef.current.add("camera");
    void (async () => {
      if (!grantedIds.has("camera")) {
        addLog(
          "warn",
          "Camera permission was not granted, so neither camera stage can run. No camera claim appears anywhere in the sheets. Everything already gathered — the permission answers, the passive facts and the sensor recordings — is still yours, and you choose what to do with it next."
        );
        markStage("camera", "skipped");
        markStage("manual", "skipped");
        toExports({
          stage: "Camera sweep and manual shots",
          reason: "Camera permission was not granted. The sweep does not re-prompt after a refusal, so both camera stages were skipped entirely.",
        });
        return;
      }

      // The 640-only investigation replaces the sweep entirely. It asks the
      // opposite kind of question — one bare width, no device pinned — so it
      // cannot be a subset of the sweep and is not run as one.
      if (mode === "width-640") {
        addLog("info", `Asking each camera for ${PROBE_WIDTH} wide, and nothing else. Two opens, and the phone decides everything else on your behalf.`);
        const probe = await runWidthProbe({
          onProgress: (message, done, total) => {
            setSweepMessage(message);
            setSweepPct(Math.min(99, Math.round((done / Math.max(total, 1)) * 100)));
          },
          onCapture: (capture) => {
            capturesRef.current.push(capture);
            setPhotoCount(capturesRef.current.length);
            setByteCount((b) => b + capture.blob.size);
          },
          shouldAbort: () => abortRef.current,
          waitWhilePaused,
        });
        capturesRef.current = [...capturesRef.current];
        widthProbeRef.current = probe;
        setWidthProbe(probe);
        setSweepPct(100);
        setSweepMessage("");
        for (const row of probe.rows) addLog(row.ok ? "success" : "warn", `${WIDTH_FACING_LABEL[row.facing]}: ${row.reading}`);
        markStage("camera", probe.aborted ? "stopped" : probe.rows.length === 0 ? "skipped" : "done");
        markStage("manual", "skipped");
        omissionsRef.current.push({
          stage: "Camera sweep and your own shots",
          reason: `This run was the ${PROBE_WIDTH}-only investigation. It opens each camera once with a bare width and records what the phone chose, which is a different question from the sweep's — the sweep pins a device and states both dimensions to map a RANGE, this sends one number to find the DEFAULT. Neither the full sweep nor the manual shot list was run, and neither was refused or failed. A full run does both.`,
        });
        if (probe.aborted) {
          toExports({ stage: `The ${PROBE_WIDTH}-only investigation (partially)`, reason: "You stopped before both cameras had been asked. The rows recorded really ran; the remaining facing was never attempted." });
        } else {
          toExports();
        }
        return;
      }

      // The impossible-asks run replaces both camera stages. It photographs
      // nothing at all: every ask in it is designed to be unanswerable, and
      // what is being measured is the shape of the refusal.
      if (mode === "impossible") {
        addLog("info", "Asking each side of this phone for things no camera can do. Not one photograph is taken here — a refusal is the reading.");
        const probe = await runImpossibleProbe({
          scope: "full",
          onProgress: (message, done, total) => {
            setSweepMessage(message);
            setSweepPct(Math.min(99, Math.round((done / Math.max(total, 1)) * 100)));
          },
          shouldAbort: () => abortRef.current,
          waitWhilePaused,
        });
        impossibleRef.current = probe;
        setImpossible(probe);
        setSweepPct(100);
        setSweepMessage("");
        const refused = probe.answers.filter((answer) => answer.outcome === "refused").length;
        const granted = probe.answers.filter((answer) => answer.outcome === "granted").length;
        addLog(
          "success",
          `${probe.answers.length} impossible ask(s) sent in ${formatDuration(probe.durationMs)}: ${refused} refused, ${granted} granted. A refusal is the informative answer here, not a failure.`
        );
        for (const note of probe.notes) addLog("info", note);
        for (const observation of probe.observations) addLog("warn", observation);
        if (probe.observations.length === 0 && probe.answers.length > 0) {
          addLog("debug", "Nothing in this round contradicted anything else in it. That is an observation about what was seen, not a pass mark.");
        }
        markStage("camera", probe.aborted ? "stopped" : probe.answers.length === 0 ? "skipped" : "done");
        markStage("manual", "skipped");
        omissionsRef.current.push({
          stage: "Camera sweep, your own shots, and every photograph",
          reason:
            "This run was the impossible-asks mode, which asks each side of the phone for things no camera can do and records how it refuses. It photographs nothing on purpose — the sweep, the hand-shot list and every capture are absent by design, not refused and not failed. A full run does all three.",
        });
        if (probe.aborted) {
          toExports({ stage: "The impossible asks (partially)", reason: "You stopped before the battery had finished. Every answer recorded really happened; the asks that never ran are absent, and none of them is recorded as a refusal." });
        } else {
          toExports();
        }
        return;
      }

      addLog("info", "Camera sweep starting — every camera, at the sizes, ratios, frame rates and control modes it says it supports. Rungs above a camera's own stated ceiling are not asked for, apart from one deliberate over-ask.");
      // The bar and the clock are both fed the real plan. Step times come from
      // this phone, measured between progress callbacks, so the remaining
      // figure is never an average of other devices.
      const sweepTimer = createStepTimer();
      let lastTick = performance.now();
      const { report, captures } = await runCameraSweep({
        onProgress: (message, done, total, totalIsExact) => {
          const now = performance.now();
          if (done > 0) sweepTimer.record(now - lastTick);
          lastTick = now;
          setSweepMessage(message);
          setSweepPct(Math.min(99, Math.round((done / Math.max(total, 1)) * 100)));
          setSweepRemaining(remainingEstimate(done, total, sweepTimer, totalIsExact === true));
        },
        onCapture: (capture) => {
          capturesRef.current.push(capture);
          setPhotoCount(capturesRef.current.length);
          setByteCount((b) => b + capture.blob.size);
        },
        shouldAbort: () => abortRef.current,
        waitWhilePaused,
      });
      capturesRef.current = [...capturesRef.current];
      setMatrix(report);
      if (report.stillsStoppedForMemory) {
        addLog("warn", report.stillsStoppedForMemory);
        omissionsRef.current.push({
          stage: "Camera sweep stills (later rows)",
          reason: report.stillsStoppedForMemory,
        });
      }
      setSweepPct(100);
      setSweepMessage("");
      setSweepRemaining(null);
      const granted = report.rows.filter((r) => r.ok).length;
      addLog(
        "success",
        `Sweep finished in ${formatDuration(report.durationMs)}: ${granted} of ${report.rows.length} requests granted across ${report.inventory.length} camera(s), ${captures.length} photos taken.`
      );
      if (report.impossible.length > 0) {
        const refusedImpossible = report.impossible.filter((answer) => answer.outcome === "refused").length;
        const grantedImpossible = report.impossible.filter((answer) => answer.outcome === "granted").length;
        addLog(
          "info",
          `${report.impossible.length} impossible ask(s) were sent alongside the sweep: ${refusedImpossible} refused, ${grantedImpossible} granted. Refusing correctly — the right error, naming the right setting, in the right time — is the part of a camera that is hardest to imitate.`
        );
        for (const observation of report.impossibleObservations) addLog("warn", observation);
      }
      if (report.untried.length > 0) {
        const budgeted = report.cameraCosts.filter((cost) => cost.hitBudget);
        for (const cost of budgeted) {
          addLog("warn", `${cost.label} used its full ${formatDuration(report.perCameraBudgetMs ?? 0)} share and stopped with ${cost.untried} request(s) untried.`);
        }
        addLog(
          "info",
          `${report.untried.length} request(s) are recorded as UNTRIED — never asked, so nothing is known about them. That is not a refusal, not a limit any camera stated and not a timeout; all three exist separately in the sheets.`
        );
        omissionsRef.current.push({
          stage: "Camera sweep (some requests)",
          reason: `${report.untried.length} request(s) were never made, because their camera reached its ${formatDuration(report.perCameraBudgetMs ?? 0)} share of the run's time first. Each one is listed by name in the camera matrix as UNTRIED. Nothing is inferred about what they would have returned — untried is not a refusal, not a stated limit and not a timeout.`,
        });
      }
      if (report.slowestStep) {
        addLog("debug", `Slowest single request: ${formatDuration(report.slowestStep.ms)} — ${report.slowestStep.label}.`);
      }
      if (report.rows.length > granted) {
        addLog("debug", `${report.rows.length - granted} requests were refused. Those are results — they map where the hardware's limits actually are.`);
      }

      if (abortRef.current) {
        markStage("camera", "stopped");
        markStage("manual", "stopped");
        toExports(
          { stage: "Camera sweep (partially)", reason: "You stopped the sweep early. Every row recorded really ran; the remainder never started." },
          { stage: "Your own shots", reason: "You stopped during the sweep, so the manual shot list never began." }
        );
        return;
      }

      markStage("camera", "done");
      closeStageCost("Camera sweep");
      const inventory = await enumerateVideoInputs();
      const manual = buildManualSteps(inventory, report);
      setManualSteps(manual.steps);
      if (manual.skips.length > 0) {
        // Recorded before the stage starts, because these were decided by rows
        // the sweep already produced rather than by anything the user did.
        adaptiveSkipsRef.current.push(...manual.skips);
        setAdaptiveSkips([...adaptiveSkipsRef.current]);
        addLog("info", `${manual.skips.length} zoom shot(s) are not on the list: the sweep already watched those cameras refuse to zoom.`);
      }

      // Everything Capacitor will say about itself, read once and for nothing:
      // no prompt, no picker, no camera. Its opinion about your permissions is
      // its own and can disagree with the browser's, which is worth having.
      const selfReport = await readCapacitorSelfReport(statesAfterRef.current.length > 0 ? statesAfterRef.current : statesBeforeRef.current);
      capacitorReportRef.current = selfReport;
      for (const note of selfReport.notes) addLog("info", note);
      for (const error of selfReport.errors) addLog("debug", error);
      for (const pair of selfReport.permissions) {
        if (pair.disagreement) addLog("warn", pair.disagreement);
      }

      setManualIndex(0);
      setPhase("manual");
    })();
  }, [phase, grantedIds, addLog, waitWhilePaused, markStage, toExports, mode, closeStageCost]);

  /* ---------------- stage four: manual shots ---------------- */
  const manualStep = phase === "manual" ? manualSteps[manualIndex] : undefined;

  const takeManual = useCallback(async (): Promise<void> => {
    const step = manualSteps[manualIndex];
    if (!step) return;

    /**
     * Drops shots the run has just PROVED redundant. Only ever touches steps
     * ahead of the current one, so a shot already taken can never be rewritten
     * as one that was skipped.
     */
    const dropAhead = (predicate: (candidate: ManualStep) => boolean, reason: string): void => {
      const doomed = manualSteps.filter((candidate, i) => i > manualIndex && predicate(candidate));
      if (doomed.length === 0) return;
      const doomedIds = new Set(doomed.map((candidate) => candidate.id));
      adaptiveSkipsRef.current.push(...doomed.map((candidate) => ({ stepId: candidate.id, title: candidate.title, reason })));
      setAdaptiveSkips([...adaptiveSkipsRef.current]);
      setManualSteps((prev) => prev.filter((candidate) => !doomedIds.has(candidate.id)));
      setManualNotes((prev) => [...prev, `${doomed.length} shot(s) not asked for — ${doomed.map((candidate) => candidate.title).join(", ")}. ${reason}`]);
      addLog("info", `Dropped ${doomed.length} remaining shot(s). ${reason}`);
    };

    setManualBusy(true);
    try {
      if (step.kind === "viewfinder") {
        const shot = await probeManualShot({ deviceId: step.deviceId, deviceLabel: step.deviceLabel, purpose: step.purpose, zoom: step.zoom });
        const capture: ProbeCapture = {
          slug: `manual-${String(manualIndex + 1).padStart(2, "0")}-${step.id}`,
          label: `${step.title} — ${step.deviceLabel}`,
          blob: shot.blob,
          origin: shot.origin,
          stage: "manual",
          deviceLabel: step.deviceLabel,
          path: shot.path,
          width: shot.width,
          height: shot.height,
          fileName: null,
          fileLastModified: null,
          fileRelativePath: null,
          asked: `manual shot, ${step.zoom ? `zoom ${step.zoom}` : "default zoom"}`,
          granted: shot.granted + (shot.zoomNote ? ` · ${shot.zoomNote}` : ""),
          takenAt: new Date().toISOString(),
        };
        capturesRef.current.push(capture);
        setPhotoCount(capturesRef.current.length);
        setByteCount((b) => b + shot.blob.size);
        addLog("success", `${step.title}: ${shot.width}×${shot.height}, ${formatBytes(shot.blob.size)} via ${shot.path === "image-capture" ? "the platform photo pipeline" : "a canvas encode by this app"}.`);
        if (shot.zoomNote) addLog("debug", shot.zoomNote);
      } else if (step.kind === "multi-pick") {
        // The one request in the run that returns several files from a single
        // trip. Every one is filed as a library pick, however rich its
        // metadata: "came from a camera at some point" is not "taken just now".
        const picked = await pickSeveralPhotos();
        for (const photo of picked) {
          const capture: ProbeCapture = {
            slug: `manual-${String(manualIndex + 1).padStart(2, "0")}-pick-${String(photo.index + 1).padStart(2, "0")}`,
            label: `${step.title} — photo ${photo.index + 1} of ${picked.length}`,
            blob: photo.blob,
            origin: "supplied-file",
            stage: "manual",
            deviceLabel: null,
            path: "picker-file",
            width: 0,
            height: 0,
            fileName: photo.fileName,
            fileLastModified: null,
            fileRelativePath: null,
            asked: `Capacitor multi-pick, limit ${MULTI_PICK_LIMIT}, quality 100, no orientation correction — a library pick, never a fresh photo`,
            granted: `${photo.blob.size.toLocaleString("en-US")} bytes, type "${photo.blob.type || "(none declared)"}", format "${photo.format ?? "(not stated)"}". ${claimedExifText(photo.claimedExif)}`,
            takenAt: new Date().toISOString(),
          };
          capturesRef.current.push(capture);
          setByteCount((b) => b + photo.blob.size);
        }
        setPhotoCount(capturesRef.current.length);
        addLog(
          "success",
          `${picked.length} photo(s) came back from ONE picker trip — nothing else in this run can do that. Every one is filed as a library pick and none is offered as a photo taken just now.`
        );
        if (picked.length < MULTI_PICK_LIMIT) {
          addLog(
            "info",
            `You picked ${picked.length} of the ${MULTI_PICK_LIMIT} this asked for. That is recorded as what you chose, not as anything failing — fewer photos simply means a smaller sample of how metadata varies on this phone.`
          );
        }
      } else if (step.kind === "contradiction") {
        // One request naming the library and the back camera at once. Whatever
        // comes back is filed as a SUPPLIED FILE: a self-contradicting request
        // cannot promise whether the picker or the camera opened, and claiming
        // freshness would invent the answer this step exists to look for.
        const delivered = await pickContradictoryPhoto();
        const bytes = new Uint8Array(await delivered.blob.arrayBuffer());
        const hasExif = !readFacingFromExif(bytes).evidence.includes("no EXIF at all");
        const reading = contradictionReading(delivered.blob.size, delivered.blob.type, hasExif);
        const capture: ProbeCapture = {
          slug: `manual-${String(manualIndex + 1).padStart(2, "0")}-${step.id}`,
          label: step.title,
          blob: delivered.blob,
          origin: "supplied-file",
          stage: "manual",
          deviceLabel: null,
          path: "picker-file",
          width: 0,
          height: 0,
          fileName: delivered.fileName,
          fileLastModified: null,
          fileRelativePath: null,
          asked: `Capacitor getPhoto — ${delivered.asked}. Quality 100, no editing, no orientation correction, nothing saved to your gallery.`,
          granted: `${reading} ${claimedExifText(delivered.claimedExif)}`,
          takenAt: new Date().toISOString(),
        };
        capturesRef.current.push(capture);
        setPhotoCount(capturesRef.current.length);
        setByteCount((b) => b + delivered.blob.size);
        setManualNotes((prev) => [...prev, `${step.title}: ${reading}`]);
        addLog("info", `${step.title}: ${reading}`);
      } else if (step.kind === "photo-form" && step.form) {
        const form = step.form;
        const delivered = await capturePhotoForm(form, "library");
        const bytes = new Uint8Array(await delivered.blob.arrayBuffer());
        const hasExif = readFacingFromExif(bytes).evidence.includes("no EXIF at all") === false;
        const baseline = formBaselineRef.current;
        const reading = readForm(form, { bytes: delivered.blob.size, mime: delivered.declaredMime, hasExif }, baseline);
        formReadingsRef.current.push(reading);
        const capture: ProbeCapture = {
          slug: `manual-${String(manualIndex + 1).padStart(2, "0")}-${step.id}`,
          label: step.title,
          blob: delivered.blob,
          origin: "supplied-file",
          stage: "manual",
          deviceLabel: null,
          path: "picker-file",
          width: 0,
          height: 0,
          fileName: null,
          fileLastModified: null,
          fileRelativePath: null,
          asked: `Capacitor getPhoto, resultType ${PHOTO_FORM_LABEL[form]}, quality 100, no editing, no orientation correction, nothing saved to your gallery`,
          granted: `${reading.reading} ${claimedExifText(delivered.claimedExif)}`,
          takenAt: new Date().toISOString(),
        };
        capturesRef.current.push(capture);
        setPhotoCount(capturesRef.current.length);
        setByteCount((b) => b + delivered.blob.size);
        setManualNotes((prev) => [...prev, `${step.title}: ${reading.reading}`]);
        addLog(reading.identical === false ? "warn" : "success", `${step.title}: ${reading.reading}`);
      } else if (step.spec) {
        const spec = step.spec;
        const result = await runManualShot(spec, (engine, at, total) => {
          if (at === 0) return;
          // A second camera opening with no explanation reads as a bug rather
          // than as a fallback, so the run says which route it is about to try.
          setManualNotes((prev) => [...prev, `${step.title} — route ${at + 1} of ${total}: ${ENGINE_NAME[String(engine)] ?? engine}.`]);
          addLog("info", `${step.title}: the previous route produced nothing, so this side is being offered ${ENGINE_NAME[String(engine)] ?? engine} instead. Each side needs one file and keeps trying until it has one.`);
        });
        const isLibrary = result.path === "picker-file";
        const capture: ProbeCapture = {
          slug: `manual-${String(manualIndex + 1).padStart(2, "0")}-${step.id}`,
          label: step.title,
          blob: result.file,
          origin: result.origin,
          stage: "manual",
          deviceLabel: null,
          path: result.path,
          width: 0,
          height: 0,
          fileName: result.file.name,
          fileLastModified: result.file.lastModified,
          fileRelativePath: result.file.webkitRelativePath ?? "",
          asked: isLibrary
            ? `${spec.engine}, no capture attribute, accept="${spec.accept ?? "image/*"}" — a library pick, not a fresh photo`
            : `${result.engine}, facing ${spec.facing ?? "unspecified"} · routes offered: ${result.attempts.map((a) => `${a.engine} (${a.outcome})`).join(" → ")}`,
          granted: `file "${result.file.name}", type "${result.file.type || "(none declared)"}", ${result.file.size.toLocaleString("en-US")} bytes, last modified ${new Date(result.file.lastModified).toISOString()}${result.changeIsTrusted === undefined ? "" : ` · change event trusted: ${result.changeIsTrusted}`}`,
          takenAt: new Date().toISOString(),
        };
        capturesRef.current.push(capture);

        // The camera's own word on which side fired, read from the file rather
        // than taken from the request. Reading it back out of the request would
        // make the whole measurement circular.
        let readFacing: FacingReading | null = null;
        if (!isLibrary) {
          readFacing = readFacingFromExif(new Uint8Array(await result.file.arrayBuffer()));
          addLog(readFacing.side === "unknown" ? "warn" : "info", `${step.title}: ${readFacing.evidence}`);
          if (result.interceptedOriginal === false) {
            addLog(
              "warn",
              `${step.title}: the original File could not be intercepted before Capacitor rewrote it, so these bytes are Capacitor's copy and the name and timestamp are synthesised. Labelled as a rebuilt copy rather than passed off as the original.`
            );
          }
          // The untouched original the alternate forms are measured against.
          if (formBaselineRef.current == null) {
            formBaselineRef.current = { bytes: result.file.size, mime: result.file.type, hasExif: readFacing.side !== "unknown" || !readFacing.evidence.includes("no EXIF at all") };
          }
        }

        // Declared here, where the facing and the production path are both known
        // for certain. A library pick never qualifies, however rich its metadata.
        // The unnamed shot's side comes from the FILE, so an ignored request can
        // never file a front photo as a back one.
        const settledFacing: ManualFacing | null = spec.facing ?? (readFacing?.side === "unknown" ? null : (readFacing?.side ?? null));
        if (!isLibrary && settledFacing != null) {
          originalCandidatesRef.current.push({ slug: capture.slug, facing: settledFacing, path: capture.path, origin: capture.origin });
        }

        // The second camera shot is built here, from what the first one turned
        // out to be, and inserted directly after it.
        if (spec.id === UNNAMED_CAMERA_SHOT.id && readFacing) {
          unnamedFacingRef.current = readFacing;
          const next = oppositeOf(readFacing);
          const because =
            readFacing.side === "unknown"
              ? `The shot that named no camera does not say which one took it — ${readFacing.evidence} So the front is asked for here, because a phone that ignores the request opens the back, which makes the front the ask most likely to reveal it.`
              : `The shot that named no camera turned out to be the ${readFacing.side === "user" ? "front" : "back"} one — ${readFacing.evidence}`;
          const nextSpec = namedCameraShot(next, because);
          const nextStep: ManualStep = {
            id: nextSpec.id,
            kind: "camera-app",
            title: `Camera app — ${next === "environment" ? "back" : "front"} camera, named this time`,
            purpose: nextSpec.purpose,
            deviceId: null,
            deviceLabel: "the phone's own camera app",
            zoom: null,
            spec: nextSpec,
          };
          setManualSteps((prev) => (prev.some((candidate) => candidate.id === nextStep.id) ? prev : [...prev.slice(0, manualIndex + 1), nextStep, ...prev.slice(manualIndex + 1)]));
          addLog("info", because);
        }

        // Both camera shots are in: say whether the request was honoured.
        if (spec.facing != null && readFacing && unnamedFacingRef.current && cameraRequestRef.current == null) {
          const finding = readCameraRequestFinding(unnamedFacingRef.current, spec.facing, readFacing);
          cameraRequestRef.current = finding;
          setManualNotes((prev) => [...prev, finding.verdict]);
          addLog(finding.honoured === "no" ? "warn" : finding.honoured === "yes" ? "success" : "info", finding.verdict);
          // Both shots landed on the same camera, so one side of the phone has
          // no original. The missing side is offered once more down the plain
          // path — a different pipeline, which is the only thing left to try —
          // and the ignored request stays on the record as the finding it is.
          if (finding.honoured === "no") {
            const missing = spec.facing;
            const retryId = `camera-app-${missing}-plain-retry`;
            const retryStep: ManualStep = {
              id: retryId,
              kind: "camera-app",
              title: `Camera app — ${missing === "environment" ? "back" : "front"} camera, one more try down a different path`,
              purpose:
                `Both shots so far have come back from the same camera, so this phone has given you two of one side and none of the other. ${finding.verdict} ` +
                `This asks once more, down the plain capture attribute instead of Capacitor — a genuinely different pipeline, and the only thing left to try. ` +
                `If it comes back from the same camera again, that is the answer and the run stops asking: the missing side is recorded as missing, with the reason, and nothing is substituted for it.`,
              deviceId: null,
              deviceLabel: "the phone's own camera app",
              zoom: null,
              spec: {
                id: retryId,
                engine: "native-camera",
                routes: ["native-camera", "capture-boolean"],
                facing: missing,
                source: "camera-app",
                purpose: "",
              },
            };
            setManualSteps((prev) => (prev.some((candidate) => candidate.id === retryId) ? prev : [...prev.slice(0, manualIndex + 1), retryStep, ...prev.slice(manualIndex + 1)]));
            addLog("info", `The ${missing === "environment" ? "back" : "front"} side has no original yet, so it is offered once more down a different pipeline. One retry, not a loop.`);
            omissionsRef.current.push({
              stage: `Camera app — the ${missing === "environment" ? "back" : "front"} camera original`,
              reason: finding.verdict,
            });
          }
        }
        // Each side needs exactly one file the camera itself wrote, and it now
        // has one. The routes that were never opened are recorded as spares
        // that went unused, which is a different thing from a shot skipped.
        if (!isLibrary && settledFacing != null) {
          const facing: ManualFacing = settledFacing;
          const tried = new Set(result.attempts.map((attempt) => String(attempt.engine)));
          const unused = spec.routes.map((engine) => String(engine)).filter((engine) => !tried.has(engine));
          if (unused.length > 0) {
            const reason = routesNotNeededReason(facing, String(result.engine), unused);
            adaptiveSkipsRef.current.push(
              ...unused.map((engine) => ({
                stepId: `${step.id}-route-${engine}`,
                title: `${step.title} — spare route ${ENGINE_NAME[engine] ?? engine}`,
                reason,
              }))
            );
            setAdaptiveSkips([...adaptiveSkipsRef.current]);
          }
          if (result.attempts.length > 1) {
            const note = fallbackReason(facing, result.attempts);
            setManualNotes((prev) => [...prev, note]);
            addLog("warn", note);
          }
        }
        setPhotoCount(capturesRef.current.length);
        setByteCount((b) => b + result.file.size);
        addLog(
          "success",
          isLibrary
            ? `${step.title}: "${result.file.name}", type "${result.file.type || "none declared"}", ${formatBytes(result.file.size)}. Filed as a library pick — the metadata is whatever was already on it, and nothing here treats it as a photo taken just now.`
            : `${step.title}: "${result.file.name}", ${formatBytes(result.file.size)} — a real camera file, so it should carry the camera's own metadata.`
        );
      }
    } catch (err) {
      if (err instanceof RoutesExhaustedError) {
        // Every route for this side was offered and none produced a file. That
        // is reported route by route, because "the camera app failed" and "you
        // closed it three times" are different facts about this device.
        const facing = step.spec?.facing;
        const note = facing != null ? fallbackReason(facing, err.attempts) : err.message;
        setManualNotes((prev) => [...prev, note]);
        addLog(err.cancelledEverywhere ? "info" : "warn", note);
        for (const attempt of err.attempts) {
          addLog("debug", `${step.title} · ${ENGINE_NAME[String(attempt.engine)] ?? attempt.engine}: ${attempt.outcome} — ${attempt.detail}`);
        }
      } else if (err instanceof CaptureCancelledError) {
        setManualNotes((prev) => [...prev, `${step.title} — skipped.`]);
        addLog("info", `${step.title}: skipped. Recorded as a skip, not as a photo.`);
      } else {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        setManualNotes((prev) => [...prev, `${step.title} — failed: ${message}`]);
        addLog("warn", `${step.title}: ${message}`);
      }
    } finally {
      setManualBusy(false);
      setManualIndex((i) => i + 1);
    }
  }, [manualSteps, manualIndex, addLog]);

  const skipManual = useCallback((): void => {
    const step = manualSteps[manualIndex];
    if (step) {
      setManualNotes((prev) => [...prev, `${step.title} — skipped.`]);
      addLog("info", `${step.title}: skipped.`);
    }
    setManualIndex((i) => i + 1);
  }, [manualSteps, manualIndex, addLog]);

  useEffect(() => {
    if (phase !== "manual" || manualSteps.length === 0 || manualIndex < manualSteps.length) return;
    addLog("success", "Manual shots finished.");
    if (cameraRequestRef.current == null) {
      omissionsRef.current.push({
        stage: "Whether this phone honours a camera request",
        reason:
          "Both camera-app shots were needed to answer this and both did not complete, so it is recorded as unmeasured. One shot on its own cannot tell an honoured request from an ignored one, and guessing between them from a single file would be an inference dressed up as a measurement.",
      });
    }
    markStage("manual", "done");
    closeStageCost("Your own shots");
    toExports();
  }, [phase, manualIndex, manualSteps.length, addLog, markStage, toExports, closeStageCost]);

  /* ---------------- stage five: the facts, then the sheets ---------------- */
  useEffect(() => {
    if (phase !== "reading" || ranRef.current.has("reading")) return;
    ranRef.current.add("reading");
    const wants = choiceRef.current;
    void (async () => {
      const captureCount = capturesRef.current.length;
      const captureBytes = capturesRef.current.reduce((sum, capture) => sum + capture.blob.size, 0);
      startTrail({
        scope: TIER_INFO[tier].label,
        captures: captureCount,
        captureMegabytes: Math.round(captureBytes / 1024 / 1024),
        archiveRequested: wants.archive,
        hexBudgetMegabytes: Math.round(HEX_BUDGET / 1024 / 1024),
        userAgent: navigator.userAgent.slice(0, 120),
      });
      setHeldBytes(captureBytes);
      try {
        addLog(
          "info",
          wants.archive
            ? `Reading the facts of ${captureCount} capture(s). The bytes are kept because you asked for the archive.`
            : `Reading the facts of ${captureCount} capture(s). Each photo's bytes are released the moment its facts are read, so nothing large is held while the sheets are written.`
        );
        mark(`Reading the facts of ${captureCount} capture(s), ${Math.round(captureBytes / 1024 / 1024)} MB`);
        // Two files survive the release whatever else happens: the back and
        // front camera-app originals. They are the only bytes in the run the
        // CAMERA wrote, and dropping them to save a few megabytes would throw
        // away the most valuable evidence of the lot.
        const keepSlugs = originalKeepSlugs(originalCandidatesRef.current);
        const result = await readCaptureFacts(capturesRef.current, {
          release: !wants.archive,
          keepSlugs,
          onProgress: (message, done, total) => {
            setBuildMessage(message);
            setBuildPct(Math.min(96, Math.round((done / Math.max(total, 1)) * 100)));
          },
          onStep: mark,
          onHeldBytes: (bytes) => {
            setHeldBytes(bytes);
            setByteCount(bytes);
          },
        });
        factsRef.current = result.facts;
        for (const warning of result.warnings) addLog("warn", warning);
        addLog(
          "success",
          `Read ${result.facts.length} capture(s), ${formatBytes(result.bytesRead)} walked. Control went back to the browser ${result.yields} time(s) during the pass, which is what keeps the page answering instead of being killed for going quiet.`
        );
        const keptOriginals = collectOriginals(result.kept, originalCandidatesRef.current);
        setOriginals(keptOriginals);
        if (result.released) {
          addLog(
            "info",
            keptOriginals.length > 0
              ? `The photo bytes have been released apart from ${keptOriginals.length} camera original(s), ${formatBytes(result.keptBytes)} in total. No archive can be built from this run — that is the trade you chose — but the camera's own files are still here and are offered below.`
              : "The photo bytes have been released. No archive can be built from this run — that is the trade you chose, and it is why the memory figure above is now zero."
          );
        }
        addLog(keptOriginals.length > 0 ? "success" : "info", originalsPolicyText(keptOriginals, result.released));
        for (const facing of ORIGINAL_FACINGS) {
          if (!keptOriginals.some((o) => o.facing === facing)) addLog("warn", missingOriginalReason(facing));
        }

        mark("Writing the sheets");
        setBuildMessage("Writing the sheets");
        const built = buildSheets(runFacts(), result.facts);
        sheetsRef.current = built;
        setSheets(built);
        setBuildPct(100);
        setBuildMessage("");
        addLog(
          "success",
          `Sheets ready: the full stat sheet, the forensic item list, the correlation brief and the device spec. None of them needed an archive, and you have them now rather than after one.`
        );

        markStage("reading", "done");
        if (wants.archive) {
          setPhase("building");
          return;
        }
        finishTrail("complete");
        setPhase("done");
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        setFatal(message);
        addLog("error", `The facts could not be read: ${message}`);
        markStage("reading", "failed");
        markStage("building", "failed");
        finishTrail("failed", message);
        setPhase("done");
      }
    })();
  }, [phase, tier, runFacts, addLog, markStage]);

  /* ---------------- stage six: the archive, only if asked for ---------------- */
  useEffect(() => {
    if (phase !== "building" || ranRef.current.has("building")) return;
    ranRef.current.add("building");
    const sheetSet = sheetsRef.current;
    void (async () => {
      if (!sheetSet) {
        setArchiveFatal("The sheets were not written, so there is nothing for the archive to copy in. This is a bug, and the run is reported as it is rather than patched over.");
        markStage("building", "failed");
        finishTrail("failed", "sheets missing at archive time");
        setPhase("done");
        return;
      }
      try {
        addLog("info", `Assembling the archive from ${capturesRef.current.length} capture(s).`);
        mark(`Starting the archive from ${capturesRef.current.length} capture(s)`);
        const result = await buildRawPack(
          { ...runFacts(), captures: capturesRef.current, hexBudgetBytes: HEX_BUDGET },
          factsRef.current,
          sheetSet,
          {
            onProgress: (message, done, total) => {
              setBuildMessage(message);
              setBuildPct(Math.min(99, Math.round((done / Math.max(total, 1)) * 100)));
            },
            onStep: mark,
          }
        );
        setBuildPct(100);
        setBuildMessage("");
        setPack(result);
        const failed = result.verification.filter((v) => !v.ok).length;
        addLog(
          failed === 0 ? "success" : "error",
          failed === 0
            ? `Archive built: ${result.files} files, ${formatBytes(result.bytes)}. Every capture was carved back out of the finished archive and matched byte-for-byte.`
            : `Archive built, but ${failed} capture(s) failed the byte-identity re-check. That failure is reported, not hidden.`
        );
        for (const warning of result.warnings) addLog("warn", warning);
        markStage("building", "done");
        finishTrail("complete");
        setPhase("done");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setArchiveFatal(message);
        addLog("error", `The archive could not be built: ${message} — the sheets above are unaffected and already yours.`);
        markStage("building", "failed");
        finishTrail("failed", message);
        setPhase("done");
      }
    })();
  }, [phase, runFacts, addLog, markStage]);

  /**
   * Stop, from any stage.
   *
   * Two stages act on the flag rather than on this handler: the sensor loop and
   * the camera sweep both check it between steps, so that a recording or a
   * constraint under test is never cut in half and reported as if it were a
   * complete reading. Both then route through `toExports` themselves. The
   * stages that sit idle waiting for you — the permission queue and your own
   * shots — have nothing to finish, so they leave immediately.
   */
  const stopEverything = useCallback((): void => {
    abortRef.current = true;
    pausedRef.current = false;
    setPaused(false);
    finishedAtRef.current = new Date().toISOString();
    if (phase === "permissions") {
      addLog("warn", "Stopping. Everything gathered so far is kept, and every sheet will be labelled partial.");
      for (const request of queue.slice(index)) setRecords((prev) => [...prev, skippedRecord(request)]);
      omissionsRef.current.push({ stage: "Remaining permission requests", reason: "You stopped the run. The requests that had not yet fired are listed as skipped." });
      ranRef.current.add("sensors");
      ranRef.current.add("camera");
      markStage("permissions", "stopped");
      markStage("sensors", "stopped");
      markStage("camera", "stopped");
      markStage("manual", "stopped");
      toExports({ stage: "Sensor recordings, camera sweep and manual shots", reason: "You stopped the run before these stages." });
      return;
    }
    if (phase === "manual") {
      addLog("warn", "Stopping. Everything gathered so far is kept, and every sheet will be labelled partial.");
      markStage("manual", "stopped");
      toExports({ stage: "Remaining manual shots", reason: "You stopped the run. The shots not yet taken were never attempted." });
      return;
    }
    addLog(
      "warn",
      "Stopping. The step in progress finishes on its own — cutting one in half would leave a reading that describes an interrupted device rather than a real one — and then you go straight to your choices. Everything gathered is kept and labelled partial."
    );
  }, [phase, queue, index, addLog, markStage, toExports]);

  /** Saves one derived text file. Nothing here needs the archive to exist. */
  const saveText = useCallback((text: string, fileName: string, mime: string): void => {
    downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), fileName);
  }, []);

  const counters = (
    <div className="grid grid-cols-4 gap-1.5">
      <Counter label="Answered" value={String(records.filter((r) => r.outcome !== "skipped").length)} />
      <Counter label="Photos" value={String(photoCount)} />
      <Counter label="Held" value={formatBytes(byteCount)} />
      <Counter label="Elapsed" value={`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`} />
    </div>
  );

  /**
   * The archive step only appears in the stepper when it was asked for. Showing
   * a stage that will never run would misreport the shape of the run.
   */
  const stages = useMemo(() => STAGES.filter((stage) => stage.phase !== "building" || choice.archive), [choice.archive]);

  const ticker = (
    <div className="diag-card overflow-hidden">
      <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Live ticker</div>
      <div ref={tickerRef} className="mono max-h-44 space-y-0.5 overflow-y-auto p-2.5 text-[10.5px] leading-relaxed">
        {logs.length === 0 ? <div className="text-muted-foreground">Nothing yet.</div> : null}
        {logs.map((l) => (
          <div key={l.id} className={`log-${l.level}`}>
            <span className="text-muted-foreground">{l.ts}</span> {l.message}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="mx-auto min-h-dvh max-w-lg px-3 pb-10 pt-4 sm:px-4">
      <header className="mb-3 flex items-center gap-2">
        <Link to="/" className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-card text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fuchsia-400">Deep Probe</p>
          <h1 className="truncate text-[15px] font-semibold leading-tight">Maximum-demand run</h1>
        </div>
        {phase !== "setup" && phase !== "done" && !WORKING.includes(phase) ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={togglePause}
              aria-label={paused ? "Resume the run" : "Pause the run"}
              className={cn(
                "flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-[11px] font-semibold active:scale-95",
                paused ? "border-amber-500/50 bg-amber-500/15 text-amber-200" : "border-border/70 bg-card text-muted-foreground"
              )}
            >
              {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              onClick={stopEverything}
              className="flex items-center gap-1.5 rounded-xl border border-rose-500/45 bg-rose-500/10 px-2.5 py-2 text-[11px] font-semibold text-rose-300 active:scale-95"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          </div>
        ) : null}
      </header>

      {phase !== "setup" ? (
        <div className="mb-3 flex items-center gap-1">
          {stages.map((stage) => {
            const order = stages.findIndex((s) => s.phase === (phase === "exports" ? "reading" : phase));
            const mine = stages.findIndex((s) => s.phase === stage.phase);
            // A recorded mark always wins. Position alone cannot tell a stage
            // that ran from one that was refused or stopped, and at the end of a
            // run every stage is behind the pointer — which is how a skipped
            // stage used to end up wearing a green tick.
            const mark = stageMarks[stage.phase];
            const active = mine === order && mark === undefined;
            const Icon = mark ? STAGE_MARK_ICON[mark] : stage.icon;
            return (
              <div
                key={stage.phase}
                title={mark ? STAGE_MARK_TITLE[mark] : undefined}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 rounded-xl border px-1 py-2 transition-colors",
                  mark
                    ? STAGE_MARK_STYLE[mark]
                    : active
                      ? "border-fuchsia-500/50 bg-fuchsia-500/12 text-fuchsia-300"
                      : "border-border/60 bg-background/40 text-muted-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="text-[8.5px] font-semibold uppercase tracking-wide">{stage.label}</span>
                {mark && mark !== "done" ? (
                  <span className="text-[7.5px] font-semibold uppercase tracking-wide opacity-80">{mark}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {crash ? (
        <div className="mb-3">
          <CrashBanner report={crash} onDismiss={() => setCrash(null)} />
        </div>
      ) : null}

      {phase === "setup" ? (
        <Setup mode={mode} setMode={setMode} tier={tier} setTier={setTier} choice={choice} setChoice={setChoice} onStart={() => void start()} />
      ) : null}

      {phase === "permissions" ? (
        <div className="space-y-3">
          {counters}
          {current ? (
            <div className="diag-card overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3.5 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Request {index + 1} of {queue.length}
                </span>
                <span className={cn("rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase", OUTCOME_STYLE.unavailable)}>{TIER_INFO[current.tier].label}</span>
              </div>
              <div className="space-y-3 p-3.5">
                <div>
                  <h2 className="text-[17px] font-semibold leading-tight">{current.label}</h2>
                  <p className="mono mt-1 text-[10px] text-muted-foreground">{current.api}</p>
                </div>
                <div className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-3 text-[11.5px] leading-relaxed">
                  <p>
                    <span className="font-semibold text-foreground">If you allow it, the site can reach: </span>
                    <span className="text-muted-foreground">{current.reaches}</span>
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">The grant lasts: </span>
                    <span className="text-muted-foreground">{current.duration}</span>
                  </p>
                </div>

                {firing ? (
                  <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Waiting for your answer…
                  </div>
                ) : current.needsGesture ? (
                  <div className="space-y-2">
                    <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200">
                      This one needs a fresh tap. {current.gestureReason ?? "The browser will not show the prompt from a timer."}
                    </p>
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <Button className="h-12 bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" onClick={() => void fire(current)}>
                        Ask for {current.label}
                        <ChevronRight className="ml-1 h-4 w-4" />
                      </Button>
                      <Button variant="outline" className="h-12" onClick={() => skip(current)}>
                        Skip
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <Button className="h-12 bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" onClick={() => void fire(current)}>
                      {countdown != null && countdown > 0 ? `Asking in ${countdown}…` : "Ask now"}
                    </Button>
                    <Button variant="outline" className="h-12" onClick={() => skip(current)}>
                      Skip
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : null}
          <ResultList records={records} />
          {ticker}
        </div>
      ) : null}

      {phase === "sensors" ? (
        <div className="space-y-3">
          {counters}
          <div className="diag-card p-3.5">
            <h2 className="section-title">Recording the sensors you granted</h2>
            <p className="section-sub mt-1">
              A grant on its own proves very little. Each recording below reports the rate actually measured, not the rate requested — the two
              usually differ, and quoting the request back would be repeating an intention as if it were a reading.
            </p>
            {paused ? (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/45 bg-amber-500/10 p-2.5 text-[11.5px] leading-relaxed text-amber-200">
                <Pause className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Paused. The recording in progress finishes on its own — cutting one off midway would leave a rate that describes a paused phone rather than a real one. Nothing further starts until you resume.</span>
              </div>
            ) : sensorMessage ? (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/10 p-2.5 text-[12px] text-fuchsia-200">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                {sensorMessage}
              </div>
            ) : null}
            <div className="mt-3 space-y-2">
              {sensors.map((s) => (
                <div key={s.id} className="rounded-xl border border-border/60 bg-background/40 p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-semibold">{s.label}</span>
                    <span className="mono text-[10px] text-muted-foreground">
                      {s.rows.length} samples · {s.measuredHz != null ? `${s.measuredHz} Hz` : "rate not determinable"}
                    </span>
                  </div>
                  <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">{s.note}</p>
                </div>
              ))}
              {sensors.length === 0 && !sensorMessage ? (
                <p className="text-[11.5px] text-muted-foreground">Nothing granted produces a time series, so this stage has nothing to record.</p>
              ) : null}
            </div>
          </div>
          {ticker}
        </div>
      ) : null}

      {phase === "camera" ? (
        <div className="space-y-3">
          {counters}
          {thermal ? (
            <div className="flex items-start gap-2 rounded-2xl border border-amber-500/45 bg-amber-500/10 p-3 text-[11.5px] leading-relaxed text-amber-200">
              <Thermometer className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{thermal}</span>
            </div>
          ) : null}
          <div className="diag-card p-3.5">
            <h2 className="section-title">Camera sweep</h2>
            <p className="section-sub mt-1">
              Every camera, at its native maximum and down the whole ladder, in every aspect ratio, frame rate and control mode it advertises. A
              refusal is a result — it marks where the hardware's limit actually is.
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300",
                  paused ? "bg-amber-400/70" : "bg-gradient-to-r from-fuchsia-500 to-cyan-400"
                )}
                style={{ width: `${sweepPct}%` }}
              />
            </div>
            <div className="mono mt-2 flex items-baseline justify-between gap-3 text-[10.5px] text-muted-foreground">
              <span>{sweepPct}% of the plan</span>
              <span className={cn(sweepRemaining?.confident ? "text-cyan-300" : undefined)}>
                {formatDuration(elapsed * 1000)} in · {sweepRemaining ? sweepRemaining.text : "too early to say"}
              </span>
            </div>
            <p className="mono mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">{sweepMessage || "Starting…"}</p>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              The bar is the real plan, not a guess — each camera contributes its exact step count once it has stated its own limits, control steps
              included. The time left comes from how long this phone&rsquo;s steps have actually been taking; until there are enough of them it says so
              rather than showing a confident number.
            </p>
            {paused ? (
              <p className="mt-2 flex items-start gap-2 rounded-xl border border-amber-500/45 bg-amber-500/10 p-2.5 text-[11.5px] leading-relaxed text-amber-200">
                <Pause className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Paused between steps. The step above completes, then the sweep holds — pausing mid-step would record a camera that was paused rather than the setting being tested.</span>
              </p>
            ) : null}
          </div>
          {ticker}
        </div>
      ) : null}

      {phase === "manual" ? (
        <div className="space-y-3">
          {counters}
          {manualStep ? (
            <div className="diag-card overflow-hidden">
              <div className="border-b border-border/60 px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Shot {manualIndex + 1} of {manualSteps.length}
              </div>
              <div className="space-y-3 p-3.5">
                <h2 className="text-[16px] font-semibold leading-tight">{manualStep.title}</h2>
                <p className="text-[11.5px] leading-relaxed text-muted-foreground">{manualStep.purpose}</p>
                {paused ? (
                  <p className="flex items-start gap-2 rounded-xl border border-amber-500/45 bg-amber-500/10 p-2.5 text-[11.5px] leading-relaxed text-amber-200">
                    <Pause className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Paused. This stage waits for you anyway — take your time, and resume when you are ready.</span>
                  </p>
                ) : null}
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <Button
                    disabled={manualBusy || paused}
                    className="h-12 bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400"
                    onClick={() => void takeManual()}
                  >
                    {manualBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : manualStep.kind === "library" || manualStep.kind === "multi-pick" || manualStep.kind === "photo-form" ? (
                      <Images className="mr-1.5 h-4 w-4" />
                    ) : (
                      <Camera className="mr-1.5 h-4 w-4" />
                    )}
                    {manualBusy
                      ? ""
                      : manualStep.kind === "multi-pick"
                        ? `Pick up to ${MULTI_PICK_LIMIT}`
                        : manualStep.kind === "photo-form"
                          ? "Pick the same one"
                          : manualStep.kind === "library"
                            ? "Pick one"
                            : "Take it"}
                  </Button>
                  <Button variant="outline" disabled={manualBusy || paused} className="h-12" onClick={skipManual}>
                    Skip
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          {adaptiveSkips.length > 0 ? (
            <div className="diag-card overflow-hidden">
              <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {adaptiveSkips.length} shot{adaptiveSkips.length === 1 ? "" : "s"} you were not asked for
              </div>
              <div className="divide-y divide-border/50">
                {adaptiveSkips.map((skip) => (
                  <div key={skip.stepId} className="px-3 py-2">
                    <div className="text-[11.5px] font-semibold">{skip.title}</div>
                    <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">{skip.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {manualNotes.length > 0 ? (
            <div className="diag-card p-3 text-[11px] leading-relaxed text-muted-foreground">
              {manualNotes.map((note) => (
                <div key={note}>· {note}</div>
              ))}
            </div>
          ) : null}
          {ticker}
        </div>
      ) : null}

      {phase === "exports" ? (
        <div className="space-y-3">
          {counters}
          <ExportChoicePanel
            choice={choice}
            setChoice={setChoice}
            photoCount={photoCount}
            byteCount={byteCount}
            omissions={omissionsRef.current}
            onGo={() => {
              addLog(
                "info",
                choice.archive
                  ? "Archive ticked. The photo bytes are kept, so this run will use the memory the archive needs."
                  : "Archive not ticked. The photo bytes will be released as they are read, and no archive can be made from this run afterwards."
              );
              setBuildPct(0);
              setPhase("reading");
            }}
          />
          {ticker}
        </div>
      ) : null}

      {phase === "reading" || phase === "building" ? (
        <div className="space-y-3">
          {counters}
          <div className="diag-card p-3.5">
            <h2 className="section-title">{phase === "reading" ? "Reading the photos and writing the sheets" : "Building the archive"}</h2>
            <p className="section-sub mt-1">
              {phase === "reading"
                ? "One walk over each photo produces its checksums, its encoder signature, its metadata directories and its structure. Control goes back to the browser as it goes, so this page keeps answering instead of being killed for going quiet."
                : "Every capture is copied in untouched and stored uncompressed, then carved back out of the finished archive and compared byte-for-byte — the claim is checked, not asserted."}
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 transition-[width] duration-300" style={{ width: `${buildPct}%` }} />
            </div>
            <p className="mono mt-2 text-[10.5px] text-muted-foreground">{buildMessage || "…"}</p>
            {phase === "building" ? (
              <p className="mt-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-2.5 text-[10.5px] leading-relaxed text-emerald-200">
                Every sheet is already written and waiting below. If this step fails, you keep all of it.
              </p>
            ) : null}
          </div>
          {ticker}
        </div>
      ) : null}

      {phase === "done" ? (
        <div className="space-y-3">
          {counters}
          {fatal ? (
            <div className="diag-card border-rose-500/45 p-3.5">
              <div className="flex items-start gap-2 text-rose-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <h2 className="text-[14px] font-semibold">The photos could not be read</h2>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-rose-200/90">{fatal}</p>
                </div>
              </div>
            </div>
          ) : null}

          {sheets ? (
            <div className="diag-card p-3.5">
              <h2 className="section-title">Your sheets are ready</h2>
              <p className="section-sub mt-1">
                {photoCount} photo(s) read · {records.filter((r) => r.outcome !== "skipped").length} request(s) answered
                {sheets.partial ? " · labelled PARTIAL, with every missing stage named inside" : " · every stage ran"}
              </p>
              {choice.sheet ? (
                <>
                  <Button
                    className="mt-3 h-12 w-full bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400"
                    onClick={() => saveText(sheets.statSheetHtml, sheets.fileNames.statHtml, "text/html")}
                  >
                    <Download className="mr-1.5 h-4 w-4" />
                    Full stat and spec sheet (.html)
                  </Button>
                  <Button variant="outline" className="mt-2 h-11 w-full" onClick={() => saveText(sheets.statSheetText, sheets.fileNames.statText, "text/plain")}>
                    <FileText className="mr-1.5 h-4 w-4" />
                    The same sheet as plain text (.txt)
                  </Button>
                  <Button variant="outline" className="mt-2 h-11 w-full" onClick={() => saveText(sheets.forensicChecklist, sheets.fileNames.checklist, "text/plain")}>
                    <ListChecks className="mr-1.5 h-4 w-4" />
                    The forensic item list on its own (.txt)
                  </Button>
                  <Button variant="outline" className="mt-2 h-11 w-full" onClick={() => saveText(sheets.correlationBrief, sheets.fileNames.brief, "text/markdown")}>
                    <FileText className="mr-1.5 h-4 w-4" />
                    Correlation brief (.md)
                  </Button>
                </>
              ) : null}
              {choice.spec ? (
                <>
                  <Button
                    variant={choice.sheet ? "outline" : "default"}
                    className={cn("mt-2 h-11 w-full", choice.sheet ? "" : "h-12 bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400")}
                    onClick={() => saveText(sheets.specMarkdown, sheets.fileNames.spec, "text/markdown")}
                  >
                    <FileCode className="mr-1.5 h-4 w-4" />
                    AI mimic spec (.md)
                  </Button>
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
                    A few pages holding only what is distinctive about this device. The facts that are identical on every phone alive are left out on
                    purpose, and the file says so — they would be noise in a document whose whole job is to characterise this one.
                  </p>
                </>
              ) : null}
              {!choice.sheet && !choice.spec ? (
                <p className="mt-3 rounded-xl border border-border/60 bg-background/40 p-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
                  You ticked neither downloadable sheet, so nothing is offered for saving. Everything is still readable below.
                </p>
              ) : null}
            </div>
          ) : null}

          {sheets ? (
            <div className="diag-card p-3.5">
              <h2 className="section-title">The camera's own files</h2>
              <p className="section-sub mt-1">
                Raw, exactly as the camera app handed them over — not re-encoded, not compressed, not zipped.
              </p>
              {originals.map((original) => (
                <Button
                  key={original.slug}
                  variant="outline"
                  className="mt-2 h-11 w-full justify-start gap-1.5 px-3 text-left"
                  onClick={() => downloadBlob(original.blob, original.fileName)}
                >
                  <Camera className="h-4 w-4 shrink-0" />
                  <span className="truncate">
                    {FACING_LABEL[original.facing]} original · {formatBytes(original.bytes)}
                    {original.sourceName ? ` · ${original.sourceName}` : ""}
                  </span>
                </Button>
              ))}
              {ORIGINAL_FACINGS.filter((facing) => !originals.some((o) => o.facing === facing)).map((facing) => (
                <p key={facing} className="mt-2 rounded-xl border border-border/60 bg-background/40 p-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
                  {missingOriginalReason(facing)}
                </p>
              ))}
              {originals.length > 0 ? (
                <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
                  These are the only files in the run the camera itself wrote — its own quantisation tables, maker note, colour profile and EXIF. Every
                  other photo here is a canvas encode, which carries no metadata at all, or a platform still, which carries almost none. They are held
                  back from the memory release for that reason, and their checksums in the sheets describe these exact bytes.
                </p>
              ) : null}
            </div>
          ) : null}

          {sheets && choice.viewer ? <SheetViewer sections={sheets.sections} /> : null}

          {archiveFatal ? (
            <div className="diag-card border-rose-500/45 p-3.5">
              <div className="flex items-start gap-2 text-rose-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <h2 className="text-[14px] font-semibold">The archive could not be built</h2>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-rose-200/90">{archiveFatal}</p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    The sheets above are unaffected. They were written before the archive was attempted, which is exactly why they survived it.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {pack ? (
            <>
              <div className="diag-card p-3.5">
                <h2 className="section-title">The raw archive</h2>
                <p className="section-sub mt-1">
                  {pack.files} files · {formatBytes(pack.bytes)}
                </p>
                <Button className="mt-3 h-12 w-full bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" onClick={() => downloadRawPack(pack)}>
                  <Download className="mr-1.5 h-4 w-4" />
                  Download the raw dump
                </Button>
                <Link
                  to="/archive"
                  className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-border/70 bg-card text-[12px] font-semibold active:scale-95"
                >
                  <FolderOpen className="h-4 w-4" />
                  Open the archive here
                </Link>
                <div className="mt-3 space-y-1 rounded-xl border border-border/60 bg-background/40 p-2.5 text-[10.5px] leading-relaxed">
                  {pack.verification.length === 0 ? (
                    <p className="text-muted-foreground">No captures to verify — this run produced no photos.</p>
                  ) : (
                    <>
                      <p className={pack.verification.every((v) => v.ok) ? "text-emerald-300" : "text-rose-300"}>
                        {pack.verification.filter((v) => v.ok).length} of {pack.verification.length} captures were carved back out of the finished
                        archive and matched byte-for-byte.
                      </p>
                      <p className="text-muted-foreground">
                        verification/byte-identity.txt inside the archive gives you the offsets to repeat that check yourself, with no need for this
                        app.
                      </p>
                    </>
                  )}
                </div>
              </div>

              {pack.warnings.length > 0 ? (
                <div className="diag-card border-amber-500/40 p-3.5">
                  <h3 className="text-[12.5px] font-semibold text-amber-200">What was not perfect</h3>
                  <div className="mt-1.5 space-y-1 text-[10.5px] leading-relaxed text-amber-200/85">
                    {pack.warnings.map((w) => (
                      <div key={w}>! {w}</div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {!choice.archive && sheets ? (
            <div className="diag-card p-3">
              <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                You did not ask for the archive, so the photo bytes were released as they were read. That is why this run used a fraction of the memory.
                {originals.length > 0
                  ? ` The ${originals.length === 1 ? "one exception is the camera original" : "only exceptions are the two camera originals"} above, ${formatBytes(originals.reduce((sum, o) => sum + o.bytes, 0))} in total, which are still held so you can save them.`
                  : " Nothing is held now."}{" "}
                To get a byte-for-byte dump of everything you would need to run again with the archive ticked.
              </p>
            </div>
          ) : null}

          <ResultList records={records} />
          {ticker}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the SWEEP found out about this camera's zoom.
 *
 * Three outcomes, not two. `moved` is the camera demonstrating a real range;
 * `flat` is the camera asked at both ends of its own range and answering with
 * the same value; `never-asked` is no zoom row existing for this camera at all.
 *
 * That third case has to be separate. A camera with no zoom rows used to be
 * written up as one that "showed no zoom range", which reports an answer nobody
 * collected — and it happened routinely, because a camera whose control block
 * was skipped as a repeat of an earlier camera's had no zoom rows to read. The
 * sweep now always asks, so this is rare; when it does happen, it says so.
 */
function zoomFinding(deviceId: string, matrix: CameraMatrixReport | null): "moved" | "flat" | "never-asked" {
  if (!matrix) return "never-asked";
  const zoomRows = matrix.rows.filter((row) => row.deviceId === deviceId && row.kind === "zoom");
  const untriedZoom = matrix.untried.some((step) => step.deviceId === deviceId && step.kind === "zoom");
  if (zoomRows.length === 0) return untriedZoom ? "never-asked" : "flat";
  const seen = new Set<number>();
  for (const row of zoomRows) {
    if (!row.ok) continue;
    const zoom = (row.grantedSettings as { zoom?: unknown } | null)?.zoom;
    if (typeof zoom === "number" && Number.isFinite(zoom)) seen.add(zoom);
  }
  return seen.size > 1 ? "moved" : "flat";
}

/**
 * Builds the manual shot list: every named camera at full frame, one zoom shot
 * where the sweep proved a range, then the camera-app handoffs.
 *
 * Four shots per camera became two at most. The minimum and the middle of a
 * zoom range are answered by holding the frame at full width and then at the
 * maximum — the middle of a range is the least informative point on it — and a
 * camera the sweep already saw refuse to zoom is not asked to prove that again
 * by hand. Every shot not asked for is returned as a skip carrying the sweep
 * observation that caused it.
 */
function buildManualSteps(inventory: CameraDeviceInfo[], matrix: CameraMatrixReport | null): { steps: ManualStep[]; skips: AdaptiveSkip[] } {
  const steps: ManualStep[] = [];
  const skips: AdaptiveSkip[] = [];
  // ONE viewfinder shot for the whole run, not one per camera. What it shows is
  // a property of the getUserMedia path rather than of the lens — a frame this
  // app encoded, carrying no camera metadata, which is true on every camera the
  // phone has — and both sides are covered separately by the camera-app trips.
  // The back camera is preferred because it is the one a phone photographs the
  // world with; where none is classified, the first camera stands in.
  const primary = inventory.find((device) => device.facing === "back") ?? inventory[0] ?? null;
  const primaryLabel = primary ? primary.label || `camera ${primary.deviceId.slice(0, 8)}` : null;
  if (primary && primaryLabel) {
    steps.push({
      id: `vf-${primary.deviceId.slice(0, 8)}-default`,
      kind: "viewfinder",
      title: `${primaryLabel} — full frame`,
      purpose:
        "The one hand shot taken through the browser's own camera path, pinned to this exact camera at its maximum resolution. It will carry no camera metadata — no browser writes any on this path — which is precisely the point of holding it against the camera-app files later. " +
        "One is enough: that absence is a property of the path, identical on every lens this phone has, and both sides of the phone are covered by the two trips to the camera app.",
      deviceId: primary.deviceId,
      deviceLabel: primaryLabel,
      zoom: null,
    });
  }
  for (const device of inventory) {
    const label = device.label || `camera ${device.deviceId.slice(0, 8)}`;
    if (device.deviceId !== primary?.deviceId) {
      skips.push({
        stepId: `vf-${device.deviceId.slice(0, 8)}-default`,
        title: `${label} — full frame`,
        reason: viewfinderNotAskedReason(label, primaryLabel ?? "the first camera this phone named"),
      });
    }
    const zoom = zoomFinding(device.deviceId, matrix);
    if (zoom === "moved") {
      steps.push({
        id: `vf-${device.deviceId.slice(0, 8)}-max`,
        kind: "viewfinder",
        title: `${label} — zoom max`,
        purpose:
          "Same camera, held at the top of the zoom range the sweep watched it move through. One zoom shot, at the end of the range: the middle of a range is the least informative point on it, and the full-frame shot above is already the other end. What this one shows is whether zooming crops the sensor or drives a different lens.",
        deviceId: device.deviceId,
        deviceLabel: label,
        zoom: "max",
      });
    } else {
      skips.push({
        stepId: `vf-${device.deviceId.slice(0, 8)}-max`,
        title: `${label} — zoom max`,
        reason: zoomNotAskedReason(label, zoom === "flat"),
      });
    }
  }
  for (const spec of buildManualShotList()) {
    const isLibrary = spec.source === "library";
    steps.push({
      id: spec.id,
      kind: isLibrary ? "library" : "camera-app",
      title: isLibrary ? "Photo library — asking for the original bytes, HEIC and all" : "Camera app — no camera named, so the phone chooses",
      purpose: spec.purpose,
      deviceId: null,
      deviceLabel: isLibrary ? "the photo library" : "the phone's own camera app",
      zoom: null,
      spec,
    });
  }

  // The second camera shot is NOT here. Which side it asks for is decided by
  // reading the first shot's own metadata, so it is inserted once that file is
  // in hand — see `takeManual`.

  steps.push({
    id: "capacitor-multi-pick",
    kind: "multi-pick",
    title: `Photo library — up to ${MULTI_PICK_LIMIT} photos in one trip`,
    purpose: MULTI_PICK_PURPOSE,
    deviceId: null,
    deviceLabel: "the photo library",
    zoom: null,
  });

  steps.push({
    id: "capacitor-contradiction",
    kind: "contradiction",
    title: "One request that contradicts itself — the library and the back camera at once",
    purpose: CONTRADICTION_PURPOSE,
    deviceId: null,
    deviceLabel: "the phone's own camera app and picker",
    zoom: null,
  });

  for (const form of ["base64", "data-url"] as PhotoForm[]) {
    steps.push({
      id: `capacitor-form-${form}`,
      kind: "photo-form",
      title: `The same photo again — as ${PHOTO_FORM_LABEL[form]}`,
      purpose:
        `Pick the SAME photo you picked a moment ago. The only thing that changes is the shape the file is handed back in: ${PHOTO_FORM_LABEL[form]} rather than a link to it. ` +
        `Every form is compared against the untouched original taken before anything could rewrite it, so the archive can say exactly what this one adds, loses, re-labels or inflates — including whether the camera's own metadata survives the trip. ` +
        `Picking a different photo does not break anything, but it makes the comparison meaningless, so the same one is worth the effort.`,
      deviceId: null,
      deviceLabel: "the photo library",
      zoom: null,
      form,
    });
  }

  return { steps, skips };
}

function ResultList({ records }: { records: PermissionRecord[] }) {
  if (records.length === 0) return null;
  return (
    <div className="diag-card overflow-hidden">
      <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Answers so far ({records.length})
      </div>
      <div className="divide-y divide-border/50">
        {records.map((r) => (
          <div key={`${r.id}-${r.askedAt}`} className="flex items-start gap-2 px-3 py-2">
            <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", OUTCOME_STYLE[r.outcome])}>
              {r.outcome === "granted" ? (
                <Check className="h-3 w-3" />
              ) : r.outcome === "denied" || r.outcome === "error" ? (
                <X className="h-3 w-3" />
              ) : r.outcome === "unavailable" ? (
                <Fingerprint className="h-3 w-3" />
              ) : (
                <Minus className="h-3 w-3" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-semibold">{r.label}</span>
                <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-muted-foreground">{OUTCOME_LABEL[r.outcome]}</span>
              </div>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">{r.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One tick box, with the consequence of the choice stated on the box itself. */
function TickBox({
  on,
  onToggle,
  title,
  detail,
  icon: Icon,
  tone,
}: {
  on: boolean;
  onToggle: () => void;
  title: string;
  detail: string;
  icon: typeof FileText;
  tone?: "heavy";
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onToggle}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition-colors active:scale-[0.99]",
        on
          ? tone === "heavy"
            ? "border-amber-500/55 bg-amber-500/12"
            : "border-fuchsia-500/55 bg-fuchsia-500/12"
          : "border-border/70 bg-background/40"
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
          on ? (tone === "heavy" ? "border-amber-400/70 bg-amber-500/25 text-amber-200" : "border-fuchsia-400/70 bg-fuchsia-500/25 text-fuchsia-200") : "border-border text-transparent"
        )}
      >
        <Check className="h-3 w-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <Icon className={cn("h-3.5 w-3.5 shrink-0", on ? (tone === "heavy" ? "text-amber-300" : "text-fuchsia-300") : "text-muted-foreground")} />
          <span className={cn("text-[12.5px] font-semibold", on ? "text-foreground" : "text-muted-foreground")}>{title}</span>
        </span>
        <span className="mt-1 block text-[10.5px] leading-relaxed text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

/**
 * The export choice, made before the photos are read rather than after.
 *
 * It has to be here and not at the end: with the archive unticked the photo
 * bytes are released as each one is read, and that is the entire reason the
 * sheet-only path costs a fraction of the memory. A choice offered afterwards
 * would be a choice that could no longer be acted on.
 */
function ExportChoicePanel({
  choice,
  setChoice,
  photoCount,
  byteCount,
  omissions,
  onGo,
}: {
  choice: ExportChoice;
  setChoice: (next: ExportChoice) => void;
  photoCount: number;
  byteCount: number;
  omissions: StageOmission[];
  onGo: () => void;
}) {
  const nothing = !choice.sheet && !choice.spec && !choice.viewer && !choice.archive;
  const noPhotos = photoCount === 0;
  return (
    <div className="space-y-3">
      <div className="diag-card p-3.5">
        <h2 className="section-title">{noPhotos ? "The gathering is over — without photos" : "The asking and the shooting are done"}</h2>
        <p className="section-sub mt-1">
          {noPhotos ? (
            <>
              This run took no photos, so there is nothing to read. Everything else it learned still stands: every permission answer, everything the
              device volunteered with no prompt at all, and every sensor recording that ran. Confirm what you want and the sheets are written from that.
            </>
          ) : (
            <>
              {photoCount} photo(s), {formatBytes(byteCount)} held. Your choices are already set from the menu — this is the last honest moment to change
              them, because whether the bytes are kept or dropped decides how much memory the next step needs.
            </>
          )}
        </p>
      </div>

      {omissions.length > 0 ? (
        <div className="diag-card border-amber-500/40 p-3">
          <h3 className="text-[11.5px] font-semibold text-amber-200">What did not happen ({omissions.length})</h3>
          <div className="mt-1.5 space-y-1.5 text-[10.5px] leading-relaxed text-amber-200/85">
            {omissions.map((o) => (
              <div key={o.stage}>
                <span className="font-semibold">{o.stage}</span> — {o.reason}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Each of these is written into the sheets as well, and the whole set is stamped PARTIAL. A gap that is named is evidence; a gap that is
            quietly closed over is not.
          </p>
        </div>
      ) : null}

      <div className="diag-card space-y-2 p-3">
        <TickBox
          on={choice.sheet}
          onToggle={() => setChoice({ ...choice, sheet: !choice.sheet })}
          title="Full stat and spec sheet"
          detail="Every detectable factor of this run, end to end, as a readable page and as plain text. The forensic item list sits at the top and also comes as its own file, alongside the correlation brief."
          icon={FileText}
        />
        <TickBox
          on={choice.spec}
          onToggle={() => setChoice({ ...choice, spec: !choice.spec })}
          title="AI mimic spec"
          detail="One concise markdown file holding only what is distinctive about this device. Facts that are identical on every phone alive are left out on purpose, and the file says so."
          icon={FileCode}
        />
        <TickBox
          on={choice.viewer}
          onToggle={() => setChoice({ ...choice, viewer: !choice.viewer })}
          title="Look through it here"
          detail="The same content on screen, section by section. No download, no archive, no unzipping."
          icon={ListChecks}
        />
        <TickBox
          on={choice.archive}
          onToggle={() => setChoice({ ...choice, archive: !choice.archive })}
          title="Raw archive (the heavy one)"
          detail={
            noPhotos
              ? "The byte-for-byte dump of every photo. This run has no photos, so the archive would hold only the sheets — which you can already save directly above."
              : "The complete byte-for-byte dump: every photo untouched, hex dumps, carved metadata regions and four checksums each. This is the step that has been killing the browser, so it is off unless you ask for it."
          }
          icon={Package}
          tone="heavy"
        />
      </div>

      {noPhotos ? null : (
        <div
          className={cn(
            "diag-card p-3 text-[10.5px] leading-relaxed",
            choice.archive ? "border-amber-500/40 text-amber-200/90" : "border-emerald-500/35 text-emerald-200/90"
          )}
        >
          {choice.archive ? (
            <>
              <span className="font-semibold">The photo bytes will be kept.</span> All {formatBytes(byteCount)} of them stay in memory while the archive is
              assembled, which is what this browser has been dying on. The sheets are still written first and handed to you before the archive is
              attempted, so a crash now costs you the dump and nothing else.
            </>
          ) : (
            <>
              <span className="font-semibold">Each photo's bytes will be released the moment its facts are read.</span> That is what keeps this path
              cheap. It also means no archive can be made from this run afterwards — you would have to run again with the archive ticked.
            </>
          )}
        </div>
      )}

      {nothing ? (
        <div className="diag-card border-border/70 p-3 text-[10.5px] leading-relaxed text-muted-foreground">
          Nothing is ticked. The sheets are still written — they are how the run reports itself — but none of them will be offered for saving or shown on
          screen.
        </div>
      ) : null}

      <Button className="h-14 w-full bg-fuchsia-500 text-[14px] font-semibold text-fuchsia-950 hover:bg-fuchsia-400" onClick={onGo}>
        {noPhotos ? "Write the sheets" : choice.archive ? "Read the photos, then build the archive" : "Read the photos and write the sheets"}
        <ChevronRight className="ml-1 h-4 w-4" />
      </Button>
    </div>
  );
}

function Setup({
  mode,
  setMode,
  tier,
  setTier,
  choice,
  setChoice,
  onStart,
}: {
  mode: RunMode;
  setMode: (next: RunMode) => void;
  tier: PermissionTier;
  setTier: (t: PermissionTier) => void;
  choice: ExportChoice;
  setChoice: (next: ExportChoice) => void;
  onStart: () => void;
}) {
  // Both short modes ask for the camera and nothing else, so the tier card and
  // the cost figures behave the same way for either. Where they differ is what
  // they DO with the camera, and that difference is stated separately.
  const short = mode !== "full";
  const impossibleOnly = mode === "impossible";
  const requestCount = useMemo(() => requestsForTier(tier).length, [tier]);
  /**
   * How many cameras this device names, read before the run rather than typed
   * in. Browsers withhold the list until a camera grant exists, so this is often
   * a count with the labels blanked — and sometimes nothing at all, which the
   * estimate then says out loud instead of pretending to a number.
   */
  const [cameraCount, setCameraCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void enumerateVideoInputs()
      .then((devices) => {
        if (live) setCameraCount(devices.length > 0 ? devices.length : null);
      })
      .catch(() => {
        if (live) setCameraCount(null);
      });
    return () => {
      live = false;
    };
  }, []);

  const estimate = useMemo(() => {
    // Derived from the camera count, because that is the one figure that
    // actually drives the length of a run. The old "12–22" was typed in and
    // stayed put whether the phone had one camera or five.
    const expected = expectedMinutes(short ? 2 : cameraCount, short ? 1 : requestCount);
    // Photos dominate the archive; hex text is capped by the device budget rather
    // than scaling with the number of captures, which is what keeps the total
    // predictable instead of open-ended.
    const hexText = hexTextBytesFor(HEX_BUDGET);
    return {
      prompts: short ? 1 : requestCount,
      minutes: expected.text,
      derivedFrom: expected.derivedFrom,
      photos: impossibleOnly
        ? "none at all — this mode photographs nothing"
        : short
          ? "4, taken for you"
          : `${cameraCount != null ? `${cameraCount * 2} automatic — exactly two per camera` : "two per camera, automatic"}, plus up to ${cameraCount != null ? Math.min(cameraCount, 2) + 11 : 12} you take yourself`,
      size: impossibleOnly
        ? "a few kilobytes of text. No photograph is taken, so there is nothing heavy in it."
        : cameraCount != null
          ? `roughly ${cameraCount * 12} MB – ${cameraCount * 40} MB, from the ${cameraCount} camera(s) this device names`
          : "40 MB – 160 MB, depending on how many cameras this device has",
      hex: `Hex dumps add at most ${formatBytes(hexText)} on this device — capped on purpose, because rendering every byte of every photo would exhaust this browser's memory before the archive finished. Anything windowed says exactly which bytes it skipped, and the complete photo is always in the archive.`,
    };
  }, [requestCount, cameraCount, short, impossibleOnly]);

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-fuchsia-500/35 bg-gradient-to-br from-fuchsia-500/12 via-card to-card p-4">
        <h2 className="text-[17px] font-semibold leading-tight">
          {impossibleOnly
            ? "What does this phone do when you ask it for the impossible?"
            : short
              ? `What does this phone do when a site asks for ${PROBE_WIDTH} wide?`
              : "Everything a website can ask you for, in one run"}
        </h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          {impossibleOnly
            ? "Each side of the phone is asked for things no camera can do — one pixel wide, a thousand frames a second, a square that is also widescreen, a setting name that does not exist, a camera that does not exist — and the run records exactly how it refuses: which error, which setting it blames, how long it takes, and whether it answers the same way twice. Succeeding is easy to imitate; refusing correctly is not. No photograph is taken anywhere in this mode, and nothing is uploaded."
            : short
              ? `One question, asked twice. The back camera and then the front camera are opened with a width of ${PROBE_WIDTH} as the only constraint — no height, no shape, no frame rate, no camera named — and the run records exactly what the phone decided on your behalf. That is the request most real websites actually send, and what a platform fills in around it is undocumented. Nothing is uploaded.`
              : "This deliberately behaves like the most demanding site you will ever visit: it asks for every permission it knows how to ask for, records exactly what your device hands over, then photographs through every camera — twice each, no more — while asking each of them for a battery of things no camera can do. Nothing is uploaded: the whole run happens on this phone and the archive is assembled in the browser."}
        </p>
      </div>

      <div className="diag-card p-3.5">
        <h3 className="text-[12.5px] font-semibold">Which run is this?</h3>
        <p className="mb-2 mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
          Chosen now rather than part way through, because it decides what the run <em>is</em>. Both stop and pause the same way.
        </p>
        <div className="space-y-1.5">
          {(Object.keys(RUN_MODE_INFO) as RunMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "w-full rounded-xl border p-3 text-left transition-colors",
                mode === m ? "border-sky-500/55 bg-sky-500/12" : "border-border/70 bg-background/40"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn("text-[13px] font-semibold", mode === m ? "text-sky-300" : "text-foreground")}>{RUN_MODE_INFO[m].label}</span>
                {mode === m ? <Check className="h-3.5 w-3.5 shrink-0 text-sky-300" /> : null}
              </div>
              <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">{RUN_MODE_INFO[m].blurb}</p>
              <p className="mt-1.5 text-[10px] font-semibold text-muted-foreground">{RUN_MODE_INFO[m].cost}</p>
            </button>
          ))}
        </div>
        {short ? (
          <p className="mt-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-2 text-[10px] leading-relaxed text-sky-200">
            This mode asks for the camera and nothing else. The sensor recordings, the full camera sweep and the shots you take by hand are not part of
            the question, so they are not run — and the sheets say that plainly rather than leaving them looking refused or failed.
            {impossibleOnly ? " It also takes no photograph at all: every ask in it is one no camera can answer, and what is being measured is the refusal." : null}
          </p>
        ) : null}
      </div>

      <div className={cn("diag-card p-3.5", short && "opacity-50")}>
        <h3 className="text-[12.5px] font-semibold">How far should it reach?</h3>
        {short ? (
          <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
            Not used by the {impossibleOnly ? "impossible-asks run" : `${PROBE_WIDTH}-only run`}, which asks for the camera and nothing else. Switch back to the full run to set this.
          </p>
        ) : null}
        <div className="mt-2 space-y-1.5">
          {TIER_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTier(t)}
              className={cn(
                "w-full rounded-xl border p-3 text-left transition-colors",
                tier === t ? "border-fuchsia-500/55 bg-fuchsia-500/12" : "border-border/70 bg-background/40"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn("text-[13px] font-semibold", tier === t ? "text-fuchsia-300" : "text-foreground")}>{TIER_INFO[t].label}</span>
                <span className="text-[10px] text-muted-foreground">{requestsForTier(t).length} requests</span>
              </div>
              <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">{TIER_INFO[t].blurb}</p>
              {TIER_INFO[t].caution ? (
                <p className={cn("mt-1.5 rounded-lg border p-2 text-[10px] leading-relaxed", t === "everything" ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-amber-500/35 bg-amber-500/10 text-amber-200")}>
                  {TIER_INFO[t].caution}
                </p>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="diag-card p-3">
        <h3 className="px-0.5 text-[12.5px] font-semibold">What it should hand you at the end</h3>
        <p className="mb-2 mt-1 px-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
          Set from the menu card, and changed here if you want. It is asked now because the archive decides whether every photo is held in memory or
          dropped as soon as it has been read — and because a run that ends early should still know what you wanted from it.
        </p>
        <div className="space-y-2">
          <TickBox
            on={choice.sheet}
            onToggle={() => setChoice({ ...choice, sheet: !choice.sheet })}
            title="Full stat and spec sheet"
            detail="Every detectable factor of the run, as a readable page and as plain text, with the forensic item list at the top and as its own file."
            icon={FileText}
          />
          <TickBox
            on={choice.spec}
            onToggle={() => setChoice({ ...choice, spec: !choice.spec })}
            title="AI mimic spec"
            detail="One concise markdown file holding only what is distinctive about this device. What is identical on every phone alive is left out on purpose."
            icon={FileCode}
          />
          <TickBox
            on={choice.viewer}
            onToggle={() => setChoice({ ...choice, viewer: !choice.viewer })}
            title="Look through it here"
            detail="The same content on screen, section by section. No download and no unzipping."
            icon={ListChecks}
          />
          <TickBox
            on={choice.archive}
            onToggle={() => setChoice({ ...choice, archive: !choice.archive })}
            title="Raw archive (the heavy one)"
            detail="The byte-for-byte dump: every photo untouched, hex dumps, carved metadata regions and four checksums each. This is the step that has been killing the browser, so it is off unless you ask for it."
            icon={Package}
            tone="heavy"
          />
        </div>
      </div>

      <div className="diag-card p-3.5">
        <h3 className="text-[12.5px] font-semibold">What this will cost you</h3>
        <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px]">
          <div className="rounded-xl border border-border/60 bg-background/40 p-2.5">
            <div className="mono text-[15px] font-semibold">{estimate.prompts}</div>
            <div className="mt-0.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">prompts to answer</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/40 p-2.5">
            <div className="mono text-[15px] font-semibold">{estimate.minutes} min</div>
            <div className="mt-0.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">of your attention</div>
          </div>
          <div className="col-span-2 rounded-xl border border-border/60 bg-background/40 p-2.5">
            <p className="text-[10px] leading-relaxed text-muted-foreground">{estimate.derivedFrom}</p>
          </div>
          <div className="col-span-2 rounded-xl border border-border/60 bg-background/40 p-2.5">
            <div className="text-[11.5px] font-semibold">{estimate.photos}</div>
            <div className="mt-0.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">photos taken</div>
          </div>
          <div className="col-span-2 rounded-xl border border-border/60 bg-background/40 p-2.5">
            <div className="text-[11.5px] font-semibold">{estimate.size}</div>
            <div className="mt-0.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">archive size</div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">{estimate.hex}</p>
          </div>
        </div>
      </div>

      <div className="diag-card p-3.5 text-[11px] leading-relaxed text-muted-foreground">
        <h3 className="mb-1.5 text-[12.5px] font-semibold text-foreground">Three things stated up front</h3>
        <p>
          <span className="text-foreground">You can stop at any point.</span> Whatever stage you are in, Stop lands on your choices and the sheets are
          written from everything gathered so far — clearly labelled partial, listing exactly which stages did not happen and why.
        </p>
        <p className="mt-1.5">
          <span className="text-foreground">A refusal is a result.</span> Nothing here is retried behind a second tap, and declining is recorded as
          declining — never as a failure.
        </p>
        <p className="mt-1.5">
          <span className="text-foreground">This is not every permission that exists.</span> The set differs by browser and grows with every release,
          so the archive reports what it asked for rather than pretending to be exhaustive.
        </p>
      </div>

      <Button className="h-14 w-full bg-fuchsia-500 text-[14px] font-semibold text-fuchsia-950 hover:bg-fuchsia-400" onClick={onStart}>
        Start the run
        <ChevronRight className="ml-1 h-4 w-4" />
      </Button>
    </div>
  );
}
