import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { computeDocConfidence, type DocumentDataCheck } from "@/lib/mrz";

/** Colour tone for a confidence score (null = neutral N/A). */
function tone(score: number | null): { chip: string; ring: string; bar: string } {
  if (score == null) {
    return { chip: "border-sky-500/40 bg-sky-500/10 text-sky-300", ring: "stroke-sky-400", bar: "bg-sky-400" };
  }
  if (score >= 80) {
    return { chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", ring: "stroke-emerald-400", bar: "bg-emerald-400" };
  }
  if (score >= 50) {
    return { chip: "border-amber-500/40 bg-amber-500/10 text-amber-300", ring: "stroke-amber-400", bar: "bg-amber-400" };
  }
  return { chip: "border-rose-500/40 bg-rose-500/10 text-rose-300", ring: "stroke-rose-400", bar: "bg-rose-400" };
}

/** Tiny SVG progress ring for the pill (14px). */
function MiniRing({ score, ringClass }: { score: number | null; ringClass: string }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  const frac = score == null ? 1 : Math.max(0, Math.min(1, score / 100));
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 -rotate-90">
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="stroke-white/15" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`}
        className={cn("transition-all duration-500", ringClass)}
      />
    </svg>
  );
}

/**
 * Deterministic document-data confidence badge: a colour-coded pill with the
 * percentage (or "N/A — no machine zone") that expands into the exact
 * calculation ledger — every check, its observed value, and the points it
 * earned. Pure math over an existing DocumentDataCheck; never re-runs OCR.
 */
export default function DocConfidenceBadge({ check, defaultOpen = false }: { check: DocumentDataCheck; defaultOpen?: boolean }) {
  const confidence = useMemo(() => computeDocConfidence(check), [check]);
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const t = tone(confidence.score);

  return (
    <>
      <button
        type="button"
        className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition-colors", t.chip)}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <MiniRing score={confidence.score} ringClass={t.ring} />
        {confidence.score == null ? confidence.label : `data confidence ${confidence.label}`}
        <ChevronDown className={cn("h-3 w-3 transition-transform duration-200", open ? "rotate-180" : "")} />
      </button>
      {open ? (
        <div className="w-full basis-full space-y-1.5 rounded-xl border border-border/60 bg-black/30 p-2.5">
          <p className="text-[10px] leading-snug text-muted-foreground">{confidence.note}</p>
          {confidence.parts.map((p) => (
            <div key={p.id} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className={cn("min-w-0 truncate text-[10.5px] font-medium", p.ok ? "text-foreground/90" : "text-amber-300")}>
                  {p.ok ? "✓" : "✗"} {p.label}
                </span>
                <span className="mono shrink-0 text-[10px] text-muted-foreground">
                  {p.earned}/{p.max} pts
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div className={cn("h-full rounded-full transition-all duration-500", t.bar)} style={{ width: `${Math.round((100 * p.earned) / Math.max(1, p.max))}%` }} />
              </div>
              <p className="mono text-[9.5px] leading-snug text-muted-foreground">{p.observed}</p>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
