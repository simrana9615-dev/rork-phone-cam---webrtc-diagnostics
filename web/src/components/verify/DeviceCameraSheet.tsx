import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Aperture, Camera, CircleAlert, Layers, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CaptureCancelledError } from "@/lib/capture-engine";
import {
  AV_DEVICE_TYPE,
  describeDevice,
  inventoryReport,
  isDeviceCameraSupported,
  lensClassLabel,
  openDeviceSession,
  probeCameraInventory,
  stopSession,
  takeDeviceStill,
  type CameraDeviceInfo,
  type CameraInventory,
  type DeviceSession,
  type StepFn,
  type StillPath,
} from "@/lib/device-camera";
import type { PackOrigin } from "@/lib/evidence-pack";
import { cn } from "@/lib/utils";

/** What a device-level capture hands back — the file plus the full hardware read-out behind it. */
export type DeviceCaptureResult = {
  file: File;
  /**
   * Declared here, at the capture site, because only this code knows whether
   * the platform's photo pipeline produced the bytes or the canvas fallback
   * ran. The evidence pack routes the file on this value.
   */
  origin: PackOrigin;
  path: StillPath;
  inventory: CameraInventory;
  device: CameraDeviceInfo | null;
  /** Full text write-up of the device inventory and the capture path, for the pack and the log. */
  report: string;
  grantedWidth: number | null;
  grantedHeight: number | null;
};

type Phase = "probing" | "ready" | "capturing" | "error";

function pickDefaultDevice(devices: CameraDeviceInfo[], facing: "user" | "environment"): CameraDeviceInfo | null {
  const want = facing === "user" ? "front" : "back";
  const onSide = devices.filter((d) => d.facing === want);
  const pool = onSide.length > 0 ? onSide : devices;
  // Prefer the plain wide lens — the one a camera app opens at 1×.
  return pool.find((d) => d.lensClass === "wide") ?? pool.find((d) => !d.isVirtual) ?? pool[0] ?? null;
}

function DeviceCameraSheet({
  facing,
  title,
  onStep,
  onDone,
  onCancel,
}: {
  facing: "user" | "environment";
  title: string;
  onStep?: StepFn;
  onDone: (result: DeviceCaptureResult) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<DeviceSession | null>(null);
  const aliveRef = useRef<boolean>(true);
  const [phase, setPhase] = useState<Phase>("probing");
  const [inventory, setInventory] = useState<CameraInventory | null>(null);
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Asking the platform which cameras exist…");

  const attach = useCallback((next: DeviceSession) => {
    stopSession(sessionRef.current);
    sessionRef.current = next;
    setSession(next);
    setActiveId(next.settings?.deviceId ?? next.device?.deviceId ?? null);
    if (videoRef.current) {
      videoRef.current.srcObject = next.stream;
      void videoRef.current.play().catch(() => undefined);
    }
  }, []);

  const openDevice = useCallback(
    async (deviceId: string | undefined, devices: CameraDeviceInfo[]) => {
      try {
        const next = await openDeviceSession({ deviceId, facing }, devices, onStep);
        if (!aliveRef.current) {
          stopSession(next);
          return;
        }
        attach(next);
        setPhase("ready");
        setStatus("");
      } catch (err) {
        if (!aliveRef.current) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [attach, facing, onStep]
  );

  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      if (!isDeviceCameraSupported()) {
        setPhase("error");
        setError("This browser does not expose navigator.mediaDevices, so device-level capture cannot run here. Pick another capture engine.");
        return;
      }
      const inv = await probeCameraInventory(facing, onStep);
      if (!aliveRef.current) return;
      setInventory(inv);
      if (!inv.granted) {
        setPhase("error");
        setError(inv.error ?? "Camera permission was not granted.");
        return;
      }
      setStatus("Opening the camera…");
      const preferred = pickDefaultDevice(inv.after, facing);
      await openDevice(preferred?.deviceId, inv.after);
    })();
    return () => {
      aliveRef.current = false;
      stopSession(sessionRef.current);
      sessionRef.current = null;
    };
  }, [facing, onStep, openDevice]);

  const shoot = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !inventory) return;
    setPhase("capturing");
    try {
      if (navigator.vibrate) navigator.vibrate(30);
      const still = await takeDeviceStill(s, videoRef.current, onStep);
      const ext = still.blob.type === "image/png" ? "png" : "jpg";
      const file = new File([still.blob], `device-camera-${Date.now()}.${ext}`, {
        type: still.blob.type || "image/jpeg",
      });
      const origin: PackOrigin = still.path === "image-capture" ? "platform-photo" : "app-encoded-frame";
      const report = inventoryReport(inventory, s, still);
      onStep?.(
        "Device-level capture complete",
        `${still.path === "image-capture" ? "platform still" : "app-encoded frame"} · ${still.width}×${still.height} · from "${s.trackLabel || "unnamed track"}"`
      );
      onDone({
        file,
        origin,
        path: still.path,
        inventory,
        device: s.device,
        report,
        grantedWidth: s.settings?.width ?? null,
        grantedHeight: s.settings?.height ?? null,
      });
    } catch (err) {
      setPhase("ready");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [inventory, onDone, onStep]);

  const devices = inventory?.after ?? [];
  const settings = session?.settings ?? null;
  const caps = (session?.capabilities ?? null) as (MediaTrackCapabilities & { zoom?: { min?: number; max?: number }; torch?: boolean }) | null;
  const activeDevice = useMemo(() => devices.find((d) => d.deviceId === activeId) ?? session?.device ?? null, [devices, activeId, session]);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-background/98 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{title}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            Device-level capture · enumerateDevices + getUserMedia + ImageCapture
          </p>
        </div>
        <button
          type="button"
          aria-label="Close the camera"
          onClick={onCancel}
          className="rounded-full border border-border/70 p-2 text-muted-foreground transition-colors hover:text-foreground active:scale-95"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={cn("h-full w-full object-contain", facing === "user" ? "-scale-x-100" : undefined)}
        />
        {phase === "probing" || status ? (
          <div className="absolute inset-0 flex items-center justify-center px-8 text-center">
            <p className="text-[12px] leading-relaxed text-muted-foreground">{status || "Reading the camera inventory…"}</p>
          </div>
        ) : null}
        {session ? (
          <div className="pointer-events-none absolute left-3 top-3 space-y-1 rounded-xl border border-emerald-500/30 bg-black/70 px-2.5 py-2 font-mono text-[9.5px] leading-relaxed text-emerald-200">
            <p className="font-semibold text-emerald-300">{session.trackLabel || "(unnamed track)"}</p>
            <p>
              {settings?.width ?? "?"}×{settings?.height ?? "?"} @ {settings?.frameRate ? Math.round(settings.frameRate) : "?"}fps
            </p>
            <p>facingMode {settings?.facingMode ?? "not reported"}</p>
            <p>
              max {(caps?.width as { max?: number } | undefined)?.max ?? "?"}×{(caps?.height as { max?: number } | undefined)?.max ?? "?"}
              {caps?.zoom ? ` · zoom ${caps.zoom.min ?? "?"}–${caps.zoom.max ?? "?"}` : " · zoom n/a"}
            </p>
            <p>
              stills{" "}
              {session.photo.supported
                ? `${session.photo.maxImageWidth ?? "?"}×${session.photo.maxImageHeight ?? "?"} (platform)`
                : "canvas fallback — no ImageCapture"}
            </p>
          </div>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-border/70 px-4 py-3">
        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5 text-[11px] leading-relaxed text-rose-200">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        ) : null}

        {inventory ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Layers className="h-3.5 w-3.5" />
              {devices.length} camera{devices.length === 1 ? "" : "s"} named by this device
              <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
                · {inventory.before.labelled} of {inventory.before.count} were named before you granted permission
              </span>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {devices.map((d) => {
                const on = d.deviceId === activeId;
                return (
                  <button
                    key={d.deviceId || d.label}
                    type="button"
                    aria-pressed={on}
                    disabled={phase === "capturing"}
                    onClick={() => {
                      setError(null);
                      setStatus(`Switching to ${d.label || "that camera"}…`);
                      setPhase("probing");
                      void openDevice(d.deviceId, devices);
                    }}
                    className={cn(
                      "shrink-0 rounded-lg border px-2.5 py-1.5 text-left text-[10px] font-semibold leading-tight transition-colors active:scale-[0.97]",
                      on
                        ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                        : "border-border/70 bg-background/60 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span className="block">{d.label || "(unnamed camera)"}</span>
                    <span className="block font-normal text-muted-foreground/80">
                      {d.classified ? lensClassLabel(d.lensClass) : "lens class not stated"}
                      {d.isVirtual ? " · fused" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            {activeDevice ? (
              <p className="text-[9.5px] leading-snug text-muted-foreground">
                {activeDevice.classified ? (
                  <>
                    Native equivalent: <span className="font-mono">{AV_DEVICE_TYPE[activeDevice.lensClass]}</span>
                  </>
                ) : (
                  "This label does not state a lens type, so none is claimed for it."
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-[10px] leading-relaxed text-amber-200">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>
            This path names every camera but produces <strong>no camera EXIF</strong> — no browser writes Make, Model, LensModel or GPS on a
            getUserMedia still. The metadata checks that read those tags will have nothing to read, and the pack says so rather than
            counting it against you.
          </span>
        </div>

        <Button
          className="h-14 w-full bg-emerald-500 text-[15px] font-semibold text-emerald-950 hover:bg-emerald-400 active:scale-[0.98]"
          disabled={phase !== "ready"}
          onClick={() => void shoot()}
        >
          {phase === "capturing" ? (
            <>
              <Aperture className="mr-2 h-5 w-5 animate-spin" />
              Capturing…
            </>
          ) : (
            <>
              <Camera className="mr-2 h-5 w-5" />
              Capture from {activeDevice?.label || "this camera"}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * Opens the device-level camera sheet and resolves with the captured file plus
 * the hardware inventory behind it. Rejects with CaptureCancelledError when
 * the user closes the sheet, matching the other capture engines.
 */
export function deviceCameraCapturePhoto(
  facing: "user" | "environment",
  onStep?: StepFn,
  title?: string
): Promise<DeviceCaptureResult> {
  return new Promise<DeviceCaptureResult>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Device-level capture needs a browser document."));
      return;
    }
    const host = document.createElement("div");
    host.setAttribute("data-device-camera-host", "");
    document.body.appendChild(host);
    const root = createRoot(host);

    const teardown = () => {
      // Deferred: unmounting synchronously from inside a React event handler
      // tears down the tree that is still rendering.
      window.setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };

    root.render(
      <DeviceCameraSheet
        facing={facing}
        title={title ?? (facing === "user" ? "Front camera" : "Back camera")}
        onStep={onStep}
        onDone={(result) => {
          teardown();
          resolve(result);
        }}
        onCancel={() => {
          teardown();
          reject(new CaptureCancelledError());
        }}
      />
    );
  });
}

export { describeDevice };

/**
 * Pushes the device inventory into a session log in a compact, readable form.
 * Shared by every surface so the wording of a hardware claim is identical
 * wherever it appears — and so the inventory lands in the evidence pack, which
 * archives the log verbatim.
 */
export function logDeviceInventory(
  res: DeviceCaptureResult,
  pushLog: (level: "info" | "success" | "warn" | "error" | "debug", message: string) => void
): void {
  const cams = res.inventory.after;
  pushLog(
    "info",
    `Device-level inventory: ${cams.length} camera${cams.length === 1 ? "" : "s"} named after the grant · ${res.inventory.before.labelled} of ${res.inventory.before.count} were named before it (browsers blank labels until permission exists) · ${res.inventory.groupCount} distinct hardware group${res.inventory.groupCount === 1 ? "" : "s"}`
  );
  cams.forEach((d, i) => pushLog("debug", `  [${i + 1}] ${describeDevice(d)}`));
  pushLog(
    "info",
    `Camera used: "${res.device?.label || "(unmatched track)"}" · granted ${res.grantedWidth ?? "?"}×${res.grantedHeight ?? "?"} · still via ${res.path === "image-capture" ? "ImageCapture.takePhoto (platform bytes)" : "canvas encode by this app (not a camera file)"}`
  );
  pushLog(
    "warn",
    "No camera EXIF exists on this path — no browser writes make, model, lens or GPS onto a getUserMedia still. EXIF-based checks are recorded as unavailable, not as failures."
  );
}
