import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture,
  ArrowLeft,
  Camera,
  CameraOff,
  Download,
  Eraser,
  FileSearch,
  Fingerprint,
  Flashlight,
  FlipHorizontal2,
  ListVideo,
  Play,
  Radar,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Smartphone,
  Square,
  Trash2,
  User,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import FraudLab from "@/components/FraudLab";
import LastPhotoExif, { ExifInspector, type ExifExportMeta, type ExifTimelineEvent, type LastPhotoShot } from "@/components/LastPhotoExif";
import { FindingRow } from "@/components/ReportView";
import { analyzeImageFraud, type FraudVerdict, type MediaFraudReport } from "@/lib/fraud-detection";
import CaptureEngineToggle from "@/components/verify/CaptureEngineToggle";
import { CaptureCancelledError, capacitorCapturePhoto, engineLaunchNote, fsPickerCapturePhoto, inputAcceptAttr, inputCaptureAttr, useCaptureEngine } from "@/lib/capture-engine";
import { deviceCameraCapturePhoto } from "@/components/verify/DeviceCameraSheet";
import { auditFileInputIntegrity } from "@/lib/injection-guard";
import { describeLensCheck, enforceLensPolicy } from "@/lib/lens-enforcement";

type NativeCtx = {
  pressedAt: number;
  changeIsTrusted?: boolean;
  elapsedSincePressMs?: number;
  pageLoadedAt?: number;
  filesApiNative?: boolean;
  pressIsTrusted?: boolean;
  pageHiddenDuring?: boolean;
};
import {
  analyzeImageBlob,
  captureFromVideo,
  captureWithImageCapture,
  constraintsFromDraft,
  defaultConstraintDraft,
  defaultCrop,
  downloadBlob,
  formatBytes,
  formatCapabilities,
  formatSettings,
  hasImageCapture,
  hasMediaDevices,
  isSecureContext,
  makeLog,
  parseOptionalNumber,
  probeConstraints,
  stopStream,
  SUITE_TESTS,
  trackCapabilities,
  trackSettings,
  type ConstraintDraft,
  type CropState,
  type EnvStatus,
  type GalleryItem,
  type LogEntry,
  type ResolutionPreset,
  type StatusTone,
  type SuiteTestResult,
} from "@/lib/camera-diagnostics";

type Facing = "user" | "environment";

const FRAUD_BADGE: Record<FraudVerdict, string> = {
  authentic: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  suspicious: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  manipulated: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  "ai-generated": "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
  "needs-more-info": "border-sky-500/40 bg-sky-500/10 text-sky-300",
};

/** Builds the per-photo JSON-export context (observed capture timeline + screening verdict) from a gallery item's recorded facts. */
function buildExifExportMeta(item: GalleryItem): ExifExportMeta {
  const events: ExifTimelineEvent[] = [];
  const trip = item.nativeTrip;
  if (trip) {
    if (trip.pageLoadedAt != null) {
      events.push({ label: "Page loaded", epochMs: trip.pageLoadedAt, detail: "performance.timeOrigin — start of this page session" });
    }
    events.push({
      label: "Capture button pressed",
      epochMs: trip.pressedAt,
      detail:
        trip.pressIsTrusted == null
          ? "press event trust not recorded"
          : trip.pressIsTrusted
            ? "user-initiated press (event.isTrusted true)"
            : "SCRIPT-FIRED press (event.isTrusted false)",
    });
    events.push({
      label: "Page hidden during round-trip (native camera app in foreground)",
      epochMs: null,
      detail:
        trip.pageHiddenDuring == null
          ? "not recorded for this capture path"
          : trip.pageHiddenDuring
            ? "observed: yes"
            : "observed: NO — page never left the foreground",
    });
    if (trip.elapsedSincePressMs != null) {
      events.push({
        label: "File arrived from camera",
        epochMs: trip.pressedAt + trip.elapsedSincePressMs,
        detail: `${(trip.elapsedSincePressMs / 1000).toFixed(1)}s after press · change event ${
          trip.changeIsTrusted == null ? "trust not recorded" : trip.changeIsTrusted ? "dispatched by the user agent" : "SCRIPT-DISPATCHED"
        } · FileList ${trip.filesApiNative == null ? "nativeness not recorded" : trip.filesApiNative ? "native" : "NOT native (DataTransfer-built)"}`,
      });
    }
  }
  if (item.blob instanceof File) {
    events.push({ label: "File lastModified", epochMs: item.blob.lastModified, detail: "declared by the OS/filesystem — not measured by this app" });
  }
  events.push({ label: "Added to session gallery", epochMs: item.createdAtEpochMs, detail: "EXIF summary, binary markers, and fraud screening completed" });
  return {
    fileName: item.name,
    source:
      item.source === "native"
        ? "native camera capture"
        : item.source === "shutter"
          ? "in-browser shutter (canvas export from the live feed — no native camera round-trip)"
          : "file import",
    timeline: events,
    screening: item.fraud ?? null,
  };
}

function StatusChip({ label, value, tone }: EnvStatus) {
  const toneClass: Record<StatusTone, string> = {
    ok: "status-ok",
    bad: "status-bad",
    warn: "status-warn",
    neutral: "status-neutral",
  };
  return (
    <div className={cn("rounded-xl border px-3 py-2", toneClass[tone])}>
      <div className="text-[10px] font-medium uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold leading-tight">{value}</div>
    </div>
  );
}

function Section({
  icon,
  title,
  subtitle,
  children,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
  accent?: string;
}) {
  return (
    <section className="diag-card overflow-hidden">
      <div className="border-b border-border/70 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary",
              accent
            )}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <h2 className="section-title">{title}</h2>
            {subtitle ? <p className="section-sub mt-0.5">{subtitle}</p> : null}
          </div>
        </div>
      </div>
      <div className="space-y-3 p-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

const Index = () => {
  const captureEngine = useCaptureEngine();
  const [lastNativePhoto, setLastNativePhoto] = useState<LastPhotoShot | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const nativeInputRef = useRef<HTMLInputElement | null>(null);
  const nativeFrontInputRef = useRef<HTMLInputElement | null>(null);
  const nativePressRef = useRef<number>(0);
  const nativePressTrustedRef = useRef<boolean | undefined>(undefined);
  const nativeHiddenSeenRef = useRef<boolean>(false);
  const nativeVisHandlerRef = useRef<(() => void) | null>(null);
  const deviceMaxPixelsRef = useRef<number | null>(null);
  const suiteAbortRef = useRef<boolean>(false);
  const streamRef = useRef<MediaStream | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  /** Mirror of `gallery` for the unmount cleanup — a direct closure would capture the first-render (empty) array and never revoke the object URLs. */
  const galleryRef = useRef<GalleryItem[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [facing, setFacing] = useState<Facing>("environment");
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [supportsTorch, setSupportsTorch] = useState(false);
  const [permission, setPermission] = useState<"not-tested" | "granted" | "denied" | "prompt">("not-tested");
  const [preset, setPreset] = useState<ResolutionPreset>("hd");
  const [customWidth, setCustomWidth] = useState("1920");
  const [customHeight, setCustomHeight] = useState("1080");
  const [draft, setDraft] = useState<ConstraintDraft>(defaultConstraintDraft());
  const [crop, setCrop] = useState<CropState>(defaultCrop());
  const [grantedSettings, setGrantedSettings] = useState<string>("—");
  const [grantedCaps, setGrantedCaps] = useState<string>("—");
  const [lastError, setLastError] = useState<string | null>(null);
  const [facingExact, setFacingExact] = useState(false);
  const [mirrorFront, setMirrorFront] = useState(true);
  const [suiteRunning, setSuiteRunning] = useState(false);
  const [suiteFacing, setSuiteFacing] = useState<Facing>("user");
  const [suiteProgress, setSuiteProgress] = useState<{ current: number; total: number } | null>(null);
  const [suiteResults, setSuiteResults] = useState<SuiteTestResult[]>([]);
  const [expandedFraudId, setExpandedFraudId] = useState<string | null>(null);
  const [expandedExifId, setExpandedExifId] = useState<string | null>(null);

  const pushLog = useCallback((level: LogEntry["level"], message: string) => {
    setLogs((prev) => {
      const next = [...prev, makeLog(level, message)];
      return next.length > 400 ? next.slice(next.length - 400) : next;
    });
  }, []);

  const envStatuses = useMemo<EnvStatus[]>(() => {
    const secure = isSecureContext();
    const media = hasMediaDevices();
    const imageCap = hasImageCapture();
    const permTone: StatusTone =
      permission === "granted" ? "ok" : permission === "denied" ? "bad" : permission === "prompt" ? "warn" : "neutral";
    const permValue =
      permission === "not-tested"
        ? "Not Tested"
        : permission === "granted"
          ? "Granted"
          : permission === "denied"
            ? "Denied"
            : "Prompt";

    return [
      {
        label: "Secure Context (HTTPS)",
        value: secure ? "Yes" : "No — camera will fail",
        tone: secure ? "ok" : "bad",
      },
      {
        label: "MediaDevices API",
        value: media ? "Available" : "Missing",
        tone: media ? "ok" : "bad",
      },
      {
        label: "ImageCapture API",
        value: imageCap ? "Available" : "Not available",
        tone: imageCap ? "ok" : "warn",
      },
      {
        label: "Camera Permission",
        value: permValue,
        tone: permTone,
      },
    ];
  }, [permission]);

  useEffect(() => {
    pushLog("info", "Phone Camera & WebRTC Diagnostic Hub ready");
    pushLog("debug", `UA: ${navigator.userAgent}`);
    pushLog("debug", `secureContext=${isSecureContext()} mediaDevices=${hasMediaDevices()} ImageCapture=${hasImageCapture()}`);

    let disposed = false;
    let watched: PermissionStatus | null = null;
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "camera" as PermissionName })
        .then((status) => {
          if (disposed) return;
          watched = status;
          setPermission(status.state as "granted" | "denied" | "prompt");
          pushLog("info", `Permissions API camera state: ${status.state}`);
          status.onchange = () => {
            setPermission(status.state as "granted" | "denied" | "prompt");
            pushLog("info", `Permission changed → ${status.state}`);
          };
        })
        .catch(() => {
          if (!disposed) pushLog("warn", "Permissions API camera query not supported on this browser");
        });
    }
    return () => {
      disposed = true;
      if (watched) watched.onchange = null;
    };
  }, [pushLog]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  useEffect(() => {
    galleryRef.current = gallery;
  }, [gallery]);

  useEffect(() => {
    return () => {
      stopStream(streamRef.current);
      streamRef.current = null;
      galleryRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  const attachStream = useCallback(
    async (stream: MediaStream) => {
      stopStream(streamRef.current);
      streamRef.current = stream;
      setStreaming(true);
      setLastError(null);

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch (err) {
          pushLog("warn", `video.play() blocked or failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const track = stream.getVideoTracks()[0];
      if (!track) {
        pushLog("error", "Stream has no video track");
        return;
      }

      const settings = trackSettings(track);
      const caps = trackCapabilities(track);
      setGrantedSettings(formatSettings(settings));
      setGrantedCaps(formatCapabilities(caps));
      pushLog("success", `getUserMedia OK · track=${track.label || "(unnamed)"}`);
      pushLog("debug", `settings: ${formatSettings(settings)}`);
      pushLog("debug", `capabilities: ${formatCapabilities(caps)}`);

      const zoomCap = (caps as MediaTrackCapabilities & { zoom?: { min?: number; max?: number; step?: number } } | null)
        ?.zoom;
      if (zoomCap && zoomCap.max != null && zoomCap.max > (zoomCap.min ?? 1)) {
        setZoomRange({
          min: zoomCap.min ?? 1,
          max: zoomCap.max,
          step: zoomCap.step ?? 0.1,
        });
        const currentZoom = (settings as MediaTrackSettings & { zoom?: number } | null)?.zoom ?? zoomCap.min ?? 1;
        setZoom(currentZoom);
      } else {
        setZoomRange(null);
        setZoom(1);
      }

      const capsW = (caps?.width as { max?: number } | undefined)?.max;
      const capsH = (caps?.height as { max?: number } | undefined)?.max;
      if (capsW && capsH) {
        deviceMaxPixelsRef.current = capsW * capsH;
      }

      const torchCap = (caps as MediaTrackCapabilities & { torch?: boolean } | null)?.torch;
      setSupportsTorch(!!torchCap);
      setTorchOn(!!(settings as MediaTrackSettings & { torch?: boolean } | null)?.torch);
    },
    [pushLog]
  );

  const startStream = useCallback(
    async (videoConstraints: MediaTrackConstraints, label: string) => {
      if (!hasMediaDevices()) {
        pushLog("error", "MediaDevices API unavailable");
        setLastError("MediaDevices API unavailable");
        return;
      }
      if (!isSecureContext()) {
        pushLog("error", "Not a secure context (HTTPS required for camera)");
        setLastError("HTTPS required");
      }

      setBusy(true);
      pushLog("info", `Requesting getUserMedia · ${label}`);
      pushLog("debug", `constraints: ${JSON.stringify({ audio: false, video: videoConstraints })}`);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraints,
        });
        setPermission("granted");
        await attachStream(stream);
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        setLastError(message);
        pushLog("error", `getUserMedia failed · ${message}`);
        if (message.toLowerCase().includes("permission") || message.includes("NotAllowedError")) {
          setPermission("denied");
        }
      } finally {
        setBusy(false);
      }
    },
    [attachStream, pushLog]
  );

  const facingConstraint = useCallback(
    (target?: Facing): ConstrainDOMString =>
      facingExact ? { exact: target ?? facing } : { ideal: target ?? facing },
    [facing, facingExact]
  );

  const resolutionConstraints = useCallback((): MediaTrackConstraints => {
    const base: MediaTrackConstraints = {};
    if (selectedDeviceId) {
      base.deviceId = { exact: selectedDeviceId };
    } else {
      base.facingMode = facingConstraint();
    }

    if (preset === "max") {
      base.width = { ideal: 3840 };
      base.height = { ideal: 2160 };
    } else if (preset === "hd") {
      base.width = { ideal: 1920 };
      base.height = { ideal: 1080 };
    } else if (preset === "720p") {
      base.width = { ideal: 1280 };
      base.height = { ideal: 720 };
    } else {
      const w = parseOptionalNumber(customWidth);
      const h = parseOptionalNumber(customHeight);
      if (w != null) base.width = { ideal: w };
      if (h != null) base.height = { ideal: h };
    }
    return base;
  }, [customHeight, customWidth, facingConstraint, preset, selectedDeviceId]);

  const requestPermission = useCallback(async () => {
    pushLog("info", `Explicit camera permission request (facing=${facing})…`);
    await startStream({ facingMode: { ideal: facing } }, `permission probe (${facing})`);
  }, [facing, pushLog, startStream]);

  const enumerateCameras = useCallback(async () => {
    if (!hasMediaDevices()) {
      pushLog("error", "Cannot enumerate — MediaDevices missing");
      return;
    }
    try {
      // Some browsers hide labels until permission granted
      if (permission !== "granted") {
        pushLog("info", "Probing camera to unlock device labels…");
        try {
          const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          stopStream(probe);
          setPermission("granted");
        } catch (err) {
          pushLog("warn", `Probe before enumerate failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const list = await navigator.mediaDevices.enumerateDevices();
      const cams = list.filter((d) => d.kind === "videoinput");
      setDevices(cams);
      pushLog("success", `Enumerated ${cams.length} videoinput device(s)`);
      cams.forEach((d, i) => {
        pushLog(
          "debug",
          `[${i}] ${d.label || "(no label)"} · deviceId=${d.deviceId.slice(0, 12)}… · group=${d.groupId?.slice(0, 8) ?? "—"}`
        );
      });
      if (cams.length && !selectedDeviceId) {
        setSelectedDeviceId("");
      }
    } catch (err) {
      pushLog("error", `enumerateDevices failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [permission, pushLog, selectedDeviceId]);

  const startLive = useCallback(async () => {
    await startStream(resolutionConstraints(), `live viewfinder · preset=${preset}`);
  }, [preset, resolutionConstraints, startStream]);

  const flipCamera = useCallback(async () => {
    const next: Facing = facing === "environment" ? "user" : "environment";
    setFacing(next);
    setSelectedDeviceId("");
    pushLog("info", `Flip camera → facingMode=${next} (${facingExact ? "exact" : "ideal"})`);
    const constraints = resolutionConstraints();
    delete constraints.deviceId;
    constraints.facingMode = facingConstraint(next);
    await startStream(constraints, `flip → ${next}`);
  }, [facing, facingConstraint, facingExact, pushLog, resolutionConstraints, startStream]);

  const selectFacing = useCallback(
    async (next: Facing) => {
      setFacing(next);
      setSelectedDeviceId("");
      pushLog("info", `Active camera for ALL requests → ${next === "user" ? "FRONT" : "BACK"} (${facingExact ? "exact" : "ideal"})`);
      if (streaming) {
        const constraints = resolutionConstraints();
        delete constraints.deviceId;
        constraints.facingMode = facingExact ? { exact: next } : { ideal: next };
        await startStream(constraints, `switch → ${next}`);
      }
    },
    [facingExact, pushLog, resolutionConstraints, startStream, streaming]
  );

  const applyZoom = useCallback(
    async (value: number) => {
      setZoom(value);
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track) return;
      try {
        await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] });
        pushLog("success", `applyConstraints zoom=${value}`);
        setGrantedSettings(formatSettings(trackSettings(track)));
      } catch (err) {
        pushLog("error", `zoom applyConstraints failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [pushLog]
  );

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) {
      pushLog("warn", "No active track for torch");
      return;
    }
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
      pushLog("success", `torch → ${next ? "ON" : "OFF"}`);
      setGrantedSettings(formatSettings(trackSettings(track)));
    } catch (err) {
      pushLog("error", `torch applyConstraints failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [pushLog, torchOn]);

  const addToGallery = useCallback(
    async (blob: Blob, source: GalleryItem["source"], baseName: string, nativeCtx?: NativeCtx) => {
      const analysis = await analyzeImageBlob(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `${baseName}-${stamp}.jpg`;
      const url = URL.createObjectURL(blob);

      let fraud: MediaFraudReport | undefined;
      try {
        fraud = await analyzeImageFraud(blob, name, {
          captureSource: nativeCtx ? "native-file" : source === "shutter" ? "live-frame" : "upload",
          fileLastModified: blob instanceof File ? blob.lastModified : undefined,
          native: nativeCtx
            ? {
                pressedAt: nativeCtx.pressedAt,
                facing,
                deviceMaxPixels: deviceMaxPixelsRef.current,
                changeIsTrusted: nativeCtx.changeIsTrusted,
                elapsedSincePressMs: nativeCtx.elapsedSincePressMs,
                pageLoadedAt: nativeCtx.pageLoadedAt,
                filesApiNative: nativeCtx.filesApiNative,
                pressIsTrusted: nativeCtx.pressIsTrusted,
                pageHiddenDuring: nativeCtx.pageHiddenDuring,
              }
            : undefined,
        });
        const fails = fraud.findings.filter((f) => f.status === "fail").length;
        const warns = fraud.findings.filter((f) => f.status === "warn").length;
        pushLog(
          fraud.verdict === "authentic"
            ? "success"
            : fraud.verdict === "suspicious" || fraud.verdict === "needs-more-info"
              ? "warn"
              : "error",
          `Screening: ${fraud.verdictLabel} · score ${fraud.score}/100 · confidence ${fraud.confidence}% · ${fails} fail / ${warns} warn`
        );
        for (const advice of fraud.retakeAdvice) pushLog("warn", `Screening retake request: ${advice}`);
      } catch (err) {
        pushLog("warn", `Fraud screening failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const item: GalleryItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        blob,
        url,
        name,
        source,
        createdAt: new Date().toLocaleString(),
        createdAtEpochMs: Date.now(),
        size: blob.size,
        mimeType: blob.type || "image/jpeg",
        dimensions: analysis.dimensions,
        exifSummary: analysis.exifSummary,
        binaryMarkers: analysis.binaryMarkers,
        hasExif: analysis.hasExif,
        fraud,
        nativeTrip: nativeCtx,
      };
      setGallery((prev) => [item, ...prev]);
      pushLog(
        analysis.hasExif ? "success" : "warn",
        `Captured ${name} · ${formatBytes(blob.size)} · ${analysis.dimensions ? `${analysis.dimensions.width}×${analysis.dimensions.height}` : "dims?"} · markers: ${analysis.binaryMarkers}`
      );
      pushLog("debug", `EXIF: ${analysis.exifSummary}`);
      return item;
    },
    [facing, pushLog]
  );

  const executeShutter = useCallback(async () => {
    setBusy(true);
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      let blob: Blob | null = null;

      if (track && hasImageCapture()) {
        try {
          pushLog("info", "Shutter via ImageCapture.takePhoto() (full frame)");
          blob = await captureWithImageCapture(track);
          pushLog("success", "ImageCapture.takePhoto() succeeded");
        } catch (err) {
          pushLog(
            "warn",
            `ImageCapture failed, falling back to canvas: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (!blob) {
        const video = videoRef.current;
        if (!video) throw new Error("No video element");
        pushLog("info", "Shutter via canvas drawImage (full video frame, uncropped)");
        blob = await captureFromVideo(video);
      }

      const item = await addToGallery(blob, "shutter", "shutter-fullframe");
      downloadBlob(item.blob, item.name);
      pushLog("info", `Auto-download started for ${item.name} (untouched binary)`);
    } catch (err) {
      pushLog("error", `Shutter failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [addToGallery, pushLog]);

  /** Starts the press-provenance watch: records press trust and whether the page loses visibility while the camera app is open. */
  const beginNativeWatch = useCallback((pressTrusted: boolean) => {
    nativePressTrustedRef.current = pressTrusted;
    nativeHiddenSeenRef.current = false;
    if (nativeVisHandlerRef.current) {
      document.removeEventListener("visibilitychange", nativeVisHandlerRef.current);
      window.removeEventListener("pagehide", nativeVisHandlerRef.current);
    }
    const onVis = () => {
      if (document.visibilityState === "hidden") nativeHiddenSeenRef.current = true;
    };
    nativeVisHandlerRef.current = onVis;
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onVis);
  }, []);

  /** Ends the watch and returns the collected press provenance. */
  const endNativeWatch = useCallback((): { pressIsTrusted?: boolean; pageHiddenDuring?: boolean } => {
    if (nativeVisHandlerRef.current) {
      document.removeEventListener("visibilitychange", nativeVisHandlerRef.current);
      window.removeEventListener("pagehide", nativeVisHandlerRef.current);
      nativeVisHandlerRef.current = null;
    }
    return {
      pressIsTrusted: nativePressTrustedRef.current,
      pageHiddenDuring: nativePressRef.current > 0 ? nativeHiddenSeenRef.current : undefined,
    };
  }, []);

  useEffect(() => {
    return () => {
      if (nativeVisHandlerRef.current) {
        document.removeEventListener("visibilitychange", nativeVisHandlerRef.current);
        window.removeEventListener("pagehide", nativeVisHandlerRef.current);
        nativeVisHandlerRef.current = null;
      }
    };
  }, []);

  const onNativeFile = useCallback(
    async (
      file: File | null,
      baseName: string,
      provenance?: { changeIsTrusted?: boolean; filesApiNative?: boolean; pressIsTrusted?: boolean; pageHiddenDuring?: boolean }
    ) => {
      if (!file) {
        pushLog("warn", "Native capture cancelled or empty");
        return;
      }
      const pressedAt = nativePressRef.current || Date.now();
      const elapsed = nativePressRef.current > 0 ? Date.now() - nativePressRef.current : undefined;
      pushLog("info", `Native capture received: ${file.name || "photo"} · ${file.type} · ${formatBytes(file.size)}${elapsed != null ? ` · ${(elapsed / 1000).toFixed(1)}s after press` : ""}${provenance?.changeIsTrusted === false ? " · SCRIPT-DISPATCHED EVENT" : ""}${provenance?.pressIsTrusted === false ? " · SCRIPT-FIRED PRESS" : ""}${provenance?.pageHiddenDuring === false ? " · page never hidden during round-trip" : ""}`);
      setLastNativePhoto({ file, label: baseName, receivedAt: Date.now() });
      const item = await addToGallery(file, "native", baseName, {
        pressedAt,
        changeIsTrusted: provenance?.changeIsTrusted,
        elapsedSincePressMs: elapsed,
        pageLoadedAt: Math.round(performance.timeOrigin),
        filesApiNative: provenance?.filesApiNative,
        pressIsTrusted: provenance?.pressIsTrusted,
        pageHiddenDuring: provenance?.pageHiddenDuring,
      });
      setLastNativePhoto((prev) => (prev && prev.file === file ? { ...prev, exportMeta: buildExifExportMeta(item) } : prev));
      downloadBlob(item.blob, item.name);
      pushLog("info", `Auto-download started for ${item.name}`);
    },
    [addToGallery, pushLog]
  );

  /** Capacitor Camera.getPhoto path for the native capture test buttons. */
  const launchCapacitorNative = useCallback(
    async (facing: "environment" | "user", baseName: string) => {
      try {
        const res = await capacitorCapturePhoto(facing, (step, note) => pushLog("debug", `Capacitor: ${step}${note ? ` — ${note}` : ""}`));
        void enforceLensPolicy(res.file, facing).then((r) => {
          const d = describeLensCheck(r, facing);
          pushLog(d.level, d.message);
        });
        const watch = endNativeWatch();
        const prov =
          res.changeIsTrusted != null && res.filesApiNative != null
            ? { changeIsTrusted: res.changeIsTrusted, filesApiNative: res.filesApiNative, ...watch }
            : undefined;
        if (!prov) pushLog("warn", "Capacitor capture: event-trust provenance was not observable — recorded as untracked, never guessed.");
        void onNativeFile(res.file, baseName, prov);
      } catch (err) {
        endNativeWatch();
        if (err instanceof CaptureCancelledError) {
          pushLog("warn", "Capacitor capture cancelled — the picker was closed without a photo");
          return;
        }
        pushLog("error", `Capacitor capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [endNativeWatch, onNativeFile, pushLog]
  );

  const runConstraintTest = useCallback(
    async (video: MediaTrackConstraints, label: string) => {
      if (selectedDeviceId) {
        video = { ...video, deviceId: { exact: selectedDeviceId } };
      } else if (!video.facingMode && !video.deviceId) {
        video = { ...video, facingMode: facingConstraint() };
      }
      await startStream(video, `${label} · facing=${facing}`);
    },
    [facing, facingConstraint, selectedDeviceId, startStream]
  );

  const runFullSuite = useCallback(
    async (target: Facing) => {
      if (!hasMediaDevices()) {
        pushLog("error", "MediaDevices API unavailable — cannot run suite");
        return;
      }
      stopStream(streamRef.current);
      streamRef.current = null;
      setStreaming(false);
      setTorchOn(false);
      if (videoRef.current) videoRef.current.srcObject = null;

      suiteAbortRef.current = false;
      setSuiteRunning(true);
      setSuiteFacing(target);
      setSuiteResults([]);
      const total = SUITE_TESTS.length;
      pushLog("info", `▶ FULL ${target === "user" ? "FRONT" : "BACK"} camera suite — ${total} requests, facingMode exact=${target}`);

      const results: SuiteTestResult[] = [];
      for (let i = 0; i < SUITE_TESTS.length; i++) {
        if (suiteAbortRef.current) {
          pushLog("warn", `Suite aborted at ${i}/${total}`);
          break;
        }
        const test = SUITE_TESTS[i];
        setSuiteProgress({ current: i + 1, total });
        const constraints = test.build(target);
        pushLog("debug", `[suite ${i + 1}/${total}] ${test.name} · ${JSON.stringify(constraints)}`);
        const started = performance.now();
        try {
          const probe = await probeConstraints(constraints);
          const granted = formatSettings(probe.settings);
          const result: SuiteTestResult = {
            id: `${target}-${i}`,
            name: test.name,
            ok: true,
            granted,
            durationMs: Math.round(performance.now() - started),
          };
          results.push(result);
          setSuiteResults([...results]);
          setPermission("granted");
          pushLog("success", `[suite] ${test.name} → GRANTED · ${granted}`);
        } catch (err) {
          const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          const result: SuiteTestResult = {
            id: `${target}-${i}`,
            name: test.name,
            ok: false,
            error: message,
            durationMs: Math.round(performance.now() - started),
          };
          results.push(result);
          setSuiteResults([...results]);
          pushLog("error", `[suite] ${test.name} → ${message}`);
        }
        // small settle delay between camera opens — some phones need it
        await new Promise((r) => setTimeout(r, 150));
      }

      const passed = results.filter((r) => r.ok).length;
      pushLog(
        passed === results.length ? "success" : "warn",
        `■ Suite finished · ${target === "user" ? "FRONT" : "BACK"} · ${passed}/${results.length} granted`
      );
      setSuiteProgress(null);
      setSuiteRunning(false);
    },
    [pushLog]
  );

  const copySuiteResults = useCallback(async () => {
    const payload = {
      facing: suiteFacing,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
      results: suiteResults.map((r) => ({
        test: r.name,
        ok: r.ok,
        granted: r.granted ?? null,
        error: r.error ?? null,
        durationMs: r.durationMs,
      })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      pushLog("success", "Suite results copied to clipboard as JSON");
    } catch (err) {
      pushLog("error", `Clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [pushLog, suiteFacing, suiteResults]);

  const stopLive = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    setStreaming(false);
    setTorchOn(false);
    if (videoRef.current) videoRef.current.srcObject = null;
    pushLog("info", "Live stream stopped");
  }, [pushLog]);

  const cropStyle = useMemo(() => {
    const scaleX = 100 / Math.max(crop.width, 1);
    const scaleY = 100 / Math.max(crop.height, 1);
    const scale = Math.max(scaleX, scaleY);
    const tx = -crop.left * scale;
    const ty = -crop.top * scale;
    return {
      transform: `translate(${tx}%, ${ty}%) scale(${scale})`,
      transformOrigin: "top left",
    } as CSSProperties;
  }, [crop]);

  const mirrorActive = facing === "user" && mirrorFront;

  const clearGallery = useCallback(() => {
    setGallery((prev) => {
      prev.forEach((item) => URL.revokeObjectURL(item.url));
      return [];
    });
    pushLog("info", "Session gallery cleared");
  }, [pushLog]);

  return (
    <div className="mx-auto min-h-dvh max-w-lg px-3 pb-10 pt-3 sm:px-4">
      <header className="mb-4 overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-card via-card to-primary/5 p-4 shadow-[0_0_40px_-18px_hsl(var(--glow)/0.55)]">
        <RouterLink to="/" className="mb-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary/90 hover:text-primary">
          <ArrowLeft className="h-3.5 w-3.5" />
          Verification Hub
        </RouterLink>
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-primary/30 bg-primary/15 text-primary">
            <Aperture className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-primary/90">Advanced Diagnostic Lab</p>
            <h1 className="mt-0.5 text-lg font-semibold leading-tight tracking-tight">
              Phone Camera & WebRTC Hub
            </h1>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Forced native capture · Full EXIF · Asymmetric constraints · Crop simulator · Impossible
              resolution / frameRate testing
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-3.5">
        <Section
          icon={<ShieldCheck className="h-4 w-4" />}
          title="Environment, Permissions & Devices"
          subtitle="Secure context, API support, permission probe, and deviceId forcing."
        >
          <div className="grid grid-cols-2 gap-2">
            {envStatuses.map((s) => (
              <StatusChip key={s.label} {...s} />
            ))}
          </div>

          <div className="control-grid grid-cols-1 sm:grid-cols-2">
            <Button className="h-11" onClick={requestPermission} disabled={busy}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              Request Camera Permission
            </Button>
            <Button className="h-11" variant="secondary" onClick={enumerateCameras} disabled={busy}>
              <ListVideo className="mr-2 h-4 w-4" />
              Enumerate All Cameras
            </Button>
          </div>

          <Field label="Force specific deviceId">
            <Select
              value={selectedDeviceId || "__facing__"}
              onValueChange={(v) => setSelectedDeviceId(v === "__facing__" ? "" : v)}
            >
              <SelectTrigger className="h-11 bg-background/60">
                <SelectValue placeholder="Use facingMode (recommended)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__facing__">— Use facingMode (recommended) —</SelectItem>
                {devices.map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${d.deviceId.slice(0, 8)}…`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-[11px] text-muted-foreground">
            Use “Enumerate Cameras” then pick a lens to force that exact camera on multi-lens phones.
          </p>

          <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-primary">
              Active camera for ALL requests
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                className="h-11"
                variant={facing === "user" ? "default" : "secondary"}
                disabled={busy || suiteRunning}
                onClick={() => void selectFacing("user")}
              >
                <User className="mr-2 h-4 w-4" />
                Front (user)
              </Button>
              <Button
                className="h-11"
                variant={facing === "environment" ? "default" : "secondary"}
                disabled={busy || suiteRunning}
                onClick={() => void selectFacing("environment")}
              >
                <Camera className="mr-2 h-4 w-4" />
                Back (environment)
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant={facingExact ? "default" : "outline"}
                onClick={() => {
                  setFacingExact((v) => {
                    pushLog("info", `facingMode strictness → ${!v ? "EXACT (hard fail if unavailable)" : "IDEAL (soft preference)"}`);
                    return !v;
                  });
                }}
              >
                {facingExact ? "facingMode: exact" : "facingMode: ideal"}
              </Button>
              <Button
                size="sm"
                variant={mirrorFront ? "default" : "outline"}
                onClick={() => setMirrorFront((v) => !v)}
              >
                {mirrorFront ? "Front mirror: on" : "Front mirror: off"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Every viewfinder start, shutter, constraint test, and permission probe below uses this camera. Exact
              mode forces OverconstrainedError when the phone cannot satisfy it.
            </p>
          </div>
        </Section>

        <Section
          icon={<Camera className="h-4 w-4" />}
          title="Live Viewfinder + Hardware Controls"
          subtitle="Flip, resolution, zoom, torch, and full-frame shutter. Crop is visual-only."
        >
          <div className="relative overflow-hidden rounded-2xl border border-border bg-black">
            <div className="relative aspect-[3/4] w-full overflow-hidden bg-zinc-950">
              <div
                className="absolute inset-0"
                style={mirrorActive ? { transform: "scaleX(-1)" } : undefined}
              >
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  autoPlay
                  className="absolute inset-0 h-full w-full object-cover"
                  style={cropStyle}
                />
              </div>
              {!streaming ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/90 text-muted-foreground">
                  <CameraOff className="h-8 w-8 opacity-60" />
                  <p className="text-sm">No live stream</p>
                  <p className="px-6 text-center text-[11px]">Start the viewfinder to test hardware controls</p>
                </div>
              ) : null}
              <div className="pointer-events-none absolute inset-0 border border-primary/20" />
              <div className="absolute left-2 top-2 rounded-md border border-primary/30 bg-black/60 px-2 py-1 text-[10px] text-primary">
                VISUAL CROP {crop.width}%×{crop.height}%
              </div>
              <div
                className={cn(
                  "absolute right-2 top-2 rounded-md border px-2 py-1 text-[10px] font-semibold",
                  facing === "user"
                    ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300"
                    : "border-primary/30 bg-black/60 text-primary"
                )}
              >
                {facing === "user" ? "FRONT" : "BACK"}{mirrorActive ? " · MIRROR" : ""}
              </div>
              {streaming ? (
                <div className="absolute bottom-2 left-2 right-2 rounded-lg border border-white/10 bg-black/65 px-2 py-1.5 mono text-[10px] text-zinc-200">
                  <div className="truncate">{grantedSettings}</div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="control-grid grid-cols-2">
            <Button className="h-11" onClick={startLive} disabled={busy}>
              <Radar className="mr-2 h-4 w-4" />
              Start Live
            </Button>
            <Button className="h-11" variant="secondary" onClick={stopLive} disabled={!streaming}>
              <CameraOff className="mr-2 h-4 w-4" />
              Stop
            </Button>
            <Button className="h-11" variant="secondary" onClick={flipCamera} disabled={busy}>
              <FlipHorizontal2 className="mr-2 h-4 w-4" />
              Flip Camera
            </Button>
            <Button
              className="h-11"
              variant={torchOn ? "default" : "secondary"}
              onClick={toggleTorch}
              disabled={!streaming || !supportsTorch}
            >
              <Flashlight className="mr-2 h-4 w-4" />
              {torchOn ? "Torch On" : "Torch Off"}
            </Button>
          </div>

          <Field label="Resolution preset">
            <Select value={preset} onValueChange={(v) => setPreset(v as ResolutionPreset)}>
              <SelectTrigger className="h-11 bg-background/60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="max">Max Native (3840×2160 ideal)</SelectItem>
                <SelectItem value="hd">HD (1920×1080)</SelectItem>
                <SelectItem value="720p">720p (1280×720)</SelectItem>
                <SelectItem value="custom">Custom (inputs below)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {preset === "custom" ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Width">
                <Input
                  inputMode="numeric"
                  value={customWidth}
                  onChange={(e) => setCustomWidth(e.target.value)}
                  className="h-11 bg-background/60"
                />
              </Field>
              <Field label="Height">
                <Input
                  inputMode="numeric"
                  value={customHeight}
                  onChange={(e) => setCustomHeight(e.target.value)}
                  className="h-11 bg-background/60"
                />
              </Field>
            </div>
          ) : null}

          <div className="space-y-2 rounded-xl border border-border/70 bg-muted/30 p-3">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-muted-foreground">Digital Zoom (applyConstraints)</span>
              <span className="mono text-primary">{zoom.toFixed(2)}×</span>
            </div>
            <Slider
              min={zoomRange?.min ?? 1}
              max={zoomRange?.max ?? 1}
              step={zoomRange?.step ?? 0.1}
              value={[zoom]}
              disabled={!zoomRange || !streaming}
              onValueChange={(v) => applyZoom(v[0] ?? 1)}
            />
            {!zoomRange ? (
              <p className="text-[11px] text-muted-foreground">Zoom not reported by current track capabilities.</p>
            ) : null}
          </div>

          <Button
            className="h-12 w-full bg-accent text-accent-foreground hover:bg-accent/90"
            onClick={executeShutter}
            disabled={!streaming || busy}
          >
            <Camera className="mr-2 h-4 w-4" />
            Execute Shutter (Full Frame)
          </Button>

          <div className="rounded-xl border border-border/60 bg-background/40 p-3 mono text-[11px] leading-relaxed text-muted-foreground">
            <div>
              <span className="text-foreground/80">Granted:</span> {grantedSettings}
            </div>
            <div className="mt-1">
              <span className="text-foreground/80">Capabilities:</span> {grantedCaps}
            </div>
            {lastError ? (
              <div className="mt-1 text-rose-300">
                <span className="text-rose-200">Last error:</span> {lastError}
              </div>
            ) : null}
          </div>
        </Section>

        <Section
          icon={<Smartphone className="h-4 w-4" />}
          title="Native Camera Request (Front & Back Forced)"
          subtitle="Brand-new photo, forced lens, no gallery. Highest EXIF fidelity path."
        >
          <CaptureEngineToggle />
          <input
            ref={nativeInputRef}
            type="file"
            accept={inputAcceptAttr(captureEngine)}
            capture={inputCaptureAttr(captureEngine, "environment")}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              if (file) {
                void enforceLensPolicy(file, "environment").then((r) => {
                  const d = describeLensCheck(r, "environment");
                  pushLog(d.level, d.message);
                });
              }
              void onNativeFile(file, "native-back-camera", {
                changeIsTrusted: e.nativeEvent?.isTrusted === true,
                filesApiNative: auditFileInputIntegrity(e.target).native,
                ...endNativeWatch(),
              });
              e.target.value = "";
            }}
          />
          <input
            ref={nativeFrontInputRef}
            type="file"
            accept={inputAcceptAttr(captureEngine)}
            capture={inputCaptureAttr(captureEngine, "user")}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              if (file) {
                void enforceLensPolicy(file, "user").then((r) => {
                  const d = describeLensCheck(r, "user");
                  pushLog(d.level, d.message);
                });
              }
              void onNativeFile(file, "native-front-camera", {
                changeIsTrusted: e.nativeEvent?.isTrusted === true,
                filesApiNative: auditFileInputIntegrity(e.target).native,
                ...endNativeWatch(),
              });
              e.target.value = "";
            }}
          />
          <Button
            className="h-12 w-full bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
            onClick={(e) => {
              nativePressRef.current = Date.now();
              beginNativeWatch(e.nativeEvent?.isTrusted === true);
              if (captureEngine === "avfoundation") {
                pushLog("info", "Opening the camera in-page (device-level) — enumerateDevices names every camera before the still is taken");
                deviceCameraCapturePhoto("environment", (step, note) => pushLog("debug", note ? `${step} — ${note}` : step), "Back camera")
                  .then((res) => {
                    pushLog(
                      "info",
                      `Device inventory: ${res.inventory.after.length} camera${res.inventory.after.length === 1 ? "" : "s"} named — ${res.inventory.after.map((d) => d.label || "(unnamed)").join(" · ") || "none"}`
                    );
                    pushLog(
                      res.origin === "platform-photo" ? "success" : "warn",
                      res.origin === "platform-photo"
                        ? "Still produced by ImageCapture.takePhoto() — platform bytes, and no camera EXIF exists on this path by design."
                        : "No ImageCapture in this browser — the frame was encoded by this app from the video track, so it is not a camera file."
                    );
                    void onNativeFile(res.file, "device-camera-back", { ...endNativeWatch() });
                  })
                  .catch((err: unknown) => {
                    endNativeWatch();
                    if (err instanceof CaptureCancelledError) pushLog("warn", "Device-level camera closed without a photo");
                    else pushLog("error", `Device-level capture failed: ${err instanceof Error ? err.message : String(err)}`);
                  });
                return;
              }
              if (captureEngine === "capacitor") {
                pushLog("info", "Opening Capacitor Camera.getPhoto() (back camera, webUseInput)");
                void launchCapacitorNative("environment", "native-back-camera");
                return;
              }
              if (captureEngine === "fs-picker") {
                pushLog("info", "Opening File System Access picker (showOpenFilePicker — no camera hint exists on this API)");
                fsPickerCapturePhoto((step, note) => pushLog("debug", note ? `${step} · ${note}` : step))
                  .then((res) => onNativeFile(res.file, "fs-picker-photo", { ...endNativeWatch() }))
                  .catch((err: unknown) => {
                    endNativeWatch();
                    if (err instanceof CaptureCancelledError) pushLog("warn", "FS Access picker closed without a file");
                    else pushLog("error", `FS Access picker failed: ${err instanceof Error ? err.message : String(err)}`);
                  });
                return;
              }
              pushLog("info", `Launching hidden input — ${engineLaunchNote(captureEngine, "environment")}`);
              nativeInputRef.current?.click();
            }}
          >
            <Camera className="mr-2 h-4 w-4" />
            TAKE PHOTO NOW (Back Camera Forced)
          </Button>
          <Button
            className="h-12 w-full bg-sky-500 text-sky-950 hover:bg-sky-400"
            onClick={(e) => {
              nativePressRef.current = Date.now();
              beginNativeWatch(e.nativeEvent?.isTrusted === true);
              if (captureEngine === "avfoundation") {
                pushLog("info", "Opening the camera in-page (device-level, front) — enumerateDevices names every camera before the still is taken");
                deviceCameraCapturePhoto("user", (step, note) => pushLog("debug", note ? `${step} — ${note}` : step), "Front camera")
                  .then((res) => {
                    pushLog(
                      "info",
                      `Device inventory: ${res.inventory.after.length} camera${res.inventory.after.length === 1 ? "" : "s"} named — ${res.inventory.after.map((d) => d.label || "(unnamed)").join(" · ") || "none"}`
                    );
                    void onNativeFile(res.file, "device-camera-front", { ...endNativeWatch() });
                  })
                  .catch((err: unknown) => {
                    endNativeWatch();
                    if (err instanceof CaptureCancelledError) pushLog("warn", "Device-level camera closed without a photo");
                    else pushLog("error", `Device-level capture failed: ${err instanceof Error ? err.message : String(err)}`);
                  });
                return;
              }
              if (captureEngine === "capacitor") {
                pushLog("info", "Opening Capacitor Camera.getPhoto() (front camera, webUseInput)");
                void launchCapacitorNative("user", "native-front-camera");
                return;
              }
              if (captureEngine === "fs-picker") {
                pushLog("info", "Opening File System Access picker (showOpenFilePicker — no camera hint exists on this API)");
                fsPickerCapturePhoto((step, note) => pushLog("debug", note ? `${step} · ${note}` : step))
                  .then((res) => onNativeFile(res.file, "fs-picker-photo", { ...endNativeWatch() }))
                  .catch((err: unknown) => {
                    endNativeWatch();
                    if (err instanceof CaptureCancelledError) pushLog("warn", "FS Access picker closed without a file");
                    else pushLog("error", `FS Access picker failed: ${err instanceof Error ? err.message : String(err)}`);
                  });
                return;
              }
              pushLog("info", `Launching hidden input — ${engineLaunchNote(captureEngine, "user")}`);
              nativeFrontInputRef.current?.click();
            }}
          >
            <User className="mr-2 h-4 w-4" />
            TAKE SELFIE NOW (Front Camera Forced)
          </Button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Both paths bypass browser JPEG re-encoding when the OS provides the original file — best chance of full
            EXIF (model, GPS, timestamp, orientation). The capture attribute requests the lens (it's the only HTML
            control that exists — the OS camera still shows flip/zoom), so the lens is enforced after capture: EXIF
            LensModel confirms which camera actually fired and DigitalZoomRatio exposes any zoom. Every native capture
            is also cross-checked for EXIF mismatch fraud: capture time vs your button press, device identity, and
            resolution plausibility.
          </p>
        </Section>

        <Section
          icon={<FileSearch className="h-4 w-4" />}
          title="Last Photo EXIF"
          subtitle="Device model, capture timestamp, GPS — parsed locally from the newest captured photo."
        >
          <LastPhotoExif shot={lastNativePhoto} />
        </Section>

        <Section
          icon={<Radar className="h-4 w-4" />}
          title="Advanced WebRTC Constraint Lab"
          subtitle="Asymmetric mins, impossible 8K / 240fps, orientation tricks. Watch the debug log."
        >
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["minWidth", "minWidth"],
                ["minHeight", "minHeight"],
                ["maxWidth", "maxWidth"],
                ["maxHeight", "maxHeight"],
                ["idealWidth", "ideal Width"],
                ["idealHeight", "ideal Height"],
                ["frameRate", "frameRate (ideal)"],
                ["aspectRatio", "aspectRatio"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  inputMode="decimal"
                  value={draft[key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  className="h-10 bg-background/60 mono text-[13px]"
                />
              </Field>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                runConstraintTest(constraintsFromDraft(draft, "only-min-width"), "ONLY minWidth")
              }
            >
              Test ONLY minWidth
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                runConstraintTest(constraintsFromDraft(draft, "only-min-height"), "ONLY minHeight")
              }
            >
              Test ONLY minHeight
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => runConstraintTest(constraintsFromDraft(draft, "both-min"), "minW + minH")}
            >
              Test Both minW + minH
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => runConstraintTest(constraintsFromDraft(draft, "only-max"), "ONLY max constraints")}
            >
              Test ONLY max constraints
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                runConstraintTest(
                  { width: { ideal: 7680 }, height: { ideal: 4320 }, facingMode: { ideal: facing } },
                  "Impossible 8K 7680×4320"
                )
              }
            >
              Test Impossible 8K
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                runConstraintTest(
                  {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    frameRate: { ideal: 240 },
                    facingMode: { ideal: facing },
                  },
                  "240fps + HD"
                )
              }
            >
              Test 240fps + High Res
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                runConstraintTest(
                  {
                    width: { min: 3840 },
                    height: { min: 2160 },
                    frameRate: { ideal: 120 },
                    facingMode: { ideal: facing },
                  },
                  "Extreme mix min 4K + 120fps"
                )
              }
            >
              Test Extreme Mix
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                runConstraintTest(
                  {
                    width: { ideal: 1080 },
                    height: { ideal: 1920 },
                    aspectRatio: { ideal: 9 / 16 },
                    facingMode: { ideal: facing },
                  },
                  "Force portrait-ish 9:16"
                )
              }
            >
              Force Portrait-ish
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                runConstraintTest(
                  {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    aspectRatio: { ideal: 16 / 9 },
                    facingMode: { ideal: facing },
                  },
                  "Force landscape-ish 16:9"
                )
              }
            >
              Force Landscape-ish
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                runConstraintTest(
                  { aspectRatio: { ideal: 16 / 9 }, facingMode: { ideal: facing } },
                  "aspectRatio 16/9 only"
                )
              }
            >
              Test aspectRatio 16/9
            </Button>
          </div>

          <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              facingMode forcing (front vs back)
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || suiteRunning}
                onClick={() => startStream({ facingMode: { exact: "user" } }, "facingMode EXACT user (front)")}
              >
                Exact FRONT
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || suiteRunning}
                onClick={() =>
                  startStream({ facingMode: { exact: "environment" } }, "facingMode EXACT environment (back)")
                }
              >
                Exact BACK
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || suiteRunning}
                onClick={() => startStream({ facingMode: { ideal: "user" } }, "facingMode IDEAL user (front)")}
              >
                Ideal FRONT
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || suiteRunning}
                onClick={() => startStream({}, "video:true — browser default camera pick")}
              >
                Default pick
              </Button>
            </div>
          </div>

          <Button
            className="h-11 w-full"
            disabled={busy}
            onClick={() =>
              runConstraintTest(constraintsFromDraft(draft, "full"), "Restart with current constraint values")
            }
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Restart Live Stream with Current Values
          </Button>
          <p className="text-[11px] text-muted-foreground">
            These buttons simulate real website constraint patterns and run against the active camera (
            {facing === "user" ? "FRONT" : "BACK"}). Watch the console for grants, clamps, and errors.
          </p>
        </Section>

        <Section
          icon={<ScanFace className="h-4 w-4" />}
          title="Automated Camera Test Suite"
          subtitle="Runs EVERY request pattern in this app against the front (or back) camera with facingMode exact, then reports grants, clamps, and errors."
        >
          <div className="grid grid-cols-2 gap-2">
            <Button
              className="h-12 bg-sky-500 text-sky-950 hover:bg-sky-400"
              disabled={busy || suiteRunning}
              onClick={() => void runFullSuite("user")}
            >
              <Play className="mr-2 h-4 w-4" />
              Run FRONT Suite
            </Button>
            <Button
              className="h-12"
              variant="secondary"
              disabled={busy || suiteRunning}
              onClick={() => void runFullSuite("environment")}
            >
              <Play className="mr-2 h-4 w-4" />
              Run BACK Suite
            </Button>
          </div>

          {suiteRunning ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-muted-foreground">
                  Testing {suiteFacing === "user" ? "FRONT" : "BACK"} camera…{" "}
                  {suiteProgress ? `${suiteProgress.current}/${suiteProgress.total}` : ""}
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    suiteAbortRef.current = true;
                    pushLog("warn", "Suite abort requested");
                  }}
                >
                  <Square className="mr-1.5 h-3.5 w-3.5" />
                  Stop
                </Button>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{
                    width: suiteProgress ? `${(suiteProgress.current / suiteProgress.total) * 100}%` : "0%",
                  }}
                />
              </div>
            </div>
          ) : null}

          {suiteResults.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[12px]">
                  <span className="font-semibold">
                    {suiteFacing === "user" ? "FRONT" : "BACK"} camera:
                  </span>{" "}
                  <span className="text-emerald-300">{suiteResults.filter((r) => r.ok).length} granted</span>
                  {" · "}
                  <span className="text-rose-300">{suiteResults.filter((r) => !r.ok).length} rejected</span>
                  {" · "}
                  <span className="text-muted-foreground">{suiteResults.length} total</span>
                </div>
                <Button size="sm" variant="outline" onClick={() => void copySuiteResults()}>
                  Copy JSON
                </Button>
              </div>
              <div className="max-h-80 space-y-1.5 overflow-y-auto rounded-xl border border-border/70 bg-black/40 p-2">
                {suiteResults.map((r) => (
                  <div
                    key={r.id}
                    className={cn(
                      "rounded-lg border px-2.5 py-2",
                      r.ok ? "border-emerald-500/25 bg-emerald-500/5" : "border-rose-500/25 bg-rose-500/5"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12px] font-medium">{r.name}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                          r.ok ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
                        )}
                      >
                        {r.ok ? "GRANTED" : "REJECTED"}
                      </span>
                    </div>
                    <div className="mt-0.5 break-words mono text-[10px] leading-snug text-muted-foreground">
                      {r.ok ? r.granted : r.error} · {r.durationMs}ms
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            !suiteRunning && (
              <p className="text-[11px] text-muted-foreground">
                Runs all {SUITE_TESTS.length} request patterns sequentially: facingMode exact/ideal, every resolution
                preset, asymmetric mins, impossible 8K / 240fps, aspect ratios, and extreme mixes. The live stream is
                stopped during the run.
              </p>
            )
          )}
        </Section>

        <Section
          icon={<Fingerprint className="h-4 w-4" />}
          title="Fraud Lab — Identity & Media Fraud Toolkit"
          subtitle="Media forensics with ultra-detailed evidence trails, document tamper checks, on-device face match, and a smile + pulse (rPPG) liveness test with screen-replay and virtual-camera detection."
        >
          <FraudLab pushLog={pushLog} logs={logs} />
        </Section>

        <Section
          icon={<Aperture className="h-4 w-4" />}
          title="Visual Crop Simulator"
          subtitle="What the user sees vs full capture. Shutter always downloads the uncropped sensor frame."
        >
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ["left", "Crop Left %"],
                ["top", "Crop Top %"],
                ["width", "Crop Width %"],
                ["height", "Crop Height %"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="mono text-primary">{crop[key]}%</span>
                </div>
                <Slider
                  min={key === "width" || key === "height" ? 10 : 0}
                  max={100}
                  step={1}
                  value={[crop[key]]}
                  onValueChange={(v) => {
                    const next = v[0] ?? crop[key];
                    setCrop((c) => {
                      const updated = { ...c, [key]: next };
                      if (updated.left + updated.width > 100) {
                        if (key === "left") updated.width = Math.max(10, 100 - updated.left);
                        if (key === "width") updated.left = Math.max(0, 100 - updated.width);
                      }
                      if (updated.top + updated.height > 100) {
                        if (key === "top") updated.height = Math.max(10, 100 - updated.top);
                        if (key === "height") updated.top = Math.max(0, 100 - updated.height);
                      }
                      return updated;
                    });
                  }}
                />
              </div>
            ))}
          </div>
          <Button variant="secondary" className="h-10 w-full" onClick={() => setCrop(defaultCrop())}>
            Reset Crop to Full
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Visual only. Every shutter / native capture still yields the full uncropped file with original EXIF.
          </p>
        </Section>

        <Section
          icon={<ListVideo className="h-4 w-4" />}
          title="System Debug Console"
          subtitle="Real-time getUserMedia results, settings, capabilities, errors, EXIF status."
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{logs.length} entries</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLogs([]);
                pushLog("info", "Log cleared");
              }}
            >
              <Eraser className="mr-1.5 h-3.5 w-3.5" />
              Clear Log
            </Button>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-border/70 bg-black/50 p-3 mono text-[11px] leading-relaxed">
            {logs.length === 0 ? (
              <div className="text-muted-foreground">No log entries yet.</div>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className={cn("mb-1.5 break-words", `log-${entry.level}`)}>
                  <span className="opacity-60">[{entry.ts}]</span>{" "}
                  <span className="uppercase opacity-70">{entry.level}</span> · {entry.message}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </Section>

        <Section
          icon={<Download className="h-4 w-4" />}
          title="Session Gallery"
          subtitle="Local only — full original binaries with EXIF. Use download on any item."
        >
          <div className="flex items-center justify-between">
            <p className="text-[12px] text-muted-foreground">{gallery.length} capture(s) this session</p>
            <Button size="sm" variant="outline" onClick={clearGallery} disabled={!gallery.length}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Clear
            </Button>
          </div>

          {gallery.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/80 px-4 py-8 text-center text-[13px] text-muted-foreground">
              Captures appear here. Files stay in this tab until you download or clear.
            </div>
          ) : (
            <div className="space-y-3">
              {gallery.map((item) => (
                <div key={item.id} className="overflow-hidden rounded-xl border border-border/70 bg-background/40">
                  <div className="flex gap-3 p-3">
                    <img
                      src={item.url}
                      alt={item.name}
                      className="h-20 w-16 shrink-0 rounded-lg object-cover ring-1 ring-border"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{item.name}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {item.source} · {item.createdAt} · {formatBytes(item.size)}
                        {item.dimensions ? ` · ${item.dimensions.width}×${item.dimensions.height}` : ""}
                      </div>
                      <div
                        className={cn(
                          "mt-1 text-[11px]",
                          item.hasExif ? "text-emerald-300" : "text-amber-200"
                        )}
                      >
                        {item.binaryMarkers}
                      </div>
                      <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                        {item.exifSummary}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {item.fraud ? (
                          <button
                            type="button"
                            className={cn(
                              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-left text-[10px] font-semibold",
                              FRAUD_BADGE[item.fraud.verdict]
                            )}
                            onClick={() =>
                              setExpandedFraudId((prev) => (prev === item.id ? null : item.id))
                            }
                          >
                            <Fingerprint className="h-3 w-3" />
                            {item.fraud.verdictLabel} · {item.fraud.score}/100
                            <span className="opacity-60">
                              {expandedFraudId === item.id ? "▲" : "▼"}
                            </span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-left text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
                          aria-expanded={expandedExifId === item.id}
                          onClick={() => setExpandedExifId((prev) => (prev === item.id ? null : item.id))}
                        >
                          <FileSearch className="h-3 w-3" />
                          EXIF
                          <span className="opacity-60">{expandedExifId === item.id ? "▲" : "▼"}</span>
                        </button>
                      </div>
                      <Button
                        size="sm"
                        className="mt-2 h-8"
                        onClick={() => {
                          downloadBlob(item.blob, item.name);
                          pushLog("info", `Download: ${item.name}`);
                        }}
                      >
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        Download Original
                      </Button>
                    </div>
                  </div>
                  {item.fraud && expandedFraudId === item.id ? (
                    <div className="space-y-1.5 border-t border-border/60 bg-black/30 p-2.5">
                      {item.fraud.findings.map((f) => (
                        <FindingRow key={f.id} finding={f} />
                      ))}
                    </div>
                  ) : null}
                  {expandedExifId === item.id ? (
                    <div className="border-t border-border/60 bg-black/30 p-2.5">
                      <ExifInspector file={item.blob} exportMeta={buildExifExportMeta(item)} />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Section>

        <footer className="px-1 pb-2 pt-1 text-center text-[11px] text-muted-foreground">
          Open on a real phone over HTTPS. After first load, only ExifReader needs network (bundled here via npm).
        </footer>
      </div>
    </div>
  );
};

export default Index;
