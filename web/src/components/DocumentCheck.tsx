import { useCallback, useRef, useState } from "react";
import { FileJson, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import ReportView from "@/components/ReportView";
import {
  analyzeImageFraud,
  exportableReport,
  type AiMediaVerdict,
  type MediaFraudReport,
} from "@/lib/fraud-detection";
import { requestImageAiVerdict } from "@/lib/ai-verdict";
import { CaptureCancelledError, capacitorCapturePhoto, fsPickerCapturePhoto, inputAcceptAttr, inputCaptureAttr, useCaptureEngine } from "@/lib/capture-engine";
import DocDataPanel from "@/components/DocDataPanel";
import { computeDocConfidence, type DocumentDataCheck } from "@/lib/mrz";
import { downloadBlob, type LogLevel } from "@/lib/camera-diagnostics";

/**
 * Document Check: fraud analysis tuned for IDs, statements and paperwork —
 * text-region tamper localization, paper uniformity, recapture detection,
 * and a clear genuine / edited / screen-recapture / retake outcome.
 */
export default function DocumentCheck({ pushLog }: { pushLog: (level: LogLevel, message: string) => void }) {
  const captureEngine = useCaptureEngine();
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<File | null>(null);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [report, setReport] = useState<MediaFraudReport | null>(null);
  const [aiVerdict, setAiVerdict] = useState<AiMediaVerdict | null>(null);
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [docData, setDocData] = useState<DocumentDataCheck | null>(null);

  const onFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      fileRef.current = file;
      setReport(null);
      setAiVerdict(null);
      setAiError(null);
      setDocData(null);
      setAnalyzing(true);
      pushLog("info", `Document Check: analyzing "${file.name}" (${(file.size / 1024).toFixed(0)} KB)`);
      try {
        const result = await analyzeImageFraud(file, file.name, {
          fileLastModified: file.lastModified,
          document: true,
          onStep: (m) => pushLog("debug", `Document Check: ${m}`),
        });
        setReport(result);
        pushLog(
          result.verdict === "authentic" ? "success" : result.verdict === "suspicious" || result.verdict === "needs-more-info" ? "warn" : "error",
          `Document Check: ${result.verdictLabel} · score ${result.score}/100 · confidence ${result.confidence}% · outcome: ${result.docOutcome ?? "—"}`
        );
      } catch (err) {
        pushLog("error", `Document Check failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setAnalyzing(false);
      }
    },
    [pushLog]
  );

  const runAi = useCallback(async () => {
    const file = fileRef.current;
    if (!file) return;
    setAiLoading(true);
    setAiError(null);
    pushLog("info", "Document Check: requesting deep AI verdict…");
    try {
      const verdict = await requestImageAiVerdict(file);
      setAiVerdict(verdict);
      pushLog(verdict.verdict === "authentic" ? "success" : "warn", `Document Check AI verdict: ${verdict.verdict} (${verdict.confidence}%)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiError(msg);
      pushLog("error", `Document Check AI verdict failed: ${msg}`);
    } finally {
      setAiLoading(false);
    }
  }, [pushLog]);

  return (
    <div className="space-y-3">
      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept={inputAcceptAttr(captureEngine)}
        capture={inputCaptureAttr(captureEngine, "environment")}
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <Button className="h-12 bg-amber-500 text-amber-950 hover:bg-amber-400" disabled={analyzing} onClick={() => uploadRef.current?.click()}>
          {analyzing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
          Upload Document
        </Button>
        <Button
          variant="secondary"
          className="h-12"
          disabled={analyzing}
          onClick={() => {
            if (captureEngine === "capacitor") {
              pushLog("info", "Document Check: launching Capacitor Camera.getPhoto() (webUseInput)…");
              capacitorCapturePhoto("environment")
                .then((res) => {
                  void onFile(res.file);
                })
                .catch((err: unknown) => {
                  if (err instanceof CaptureCancelledError) pushLog("warn", "Document Check: capture cancelled");
                  else pushLog("error", `Document Check: Capacitor capture failed: ${err instanceof Error ? err.message : String(err)}`);
                });
              return;
            }
            if (captureEngine === "fs-picker") {
              pushLog("info", "Document Check: launching File System Access picker (showOpenFilePicker)…");
              fsPickerCapturePhoto()
                .then((res) => {
                  void onFile(res.file);
                })
                .catch((err: unknown) => {
                  if (err instanceof CaptureCancelledError) pushLog("warn", "Document Check: capture cancelled");
                  else pushLog("error", `Document Check: FS Access picker failed: ${err instanceof Error ? err.message : String(err)}`);
                });
              return;
            }
            cameraRef.current?.click();
          }}
        >
          <FileText className="mr-2 h-4 w-4" />
          Photograph Now
        </Button>
      </div>
      {!report && !analyzing ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Tuned for IDs, statements and paperwork: text-region tamper localization (pasted or retyped text lights up against the
          paper), background uniformity for cloned/whitened patches, print halftone classification, screen-recapture detection, and
          metadata checks calibrated for how genuine document photos and scans look. Outcome: genuine original, edited, screen
          recapture, or a specific retake request.
        </p>
      ) : null}
      {analyzing ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Running document forensics — steps stream into the debug console…
        </p>
      ) : null}
      {report && fileRef.current ? (
        <DocDataPanel blob={fileRef.current} docType="unknown" result={docData} onResult={setDocData} pushLog={pushLog} />
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
                schema: "verification-hub/document-check@1",
                exportedAt: new Date().toISOString(),
                file: file ? { name: file.name, sizeBytes: file.size, type: file.type, lastModified: file.lastModified } : null,
                report: exportableReport(report),
                docData,
                docConfidence: docData ? computeDocConfidence(docData) : null,
                aiVerdict,
              };
              downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `document-check-${Date.now()}.json`);
              pushLog("success", "Document check results + raw data exported (.json)");
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
