import { useCallback, useState, useSyncExternalStore } from "react";
import { Activity, Camera, ChevronDown, Clapperboard, Download, FileCode2, Film, Image as ImageIcon, ListOrdered, Radio } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { downloadBlob } from "@/lib/camera-diagnostics";
import LedgerTimelineChart from "@/components/verify/LedgerTimelineChart";
import {
  buildLedgerJsonObject,
  getLedger,
  getLedgerVersion,
  offsetLabel,
  subscribeLedger,
  type ClipEntry,
  type DiffRow,
  type FeedEntry,
  type FrameEntry,
  type LedgerClock,
  type NativeTripEntry,
} from "@/lib/capture-ledger";

/**
 * Capture Feed Ledger — surgical-overkill audit section. Renders the
 * chronological event timeline plus expandable per-entry cards: verbatim
 * request code, full settings/capability dumps, requested-vs-received diff
 * tables (DIFFERS highlighted, agreement shown too), clip bitrate math,
 * frame encode facts, native round-trip millisecond timelines, complete raw
 * EXIF dumps, and explicit not-exposed honesty rows.
 */

const DIFF_CHIP: Record<DiffRow["verdict"], string> = {
  match: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  differs: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "not-exposed": "border-border/70 bg-background/40 text-muted-foreground",
};

const DIFF_TAG: Record<DiffRow["verdict"], string> = { match: "MATCH", differs: "DIFFERS", info: "INFO", "not-exposed": "N/EXP" };

function ClockRow({ label, clock, start, extra }: { label: string; clock: LedgerClock | null; start: LedgerClock | null; extra?: string }) {
  return (
    <div className="mono grid grid-cols-[96px_1fr] gap-x-2 text-[9.5px] leading-snug">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all text-foreground/90">
        {clock ? (
          <>
            {clock.iso} · mono {clock.perfMs.toLocaleString("en-US")}ms · {offsetLabel(clock, start)}
            {extra ? ` · ${extra}` : ""}
          </>
        ) : (
          "—"
        )}
      </span>
    </div>
  );
}

function DiffTable({ rows, title }: { rows: DiffRow[]; title: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={`${r.field}-${i}`} className={cn("rounded-lg border p-1.5", r.verdict === "differs" ? "border-rose-500/40 bg-rose-500/5" : "border-border/60 bg-black/25")}>
            <div className="flex items-start gap-1.5">
              <span className={cn("mono inline-flex w-[46px] shrink-0 items-center justify-center rounded border px-1 py-0.5 text-[8.5px] font-bold", DIFF_CHIP[r.verdict])}>
                {DIFF_TAG[r.verdict]}
              </span>
              <div className="mono min-w-0 flex-1 text-[9.5px] leading-snug">
                <span className="font-semibold text-foreground/90">{r.field}</span>
                <div className="grid grid-cols-[52px_1fr] gap-x-1.5 text-muted-foreground">
                  <span className="text-sky-300/80">sent</span>
                  <span className="break-all text-foreground/85">{r.sent}</span>
                  <span className="text-emerald-300/80">received</span>
                  <span className={cn("break-all", r.verdict === "differs" ? "font-semibold text-rose-300" : "text-foreground/85")}>{r.received}</span>
                </div>
                {r.note ? <p className="mt-0.5 text-[9px] leading-snug text-muted-foreground/80">{r.note}</p> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function KvDump({ title, data }: { title: string; data: Record<string, unknown> | null }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {data && Object.keys(data).length > 0 ? (
        <div className="mono grid grid-cols-[minmax(90px,38%)_1fr] gap-x-2 gap-y-0.5 rounded-lg border border-border/60 bg-black/25 p-2 text-[9.5px] leading-snug">
          {Object.entries(data).map(([k, v]) => (
            <FragmentRow key={k} k={k} v={v} />
          ))}
        </div>
      ) : (
        <p className="mono rounded-lg border border-border/60 bg-black/25 p-2 text-[9.5px] text-muted-foreground">not supported on this browser</p>
      )}
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: unknown }) {
  const text = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  return (
    <>
      <span className="break-all text-muted-foreground">{k}</span>
      <span className="break-all text-foreground/90">{text}</span>
    </>
  );
}

function EntryCard({
  icon,
  title,
  chips,
  children,
  defaultOpen = false,
}: {
  icon: React.ReactNode;
  title: string;
  chips?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  return (
    <div className="rounded-xl border border-border/60 bg-background/40">
      <button type="button" className="flex w-full items-center gap-2 p-2.5 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/40 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px] font-semibold leading-tight">{title}</span>
          {chips ? <span className="mt-0.5 flex flex-wrap items-center gap-1">{chips}</span> : null}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open ? "rotate-180" : "")} />
      </button>
      {open ? <div className="space-y-2.5 border-t border-border/60 p-2.5">{children}</div> : null}
    </div>
  );
}

function MiniChip({ cls, children }: { cls?: string; children: React.ReactNode }) {
  return <span className={cn("mono inline-flex items-center rounded border px-1.5 py-0.5 text-[8.5px] font-semibold", cls ?? "border-border/70 bg-background/40 text-muted-foreground")}>{children}</span>;
}

function FeedCard({ e, start }: { e: FeedEntry; start: LedgerClock | null }) {
  const differs = e.diffs.filter((d) => d.verdict === "differs").length;
  return (
    <EntryCard
      icon={<Radio className="h-3.5 w-3.5" />}
      title={`${e.id} — ${e.purpose}`}
      chips={
        <>
          {e.error ? (
            <MiniChip cls="border-rose-500/40 bg-rose-500/10 text-rose-300">REJECTED</MiniChip>
          ) : (
            <MiniChip cls="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">granted +{e.grantLatencyMs ?? "?"}ms</MiniChip>
          )}
          {e.received ? (
            <MiniChip>
              {String(e.received.settings.width ?? "?")}×{String(e.received.settings.height ?? "?")} @ {String(e.received.settings.frameRate ?? "?")}fps
            </MiniChip>
          ) : null}
          {differs > 0 ? <MiniChip cls="border-rose-500/40 bg-rose-500/10 text-rose-300">{differs} DIFFERS</MiniChip> : null}
          {e.lifetimeMs != null ? <MiniChip>{e.lifetimeMs.toLocaleString("en-US")}ms lifetime</MiniChip> : null}
        </>
      }
    >
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <FileCode2 className="h-3 w-3" />
          Request sent (verbatim getUserMedia constraints)
        </div>
        <pre className="mono overflow-x-auto rounded-lg border border-border/60 bg-black/40 p-2 text-[9.5px] leading-snug text-sky-200">{e.requestSentJson}</pre>
      </div>
      <div className="space-y-0.5 rounded-lg border border-border/60 bg-black/25 p-2">
        <ClockRow label="request sent" clock={e.requestedAt} start={start} />
        <ClockRow label="granted" clock={e.grantedAt} start={start} extra={e.grantLatencyMs != null ? `${e.grantLatencyMs}ms after request (incl. the user's permission decision on a first ask)` : undefined} />
        <ClockRow label="first frame" clock={e.firstFrameAt} start={start} extra={e.firstFrameLatencyMs != null ? `${e.firstFrameLatencyMs}ms after grant` : undefined} />
        <ClockRow label="stopped" clock={e.stoppedAt} start={start} extra={e.lifetimeMs != null ? `total lifetime ${e.lifetimeMs.toLocaleString("en-US")}ms` : undefined} />
        {e.error ? <p className="mono text-[9.5px] font-semibold text-rose-300">rejected: {e.error}</p> : null}
      </div>
      {e.received ? (
        <>
          <div className="mono space-y-0.5 rounded-lg border border-border/60 bg-black/25 p-2 text-[9.5px] leading-snug">
            <p>
              <span className="text-muted-foreground">device</span> <span className="font-semibold text-foreground">"{e.received.trackLabel || "(unlabelled)"}"</span>
            </p>
            <p className="break-all text-muted-foreground">
              deviceId {e.received.deviceId ?? "—"} · groupId {e.received.groupId ?? "—"}
            </p>
            <p className="text-muted-foreground">
              computed delivered aspect ratio <span className="font-semibold text-foreground/90">{e.received.computedAspectRatio ?? "—"}</span>
            </p>
            <p className="text-muted-foreground">
              cameras enumerated at grant: <span className="text-foreground/85">{e.received.enumeratedCameras.map((c) => c.label || "(unlabelled)").join(" · ") || "—"}</span>
            </p>
          </div>
          <DiffTable rows={e.diffs} title="Requested vs received — every field, agreement shown too" />
          <KvDump title="Full track settings dump (every exposed key)" data={e.received.settings} />
          <KvDump title="Full device capability sheet at grant time" data={e.received.capabilities} />
          {e.received.constraintsInEffect ? <KvDump title="Constraints the browser stored (track.getConstraints())" data={e.received.constraintsInEffect} /> : null}
        </>
      ) : null}
      <div className="mono rounded-lg border border-border/60 bg-black/25 p-2 text-[9.5px] leading-snug text-muted-foreground">
        <span className="font-semibold text-foreground/90">Lifetime telemetry (measured, not claimed):</span> {e.telemetry.framesObserved ?? "?"} frames observed ·{" "}
        {e.telemetry.measuredFps != null ? `${e.telemetry.measuredFps}fps measured` : "fps unmeasured"} · {e.telemetry.resolutionChanges.length} mid-feed resolution change(s)
        {e.telemetry.resolutionChanges.map((rc, i) => (
          <p key={i}>
            change {rc.from} → {rc.to} at {rc.at.iso} ({offsetLabel(rc.at, start)})
          </p>
        ))}
      </div>
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Not exposed by the browser — recorded honestly, never guessed</div>
        {e.notExposed.map((n) => (
          <p key={n.field} className="mono rounded-lg border border-border/60 bg-black/25 p-1.5 text-[9px] leading-snug text-muted-foreground">
            <span className="font-semibold text-foreground/80">{n.field}:</span> {n.reason}
          </p>
        ))}
      </div>
    </EntryCard>
  );
}

function ClipCard({ e, start }: { e: ClipEntry; start: LedgerClock | null }) {
  return (
    <EntryCard
      icon={<Film className="h-3.5 w-3.5" />}
      title={`${e.id} — ${e.purpose}`}
      chips={
        <>
          <MiniChip>{e.container} · {e.codecs}</MiniChip>
          {e.bytes != null ? <MiniChip>{(e.bytes / 1024).toFixed(0)} KB</MiniChip> : <MiniChip cls="border-amber-500/40 bg-amber-500/10 text-amber-300">no data</MiniChip>}
          {e.avgKbps != null ? <MiniChip cls="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">≈{e.avgKbps} kbps avg</MiniChip> : null}
        </>
      }
    >
      <div className="space-y-0.5 rounded-lg border border-border/60 bg-black/25 p-2">
        <ClockRow label="rec. started" clock={e.startedAt} start={start} />
        <ClockRow label="rec. stopped" clock={e.stoppedAt} start={start} extra={e.durationMs != null ? `duration ${e.durationMs.toLocaleString("en-US")}ms` : undefined} />
      </div>
      <div className="mono rounded-lg border border-border/60 bg-black/25 p-2 text-[9.5px] leading-snug text-muted-foreground">
        <p>
          source feed <span className="font-semibold text-foreground/90">{e.feedId}</span> · mime "{e.mime}"
        </p>
        <p>
          size {e.bytes != null ? `${e.bytes.toLocaleString("en-US")} bytes` : "—"} · average bitrate{" "}
          {e.avgKbps != null ? `${e.avgKbps} kbps (computed: bytes ÷ duration — live wire bitrate is not exposed by the browser)` : "—"}
        </p>
        {e.note ? <p className="text-amber-300/90">{e.note}</p> : null}
      </div>
    </EntryCard>
  );
}

function FrameCard({ frames, start }: { frames: FrameEntry[]; start: LedgerClock | null }) {
  return (
    <EntryCard
      icon={<ImageIcon className="h-3.5 w-3.5" />}
      title={`Still frames — ${frames.length} sampled`}
      chips={<MiniChip>{frames.filter((f) => f.encode).length} encoded to JPEG</MiniChip>}
    >
      <div className="space-y-1">
        {frames.map((f) => (
          <div key={f.id} className="mono rounded-lg border border-border/60 bg-black/25 p-1.5 text-[9.5px] leading-snug text-muted-foreground">
            <p>
              <span className="font-semibold text-foreground/90">{f.id}</span> · {f.label} · from {f.feedId}
            </p>
            <p>
              captured {f.capturedAt.iso} ({offsetLabel(f.capturedAt, start)}) · {f.width}×{f.height}
            </p>
            <p>
              {f.encode
                ? `encoded ${f.encode.format}${f.encode.quality != null ? ` q=${f.encode.quality}` : ""} · ${f.encode.bytes.toLocaleString("en-US")} bytes · ${f.encode.bitsPerPixel} bits/px effective`
                : "not individually exported — in-memory canvas used for motion analysis only"}
            </p>
          </div>
        ))}
      </div>
    </EntryCard>
  );
}

function NativeCard({ e, start }: { e: NativeTripEntry; start: LedgerClock | null }) {
  const [showExif, setShowExif] = useState<boolean>(false);
  return (
    <EntryCard
      icon={<Camera className="h-3.5 w-3.5" />}
      title={`${e.id} — ${e.label} (${e.facing === "user" ? "front" : "back"} camera app)`}
      chips={
        <>
          {e.file ? <MiniChip>{(e.file.bytes / 1024).toFixed(0)} KB{e.file.width ? ` · ${e.file.width}×${e.file.height}` : ""}</MiniChip> : <MiniChip cls="border-amber-500/40 bg-amber-500/10 text-amber-300">no file yet</MiniChip>}
          {e.exif ? <MiniChip cls="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">{e.exif.tagCount} EXIF tags</MiniChip> : null}
          {e.holdMs != null ? <MiniChip>hold {e.holdMs}ms</MiniChip> : null}
          {e.trust.changeIsTrusted === false || e.trust.pressIsTrusted === false ? <MiniChip cls="border-rose-500/40 bg-rose-500/10 text-rose-300">SCRIPT-FIRED</MiniChip> : null}
        </>
      }
    >
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Millisecond timeline — wall-clock + monotonic, delta from previous step</div>
        <div className="space-y-0.5 rounded-lg border border-border/60 bg-black/25 p-2">
          {e.timeline.map((t, i) => (
            <div key={i} className="mono grid grid-cols-[minmax(110px,42%)_1fr] gap-x-2 text-[9.5px] leading-snug">
              <span className="break-words text-foreground/90">
                {t.step}
                {t.deltaMs != null ? <span className="text-amber-300/90"> Δ{t.deltaMs.toLocaleString("en-US")}ms</span> : null}
              </span>
              <span className="break-all text-muted-foreground">
                {t.at.iso} · mono {t.at.perfMs.toLocaleString("en-US")}ms · {offsetLabel(t.at, start)}
                {t.note ? <span className="block text-[9px] text-muted-foreground/75">{t.note}</span> : null}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="mono rounded-lg border border-border/60 bg-black/25 p-2 text-[9.5px] leading-snug text-muted-foreground">
        <p>
          <span className="font-semibold text-foreground/90">Trust facts:</span> press{" "}
          {e.trust.pressIsTrusted == null ? "untracked" : e.trust.pressIsTrusted ? "user-initiated (isTrusted)" : <span className="font-bold text-rose-300">SCRIPT-FIRED</span>} · change event{" "}
          {e.trust.changeIsTrusted == null ? "untracked" : e.trust.changeIsTrusted ? "user-initiated (isTrusted)" : <span className="font-bold text-rose-300">SCRIPT-DISPATCHED</span>} · files API{" "}
          {e.trust.filesApiNative == null ? "unaudited" : e.trust.filesApiNative ? "native accessor" : <span className="font-bold text-amber-300">wrapped accessor</span>}
        </p>
        <p>
          Securing hold actually drawn: <span className="font-semibold text-foreground/90">{e.holdMs != null ? `${e.holdMs}ms` : "—"}</span> (bell curve 1000–2000ms, applied BEFORE the round-trip clock is read)
        </p>
        {e.file ? (
          <>
            <p className="break-all">
              file "{e.file.name}" · declared {e.file.declaredType} · {e.file.bytes.toLocaleString("en-US")} bytes{e.file.width ? ` · ${e.file.width}×${e.file.height}` : ""}
            </p>
            <p>
              file's own lastModified {e.file.lastModifiedIso}
              {e.file.lastModifiedMinusPressMs != null ? ` (${e.file.lastModifiedMinusPressMs >= 0 ? "+" : ""}${e.file.lastModifiedMinusPressMs.toLocaleString("en-US")}ms vs press)` : ""}
            </p>
          </>
        ) : null}
      </div>
      <DiffTable rows={e.crossChecks} title="Sent vs received cross-checks — both sides recorded, differences flagged" />
      {e.exif ? (
        <div className="space-y-1">
          <button type="button" className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-black/25 p-2 text-left" onClick={() => setShowExif((s) => !s)}>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Complete raw metadata dump — {e.exif.tagCount} tags (every readable EXIF/TIFF/GPS/maker tag)</span>
            <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", showExif ? "rotate-180" : "")} />
          </button>
          {showExif ? (
            <div className="mono grid max-h-80 grid-cols-[minmax(100px,40%)_1fr] gap-x-2 gap-y-0.5 overflow-y-auto rounded-lg border border-border/60 bg-black/25 p-2 text-[9px] leading-snug">
              {Object.entries(e.exif.tags).map(([k, v]) => (
                <FragmentRow key={k} k={k} v={v} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </EntryCard>
  );
}

export default function CaptureLedgerSection({ filePrefix }: { filePrefix: string }) {
  const version = useSyncExternalStore(subscribeLedger, getLedgerVersion);
  const ledger = getLedger();
  const [timelineOpen, setTimelineOpen] = useState<boolean>(false);

  const downloadLedger = useCallback(() => {
    const blob = new Blob([JSON.stringify(buildLedgerJsonObject(), null, 2)], { type: "application/json" });
    downloadBlob(blob, `${filePrefix}-capture-feed-ledger-${Date.now()}.json`);
  }, [filePrefix]);

  if (ledger.entries.length === 0) return null;
  const feeds = ledger.entries.filter((e): e is FeedEntry => e.kind === "feed");
  const clips = ledger.entries.filter((e): e is ClipEntry => e.kind === "clip");
  const frames = ledger.entries.filter((e): e is FrameEntry => e.kind === "frame");
  const natives = ledger.entries.filter((e): e is NativeTripEntry => e.kind === "native");
  const start = ledger.startedAt;

  return (
    <section className="animate-rise space-y-2.5 rounded-2xl border border-cyan-500/25 bg-card p-3.5" data-version={version}>
      <div className="flex items-start justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Activity className="h-4 w-4 text-cyan-400" />
          Capture Feed Ledger — every camera interaction, ms-exact
        </h2>
        <Button variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-[10.5px] text-muted-foreground" onClick={downloadLedger}>
          <Download className="mr-1 h-3 w-3" />
          Ledger JSON
        </Button>
      </div>
      <p className="text-[10.5px] leading-snug text-muted-foreground">
        The exact request every feed sent (verbatim code), when it was sent and granted, exactly what the phone delivered (device, resolution,
        measured fps, aspect ratio, format, bitrate), every native camera round-trip on a millisecond timeline, every artifact's full raw
        metadata, and sent-vs-received diffs — values the browser cannot expose are listed as "not exposed" with the reason, never guessed.
      </p>
      <div className="mono flex flex-wrap gap-1 text-[9px]">
        <MiniChip cls="border-cyan-500/40 bg-cyan-500/10 text-cyan-300">{feeds.length} live feed{feeds.length === 1 ? "" : "s"}</MiniChip>
        <MiniChip cls="border-cyan-500/40 bg-cyan-500/10 text-cyan-300">{natives.length} native round-trip{natives.length === 1 ? "" : "s"}</MiniChip>
        <MiniChip cls="border-cyan-500/40 bg-cyan-500/10 text-cyan-300">{clips.length} clip{clips.length === 1 ? "" : "s"}</MiniChip>
        <MiniChip cls="border-cyan-500/40 bg-cyan-500/10 text-cyan-300">{frames.length} frame{frames.length === 1 ? "" : "s"}</MiniChip>
        <MiniChip cls="border-cyan-500/40 bg-cyan-500/10 text-cyan-300">{ledger.events.length} timeline events</MiniChip>
      </div>

      <LedgerTimelineChart ledger={ledger} />

      <div className="rounded-xl border border-border/60 bg-background/40">
        <button type="button" className="flex w-full items-center gap-2 p-2.5 text-left" onClick={() => setTimelineOpen((o) => !o)}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/40 text-muted-foreground">
            <ListOrdered className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 text-[11.5px] font-semibold">Chronological event timeline ({ledger.events.length} events)</span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", timelineOpen ? "rotate-180" : "")} />
        </button>
        {timelineOpen ? (
          <div className="max-h-80 space-y-0.5 overflow-y-auto border-t border-border/60 p-2.5">
            {ledger.events.map((ev) => (
              <div key={ev.seq} className="mono grid grid-cols-[86px_1fr] gap-x-2 text-[9px] leading-snug">
                <span className="text-amber-300/90">{offsetLabel(ev.at, start)}</span>
                <span className="break-words text-muted-foreground">
                  <span className="text-cyan-300/80">[{ev.refId}]</span> {ev.text}
                  <span className="block text-[8.5px] text-muted-foreground/60">{ev.at.iso}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        {feeds.map((e) => (
          <FeedCard key={e.id} e={e} start={start} />
        ))}
        {clips.map((e) => (
          <ClipCard key={e.id} e={e} start={start} />
        ))}
        {frames.length > 0 ? <FrameCard frames={frames} start={start} /> : null}
        {natives.map((e) => (
          <NativeCard key={e.id} e={e} start={start} />
        ))}
      </div>
      <p className="mono flex items-center gap-1 text-[9px] text-muted-foreground/70">
        <Clapperboard className="h-3 w-3" />
        Ledger session "{ledger.sessionLabel}" · started {start?.iso ?? "—"} · included in full in both exports.
      </p>
    </section>
  );
}
