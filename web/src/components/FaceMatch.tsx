import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, Camera, Loader2, ScanFace, Upload, UserCheck, UserX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CaptureCancelledError, capacitorCapturePhoto, fsPickerCapturePhoto, inputAcceptAttr, inputCaptureAttr, useCaptureEngine } from "@/lib/capture-engine";
import { cn } from "@/lib/utils";
import {
  compareFaceDescriptions,
  describeFaceRobust,
  loadFaceModels,
  MATCH_DISTANCE_MAX,
  MISMATCH_DISTANCE_MIN,
  type EnsembleMatch,
  type FaceDescription,
} from "@/lib/face-vision";
import type { LogEntry, LogLevel } from "@/lib/camera-diagnostics";
import { ScoreRing } from "@/components/ReportView";
import EvidencePackButton from "@/components/EvidencePackButton";
import { originForCaptureEngine, type PackInput, type PackMediaItem, type PackOrigin } from "@/lib/evidence-pack";
import { deviceCameraCapturePhoto } from "@/components/verify/DeviceCameraSheet";

type SlotState = {
  url: string | null;
  fileName: string | null;
  /** Original picked/captured file, kept so the evidence pack can archive it unmodified. */
  blob: File | null;
  face: FaceDescription | null;
  error: string | null;
  /** Declared by the capture path when it knows better than the engine default. */
  origin: PackOrigin | null;
};

const EMPTY_SLOT: SlotState = { url: null, fileName: null, blob: null, face: null, error: null, origin: null };

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

function FaceSlot({
  title,
  hint,
  slot,
  busy,
  captureUser,
  onFile,
}: {
  title: string;
  hint: string;
  slot: SlotState;
  busy: boolean;
  captureUser: boolean;
  onFile: (file: File, origin?: PackOrigin) => void;
}) {
  const captureEngine = useCaptureEngine();
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-background/40 p-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="relative flex h-36 items-center justify-center overflow-hidden rounded-lg bg-black/50 ring-1 ring-border">
        {slot.url ? (
          <img src={slot.url} alt={title} className="h-full w-full object-contain" />
        ) : (
          <span className="px-3 text-center text-[10px] text-muted-foreground">{hint}</span>
        )}
        {slot.face ? (
          <span className="absolute left-1 top-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
            face {slot.face.quality.boxWidth}px · det {slot.face.quality.detectionScore}
          </span>
        ) : null}
      </div>
      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept={inputAcceptAttr(captureEngine)}
        capture={inputCaptureAttr(captureEngine, captureUser ? "user" : "environment")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <Button size="sm" variant="secondary" className="h-9" disabled={busy} onClick={() => uploadRef.current?.click()}>
          <Upload className="mr-1 h-3.5 w-3.5" />
          Upload
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-9"
          disabled={busy}
          onClick={() => {
            if (captureEngine === "avfoundation") {
              deviceCameraCapturePhoto(captureUser ? "user" : "environment", undefined, title)
                .then((res) => onFile(res.file, res.origin))
                .catch((err: unknown) => {
                  if (!(err instanceof CaptureCancelledError)) console.error("FaceMatch: device-level capture failed", err);
                });
              return;
            }
            if (captureEngine === "capacitor") {
              capacitorCapturePhoto(captureUser ? "user" : "environment")
                .then((res) => onFile(res.file))
                .catch((err: unknown) => {
                  if (!(err instanceof CaptureCancelledError)) console.error("FaceMatch: Capacitor capture failed", err);
                });
              return;
            }
            if (captureEngine === "fs-picker") {
              fsPickerCapturePhoto()
                .then((res) => onFile(res.file))
                .catch((err: unknown) => {
                  if (!(err instanceof CaptureCancelledError)) console.error("FaceMatch: FS Access picker failed", err);
                });
              return;
            }
            cameraRef.current?.click();
          }}
        >
          <Camera className="mr-1 h-3.5 w-3.5" />
          Camera
        </Button>
      </div>
      {slot.error ? <p className="text-[10px] leading-snug text-rose-300">{slot.error}</p> : null}
      {slot.face && slot.face.quality.issues.length > 0 ? (
        <div className="space-y-0.5">
          {slot.face.quality.issues.map((issue) => (
            <p key={issue} className="flex items-start gap-1 text-[10px] leading-snug text-amber-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {issue}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * On-device face identity comparison: 128-d descriptors from two photos,
 * Match / Mismatch / Uncertain with quality-gated retake requests.
 */
export default function FaceMatch({ pushLog, logs }: { pushLog: (level: LogLevel, message: string) => void; logs?: LogEntry[] }) {
  /** Whether these bytes are a fresh camera file or a photo picked from storage. */
  const matchCaptureEngine = useCaptureEngine();
  const fileOrigin = useMemo<PackOrigin>(() => originForCaptureEngine(matchCaptureEngine), [matchCaptureEngine]);
  const [slotA, setSlotA] = useState<SlotState>(EMPTY_SLOT);
  const [slotB, setSlotB] = useState<SlotState>(EMPTY_SLOT);
  const [busy, setBusy] = useState<boolean>(false);
  const [outcome, setOutcome] = useState<EnsembleMatch | null>(null);
  const [retakeReasons, setRetakeReasons] = useState<string[]>([]);

  const handleFile = useCallback(
    async (file: File, which: "A" | "B", origin?: PackOrigin) => {
      const setSlot = which === "A" ? setSlotA : setSlotB;
      setOutcome(null);
      setRetakeReasons([]);
      setBusy(true);
      pushLog("info", `Face Match: analyzing ${which === "A" ? "reference" : "probe"} photo "${file.name}" (${(file.size / 1024).toFixed(0)} KB)`);
      try {
        await loadFaceModels((m) => pushLog("debug", `Face Match: ${m}`));
        const img = await loadImageEl(file);
        const face = await describeFaceRobust(img, (m) => pushLog("debug", `Face Match: ${m}`));
        if (!face) {
          setSlot((prev) => {
            if (prev.url) URL.revokeObjectURL(prev.url);
            return {
              url: img.src,
              fileName: file.name,
              blob: file,
              face: null,
              error: "No face detected — use a clear frontal photo with the face well lit.",
              origin: origin ?? null,
            };
          });
          pushLog("warn", `Face Match: no face found in "${file.name}"`);
        } else {
          setSlot((prev) => {
            if (prev.url) URL.revokeObjectURL(prev.url);
            return { url: img.src, fileName: file.name, blob: file, face, error: null, origin: origin ?? null };
          });
          pushLog(
            face.quality.ok ? "success" : "warn",
            `Face Match: face found in "${file.name}" · box ${face.quality.boxWidth}px · detection ${face.quality.detectionScore} (${face.detector ?? "tiny"}) · ensemble ×${face.variants?.length ?? 1} · brightness ${face.quality.brightness} · sharpness ${face.quality.sharpness}${face.quality.ok ? "" : ` · ${face.quality.issues.length} quality issue(s)`}`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSlot((prev) => {
          if (prev.url) URL.revokeObjectURL(prev.url);
          return { ...EMPTY_SLOT, error: msg };
        });
        pushLog("error", `Face Match failed: ${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [pushLog]
  );

  const compare = useCallback(() => {
    if (!slotA.face || !slotB.face) return;
    const issues = [...slotA.face.quality.issues.map((i) => `Photo 1: ${i}`), ...slotB.face.quality.issues.map((i) => `Photo 2: ${i}`)];
    const result = compareFaceDescriptions(slotA.face, slotB.face);
    if (!slotA.face.quality.ok || !slotB.face.quality.ok) {
      if (result.verdict === "mismatch") {
        setOutcome({ ...result, verdict: "uncertain" });
        setRetakeReasons([
          "A mismatch verdict was suppressed because photo quality is insufficient — a blurry, dark, or tiny face can look like a different person. Retake and compare again.",
          ...issues,
        ]);
        pushLog("warn", `Face Match: raw distance ${result.distance} would be MISMATCH but quality gates fired — returning UNCERTAIN + retake request (no false accusation).`);
        return;
      }
      setRetakeReasons(issues);
    } else {
      setRetakeReasons(
        result.verdict === "uncertain"
          ? [`Similarity landed in the ambiguous band (distance ${MATCH_DISTANCE_MAX}–${MISMATCH_DISTANCE_MIN}). Capture both faces frontal, well-lit, without glasses, and retry.`]
          : []
      );
    }
    setOutcome(result);
    pushLog(
      result.verdict === "match" ? "success" : result.verdict === "mismatch" ? "error" : "warn",
      `Face Match verdict: ${result.verdict.toUpperCase()} · fused distance ${result.distance} (match ≤${MATCH_DISTANCE_MAX}, mismatch ≥${MISMATCH_DISTANCE_MIN}) · ensemble ${result.pairsCompared} pairs · best ${result.bestDistance} · median ${result.medianDistance} · similarity ${result.similarity}%`
    );
  }, [pushLog, slotA.face, slotB.face]);

  const verdictColor = outcome?.verdict === "match" ? "hsl(152 65% 52%)" : outcome?.verdict === "mismatch" ? "hsl(0 84% 60%)" : "hsl(204 90% 60%)";

  /** Evidence pack for a face comparison: both originals, both aligned crops, the distance maths. */
  const buildPack = useCallback((): PackInput => {
    const slots: { slot: SlotState; slug: string; label: string }[] = [
      { slot: slotA, slug: "01-reference", label: "Photo 1 — reference / ID portrait" },
      { slot: slotB, slug: "02-probe", label: "Photo 2 — probe / selfie" },
    ];
    const media: PackMediaItem[] = slots.map(({ slot, slug, label }) => ({
      slug,
      label,
      origin: slot.origin ?? fileOrigin,
      blob: slot.blob,
      url: slot.url,
      fileName: slot.fileName,
      captureMeta: slot.blob ? `${slot.blob.type || "unknown type"}, last modified ${new Date(slot.blob.lastModified).toISOString()}` : null,
      derived: slot.face?.cropUrl
        ? [
            {
              id: "aligned-crop",
              label: "Aligned crop the embedding was extracted from",
              url: slot.face.cropUrl,
              caption: `ArcFace 5-point aligned, roll-corrected crop — ${slot.face.quality.boxWidth}px wide in the source, detection score ${slot.face.quality.detectionScore}${slot.face.enhancement?.length ? `. Preparation: ${slot.face.enhancement.join("; ")}` : ""}.`,
            },
          ]
        : [],
      notes: slot.face
        ? [
            `Face located: ${slot.face.quality.boxWidth}px wide · detection ${slot.face.quality.detectionScore} · detector ${slot.face.detector ?? "unknown"}`,
            `Quality: brightness ${slot.face.quality.brightness} · sharpness ${slot.face.quality.sharpness} · contrast ${slot.face.quality.contrast} · unique levels ${slot.face.quality.uniqueLevels} — ${slot.face.quality.ok ? "gates passed" : `issues: ${slot.face.quality.issues.join("; ")}`}`,
            `Embedding: ${slot.face.engine ?? "unknown engine"} · ${slot.face.embedDim ?? "?"}-d · ${slot.face.metric ?? "?"} distance · ${slot.face.variants?.length ?? 1} ensemble variant(s)`,
          ]
        : [slot.error ?? "No face was located in this photo."],
    }));

    const deep: string[] = [
      "FACE MATCH — DEEP REPORT",
      "=".repeat(70),
      `Exported ${new Date().toISOString()}`,
      "",
      "Both photos were compared entirely on this device. No image was uploaded.",
      "",
    ];
    for (const { slot, label } of slots) {
      deep.push(`── ${label} ──`, `File: ${slot.fileName ?? "(none)"}`);
      if (slot.face) {
        deep.push(
          `Face box width (source px): ${slot.face.quality.boxWidth}`,
          `Detection score: ${slot.face.quality.detectionScore} (${slot.face.detector ?? "unknown detector"})`,
          `Brightness ${slot.face.quality.brightness} · sharpness ${slot.face.quality.sharpness} · contrast ${slot.face.quality.contrast} · unique intensity levels ${slot.face.quality.uniqueLevels}`,
          `Quality gates: ${slot.face.quality.ok ? "PASSED" : `FAILED — ${slot.face.quality.issues.join("; ")}`}`,
          `Embedding: ${slot.face.engine ?? "unknown"} · ${slot.face.embedDim ?? "?"}-d · metric ${slot.face.metric ?? "?"}`,
          `Preparation: ${slot.face.enhancement?.join("; ") ?? "none recorded"}`
        );
      } else {
        deep.push(`No face located. ${slot.error ?? ""}`);
      }
      deep.push("");
    }
    if (outcome) {
      deep.push(
        "── COMPARISON ──",
        `Verdict: ${outcome.verdict.toUpperCase()}`,
        `Fused distance: ${outcome.distance} · decision bands: match ≤${MATCH_DISTANCE_MAX}, mismatch ≥${MISMATCH_DISTANCE_MIN}`,
        `Similarity: ${outcome.similarity}%`,
        `Ensemble: ${outcome.pairsCompared} variant pairs · best ${outcome.bestDistance} · median ${outcome.medianDistance} · mean ${outcome.meanDistance}`,
        "",
        "A mismatch is never asserted from a low-quality capture: if either photo fails the quality gates, a raw",
        "mismatch is downgraded to UNCERTAIN with a retake request instead of an accusation.",
        ""
      );
      if (retakeReasons.length > 0) deep.push("Retake requested because:", ...retakeReasons.map((r) => `  - ${r}`), "");
    } else {
      deep.push("── COMPARISON ──", "Not run — both photos need a located face before a comparison is possible.", "");
    }
    deep.push("=== END OF REPORT ===");

    return {
      surface: "face-match",
      title: "Face Match — Evidence Pack",
      subtitle: "On-device identity comparison of two photos",
      scopeNote:
        "This pack covers the face comparison only — it carries no metadata forensics or capture-channel audit for these photos. Run the Fraud Lab media analysis on each photo for that.",
      verdict: outcome
        ? {
            label:
              outcome.verdict === "match"
                ? `SAME PERSON — ${outcome.similarity}% similarity`
                : outcome.verdict === "mismatch"
                  ? `DIFFERENT PERSON — ${outcome.similarity}% similarity`
                  : `UNCERTAIN — retake requested (${outcome.similarity}% similarity)`,
            tone: outcome.verdict === "match" ? "pass" : outcome.verdict === "mismatch" ? "fail" : "review",
            reasons: [
              `Fused cosine distance ${outcome.distance} — match at ≤${MATCH_DISTANCE_MAX}, mismatch at ≥${MISMATCH_DISTANCE_MIN}`,
              `Ensemble of ${outcome.pairsCompared} variant pairs · best ${outcome.bestDistance} · median ${outcome.medianDistance}`,
            ],
            corrective: retakeReasons,
          }
        : { label: "NOT COMPARED", tone: "info", reasons: ["Both photos need a detected face before a comparison can run."] },
      media,
      logs,
      includeLedger: false,
      deepText: deep.join("\n"),
      deepJson: JSON.stringify(
        {
          schema: "verification-hub/face-match@1",
          exportedAt: new Date().toISOString(),
          bands: { matchAtOrBelow: MATCH_DISTANCE_MAX, mismatchAtOrAbove: MISMATCH_DISTANCE_MIN },
          photos: slots.map(({ slot, slug }) => ({
            slot: slug,
            fileName: slot.fileName,
            bytes: slot.blob?.size ?? null,
            type: slot.blob?.type ?? null,
            face: slot.face
              ? {
                  quality: slot.face.quality,
                  detector: slot.face.detector ?? null,
                  engine: slot.face.engine ?? null,
                  embedDim: slot.face.embedDim ?? null,
                  metric: slot.face.metric ?? null,
                  variants: slot.face.variants?.length ?? 1,
                  enhancement: slot.face.enhancement ?? [],
                }
              : null,
            error: slot.error,
          })),
          outcome: outcome
            ? {
                verdict: outcome.verdict,
                distance: outcome.distance,
                similarity: outcome.similarity,
                pairsCompared: outcome.pairsCompared,
                bestDistance: outcome.bestDistance,
                medianDistance: outcome.medianDistance,
                meanDistance: outcome.meanDistance,
              }
            : null,
          retakeReasons,
        },
        null,
        2
      ),
      sections: [
        {
          title: "How to read the distance",
          lines: [
            `Distances are cosine distances between L2-normalised identity embeddings. ≤${MATCH_DISTANCE_MAX} is a match, ≥${MISMATCH_DISTANCE_MIN} is a mismatch, and the band between them is deliberately left uncertain.`,
            "Each photo is embedded several times (aligned, mirrored, contrast-normalised) and the variants are fused, which stabilises the hard case of a small laminated ID portrait.",
          ],
        },
      ],
    };
  }, [logs, outcome, retakeReasons, slotA, slotB]);

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Compare two faces entirely on this device (e.g. an ID portrait vs a fresh selfie). Each photo runs ArcFace 5-point alignment
        and a MobileFaceNet ONNX embedding (256-d), with multi-detector location and an ensemble (aligned / mirrored /
        contrast-normalized) fused for the hard case of a small laminated ID portrait. Models run locally; photos never leave your
        phone. Quality gates suppress false mismatches: bad captures trigger a retake request instead.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <FaceSlot
          title="Photo 1 — Reference / ID"
          hint="Upload the ID portrait or reference photo"
          slot={slotA}
          busy={busy}
          captureUser={false}
          onFile={(f, origin) => void handleFile(f, "A", origin)}
        />
        <FaceSlot
          title="Photo 2 — Probe / Selfie"
          hint="Take or upload the selfie to verify"
          slot={slotB}
          busy={busy}
          captureUser
          onFile={(f, origin) => void handleFile(f, "B", origin)}
        />
      </div>
      <Button className="h-12 w-full bg-teal-500 text-teal-950 hover:bg-teal-400" disabled={busy || !slotA.face || !slotB.face} onClick={compare}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanFace className="mr-2 h-4 w-4" />}
        {busy ? "Analyzing faces…" : "Compare Faces"}
      </Button>

      {outcome ? (
        <div className="flex items-center gap-4 rounded-xl border border-border/70 bg-background/40 p-3">
          <ScoreRing score={outcome.similarity} color={verdictColor} caption="similarity" />
          <div className="min-w-0 flex-1 space-y-1">
            <div
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold",
                outcome.verdict === "match"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : outcome.verdict === "mismatch"
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                    : "border-sky-500/40 bg-sky-500/10 text-sky-300"
              )}
            >
              {outcome.verdict === "match" ? <UserCheck className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />}
              {outcome.verdict === "match" ? "SAME PERSON" : outcome.verdict === "mismatch" ? "DIFFERENT PERSON" : "UNCERTAIN — RETAKE"}
            </div>
            <p className="mono text-[10px] text-muted-foreground">
              cosine distance {outcome.distance} · match ≤ {MATCH_DISTANCE_MAX} · mismatch ≥ {MISMATCH_DISTANCE_MIN}
            </p>
            <p className="mono text-[10px] text-muted-foreground">
              ensemble {outcome.pairsCompared} pairs · best {outcome.bestDistance} · median {outcome.medianDistance} · mean {outcome.meanDistance}
            </p>
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              {outcome.verdict === "match"
                ? "The 128-dimension identity embeddings are close enough that both photos show the same person."
                : outcome.verdict === "mismatch"
                  ? "Identity embeddings are far apart — these photos show different people (both captures passed quality gates)."
                  : "The result is in the ambiguous band or quality-limited — no accusation is made without better evidence."}
            </p>
          </div>
        </div>
      ) : null}

      {slotA.blob || slotB.blob ? (
        <EvidencePackButton
          build={buildPack}
          pushLog={pushLog}
          variant="secondary"
          hint="Both photos in original form, the aligned crops the embeddings came from, and the full distance maths."
        />
      ) : null}

      {retakeReasons.length > 0 ? (
        <div className="space-y-1 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-sky-300">Repeat capture requested</div>
          {retakeReasons.map((r) => (
            <p key={r} className="text-[10.5px] leading-snug text-foreground/90">
              • {r}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
