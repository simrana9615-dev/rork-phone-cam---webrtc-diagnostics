import { useState } from "react";
import { FileSearch, Loader2, RefreshCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { aiVerdictAvailable } from "@/lib/ai-verdict";
import DocConfidenceBadge from "@/components/DocConfidenceBadge";
import { runDocumentDataCheck, type DocumentDataCheck } from "@/lib/mrz";
import type { FindingStatus } from "@/lib/fraud-detection";
import type { LogLevel } from "@/lib/camera-diagnostics";

const STATUS_STYLE: Record<FindingStatus, string> = {
  pass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  fail: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-300",
};

const OUTCOME_STYLE: Record<DocumentDataCheck["outcome"], { label: string; cls: string }> = {
  consistent: { label: "DATA CONSISTENT", cls: STATUS_STYLE.pass },
  mismatch: { label: "ZONE MISMATCH", cls: STATUS_STYLE.fail },
  "checksum-failed": { label: "CHECKSUMS FAIL", cls: STATUS_STYLE.fail },
  unreadable: { label: "MRZ UNREADABLE", cls: STATUS_STYLE.warn },
  "no-mrz": { label: "NO MRZ", cls: STATUS_STYLE.info },
};

/**
 * Deep Data Check panel: vision-model OCR of the MRZ + printed fields, then
 * local ICAO 9303 checksum validation and MRZ↔visual-zone cross-checks — the
 * same document-data layer IDVerse/Innovatrics run server-side.
 */
export default function DocDataPanel({
  blob,
  docType,
  result,
  onResult,
  pushLog,
}: {
  blob: Blob;
  docType: "passport" | "licence" | "unknown";
  result: DocumentDataCheck | null;
  onResult: (r: DocumentDataCheck) => void;
  pushLog: (level: LogLevel, message: string) => void;
}) {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const available = aiVerdictAvailable();

  const run = async () => {
    setLoading(true);
    setError(null);
    pushLog("info", "Deep data check: OCR (MRZ + visual zone) → ICAO 9303 validation…");
    try {
      const r = await runDocumentDataCheck(blob, docType);
      onResult(r);
      pushLog(
        r.outcome === "consistent" || r.outcome === "no-mrz" ? "success" : r.outcome === "unreadable" ? "warn" : "error",
        `Deep data check: ${OUTCOME_STYLE[r.outcome].label} — ${r.summary}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      pushLog("error", `Deep data check failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-background/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold">
            <FileSearch className="h-3.5 w-3.5 text-violet-400" />
            Deep Data Check — MRZ + ICAO 9303
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">
            AI reads the machine zone verbatim; check digits (7-3-1 mod 10), dates, and MRZ↔printed-zone agreement are validated locally.
            Re-run any time with a sharper capture.
          </p>
        </div>
        <Button size="sm" variant="secondary" className="h-9 shrink-0 text-[11px]" disabled={!available || loading} onClick={() => void run()}>
          {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : result ? <RefreshCcw className="mr-1 h-3 w-3" /> : null}
          {loading ? "Reading…" : result ? "Re-run" : "Run"}
        </Button>
      </div>
      {!available ? <p className="text-[10px] text-amber-300">AI toolkit credentials unavailable — data extraction disabled.</p> : null}
      {error ? <p className="text-[10px] text-rose-300">{error}</p> : null}
      {result ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-[10.5px] font-semibold", OUTCOME_STYLE[result.outcome].cls)}>
              {OUTCOME_STYLE[result.outcome].label}
            </div>
            <DocConfidenceBadge check={result} />
          </div>
          <p className="text-[10px] leading-snug text-foreground/90">{result.summary}</p>
          {result.mrz ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border border-border/60 bg-black/30 p-2 mono text-[10px]">
              <span className="text-muted-foreground">Format / code</span>
              <span>{result.mrz.format} · {result.mrz.documentCode || "?"} · {result.mrz.issuingState || "?"}</span>
              <span className="text-muted-foreground">Name</span>
              <span className="truncate">{[result.mrz.surname, result.mrz.givenNames].filter(Boolean).join(", ") || "—"}</span>
              <span className="text-muted-foreground">Document №</span>
              <span>{result.mrz.documentNumber || "—"}</span>
              <span className="text-muted-foreground">Birth / sex</span>
              <span>{result.mrz.birthDateIso ?? "—"} · {result.mrz.sex}</span>
              <span className="text-muted-foreground">Expiry</span>
              <span>{result.mrz.expiryDateIso ?? "—"}</span>
              <span className="text-muted-foreground">Nationality</span>
              <span>{result.mrz.nationality || "—"}</span>
            </div>
          ) : null}
          {result.mrz ? (
            <div className="space-y-0.5">
              {result.mrz.checkDigits.map((d) => (
                <p key={d.field} className={cn("mono text-[10px]", d.ok ? "text-emerald-300/90" : "text-rose-300")}>
                  {d.ok ? "✓" : "✗"} {d.field}: printed {d.actual} · computed {d.expected}
                </p>
              ))}
            </div>
          ) : null}
          <div className="space-y-1">
            {result.findings.map((f) => (
              <div key={f.id} className="rounded-lg border border-border/50 bg-black/20 p-1.5">
                <div className="flex items-center gap-1.5">
                  <span className={cn("rounded border px-1 py-px text-[9.5px] font-bold uppercase", STATUS_STYLE[f.status])}>{f.status}</span>
                  <span className="text-[10.5px] font-medium">{f.label}</span>
                </div>
                {f.observed ? <p className="mono mt-0.5 text-[10px] text-muted-foreground">observed: {f.observed}</p> : null}
                {f.expected ? <p className="mono text-[10px] text-muted-foreground">expected: {f.expected}</p> : null}
                <p className="mt-0.5 text-[10px] leading-snug text-foreground/80">{f.detail}</p>
              </div>
            ))}
          </div>
          {result.extraction.notes.length > 0 ? (
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">OCR observations</p>
              {result.extraction.notes.map((n) => (
                <p key={n} className="text-[10px] text-muted-foreground">• {n}</p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
