import {
  Activity,
  Camera,
  CheckCircle2,
  ChevronLeft,
  Cpu,
  Download,
  FileJson,
  FileText,
  Gauge,
  Loader2,
  Play,
  RefreshCw,
  ScanBarcode,
  Video,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import EvidencePackButton from "@/components/EvidencePackButton";
import type { PackInput } from "@/lib/evidence-pack";
import { downloadBlob } from "@/lib/camera-diagnostics";
import {
  buildDeviceSpecJson,
  buildDeviceSpecText,
  runDeviceSpec,
  type DeviceSpecReport,
  type SpecTone,
} from "@/lib/device-spec";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<SpecTone, string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-rose-300",
  neutral: "text-foreground/90",
};

function SectionCard({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-3.5">
      <div className="mb-2.5 flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
          {icon}
        </div>
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold leading-tight">{title}</h2>
          {subtitle ? <p className="text-[10px] leading-snug text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export default function DeviceSpec() {
  const [running, setRunning] = useState<boolean>(false);
  const [progressPct, setProgressPct] = useState<number>(0);
  const [progressMsg, setProgressMsg] = useState<string>("");
  const [report, setReport] = useState<DeviceSpecReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    setProgressPct(0);
    setProgressMsg("Starting…");
    try {
      const result = await runDeviceSpec((msg, pct) => {
        setProgressMsg(msg);
        setProgressPct(pct);
      });
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  const exportText = useCallback(() => {
    if (!report) return;
    const stamp = report.startedAt.replace(/[:.]/g, "-");
    downloadBlob(new Blob([buildDeviceSpecText(report)], { type: "text/plain" }), `device-spec-report-${stamp}.txt`);
  }, [report]);

  const exportJson = useCallback(() => {
    if (!report) return;
    const stamp = report.startedAt.replace(/[:.]/g, "-");
    downloadBlob(new Blob([buildDeviceSpecJson(report)], { type: "application/json" }), `device-spec-report-${stamp}.json`);
  }, [report]);

  const suiteTotals = useMemo(() => {
    if (!report) return null;
    const granted = report.suites.reduce((n, s) => n + s.passed, 0);
    const total = report.suites.reduce((n, s) => n + s.results.length, 0);
    return { granted, total };
  }, [report]);

  /**
   * Evidence pack for a spec run. There is no captured media here — the
   * evidence is what the hardware and browser actually granted — so the pack
   * carries the full text/JSON report plus the threshold reference.
   */
  const buildPack = useCallback((): PackInput => {
    if (!report) throw new Error("Run the spec test first.");
    const granted = suiteTotals ? `${suiteTotals.granted}/${suiteTotals.total} constraint patterns granted` : "constraint results recorded";
    return {
      surface: "device-spec",
      title: "Device Camera Spec — Evidence Pack",
      subtitle: `${report.totalVideoInputs} camera${report.totalVideoInputs === 1 ? "" : "s"} · ${granted} · ${(report.durationMs / 1000).toFixed(1)}s run`,
      scopeNote:
        "A capability probe, not a fraud screening: it records what this device and browser actually granted. No photos or clips are captured, so the pack has no originals folder — the report and the environment dump are the evidence.",
      verdict: {
        label: "SPEC RUN COMPLETE",
        tone: "info",
        reasons: [
          `${report.totalVideoInputs} video input${report.totalVideoInputs === 1 ? "" : "s"} enumerated`,
          granted,
          `ImageCapture ${report.imageCaptureSupported ? "supported" : "unavailable"} · ${report.recorderCodecs.filter((c) => c.supported).length}/${report.recorderCodecs.length} recorder codecs supported`,
          `Native barcode formats: ${report.barcodeDetectorFormats.length > 0 ? report.barcodeDetectorFormats.join(", ") : "BarcodeDetector unavailable"}`,
        ],
      },
      media: [],
      includeLedger: true,
      deepText: buildDeviceSpecText(report),
      deepJson: buildDeviceSpecJson(report),
      sections: [
        {
          title: "Cameras found",
          lines: report.cameras.map(
            (c) =>
              `${c.label || "(unlabelled)"} — ${c.facingGuess} facing${c.grantedWidth ? ` · granted ${c.grantedWidth}×${c.grantedHeight}${c.grantedFps ? `@${c.grantedFps}fps` : ""}` : ""}${c.measuredFps != null ? ` · measured ${c.measuredFps} fps` : ""}${c.error ? ` · error: ${c.error}` : ""}`
          ),
        },
        { title: "Notes recorded during the run", lines: report.notes },
      ],
    };
  }, [report, suiteTotals]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-3 px-3 pb-8 pt-4">
      <header className="flex items-center gap-2.5 px-0.5">
        <Link
          to="/"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-card text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Back to dashboard"
        >
          <ChevronLeft className="h-4.5 w-4.5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight">Device Camera Spec Report</h1>
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            Tests everything spec-wise this device's cameras support and exports a full report.
          </p>
        </div>
      </header>

      {!report && !running ? (
        <div className="rounded-2xl border border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 via-card to-card p-4">
          <div className="mb-3 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <p className="text-[12.5px] font-semibold text-foreground">What this runs (~30–60 s):</p>
            <ul className="ml-4 list-disc space-y-1">
              <li>Environment &amp; API surface: getUserMedia, ImageCapture, MediaRecorder, BarcodeDetector, screen/GPU/CPU</li>
              <li>Every camera probed at maximum capability (8K ideal request) — granted resolution, fps, zoom, torch, focus/exposure modes</li>
              <li>Measured real fps per camera (1.2 s frame-callback sample, not just the reported number)</li>
              <li>ImageCapture still-photo max resolution (can exceed video resolution)</li>
              <li>Full 19-pattern getUserMedia constraint suite on both facings (min/max/ideal/aspect/fps, incl. impossible requests)</li>
              <li>MediaRecorder codec matrix (mp4/h264/hevc/webm/vp8/vp9/av1/opus) and native barcode formats</li>
            </ul>
            <p className="pt-1">
              The camera permission prompt fires once at the start. The report exports as readable text and structured JSON.
            </p>
          </div>
          <Button className="h-12 w-full bg-cyan-500 text-cyan-950 hover:bg-cyan-400" onClick={() => void start()}>
            <Play className="mr-1.5 h-4 w-4" />
            Run Full Spec Test
          </Button>
        </div>
      ) : null}

      {running ? (
        <div className="rounded-2xl border border-border/70 bg-card p-4">
          <div className="flex items-center gap-2.5">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium">{progressMsg}</div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-background/70">
                <div
                  className="h-full rounded-full bg-cyan-400 transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
            <span className="shrink-0 text-[11px] font-semibold tabular-nums text-cyan-300">{progressPct}%</span>
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            The screen may briefly flash as each camera and constraint pattern is opened and released — that is the test working.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-[11.5px] text-rose-200">
          Spec test failed: {error}
        </div>
      ) : null}

      {report ? (
        <>
          <div className="rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 via-card to-card p-3.5">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-300" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">Spec test complete</div>
                <p className="text-[10.5px] text-muted-foreground">
                  {report.totalVideoInputs} camera{report.totalVideoInputs === 1 ? "" : "s"} ·{" "}
                  {suiteTotals ? `${suiteTotals.granted}/${suiteTotals.total} constraint patterns granted` : ""} ·{" "}
                  {(report.durationMs / 1000).toFixed(1)} s
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="outline" className="h-11 border-border/70" onClick={exportText}>
                <FileText className="mr-1.5 h-4 w-4" />
                Export .txt
              </Button>
              <Button variant="outline" className="h-11 border-border/70" onClick={exportJson}>
                <FileJson className="mr-1.5 h-4 w-4" />
                Export .json
              </Button>
            </div>
            <div className="mt-2">
              <EvidencePackButton
                build={buildPack}
                hint="One ZIP: the full spec report, the environment dump, the capture ledger, and the threshold reference."
              />
            </div>
          </div>

          <SectionCard icon={<Cpu className="h-4 w-4" />} title="Environment & API surface">
            <div className="space-y-1">
              {report.environment.map((e) => (
                <div key={e.label} className="flex items-start justify-between gap-3 border-b border-border/40 pb-1 last:border-0 last:pb-0">
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">{e.label}</span>
                  <span className={cn("break-all text-right text-[10.5px] font-medium", TONE_CLASS[e.tone])}>{e.value}</span>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard
            icon={<Camera className="h-4 w-4" />}
            title={`Cameras (${report.totalVideoInputs})`}
            subtitle="Each probed with an 8K ideal request — the granted values are the real maximums."
          >
            <div className="space-y-2.5">
              {report.cameras.map((c) => (
                <div key={c.deviceId || c.index} className="rounded-xl border border-border/60 bg-background/40 p-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase",
                        c.facingGuess === "front"
                          ? "border-teal-500/40 bg-teal-500/15 text-teal-300"
                          : c.facingGuess === "back"
                            ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                            : "border-border/70 bg-background/40 text-muted-foreground"
                      )}
                    >
                      {c.facingGuess}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{c.label}</span>
                  </div>
                  {c.error ? (
                    <p className="mt-1.5 text-[10.5px] text-rose-300">{c.error}</p>
                  ) : (
                    <div className="mt-1.5 space-y-0.5 text-[10.5px]">
                      <Row k="Granted (max request)" v={c.grantedSettings ?? "n/a"} />
                      <Row k="Capabilities" v={c.capabilitiesSummary ?? "n/a"} />
                      {c.measuredFps != null ? <Row k="Measured fps" v={`${c.measuredFps} fps (1.2 s sample)`} /> : null}
                      {c.zoomRange ? <Row k="Zoom" v={c.zoomRange} /> : null}
                      {c.torchSupported != null ? <Row k="Torch" v={c.torchSupported ? "supported" : "not supported"} /> : null}
                      {c.focusModes ? <Row k="Focus modes" v={c.focusModes} /> : null}
                      {c.exposureModes ? <Row k="Exposure modes" v={c.exposureModes} /> : null}
                      {c.whiteBalanceModes ? <Row k="White balance" v={c.whiteBalanceModes} /> : null}
                      {c.photoCapabilities ? <Row k="ImageCapture photo" v={c.photoCapabilities} /> : null}
                      {c.openMs != null ? <Row k="Open time" v={`${c.openMs} ms`} /> : null}
                    </div>
                  )}
                </div>
              ))}
              {report.cameras.length === 0 ? (
                <p className="text-[10.5px] text-muted-foreground">No cameras enumerated (permission denied or no devices).</p>
              ) : null}
            </div>
          </SectionCard>

          {report.suites.map((suite) => (
            <SectionCard
              key={suite.facing}
              icon={<Gauge className="h-4 w-4" />}
              title={`Constraint suite — ${suite.facing === "user" ? "front" : "back"} camera`}
              subtitle={`${suite.passed} granted · ${suite.failed} rejected of ${suite.results.length} patterns (rejections map hard limits — they are valid results)`}
            >
              <div className="space-y-1">
                {suite.results.map((r) => (
                  <div key={r.id} className="flex items-start gap-2 border-b border-border/40 pb-1 last:border-0 last:pb-0">
                    {r.ok ? (
                      <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-300" />
                    ) : (
                      <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-rose-300" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[10.5px] font-medium">{r.name}</span>
                        <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">{r.durationMs} ms</span>
                      </div>
                      <p className={cn("break-all text-[9.5px]", r.ok ? "text-muted-foreground" : "text-rose-300/80")}>
                        {r.ok ? r.granted : r.error}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          ))}

          <SectionCard
            icon={<Video className="h-4 w-4" />}
            title="MediaRecorder codec matrix"
            subtitle="Determines the silent-clip container (mp4 on iOS Safari, webm elsewhere)."
          >
            <div className="grid grid-cols-1 gap-1">
              {report.recorderCodecs.map((c) => (
                <div key={c.mime} className="flex items-center gap-2">
                  {c.supported ? (
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-300" />
                  ) : (
                    <XCircle className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className={cn("break-all text-[10px]", c.supported ? "text-foreground/90" : "text-muted-foreground/60")}>
                    {c.mime}
                  </span>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard icon={<ScanBarcode className="h-4 w-4" />} title="Barcode detector">
            <p className="text-[10.5px] text-muted-foreground">
              {report.barcodeDetectorFormats.length ? (
                <>
                  Native formats: <span className="text-foreground/90">{report.barcodeDetectorFormats.join(", ")}</span>
                  {report.barcodeDetectorFormats.includes("pdf417")
                    ? " — licence barcodes decode natively."
                    : " — pdf417 missing; the app uses the ZXing fallback."}
                </>
              ) : (
                "Native BarcodeDetector unavailable — the app uses the ZXing fallback for PDF417 licence barcodes."
              )}
            </p>
          </SectionCard>

          {report.notes.length ? (
            <SectionCard icon={<Activity className="h-4 w-4" />} title="Notes">
              <ul className="ml-4 list-disc space-y-1 text-[10.5px] text-amber-200/90">
                {report.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="h-11 border-border/70" onClick={() => void start()} disabled={running}>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Run again
            </Button>
            <Button variant="outline" className="h-11 border-border/70" onClick={exportText}>
              <Download className="mr-1.5 h-4 w-4" />
              Export report
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="break-all text-right font-medium text-foreground/90">{v}</span>
    </div>
  );
}
