/**
 * "Download Evidence Pack" action — the single end-of-flow export.
 *
 * The caller supplies a builder that assembles the pack input lazily (so the
 * heavy work only happens on tap). Progress is surfaced inline and every step
 * is pushed into the caller's session log, because the export itself is part of
 * the evidence trail.
 *
 * The byte-identity result is reported here rather than hidden: after building,
 * every archived media payload is carved back out of the finished ZIP and
 * compared to the capture, and the outcome is shown on screen and logged
 * per file. A mismatch is stated loudly instead of being smoothed over.
 */

import { useCallback, useState } from "react";
import { FileArchive, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes, type LogLevel } from "@/lib/camera-diagnostics";
import { downloadEvidencePack, type PackInput, type PackVerification } from "@/lib/evidence-pack";

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
  const [verified, setVerified] = useState<PackVerification[]>([]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    setVerified([]);
    setStatus("Collecting evidence…");
    pushLog?.("info", "Evidence pack: build started (all processing local, nothing uploaded)");
    try {
      const input = await build();
      const result = await downloadEvidencePack(input, (msg) => setStatus(msg));
      setDone(`${result.fileName} — ${result.files} files, ${formatBytes(result.bytes)}`);
      setVerified(result.verification);
      pushLog?.("success", `Evidence pack downloaded: ${result.fileName} · ${result.files} files · ${formatBytes(result.bytes)}`);
      // Log the byte-identity outcome per file — this is the claim the pack rests on.
      for (const v of result.verification) {
        pushLog?.(v.ok ? "debug" : "error", `Evidence pack byte check — ${v.path}: ${v.detail}`);
      }
      const failed = result.verification.filter((v) => !v.ok).length;
      if (result.verification.length > 0) {
        pushLog?.(
          failed === 0 ? "success" : "error",
          failed === 0
            ? `Evidence pack: all ${result.verification.length} archived media file(s) verified byte-for-byte identical to the capture`
            : `Evidence pack: ${failed} of ${result.verification.length} archived media file(s) did NOT match the capture`
        );
      }
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

  const failedCount = verified.filter((v) => !v.ok).length;

  return (
    <div className={cn("space-y-1.5", className)}>
      <Button variant={variant} className="h-12 w-full" disabled={busy || disabled} onClick={() => void run()}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileArchive className="mr-1.5 h-4 w-4" />}
        {busy ? "Building pack…" : label}
      </Button>
      {busy && status ? <p className="text-[10.5px] leading-snug text-muted-foreground">{status}</p> : null}
      {!busy && done ? <p className="text-[10.5px] leading-snug text-emerald-400">Saved {done}</p> : null}
      {!busy && verified.length > 0 ? (
        failedCount === 0 ? (
          <p className="text-[10.5px] leading-snug text-emerald-400">
            Byte check passed: {verified.length} media file{verified.length === 1 ? "" : "s"} carved back out of the archive and compared — identical to the capture, metadata intact. Offsets and
            checksums to repeat the check are in <span className="mono">verification/byte-identity.txt</span>.
          </p>
        ) : (
          <div className="space-y-1 rounded-lg border border-red-500/40 bg-red-500/10 p-2">
            <p className="text-[10.5px] font-semibold leading-snug text-red-300">
              Byte check FAILED on {failedCount} of {verified.length} file{verified.length === 1 ? "" : "s"} — do not rely on this pack.
            </p>
            {verified
              .filter((v) => !v.ok)
              .map((v) => (
                <p key={v.path} className="mono text-[9.5px] leading-snug text-red-300/90">
                  {v.path}: {v.detail}
                </p>
              ))}
          </div>
        )
      ) : null}
      {!busy && error ? <p className="text-[10.5px] leading-snug text-red-400">{error}</p> : null}
      {!busy && !done && !error && hint ? <p className="text-[10.5px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
