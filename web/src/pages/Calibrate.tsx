import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronLeft,
  Download,
  FlaskConical,
  Loader2,
  Monitor,
  Printer,
  RotateCcw,
  Ruler,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  analyzeAllMetrics,
  calibrationReadiness,
  clearCalibration,
  exportCalibration,
  loadCalibration,
  saveCalibration,
  type CalibrationClass,
  type CalibrationSample,
  type CalibrationStore,
  type MetricSeparation,
} from "@/lib/calibration";
import { measureForCalibration } from "@/lib/calibration-metrics";
import EvidencePackButton from "@/components/EvidencePackButton";
import type { PackInput } from "@/lib/evidence-pack";
import { cn } from "@/lib/utils";

type ClassSpec = {
  id: CalibrationClass;
  label: string;
  target: number;
  icon: React.ReactNode;
  guidance: string[];
  accent: string;
};

const CLASS_SPECS: ClassSpec[] = [
  {
    id: "genuine",
    label: "Genuine document",
    target: 6,
    icon: <Camera className="h-4 w-4" />,
    accent: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
    guidance: [
      "Licence flat on a table, filling most of the frame",
      "Licence held in your hand",
      "Bright daylight, then dim indoor light",
      "One with the front camera",
    ],
  },
  {
    id: "screen",
    label: "Shown on a screen",
    target: 4,
    icon: <Monitor className="h-4 w-4" />,
    accent: "text-rose-300 border-rose-500/40 bg-rose-500/10",
    guidance: [
      "Open a photo of the licence on another phone, then photograph that screen",
      "Repeat on a laptop or monitor",
      "Vary the distance so the pattern spacing changes",
    ],
  },
  {
    id: "print",
    label: "Printed photocopy",
    target: 2,
    icon: <Printer className="h-4 w-4" />,
    accent: "text-amber-300 border-amber-500/40 bg-amber-500/10",
    guidance: ["Optional — photograph a printed copy of the document", "Any home or office printer is fine"],
  },
];

function StatBar({ stats, label }: { stats: { min: number; max: number; median: number } | null; label: string }) {
  if (!stats) return <span className="mono text-[10px] text-muted-foreground">{label}: no data</span>;
  return (
    <span className="mono text-[10px] text-foreground/85">
      {label}: {stats.min.toFixed(2)} – {stats.max.toFixed(2)} <span className="text-muted-foreground">(median {stats.median.toFixed(2)})</span>
    </span>
  );
}

function SeparationRow({ sep }: { sep: MetricSeparation }) {
  const tone =
    sep.outcome === "separates"
      ? "border-emerald-500/40 bg-emerald-500/5"
      : sep.outcome === "overlaps"
        ? "border-rose-500/40 bg-rose-500/5"
        : "border-border/60 bg-background/30";
  const icon =
    sep.outcome === "separates" ? (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
    ) : sep.outcome === "overlaps" ? (
      <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-300" />
    ) : (
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    );
  return (
    <div className={cn("rounded-lg border p-2", tone)}>
      <div className="flex items-start gap-1.5">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] font-medium leading-snug text-foreground">{sep.def.label}</p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{sep.def.measures}</p>
        </div>
        {sep.outcome === "separates" ? (
          <span className="mono shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
            ≥{sep.suggestedWarn}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5 pl-5">
        <StatBar stats={sep.genuine} label="genuine" />
        <StatBar stats={sep.suspect} label="fraudulent" />
      </div>
      <p className="mt-1 pl-5 text-[10px] leading-snug text-muted-foreground">{sep.explanation}</p>
    </div>
  );
}

export default function Calibrate() {
  const [store, setStore] = useState<CalibrationStore>(() => loadCalibration());
  const [busy, setBusy] = useState<CalibrationClass | null>(null);
  const [lastNote, setLastNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingClass = useRef<CalibrationClass>("genuine");

  const readiness = useMemo(() => calibrationReadiness(store), [store]);
  const separations = useMemo(() => analyzeAllMetrics(store), [store]);
  const separatingCount = separations.filter((s) => s.outcome === "separates").length;
  const overlapCount = separations.filter((s) => s.outcome === "overlaps").length;

  const persist = useCallback((next: CalibrationStore) => {
    setStore(next);
    saveCalibration(next);
  }, []);

  const openPicker = useCallback((klass: CalibrationClass) => {
    pendingClass.current = klass;
    inputRef.current?.click();
  }, []);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const klass = pendingClass.current;
      setBusy(klass);
      setLastNote(null);
      const added: CalibrationSample[] = [];
      let failed = 0;
      try {
        for (const file of Array.from(files)) {
          const measurement = await measureForCalibration(file);
          if (!measurement) {
            failed += 1;
            continue;
          }
          added.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            klass,
            label: file.name.slice(0, 60),
            capturedAt: Date.now(),
            metrics: measurement.metrics,
            width: measurement.width,
            height: measurement.height,
          });
          setLastNote(measurement.documentNote);
        }
        if (added.length > 0) {
          persist({ ...store, samples: [...store.samples, ...added], appliedAt: null });
          toast.success(`Measured ${added.length} ${CLASS_SPECS.find((c) => c.id === klass)?.label.toLowerCase()} sample${added.length === 1 ? "" : "s"}`);
        }
        if (failed > 0) toast.error(`${failed} file(s) could not be decoded for measurement`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Measurement failed");
      } finally {
        setBusy(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [persist, store]
  );

  const apply = useCallback(() => {
    if (separatingCount === 0) {
      toast.error("No measurement separates genuine from fraudulent captures yet — nothing to apply");
      return;
    }
    persist({ ...store, appliedAt: Date.now() });
    toast.success(`${separatingCount} threshold${separatingCount === 1 ? "" : "s"} now active in every report`);
  }, [persist, separatingCount, store]);

  const unapply = useCallback(() => {
    persist({ ...store, appliedAt: null });
    toast.success("Calibrated thresholds switched off — those checks are unscored again");
  }, [persist, store]);

  const reset = useCallback(() => {
    clearCalibration();
    setStore(loadCalibration());
    setLastNote(null);
    toast.success("Calibration cleared");
  }, []);

  /**
   * Evidence pack for a calibration run: the measured samples, the separation
   * analysis, and which thresholds this earned the right to score. No sample
   * images are held after measurement, which the pack states plainly.
   */
  const buildPack = useCallback((): PackInput => {
    const lines: string[] = [
      "CALIBRATION — DEEP REPORT",
      "=".repeat(70),
      `Exported ${new Date().toISOString()}`,
      `Device: ${store.device}`,
      `Samples measured: ${store.samples.length}`,
      `Calibrated thresholds active: ${store.appliedAt != null ? `yes, applied ${new Date(store.appliedAt).toISOString()}` : "no"}`,
      "",
      "Purpose: a threshold is only allowed to remove points once it has been shown to separate genuine captures",
      "from fraudulent ones on this device. Until then the measurement is reported and scores nothing.",
      "",
      "── SEPARATION ANALYSIS ──",
    ];
    for (const s of separations) {
      lines.push(
        "",
        `${s.metricId} — ${s.def.label} [${s.outcome.toUpperCase()}]`,
        `  measures: ${s.def.measures}`,
        `  genuine: ${s.genuine ? `n=${s.genuine.count} · min ${s.genuine.min} · p10 ${s.genuine.p10} · median ${s.genuine.median} · p90 ${s.genuine.p90} · max ${s.genuine.max}` : "no samples"}`,
        `  fraudulent: ${s.suspect ? `n=${s.suspect.count} · min ${s.suspect.min} · p10 ${s.suspect.p10} · median ${s.suspect.median} · p90 ${s.suspect.p90} · max ${s.suspect.max}` : "no samples"}`,
        `  separation: ${s.separation ?? "not computable"}`,
        `  suggested: warn ${s.suggestedWarn ?? "—"} · fail ${s.suggestedFail ?? "—"}`,
        `  ${s.explanation}`
      );
    }
    lines.push("", "── SAMPLES ──");
    for (const sample of store.samples) {
      lines.push(
        `[${sample.klass}] ${sample.label} · ${sample.width}×${sample.height} · measured ${new Date(sample.capturedAt).toISOString()}`,
        ...Object.entries(sample.metrics).map(([k, v]) => `    ${k}: ${v ?? "not measurable"}`)
      );
    }
    lines.push("", "=== END OF REPORT ===");

    return {
      surface: "calibration",
      title: "Calibration — Evidence Pack",
      subtitle: `${store.samples.length} sample${store.samples.length === 1 ? "" : "s"} · ${separatingCount} measurement${separatingCount === 1 ? "" : "s"} separate cleanly`,
      scopeNote:
        "Calibration measures samples and keeps only the numbers — the sample images themselves are never stored, so this pack has no originals folder. It proves which thresholds earned the right to affect a score.",
      verdict: {
        label:
          store.appliedAt != null
            ? `CALIBRATED THRESHOLDS ACTIVE — ${separatingCount} scoring`
            : separatingCount > 0
              ? `${separatingCount} THRESHOLD${separatingCount === 1 ? "" : "S"} READY TO APPLY`
              : "NOT YET CALIBRATED",
        tone: store.appliedAt != null ? "pass" : separatingCount > 0 ? "review" : "info",
        reasons: [
          `${separatingCount} measurement${separatingCount === 1 ? "" : "s"} separate genuine from fraudulent captures cleanly and may be scored.`,
          ...(overlapCount > 0
            ? [`${overlapCount} measurement${overlapCount === 1 ? "" : "s"} overlap between the two classes, so ${overlapCount === 1 ? "it stays" : "they stay"} permanently unscored — no threshold could separate them honestly.`]
            : []),
          ...(readiness.ready ? [] : [`Not enough samples yet. Still to capture: ${readiness.missing.join(", ") || "—"}.`]),
        ],
      },
      media: [],
      includeLedger: false,
      deepText: lines.join("\n"),
      deepJson: exportCalibration(store),
      sections: [
        {
          title: "What this changes in every report",
          lines: [
            "Thresholds proven here are cited as CALIBRATED in the check ledger of every future report, with the sample counts behind them.",
            "Measurements that overlap stay unscored no matter how many samples are added — overlap means no honest threshold exists.",
            "Switching calibration off returns those checks to reported-but-unscored.",
          ],
        },
      ],
    };
  }, [overlapCount, readiness, separatingCount, separations, store]);

  const download = useCallback(() => {
    const blob = new Blob([exportCalibration(store)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `calibration-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [store]);

  return (
    <div className="mx-auto min-h-dvh w-full max-w-md px-3 pb-16 pt-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => void onFiles(e.target.files)}
      />

      <header className="mb-3 flex items-center gap-2">
        <Link to="/" className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-card text-muted-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-tight tracking-tight">Threshold calibration</h1>
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            Prove which checks can actually tell genuine from fraudulent — on your camera
          </p>
        </div>
      </header>

      <section className="diag-card mb-3 p-3">
        <div className="flex items-start gap-2">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Several measurements are physically motivated but have no honest firing level until they have been measured on
            real captures. Until then they are shown in reports and deduct <span className="text-foreground">nothing</span>.
            Capture the samples below and the app will find where genuine and fraudulent captures actually separate — and
            tell you plainly when they do not.
          </p>
        </div>
      </section>

      <section className="mb-3 space-y-2">
        {CLASS_SPECS.map((spec) => {
          const count = store.samples.filter((s) => s.klass === spec.id).length;
          const done = count >= spec.target;
          return (
            <div key={spec.id} className="diag-card p-3">
              <div className="flex items-center gap-2">
                <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", spec.accent)}>
                  {spec.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-semibold leading-tight">{spec.label}</p>
                  <p className="mono text-[10px] text-muted-foreground">
                    {count} of {spec.target} suggested
                  </p>
                </div>
                {done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" /> : null}
              </div>
              <ul className="mt-2 space-y-0.5 pl-1">
                {spec.guidance.map((g) => (
                  <li key={g} className="flex gap-1.5 text-[10.5px] leading-snug text-muted-foreground">
                    <span className="text-primary/60">•</span>
                    {g}
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2 h-9 w-full text-[12px]"
                disabled={busy !== null}
                onClick={() => openPicker(spec.id)}
              >
                {busy === spec.id ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Measuring…
                  </>
                ) : (
                  <>
                    <Camera className="mr-1.5 h-3.5 w-3.5" />
                    Capture / add {spec.label.toLowerCase()}
                  </>
                )}
              </Button>
            </div>
          );
        })}
      </section>

      {lastNote ? (
        <p className="mb-3 rounded-lg border border-border/60 bg-background/40 p-2 text-[10px] leading-snug text-muted-foreground">
          Last sample: {lastNote}
        </p>
      ) : null}

      <section className="diag-card mb-3 p-3">
        <div className="mb-2 flex items-center gap-1.5">
          <Ruler className="h-3.5 w-3.5 text-primary" />
          <p className="text-[12px] font-semibold">Separation analysis</p>
          <span className="mono ml-auto text-[10px] text-muted-foreground">
            {store.samples.length} sample{store.samples.length === 1 ? "" : "s"}
          </span>
        </div>
        {!readiness.ready ? (
          <p className="text-[11px] leading-snug text-muted-foreground">
            Need at least 3 genuine and 3 screen recaptures before separation can be measured.
            {readiness.missing.length > 0 ? ` Still to capture: ${readiness.missing.join(", ")}.` : ""}
          </p>
        ) : (
          <div className="space-y-1.5">
            {separations.map((sep) => (
              <SeparationRow key={sep.metricId} sep={sep} />
            ))}
            <p className="pt-1 text-[10px] leading-snug text-muted-foreground">
              {separatingCount} measurement{separatingCount === 1 ? "" : "s"} separate cleanly and can be scored.{" "}
              {overlapCount > 0
                ? `${overlapCount} overlap${overlapCount === 1 ? "s" : ""} between genuine and fraudulent captures — ${overlapCount === 1 ? "it stays" : "they stay"} unscored, because no threshold could separate them honestly.`
                : ""}
            </p>
          </div>
        )}
      </section>

      <section className="diag-card space-y-2 p-3">
        {store.appliedAt != null ? (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2">
            <p className="text-[11px] font-medium text-emerald-300">Calibrated thresholds are active</p>
            <p className="mono mt-0.5 text-[10px] text-muted-foreground">
              Applied {new Date(store.appliedAt).toLocaleString()} · every report cites them as CALIBRATED
            </p>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {store.appliedAt == null ? (
            <Button size="sm" className="h-9 text-[12px]" disabled={separatingCount === 0} onClick={apply}>
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              Apply thresholds
            </Button>
          ) : (
            <Button size="sm" variant="secondary" className="h-9 text-[12px]" onClick={unapply}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Switch off
            </Button>
          )}
          <Button size="sm" variant="secondary" className="h-9 text-[12px]" disabled={store.samples.length === 0} onClick={download}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export JSON
          </Button>
        </div>
        {store.samples.length > 0 ? (
          <EvidencePackButton
            build={buildPack}
            variant="secondary"
            hint="One ZIP: every measured sample, the separation analysis, and which thresholds this earned the right to score."
          />
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-full text-[11px] text-muted-foreground"
          disabled={store.samples.length === 0}
          onClick={reset}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Clear all samples
        </Button>
      </section>
    </div>
  );
}
