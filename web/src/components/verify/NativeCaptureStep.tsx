import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ShieldAlert, SmartphoneNfc } from "lucide-react";

import { Button } from "@/components/ui/button";
import CaptureEngineToggle from "@/components/verify/CaptureEngineToggle";
import CaptureHoldOverlay from "@/components/verify/CaptureHoldOverlay";
import type { LogLevel } from "@/lib/camera-diagnostics";
import {
  CaptureCancelledError,
  capacitorCapturePhoto,
  engineOption,
  useCaptureEngine,
} from "@/lib/capture-engine";
import { runCaptureHold } from "@/lib/capture-hold";
import {
  ledgerBeginNativeTrip,
  ledgerNativeFileFacts,
  ledgerNativeHold,
  ledgerNativeStep,
  ledgerNativeTrust,
} from "@/lib/capture-ledger";
import { auditFileInputIntegrity, type NativeProvenance } from "@/lib/injection-guard";
import { describeLensCheck, enforceLensPolicy } from "@/lib/lens-enforcement";

/**
 * Native camera-app capture step with a selectable capture engine:
 *
 * - Native camera app: capture-enabled file input — the OS camera opens and
 *   the returned file keeps its original EXIF.
 * - System picker: the same input WITHOUT a capture attribute — iOS shows the
 *   UIImagePickerController-style sheet (Photo Library / Take Photo / Choose
 *   File). Library picks are allowed and judged by the file-age forensics.
 * - Capacitor Camera: Camera.getPhoto() (webUseInput) drives Capacitor's own
 *   hidden input; the original File and the change event's trust are
 *   intercepted there at event time, so provenance stays first-hand.
 *
 * All engines record full capture provenance — shutter-press epoch + trust,
 * round-trip time, change-event trust, page-visibility loss during the
 * round-trip, session start, and file-input API integrity — for the
 * injection forensics in the report.
 *
 * Lens policy: `capture="user"|"environment"` is the only HTML control that
 * exists (W3C HTML Media Capture) — the OS camera app still shows its own
 * flip/zoom controls. So the requested lens is ENFORCED after capture via
 * EXIF: wrong-lens or zoomed photos are rejected and must be retaken.
 *
 * Capture hold: every returned photo is held for a 1–2s bell-curve delay
 * ("Securing capture…" overlay) BEFORE the round-trip time is recorded, so
 * recorded timings always include the enforced hold — a sub-0.3s recorded
 * return is physically impossible and fails hard.
 */
export default function NativeCaptureStep({
  facing,
  buttonLabel,
  hint,
  pushLog,
  onCapture,
}: {
  facing: "environment" | "user";
  buttonLabel: string;
  hint: string;
  pushLog: (level: LogLevel, message: string) => void;
  onCapture: (file: File, provenance: NativeProvenance) => void;
}) {
  const engine = useCaptureEngine();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tripIdRef = useRef<string | null>(null);
  const pressedAtEpochRef = useRef<number>(0);
  const pressedAtPerfRef = useRef<number>(0);
  const pressTrustedRef = useRef<boolean | undefined>(undefined);
  const hiddenSeenRef = useRef<boolean>(false);
  const visHandlerRef = useRef<(() => void) | null>(null);
  const [lensRejection, setLensRejection] = useState<string | null>(null);
  const [securing, setSecuring] = useState<boolean>(false);

  const stopVisibilityWatch = useCallback(() => {
    if (visHandlerRef.current) {
      document.removeEventListener("visibilitychange", visHandlerRef.current);
      window.removeEventListener("pagehide", visHandlerRef.current);
      visHandlerRef.current = null;
    }
  }, []);

  useEffect(() => stopVisibilityWatch, [stopVisibilityWatch]);

  const startVisibilityWatch = useCallback(() => {
    stopVisibilityWatch();
    hiddenSeenRef.current = false;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (!hiddenSeenRef.current && tripIdRef.current) {
          ledgerNativeStep(tripIdRef.current, "Page hidden — the OS camera app took over the screen");
        }
        hiddenSeenRef.current = true;
      } else if (document.visibilityState === "visible" && hiddenSeenRef.current && tripIdRef.current) {
        ledgerNativeStep(tripIdRef.current, "Page visible again — returned from the camera app");
      }
    };
    visHandlerRef.current = onVis;
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onVis);
  }, [stopVisibilityWatch]);

  /**
   * Shared post-arrival pipeline for all engines: securing hold → provenance
   * assembly → lens policy → onCapture. `facts` are the event-time
   * observations (trust + files-API integrity) from whichever input fired.
   */
  const processFile = useCallback(
    async (f: File, facts: { changeIsTrusted: boolean; filesApiNative: boolean; filesApiObserved: string }) => {
      const tripId = tripIdRef.current;
      const pageHiddenDuring = pressedAtPerfRef.current > 0 ? hiddenSeenRef.current : undefined;
      stopVisibilityWatch();
      setSecuring(true);
      try {
        // Bell-curve hold (1–2s) BEFORE the round-trip is recorded — the
        // recorded elapsed time below always includes this hold.
        const heldMs = await runCaptureHold();
        if (tripId) ledgerNativeHold(tripId, heldMs);
        const elapsedMs = pressedAtPerfRef.current > 0 ? performance.now() - pressedAtPerfRef.current : -1;
        const provenance: NativeProvenance = {
          pressedAt: pressedAtEpochRef.current || Date.now(),
          elapsedMs,
          changeIsTrusted: facts.changeIsTrusted,
          pageLoadedAt: Math.round(performance.timeOrigin),
          filesApiNative: facts.filesApiNative,
          pressIsTrusted: pressTrustedRef.current,
          pageHiddenDuring,
        };
        pushLog("debug", `Native capture: secured for ${(heldMs / 1000).toFixed(2)}s (bell-curve hold) before timing was recorded.`);
        pushLog(
          !facts.changeIsTrusted || pressTrustedRef.current === false ? "error" : facts.filesApiNative ? "info" : "warn",
          `Native capture: received "${f.name}" (${(f.size / 1024).toFixed(0)} KB, ${f.type || "unknown type"}) · ${elapsedMs >= 0 ? `${(elapsedMs / 1000).toFixed(1)}s after press (incl. ${(heldMs / 1000).toFixed(1)}s securing hold)` : "press time unknown"} · press ${pressTrustedRef.current == null ? "untracked" : pressTrustedRef.current ? "trusted" : "SCRIPT-FIRED"} · event ${facts.changeIsTrusted ? "trusted" : "SCRIPT-DISPATCHED"} · page ${pageHiddenDuring == null ? "visibility untracked" : pageHiddenDuring ? "hidden during round-trip (camera app took over)" : "NEVER hidden during round-trip"} · files API ${facts.filesApiNative ? "native" : `wrapped (${facts.filesApiObserved}) — privacy browsers do this legitimately; scored as a caution, not proof`}`
        );
        const lens = await enforceLensPolicy(f, facing);
        const described = describeLensCheck(lens, facing);
        pushLog(described.level, described.message);
        if (!lens.ok) {
          if (tripId) ledgerNativeStep(tripId, "Lens policy rejected the photo — retake required", lens.reasons.join(" "));
          setLensRejection(lens.reasons.join(" "));
          return;
        }
        setLensRejection(null);
        if (tripId) {
          void ledgerNativeFileFacts(tripId, f, pressedAtEpochRef.current || null);
          ledgerNativeStep(tripId, "Forensic analysis started", `recorded round-trip ${elapsedMs >= 0 ? `${Math.round(elapsedMs)}ms` : "unknown"} (includes the securing hold)`);
        }
        onCapture(f, provenance);
      } finally {
        setSecuring(false);
      }
    },
    [facing, onCapture, pushLog, stopVisibilityWatch]
  );

  /** Launches the Capacitor Camera.getPhoto pipeline for this trip. */
  const launchCapacitor = useCallback(
    async (tripId: string) => {
      try {
        const res = await capacitorCapturePhoto(facing, (step, note) => ledgerNativeStep(tripId, step, note));
        if (res.changeIsTrusted == null || res.filesApiNative == null) {
          // Honesty rule: never report trust facts that were not observed.
          ledgerNativeStep(
            tripId,
            "Provenance not observable — capture rejected for honesty",
            "Capacitor returned a photo but the change event on its input was not intercepted, so event-trust and files-API facts cannot be reported. Retake required."
          );
          stopVisibilityWatch();
          pushLog("warn", "Capacitor capture returned a photo without observable event-trust provenance — please retake.");
          setLensRejection("The Capacitor pipeline returned a photo without observable capture provenance. Press the button below to retake.");
          return;
        }
        ledgerNativeTrust(tripId, { changeIsTrusted: res.changeIsTrusted, filesApiNative: res.filesApiNative });
        ledgerNativeStep(
          tripId,
          "File arrived via Capacitor Camera.getPhoto()",
          `"${res.file.name}" · ${res.file.size.toLocaleString("en-US")} bytes · declared ${res.file.type || "unknown"} · original bytes ${res.interceptedOriginal ? "intercepted at Capacitor's input" : "reconstructed from webPath"}`
        );
        await processFile(res.file, {
          changeIsTrusted: res.changeIsTrusted,
          filesApiNative: res.filesApiNative,
          filesApiObserved: res.filesApiObserved ?? "[native code]",
        });
      } catch (err) {
        stopVisibilityWatch();
        if (err instanceof CaptureCancelledError) {
          ledgerNativeStep(tripId, "Capacitor picker closed with no file — capture cancelled");
          pushLog("warn", "Native capture cancelled (Capacitor Camera).");
          return;
        }
        pushLog("error", `Capacitor capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [facing, processFile, pushLog, stopVisibilityWatch]
  );

  return (
    <div className="space-y-3">
      <CaptureHoldOverlay visible={securing} />
      <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-background/40 p-4">
        <SmartphoneNfc className="h-8 w-8 shrink-0 text-emerald-400" />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          This step opens your phone's <span className="font-semibold text-foreground">real camera app</span>. The returned photo
          keeps its full original metadata (EXIF, maker notes, GPS if enabled) and runs through the complete forensic engine:
          AI-generator signatures, editor fingerprints, device consistency, timestamp agreement, capture-timing checks, and
          injection provenance (trusted press + trusted event, round-trip time, camera-app visibility takeover, file age, input
          API integrity).
        </p>
      </div>
      <CaptureEngineToggle onChanged={(next) => pushLog("info", `Capture engine set to: ${engineOption(next).label}`)} />
      <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      {lensRejection ? (
        <div className="flex items-start gap-2.5 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-3.5">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
          <div className="text-[11.5px] leading-relaxed">
            <p className="font-semibold text-rose-300">Photo rejected — retake required</p>
            <p className="mt-0.5 text-rose-200/80">{lensRejection}</p>
            <p className="mt-1 text-rose-200/60">
              Keep the camera on the {facing === "user" ? "front (selfie)" : "back"} lens at 1× — don't switch cameras or
              zoom. Press the button below to retake.
            </p>
          </div>
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={engine === "system-picker" ? undefined : facing}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Event-time facts are captured synchronously — trust, files-API
          // integrity and visibility can only be read at the change event.
          const changeIsTrusted = e.nativeEvent?.isTrusted === true;
          const filesApi = auditFileInputIntegrity(e.target);
          e.target.value = "";
          const tripId = tripIdRef.current;
          if (!f) {
            if (tripId) ledgerNativeStep(tripId, "Picker closed with no file — capture cancelled");
            stopVisibilityWatch();
            return;
          }
          if (tripId) {
            ledgerNativeTrust(tripId, { changeIsTrusted, filesApiNative: filesApi.native });
            ledgerNativeStep(
              tripId,
              engine === "system-picker" ? "File arrived from the system picker" : "File arrived from the camera app",
              `"${f.name}" · ${f.size.toLocaleString("en-US")} bytes · declared ${f.type || "unknown"}`
            );
          }
          void processFile(f, { changeIsTrusted, filesApiNative: filesApi.native, filesApiObserved: filesApi.observed });
        }}
      />
      <Button
        className="h-14 w-full bg-emerald-500 text-[15px] font-semibold text-emerald-950 hover:bg-emerald-400 active:scale-[0.98]"
        onClick={(e) => {
          pressedAtEpochRef.current = Date.now();
          pressedAtPerfRef.current = performance.now();
          pressTrustedRef.current = e.nativeEvent?.isTrusted === true;
          const tripId = ledgerBeginNativeTrip(`${buttonLabel} · via ${engineOption(engine).label}`, facing);
          tripIdRef.current = tripId;
          ledgerNativeTrust(tripId, { pressIsTrusted: pressTrustedRef.current });
          ledgerNativeStep(tripId, pressTrustedRef.current ? "Shutter press registered (user tap)" : "Shutter press registered (SCRIPT-FIRED — not a user gesture)");
          startVisibilityWatch();
          if (navigator.vibrate) navigator.vibrate(30);
          pushLog(
            "info",
            `Native capture [${engineOption(engine).label}]: opening ${engine === "system-picker" ? "system picker" : `camera (${facing === "user" ? "front" : "back"})`}… press ${pressTrustedRef.current ? "trusted" : "SCRIPT-FIRED"}`
          );
          if (engine === "capacitor") {
            void launchCapacitor(tripId);
            return;
          }
          inputRef.current?.click();
          ledgerNativeStep(
            tripId,
            engine === "system-picker"
              ? "Hidden input .click() dispatched — system picker opening (no capture attribute; iOS shows the UIImagePickerController-style sheet)"
              : `Hidden input .click() dispatched — OS camera opening (capture="${facing}")`
          );
        }}
      >
        <Camera className="mr-2 h-5 w-5" />
        {buttonLabel}
      </Button>
    </div>
  );
}
