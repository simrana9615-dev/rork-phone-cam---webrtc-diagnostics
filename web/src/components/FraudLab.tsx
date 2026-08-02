import { useCallback, useRef, useState } from "react";
import { FileJson, FileSearch, FileText, HeartPulse, Loader2, ScanFace } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import ReportView from "@/components/ReportView";
import DocumentCheck from "@/components/DocumentCheck";
import FaceMatch from "@/components/FaceMatch";
import LivenessCheck from "@/components/LivenessCheck";
import {
  analyzeImageFraud,
  analyzeVideoFraud,
  exportableReport,
  type AiMediaVerdict,
  type MediaFraudReport,
} from "@/lib/fraud-detection";
import { requestImageAiVerdict, requestVideoAiVerdict } from "@/lib/ai-verdict";
import { downloadBlob, type LogLevel } from "@/lib/camera-diagnostics";

type LabTab = "media" | "document" | "face" | "liveness";

const TABS: { id: LabTab; label: string; icon: typeof FileSearch }[] = [
  { id: "media", label: "Media", icon: FileSearch },
  { id: "document", label: "Document", icon: FileText },
  { id: "face", label: "Face Match", icon: ScanFace },
  { id: "liveness", label: "Liveness", icon: HeartPulse },
];

function MediaAnalysis({ pushLog }: { pushLog: (level: LogLevel, message: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<File | null>(null);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [report, setReport] = useState<MediaFraudReport | null>(null);
  const [aiVerdict, setAiVerdict] = useState<AiMediaVerdict | null>(null);
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const onFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      fileRef.current = file;
      setReport(null);
      setAiVerdict(null);
      setAiError(null);
      setAnalyzing(true);
      const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v|3gp)$/i.test(file.name);
      pushLog("info", `Fraud Lab: analyzing ${isVideo ? "video" : "image"} "${file.name}" (${(file.size / 1024).toFixed(0)} KB)`);
      try {
        const onStep = (m: string) => pushLog("debug", `Fraud Lab: ${m}`);
        const result = isVideo
          ? await analyzeVideoFraud(file, file.name, { fileLastModified: file.lastModified, onStep })
          : await analyzeImageFraud(file, file.name, { fileLastModified: file.lastModified, onStep });
        setReport(result);
        const fails = result.findings.filter((f) => f.status === "fail").length;
        const warns = result.findings.filter((f) => f.status === "warn").length;
        pushLog(
          result.verdict === "authentic" ? "success" : result.verdict === "suspicious" || result.verdict === "needs-more-info" ? "warn" : "error",
          `Fraud Lab: ${result.verdictLabel} · score ${result.score}/100 · confidence ${result.confidence}% · ${fails} fail, ${warns} warn · categories: ${result.categories.map((c) => `${c.label} ${c.score}`).join(", ")}`
        );
        for (const advice of result.retakeAdvice) pushLog("warn", `Fraud Lab retake request: ${advice}`);
      } catch (err) {
        pushLog("error", `Fraud Lab analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setAnalyzing(false);
      }
    },
    [pushLog]
  );

  const runAi = useCallback(async () => {
    const file = fileRef.current;
    if (!file || !report) return;
    setAiLoading(true);
    setAiError(null);
    pushLog("info", `Fraud Lab: requesting deep AI verdict (${report.kind === "video" ? "sampled frames" : "full image"})…`);
    try {
      const verdict = report.kind === "video" ? await requestVideoAiVerdict(file) : await requestImageAiVerdict(file);
      setAiVerdict(verdict);
      pushLog(
        verdict.verdict === "authentic" ? "success" : "warn",
        `Fraud Lab AI verdict: ${verdict.verdict} (${verdict.confidence}% confidence)${verdict.framesAnalyzed ? ` · ${verdict.framesAnalyzed} frames` : ""}${verdict.indicators.length ? ` · indicators: ${verdict.indicators.join("; ")}` : ""}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiError(msg);
      pushLog("error", `Fraud Lab AI verdict failed: ${msg}`);
    } finally {
      setAiLoading(false);
    }
  }, [pushLog, report]);

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <Button className="h-12 w-full bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" disabled={analyzing} onClick={() => inputRef.current?.click()}>
        {analyzing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSearch className="mr-2 h-4 w-4" />}
        {analyzing ? "Running forensic analysis…" : "Analyze Photo or Video for Fraud"}
      </Button>
      {!report && !analyzing ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Ultra-detailed on-device forensics: metadata completeness and physical plausibility, AI-generator signatures (Midjourney,
          DALL·E, Stable Diffusion, Sora, Veo, Kling…), Content Credentials, editor fingerprints, timestamp cross-agreement,
          device-vs-metadata comparison, photo-of-a-screen detection, sensor-noise analysis, Error Level Analysis, and MP4/MOV
          container + temporal frame inspection for videos — each finding shows observed vs expected evidence and its exact score
          impact. Nothing leaves your phone unless you request the deep AI verdict.
        </p>
      ) : null}
      {analyzing ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Running forensics — steps stream into the debug console…
        </p>
      ) : null}
      {report ? (
        <>
          <ReportView
            report={report}
            aiVerdict={aiVerdict}
            aiLoading={aiLoading}
            aiError={aiError}
            onRunAi={() => void runAi()}
            onCopied={(ok, msg) => pushLog(ok ? "success" : "error", msg)}
          />
          <Button
            variant="secondary"
            className="h-11 w-full"
            onClick={() => {
              const file = fileRef.current;
              const payload = {
                schema: "verification-hub/media-analysis@1",
                exportedAt: new Date().toISOString(),
                file: file ? { name: file.name, sizeBytes: file.size, type: file.type, lastModified: file.lastModified } : null,
                report: exportableReport(report),
                aiVerdict,
              };
              downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `media-analysis-${Date.now()}.json`);
              pushLog("success", "Media analysis results + raw data exported (.json)");
            }}
          >
            <FileJson className="mr-1.5 h-4 w-4" />
            Export Results + Raw Data (JSON)
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** Fraud Lab hub: Media Analysis · Document Check · Face Match · Liveness + Pulse. */
export default function FraudLab({ pushLog }: { pushLog: (level: LogLevel, message: string) => void }) {
  const [tab, setTab] = useState<LabTab>("media");
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-1 rounded-xl border border-border/70 bg-background/40 p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-[10px] font-semibold transition-colors",
              tab === id ? "bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-500/30" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setTab(id)}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      {tab === "media" ? <MediaAnalysis pushLog={pushLog} /> : null}
      {tab === "document" ? <DocumentCheck pushLog={pushLog} /> : null}
      {tab === "face" ? <FaceMatch pushLog={pushLog} /> : null}
      {tab === "liveness" ? <LivenessCheck pushLog={pushLog} /> : null}
    </div>
  );
}
