import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  CreditCard,
  FlaskConical,
  FolderOpen,
  Gauge,
  HeartPulse,
  MonitorSmartphone,
  Radar,
  ScanFace,
  Smartphone,
  SlidersHorizontal,
  Wrench,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TEMPLATES, type CaptureMethod, type DocType, type FaceMode } from "@/lib/verification-templates";

function ModeChip({ icon, label, className }: { icon: React.ReactNode; label: string; className: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", className)}>
      {icon}
      {label}
    </span>
  );
}

function OptionRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={cn(
              "rounded-lg border px-1.5 py-2 text-[10.5px] font-semibold transition-colors",
              value === o.id ? "border-primary/50 bg-primary/15 text-primary" : "border-border/70 bg-background/40 text-muted-foreground hover:text-foreground"
            )}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Start dashboard: 6 verification templates, custom flow builder, advanced tools. */
export default function Dashboard() {
  const navigate = useNavigate();
  const [customOpen, setCustomOpen] = useState<boolean>(false);
  const [doc, setDoc] = useState<DocType>("passport");
  const [capture, setCapture] = useState<CaptureMethod>("webrtc");
  const [face, setFace] = useState<FaceMode>("liveness");
  const [pageFront, setPageFront] = useState<boolean>(true);
  const [pageBack, setPageBack] = useState<boolean>(true);

  const startCustom = () => {
    const params = new URLSearchParams({ doc, capture, face });
    if (doc === "licence") {
      const pages: string[] = [];
      if (pageFront) pages.push("front");
      if (pageBack) pages.push("back");
      params.set("pages", pages.length > 0 ? pages.join(",") : "front");
    }
    navigate(`/verify/custom?${params.toString()}`);
  };

  return (
    <div className="mx-auto min-h-dvh max-w-lg px-3 pb-10 pt-4 sm:px-4">
      <header className="mb-4 overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-card via-card to-primary/5 p-4 shadow-[0_0_40px_-18px_hsl(var(--glow)/0.55)]">
        <div className="flex items-start gap-3">
          <img src="/icon.png" alt="" className="h-11 w-11 rounded-2xl ring-1 ring-primary/30" />
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-primary/90">Verification Hub</p>
            <h1 className="mt-0.5 text-lg font-semibold leading-tight tracking-tight">Pick a Verification Template</h1>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Guided document + face flows with on-device forensics, liveness + pulse, and a face-to-document match score. Every
              session ends in one PASS / REVIEW / FAIL summary with an exportable corrective report.
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-2.5">
        <button
          type="button"
          className="w-full overflow-hidden rounded-2xl border border-amber-500/40 bg-gradient-to-br from-amber-500/15 via-card to-card p-3.5 text-left shadow-[0_0_40px_-16px_hsl(45_93%_58%/0.5)] transition-all hover:border-amber-400/60 active:scale-[0.985]"
          onClick={() => navigate("/eyedeekit/licence")}
        >
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-500/50 bg-amber-500/20 text-amber-300">
              <Zap className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[13.5px] font-semibold leading-tight">EyeDeeKit Drivers Licence Flow</span>
                <span className="rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300">Fastest</span>
              </div>
              <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
                One tap — silent passive checks run before each capture while the native camera auto-opens for your licence front &amp; back, then a quick liveness. Full forensics + identity chain.
              </p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-amber-300/80" />
          </div>
        </button>

        <button
          type="button"
          className="w-full overflow-hidden rounded-2xl border border-indigo-500/40 bg-gradient-to-br from-indigo-500/15 via-card to-card p-3.5 text-left shadow-[0_0_40px_-16px_hsl(239_84%_67%/0.5)] transition-all hover:border-indigo-400/60 active:scale-[0.985]"
          onClick={() => navigate("/eyedeekit/passport")}
        >
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-indigo-500/50 bg-indigo-500/20 text-indigo-300">
              <Zap className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[13.5px] font-semibold leading-tight">EyeDeeKit Passport Flow</span>
                <span className="rounded-md border border-indigo-500/40 bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-indigo-300">One tap</span>
              </div>
              <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
                One tap — a silent passive check runs while the native camera auto-opens for your passport photo page, then a quick liveness. Full forensics + identity chain.
              </p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-indigo-300/80" />
          </div>
        </button>

        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="w-full rounded-2xl border border-border/70 bg-card p-3.5 text-left transition-all hover:border-primary/40 active:scale-[0.985]"
            onClick={() => navigate(`/verify/${t.id}`)}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border",
                  t.doc === "passport" ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-300" : "border-cyan-500/40 bg-cyan-500/15 text-cyan-300"
                )}
              >
                {t.doc === "passport" ? <BookOpenText className="h-5 w-5" /> : <CreditCard className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold leading-tight">{t.name}</div>
                <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">{t.tagline}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <ModeChip
                    icon={t.docCapture === "webrtc" ? <MonitorSmartphone className="h-2.5 w-2.5" /> : <Smartphone className="h-2.5 w-2.5" />}
                    label={t.docCapture === "webrtc" ? "Live browser · max fps" : "Native camera · full EXIF"}
                    className={
                      t.docCapture === "webrtc"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                    }
                  />
                  <ModeChip
                    icon={t.faceMode === "liveness" ? <HeartPulse className="h-2.5 w-2.5" /> : <ScanFace className="h-2.5 w-2.5" />}
                    label={t.faceMode === "liveness" ? "Liveness + pulse" : "Native selfie"}
                    className={
                      t.faceMode === "liveness" ? "border-rose-500/40 bg-rose-500/10 text-rose-300" : "border-teal-500/40 bg-teal-500/10 text-teal-300"
                    }
                  />
                  <ModeChip
                    icon={t.doc === "passport" ? <BookOpenText className="h-2.5 w-2.5" /> : <CreditCard className="h-2.5 w-2.5" />}
                    label={t.pages.length === 1 ? "1 page" : `${t.pages.length} pages`}
                    className="border-border/70 bg-background/40 text-muted-foreground"
                  />
                </div>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          </button>
        ))}

        <div className="rounded-2xl border border-border/70 bg-card">
          <button type="button" className="flex w-full items-center gap-3 p-3.5 text-left active:scale-[0.99]" onClick={() => setCustomOpen((v) => !v)}>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300">
              <SlidersHorizontal className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold leading-tight">Custom Flow</div>
              <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
                Build your own template: document type, pages, capture method, face step on/off.
              </p>
            </div>
            <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", customOpen ? "rotate-180" : "")} />
          </button>
          {customOpen ? (
            <div className="space-y-3 border-t border-border/60 p-3.5">
              <OptionRow<DocType>
                label="Document"
                value={doc}
                options={[
                  { id: "passport", label: "Passport" },
                  { id: "licence", label: "Driver's Licence" },
                ]}
                onChange={setDoc}
              />
              {doc === "licence" ? (
                <div>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Pages</div>
                  <div className="grid grid-cols-2 gap-1">
                    {(
                      [
                        { label: "Front", value: pageFront, set: setPageFront },
                        { label: "Back", value: pageBack, set: setPageBack },
                      ] as const
                    ).map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        className={cn(
                          "rounded-lg border px-1.5 py-2 text-[10.5px] font-semibold transition-colors",
                          p.value ? "border-primary/50 bg-primary/15 text-primary" : "border-border/70 bg-background/40 text-muted-foreground"
                        )}
                        onClick={() => p.set(!p.value)}
                      >
                        {p.label} {p.value ? "✓" : ""}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <OptionRow<CaptureMethod>
                label="Document capture"
                value={capture}
                options={[
                  { id: "webrtc", label: "Live browser (max fps)" },
                  { id: "native", label: "Native camera (EXIF)" },
                ]}
                onChange={setCapture}
              />
              <OptionRow<FaceMode>
                label="Face step"
                value={face}
                options={[
                  { id: "liveness", label: "Liveness + pulse" },
                  { id: "native-selfie", label: "Native selfie" },
                  { id: "none", label: "None" },
                ]}
                onChange={setFace}
              />
              <Button className="h-12 w-full bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" onClick={startCustom}>
                Start Custom Flow
                <ChevronRight className="ml-1.5 h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </div>

        <Link
          to="/advanced"
          className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 text-left transition-all hover:border-primary/40 active:scale-[0.985]"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/15 text-primary">
            <Wrench className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold leading-tight">Advanced Tools</div>
            <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
              Full diagnostic hub: environment checks, live viewfinder, constraint lab, crop simulator, automated suite, session
              gallery with auto-screening, Fraud Lab (media / document / face match / liveness), debug console.
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>

        <Link
          to="/device-spec"
          className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 text-left transition-all hover:border-cyan-400/50 active:scale-[0.985]"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-500/40 bg-cyan-500/15 text-cyan-300">
            <Gauge className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold leading-tight">Device Camera Spec Report</div>
            <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
              One-tap full spec test of this phone's cameras: every lens probed at max capability, 19 constraint patterns per
              facing, measured fps, codec matrix — exports as text + JSON.
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>

        <Link
          to="/deep-probe"
          className="flex w-full items-center gap-3 rounded-2xl border border-fuchsia-500/40 bg-gradient-to-br from-fuchsia-500/12 via-card to-card p-3.5 text-left transition-all hover:border-fuchsia-400/60 active:scale-[0.985]"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-fuchsia-500/50 bg-fuchsia-500/20 text-fuchsia-300">
            <Radar className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[13.5px] font-semibold leading-tight">Deep Probe</span>
              <span className="rounded-md border border-fuchsia-500/40 bg-fuchsia-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-fuchsia-300">
                Long run
              </span>
            </div>
            <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
              Asks for every permission a website can ask you for, records what your device actually hands over, then photographs through every
              camera at every resolution, ratio and mode it supports. Ends in one archive with the untouched files, a hex dump of every byte, every
              carved metadata region and four checksums each. 15–30 minutes; you can stop at any point and keep what you have.
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-fuchsia-300/80" />
        </Link>

        <Link
          to="/archive"
          className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 text-left transition-all hover:border-fuchsia-400/50 active:scale-[0.985]"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300">
            <FolderOpen className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold leading-tight">Archive Viewer</div>
            <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
              Open a Deep Probe archive back up on the phone: browse the files, read the hex, view the carved metadata regions, and re-check any
              file against the checksum stored inside. Nothing is uploaded and the archive is only ever read.
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>

        <Link
          to="/calibrate"
          className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 text-left transition-all hover:border-emerald-400/50 active:scale-[0.985]"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/15 text-emerald-300">
            <FlaskConical className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold leading-tight">Threshold Calibration</div>
            <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
              Several checks are measured but unscored until proven on this camera. Capture a few genuine documents and a few
              shown on a screen; the app finds where they actually separate and only then lets those checks affect a score.
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
      </div>

      <footer className="px-1 pb-2 pt-4 text-center text-[11px] text-muted-foreground">
        Open on a real phone over HTTPS. Forensics, barcode decoding, and face matching run on-device; the AI verdict and the deep
        data read (MRZ/field OCR) each send a downsized copy of that one image to the vision model — nothing else leaves the phone.
      </footer>
    </div>
  );
}
