import { Loader2, ShieldCheck } from "lucide-react";

/**
 * Full-screen "Securing capture…" overlay shown while a returned photo is
 * held for the enforced bell-curve delay (see lib/capture-hold.ts). Rendered
 * for the 1–2s hold between the camera returning a file and the file
 * re-entering the verification flow.
 */
export default function CaptureHoldOverlay({ visible, label }: { visible: boolean; label?: string | null }) {
  if (!visible) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/95 backdrop-blur">
      <div className="relative">
        <div className="absolute inset-0 animate-ping rounded-full bg-emerald-500/20" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/40 bg-emerald-500/15">
          <ShieldCheck className="h-8 w-8 text-emerald-400" />
        </div>
      </div>
      <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
      <p className="text-[13px] font-medium text-foreground">Securing capture…</p>
      <p className="max-w-[260px] text-center text-[11px] leading-snug text-muted-foreground">
        {label ?? "Sealing the photo's capture provenance before analysis."}
      </p>
    </div>
  );
}
