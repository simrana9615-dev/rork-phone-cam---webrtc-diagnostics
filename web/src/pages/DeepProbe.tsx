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
import { probeManualShot, type ZoomTarget } from "@/components/deep-probe/ProbeViewfinder";
import { SheetViewer } from "@/components/deep-probe/SheetViewer";
import { Button } from "@/components/ui/button";
import { downloadBlob, formatBytes, makeLog, type LogEntry, type LogLevel } from "@/lib/camera-diagnostics";
import { CaptureCancelledError } from "@/lib/capture-engine";
import { enumerateVideoInputs, type CameraDeviceInfo } from "@/lib/device-camera";
import { handoffDecision, zoomSkipReason, type AdaptiveSkip, type HandoffSighting, type ManualFacing } from "@/lib/deep-probe/adaptive-manual";
import { runCameraSweep, type CameraMatrixReport, type ProbeCapture } from "@/lib/deep-probe/camera-matrix";
import { readCaptureFacts, type CaptureFacts } from "@/lib/deep-probe/capture-facts";
import { readShape } from "@/lib/deep-probe/capture-signature";
import { finishTrail, mark, markLeft, setHeldBytes, startTrail, stopHeartbeat, takeCrashReport, type CrashReport } from "@/lib/deep-probe/crash-trail";
import { useExportChoice, type ExportChoice } from "@/lib/deep-probe/export-choice";
import { hexBudgetForDevice, hexTextBytesFor, readMemoryHints } from "@/lib/deep-probe/hex-budget";
import { buildManualShotList, runManualShot, type ManualShotSpec } from "@/lib/deep-probe/manual-capture";
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
  kind: "viewfinder" | "camera-app" | "library";
  title: string;
  purpose: string;
  deviceId: string | null;
  deviceLabel: string;
  zoom: ZoomTarget;
  spec?: ManualShotSpec;
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
  const [matrix, setMatrix] = useState<CameraMatrixReport | null>(null);
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
  /**
   * Camera-app files seen so far, reduced to their shapes. Two different
   * engines returning one shape is what proves the remaining handoffs for that
   * facing would collect a third copy of a file already in hand.
   */
  const handoffSightingsRef = useRef<HandoffSighting[]>([]);
  const adaptiveSkipsRef = useRef<AdaptiveSkip[]>([]);
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
      logs: suspensionLogs(logs, suspensionsRef.current),
      omissions: omissionsRef.current,
      devicesBeforePermission: devicesBeforeRef.current,
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
    addLog("info", `Deep Probe started at the ${TIER_INFO[tier].label} scope.`);
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
    setQueue(requestsForTier(tier));
    setIndex(0);
    setPhase("permissions");
  }, [addLog, tier]);

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
  }, [phase, grantedIds, addLog, waitWhilePaused, markStage, toExports]);

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
      addLog("info", "Camera sweep starting — every camera, every resolution rung, every ratio, frame rate and control mode.");
      const { report, captures } = await runCameraSweep({
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
      const granted = report.rows.filter((r) => r.ok).length;
      addLog(
        "success",
        `Sweep finished: ${granted} of ${report.rows.length} requests granted across ${report.inventory.length} camera(s), ${captures.length} photos taken.`
      );
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
      const inventory = await enumerateVideoInputs();
      setManualSteps(buildManualSteps(inventory));
      setManualIndex(0);
      setPhase("manual");
    })();
  }, [phase, grantedIds, addLog, waitWhilePaused, markStage, toExports]);

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
        // A zoom step that applied no zoom is the camera saying it has no range.
        // The remaining two would each be an identical unzoomed frame carrying
        // an identical note, which is one fact recorded twice more.
        if (step.zoom != null && shot.zoomApplied == null) {
          dropAhead((candidate) => candidate.kind === "viewfinder" && candidate.deviceId === step.deviceId && candidate.zoom != null, zoomSkipReason(step.deviceLabel));
        }
      } else if (step.spec) {
        const spec = step.spec;
        const result = await runManualShot(spec);
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
            : `${spec.engine}, facing ${spec.facing ?? "unspecified"}`,
          granted: `file "${result.file.name}", type "${result.file.type || "(none declared)"}", ${result.file.size.toLocaleString("en-US")} bytes, last modified ${new Date(result.file.lastModified).toISOString()}${result.changeIsTrusted === undefined ? "" : ` · change event trusted: ${result.changeIsTrusted}`}`,
          takenAt: new Date().toISOString(),
        };
        capturesRef.current.push(capture);
        // Declared here, where the facing and the production path are both known
        // for certain. A library pick never qualifies, however rich its metadata.
        if (!isLibrary && spec.facing != null) {
          originalCandidatesRef.current.push({ slug: capture.slug, facing: spec.facing, path: capture.path, origin: capture.origin });
        }
        // A file taken by hand is never thrown away — it cost someone a minute
        // of standing still. What its shape can do is stop the run ASKING for
        // the next one, which is the same saving without the discourtesy.
        if (!isLibrary && spec.facing != null) {
          const facing: ManualFacing = spec.facing;
          const shape = await readShape(result.file);
          handoffSightingsRef.current.push({ engine: String(spec.engine), facing, shapeId: shape.id, slug: capture.slug });
          const remaining = manualSteps
            .filter((candidate, i) => i > manualIndex && candidate.kind === "camera-app" && candidate.spec?.facing === facing)
            .map((candidate) => String(candidate.spec?.engine ?? ""));
          const decision = handoffDecision(handoffSightingsRef.current, facing, remaining);
          if (decision.reason != null) {
            const skipping = new Set(decision.skipEngines);
            dropAhead((candidate) => candidate.kind === "camera-app" && candidate.spec?.facing === facing && skipping.has(String(candidate.spec?.engine ?? "")), decision.reason);
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
      if (err instanceof CaptureCancelledError) {
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
    markStage("manual", "done");
    toExports();
  }, [phase, manualIndex, manualSteps.length, addLog, markStage, toExports]);

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

      {phase === "setup" ? <Setup tier={tier} setTier={setTier} choice={choice} setChoice={setChoice} onStart={() => void start()} /> : null}

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
            <p className="mono mt-2 text-[10.5px] leading-relaxed text-muted-foreground">{sweepMessage || "Starting…"}</p>
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
                    ) : manualStep.kind === "library" ? (
                      <Images className="mr-1.5 h-4 w-4" />
                    ) : (
                      <Camera className="mr-1.5 h-4 w-4" />
                    )}
                    {manualBusy ? "" : manualStep.kind === "library" ? "Pick one" : "Take it"}
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

/** Builds the manual shot list: every named camera in the viewfinder, three zoom steps each, then the camera-app handoffs. */
function buildManualSteps(inventory: CameraDeviceInfo[]): ManualStep[] {
  const steps: ManualStep[] = [];
  for (const device of inventory) {
    const label = device.label || `camera ${device.deviceId.slice(0, 8)}`;
    steps.push({
      id: `vf-${device.deviceId.slice(0, 8)}-default`,
      kind: "viewfinder",
      title: `${label} — full frame`,
      purpose:
        "Pinned to this exact camera at its own maximum resolution. This is the shot that shows what this specific lens sees. It will carry no camera metadata — no browser writes any on this path — which is itself the point of comparing it with the camera-app shots later.",
      deviceId: device.deviceId,
      deviceLabel: label,
      zoom: null,
    });
    for (const zoom of ["min", "mid", "max"] as const) {
      steps.push({
        id: `vf-${device.deviceId.slice(0, 8)}-${zoom}`,
        kind: "viewfinder",
        title: `${label} — zoom ${zoom}`,
        purpose: `Same camera, held at the ${zoom} of the zoom range it reports. If this camera exposes no zoom control the shot is still taken and clearly recorded as unzoomed, rather than quietly pretending otherwise.`,
        deviceId: device.deviceId,
        deviceLabel: label,
        zoom,
      });
    }
  }
  for (const spec of buildManualShotList()) {
    const isLibrary = spec.source === "library";
    steps.push({
      id: spec.id,
      kind: isLibrary ? "library" : "camera-app",
      title: isLibrary
        ? `Photo library — ${spec.id === "library-original" ? "the same photo, asking for the original bytes" : "an ordinary upload"}`
        : `Camera app — ${spec.facing === "environment" ? "back" : "front"} via ${spec.engine}`,
      purpose: spec.purpose,
      deviceId: null,
      deviceLabel: isLibrary ? "the photo library" : "the phone's own camera app",
      zoom: null,
      spec,
    });
  }
  return steps;
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
  tier,
  setTier,
  choice,
  setChoice,
  onStart,
}: {
  tier: PermissionTier;
  setTier: (t: PermissionTier) => void;
  choice: ExportChoice;
  setChoice: (next: ExportChoice) => void;
  onStart: () => void;
}) {
  const requestCount = useMemo(() => requestsForTier(tier).length, [tier]);
  const estimate = useMemo(() => {
    const promptMinutes = Math.ceil(requestCount * 0.2);
    // Photos dominate the archive; hex text is capped by the device budget rather
    // than scaling with the number of captures, which is what keeps the total
    // predictable instead of open-ended.
    const hexText = hexTextBytesFor(HEX_BUDGET);
    return {
      prompts: requestCount,
      minutes: `${promptMinutes + 12}–${promptMinutes + 22}`,
      photos: "60–150 automatic, plus up to 22 you take yourself",
      size: `250 MB – 700 MB, depending on how many cameras this device has`,
      hex: `Hex dumps add at most ${formatBytes(hexText)} on this device — capped on purpose, because rendering every byte of every photo would exhaust this browser's memory before the archive finished. Anything windowed says exactly which bytes it skipped, and the complete photo is always in the archive.`,
    };
  }, [requestCount]);

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-fuchsia-500/35 bg-gradient-to-br from-fuchsia-500/12 via-card to-card p-4">
        <h2 className="text-[17px] font-semibold leading-tight">Everything a website can ask you for, in one run</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          This deliberately behaves like the most demanding site you will ever visit: it asks for every permission it knows how to ask for, records
          exactly what your device hands over, then photographs through every camera at every setting it supports. Nothing is uploaded — the whole
          run happens on this phone and the archive is assembled in the browser.
        </p>
      </div>

      <div className="diag-card p-3.5">
        <h3 className="text-[12.5px] font-semibold">How far should it reach?</h3>
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
