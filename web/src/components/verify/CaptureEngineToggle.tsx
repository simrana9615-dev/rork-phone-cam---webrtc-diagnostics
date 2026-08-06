import { useState } from "react";
import { ChevronDown, Circle, CircleSlash, Info, KeyRound, Settings2, Sparkles } from "lucide-react";

import {
  CAPTURE_ENGINE_OPTIONS,
  engineFacts,
  setCaptureEngine,
  useCaptureEngine,
  type CaptureEngine,
  type EngineTrait,
} from "@/lib/capture-engine";
import { cn } from "@/lib/utils";

const TRAIT_STYLE: Record<EngineTrait, { dot: string; text: string; word: string }> = {
  full: { dot: "bg-emerald-400", text: "text-emerald-300", word: "Full" },
  partial: { dot: "bg-amber-400", text: "text-amber-300", word: "Partial" },
  none: { dot: "bg-rose-400/70", text: "text-rose-300/90", word: "None" },
};

function TraitRow({ label, trait, detail }: { label: string; trait: EngineTrait; detail: string }) {
  const s = TRAIT_STYLE[trait];
  return (
    <div className="flex gap-2">
      <span className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label} <span className={s.text}>· {s.word}</span>
        </p>
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

/**
 * Settings toggle for the capture pipeline, with an expandable breakdown of
 * what each engine asks of the user and what the website receives in return.
 *
 * The engines split into two families that are easy to confuse:
 *
 * - Six hand off to an OS picker or camera app. The site never touches the
 *   camera, learns nothing about the hardware, and receives a file — whose
 *   EXIF, on the camera-app paths, names the exact lens that fired.
 * - One (device-level / AVFoundation) opens the camera in the page. It names
 *   every camera on the device and can pin one specific lens, but produces
 *   stills with no camera EXIF at all.
 *
 * Neither is strictly better, so the trade is stated rather than ranked.
 */
export default function CaptureEngineToggle({
  className,
  onChanged,
}: {
  className?: string;
  onChanged?: (engine: CaptureEngine) => void;
}) {
  const engine = useCaptureEngine();
  const [expanded, setExpanded] = useState<boolean>(false);
  const active = CAPTURE_ENGINE_OPTIONS.find((o) => o.id === engine) ?? CAPTURE_ENGINE_OPTIONS[0];
  const facts = engineFacts(active.id);

  return (
    <div className={cn("rounded-2xl border border-border/70 bg-background/40 p-3", className)}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Settings2 className="h-3.5 w-3.5" />
        Capture engine
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {CAPTURE_ENGINE_OPTIONS.map((o) => {
          const on = o.id === engine;
          const deviceLevel = engineFacts(o.id).deviceInventory === "full";
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setCaptureEngine(o.id);
                onChanged?.(o.id);
              }}
              className={cn(
                "relative rounded-lg border px-2 py-2 text-[10.5px] font-semibold leading-tight transition-colors active:scale-[0.97]",
                on
                  ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                  : "border-border/70 bg-background/60 text-muted-foreground hover:text-foreground"
              )}
            >
              {deviceLevel ? (
                <Sparkles className={cn("absolute right-1.5 top-1.5 h-3 w-3", on ? "text-emerald-300" : "text-sky-400/70")} />
              ) : null}
              {o.label}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">{active.description}</p>

      <div className="mt-2.5 space-y-2 rounded-xl border border-border/60 bg-background/50 p-2.5">
        <div className="flex gap-2">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400" />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Permission{" "}
              <span className={facts.needsCameraPermission ? "text-amber-300" : "text-emerald-300"}>
                · {facts.needsCameraPermission ? "browser camera access required" : "no browser camera access"}
              </span>
            </p>
            <p className="text-[10.5px] leading-relaxed text-muted-foreground">{facts.permissionPrompt}</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground/80">The site ends up with:</span> {facts.siteGrant}
            </p>
          </div>
        </div>

        <TraitRow label="Camera inventory" trait={facts.deviceInventory} detail={facts.deviceNaming} />
        <TraitRow label="Metadata on the file" trait={facts.metadata} detail={facts.metadataDetail} />

        <div className="flex gap-2">
          {facts.allowsLibraryPick ? (
            <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          ) : (
            <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
          )}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Existing photos{" "}
              <span className={facts.allowsLibraryPick ? "text-amber-300" : "text-emerald-300"}>
                · {facts.allowsLibraryPick ? "can be substituted" : "cannot be substituted"}
              </span>
            </p>
            <p className="text-[10.5px] leading-relaxed text-muted-foreground">{facts.bytes}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground/80">Native equivalent:</span> {facts.nativeEquivalent}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-border/60 py-1.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground active:scale-[0.98]"
      >
        {expanded ? "Hide" : "Compare"} all {CAPTURE_ENGINE_OPTIONS.length} engines
        <ChevronDown className={cn("h-3 w-3 transition-transform", expanded ? "rotate-180" : undefined)} />
      </button>

      {expanded ? (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            The engines split into two families. Six hand control to an OS picker or camera app: the site never touches the camera and
            learns nothing about the hardware, but the file that comes back can carry full camera EXIF — including a{" "}
            <span className="font-mono">LensModel</span> string that names the exact optic that fired. One opens the camera inside the
            page: it names every camera on the device and can pin a specific lens, but its stills carry no camera EXIF at all. Richest
            hardware information and richest file metadata are on opposite sides.
          </p>
          {CAPTURE_ENGINE_OPTIONS.map((o) => {
            const f = engineFacts(o.id);
            return (
              <div
                key={o.id}
                className={cn(
                  "space-y-1 rounded-xl border p-2.5",
                  o.id === engine ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/60 bg-background/40"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold">{o.label}</p>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold",
                      f.needsCameraPermission ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"
                    )}
                  >
                    {f.needsCameraPermission ? "camera permission" : "no camera permission"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-[9.5px]">
                  <div className="rounded-lg border border-border/50 px-1.5 py-1">
                    <p className="text-muted-foreground/70">Camera list</p>
                    <p className={TRAIT_STYLE[f.deviceInventory].text}>{TRAIT_STYLE[f.deviceInventory].word}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 px-1.5 py-1">
                    <p className="text-muted-foreground/70">Lens control</p>
                    <p className={TRAIT_STYLE[f.liveControl].text}>{TRAIT_STYLE[f.liveControl].word}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 px-1.5 py-1">
                    <p className="text-muted-foreground/70">File EXIF</p>
                    <p className={TRAIT_STYLE[f.metadata].text}>{TRAIT_STYLE[f.metadata].word}</p>
                  </div>
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground/70">Names cameras:</span> {f.deviceNaming}
                </p>
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground/70">Native:</span> {f.nativeEquivalent}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
