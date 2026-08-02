import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Barcode,
  CheckCircle2,
  Clock,
  FileSearch,
  HeartPulse,
  Loader2,
  RefreshCcw,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  UserCheck,
  UserX,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { decodeShareSummary, shareExpiry, type SharePage, type ShareSummary } from "@/lib/share-link";

type ViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "expired"; summary: ShareSummary }
  | { status: "ok"; summary: ShareSummary };

const VERDICT_META = {
  pass: { label: "PASS", Icon: ShieldCheck, cls: "border-emerald-500/40 bg-emerald-500/10", text: "text-emerald-300" },
  review: { label: "REVIEW", Icon: ShieldAlert, cls: "border-amber-500/40 bg-amber-500/10", text: "text-amber-300" },
  fail: { label: "FAIL", Icon: ShieldX, cls: "border-rose-500/40 bg-rose-500/10", text: "text-rose-300" },
} as const;

function Chip({ label, tone }: { label: string; tone: "good" | "warn" | "bad" | "muted" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[10.5px] font-semibold",
        tone === "good"
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          : tone === "warn"
            ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
            : tone === "bad"
              ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
              : "border-border/70 bg-background/40 text-muted-foreground"
      )}
    >
      {label}
    </span>
  );
}

function scoreTone(score: number): "good" | "warn" | "bad" {
  return score >= 70 ? "good" : score >= 40 ? "warn" : "bad";
}

function PageCard({ page }: { page: SharePage }) {
  return (
    <div className="space-y-1.5 rounded-xl border border-border/70 bg-background/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold">
        <FileSearch className="h-3.5 w-3.5 text-fuchsia-400" />
        {page.label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Chip label={`${page.verdict} · ${page.score}/100`} tone={scoreTone(page.score)} />
        <Chip label={`confidence ${page.confidence}%`} tone="muted" />
        {page.outcome ? <Chip label={`outcome ${page.outcome}`} tone="muted" /> : null}
        {page.data ? (
          <Chip
            label={`data ${page.data}`}
            tone={page.data === "consistent" || page.data === "no-mrz" ? "good" : page.data === "unreadable" ? "warn" : "bad"}
          />
        ) : null}
        {page.barcode ? <Chip label={`barcode ${page.barcode}`} tone={page.barcode === "parsed" ? "good" : "muted"} /> : null}
        {page.ai ? (
          <Chip label={`AI ${page.ai.verdict} (${page.ai.confidence}%)`} tone={page.ai.verdict === "authentic" ? "good" : "warn"} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Read-only viewer for a shared verification summary. The entire payload
 * lives in the URL fragment — nothing is fetched or stored server-side —
 * and it self-expires 72 hours after creation.
 */
export default function SharedReport() {
  const [state, setState] = useState<ViewState>({ status: "loading" });

  useEffect(() => {
    const payload = window.location.hash.replace(/^#/, "");
    if (!payload) {
      setState({ status: "error", message: "This link does not contain a shared summary." });
      return;
    }
    let cancelled = false;
    void decodeShareSummary(payload)
      .then((summary) => {
        if (cancelled) return;
        setState(shareExpiry(summary).expired ? { status: "expired", summary } : { status: "ok", summary });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (state.status === "error" || state.status === "expired") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4">
        <div className="animate-rise w-full max-w-md space-y-3 rounded-2xl border border-border/70 bg-card p-6 text-center">
          {state.status === "expired" ? <Clock className="mx-auto h-10 w-10 text-amber-400" /> : <AlertTriangle className="mx-auto h-10 w-10 text-amber-400" />}
          <h1 className="text-lg font-bold tracking-tight">{state.status === "expired" ? "This shared summary has expired" : "Cannot open this shared summary"}</h1>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {state.status === "expired"
              ? `Shared summaries are temporary and expire 72 hours after creation (this one was created ${new Date(state.summary.at).toLocaleString()}). Ask the sender to run the flow again and share a fresh link.`
              : state.message}
          </p>
          <Button asChild variant="secondary" className="h-11 w-full">
            <Link to="/">Open Verification Hub</Link>
          </Button>
        </div>
      </div>
    );
  }

  const s = state.summary;
  const meta = VERDICT_META[s.verdict];
  const { remainingMs } = shareExpiry(s);
  const remainingH = Math.max(1, Math.ceil(remainingMs / 3_600_000));

  return (
    <div className="mx-auto min-h-dvh max-w-lg px-3 pb-10 pt-4 sm:px-4">
      <header className="mb-3">
        <h1 className="text-[15px] font-bold tracking-tight">Shared Verification Summary</h1>
        <p className="mono text-[10.5px] text-muted-foreground">
          {s.template} · created {new Date(s.at).toLocaleString()}
        </p>
      </header>

      <div className="space-y-3">
        <section className={cn("animate-rise rounded-2xl border p-4", meta.cls)}>
          <div className="flex items-center gap-3">
            <meta.Icon className={cn("h-9 w-9 shrink-0", meta.text)} />
            <div>
              <div className={cn("text-xl font-bold tracking-tight", meta.text)}>{meta.label}</div>
              <p className="text-[11px] text-muted-foreground">
                {s.verdict === "pass"
                  ? "All checks were consistent with a genuine session."
                  : s.verdict === "review"
                    ? "Evidence was incomplete or ambiguous — corrective actions were issued, no accusation made."
                    : "Hard, corroborated fraud signals were found."}
              </p>
            </div>
          </div>
          {s.reasons.length > 0 ? (
            <div className="mt-3 space-y-1">
              {s.reasons.map((r, i) => (
                <p key={`reason-${i}`} className="flex items-start gap-1.5 text-[11px] leading-snug text-foreground/90">
                  <CheckCircle2 className={cn("mt-0.5 h-3 w-3 shrink-0", meta.text)} />
                  {r}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        {s.pages.length > 0 ? (
          <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "80ms" }}>
            <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
              <Barcode className="h-4 w-4 text-cyan-400" />
              Document Pages
            </h2>
            {s.pages.map((p, i) => (
              <PageCard key={`page-${i}`} page={p} />
            ))}
          </section>
        ) : null}

        {s.face ? (
          <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "140ms" }}>
            <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
              <ScanFace className="h-4 w-4 text-teal-400" />
              Live Face
            </h2>
            <div className="flex flex-wrap gap-1.5">
              <Chip label={s.face.mode === "liveness" ? "liveness session" : "native selfie"} tone="muted" />
              <Chip label={s.face.faceCaptured ? "identity face captured" : "no usable face"} tone={s.face.faceCaptured ? "good" : "warn"} />
              {s.face.liveness ? (
                <Chip
                  label={`liveness ${s.face.liveness}${s.face.bpm ? ` · ${s.face.bpm} BPM` : ""}`}
                  tone={s.face.liveness === "live" ? "good" : s.face.liveness === "not-live" ? "bad" : "warn"}
                />
              ) : null}
              {s.face.score != null ? <Chip label={`forensics ${s.face.score}/100`} tone={scoreTone(s.face.score)} /> : null}
              {s.face.faces != null && s.face.faces > 1 ? <Chip label={`${s.face.faces} faces in frame`} tone="warn" /> : null}
              {s.face.ai ? <Chip label={`AI ${s.face.ai.verdict} (${s.face.ai.confidence}%)`} tone={s.face.ai.verdict === "authentic" ? "good" : "warn"} /> : null}
            </div>
            {s.match ? (
              <div
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold",
                  s.match.verdict === "match"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : s.match.verdict === "mismatch"
                      ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                      : "border-sky-500/40 bg-sky-500/10 text-sky-300"
                )}
              >
                {s.match.verdict === "match" ? <UserCheck className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />}
                {s.match.verdict === "match" ? "SAME PERSON" : s.match.verdict === "mismatch" ? "DIFFERENT PERSON" : "FACE MATCH UNCERTAIN"} ·{" "}
                {s.match.similarity}% similarity
              </div>
            ) : (
              <p className="text-[10.5px] text-muted-foreground">No face-to-document comparison was available in this session.</p>
            )}
          </section>
        ) : null}

        {s.actions.length > 0 ? (
          <section className="animate-rise space-y-1.5 rounded-2xl border border-sky-500/30 bg-sky-500/5 p-3.5" style={{ animationDelay: "200ms" }}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sky-300">
              <RefreshCcw className="h-3.5 w-3.5" />
              Corrective actions issued
            </div>
            {s.actions.map((a, i) => (
              <p key={`action-${i}`} className="text-[11px] leading-snug text-foreground/90">
                • {a}
              </p>
            ))}
          </section>
        ) : null}

        <section className="animate-rise space-y-1.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "260ms" }}>
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <HeartPulse className="h-3.5 w-3.5" />
            About this link
          </div>
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            The summary is embedded inside the link itself — nothing was uploaded or stored on any server, and no document images are
            included. This temporary link stops working in about {remainingH} hour{remainingH === 1 ? "" : "s"} (72 h after creation).
          </p>
          <Button asChild variant="secondary" className="h-11 w-full">
            <Link to="/">Open Verification Hub</Link>
          </Button>
        </section>
      </div>
    </div>
  );
}
