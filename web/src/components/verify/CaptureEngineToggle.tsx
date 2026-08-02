import { Settings2 } from "lucide-react";

import {
  CAPTURE_ENGINE_OPTIONS,
  setCaptureEngine,
  useCaptureEngine,
  type CaptureEngine,
} from "@/lib/capture-engine";
import { cn } from "@/lib/utils";

/**
 * Settings toggle for the native-capture pipeline: direct native camera app
 * (`<input capture>`), system picker (no capture attribute), Capacitor
 * Camera.getPhoto (webUseInput), bare boolean capture attribute, legacy
 * accept="image/*;capture=camera" hint, or the File System Access picker
 * (showOpenFilePicker, Chromium-only). The choice is global and persisted —
 * every native-camera launch point in the app honors it.
 */
export default function CaptureEngineToggle({
  className,
  onChanged,
}: {
  className?: string;
  onChanged?: (engine: CaptureEngine) => void;
}) {
  const engine = useCaptureEngine();
  const active = CAPTURE_ENGINE_OPTIONS.find((o) => o.id === engine) ?? CAPTURE_ENGINE_OPTIONS[0];
  return (
    <div className={cn("rounded-2xl border border-border/70 bg-background/40 p-3", className)}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Settings2 className="h-3.5 w-3.5" />
        Capture engine
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {CAPTURE_ENGINE_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={o.id === engine}
            onClick={() => {
              setCaptureEngine(o.id);
              onChanged?.(o.id);
            }}
            className={cn(
              "rounded-lg border px-2 py-2 text-[10.5px] font-semibold leading-tight transition-colors active:scale-[0.97]",
              o.id === engine
                ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                : "border-border/70 bg-background/60 text-muted-foreground hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">{active.description}</p>
    </div>
  );
}
