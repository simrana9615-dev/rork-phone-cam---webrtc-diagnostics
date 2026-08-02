import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type { CaptureLedgerData, ClipEntry, FeedEntry, FrameEntry, LedgerClock, NativeTripEntry } from "@/lib/capture-ledger";

/**
 * Graphical interaction-flow timeline for the Capture Feed Ledger: a
 * Gantt-style SVG plotting every ledger lane against real session time —
 * live-feed lifetimes (request→grant→first-frame→stop), clip recording
 * spans, sampled-frame ticks, and native round-trips with every discrete
 * event (press, input click, page hidden / camera-app takeover, page
 * visible again, file arrival, securing hold, analysis start) as a
 * tappable marker. Tapping any marker or span shows its exact wall-clock +
 * offset facts below the chart. Linear time scale — no compression, what
 * you see is the actual pacing of the session.
 */

type MarkerKind = "request" | "grant" | "first-frame" | "stop" | "press" | "click" | "hidden" | "visible" | "file" | "hold" | "analysis" | "reject" | "step";

const MARKER_COLOR: Record<MarkerKind, string> = {
  request: "#38bdf8",
  grant: "#34d399",
  "first-frame": "#a7f3d0",
  stop: "#64748b",
  press: "#34d399",
  click: "#38bdf8",
  hidden: "#a78bfa",
  visible: "#c4b5fd",
  file: "#fbbf24",
  hold: "#fb7185",
  analysis: "#22d3ee",
  reject: "#f43f5e",
  step: "#94a3b8",
};

const MARKER_LABEL: Record<MarkerKind, string> = {
  request: "request sent",
  grant: "granted",
  "first-frame": "first frame",
  stop: "feed stopped",
  press: "press",
  click: "input click",
  hidden: "page hidden",
  visible: "page visible",
  file: "file arrival",
  hold: "hold done",
  analysis: "analysis",
  reject: "rejected",
  step: "step",
};

type Marker = {
  kind: MarkerKind;
  at: LedgerClock;
  label: string;
  detail?: string;
};

type Span = {
  fromPerf: number;
  toPerf: number;
  color: string;
  /** Lighter overlay span (e.g. camera-app-open window, securing hold). */
  overlay?: boolean;
  label: string;
};

type Lane = {
  id: string;
  title: string;
  tint: string;
  spans: Span[];
  markers: Marker[];
  /** Tiny tick marks (sampled frames) — drawn thinner than markers. */
  ticks: { atPerf: number; label: string; at: LedgerClock }[];
};

/** Classifies a native-timeline step into a marker kind by its wording. */
function stepKind(step: string): MarkerKind {
  const s = step.toLowerCase();
  if (s.includes("press") || s.includes("auto-launch")) return "press";
  if (s.includes(".click()")) return "click";
  if (s.includes("page hidden")) return "hidden";
  if (s.includes("page visible")) return "visible";
  if (s.includes("file arrived") || s.includes("file facts")) return "file";
  if (s.includes("hold")) return "hold";
  if (s.includes("analysis")) return "analysis";
  if (s.includes("rejected") || s.includes("cancelled") || s.includes("watchdog")) return "reject";
  return "step";
}

function fmtOffset(ms: number): string {
  if (ms >= 10_000) return `+${(ms / 1000).toFixed(1)}s`;
  return `+${ms.toLocaleString("en-US", { maximumFractionDigits: 0 })}ms`;
}

function buildLanes(ledger: CaptureLedgerData, tEnd: number): Lane[] {
  const lanes: Lane[] = [];
  const feeds = ledger.entries.filter((e): e is FeedEntry => e.kind === "feed");
  const clips = ledger.entries.filter((e): e is ClipEntry => e.kind === "clip");
  const frames = ledger.entries.filter((e): e is FrameEntry => e.kind === "frame");
  const natives = ledger.entries.filter((e): e is NativeTripEntry => e.kind === "native");

  for (const f of feeds) {
    const to = f.stoppedAt?.perfMs ?? tEnd;
    const markers: Marker[] = [{ kind: "request", at: f.requestedAt, label: `${f.id}: getUserMedia request sent` }];
    if (f.grantedAt) markers.push({ kind: "grant", at: f.grantedAt, label: `${f.id}: stream granted`, detail: f.grantLatencyMs != null ? `${f.grantLatencyMs}ms after request` : undefined });
    if (f.firstFrameAt) markers.push({ kind: "first-frame", at: f.firstFrameAt, label: `${f.id}: first video frame`, detail: f.firstFrameLatencyMs != null ? `${f.firstFrameLatencyMs}ms after grant` : undefined });
    if (f.stoppedAt) markers.push({ kind: "stop", at: f.stoppedAt, label: f.error ? `${f.id}: rejected — ${f.error}` : `${f.id}: feed stopped`, detail: f.lifetimeMs != null ? `lifetime ${f.lifetimeMs.toLocaleString("en-US")}ms` : undefined });
    lanes.push({
      id: f.id,
      title: `${f.id} · ${f.purpose}`,
      tint: f.error ? "#f43f5e" : "#22d3ee",
      spans: [{ fromPerf: f.requestedAt.perfMs, toPerf: to, color: f.error ? "#f43f5e" : "#22d3ee", label: `${f.id} lifetime` }],
      markers,
      ticks: frames
        .filter((fr) => fr.feedId === f.id)
        .map((fr) => ({ atPerf: fr.capturedAt.perfMs, label: `${fr.id}: ${fr.label}`, at: fr.capturedAt })),
    });
  }

  for (const c of clips) {
    const to = c.stoppedAt?.perfMs ?? tEnd;
    const markers: Marker[] = [{ kind: "request", at: c.startedAt, label: `${c.id}: recording started (${c.mime})` }];
    if (c.stoppedAt) {
      markers.push({
        kind: "stop",
        at: c.stoppedAt,
        label: `${c.id}: recording stopped`,
        detail: c.bytes != null ? `${c.bytes.toLocaleString("en-US")} bytes over ${c.durationMs?.toLocaleString("en-US")}ms ≈ ${c.avgKbps} kbps` : c.note ?? undefined,
      });
    }
    lanes.push({
      id: c.id,
      title: `${c.id} · ${c.container} clip (${c.feedId})`,
      tint: "#34d399",
      spans: [{ fromPerf: c.startedAt.perfMs, toPerf: to, color: "#34d399", label: `${c.id} recording` }],
      markers,
      ticks: [],
    });
  }

  for (const n of natives) {
    if (n.timeline.length === 0) continue;
    const first = n.timeline[0];
    const last = n.timeline[n.timeline.length - 1];
    const spans: Span[] = [{ fromPerf: first.at.perfMs, toPerf: last.at.perfMs, color: "#fbbf24", label: `${n.id} round-trip` }];
    // Camera-app-open window: page hidden → page visible (the OS camera covered the page).
    const hiddenStep = n.timeline.find((t) => stepKind(t.step) === "hidden");
    const visibleStep = n.timeline.find((t) => stepKind(t.step) === "visible");
    if (hiddenStep) {
      spans.push({
        fromPerf: hiddenStep.at.perfMs,
        toPerf: (visibleStep ?? last).at.perfMs,
        color: "#a78bfa",
        overlay: true,
        label: `${n.id}: camera app open (page hidden)`,
      });
    }
    // Securing-hold window: holdMs before the "hold complete" step.
    const holdStep = n.timeline.find((t) => stepKind(t.step) === "hold");
    if (holdStep && n.holdMs != null) {
      spans.push({
        fromPerf: holdStep.at.perfMs - n.holdMs,
        toPerf: holdStep.at.perfMs,
        color: "#fb7185",
        overlay: true,
        label: `${n.id}: securing hold (${n.holdMs}ms bell-curve)`,
      });
    }
    lanes.push({
      id: n.id,
      title: `${n.id} · ${n.label} (${n.facing === "user" ? "front" : "back"} camera app)`,
      tint: "#fbbf24",
      spans,
      markers: n.timeline.map((t) => ({
        kind: stepKind(t.step),
        at: t.at,
        label: `${n.id}: ${t.step}`,
        detail: [t.deltaMs != null ? `Δ ${t.deltaMs.toLocaleString("en-US")}ms from previous step` : null, t.note ?? null].filter(Boolean).join(" — ") || undefined,
      })),
      ticks: [],
    });
  }

  return lanes.sort((a, b) => {
    const aStart = Math.min(...a.spans.map((s) => s.fromPerf));
    const bStart = Math.min(...b.spans.map((s) => s.fromPerf));
    return aStart - bStart;
  });
}

type Selected = { label: string; detail?: string; at: LedgerClock; laneTitle: string; kind: MarkerKind | "span" | "tick" };

const W = 360;
const PAD_L = 8;
const PAD_R = 8;
const LANE_H = 30;
const LANE_GAP = 8;
const AXIS_H = 18;
const TOP = 6;

export default function LedgerTimelineChart({ ledger }: { ledger: CaptureLedgerData }) {
  const [selected, setSelected] = useState<Selected | null>(null);

  const model = useMemo(() => {
    const start = ledger.startedAt;
    if (!start) return null;
    const t0 = start.perfMs;
    let tEnd = t0 + 1;
    for (const ev of ledger.events) tEnd = Math.max(tEnd, ev.at.perfMs);
    for (const e of ledger.entries) {
      if (e.kind === "feed") tEnd = Math.max(tEnd, e.stoppedAt?.perfMs ?? e.requestedAt.perfMs);
      else if (e.kind === "clip") tEnd = Math.max(tEnd, e.stoppedAt?.perfMs ?? e.startedAt.perfMs);
      else if (e.kind === "frame") tEnd = Math.max(tEnd, e.capturedAt.perfMs);
      else for (const t of e.timeline) tEnd = Math.max(tEnd, t.at.perfMs);
    }
    const lanes = buildLanes(ledger, tEnd);
    if (lanes.length === 0) return null;
    const total = Math.max(1, tEnd - t0);
    const x = (perf: number) => PAD_L + ((perf - t0) / total) * (W - PAD_L - PAD_R);
    const height = TOP + lanes.length * (LANE_H + LANE_GAP) + AXIS_H;
    // 5 axis ticks across the session.
    const ticks = Array.from({ length: 5 }, (_, i) => {
      const ms = (total / 4) * i;
      return { x: x(t0 + ms), label: fmtOffset(ms) };
    });
    return { lanes, x, height, t0, total, ticks };
  }, [ledger]);

  if (!model) return null;
  const { lanes, x, height, t0, ticks } = model;
  const start = ledger.startedAt;

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Interaction flow — real session pacing, linear time</div>
      <div className="rounded-xl border border-border/60 bg-black/30 p-1.5">
        <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Capture ledger interaction timeline">
          {/* Axis gridlines */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={t.x} y1={TOP} x2={t.x} y2={height - AXIS_H + 3} stroke="#334155" strokeWidth={0.5} strokeDasharray="2 3" />
              <text x={t.x} y={height - 4} fontSize={7} fill="#64748b" textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"} fontFamily="monospace">
                {t.label}
              </text>
            </g>
          ))}
          {lanes.map((lane, li) => {
            const y = TOP + li * (LANE_H + LANE_GAP);
            const barY = y + 12;
            const barH = 10;
            return (
              <g key={lane.id}>
                <text x={PAD_L} y={y + 8} fontSize={7.5} fill="#94a3b8" fontFamily="monospace">
                  {lane.title.length > 62 ? `${lane.title.slice(0, 62)}…` : lane.title}
                </text>
                {/* Lane baseline */}
                <line x1={PAD_L} y1={barY + barH / 2} x2={W - PAD_R} y2={barY + barH / 2} stroke="#1e293b" strokeWidth={1} />
                {/* Spans */}
                {lane.spans.map((s, si) => {
                  const x1 = x(s.fromPerf);
                  const x2 = Math.max(x1 + 1.5, x(s.toPerf));
                  return (
                    <rect
                      key={si}
                      x={x1}
                      y={s.overlay ? barY - 2 : barY}
                      width={x2 - x1}
                      height={s.overlay ? barH + 4 : barH}
                      rx={s.overlay ? 3 : 2.5}
                      fill={s.color}
                      opacity={s.overlay ? 0.28 : 0.5}
                      stroke={s.color}
                      strokeWidth={s.overlay ? 0.75 : 0}
                      strokeDasharray={s.overlay ? "2 2" : undefined}
                      className="cursor-pointer"
                      onClick={() =>
                        setSelected({
                          label: s.label,
                          detail: `${((s.toPerf - s.fromPerf)).toLocaleString("en-US", { maximumFractionDigits: 1 })}ms span · ${fmtOffset(s.fromPerf - t0)} → ${fmtOffset(s.toPerf - t0)}`,
                          at: { epochMs: 0, perfMs: s.fromPerf, iso: "" },
                          laneTitle: lane.title,
                          kind: "span",
                        })
                      }
                    />
                  );
                })}
                {/* Frame ticks */}
                {lane.ticks.map((t, ti) => (
                  <line
                    key={ti}
                    x1={x(t.atPerf)}
                    y1={barY - 1}
                    x2={x(t.atPerf)}
                    y2={barY + barH + 1}
                    stroke="#e2e8f0"
                    strokeWidth={0.9}
                    opacity={0.85}
                    className="cursor-pointer"
                    onClick={() => setSelected({ label: t.label, at: t.at, laneTitle: lane.title, kind: "tick" })}
                  />
                ))}
                {/* Event markers */}
                {lane.markers.map((m, mi) => {
                  const cx = x(m.at.perfMs);
                  const isSel = selected?.label === m.label && selected.at.perfMs === m.at.perfMs;
                  return (
                    <g key={mi} className="cursor-pointer" onClick={() => setSelected({ label: m.label, detail: m.detail, at: m.at, laneTitle: lane.title, kind: m.kind })}>
                      {/* Generous invisible hit target for touch */}
                      <circle cx={cx} cy={barY + barH / 2} r={7} fill="transparent" />
                      <circle
                        cx={cx}
                        cy={barY + barH / 2}
                        r={isSel ? 4 : 2.8}
                        fill={MARKER_COLOR[m.kind]}
                        stroke={isSel ? "#f8fafc" : "#0f172a"}
                        strokeWidth={isSel ? 1.2 : 0.75}
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Selected event facts */}
      {selected ? (
        <div className="mono rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-2 text-[9.5px] leading-snug">
          <p className="font-semibold text-cyan-200">{selected.label}</p>
          <p className="text-muted-foreground">{selected.laneTitle}</p>
          {selected.kind !== "span" ? (
            <p className="text-foreground/85">
              {selected.at.iso} · mono {selected.at.perfMs.toLocaleString("en-US")}ms{start ? ` · ${fmtOffset(selected.at.perfMs - start.perfMs)} into the session` : ""}
            </p>
          ) : null}
          {selected.detail ? <p className="text-amber-200/90">{selected.detail}</p> : null}
        </div>
      ) : (
        <p className="text-[9px] text-muted-foreground/70">Tap any dot, tick, or bar for its exact wall-clock + monotonic facts.</p>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-x-2.5 gap-y-1">
        {(["request", "grant", "first-frame", "press", "click", "hidden", "visible", "file", "hold", "analysis", "stop", "reject"] as MarkerKind[]).map((k) => (
          <span key={k} className="mono inline-flex items-center gap-1 text-[8.5px] text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: MARKER_COLOR[k] }} />
            {MARKER_LABEL[k]}
          </span>
        ))}
        <span className="mono inline-flex items-center gap-1 text-[8.5px] text-muted-foreground">
          <span className={cn("inline-block h-2 w-3 rounded-sm opacity-40")} style={{ backgroundColor: "#a78bfa" }} />
          camera app open
        </span>
        <span className="mono inline-flex items-center gap-1 text-[8.5px] text-muted-foreground">
          <span className="inline-block h-2 w-3 rounded-sm opacity-40" style={{ backgroundColor: "#fb7185" }} />
          securing hold
        </span>
        <span className="mono inline-flex items-center gap-1 text-[8.5px] text-muted-foreground">
          <span className="inline-block h-2 w-0.5 bg-slate-200" />
          sampled frame
        </span>
      </div>
    </div>
  );
}
