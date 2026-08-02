import { Timer } from "lucide-react";

import { SILENT_CLIP_PRESETS, setSilentClipMaxMs, useSilentClipMaxMs } from "@/lib/silent-clip";
import { cn } from "@/lib/utils";

/**
 * Settings control for the silent background-clip max duration. The cap
 * bounds the hidden front-camera verification recording in both directions:
 * a hard-stop timer guarantees it when the background checks overrun, and
 * early-finishing checks keep recording to the cap — so the setting directly
 * trades file size against micro-motion evidence window. Persisted locally.
 */
export default function SilentClipDurationSetting({
  className,
  onChanged,
}: {
  className?: string;
  onChanged?: (ms: number) => void;
}) {
  const maxMs = useSilentClipMaxMs();
  const active = SILENT_CLIP_PRESETS.find((p) => p.ms === maxMs) ?? null;
  return (
    <div className={cn("rounded-2xl border border-border/70 bg-background/40 p-3", className)}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Timer className="h-3.5 w-3.5" />
        Silent clip max duration
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {SILENT_CLIP_PRESETS.map((p) => (
          <button
            key={p.ms}
            type="button"
            aria-pressed={p.ms === maxMs}
            onClick={() => {
              setSilentClipMaxMs(p.ms);
              onChanged?.(p.ms);
            }}
            className={cn(
              "rounded-lg border px-1.5 py-2 text-center transition-colors active:scale-[0.97]",
              p.ms === maxMs
                ? "border-amber-500/60 bg-amber-500/15 text-amber-300"
                : "border-border/70 bg-background/60 text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="block text-[12px] font-bold leading-none">{p.label}</span>
            <span className="mt-1 block text-[8.5px] font-semibold uppercase tracking-wide opacity-80">{p.name}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
        {active ? active.description : `Custom cap: ${(maxMs / 1000).toFixed(1)}s (set outside the presets).`}
      </p>
      <p className="mt-1 text-[9.5px] leading-snug text-muted-foreground/70">
        Caps the hidden front-camera verification clip recorded before each document capture. File size scales linearly with duration — the
        exact container, bytes, duration, and measured average bitrate of every clip are recorded in the Capture Feed Ledger.
      </p>
    </div>
  );
}
