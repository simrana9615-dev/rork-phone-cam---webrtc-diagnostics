import { useCallback, useMemo, useRef, useState } from "react";
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
import { deviceCameraCapturePhoto } from "@/components/verify/DeviceCameraSheet";
import DocDataPanel from "@/components/DocDataPanel";
import { computeDocConfidence, type DocumentDataCheck } from "@/lib/mrz";
import { downloadBlob, type LogEntry, type LogLevel } from "@/lib/camera-diagnostics";
import EvidencePackButton from "@/components/EvidencePackButton";
import { originForCaptureEngine, type PackInput, type PackOrigin } from "@/lib/evidence-pack";
import { formatReportText } from "@/lib/fraud-detection";

/**
 * Document Check: fraud analysis tuned for IDs, statements and paperwork —
 * text-region tamper localization, paper uniformity, recapture detection,
 * and a clear genuine / edited / screen-recapture / retake outcome.
 */
export default function DocumentCheck({ pushLog, logs }: { pushLog: (level: LogLevel, message: string) => void; logs?: LogEntry[] }) {
  const captureEngine = useCaptureEngine();
  /** Whether these bytes are a fresh camera file or a photo picked from storage. */
  const engineOrigin = useMemo<PackOrigin>(() => originForCaptureEngine(captureEngine), [captureEngine]);
  /**
   * Set only by capture paths that know their own origin at capture time
   * (device-level capture, where it depends on whether the browser's photo
   * pipeline or the canvas fallback ran). Overrides the engine default.
   */
  const [declaredOrigin, setDeclaredOrigin] = useState<PackOrigin | null>(null);
  const fileOrigin: PackOrigin = declaredOrigin ?? engineOrigin;
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
    async (file: File | null, origin?: PackOrigin) => {
      if (!file) return;
      fileRef.current = file;
      setDeclaredOrigin(origin ?? null);
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

  /** Evidence pack for one document check: the original file, the engine's renders, the data checks. */
  const buildPack = useCallback((): PackInput => {
    if (!report) throw new Error("Analyse a document first.");
    const file = fileRef.current;
    const conf = docData ? computeDocConfidence(docData) : null;
    const deep: string[] = [
      "DOCUMENT CHECK — DEEP REPORT",
      "=".repeat(70),
      `Exported ${new Date().toISOString()}`,
      "",
    ];
    if (docData) {
      deep.push(
        `DEEP DATA CHECK: ${docData.outcome.toUpperCase()} — ${docData.summary}`,
        conf ? `Data confidence: ${conf.score == null ? conf.label : `${conf.score}%`} — ${conf.note}` : "",
        ...(conf?.parts ?? []).map((p) => `  ${p.ok ? "✓" : "✗"} ${p.label}: ${p.earned}/${p.max} pts — ${p.observed}`),
        ""
      );
      if (docData.mrz) {
        const m = docData.mrz;
        deep.push(
          `MRZ: ${m.format} · ${m.documentCode}/${m.issuingState} · ${[m.surname, m.givenNames].filter(Boolean).join(", ")} · no. ${m.documentNumber} · born ${m.birthDateIso ?? "?"} · expires ${m.expiryDateIso ?? "?"}`,
          ...m.checkDigits.map((d) => `  ${d.ok ? "✓" : "✗"} ${d.field} check digit: printed ${d.actual}, computed ${d.expected}`),
          ""
        );
      }
      for (const f of docData.findings) {
        deep.push(`[${f.status.toUpperCase()}] ${f.label}`);
        if (f.observed) deep.push(`  observed: ${f.observed}`);
        if (f.expected) deep.push(`  expected: ${f.expected}`);
        deep.push(`  ${f.detail}`);
      }
      deep.push("");
    }
    deep.push(formatReportText(report, aiVerdict), "", "=== END OF REPORT ===");

    return {
      surface: "document-check",
      title: "Document Check — Evidence Pack",
      subtitle: `${report.fileName} · ${report.verdictLabel}`,
      scopeNote:
        "A single-file document check: forensic screening of one image plus the optional data read. It carries no live-capture ledger, because the file was supplied rather than captured through a monitored feed.",
      verdict: {
        label: `${report.docOutcome ? report.docOutcome.replace(/-/g, " ").toUpperCase() : report.verdictLabel} — score ${report.score}/100`,
        tone: report.score >= 80 ? "pass" : report.score >= 55 ? "review" : "fail",
        reasons: [
          report.verdictLabel,
          `Confidence ${report.confidence}% — how much evidence was actually available in this file`,
          ...(docData ? [`Data check: ${docData.outcome} — ${docData.summary}`] : []),
        ],
        corrective: report.retakeAdvice,
      },
      media: [
        {
          slug: "01-document",
          label: "Document image",
          origin: fileOrigin,
          blob: file,
          fileName: file?.name ?? report.fileName,
          captureMeta: file ? `supplied file · ${file.type || "unknown type"} · last modified ${new Date(file.lastModified).toISOString()}` : null,
          report,
          ai: aiVerdict,
          notes: docData ? [`Data check: ${docData.outcome} — ${docData.summary}`] : [],
        },
      ],
      logs,
      includeLedger: false,
      deepText: deep.join("\n"),
      deepJson: JSON.stringify(
        {
          schema: "verification-hub/document-check@1",
          exportedAt: new Date().toISOString(),
          file: file ? { name: file.name, sizeBytes: file.size, type: file.type, lastModified: file.lastModified } : null,
          report: exportableReport(report),
          docData,
          docConfidence: conf,
          aiVerdict,
        },
        null,
        2
      ),
    };
  }, [aiVerdict, docData, logs, report]);

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
            if (captureEngine === "avfoundation") {
              pushLog("info", "Document Check: opening the camera in-page and naming every device (enumerateDevices + getUserMedia)…");
              deviceCameraCapturePhoto("environment", (step, note) => pushLog("debug", note ? `Document Check: ${step} — ${note}` : `Document Check: ${step}`), "Photograph the document")
                .then((res) => {
                  pushLog(
                    "info",
                    `Document Check: ${res.inventory.after.length} camera${res.inventory.after.length === 1 ? "" : "s"} named — ${res.inventory.after.map((d) => d.label || "(unnamed)").join(" · ") || "none"}`
                  );
                  void onFile(res.file, res.origin);
                })
                .catch((err: unknown) => {
                  if (err instanceof CaptureCancelledError) pushLog("warn", "Document Check: capture cancelled");
                  else pushLog("error", `Document Check: device-level capture failed: ${err instanceof Error ? err.message : String(err)}`);
                });
              return;
            }
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
          <EvidencePackButton
            build={buildPack}
            pushLog={pushLog}
            hint="The original file untouched, the engine's renders and crops, the full tag dump, and a printable overview."
          />
        </>
      ) : null}
    </div>
  );
}
