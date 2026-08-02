import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Barcode,
  CheckCircle2,
  ChevronRight,
  ClipboardCopy,
  FileDown,
  FileJson,
  Fingerprint,
  HeartPulse,
  History,
  Home,
  Loader2,
  RefreshCcw,
  RotateCcw,
  ScanFace,
  Share2,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Terminal,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import LiveDocCapture from "@/components/verify/LiveDocCapture";
import NativeCaptureStep from "@/components/verify/NativeCaptureStep";
import CaptureLedgerSection from "@/components/verify/CaptureLedgerSection";
import { buildLedgerJsonObject, buildLedgerText, ledgerReset } from "@/lib/capture-ledger";
import LivenessCheck, { type LivenessSessionResult } from "@/components/LivenessCheck";
import ReportView, { FindingRow, ScoreRing, VERDICT_CHIP } from "@/components/ReportView";
import DocDataPanel from "@/components/DocDataPanel";
import DocConfidenceBadge from "@/components/DocConfidenceBadge";
import { downloadBlob, makeLog, type LogEntry, type LogLevel } from "@/lib/camera-diagnostics";
import { analyzeImageFraud, type AiMediaVerdict, type Finding, type MediaFraudReport } from "@/lib/fraud-detection";
import type { NativeProvenance } from "@/lib/injection-guard";
import { aiVerdictAvailable, requestImageAiVerdict } from "@/lib/ai-verdict";
import { runDocumentDataCheck, type DocumentDataCheck } from "@/lib/mrz";
import { runLicenceBackCheck, type LicenceBarcodeCheck } from "@/lib/pdf417";
import { assessCaptureQuality } from "@/lib/capture-quality";
import { countFaces, describeFaceRobust, loadFaceModels, MATCH_DISTANCE_MAX, MISMATCH_DISTANCE_MIN, type FaceDescription } from "@/lib/face-vision";
import { clearSession, loadSession, saveSession, type StoredSession } from "@/lib/session-store";
import { buildShareSummary, encodeShareSummary } from "@/lib/share-link";
import {
  buildChecksCoverage,
  buildSessionJson,
  buildSessionReportText,
  compareFaces,
  computeOverall,
  getTemplate,
  licenceCrossFindings,
  type CheckCoverage,
  type FaceCompare,
  type FaceStepResult,
  type PageDef,
  type PageResult,
  type SessionAiVerdicts,
} from "@/lib/verification-templates";

type Step = { kind: "doc"; page: PageDef } | { kind: "face" } | { kind: "summary" };

type AiState = { verdict: AiMediaVerdict | null; loading: boolean; error: string | null };

type DocCaptureOpts = { provenance?: NativeProvenance; channelFindings?: Finding[] };

type FailedDoc = { page: PageDef; blob: Blob; url: string; meta: string; opts?: DocCaptureOpts; error: string };

type FailedSelfie = { file: File; url: string; prov: NativeProvenance; error: string };

const COVERAGE_CHIP: Record<CheckCoverage["status"], { label: string; cls: string }> = {
  ran: { label: "RAN", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  "not-run": { label: "NOT RUN", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
  unavailable: { label: "N/A", cls: "border-border/70 bg-background/40 text-muted-foreground" },
};

const LOG_COLOR: Record<LogLevel, string> = {
  info: "text-sky-300",
  success: "text-emerald-300",
  warn: "text-amber-300",
  error: "text-rose-300",
  debug: "text-muted-foreground",
};

function loadImageEl(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Browser cannot decode this image"));
    };
    img.src = url;
  });
}

function revokeIfBlobUrl(url: string | null | undefined): void {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function VerdictMiniChip({ report }: { report: MediaFraudReport }) {
  return (
    <span className={cn("inline-block rounded-md border px-2 py-0.5 text-[10.5px] font-semibold", VERDICT_CHIP[report.verdict])}>
      {report.verdictLabel} · {report.score}/100
    </span>
  );
}

const BARCODE_OUTCOME_STYLE: Record<LicenceBarcodeCheck["outcome"], { label: string; cls: string }> = {
  parsed: { label: "AAMVA PARSED", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  "raw-only": { label: "NON-AAMVA DATA", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  unreadable: { label: "NO PDF417 DECODED", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
};

/** Licence-back PDF417/AAMVA panel: decoded fields + findings. */
function BarcodePanel({ barcode }: { barcode: LicenceBarcodeCheck }) {
  const f = barcode.fields;
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-background/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        <Barcode className="h-3.5 w-3.5 text-cyan-400" />
        Licence Barcode — PDF417 / AAMVA
      </div>
      <div className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-[10.5px] font-semibold", BARCODE_OUTCOME_STYLE[barcode.outcome].cls)}>
        {BARCODE_OUTCOME_STYLE[barcode.outcome].label}
      </div>
      <p className="text-[10.5px] leading-snug text-foreground/90">{barcode.summary}</p>
      {barcode.engine ? <p className="mono text-[10px] text-muted-foreground">decoder: {barcode.engine}</p> : null}
      {f ? (
        <div className="mono grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border border-border/60 bg-black/30 p-2 text-[10px]">
          <span className="text-muted-foreground">Name</span>
          <span className="truncate">{f.fullName ?? "—"}</span>
          <span className="text-muted-foreground">Licence №</span>
          <span>{f.documentNumber ?? "—"}</span>
          <span className="text-muted-foreground">Birth / sex</span>
          <span>
            {f.birthDate ?? "—"} · {f.sex ?? "?"}
          </span>
          <span className="text-muted-foreground">Expiry / issued</span>
          <span>
            {f.expiryDate ?? "—"} · {f.issueDate ?? "—"}
          </span>
          <span className="text-muted-foreground">Region</span>
          <span>{[f.addressState, f.country].filter(Boolean).join(" · ") || "—"}</span>
          <span className="text-muted-foreground">AAMVA / IIN</span>
          <span>
            v{f.aamvaVersion ?? "?"} · {f.issuerIin ?? "?"}
          </span>
        </div>
      ) : null}
      <div className="space-y-1">
        {barcode.findings.map((fd) => (
          <FindingRow key={fd.id} finding={fd} />
        ))}
      </div>
    </div>
  );
}

export default function Verify() {
  const { templateId } = useParams<{ templateId: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const template = useMemo(() => getTemplate(templateId ?? "", search), [templateId, search]);
  const sessionKey = useMemo(
    () => (templateId === "custom" ? `custom?${search.toString()}` : templateId ?? ""),
    [search, templateId]
  );

  const steps: Step[] = useMemo(() => {
    if (!template) return [];
    const s: Step[] = template.pages.map((p) => ({ kind: "doc" as const, page: p }));
    if (template.faceMode !== "none") s.push({ kind: "face" });
    s.push({ kind: "summary" });
    return s;
  }, [template]);

  const [stepIndex, setStepIndex] = useState<number>(0);
  const [pageResults, setPageResults] = useState<Record<string, PageResult>>({});
  const [faceResult, setFaceResult] = useState<FaceStepResult | null>(null);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [analyzeMsg, setAnalyzeMsg] = useState<string>("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [aiState, setAiState] = useState<Record<string, AiState>>({});
  const [failedDoc, setFailedDoc] = useState<FailedDoc | null>(null);
  const [failedSelfie, setFailedSelfie] = useState<FailedSelfie | null>(null);
  const [resume, setResume] = useState<StoredSession | null>(null);
  const [runningAll, setRunningAll] = useState<boolean>(false);
  const [sharing, setSharing] = useState<boolean>(false);
  /** Shows the optional in-browser liveness + pulse add-on (native-selfie flows). */
  const [addonLiveness, setAddonLiveness] = useState<boolean>(false);

  /** Guard against state updates after unmount (in-flight analysis, AI calls). */
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pushLog = useCallback((level: LogLevel, message: string) => {
    if (!mountedRef.current) return;
    setLogs((prev) => [...prev.slice(-299), makeLog(level, message)]);
  }, []);

  // Capture Feed Ledger: one in-memory ledger per verification session — a new
  // template/session key starts a fresh ledger (live feeds only exist per load).
  useEffect(() => {
    if (template) ledgerReset(template.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const step = steps[stepIndex];

  const goTo = useCallback(
    (idx: number) => {
      setStepIndex(idx);
      window.scrollTo({ top: 0 });
      if (navigator.vibrate) navigator.vibrate(steps[idx]?.kind === "summary" ? [30, 60, 30] : 15);
    },
    [steps]
  );

  // ── Session persistence: load once, offer resume, save on change ──────────
  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;
    void loadSession(sessionKey)
      .then((s) => {
        if (!cancelled && s && (s.pages.length > 0 || s.face)) setResume(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!template || !sessionKey) return;
    const pages = template.pages.map((p) => pageResults[p.id]).filter((p): p is PageResult => p != null);
    if (pages.length === 0 && !faceResult) return;
    const timer = window.setTimeout(() => {
      const stored: StoredSession = {
        key: sessionKey,
        savedAt: Date.now(),
        stepIndex,
        pages: pages.map((p) => ({
          pageId: p.page.id,
          blob: p.blob,
          fileName: p.fileName,
          captureMeta: p.captureMeta,
          report: p.report,
          portrait: p.portrait,
          docData: p.docData ?? null,
          barcode: p.barcode ?? null,
          quickQuality: p.quickQuality ?? null,
        })),
        face: faceResult
          ? {
              mode: faceResult.mode,
              face: faceResult.face,
              imageDataUrl: faceResult.url && faceResult.url.startsWith("data:") ? faceResult.url : null,
              imageBlob: faceResult.blob ?? null,
              report: faceResult.report,
              liveness: faceResult.liveness,
              facesDetected: faceResult.facesDetected ?? null,
            }
          : null,
        ai: Object.fromEntries(Object.entries(aiState).map(([k, v]) => [k, v.verdict])),
      };
      void saveSession(stored).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [aiState, faceResult, pageResults, sessionKey, stepIndex, template]);

  const applyResume = useCallback(
    (s: StoredSession) => {
      if (!template) return;
      const results: Record<string, PageResult> = {};
      for (const sp of s.pages) {
        const def = template.pages.find((p) => p.id === sp.pageId);
        if (!def) continue;
        results[def.id] = {
          page: def,
          blob: sp.blob,
          url: URL.createObjectURL(sp.blob),
          fileName: sp.fileName,
          captureMeta: sp.captureMeta,
          report: sp.report,
          portrait: sp.portrait,
          docData: sp.docData,
          barcode: sp.barcode,
          quickQuality: sp.quickQuality,
        };
      }
      setPageResults(results);
      if (s.face) {
        setFaceResult({
          mode: s.face.mode,
          face: s.face.face,
          url: s.face.imageDataUrl ?? (s.face.imageBlob ? URL.createObjectURL(s.face.imageBlob) : null),
          blob: s.face.imageBlob,
          report: s.face.report,
          liveness: s.face.liveness,
          facesDetected: s.face.facesDetected,
        });
      }
      const aiRestored: Record<string, AiState> = {};
      for (const [k, v] of Object.entries(s.ai)) aiRestored[k] = { verdict: v, loading: false, error: null };
      setAiState(aiRestored);
      setResume(null);
      goTo(Math.min(s.stepIndex, Math.max(0, steps.length - 1)));
      pushLog(
        "success",
        `Session resumed (saved ${Math.max(1, Math.round((Date.now() - s.savedAt) / 60000))} min ago) — ${s.pages.length} page(s)${s.face ? " + face step" : ""} restored`
      );
    },
    [goTo, pushLog, steps.length, template]
  );

  const discardResume = useCallback(() => {
    setResume(null);
    void clearSession(sessionKey).catch(() => undefined);
    pushLog("info", "Previous session discarded");
  }, [pushLog, sessionKey]);

  // ── Deep data check + barcode helpers ──────────────────────────────────────
  const runDeepDataFor = useCallback(
    async (pageId: string, pageLabel: string, blob: Blob, onStep?: (m: string) => void) => {
      if (!template) return;
      try {
        onStep?.("Deep data check: OCR (MRZ + visual zone) → ICAO 9303 validation…");
        const r = await runDocumentDataCheck(blob, template.doc);
        if (!mountedRef.current) return;
        setPageResults((prev) => (prev[pageId] ? { ...prev, [pageId]: { ...prev[pageId], docData: r } } : prev));
        pushLog(
          r.outcome === "consistent" || r.outcome === "no-mrz" ? "success" : r.outcome === "unreadable" ? "warn" : "error",
          `${pageLabel} deep data check: ${r.outcome.toUpperCase()} — ${r.summary}`
        );
      } catch (err) {
        pushLog("warn", `${pageLabel} deep data check failed (page kept, re-run from the summary): ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [pushLog, template]
  );

  const runBarcodeFor = useCallback(
    async (pageId: string, pageLabel: string, blob: Blob, onStep?: (m: string) => void) => {
      try {
        const r = await runLicenceBackCheck(blob, (m) => onStep?.(m));
        if (!mountedRef.current) return;
        setPageResults((prev) => (prev[pageId] ? { ...prev, [pageId]: { ...prev[pageId], barcode: r } } : prev));
        pushLog(r.outcome === "parsed" ? "success" : "info", `${pageLabel} barcode: ${r.outcome.toUpperCase()} — ${r.summary}`);
      } catch (err) {
        pushLog("warn", `${pageLabel} barcode read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [pushLog]
  );

  // ── Capture handlers ───────────────────────────────────────────────────────
  const handleDocCapture = useCallback(
    async (page: PageDef, blob: Blob, meta: string, opts?: DocCaptureOpts) => {
      if (!template) return;
      setResume(null);
      setFailedDoc((prev) => {
        if (prev) revokeIfBlobUrl(prev.url);
        return null;
      });
      setAnalyzing(true);
      setAnalyzeMsg("Instant quality gate: checking sharpness and glare…");
      const fileName = blob instanceof File ? blob.name : `${template.doc}-${page.id}-${Date.now()}.jpg`;
      const prov = opts?.provenance;
      const quickQuality = await assessCaptureQuality(blob);
      if (quickQuality) {
        pushLog(
          quickQuality.ok ? "debug" : "warn",
          `${page.label}: instant quality gate ${quickQuality.ok ? "OK" : "FLAGGED"} — sharpness ${quickQuality.sharpness}, glare ${(quickQuality.glareFraction * 100).toFixed(1)}%, shadow ${(quickQuality.darkFraction * 100).toFixed(1)}%`
        );
      }
      try {
        const report = await analyzeImageFraud(blob, fileName, {
          document: true,
          captureSource: prov ? "native-file" : "live-frame",
          fileLastModified: blob instanceof File ? blob.lastModified : undefined,
          native: prov
            ? {
                pressedAt: prov.pressedAt,
                facing: "environment",
                deviceMaxPixels: null,
                changeIsTrusted: prov.changeIsTrusted,
                elapsedSincePressMs: prov.elapsedMs >= 0 ? prov.elapsedMs : undefined,
                pageLoadedAt: prov.pageLoadedAt,
                filesApiNative: prov.filesApiNative,
                pressIsTrusted: prov.pressIsTrusted,
                pageHiddenDuring: prov.pageHiddenDuring,
              }
            : undefined,
          extraFindings: opts?.channelFindings,
          onStep: (m) => {
            if (!mountedRef.current) return;
            setAnalyzeMsg(m);
            pushLog("debug", `${page.label}: ${m}`);
          },
        });
        pushLog(
          report.verdict === "authentic" ? "success" : report.verdict === "suspicious" || report.verdict === "needs-more-info" ? "warn" : "error",
          `${page.label}: ${report.verdictLabel} · score ${report.score}/100 · confidence ${report.confidence}% · outcome ${report.docOutcome ?? "—"}`
        );
        let portrait: FaceDescription | null = null;
        if (page.portrait) {
          if (mountedRef.current) setAnalyzeMsg("Detecting the document portrait on-device…");
          try {
            await loadFaceModels((m) => pushLog("debug", `Portrait: ${m}`));
            const img = await loadImageEl(blob);
            portrait = await describeFaceRobust(img, (m) => {
              if (mountedRef.current) setAnalyzeMsg(m);
            });
            revokeIfBlobUrl(img.src);
            pushLog(
              portrait ? (portrait.quality.ok ? "success" : "warn") : "warn",
              portrait
                ? `Portrait detected on ${page.label} · ${portrait.quality.boxWidth}px wide · detection ${portrait.quality.detectionScore} (${portrait.detector ?? "tiny"}) · ensemble ×${portrait.variants?.length ?? 1}${portrait.quality.ok ? "" : ` · ${portrait.quality.issues.length} quality issue(s)`}`
                : `No portrait detected on ${page.label} — face match will be unavailable until retaken`
            );
          } catch (err) {
            pushLog("warn", `Portrait detection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (!mountedRef.current) return;
        const url = URL.createObjectURL(blob);
        setPageResults((prev) => {
          const old = prev[page.id];
          if (old) URL.revokeObjectURL(old.url);
          return { ...prev, [page.id]: { page, blob, url, fileName, captureMeta: meta, report, portrait, quickQuality } };
        });
        setAiState((prev) => ({ ...prev, [page.id]: { verdict: null, loading: false, error: null } }));
        if (navigator.vibrate) navigator.vibrate(15);

        // Auto-run the data layer: deep data check (AI OCR + local ICAO math)
        // for pages with printed data, PDF417 barcode for licence backs.
        if (template.doc === "licence" && page.id === "back") {
          setAnalyzeMsg("Decoding the PDF417 barcode (local)…");
          await runBarcodeFor(page.id, page.label, blob, (m) => {
            if (mountedRef.current) setAnalyzeMsg(m);
          });
        } else if (aiVerdictAvailable()) {
          setAnalyzeMsg("Deep data check: reading MRZ + printed fields…");
          await runDeepDataFor(page.id, page.label, blob, (m) => {
            if (mountedRef.current) setAnalyzeMsg(m);
          });
        } else {
          pushLog("debug", `${page.label}: deep data check skipped — AI toolkit credentials unavailable`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("error", `${page.label} analysis failed (capture kept — retry from the step): ${msg}`);
        if (mountedRef.current) {
          setFailedDoc({ page, blob, url: URL.createObjectURL(blob), meta, opts, error: msg });
        }
      } finally {
        if (mountedRef.current) {
          setAnalyzing(false);
          setAnalyzeMsg("");
        }
      }
    },
    [pushLog, runBarcodeFor, runDeepDataFor, template]
  );

  const handleSelfieCapture = useCallback(
    async (file: File, prov: NativeProvenance) => {
      setResume(null);
      setFailedSelfie((prev) => {
        if (prev) revokeIfBlobUrl(prev.url);
        return null;
      });
      setAnalyzing(true);
      setAnalyzeMsg("Analyzing selfie metadata and pixels…");
      try {
        const report = await analyzeImageFraud(file, file.name, {
          captureSource: "native-file",
          fileLastModified: file.lastModified,
          native: {
            pressedAt: prov.pressedAt,
            facing: "user",
            deviceMaxPixels: null,
            changeIsTrusted: prov.changeIsTrusted,
            elapsedSincePressMs: prov.elapsedMs >= 0 ? prov.elapsedMs : undefined,
            pageLoadedAt: prov.pageLoadedAt,
            filesApiNative: prov.filesApiNative,
            pressIsTrusted: prov.pressIsTrusted,
            pageHiddenDuring: prov.pageHiddenDuring,
          },
          onStep: (m) => {
            if (!mountedRef.current) return;
            setAnalyzeMsg(m);
            pushLog("debug", `Selfie: ${m}`);
          },
        });
        pushLog(
          report.verdict === "authentic" ? "success" : report.verdict === "suspicious" || report.verdict === "needs-more-info" ? "warn" : "error",
          `Selfie: ${report.verdictLabel} · score ${report.score}/100 · confidence ${report.confidence}%`
        );
        if (mountedRef.current) setAnalyzeMsg("Detecting the face on-device…");
        await loadFaceModels((m) => pushLog("debug", `Selfie: ${m}`));
        const img = await loadImageEl(file);
        const face = await describeFaceRobust(img, (m) => {
          if (mountedRef.current) setAnalyzeMsg(m);
        });
        const facesDetected = await countFaces(img);
        pushLog(
          face ? (face.quality.ok ? "success" : "warn") : "warn",
          face
            ? `Selfie face detected · ${face.quality.boxWidth}px · detection ${face.quality.detectionScore} (${face.detector ?? "tiny"}) · ensemble ×${face.variants?.length ?? 1}${face.quality.ok ? "" : ` · ${face.quality.issues.length} quality issue(s)`}`
            : "No face detected in the selfie — retake frontal and well lit"
        );
        if (facesDetected > 1) {
          pushLog("warn", `Selfie: ${facesDetected} faces detected in the frame — coaching/coercion review signal, retake alone`);
        }
        if (!mountedRef.current) {
          revokeIfBlobUrl(img.src);
          return;
        }
        setFaceResult((prev) => {
          if (prev) revokeIfBlobUrl(prev.url);
          return { mode: "native-selfie", face, url: img.src, blob: file, report, liveness: null, facesDetected: facesDetected >= 0 ? facesDetected : null };
        });
        setAiState((prev) => ({ ...prev, selfie: { verdict: null, loading: false, error: null } }));
        if (navigator.vibrate) navigator.vibrate(15);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("error", `Selfie analysis failed (capture kept — retry from the step): ${msg}`);
        if (mountedRef.current) {
          setFailedSelfie({ file, url: URL.createObjectURL(file), prov, error: msg });
        }
      } finally {
        if (mountedRef.current) {
          setAnalyzing(false);
          setAnalyzeMsg("");
        }
      }
    },
    [pushLog]
  );

  const handleLivenessResult = useCallback(
    (r: LivenessSessionResult) => {
      if (!mountedRef.current) return;
      setResume(null);
      setFaceResult((prev) => {
        if (prev) revokeIfBlobUrl(prev.url);
        return {
          mode: "liveness",
          face: r.face,
          url: r.faceImageUrl,
          report: null,
          liveness: { verdict: r.verdict, findings: r.findings, pulse: r.pulse },
        };
      });
      pushLog(
        r.face ? "success" : "warn",
        r.face
          ? `Liveness session captured an identity face (${r.face.quality.boxWidth}px, detection ${r.face.quality.detectionScore})`
          : "Liveness session ended without a usable identity frame — face match unavailable until repeated"
      );
    },
    [pushLog]
  );

  /**
   * Optional in-browser liveness + pulse add-on for native-selfie flows:
   * merges the live session evidence into the existing face step without
   * dropping the selfie's EXIF/pixel forensic report. Its verdict feeds
   * computeOverall exactly like a full liveness step.
   */
  const handleAddonLiveness = useCallback(
    (r: LivenessSessionResult) => {
      if (!mountedRef.current) return;
      setFaceResult((prev) => {
        if (!prev) {
          return {
            mode: "liveness",
            face: r.face,
            url: r.faceImageUrl,
            report: null,
            liveness: { verdict: r.verdict, findings: r.findings, pulse: r.pulse },
          };
        }
        return { ...prev, face: prev.face ?? r.face, liveness: { verdict: r.verdict, findings: r.findings, pulse: r.pulse } };
      });
      pushLog(
        r.verdict === "live" ? "success" : r.verdict === "not-live" ? "error" : "warn",
        `Add-on liveness session: ${r.verdict.toUpperCase()}${r.pulse.bpm ? ` · ${r.pulse.bpm} BPM` : ""} — result now feeds the final PASS/REVIEW/FAIL verdict and both exports`
      );
    },
    [pushLog]
  );

  const runAiFor = useCallback(
    async (key: string, blob: Blob) => {
      if (!mountedRef.current) return;
      setAiState((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { verdict: null }), verdict: prev[key]?.verdict ?? null, loading: true, error: null } }));
      pushLog("info", `AI verdict requested (${key})…`);
      try {
        const verdict = await requestImageAiVerdict(blob);
        if (!mountedRef.current) return;
        setAiState((prev) => ({ ...prev, [key]: { verdict, loading: false, error: null } }));
        pushLog(verdict.verdict === "authentic" ? "success" : "warn", `AI verdict (${key}): ${verdict.verdict} (${verdict.confidence}%)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!mountedRef.current) return;
        setAiState((prev) => ({ ...prev, [key]: { verdict: null, loading: false, error: msg } }));
        pushLog("error", `AI verdict failed (${key}): ${msg}`);
      }
    },
    [pushLog]
  );

  const orderedPages: PageResult[] = useMemo(
    () => (template ? template.pages.map((p) => pageResults[p.id]).filter((p): p is PageResult => p != null) : []),
    [pageResults, template]
  );

  const aiVerdicts: SessionAiVerdicts = useMemo(() => {
    const out: SessionAiVerdicts = {};
    for (const [k, v] of Object.entries(aiState)) out[k] = v.verdict;
    return out;
  }, [aiState]);

  const compare: FaceCompare | null = useMemo(() => {
    const portrait = orderedPages.find((p) => p.page.portrait && p.portrait)?.portrait ?? null;
    if (!portrait || !faceResult?.face) return null;
    return compareFaces(portrait, faceResult.face);
  }, [faceResult, orderedPages]);

  const overall = useMemo(
    () => (template ? computeOverall(template, orderedPages, faceResult, compare, aiVerdicts) : null),
    [aiVerdicts, compare, faceResult, orderedPages, template]
  );

  const crossFindings = useMemo(() => licenceCrossFindings(orderedPages), [orderedPages]);

  /** Honest per-check coverage matrix for the summary + exports. */
  const coverage: CheckCoverage[] = useMemo(
    () => (template ? buildChecksCoverage(template, orderedPages, faceResult, compare, aiVerdicts, aiVerdictAvailable()) : []),
    [aiVerdicts, compare, faceResult, orderedPages, template]
  );

  /** Count of checks still runnable from the summary ("Run all remaining checks"). */
  const remainingChecks = useMemo(() => {
    if (!template) return 0;
    let n = 0;
    const aiOk = aiVerdictAvailable();
    for (const p of orderedPages) {
      if (aiOk && !aiState[p.page.id]?.verdict) n++;
      if (template.doc === "licence" && p.page.id === "back") {
        if (!p.barcode) n++;
      } else if (aiOk && !p.docData) {
        n++;
      }
    }
    if (aiOk && faceResult?.blob && !aiState.selfie?.verdict) n++;
    return n;
  }, [aiState, faceResult, orderedPages, template]);

  const runAllRemaining = useCallback(async () => {
    if (!template) return;
    setRunningAll(true);
    pushLog("info", `Running all remaining checks (${remainingChecks})…`);
    try {
      const aiOk = aiVerdictAvailable();
      for (const p of orderedPages) {
        if (template.doc === "licence" && p.page.id === "back") {
          if (!p.barcode) await runBarcodeFor(p.page.id, p.page.label, p.blob);
        } else if (aiOk && !p.docData) {
          await runDeepDataFor(p.page.id, p.page.label, p.blob);
        }
        if (aiOk && !aiState[p.page.id]?.verdict) await runAiFor(p.page.id, p.blob);
        if (!mountedRef.current) return;
      }
      if (aiOk && faceResult?.blob && !aiState.selfie?.verdict) await runAiFor("selfie", faceResult.blob);
      pushLog("success", "All remaining checks completed");
    } finally {
      if (mountedRef.current) setRunningAll(false);
    }
  }, [aiState, faceResult, orderedPages, pushLog, remainingChecks, runAiFor, runBarcodeFor, runDeepDataFor, template]);

  const exportText = useCallback(() => {
    if (!template || !overall) return "";
    const base = buildSessionReportText(template, orderedPages, faceResult, compare, overall, aiVerdicts, aiVerdictAvailable());
    return [base.replace(/\n=== END OF REPORT ===$/, ""), "", buildLedgerText(), "", "=== END OF REPORT ==="].join("\n");
  }, [aiVerdicts, compare, faceResult, orderedPages, overall, template]);

  /** Structured JSON export with the complete Capture Feed Ledger merged in. */
  const exportJson = useCallback(() => {
    if (!template || !overall) return "";
    const base = JSON.parse(buildSessionJson(template, orderedPages, faceResult, compare, overall, aiVerdicts, aiVerdictAvailable())) as Record<string, unknown>;
    base.captureFeedLedger = buildLedgerJsonObject();
    return JSON.stringify(base, null, 2);
  }, [aiVerdicts, compare, faceResult, orderedPages, overall, template]);

  /**
   * Builds a temporary share link: the compact summary (no images) is
   * compressed into the URL fragment — nothing touches a server — and the
   * viewer refuses links older than 72 h. Uses the native share sheet when
   * available, clipboard otherwise.
   */
  const shareSummaryLink = useCallback(async () => {
    if (!template || !overall) return;
    setSharing(true);
    try {
      const payload = await encodeShareSummary(buildShareSummary(template, orderedPages, faceResult, compare, overall, aiVerdicts));
      const url = `${window.location.origin}/shared#${payload}`;
      pushLog("info", `Share link built (${url.length} chars) — summary only, no images, valid 72 h`);
      if (navigator.share) {
        try {
          await navigator.share({ title: `Verification summary — ${template.name}`, url });
          pushLog("success", "Share sheet opened with the summary link");
          return;
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") return;
          // Share sheet unavailable/failed — fall through to clipboard.
        }
      }
      await navigator.clipboard.writeText(url);
      pushLog("success", "Temporary share link copied to clipboard (valid 72 h)");
    } catch (err) {
      pushLog("error", `Share link failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mountedRef.current) setSharing(false);
    }
  }, [aiVerdicts, compare, faceResult, orderedPages, overall, pushLog, template]);

  const restart = useCallback(() => {
    orderedPages.forEach((p) => URL.revokeObjectURL(p.url));
    if (faceResult) revokeIfBlobUrl(faceResult.url);
    if (failedDoc) revokeIfBlobUrl(failedDoc.url);
    if (failedSelfie) revokeIfBlobUrl(failedSelfie.url);
    setPageResults({});
    setFaceResult(null);
    setAiState({});
    setFailedDoc(null);
    setFailedSelfie(null);
    void clearSession(sessionKey).catch(() => undefined);
    if (template) ledgerReset(template.name);
    goTo(0);
    pushLog("info", "Session restarted");
  }, [faceResult, failedDoc, failedSelfie, goTo, orderedPages, pushLog, sessionKey, template]);

  const copyLogs = useCallback(() => {
    const text = logs.map((l) => `${l.ts} [${l.level}] ${l.message}`).join("\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => pushLog("success", `Copied ${logs.length} log entries to clipboard`))
      .catch((err: unknown) => pushLog("error", `Clipboard failed: ${err instanceof Error ? err.message : String(err)}`));
  }, [logs, pushLog]);

  if (!template) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-3 px-4">
        <ShieldAlert className="h-10 w-10 text-amber-400" />
        <p className="text-sm text-muted-foreground">Unknown verification template.</p>
        <Button asChild variant="secondary">
          <Link to="/">Back to Dashboard</Link>
        </Button>
      </div>
    );
  }

  const faceStepIndex = steps.findIndex((s) => s.kind === "face");

  return (
    <div className="mx-auto min-h-dvh max-w-lg px-3 pb-10 sm:px-4">
      <header className="sticky top-0 z-20 -mx-3 mb-3 border-b border-border/60 bg-background/90 px-3 pb-2.5 pt-3 backdrop-blur sm:-mx-4 sm:px-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => navigate("/")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[14px] font-semibold leading-tight">{template.name}</h1>
            <p className="mono text-[10px] text-muted-foreground">
              step {Math.min(stepIndex + 1, steps.length)} of {steps.length} ·{" "}
              {step?.kind === "doc" ? step.page.label : step?.kind === "face" ? "live face" : "summary"}
            </p>
          </div>
        </div>
        <div className="mt-2 flex gap-1">
          {steps.map((s, i) => (
            <div
              key={`${s.kind}-${s.kind === "doc" ? s.page.id : i}`}
              className={cn("h-1 flex-1 rounded-full transition-colors duration-500", i < stepIndex ? "bg-emerald-400" : i === stepIndex ? "bg-primary" : "bg-muted")}
            />
          ))}
        </div>
      </header>

      <div className="space-y-3.5">
        {resume ? (
          <section className="animate-rise space-y-2 rounded-2xl border border-primary/40 bg-primary/10 p-3.5">
            <div className="flex items-center gap-2">
              <History className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold">Resume previous session?</div>
                <p className="text-[10.5px] leading-snug text-muted-foreground">
                  Saved {Math.max(1, Math.round((Date.now() - resume.savedAt) / 60000))} min ago · {resume.pages.length} document page(s)
                  {resume.face ? " + face step" : ""} captured. Page reloads no longer lose your progress.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Button className="h-11 bg-primary text-primary-foreground" onClick={() => applyResume(resume)}>
                <History className="mr-1.5 h-4 w-4" />
                Resume
              </Button>
              <Button variant="secondary" className="h-11" onClick={discardResume}>
                <Trash2 className="mr-1.5 h-4 w-4" />
                Discard
              </Button>
            </div>
          </section>
        ) : null}

        {analyzing ? (
          <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-4">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-[13px] font-medium">Running forensic analysis…</span>
            </div>
            <p className="mono min-h-8 text-[10.5px] leading-snug text-muted-foreground">{analyzeMsg}</p>
          </div>
        ) : step?.kind === "doc" ? (
          (() => {
            const result = pageResults[step.page.id];
            if (!result && failedDoc && failedDoc.page.id === step.page.id) {
              return (
                <section className="space-y-3 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3.5">
                  <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                    {step.page.label} — analysis failed (photo kept)
                  </h2>
                  <img src={failedDoc.url} alt={step.page.label} className="max-h-64 w-full rounded-xl object-contain ring-1 ring-border" />
                  <p className="mono text-[10px] text-amber-300">{failedDoc.error}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      className="h-12"
                      onClick={() => {
                        revokeIfBlobUrl(failedDoc.url);
                        setFailedDoc(null);
                        pushLog("info", `${step.page.label}: capture discarded, retaking`);
                      }}
                    >
                      <RefreshCcw className="mr-1.5 h-4 w-4" />
                      Retake
                    </Button>
                    <Button
                      className="h-12 bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                      onClick={() => void handleDocCapture(failedDoc.page, failedDoc.blob, failedDoc.meta, failedDoc.opts)}
                    >
                      <RotateCcw className="mr-1.5 h-4 w-4" />
                      Retry Analysis
                    </Button>
                  </div>
                </section>
              );
            }
            if (!result) {
              return (
                <section className="rounded-2xl border border-border/70 bg-card p-3.5">
                  <h2 className="mb-1 text-[13px] font-semibold">{step.page.label}</h2>
                  {template.docCapture === "webrtc" ? (
                    <LiveDocCapture
                      guideAspect={step.page.guideAspect}
                      hint={step.page.hint}
                      pushLog={pushLog}
                      onCapture={(blob, meta, channelFindings) => void handleDocCapture(step.page, blob, meta, { channelFindings })}
                    />
                  ) : (
                    <NativeCaptureStep
                      facing="environment"
                      buttonLabel={`Photograph ${step.page.label}`}
                      hint={step.page.hint}
                      pushLog={pushLog}
                      onCapture={(file, provenance) => void handleDocCapture(step.page, file, `Native camera app · ${file.name} · ${(file.size / 1024).toFixed(0)} KB`, { provenance })}
                    />
                  )}
                </section>
              );
            }
            const gateFailed = result.quickQuality != null && !result.quickQuality.ok;
            return (
              <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-3.5">
                <h2 className="text-[13px] font-semibold">{step.page.label} — captured</h2>
                <img src={result.url} alt={step.page.label} className="max-h-64 w-full rounded-xl object-contain ring-1 ring-border" />
                {gateFailed && result.quickQuality ? (
                  <div className="space-y-1 rounded-xl border border-amber-500/50 bg-amber-500/10 p-2.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Instant quality check — retake now recommended
                    </div>
                    {result.quickQuality.issues.map((i) => (
                      <p key={i} className="text-[10.5px] leading-snug text-foreground/90">
                        • {i}
                      </p>
                    ))}
                    <p className="mono text-[10px] text-muted-foreground">
                      sharpness {result.quickQuality.sharpness} · glare {(result.quickQuality.glareFraction * 100).toFixed(1)}% · shadow{" "}
                      {(result.quickQuality.darkFraction * 100).toFixed(1)}%
                    </p>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  <VerdictMiniChip report={result.report} />
                  {step.page.portrait ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold",
                        result.portrait
                          ? result.portrait.quality.ok
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                            : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                      )}
                    >
                      <ScanFace className="h-3 w-3" />
                      {result.portrait ? `portrait ${result.portrait.quality.boxWidth}px${result.portrait.quality.ok ? "" : " · quality issues"}` : "no portrait found"}
                    </span>
                  ) : null}
                  {result.barcode ? (
                    <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold", BARCODE_OUTCOME_STYLE[result.barcode.outcome].cls)}>
                      <Barcode className="h-3 w-3" />
                      {BARCODE_OUTCOME_STYLE[result.barcode.outcome].label}
                    </span>
                  ) : null}
                  {result.docData ? (
                    <span
                      className={cn(
                        "inline-flex items-center rounded-md border px-2 py-0.5 text-[10.5px] font-semibold",
                        result.docData.outcome === "consistent" || result.docData.outcome === "no-mrz"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                          : result.docData.outcome === "unreadable"
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                            : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                      )}
                    >
                      data {result.docData.outcome}
                    </span>
                  ) : null}
                  {result.docData ? <DocConfidenceBadge check={result.docData} /> : null}
                </div>
                <p className="mono text-[10px] text-muted-foreground">{result.captureMeta}</p>
                {result.report.retakeAdvice.length > 0 ? (
                  <div className="space-y-1 rounded-xl border border-sky-500/30 bg-sky-500/5 p-2.5">
                    <div className="text-[10.5px] font-medium uppercase tracking-wide text-sky-300">Retake requested</div>
                    {result.report.retakeAdvice.map((a) => (
                      <p key={a} className="text-[10.5px] leading-snug text-foreground/90">
                        • {a}
                      </p>
                    ))}
                  </div>
                ) : null}
                {result.portrait && !result.portrait.quality.ok ? (
                  <div className="space-y-0.5">
                    {result.portrait.quality.issues.map((i) => (
                      <p key={i} className="text-[10px] leading-snug text-amber-300">
                        • {i}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    className={cn("h-12", gateFailed ? "bg-amber-500 text-amber-950 hover:bg-amber-400" : "")}
                    onClick={() => {
                      URL.revokeObjectURL(result.url);
                      setPageResults((prev) => {
                        const next = { ...prev };
                        delete next[step.page.id];
                        return next;
                      });
                      pushLog("info", `${step.page.label}: retake started`);
                    }}
                  >
                    <RefreshCcw className="mr-1.5 h-4 w-4" />
                    {gateFailed ? "Retake Now" : "Retake"}
                  </Button>
                  <Button
                    variant={gateFailed ? "secondary" : "default"}
                    className={cn("h-12", gateFailed ? "" : "bg-emerald-500 text-emerald-950 hover:bg-emerald-400")}
                    onClick={() => goTo(stepIndex + 1)}
                  >
                    Continue
                    <ChevronRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">The full ultra-detailed report for this page is on the final summary screen.</p>
              </section>
            );
          })()
        ) : step?.kind === "face" ? (
          <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-3.5">
            <h2 className="text-[13px] font-semibold">
              {template.faceMode === "liveness" ? "Live Face — Liveness + Pulse" : "Live Face — Native Selfie"}
            </h2>
            {template.faceMode === "liveness" ? (
              <>
                <LivenessCheck pushLog={pushLog} captureIdentity onResult={handleLivenessResult} />
                {faceResult?.mode === "liveness" ? (
                  <div className="space-y-2 rounded-xl border border-border/70 bg-background/40 p-2.5">
                    <div className="flex items-center gap-2">
                      {faceResult.url ? <img src={faceResult.url} alt="Captured face" className="h-14 w-14 rounded-lg object-cover ring-1 ring-border" /> : null}
                      <p className="text-[10.5px] leading-snug text-muted-foreground">
                        {faceResult.face
                          ? `Identity frame captured (${faceResult.face.quality.boxWidth}px, detection ${faceResult.face.quality.detectionScore}) — it will be compared to the document portrait.`
                          : "No usable identity frame was captured — run the session again for the face match."}
                      </p>
                    </div>
                    <Button className="h-12 w-full bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={() => goTo(stepIndex + 1)}>
                      Continue to Summary
                      <ChevronRight className="ml-1.5 h-4 w-4" />
                    </Button>
                  </div>
                ) : null}
              </>
            ) : failedSelfie && faceResult?.mode !== "native-selfie" ? (
              <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-2.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <AlertTriangle className="h-4 w-4 text-amber-400" />
                  Selfie analysis failed (photo kept)
                </div>
                <img src={failedSelfie.url} alt="Selfie" className="max-h-48 w-full rounded-xl object-contain ring-1 ring-border" />
                <p className="mono text-[10px] text-amber-300">{failedSelfie.error}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    className="h-12"
                    onClick={() => {
                      revokeIfBlobUrl(failedSelfie.url);
                      setFailedSelfie(null);
                    }}
                  >
                    <RefreshCcw className="mr-1.5 h-4 w-4" />
                    Retake
                  </Button>
                  <Button
                    className="h-12 bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                    onClick={() => void handleSelfieCapture(failedSelfie.file, failedSelfie.prov)}
                  >
                    <RotateCcw className="mr-1.5 h-4 w-4" />
                    Retry Analysis
                  </Button>
                </div>
              </div>
            ) : faceResult?.mode === "native-selfie" ? (
              <div className="space-y-3">
                {faceResult.url ? <img src={faceResult.url} alt="Selfie" className="max-h-64 w-full rounded-xl object-contain ring-1 ring-border" /> : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  {faceResult.report ? <VerdictMiniChip report={faceResult.report} /> : null}
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold",
                      faceResult.face
                        ? faceResult.face.quality.ok
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                        : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                    )}
                  >
                    <ScanFace className="h-3 w-3" />
                    {faceResult.face ? `face ${faceResult.face.quality.boxWidth}px${faceResult.face.quality.ok ? "" : " · quality issues"}` : "no face found"}
                  </span>
                  {faceResult.facesDetected != null && faceResult.facesDetected > 1 ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-300">
                      <UserX className="h-3 w-3" />
                      {faceResult.facesDetected} faces in frame
                    </span>
                  ) : null}
                </div>
                {faceResult.facesDetected != null && faceResult.facesDetected > 1 ? (
                  <p className="text-[10.5px] leading-snug text-amber-300">
                    Multiple faces were detected — verification selfies must show only you. Retake alone; this raises a review flag.
                  </p>
                ) : null}
                {faceResult.face && !faceResult.face.quality.ok ? (
                  <div className="space-y-0.5">
                    {faceResult.face.quality.issues.map((i) => (
                      <p key={i} className="text-[10px] leading-snug text-amber-300">
                        • {i}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    className="h-12"
                    onClick={() =>
                      setFaceResult((prev) => {
                        if (prev) revokeIfBlobUrl(prev.url);
                        return null;
                      })
                    }
                  >
                    <RefreshCcw className="mr-1.5 h-4 w-4" />
                    Retake
                  </Button>
                  <Button className="h-12 bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={() => goTo(stepIndex + 1)}>
                    Continue
                    <ChevronRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <NativeCaptureStep
                facing="user"
                buttonLabel="Take Selfie with Camera App"
                hint="Hold the phone at eye level, face centered and well lit, no hat or sunglasses. The selfie gets full EXIF forensics plus on-device face quality gates."
                pushLog={pushLog}
                onCapture={(file, provenance) => void handleSelfieCapture(file, provenance)}
              />
            )}
          </section>
        ) : step?.kind === "summary" && overall ? (
          <>
            <section
              className={cn(
                "animate-rise rounded-2xl border p-4",
                overall.verdict === "pass"
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : overall.verdict === "review"
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-rose-500/40 bg-rose-500/10"
              )}
            >
              <div className="flex items-center gap-3">
                {overall.verdict === "pass" ? (
                  <ShieldCheck className="h-9 w-9 shrink-0 text-emerald-400" />
                ) : overall.verdict === "review" ? (
                  <ShieldAlert className="h-9 w-9 shrink-0 text-amber-400" />
                ) : (
                  <ShieldX className="h-9 w-9 shrink-0 text-rose-400" />
                )}
                <div>
                  <div
                    className={cn(
                      "text-xl font-bold tracking-tight",
                      overall.verdict === "pass" ? "text-emerald-300" : overall.verdict === "review" ? "text-amber-300" : "text-rose-300"
                    )}
                  >
                    {overall.verdict === "pass" ? "PASS" : overall.verdict === "review" ? "REVIEW" : "FAIL"}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {overall.verdict === "pass"
                      ? "All checks are consistent with a genuine session."
                      : overall.verdict === "review"
                        ? "Evidence is incomplete or ambiguous — corrective actions below, no accusation made."
                        : "Hard, corroborated fraud signals were found."}
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-1">
                {overall.reasons.map((r) => (
                  <p key={r} className="flex items-start gap-1.5 text-[11px] leading-snug text-foreground/90">
                    <CheckCircle2 className={cn("mt-0.5 h-3 w-3 shrink-0", overall.verdict === "pass" ? "text-emerald-400" : overall.verdict === "review" ? "text-amber-400" : "text-rose-400")} />
                    {r}
                  </p>
                ))}
              </div>
            </section>

            {remainingChecks > 0 ? (
              <section className="animate-rise rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-3.5" style={{ animationDelay: "60ms" }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                      <Sparkles className="h-4 w-4 text-fuchsia-400" />
                      {remainingChecks} check{remainingChecks === 1 ? "" : "s"} not run yet
                    </div>
                    <p className="text-[10.5px] leading-snug text-muted-foreground">
                      AI verdicts, deep data reads, and barcode decodes that haven't run. Their results feed the PASS/REVIEW/FAIL verdict and both exports.
                    </p>
                  </div>
                </div>
                <Button className="mt-2 h-12 w-full bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" disabled={runningAll} onClick={() => void runAllRemaining()}>
                  {runningAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {runningAll ? "Running remaining checks…" : "Run All Remaining Checks"}
                </Button>
              </section>
            ) : null}

            <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "90ms" }}>
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                Checks Coverage — what ran and what didn't
              </h2>
              <p className="text-[10.5px] leading-snug text-muted-foreground">
                Every check this flow can involve, with its real status. Nothing is silently skipped — checks that didn't run say exactly why and
                how to run them.
              </p>
              <div className="space-y-1.5">
                {coverage.map((c) => (
                  <div key={c.id} className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/40 p-2">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex w-[62px] shrink-0 items-center justify-center rounded-md border px-1 py-0.5 text-[9px] font-bold tracking-wide",
                        COVERAGE_CHIP[c.status].cls
                      )}
                    >
                      {COVERAGE_CHIP[c.status].label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium leading-tight">{c.label}</div>
                      {c.result ? <p className="mono mt-0.5 text-[10px] leading-snug text-muted-foreground">{c.result}</p> : null}
                      {c.note ? <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{c.note}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {overall.correctiveActions.length > 0 ? (
              <section className="animate-rise space-y-1.5 rounded-2xl border border-sky-500/30 bg-sky-500/5 p-3.5" style={{ animationDelay: "120ms" }}>
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sky-300">
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Corrective actions
                </div>
                {overall.correctiveActions.map((a) => (
                  <p key={a} className="text-[11px] leading-snug text-foreground/90">
                    • {a}
                  </p>
                ))}
              </section>
            ) : null}

            {template.faceMode !== "none" ? (
              <section className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "180ms" }}>
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <ScanFace className="h-4 w-4 text-teal-400" />
                  Face Match — Document vs Live
                </h2>
                {compare ? (
                  <div className="flex items-center gap-3">
                    <ScoreRing
                      score={compare.outcome.similarity}
                      color={compare.outcome.verdict === "match" ? "hsl(152 65% 52%)" : compare.outcome.verdict === "mismatch" ? "hsl(0 84% 60%)" : "hsl(204 90% 60%)"}
                      caption="similarity"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold",
                          compare.outcome.verdict === "match"
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                            : compare.outcome.verdict === "mismatch"
                              ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                              : "border-sky-500/40 bg-sky-500/10 text-sky-300"
                        )}
                      >
                        {compare.outcome.verdict === "match" ? <UserCheck className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />}
                        {compare.outcome.verdict === "match" ? "SAME PERSON" : compare.outcome.verdict === "mismatch" ? "DIFFERENT PERSON" : "UNCERTAIN — RETAKE"}
                      </div>
                      <p className="mono text-[10px] text-muted-foreground">
                        distance {compare.outcome.distance} · match ≤{MATCH_DISTANCE_MAX} · mismatch ≥{MISMATCH_DISTANCE_MIN}
                      </p>
                      {compare.reasons.map((r) => (
                        <p key={r} className="text-[10px] leading-snug text-muted-foreground">
                          • {r}
                        </p>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Face match unavailable — {orderedPages.find((p) => p.page.portrait)?.portrait ? "no usable live face was captured." : "no portrait was detected on the document."}{" "}
                    Retake the missing step below.
                  </p>
                )}
              </section>
            ) : null}

            {crossFindings.length > 0 ? (
              <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "220ms" }}>
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <Barcode className="h-4 w-4 text-cyan-400" />
                  Licence Data Cross-Check — Barcode vs Front
                </h2>
                <div className="space-y-1.5">
                  {crossFindings.map((f) => (
                    <FindingRow key={f.id} finding={f} />
                  ))}
                </div>
              </section>
            ) : null}

            {template.faceMode === "native-selfie" ? (
              <section className="animate-rise space-y-2 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-3.5" style={{ animationDelay: "230ms" }}>
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <HeartPulse className="h-4 w-4 text-rose-400" />
                  Optional Add-On — Live Liveness + Pulse
                </h2>
                <p className="text-[10.5px] leading-snug text-muted-foreground">
                  A native selfie is a still photo — it cannot prove the person was live, and a pulse physically cannot be measured from it. This
                  optional in-browser session adds a quick smile challenge (smile → smile a bit more, ~7–9 seconds) and rPPG pulse measurement on
                  top of the selfie forensics. Its result feeds the final PASS/REVIEW/FAIL verdict and both exports.
                </p>
                {faceResult?.liveness && !addonLiveness ? (
                  <div
                    className={cn(
                      "inline-block rounded-md border px-2 py-1 text-[11px] font-semibold",
                      faceResult.liveness.verdict === "live"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        : faceResult.liveness.verdict === "not-live"
                          ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                          : "border-sky-500/40 bg-sky-500/10 text-sky-300"
                    )}
                  >
                    {faceResult.liveness.verdict === "live" ? "LIVE PERSON VERIFIED" : faceResult.liveness.verdict === "not-live" ? "NOT LIVE" : "INCONCLUSIVE"}
                    {faceResult.liveness.pulse?.bpm ? ` · ${faceResult.liveness.pulse.bpm} BPM` : ""}
                  </div>
                ) : null}
                {addonLiveness ? (
                  <LivenessCheck pushLog={pushLog} captureIdentity={!faceResult?.face} onResult={handleAddonLiveness} />
                ) : (
                  <Button className="h-12 w-full bg-rose-500 text-rose-950 hover:bg-rose-400" onClick={() => setAddonLiveness(true)}>
                    <HeartPulse className="mr-2 h-4 w-4" />
                    {faceResult?.liveness ? "Run Liveness + Pulse Again" : "Run Liveness + Pulse Now"}
                  </Button>
                )}
              </section>
            ) : null}

            {faceResult?.liveness ? (
              <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "240ms" }}>
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <HeartPulse className="h-4 w-4 text-rose-400" />
                  Liveness + Pulse Evidence
                </h2>
                <div
                  className={cn(
                    "inline-block rounded-md border px-2 py-1 text-[11px] font-semibold",
                    faceResult.liveness.verdict === "live"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : faceResult.liveness.verdict === "not-live"
                        ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                        : "border-sky-500/40 bg-sky-500/10 text-sky-300"
                  )}
                >
                  {faceResult.liveness.verdict === "live" ? "LIVE PERSON VERIFIED" : faceResult.liveness.verdict === "not-live" ? "NOT LIVE — REPLAY / INJECTION" : "INCONCLUSIVE"}
                  {faceResult.liveness.pulse?.bpm ? ` · ${faceResult.liveness.pulse.bpm} BPM` : ""}
                </div>
                <div className="space-y-1.5">
                  {faceResult.liveness.findings.map((f) => (
                    <FindingRow key={f.id} finding={f} />
                  ))}
                </div>
              </section>
            ) : null}

            {orderedPages.map((p, i) => {
              const ai = aiState[p.page.id] ?? { verdict: null, loading: false, error: null };
              return (
                <section key={p.page.id} className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: `${280 + i * 60}ms` }}>
                  <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <Fingerprint className="h-4 w-4 text-fuchsia-400" />
                    {p.page.label} — Full Forensic Report
                  </h2>
                  <p className="mono text-[10px] text-muted-foreground">{p.captureMeta}</p>
                  {p.barcode ? <BarcodePanel barcode={p.barcode} /> : null}
                  {template.doc === "licence" && p.page.id === "back" ? null : (
                    <DocDataPanel
                      blob={p.blob}
                      docType={template.doc}
                      result={p.docData ?? null}
                      pushLog={pushLog}
                      onResult={(r: DocumentDataCheck) =>
                        setPageResults((prev) => (prev[p.page.id] ? { ...prev, [p.page.id]: { ...prev[p.page.id], docData: r } } : prev))
                      }
                    />
                  )}
                  <ReportView
                    report={p.report}
                    aiVerdict={ai.verdict}
                    aiLoading={ai.loading}
                    aiError={ai.error}
                    onRunAi={() => void runAiFor(p.page.id, p.blob)}
                    onCopied={(ok, msg) => pushLog(ok ? "success" : "error", msg)}
                  />
                </section>
              );
            })}

            {faceResult?.report && faceResult.url ? (
              <section className="animate-rise space-y-2.5 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "400ms" }}>
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <ScanFace className="h-4 w-4 text-teal-400" />
                  Selfie — Full Forensic Report
                </h2>
                <ReportView
                  report={faceResult.report}
                  aiVerdict={(aiState.selfie ?? { verdict: null }).verdict}
                  aiLoading={aiState.selfie?.loading ?? false}
                  aiError={aiState.selfie?.error ?? null}
                  onRunAi={() => {
                    if (faceResult.blob) {
                      void runAiFor("selfie", faceResult.blob);
                      return;
                    }
                    const url = faceResult.url;
                    if (!url) return;
                    void (async () => {
                      const blob = await (await fetch(url)).blob();
                      await runAiFor("selfie", blob);
                    })();
                  }}
                  onCopied={(ok, msg) => pushLog(ok ? "success" : "error", msg)}
                />
              </section>
            ) : null}

            <CaptureLedgerSection filePrefix={`verification-${template.id}`} />

            <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "460ms" }}>
              <h2 className="text-[13px] font-semibold">Export & Share</h2>
              <p className="text-[10.5px] leading-snug text-muted-foreground">
                Full evidence trail with every finding (observed vs expected, score impact), deep data + barcode checks, AI verdicts,
                corrective/retake actions, and session metadata — readable text plus structured JSON for hardening detection settings.
                Share creates a temporary link (72 h) carrying the summary only — no images, nothing stored on a server.
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  variant="secondary"
                  className="h-11"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(exportText())
                      .then(() => pushLog("success", "Session report copied to clipboard"))
                      .catch((err: unknown) => pushLog("error", `Clipboard failed: ${err instanceof Error ? err.message : String(err)}`));
                  }}
                >
                  <ClipboardCopy className="mr-1 h-3.5 w-3.5" />
                  Copy
                </Button>
                <Button
                  variant="secondary"
                  className="h-11"
                  onClick={() => {
                    downloadBlob(new Blob([exportText()], { type: "text/plain" }), `verification-${template.id}-${Date.now()}.txt`);
                    pushLog("success", "Session report downloaded (.txt)");
                  }}
                >
                  <FileDown className="mr-1 h-3.5 w-3.5" />
                  Text
                </Button>
                <Button
                  variant="secondary"
                  className="h-11"
                  onClick={() => {
                    downloadBlob(new Blob([exportJson()], { type: "application/json" }), `verification-${template.id}-${Date.now()}.json`);
                    pushLog("success", "Session report downloaded (.json) — includes the complete Capture Feed Ledger");
                  }}
                >
                  <FileJson className="mr-1 h-3.5 w-3.5" />
                  JSON
                </Button>
                <Button variant="secondary" className="h-11" disabled={sharing} onClick={() => void shareSummaryLink()}>
                  {sharing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Share2 className="mr-1 h-3.5 w-3.5" />}
                  Share Link
                </Button>
              </div>
            </section>

            <section className="animate-rise space-y-2 rounded-2xl border border-border/70 bg-card p-3.5" style={{ animationDelay: "520ms" }}>
              <h2 className="text-[13px] font-semibold">Retake a Step</h2>
              <div className="grid grid-cols-2 gap-1.5">
                {template.pages.map((p, i) => (
                  <Button
                    key={p.id}
                    variant="secondary"
                    className="h-11"
                    onClick={() => {
                      const old = pageResults[p.id];
                      if (old) URL.revokeObjectURL(old.url);
                      setPageResults((prev) => {
                        const next = { ...prev };
                        delete next[p.id];
                        return next;
                      });
                      goTo(i);
                    }}
                  >
                    <RefreshCcw className="mr-1 h-3.5 w-3.5" />
                    {p.label}
                  </Button>
                ))}
                {template.faceMode !== "none" && faceStepIndex >= 0 ? (
                  <Button
                    variant="secondary"
                    className="h-11"
                    onClick={() => {
                      setFaceResult((prev) => {
                        if (prev) revokeIfBlobUrl(prev.url);
                        return null;
                      });
                      goTo(faceStepIndex);
                    }}
                  >
                    <ScanFace className="mr-1 h-3.5 w-3.5" />
                    Face step
                  </Button>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <Button variant="outline" className="h-11" onClick={restart}>
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                  Start Over
                </Button>
                <Button variant="outline" className="h-11" asChild>
                  <Link to="/">
                    <Home className="mr-1 h-3.5 w-3.5" />
                    Dashboard
                  </Link>
                </Button>
              </div>
            </section>
          </>
        ) : null}

        <details className="rounded-2xl border border-border/70 bg-card">
          <summary className="flex cursor-pointer items-center gap-2 p-3 text-[12px] font-medium text-muted-foreground">
            <Terminal className="h-4 w-4" />
            Debug console ({logs.length})
          </summary>
          <div className="border-t border-border/60 bg-black/40">
            <div className="flex justify-end px-2 pt-1.5">
              <Button variant="ghost" size="sm" className="h-8 px-2 text-[11px] text-muted-foreground" onClick={copyLogs}>
                <ClipboardCopy className="mr-1 h-3 w-3" />
                Copy logs
              </Button>
            </div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto p-2.5 pt-1">
              {logs.length === 0 ? <p className="text-[10px] text-muted-foreground">No log entries yet.</p> : null}
              {[...logs].reverse().map((l) => (
                <p key={l.id} className={cn("mono text-[10px] leading-snug", LOG_COLOR[l.level])}>
                  <span className="opacity-50">{l.ts}</span> {l.message}
                </p>
              ))}
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
