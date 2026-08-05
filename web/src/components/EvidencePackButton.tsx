/**
 * "Download Evidence Pack" action — the single end-of-flow export.
 *
 * The caller supplies a builder that assembles the pack input lazily (so the
 * heavy work only happens on tap). Progress is surfaced inline and every step
 * is pushed into the caller's session log, because the export itself is part of
 * the evidence trail.
 */

import { useCallback, useState } from "react";
import { FileArchive, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes, type LogLevel } from "@/lib/camera-diagnostics";
import { downloadEvidencePack, type PackInput } from "@/lib/evidence-pack";

type Props = {
  /** Assembles the pack contents at tap time. May be async. */
  build: () => PackInput | Promise<PackInput>;
  /** Session logger, so the export appears in the log that ships inside the pack. */
  pushLog?: (level: LogLevel, message: string) => void;
  /** Rendered under the button when idle. */
  hint?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
  variant?: "default" | "secondary";
};

export default function EvidencePackButton({
  build,
  pushLog,
  hint,
  label = "Download Evidence Pack (.zip)",
  className,
  disabled,
  variant = "default",
}: Props) {
  const [busy, setBusy] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    setStatus("Collecting evidence…");
    pushLog?.("info", "Evidence pack: build started (all processing local, nothing uploaded)");
    try {
      const input = await build();
      const result = await downloadEvidencePack(input, (msg) => setStatus(msg));
      setDone(`${result.fileName} — ${result.files} files, ${formatBytes(result.bytes)}`);
      pushLog?.("success", `Evidence pack downloaded: ${result.fileName} · ${result.files} files · ${formatBytes(result.bytes)}`);
      for (const w of result.warnings) pushLog?.("warn", `Evidence pack note: ${w}`);
      if (navigator.vibrate) navigator.vibrate([25, 45, 25]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushLog?.("error", `Evidence pack failed: ${message}`);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }, [build, pushLog]);

  return (
    <div className={cn("space-y-1.5", className)}>
      <Button variant={variant} className="h-12 w-full" disabled={busy || disabled} onClick={() => void run()}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileArchive className="mr-1.5 h-4 w-4" />}
        {busy ? "Building pack…" : label}
      </Button>
      {busy && status ? <p className="text-[10.5px] leading-snug text-muted-foreground">{status}</p> : null}
      {!busy && done ? <p className="text-[10.5px] leading-snug text-emerald-400">Saved {done}</p> : null}
      {!busy && error ? <p className="text-[10.5px] leading-snug text-red-400">{error}</p> : null}
      {!busy && !done && !error && hint ? <p className="text-[10.5px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
