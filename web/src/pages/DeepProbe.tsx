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
  Loader2,
  Minus,
  FileText,
  FolderOpen,
  Package,
  Pause,
  Play,
  Radio,
  ShieldQuestion,
  Square,
  Thermometer,
  X,
} from "lucide-react";

import { probeManualShot, type ZoomTarget } from "@/components/deep-probe/ProbeViewfinder";
import { Button } from "@/components/ui/button";
import { formatBytes, makeLog, type LogEntry, type LogLevel } from "@/lib/camera-diagnostics";
import { CaptureCancelledError } from "@/lib/capture-engine";
import { enumerateVideoInputs, type CameraDeviceInfo } from "@/lib/device-camera";
import { runCameraSweep, type CameraMatrixReport, type ProbeCapture } from "@/lib/deep-probe/camera-matrix";
import { hexBudgetForDevice, hexTextBytesFor, readMemoryHints } from "@/lib/deep-probe/hex-budget";
import { buildManualShotList, runManualShot, type ManualShotSpec } from "@/lib/deep-probe/manual-capture";
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
import { buildRawPack, downloadDeviceSpec, downloadRawPack, type RawPackResult, type StageOmission } from "@/lib/deep-probe/raw-pack";
import {
  recordGenericSensor,
  recordGeolocation,
  recordMicrophoneLevel,
  recordMotion,
  recordOrientation,
  type SensorSeries,
} from "@/lib/deep-probe/sensors";
import { cn } from "@/lib/utils";

type Phase = "setup" | "permissions" | "sensors" | "camera" | "manual" | "building" | "done";

const STAGES: { phase: Phase; label: string; icon: typeof ShieldQuestion }[] = [
  { phase: "permissions", label: "Permissions", icon: ShieldQuestion },
  { phase: "sensors", label: "Sensors", icon: Radio },
  { phase: "camera", label: "Camera sweep", icon: Camera },
  { phase: "manual", label: "Your shots", icon: Hand },
  { phase: "building", label: "Archive", icon: Package },
];

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
  kind: "viewfinder" | "camera-app";
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

  const [buildMessage, setBuildMessage] = useState<string>("");
  const [buildPct, setBuildPct] = useState<number>(0);
  const [pack, setPack] = useState<RawPackResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const [paused, setPaused] = useState<boolean>(false);
  const [photoCount, setPhotoCount] = useState<number>(0);
  const [byteCount, setByteCount] = useState<number>(0);
  const [elapsed, setElapsed] = useState<number>(0);

  const capturesRef = useRef<ProbeCapture[]>([]);
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
  const tickerRef = useRef<HTMLDivElement | null>(null);

  const addLog = useCallback((level: LogLevel, message: string): void => {
    setLogs((prev) => [...prev.slice(-299), makeLog(level, message)]);
  }, []);

  useEffect(() => {
    tickerRef.current?.scrollTo({ top: tickerRef.current.scrollHeight, behavior: "smooth" });
  }, [logs]);

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
      setPhase("sensors");
    })();
  }, [phase, index, queue.length, addLog]);

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
        omissionsRef.current.push({ stage: "Camera sweep and manual shots", reason: "You stopped the run before these stages." });
        setPhase("building");
        return;
      }

      if (collected.length === 0) {
        addLog("info", "No sensor recordings ran, because nothing that produces a time series was granted. Recorded as such, not as a failure.");
        omissionsRef.current.push({
          stage: "Sensor recordings",
          reason: "Nothing that produces a time series was granted, so there was nothing to record. This is a consequence of the permission answers, not a fault.",
        });
      }
      setPhase("camera");
    })();
  }, [phase, grantedIds, addLog, waitWhilePaused]);

  /* ---------------- stage three: camera sweep ---------------- */
  useEffect(() => {
    if (phase !== "camera" || ranRef.current.has("camera")) return;
    ranRef.current.add("camera");
    void (async () => {
      if (!grantedIds.has("camera")) {
        addLog("warn", "Camera permission was not granted, so the sweep cannot run. No camera claim appears anywhere in the archive.");
        omissionsRef.current.push({
          stage: "Camera sweep and manual shots",
          reason: "Camera permission was not granted. The sweep does not re-prompt after a refusal, so both camera stages were skipped entirely.",
        });
        setPhase("building");
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
        omissionsRef.current.push({ stage: "Camera sweep (partially)", reason: "You stopped the sweep early. Every row recorded really ran; the remainder never started." });
        setPhase("building");
        return;
      }

      const inventory = await enumerateVideoInputs();
      setManualSteps(buildManualSteps(inventory));
      setManualIndex(0);
      setPhase("manual");
    })();
  }, [phase, grantedIds, addLog, waitWhilePaused]);

  /* ---------------- stage four: manual shots ---------------- */
  const manualStep = phase === "manual" ? manualSteps[manualIndex] : undefined;

  const takeManual = useCallback(async (): Promise<void> => {
    const step = manualSteps[manualIndex];
    if (!step) return;
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
      } else if (step.spec) {
        const result = await runManualShot(step.spec);
        const capture: ProbeCapture = {
          slug: `manual-${String(manualIndex + 1).padStart(2, "0")}-${step.id}`,
          label: step.title,
          blob: result.file,
          origin: result.origin,
          stage: "manual",
          deviceLabel: null,
          path: "camera-file",
          width: 0,
          height: 0,
          fileName: result.file.name,
          fileLastModified: result.file.lastModified,
          fileRelativePath: result.file.webkitRelativePath ?? "",
          asked: `${step.spec.engine}, facing ${step.spec.facing}`,
          granted: `file "${result.file.name}", ${result.file.size.toLocaleString("en-US")} bytes, last modified ${new Date(result.file.lastModified).toISOString()}${result.changeIsTrusted === undefined ? "" : ` · change event trusted: ${result.changeIsTrusted}`}`,
          takenAt: new Date().toISOString(),
        };
        capturesRef.current.push(capture);
        setPhotoCount(capturesRef.current.length);
        setByteCount((b) => b + result.file.size);
        addLog("success", `${step.title}: "${result.file.name}", ${formatBytes(result.file.size)} — a real camera file, so it should carry the camera's own metadata.`);
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
    setPhase("building");
  }, [phase, manualIndex, manualSteps.length, addLog]);

  /* ---------------- stage five: the archive ---------------- */
  useEffect(() => {
    if (phase !== "building" || ranRef.current.has("building")) return;
    ranRef.current.add("building");
    void (async () => {
      try {
        addLog("info", `Assembling the archive from ${capturesRef.current.length} capture(s).`);
        const result = await buildRawPack(
          {
            startedAt: startedAtRef.current,
            finishedAt: new Date().toISOString(),
            tier,
            permissions: records,
            passive: passiveRef.current,
            permissionStatesBefore: statesBeforeRef.current,
            permissionStatesAfter: statesAfterRef.current.length > 0 ? statesAfterRef.current : statesBeforeRef.current,
            sensors,
            matrix,
            captures: capturesRef.current,
            logs: suspensionLogs(logs, suspensionsRef.current),
            omissions: omissionsRef.current,
            hexBudgetBytes: HEX_BUDGET,
            devicesBeforePermission: devicesBeforeRef.current,
          },
          (message, done, total) => {
            setBuildMessage(message);
            setBuildPct(Math.min(99, Math.round((done / Math.max(total, 1)) * 100)));
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
        setPhase("done");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setFatal(message);
        addLog("error", `The archive could not be built: ${message}`);
        setPhase("done");
      }
    })();
  }, [phase, tier, records, sensors, matrix, logs, addLog]);

  const stopEverything = useCallback((): void => {
    abortRef.current = true;
    pausedRef.current = false;
    setPaused(false);
    addLog("warn", "Stopping. Everything gathered so far is kept, and the archive will be labelled partial.");
    if (phase === "permissions") {
      for (const request of queue.slice(index)) setRecords((prev) => [...prev, skippedRecord(request)]);
      omissionsRef.current.push({ stage: "Remaining permission requests", reason: "You stopped the run. The requests that had not yet fired are listed as skipped." });
      ranRef.current.add("sensors");
      ranRef.current.add("camera");
      omissionsRef.current.push({ stage: "Sensor recordings, camera sweep and manual shots", reason: "You stopped the run before these stages." });
      setPhase("building");
    } else if (phase === "manual") {
      omissionsRef.current.push({ stage: "Remaining manual shots", reason: "You stopped the run. The shots not yet taken were never attempted." });
      setPhase("building");
    }
  }, [phase, queue, index, addLog]);

  const counters = (
    <div className="grid grid-cols-4 gap-1.5">
      <Counter label="Answered" value={String(records.filter((r) => r.outcome !== "skipped").length)} />
      <Counter label="Photos" value={String(photoCount)} />
      <Counter label="Held" value={formatBytes(byteCount)} />
      <Counter label="Elapsed" value={`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`} />
    </div>
  );

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
        {phase !== "setup" && phase !== "done" && phase !== "building" ? (
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
          {STAGES.map((stage) => {
            const order = STAGES.findIndex((s) => s.phase === phase);
            const mine = STAGES.findIndex((s) => s.phase === stage.phase);
            const state = phase === "done" || mine < order ? "done" : mine === order ? "active" : "todo";
            const Icon = stage.icon;
            return (
              <div
                key={stage.phase}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 rounded-xl border px-1 py-2 transition-colors",
                  state === "done"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : state === "active"
                      ? "border-fuchsia-500/50 bg-fuchsia-500/12 text-fuchsia-300"
                      : "border-border/60 bg-background/40 text-muted-foreground"
                )}
              >
                {state === "done" ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                <span className="text-[8.5px] font-semibold uppercase tracking-wide">{stage.label}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {phase === "setup" ? <Setup tier={tier} setTier={setTier} onStart={() => void start()} /> : null}

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
                    {manualBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="mr-1.5 h-4 w-4" />}
                    {manualBusy ? "" : "Take it"}
                  </Button>
                  <Button variant="outline" disabled={manualBusy || paused} className="h-12" onClick={skipManual}>
                    Skip
                  </Button>
                </div>
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

      {phase === "building" ? (
        <div className="space-y-3">
          {counters}
          <div className="diag-card p-3.5">
            <h2 className="section-title">Building the archive</h2>
            <p className="section-sub mt-1">
              Every capture is copied in untouched and stored uncompressed, then carved back out of the finished archive and compared byte-for-byte —
              the claim is checked, not asserted.
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 transition-[width] duration-300" style={{ width: `${buildPct}%` }} />
            </div>
            <p className="mono mt-2 text-[10.5px] text-muted-foreground">{buildMessage || "…"}</p>
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
                  <h2 className="text-[14px] font-semibold">The archive could not be built</h2>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-rose-200/90">{fatal}</p>
                </div>
              </div>
            </div>
          ) : null}

          {pack ? (
            <>
              <div className="diag-card p-3.5">
                <h2 className="section-title">Run complete</h2>
                <p className="section-sub mt-1">
                  {pack.files} files · {formatBytes(pack.bytes)}
                  {omissionsRef.current.length > 0 || matrix?.aborted ? " · labelled PARTIAL, with every missing stage named inside" : " · every stage ran"}
                </p>
                <Button
                  className="mt-3 h-12 w-full bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400"
                  onClick={() => downloadRawPack(pack)}
                >
                  <Download className="mr-1.5 h-4 w-4" />
                  Download the raw dump
                </Button>
                <Button variant="outline" className="mt-2 h-11 w-full" onClick={() => downloadDeviceSpec(pack)}>
                  <FileText className="mr-1.5 h-4 w-4" />
                  Device spec only (.md)
                </Button>
                <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
                  The spec is a few pages instead of {formatBytes(pack.bytes)}: only the readings that differ between devices, each tagged as fixed
                  hardware, tied to the OS version, a setting you chose, or something that changes every run. It is also inside the archive as
                  device-spec.md.
                </p>
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
    steps.push({
      id: spec.id,
      kind: "camera-app",
      title: `Camera app — ${spec.facing === "environment" ? "back" : "front"} via ${spec.engine}`,
      purpose: spec.purpose,
      deviceId: null,
      deviceLabel: "the phone's own camera app",
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

function Setup({ tier, setTier, onStart }: { tier: PermissionTier; setTier: (t: PermissionTier) => void; onStart: () => void }) {
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
          <span className="text-foreground">You can stop at any point.</span> Everything gathered so far is kept and the archive is built from it,
          clearly labelled partial, listing exactly which stages did not happen.
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
