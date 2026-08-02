import { CameraOff, RefreshCcw, ShieldAlert, VideoOff } from "lucide-react";

import { Button } from "@/components/ui/button";

export type CameraErrorKind = "denied" | "no-camera" | "busy" | "other";

export type CameraErrorInfo = { kind: CameraErrorKind; message: string };

/** Maps a getUserMedia rejection to a user-facing category. */
export function classifyCameraError(err: unknown): CameraErrorInfo {
  const name = err instanceof DOMException ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return { kind: "denied", message };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { kind: "no-camera", message };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return { kind: "busy", message };
  }
  return { kind: "other", message };
}

const DENIED_STEPS: string[] = [
  "iPhone / iPad (Safari): tap the “aA” or puzzle icon in the address bar → Website Settings → Camera → Allow. Or Settings app → Safari → Camera → Allow.",
  "Android (Chrome): tap the lock/tune icon in the address bar → Permissions → Camera → Allow.",
  "Then come back here and tap “Try Again” — no need to restart the whole session.",
];

/** Camera failure panel: distinct denied / no-camera / busy states with concrete re-enable steps. */
export default function CameraErrorHelp({ info, onRetry }: { info: CameraErrorInfo; onRetry: () => void }) {
  const isDenied = info.kind === "denied";
  return (
    <div className="space-y-2.5 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-3.5">
      <div className="flex items-center gap-2.5">
        {isDenied ? (
          <ShieldAlert className="h-6 w-6 shrink-0 text-rose-400" />
        ) : info.kind === "no-camera" ? (
          <VideoOff className="h-6 w-6 shrink-0 text-amber-400" />
        ) : (
          <CameraOff className="h-6 w-6 shrink-0 text-amber-400" />
        )}
        <div>
          <div className="text-[13px] font-semibold">
            {isDenied
              ? "Camera access is blocked"
              : info.kind === "no-camera"
                ? "No usable camera found"
                : info.kind === "busy"
                  ? "Camera is in use by another app"
                  : "Camera failed to start"}
          </div>
          <p className="mono text-[10px] text-muted-foreground">{info.message}</p>
        </div>
      </div>
      {isDenied ? (
        <div className="space-y-1">
          {DENIED_STEPS.map((s) => (
            <p key={s} className="text-[11px] leading-snug text-foreground/90">
              • {s}
            </p>
          ))}
        </div>
      ) : info.kind === "no-camera" ? (
        <p className="text-[11px] leading-snug text-foreground/90">
          This device reports no camera matching the request. On a desktop without a webcam, open this page on your phone instead —
          the whole flow is built for mobile.
        </p>
      ) : info.kind === "busy" ? (
        <p className="text-[11px] leading-snug text-foreground/90">
          Another app or browser tab is holding the camera. Close video-call apps and other tabs using the camera, then try again.
        </p>
      ) : (
        <p className="text-[11px] leading-snug text-foreground/90">An unexpected camera error occurred — retrying usually resolves it.</p>
      )}
      <Button variant="secondary" className="h-11 w-full" onClick={onRetry}>
        <RefreshCcw className="mr-2 h-4 w-4" />
        Try Again
      </Button>
    </div>
  );
}
