import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ClipboardCopy,
  Cpu,
  Info,
  Layers,
  Loader2,
  RefreshCcw,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABELS,
  DOC_OUTCOME_LABELS,
  categoryOf,
  findingImpact,
  formatReportText,
  mergeAssessment,
  type AiMediaVerdict,
  type Finding,
  type FraudVerdict,
  type MediaFraudReport,
  type MetricEntry,
  type MetricState,
  type ReportTelemetry,
} from "@/lib/fraud-detection";
import { aiVerdictAvailable } from "@/lib/ai-verdict";

export const VERDICT_COLORS: Record<FraudVerdict, string> = {
  authentic: "hsl(152 65% 52%)",
  suspicious: "hsl(42 92% 58%)",
  manipulated: "hsl(18 90% 58%)",
  "ai-generated": "hsl(330 85% 62%)",
  "needs-more-info": "hsl(204 90% 60%)",
};

export const VERDICT_CHIP: Record<FraudVerdict, string> = {
  authentic: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  suspicious: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  manipulated: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  "ai-generated": "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
  "needs-more-info": "border-sky-500/40 bg-sky-500/10 text-sky-300",
};

export function ScoreRing({ score, color, caption }: { score: number; color: string; caption?: string }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const target = Math.max(0, Math.min(100, score));
  const [display, setDisplay] = useState<number>(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const duration = 750;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  const filled = (display / 100) * c;
  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg viewBox="0 0 104 104" className="h-full w-full -rotate-90">
        <circle cx="52" cy="52" r={r} fill="none" strokeWidth="8" className="stroke-muted" />
        <circle
          cx="52"
          cy="52"
          r={r}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c}`}
          style={{ stroke: color }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold leading-none" style={{ color }}>
          {display}
        </span>
        <span className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{caption ?? "/ 100"}</span>
      </div>
    </div>
  );
}

/** One evidence row: status icon, label, points impact, observed vs expected, detail. */
export function FindingRow({ finding }: { finding: Finding }) {
  const { status, label, detail, observed, expected } = finding;
  const impact = findingImpact(finding);
  const icon =
    status === "pass" ? (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
    ) : status === "warn" ? (
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
    ) : status === "fail" ? (
      <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
    ) : (
      <Info className="h-3.5 w-3.5 shrink-0 text-sky-400" />
    );
  const border =
    status === "fail"
      ? "border-rose-500/25 bg-rose-500/5"
      : status === "warn"
        ? "border-amber-500/20 bg-amber-500/5"
        : "border-border/50 bg-background/30";
  return (
    <div className={cn("rounded-lg border px-2.5 py-2", border)}>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
        <span className="mono shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {CATEGORY_LABELS[categoryOf(finding)]}
        </span>
        {impact > 0 ? (
          <span
            className={cn(
              "mono shrink-0 rounded px-1 py-0.5 text-[10px] font-bold",
              status === "fail" ? "bg-rose-500/15 text-rose-300" : "bg-amber-500/15 text-amber-300"
            )}
          >
            −{impact} pts
          </span>
        ) : null}
      </div>
      {observed ? (
        <p className="mono mt-1 text-[10px] leading-snug text-foreground/80">
          <span className="text-muted-foreground">observed:</span> {observed}
        </p>
      ) : null}
      {expected ? (
        <p className="mono text-[10px] leading-snug text-foreground/60">
          <span className="text-muted-foreground">expected:</span> {expected}
        </p>
      ) : null}
      <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">{detail}</p>
    </div>
  );
}

const METRIC_STATE_CHIP: Record<MetricState, string> = {
  ok: "bg-emerald-500/15 text-emerald-300",
  weak: "bg-amber-500/15 text-amber-300",
  strong: "bg-rose-500/15 text-rose-300",
  info: "bg-sky-500/15 text-sky-300",
};

/** Maximum-detail engine internals: score ledger, confidence math, verdict rule trace, raw signal values vs thresholds. */
function TechnicalBreakdown({ telemetry }: { telemetry: ReportTelemetry }) {
  const penalized = telemetry.scoring.entries.filter((e) => e.penalty > 0);
  const zeroImpact = telemetry.scoring.entries.length - penalized.length;
  const groups: { name: string; entries: MetricEntry[] }[] = [];
  for (const m of telemetry.metrics) {
    const g = groups.find((x) => x.name === m.group);
    if (g) g.entries.push(m);
    else groups.push({ name: m.group, entries: [m] });
  }
  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Cpu className="h-3.5 w-3.5" />
        Technical breakdown
        <span className="mono ml-auto text-[10px] normal-case tracking-normal">{telemetry.engine}</span>
      </div>

      <div className="space-y-1 rounded-lg border border-border/50 bg-black/30 p-2.5">
        <p className="text-[11px] font-semibold text-foreground/90">Score ledger — every point accounted for</p>
        <p className="mono text-[10px] leading-snug text-muted-foreground">{telemetry.scoring.formula}</p>
        {penalized.length > 0 ? (
          <div className="mt-1 space-y-1">
            {penalized.map((e) => (
              <div key={`${e.id}-${e.label}`} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "mono w-14 shrink-0 rounded px-1 py-0.5 text-right text-[10px] font-bold",
                    e.status === "fail" ? "bg-rose-500/15 text-rose-300" : "bg-amber-500/15 text-amber-300"
                  )}
                >
                  −{e.penalty.toFixed(1)}
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[10px] text-foreground/85">{e.id}</span>
                <span className="mono shrink-0 text-[10px] text-muted-foreground">
                  {CATEGORY_LABELS[e.category]} · w{e.weight}×{e.multiplier}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10.5px] text-muted-foreground">No penalties applied — every scored check passed.</p>
        )}
        <p className="mono pt-1 text-[10px] text-muted-foreground">
          {zeroImpact} zero-penalty checks · base {telemetry.scoring.base} − {telemetry.scoring.totalPenalty} penalty →{" "}
          <span className="font-bold text-foreground">{telemetry.scoring.finalScore}/100</span>
        </p>
      </div>

      <div className="space-y-1 rounded-lg border border-border/50 bg-black/30 p-2.5">
        <p className="text-[11px] font-semibold text-foreground/90">Evidence confidence ledger</p>
        <p className="mono text-[10px] leading-snug text-muted-foreground">{telemetry.confidence.formula}</p>
        <div className="mt-1 space-y-1">
          {telemetry.confidence.parts.map((p) => (
            <div key={p.label} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "mono w-10 shrink-0 rounded px-1 py-0.5 text-right text-[10px] font-bold",
                  p.points > 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground"
                )}
              >
                +{p.points}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/85">{p.label}</span>
              <span className="mono max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground">{p.observed}</span>
            </div>
          ))}
        </div>
        <p className="mono pt-1 text-[10px] text-muted-foreground">
          Final: <span className="font-bold text-foreground">{telemetry.confidence.final}%</span>
        </p>
      </div>

      <div className="space-y-1 rounded-lg border border-border/50 bg-black/30 p-2.5">
        <p className="text-[11px] font-semibold text-foreground/90">Verdict derivation trace</p>
        {telemetry.verdictTrace.map((s, i) => (
          <p key={`step-${i}`} className="mono text-[10px] leading-snug text-foreground/80">
            {s}
          </p>
        ))}
      </div>

      {telemetry.checks && telemetry.checks.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border/50 bg-black/30 p-2.5">
          <p className="text-[11px] font-semibold text-foreground/90">
            Check ledger — what was measured, and where each threshold came from
          </p>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {telemetry.calibrated
              ? "Thresholds marked CALIBRATED were derived from genuine and fraudulent captures taken on this device."
              : "Checks marked UNCALIBRATED are measured and shown, but contribute zero points — no threshold has been proven to separate genuine captures from fraudulent ones yet. Run calibration to enable them."}
          </p>
          <div className="space-y-1.5">
            {telemetry.checks.map((c) => (
              <div key={c.id} className="rounded border border-border/40 bg-background/30 p-1.5">
                <div className="flex items-start gap-1.5">
                  <span
                    className={cn(
                      "mono mt-px w-14 shrink-0 rounded px-1 py-0.5 text-right text-[10px] font-bold",
                      c.penalty > 0 ? "bg-rose-500/15 text-rose-300" : c.scoring ? "bg-emerald-500/15 text-emerald-300" : "bg-sky-500/15 text-sky-300"
                    )}
                  >
                    {c.penalty > 0 ? `−${c.penalty.toFixed(1)}` : c.scoring ? "0.0" : "n/s"}
                  </span>
                  <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-foreground/90">
                    {c.label}: <span className="mono text-foreground">{c.measured}</span>
                  </span>
                </div>
                <p className="mono mt-0.5 pl-[62px] text-[10px] leading-snug text-muted-foreground">
                  {c.threshold} · <span className="uppercase">{c.provenance}</span>
                </p>
                <p className="mt-0.5 pl-[62px] text-[10px] leading-snug text-muted-foreground/80">{c.provenanceNote}</p>
              </div>
            ))}
          </div>
          <p className="mono pt-0.5 text-[10px] text-muted-foreground">
            Ledger total −{telemetry.checks.reduce((a, c) => a + c.penalty, 0).toFixed(1)} of −
            {telemetry.scoring.totalPenalty.toFixed(1)} overall penalty · “n/s” = measured but not scored
          </p>
        </div>
      ) : null}

      {groups.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border/50 bg-black/30 p-2.5">
          <p className="text-[11px] font-semibold text-foreground/90">Raw signal measurements vs thresholds</p>
          {groups.map((g) => (
            <div key={g.name}>
              <p className="mono text-[10px] uppercase tracking-wider text-muted-foreground">{g.name}</p>
              <div className="mt-0.5 space-y-0.5">
                {g.entries.map((m, i) => (
                  <div key={`${g.name}-${i}`} className="flex items-start gap-1.5">
                    <span className={cn("mono mt-px shrink-0 rounded px-1 py-0.5 text-[10px] font-bold uppercase", METRIC_STATE_CHIP[m.state])}>
                      {m.state}
                    </span>
                    <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-foreground/85">
                      {m.name}: <span className="mono text-foreground">{m.value}</span>
                      {m.threshold ? <span className="mono text-muted-foreground"> · {m.threshold}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CategoryBars({ report }: { report: MediaFraudReport }) {
  return (
    <div className="space-y-1.5 rounded-xl border border-border/70 bg-background/40 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Category scores</div>
      {report.categories.map((c) => {
        const color = c.score >= 75 ? "bg-emerald-400" : c.score >= 50 ? "bg-amber-400" : "bg-rose-400";
        return (
          <div key={c.id}>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px]">{c.label}</span>
              <span className="mono text-[10px] text-muted-foreground">
                {c.score}/100 · {c.fails}F/{c.warns}W/{c.findings} checks
              </span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full transition-all duration-700", color)} style={{ width: `${c.score}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type ReportViewProps = {
  report: MediaFraudReport;
  aiVerdict: AiMediaVerdict | null;
  aiLoading: boolean;
  aiError: string | null;
  onRunAi: () => void;
  onCopied: (ok: boolean, message: string) => void;
};

/** Full ultra-detailed report: verdict, confidence, category bars, evidence trail, ELA, retake advice, AI verdict. */
export default function ReportView({ report, aiVerdict, aiLoading, aiError, onRunAi, onCopied }: ReportViewProps) {
  const merged = aiVerdict ? mergeAssessment(report, aiVerdict) : null;
  const displayVerdict: FraudVerdict = merged?.verdict ?? report.verdict;
  const color = VERDICT_COLORS[displayVerdict];

  const copyReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(formatReportText(report, aiVerdict));
      onCopied(true, "Fraud Lab report copied to clipboard");
    } catch (err) {
      onCopied(false, `Clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [aiVerdict, onCopied, report]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 rounded-xl border border-border/70 bg-background/40 p-3">
        <ScoreRing score={report.score} color={color} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className={cn("inline-block rounded-md border px-2 py-1 text-[11px] font-semibold", VERDICT_CHIP[displayVerdict])}>
            {merged?.label ?? report.verdictLabel}
          </div>
          {report.docOutcome ? (
            <div className="text-[11px] font-medium text-foreground/90">{DOC_OUTCOME_LABELS[report.docOutcome]}</div>
          ) : null}
          <div className="truncate text-[11px] text-muted-foreground">
            {report.fileName} · {report.kind} · {(report.size / 1024).toFixed(0)} KB
          </div>
          <div className="flex items-center gap-2">
            <span className="mono text-[10px] text-muted-foreground">evidence confidence</span>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", report.confidence >= 60 ? "bg-emerald-400" : report.confidence >= 40 ? "bg-amber-400" : "bg-rose-400")}
                style={{ width: `${report.confidence}%` }}
              />
            </div>
            <span className="mono text-[10px] text-muted-foreground">{report.confidence}%</span>
          </div>
          {merged ? (
            <p className="text-[10.5px] leading-snug text-muted-foreground">{merged.summary}</p>
          ) : (
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              {report.findings.filter((f) => f.status === "fail").length} failed ·{" "}
              {report.findings.filter((f) => f.status === "warn").length} warnings ·{" "}
              {report.findings.filter((f) => f.status === "pass").length} passed
              {report.findings.some((f) => f.status === "info")
                ? ` · ${report.findings.filter((f) => f.status === "info").length} info notes`
                : ""}
            </p>
          )}
        </div>
      </div>

      {report.retakeAdvice.length > 0 ? (
        <div className="space-y-1.5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sky-300">
            <RefreshCcw className="h-3.5 w-3.5" />
            Repeat capture requested
          </div>
          {report.retakeAdvice.map((a) => (
            <p key={a} className="text-[11px] leading-snug text-foreground/90">
              • {a}
            </p>
          ))}
        </div>
      ) : null}

      <CategoryBars report={report} />

      {(() => {
        const scored = report.findings.filter((f) => f.status === "fail" || f.status === "warn" || f.status === "pass");
        const notes = report.findings.filter((f) => f.status === "info");
        return (
          <>
            <div className="max-h-96 space-y-1.5 overflow-y-auto rounded-xl border border-border/70 bg-black/40 p-2">
              {scored.map((f) => (
                <FindingRow key={f.id} finding={f} />
              ))}
            </div>
            {notes.length > 0 ? (
              <div className="space-y-1.5 rounded-xl border border-sky-500/20 bg-sky-500/5 p-2.5">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sky-300">
                  <Info className="h-3.5 w-3.5" />
                  Expected browser mediation · {notes.length} note{notes.length === 1 ? "" : "s"}
                </div>
                <p className="text-[10.5px] leading-snug text-muted-foreground">
                  These are normal phone-browser behaviors (stripped EXIF tags, HEIC→JPEG quirks, privacy wrappers). They never lower the score and are not risk signals.
                </p>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {notes.map((f) => (
                    <FindingRow key={f.id} finding={f} />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        );
      })()}

      {report.ela ? (
        <div className="space-y-1.5 rounded-xl border border-border/70 bg-background/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Error Level Analysis heat map</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <img src={report.ela.sourceUrl} alt="Original" className="w-full rounded-lg ring-1 ring-border" />
              <p className="mt-1 text-center text-[10px] text-muted-foreground">Original</p>
            </div>
            <div>
              <img src={report.ela.url} alt="ELA heat map" className="w-full rounded-lg ring-1 ring-border" />
              <p className="mt-1 text-center text-[10px] text-muted-foreground">ELA · inconsistency {report.ela.blockInconsistency}</p>
            </div>
          </div>
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            Uniform noise = single save. Bright, sharply bounded regions = areas re-saved at a different compression level (splices,
            local edits, pasted text).
          </p>
        </div>
      ) : null}

      {report.visuals && report.visuals.length > 0 ? (
        <div className="space-y-2.5 rounded-xl border border-border/70 bg-background/40 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            Forensic visual evidence · {report.visuals.length} maps
          </div>
          {report.visuals.map((v) => (
            <div key={v.id} className="space-y-1">
              <p className="text-[11px] font-medium text-foreground/90">{v.label}</p>
              <img src={v.url} alt={v.label} className="w-full rounded-lg ring-1 ring-border" />
              <p className="text-[10.5px] leading-snug text-muted-foreground">{v.caption}</p>
            </div>
          ))}
        </div>
      ) : null}

      {report.telemetry ? <TechnicalBreakdown telemetry={report.telemetry} /> : null}

      <div className="space-y-2 rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/5 p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-fuchsia-300">
          <BrainCircuit className="h-3.5 w-3.5" />
          Deep AI vision verdict
        </div>
        {aiVerdict ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                  aiVerdict.verdict === "authentic"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : aiVerdict.verdict === "uncertain"
                      ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
                      : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                )}
              >
                {aiVerdict.verdict.toUpperCase()} · {aiVerdict.confidence}%
              </span>
              <span className="mono text-[10px] text-muted-foreground">
                {aiVerdict.model}
                {aiVerdict.framesAnalyzed ? ` · ${aiVerdict.framesAnalyzed} frames` : ""}
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-foreground/90">{aiVerdict.reasoning}</p>
            {aiVerdict.indicators.length > 0 ? (
              <ul className="list-inside list-disc space-y-0.5 text-[10.5px] text-muted-foreground">
                {aiVerdict.indicators.map((ind) => (
                  <li key={ind}>{ind}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <>
            <Button className="h-11 w-full" variant="secondary" disabled={aiLoading || !aiVerdictAvailable()} onClick={onRunAi}>
              {aiLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BrainCircuit className="mr-2 h-4 w-4" />}
              {aiLoading
                ? report.kind === "video"
                  ? "Sampling frames + querying model…"
                  : "Querying vision model…"
                : `Get AI Verdict${report.kind === "video" ? " (samples 4 frames)" : ""}`}
            </Button>
            <p className="text-[10px] text-muted-foreground">
              Sends {report.kind === "video" ? "downsized sampled frames" : "a downsized copy"} to a vision AI (Gemini 3.5 Flash via
              Rork Toolkit) — uses Rork AI Cloud credits.
              {!aiVerdictAvailable() ? " Currently unavailable: toolkit credentials missing." : ""}
            </p>
            {aiError ? <p className="text-[10.5px] text-rose-300">{aiError}</p> : null}
          </>
        )}
      </div>

      <Button variant="outline" className="h-10 w-full" onClick={() => void copyReport()}>
        <ClipboardCopy className="mr-2 h-4 w-4" />
        Copy Full Evidence Report
      </Button>
    </div>
  );
}
