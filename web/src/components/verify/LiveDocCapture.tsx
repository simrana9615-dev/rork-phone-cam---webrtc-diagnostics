import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, ShieldAlert, ShieldCheck, Zap, ZapOff, ZoomIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import CameraErrorHelp, { classifyCameraError, type CameraErrorInfo } from "@/components/CameraErrorHelp";
import { captureFromVideo, stopStream, trackSettings, type LogLevel } from "@/lib/camera-diagnostics";
import type { PackOrigin } from "@/lib/evidence-pack";
import {
  ledgerBeginFeed,
  ledgerFeedDenied,
  ledgerFeedFirstFrame,
  ledgerFeedGranted,
  ledgerFeedResolutionChange,
  ledgerFeedStopped,
  ledgerFeedTelemetry,
  ledgerFrameEncoded,
  ledgerRecordFrame,
} from "@/lib/capture-ledger";
import { DocAlignmentAnalyzer, type AlignmentSnapshot, type CornerLocks } from "@/lib/doc-align";
import { injectionFindings, runInjectionAudit, type InjectionAuditResult } from "@/lib/injection-guard";
import type { Finding } from "@/lib/fraud-detection";

/**
 * Live WebRTC document viewfinder: opens the back camera at maximum
 * resolution and frame rate, shows a live measured-fps counter and the active
 * track settings, overlays a document framing guide, and captures the frame
 * on tap — preferring a FULL-RESOLUTION still photo via the ImageCapture API
 * (often far larger than the video frame) with a video-frame fallback.
 * Torch and optical/digital zoom controls appear when the hardware supports
 * them — sharper MRZ lines and portraits improve every downstream check.
 *
 * Orientation-aware: the viewfinder box adopts the ACTUAL orientation of the
 * delivered stream (portrait phones get portrait frames, desktops/tablets get
 * landscape) and renders with object-contain, so what the user sees is
 * exactly the frame that gets captured — no hidden crop between the framing
 * guide and the forensic capture. The guide itself sizes against whichever
 * axis binds (width in portrait, height in landscape).
 */
const MIN_VIEW_ASPECT = 9 / 16;
const MAX_VIEW_ASPECT = 16 / 9;

/** Alignment analysis cadence and the consecutive good ticks auto-capture needs (~1.1s). */
const ALIGN_INTERVAL_MS = 220;
const READY_TICKS = 5;

/** Corner bracket placement + border sides for the four guide corners. */
const CORNER_STYLES: { key: keyof CornerLocks; cls: string }[] = [
  { key: "tl", cls: "-left-0.5 -top-0.5 rounded-tl-xl border-l-[3px] border-t-[3px]" },
  { key: "tr", cls: "-right-0.5 -top-0.5 rounded-tr-xl border-r-[3px] border-t-[3px]" },
  { key: "br", cls: "-bottom-0.5 -right-0.5 rounded-br-xl border-b-[3px] border-r-[3px]" },
  { key: "bl", cls: "-bottom-0.5 -left-0.5 rounded-bl-xl border-b-[3px] border-l-[3px]" },
];

type ImageCaptureLike = {
  takePhoto(opts?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
  getPhotoCapabilities(): Promise<{ imageWidth?: { max?: number }; imageHeight?: { max?: number } }>;
};
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  zoom?: { min?: number; max?: number; step?: number };
};
type ExtendedConstraintSet = MediaTrackConstraintSet & { torch?: boolean; zoom?: number };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export default function LiveDocCapture({
  guideAspect,
  hint,
  pushLog,
  onCapture,
}: {
  guideAspect: number;
  hint: string;
  pushLog: (level: LogLevel, message: string) => void;
  onCapture: (blob: Blob, meta: string, channelFindings: Finding[], origin: PackOrigin) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameTimesRef = useRef<number[]>([]);
  const fpsTimerRef = useRef<number | null>(null);
  const cancelFrameCbRef = useRef<(() => void) | null>(null);
  /** Capture Feed Ledger bookkeeping: feed id, total frames observed, last seen dims. */
  const ledgerFeedIdRef = useRef<string | null>(null);
  const frameCountRef = useRef<number>(0);
  const lastDimsRef = useRef<{ w: number; h: number } | null>(null);

  const [starting, setStarting] = useState<boolean>(true);
  const [error, setError] = useState<CameraErrorInfo | null>(null);
  const [settingsLine, setSettingsLine] = useState<string>("");
  const [measuredFps, setMeasuredFps] = useState<number>(0);
  const [capturing, setCapturing] = useState<boolean>(false);
  const [channelStatus, setChannelStatus] = useState<InjectionAuditResult["verdict"] | null>(null);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const [torchSupported, setTorchSupported] = useState<boolean>(false);
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [zoomCaps, setZoomCaps] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [align, setAlign] = useState<AlignmentSnapshot | null>(null);
  const [autoCapture, setAutoCapture] = useState<boolean>(true);
  const [readyProgress, setReadyProgress] = useState<number>(0);

  const analyzerRef = useRef<DocAlignmentAnalyzer | null>(null);
  const alignTimerRef = useRef<number | null>(null);
  const readyTicksRef = useRef<number>(0);
  const autoFiredRef = useRef<boolean>(false);
  const autoRef = useRef<boolean>(true);
  const capturingRef = useRef<boolean>(false);
  const captureRef = useRef<() => void>(() => {});
  const guideAspectRef = useRef<number>(guideAspect);

  useEffect(() => {
    guideAspectRef.current = guideAspect;
  }, [guideAspect]);

  useEffect(() => {
    autoRef.current = autoCapture;
    if (!autoCapture) {
      readyTicksRef.current = 0;
      setReadyProgress(0);
    }
  }, [autoCapture]);

  const stop = useCallback(() => {
    cancelFrameCbRef.current?.();
    cancelFrameCbRef.current = null;
    if (fpsTimerRef.current != null) window.clearInterval(fpsTimerRef.current);
    fpsTimerRef.current = null;
    if (alignTimerRef.current != null) window.clearInterval(alignTimerRef.current);
    alignTimerRef.current = null;
    const fid = ledgerFeedIdRef.current;
    if (fid && streamRef.current) {
      const times = frameTimesRef.current;
      let fps: number | null = null;
      if (times.length >= 2) {
        const span = times[times.length - 1] - times[0];
        if (span > 0) fps = Math.round(((times.length - 1) / span) * 1000);
      }
      ledgerFeedTelemetry(fid, frameCountRef.current, fps);
      ledgerFeedStopped(fid);
      ledgerFeedIdRef.current = null;
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.onresize = null;
      videoRef.current.srcObject = null;
    }
  }, []);

  const start = useCallback(async () => {
    stop();
    setStarting(true);
    setError(null);
    setTorchSupported(false);
    setTorchOn(false);
    setZoomCaps(null);
    frameTimesRef.current = [];
    frameCountRef.current = 0;
    lastDimsRef.current = null;
    setMeasuredFps(0);
    pushLog("info", "Doc capture: requesting back camera at max resolution + max fps…");
    const gumConstraints: MediaStreamConstraints = {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 4096 },
        height: { ideal: 2160 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    };
    const feedId = ledgerBeginFeed("Live document viewfinder (back camera, max resolution + fps)", gumConstraints);
    ledgerFeedIdRef.current = feedId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(gumConstraints);
      streamRef.current = stream;
      void ledgerFeedGranted(feedId, stream);
      const video = videoRef.current;
      if (!video) throw new Error("Video element unavailable");
      video.srcObject = stream;
      await video.play();
      ledgerFeedFirstFrame(feedId);

      const track = stream.getVideoTracks()[0];
      const s = trackSettings(track);
      const line = s
        ? `${s.width ?? "?"}×${s.height ?? "?"} @ ${s.frameRate ? Math.round(s.frameRate) : "?"}fps · ${track?.label ?? "camera"}`
        : track?.label ?? "camera";
      setSettingsLine(line);
      pushLog("success", `Doc capture: stream active — ${line}`);

      // Hardware controls: torch + zoom when the sensor exposes them.
      try {
        const caps = (track?.getCapabilities?.() ?? {}) as ExtendedCapabilities;
        if (caps.torch === true) {
          setTorchSupported(true);
          pushLog("debug", "Doc capture: torch is available on this camera");
        }
        if (caps.zoom && typeof caps.zoom.max === "number" && typeof caps.zoom.min === "number" && caps.zoom.max > caps.zoom.min) {
          const zc = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step && caps.zoom.step > 0 ? caps.zoom.step : 0.1 };
          setZoomCaps(zc);
          const current = (trackSettings(track) as (MediaTrackSettings & { zoom?: number }) | null)?.zoom;
          setZoom(typeof current === "number" ? current : zc.min);
          pushLog("debug", `Doc capture: zoom available ${zc.min}–${zc.max} (step ${zc.step})`);
        }
      } catch {
        // capabilities probing is best-effort
      }

      const updateAspect = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          const aspect = video.videoWidth / video.videoHeight;
          const prevDims = lastDimsRef.current;
          if (prevDims && (prevDims.w !== video.videoWidth || prevDims.h !== video.videoHeight)) {
            ledgerFeedResolutionChange(feedId, `${prevDims.w}×${prevDims.h}`, `${video.videoWidth}×${video.videoHeight}`);
          }
          lastDimsRef.current = { w: video.videoWidth, h: video.videoHeight };
          setVideoAspect(aspect);
          pushLog(
            "debug",
            `Doc capture: delivered frame ${video.videoWidth}×${video.videoHeight} — ${aspect >= 1 ? "LANDSCAPE" : "PORTRAIT"} orientation (viewfinder matched, zero display crop)`
          );
        }
      };
      updateAspect();
      // Browsers fire resize on the element when frame dimensions change (device rotation mid-stream).
      video.onresize = updateAspect;

      // Early capture-channel audit for live feedback; a fresh audit re-runs at capture time.
      void runInjectionAudit({ stream, video, log: (m) => pushLog("debug", `Doc capture: ${m}`) })
        .then((a) => setChannelStatus(a.verdict))
        .catch(() => undefined);

      const onFrame = (now: number) => {
        frameCountRef.current += 1;
        frameTimesRef.current.push(now);
        if (frameTimesRef.current.length > 120) frameTimesRef.current.shift();
      };
      const vAny = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number) => void) => number;
        cancelVideoFrameCallback?: (id: number) => void;
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
      fpsTimerRef.current = window.setInterval(() => {
        const times = frameTimesRef.current;
        if (times.length < 2) return;
        const spanMs = times[times.length - 1] - times[0];
        if (spanMs > 0) setMeasuredFps(Math.round(((times.length - 1) / spanMs) * 1000));
      }, 500);

      // Live alignment guidance + auto-capture: analyze a downscaled frame
      // every tick, coach the user via the overlay, and fire the capture once
      // the document has been aligned, sharp, lit, and steady long enough.
      readyTicksRef.current = 0;
      autoFiredRef.current = false;
      setReadyProgress(0);
      setAlign(null);
      if (!analyzerRef.current) analyzerRef.current = new DocAlignmentAnalyzer();
      analyzerRef.current.reset();
      alignTimerRef.current = window.setInterval(() => {
        const v = videoRef.current;
        if (!v || v.readyState < 2 || capturingRef.current || autoFiredRef.current) return;
        const snap = analyzerRef.current?.analyze(v, guideAspectRef.current);
        if (!snap) return;
        setAlign(snap);
        readyTicksRef.current = snap.ready ? Math.min(READY_TICKS, readyTicksRef.current + 1) : Math.max(0, readyTicksRef.current - 2);
        setReadyProgress(readyTicksRef.current / READY_TICKS);
        if (autoRef.current && readyTicksRef.current >= READY_TICKS) {
          autoFiredRef.current = true;
          pushLog(
            "success",
            `Doc capture: AUTO — document aligned, flat (skew ${snap.skewPct ?? "n/a"}%), sharp (${snap.sharpness}) and steady for ${((READY_TICKS * ALIGN_INTERVAL_MS) / 1000).toFixed(1)}s, capturing now`
          );
          captureRef.current();
        }
      }, ALIGN_INTERVAL_MS);
      setStarting(false);
    } catch (err) {
      const info = classifyCameraError(err);
      if (ledgerFeedIdRef.current && !streamRef.current) {
        ledgerFeedDenied(ledgerFeedIdRef.current, `${info.kind}: ${info.message}`);
        ledgerFeedIdRef.current = null;
      }
      setError(info);
      setStarting(false);
      pushLog("error", `Doc capture failed to start (${info.kind}): ${info.message}`);
    }
  }, [pushLog, stop]);

  useEffect(() => {
    void start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as ExtendedConstraintSet] });
      setTorchOn(next);
      pushLog("info", `Doc capture: torch ${next ? "ON" : "off"}`);
    } catch (err) {
      pushLog("warn", `Doc capture: torch toggle failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [pushLog, torchOn]);

  const applyZoom = useCallback(
    async (value: number) => {
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track || !zoomCaps) return;
      const clamped = Math.max(zoomCaps.min, Math.min(zoomCaps.max, value));
      setZoom(clamped);
      try {
        await track.applyConstraints({ advanced: [{ zoom: clamped } as ExtendedConstraintSet] });
      } catch (err) {
        pushLog("warn", `Doc capture: zoom failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [pushLog, zoomCaps]
  );

  /**
   * Prefers ImageCapture.takePhoto() at the sensor's max photo resolution —
   * on modern phones this yields a still far larger than the video frame.
   * Falls back to the video-frame grab if unsupported or slower/smaller.
   */
  const grabBestStill = useCallback(
    async (video: HTMLVideoElement): Promise<{ blob: Blob; width: number; height: number; method: string; origin: PackOrigin }> => {
      const track = streamRef.current?.getVideoTracks()[0];
      const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
      if (IC && track && track.readyState === "live") {
        try {
          const ic = new IC(track);
          let photo: Blob | null = null;
          try {
            const caps = await withTimeout(ic.getPhotoCapabilities(), 2000, "getPhotoCapabilities");
            const maxW = caps.imageWidth?.max;
            const maxH = caps.imageHeight?.max;
            if (maxW && maxH) {
              photo = await withTimeout(ic.takePhoto({ imageWidth: maxW, imageHeight: maxH }), 5000, "takePhoto(max)");
            }
          } catch {
            photo = null;
          }
          if (!photo) photo = await withTimeout(ic.takePhoto(), 5000, "takePhoto");
          const bmp = await createImageBitmap(photo);
          const w = bmp.width;
          const h = bmp.height;
          bmp.close();
          if (w >= video.videoWidth && h >= video.videoHeight) {
            // Encoded by the platform's photo pipeline, not by us.
            return { blob: photo, width: w, height: h, method: `ImageCapture still (${w}×${h})`, origin: "platform-photo" };
          }
          pushLog("debug", `Doc capture: still photo ${w}×${h} smaller than the video frame — using the video frame instead`);
        } catch (err) {
          pushLog("debug", `Doc capture: ImageCapture unavailable/failed (${err instanceof Error ? err.message : String(err)}) — using video frame`);
        }
      }
      // Drawn to a canvas and encoded here — not a camera file, and the pack must say so.
      const blob = await captureFromVideo(video);
      return { blob, width: video.videoWidth, height: video.videoHeight, method: "video frame", origin: "app-encoded-frame" };
    },
    [pushLog]
  );

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || capturingRef.current) return;
    capturingRef.current = true;
    setCapturing(true);
    try {
      if (navigator.vibrate) navigator.vibrate(30);
      // Audit the channel at the moment of truth — APIs, device anchor, dual-path readback — then grab the frame.
      const audit = await runInjectionAudit({ stream: streamRef.current, video, log: (m) => pushLog("debug", `Doc capture: ${m}`) });
      setChannelStatus(audit.verdict);
      pushLog(audit.verdict === "clean" ? "success" : audit.verdict === "suspicious" ? "warn" : "error", `Doc capture channel: ${audit.summary}`);
      const still = await grabBestStill(video);
      const fid = ledgerFeedIdRef.current;
      if (fid) {
        const frameId = ledgerRecordFrame(fid, `document still — ${still.method}`, still.width, still.height);
        ledgerFrameEncoded(frameId, still.blob.type || "image/jpeg", still.method === "video frame" ? 0.95 : null, still.blob.size);
      }
      const orientation = still.width >= still.height ? "landscape" : "portrait";
      const meta = `Live WebRTC ${still.method} · ${still.width}×${still.height} (${orientation}) · measured ${measuredFps}fps · ${settingsLine}${torchOn ? " · torch ON" : ""}${zoomCaps && zoom > zoomCaps.min ? ` · zoom ${zoom.toFixed(1)}×` : ""} · channel ${audit.verdict}`;
      pushLog("success", `Doc capture: ${still.method} — ${still.width}×${still.height} (${(still.blob.size / 1024).toFixed(0)} KB) at ${measuredFps}fps measured`);
      stop();
      onCapture(still.blob, meta, injectionFindings(audit), still.origin);
    } catch (err) {
      pushLog("error", `Doc capture failed: ${err instanceof Error ? err.message : String(err)}`);
      capturingRef.current = false;
      autoFiredRef.current = false;
      readyTicksRef.current = 0;
      setReadyProgress(0);
      setCapturing(false);
    }
  }, [grabBestStill, measuredFps, onCapture, pushLog, settingsLine, stop, torchOn, zoom, zoomCaps]);

  useEffect(() => {
    captureRef.current = () => void capture();
  }, [capture]);

  return (
    <div className="space-y-3">
      <div
        className="relative overflow-hidden rounded-2xl bg-black ring-1 ring-border"
        style={{ aspectRatio: `${Math.min(MAX_VIEW_ASPECT, Math.max(MIN_VIEW_ASPECT, videoAspect ?? 3 / 4))}` }}
      >
        <video ref={videoRef} playsInline muted className="h-full w-full object-contain" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div
            className={`relative rounded-xl border-2 transition-all duration-300 ${
              align?.ready
                ? "border-emerald-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.35),0_0_24px_2px_rgba(52,211,153,0.5)]"
                : align?.docDetected
                  ? "border-dashed border-amber-300 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
                  : "border-dashed border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
            }`}
            style={
              Math.min(MAX_VIEW_ASPECT, Math.max(MIN_VIEW_ASPECT, videoAspect ?? 3 / 4)) <= guideAspect
                ? { width: "100%", aspectRatio: `${guideAspect}` }
                : { height: "100%", aspectRatio: `${guideAspect}` }
            }
          >
            {/* Corner locks: each bracket lights up when both adjacent document edges are detected near that corner. */}
            {CORNER_STYLES.map((c) => (
              <div
                key={c.key}
                className={`absolute h-6 w-6 transition-colors duration-300 ${c.cls} ${
                  align?.corners?.[c.key] ? "border-emerald-400" : align?.docDetected ? "border-amber-300/80" : "border-white/45"
                }`}
              />
            ))}
            {/* Centre alignment cross — subtle target for holding the phone directly above the document. */}
            <div className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-white/30" />
            <div className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-white/30" />
            {/* Live perspective-skew readout — watch the distortion shrink as the phone levels out. */}
            {align?.skewPct != null ? (
              <span
                className={`mono absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[9.5px] font-bold transition-colors ${
                  align.flat ? "text-emerald-300" : "text-amber-300"
                }`}
              >
                skew {align.skewPct}%{align.flat ? " · flat" : ""}
              </span>
            ) : null}
            {autoCapture && readyProgress > 0 ? (
              <div className="absolute inset-x-3 bottom-2 h-1 overflow-hidden rounded-full bg-white/20">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-[width] duration-200 ease-linear"
                  style={{ width: `${Math.round(readyProgress * 100)}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/80 to-transparent p-2.5">
          <span className="mono min-w-0 flex-1 truncate text-[10px] text-white/80">{settingsLine || "starting…"}</span>
          <button
            type="button"
            className={`mono shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold transition-colors ${
              autoCapture ? "bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-400/40" : "bg-black/50 text-white/60 ring-1 ring-white/20"
            }`}
            onClick={() => {
              const next = !autoCapture;
              pushLog("info", `Doc capture: auto-capture ${next ? "enabled" : "disabled"}`);
              setAutoCapture(next);
            }}
          >
            AUTO {autoCapture ? "ON" : "OFF"}
          </button>
          <span className="mono shrink-0 rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-bold text-emerald-300">{measuredFps} fps</span>
        </div>
        {!starting && !error ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2.5 flex justify-center px-14">
            <span
              className={`max-w-full truncate rounded-full px-3 py-1 text-[11px] font-semibold transition-colors duration-300 ${
                align?.ready
                  ? "bg-emerald-500/90 text-emerald-950"
                  : align?.docDetected
                    ? "bg-amber-400/90 text-amber-950"
                    : "bg-black/60 text-white/90 ring-1 ring-white/15"
              }`}
            >
              {capturing
                ? "Capturing…"
                : align
                  ? align.ready && autoCapture
                    ? readyProgress >= 1
                      ? "Capturing…"
                      : "Perfect — hold it there"
                    : align.ready
                      ? "Ready — tap Capture"
                      : align.hint
                  : "Looking for the document…"}
            </span>
          </div>
        ) : null}
        {channelStatus ? (
          <div className="absolute left-2 top-9">
            <span
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                channelStatus === "clean" ? "bg-emerald-500/25 text-emerald-200" : channelStatus === "suspicious" ? "bg-amber-500/25 text-amber-200" : "bg-rose-500/30 text-rose-200"
              }`}
            >
              {channelStatus === "clean" ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
              {channelStatus === "clean" ? "channel verified" : channelStatus === "suspicious" ? "channel anomaly" : "INJECTED FEED"}
            </span>
          </div>
        ) : null}
        {torchSupported && !starting ? (
          <button
            type="button"
            className={`absolute right-2 top-9 flex h-10 w-10 items-center justify-center rounded-full ring-1 transition-colors ${
              torchOn ? "bg-amber-400 text-amber-950 ring-amber-300" : "bg-black/55 text-white/85 ring-white/25"
            }`}
            onClick={() => void toggleTorch()}
          >
            {torchOn ? <Zap className="h-5 w-5" /> : <ZapOff className="h-5 w-5" />}
          </button>
        ) : null}
        {starting ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Loader2 className="h-8 w-8 animate-spin text-white/60" />
          </div>
        ) : null}
      </div>
      {zoomCaps && !starting && !error ? (
        <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/40 px-3 py-2">
          <ZoomIn className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="range"
            min={zoomCaps.min}
            max={zoomCaps.max}
            step={zoomCaps.step}
            value={zoom}
            className="h-6 min-w-0 flex-1 accent-emerald-400"
            onChange={(e) => void applyZoom(Number(e.target.value))}
          />
          <span className="mono w-10 shrink-0 text-right text-[11px] text-muted-foreground">{zoom.toFixed(1)}×</span>
        </div>
      ) : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      {error ? (
        <CameraErrorHelp info={error} onRetry={() => void start()} />
      ) : (
        <Button
          className="h-14 w-full bg-emerald-500 text-[15px] font-semibold text-emerald-950 hover:bg-emerald-400 active:scale-[0.98]"
          disabled={starting || capturing}
          onClick={() => void capture()}
        >
          {capturing ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Camera className="mr-2 h-5 w-5" />}
          {capturing ? "Capturing…" : autoCapture ? "Capture Now (auto is armed)" : "Capture Full Frame"}
        </Button>
      )}
    </div>
  );
}
