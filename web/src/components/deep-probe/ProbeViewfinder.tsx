import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Camera, X, ZoomIn } from "lucide-react";

import { CaptureCancelledError } from "@/lib/capture-engine";
import type { PackOrigin } from "@/lib/evidence-pack";

/**
 * A full-screen viewfinder pinned to ONE named camera, opened imperatively for
 * a single deliberate shot.
 *
 * It exists separately from the verification flow's device camera sheet because
 * Deep Probe needs something that sheet does not offer: pinning a specific
 * `deviceId` and holding a specific zoom factor while the user frames the shot.
 * The HUD states, before the shutter is pressed, which physical camera is open,
 * what the platform actually granted, and which of the two still paths will be
 * used — so nothing about the resulting file has to be inferred afterwards.
 */

export type ProbeShot = {
  blob: Blob;
  origin: PackOrigin;
  path: "image-capture" | "canvas";
  width: number;
  height: number;
  /** What the track reported while this shot was taken. */
  granted: string;
  /** Zoom actually in force, when the camera exposes zoom at all. */
  zoomApplied: number | null;
  /** Stated plainly when a zoom step was asked for and the camera has no zoom control. */
  zoomNote: string;
};

/**
 * Which end of the zoom range to hold. Resolved against the camera's own
 * reported range rather than a hardcoded factor, because "2x" means different
 * things on different lenses and inventing a number would misdescribe the shot.
 */
export type ZoomTarget = "min" | "mid" | "max" | null;

type PhotoCaps = { imageWidth?: { max?: number }; imageHeight?: { max?: number } };
type ImageCaptureLike = { takePhoto: (s?: { imageWidth?: number; imageHeight?: number }) => Promise<Blob>; getPhotoCapabilities: () => Promise<PhotoCaps> };
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

function imageCaptureCtor(): ImageCaptureCtor | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture ?? null;
}

function blobDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0 });
    };
    img.src = url;
  });
}

type ViewfinderProps = {
  deviceId: string | null;
  deviceLabel: string;
  purpose: string;
  /** Which end of the camera's own zoom range to hold, or null for its default. */
  zoom: ZoomTarget;
  onDone: (shot: ProbeShot) => void;
  onCancel: () => void;
};

/** `advanced` constraint sets predate zoom in the DOM types; the cast is kept to this one helper. */
function zoomConstraint(zoom: number): MediaTrackConstraints {
  return { advanced: [{ zoom }] } as unknown as MediaTrackConstraints;
}

function resolveZoom(target: Exclude<ZoomTarget, null>, min: number, max: number): number {
  if (target === "min") return min;
  if (target === "max") return max;
  return min + (max - min) / 2;
}

function Viewfinder({ deviceId, deviceLabel, purpose, zoom, onDone, onCancel }: ViewfinderProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<string>("Opening the camera…");
  const [granted, setGranted] = useState<string>("");
  const [zoomApplied, setZoomApplied] = useState<number | null>(null);
  const [zoomNote, setZoomNote] = useState<string>("");
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number } | null>(null);
  const [stillPath, setStillPath] = useState<"image-capture" | "canvas">("canvas");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const open = async (): Promise<void> => {
      try {
        const constraints: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } };
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0] ?? null;

        // Push to the camera's own maximum before framing, so the shot is the best this lens offers.
        const caps = (track?.getCapabilities?.() ?? null) as (MediaTrackCapabilities & { zoom?: { min?: number; max?: number } }) | null;
        const maxW = caps?.width?.max;
        const maxH = caps?.height?.max;
        if (track && maxW && maxH) {
          try {
            await track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH } });
          } catch {
            // the camera kept its default size; the HUD reports what was granted
          }
        }

        if (caps?.zoom?.min != null && caps.zoom.max != null && caps.zoom.max > caps.zoom.min) {
          const range = { min: caps.zoom.min, max: caps.zoom.max };
          setZoomRange(range);
          if (zoom != null && track) {
            const target = resolveZoom(zoom, range.min, range.max);
            try {
              await track.applyConstraints(zoomConstraint(target));
              const actual = (track.getSettings?.() as MediaTrackSettings & { zoom?: number } | undefined)?.zoom ?? target;
              setZoomApplied(actual);
              setZoomNote(`Zoom held at ${actual} (${zoom} of the ${range.min}–${range.max} range this camera reports).`);
            } catch {
              setZoomApplied(null);
              setZoomNote(`This camera advertises a zoom range of ${range.min}–${range.max} but refused to apply the ${zoom} setting. Recorded as refused.`);
            }
          }
        } else if (zoom != null) {
          setZoomApplied(null);
          setZoomNote("This camera exposes no zoom control at all, so the zoom step could not be taken. The shot below is at its fixed default — it is not a zoomed frame pretending to be one.");
        }

        const settings = track?.getSettings?.() ?? null;
        setGranted(
          `${settings?.width ?? "?"}×${settings?.height ?? "?"} @ ${settings?.frameRate ? Math.round(settings.frameRate) : "?"} fps${settings?.facingMode ? ` · ${settings.facingMode}` : ""}`
        );
        setStillPath(imageCaptureCtor() ? "image-capture" : "canvas");

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setStatus("Ready — frame the shot and press the shutter.");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Camera permission is not in force, so this camera could not be opened. That is a refusal, not a fault — it will be recorded as one."
            : `The camera could not be opened: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
        );
      }
    };

    void open();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [deviceId, zoom]);

  const shoot = useCallback(async (): Promise<void> => {
    const track = streamRef.current?.getVideoTracks()[0] ?? null;
    if (!track) return;
    setBusy(true);
    try {
      const Ctor = imageCaptureCtor();
      if (Ctor && track.readyState === "live") {
        try {
          const blob = await new Ctor(track).takePhoto();
          const dims = await blobDimensions(blob);
          onDone({ blob, origin: "platform-photo", path: "image-capture", width: dims.width, height: dims.height, granted, zoomApplied, zoomNote });
          return;
        } catch {
          // fall through to the canvas encode, which is recorded honestly as such
        }
      }
      const video = videoRef.current;
      if (!video || !video.videoWidth) throw new Error("No frame is available yet.");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No 2D canvas context is available.");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95));
      if (!blob) throw new Error("canvas.toBlob() returned nothing.");
      onDone({ blob, origin: "app-encoded-frame", path: "canvas", width: canvas.width, height: canvas.height, granted, zoomApplied, zoomNote });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [granted, zoomApplied, zoomNote, onDone]);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/75 via-transparent to-black/85" />

      <div className="relative z-10 flex items-start justify-between gap-3 p-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">Manual shot</p>
          <h2 className="mt-0.5 truncate text-[15px] font-semibold text-white">{deviceLabel}</h2>
          <p className="mt-1 text-[11px] leading-snug text-white/70">{purpose}</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-black/50 text-white active:scale-95"
          aria-label="Skip this shot"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative z-10 mt-auto space-y-3 p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {error ? (
          <div className="rounded-xl border border-rose-500/50 bg-rose-950/70 p-3 text-[12px] leading-relaxed text-rose-100">{error}</div>
        ) : (
          <div className="mono space-y-1 rounded-xl border border-white/15 bg-black/55 p-3 text-[10.5px] leading-relaxed text-white/85 backdrop-blur-sm">
            <div>granted&nbsp;&nbsp;{granted || "…"}</div>
            <div>
              still&nbsp;&nbsp;&nbsp;&nbsp;
              {stillPath === "image-capture"
                ? "ImageCapture.takePhoto() — the platform encodes these bytes"
                : "canvas encode — THIS APP writes the JPEG, so it lands in rendered-frames/"}
            </div>
            <div>
              zoom&nbsp;&nbsp;&nbsp;&nbsp;
              {zoomRange ? `${zoomApplied ?? "default"} (range ${zoomRange.min}–${zoomRange.max})` : "not exposed by this camera"}
            </div>
            {zoomNote ? <div className="text-cyan-300/90">note&nbsp;&nbsp;&nbsp;&nbsp;{zoomNote}</div> : null}
            <div className="text-amber-300/90">exif&nbsp;&nbsp;&nbsp;&nbsp;none — no browser writes camera EXIF on this path</div>
          </div>
        )}

        <p className="text-center text-[11px] text-white/65">{status}</p>

        <div className="flex items-center justify-center gap-6">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-white/25 px-4 py-2.5 text-[12px] font-semibold text-white/80 active:scale-95"
          >
            Skip
          </button>
          <button
            type="button"
            disabled={busy || error != null}
            onClick={() => void shoot()}
            className="flex h-[74px] w-[74px] items-center justify-center rounded-full border-4 border-white/85 bg-white/15 backdrop-blur-sm transition-transform active:scale-90 disabled:opacity-40"
            aria-label="Take the photo"
          >
            {zoomApplied != null ? <ZoomIn className="h-7 w-7 text-white" /> : <Camera className="h-7 w-7 text-white" />}
          </button>
          <div className="w-[68px]" />
        </div>
      </div>
    </div>
  );
}

/**
 * Opens the viewfinder for one shot and resolves with it. Rejects with
 * `CaptureCancelledError` when the shot is skipped, so the caller records a
 * skip rather than inventing a photo.
 */
export function probeManualShot(options: { deviceId: string | null; deviceLabel: string; purpose: string; zoom: ZoomTarget }): Promise<ProbeShot> {
  return new Promise((resolve, reject) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let root: Root | null = createRoot(host);

    const close = (): void => {
      const current = root;
      root = null;
      setTimeout(() => {
        current?.unmount();
        host.remove();
      }, 0);
    };

    root.render(
      <Viewfinder
        deviceId={options.deviceId}
        deviceLabel={options.deviceLabel}
        purpose={options.purpose}
        zoom={options.zoom}
        onDone={(shot) => {
          close();
          resolve(shot);
        }}
        onCancel={() => {
          close();
          reject(new CaptureCancelledError());
        }}
      />
    );
  });
}
