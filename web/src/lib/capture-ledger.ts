import ExifReader from "exifreader";

/**
 * Capture Feed Ledger — a millisecond-exact, session-scoped record of every
 * camera interaction: every getUserMedia request (verbatim constraints, exact
 * request/grant/first-frame timestamps, full delivered settings + capability
 * dumps, requested-vs-received diffs, lifetime telemetry, teardown), every
 * recorded clip (container/codec/bytes/duration/average bitrate), every still
 * artifact (frames + native photos with a complete raw EXIF dump), and every
 * native camera round-trip (press → click → page-hidden → file → securing
 * hold → analysis, each step wall-clock + monotonic stamped with deltas).
 *
 * Honesty rule: values the browser physically cannot expose are recorded as
 * explicit "not exposed" rows with the reason — never omitted, never guessed.
 *
 * The ledger is a module-level singleton (one verification flow is active at
 * a time); flows call `ledgerReset()` when a session starts or restarts. UI
 * subscribes via `subscribeLedger` + `getLedgerVersion` (useSyncExternalStore).
 */

// ── Clock ─────────────────────────────────────────────────────────────────────

export type LedgerClock = {
  /** Wall-clock epoch milliseconds (Date.now()). */
  epochMs: number;
  /** Monotonic milliseconds (performance.now()), immune to clock changes. */
  perfMs: number;
  /** Wall-clock ISO-8601 with milliseconds. */
  iso: string;
};

export function ledgerNow(): LedgerClock {
  const epochMs = Date.now();
  return { epochMs, perfMs: Math.round(performance.now() * 100) / 100, iso: new Date(epochMs).toISOString() };
}

/** Milliseconds offset from the session start, formatted as "+12,345.6ms". */
export function offsetLabel(clock: LedgerClock | null | undefined, start: LedgerClock | null): string {
  if (!clock || !start) return "—";
  const ms = clock.perfMs - start.perfMs;
  return `+${ms.toLocaleString("en-US", { maximumFractionDigits: 1 })}ms`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiffVerdict = "match" | "differs" | "info" | "not-exposed";

export type DiffRow = {
  field: string;
  /** What the site sent / asked for (verbatim). */
  sent: string;
  /** What the phone/browser actually delivered. */
  received: string;
  verdict: DiffVerdict;
  note?: string;
};

export type LedgerEvent = {
  seq: number;
  at: LedgerClock;
  /** Ledger entry this event belongs to (feed/clip/frame/native id). */
  refId: string;
  text: string;
};

export type FeedTelemetry = {
  /** Total video frames observed across the feed's lifetime (frame callbacks). */
  framesObserved: number | null;
  /** Measured fps from real frame arrivals (not the track's claim). */
  measuredFps: number | null;
  /** Mid-feed resolution changes with exact timestamps. */
  resolutionChanges: { at: LedgerClock; from: string; to: string }[];
};

export type FeedEntry = {
  kind: "feed";
  id: string;
  seq: number;
  /** Why this feed was opened (flow step). */
  purpose: string;
  /** The verbatim MediaStreamConstraints JSON sent to getUserMedia. */
  requestSentJson: string;
  requestedAt: LedgerClock;
  grantedAt: LedgerClock | null;
  /** Request → grant latency (includes the user's permission-prompt time on first ask). */
  grantLatencyMs: number | null;
  firstFrameAt: LedgerClock | null;
  firstFrameLatencyMs: number | null;
  /** getUserMedia rejection (denied / unavailable / overconstrained). */
  error: string | null;
  /** Full received-side dump at grant time. */
  received: {
    trackLabel: string;
    deviceId: string | null;
    groupId: string | null;
    /** Complete track.getSettings() dump — every key, nothing summarized. */
    settings: Record<string, unknown>;
    /** Complete track.getCapabilities() dump. */
    capabilities: Record<string, unknown> | null;
    /** track.getConstraints() as the browser stored them. */
    constraintsInEffect: Record<string, unknown> | null;
    /** Delivered aspect ratio computed from width/height to 4 decimals. */
    computedAspectRatio: string | null;
    /** All video-input devices the browser enumerated at grant time. */
    enumeratedCameras: { label: string; deviceId: string }[];
  } | null;
  /** Field-by-field requested-vs-received comparison. */
  diffs: DiffRow[];
  telemetry: FeedTelemetry;
  stoppedAt: LedgerClock | null;
  lifetimeMs: number | null;
  /** Explicit honesty rows: values the browser cannot expose, with reasons. */
  notExposed: { field: string; reason: string }[];
};

export type ClipEntry = {
  kind: "clip";
  id: string;
  seq: number;
  feedId: string;
  purpose: string;
  mime: string;
  container: string;
  codecs: string;
  startedAt: LedgerClock;
  stoppedAt: LedgerClock | null;
  durationMs: number | null;
  bytes: number | null;
  /** Average bitrate computed from bytes over duration (kbps). */
  avgKbps: number | null;
  note: string | null;
};

export type FrameEntry = {
  kind: "frame";
  id: string;
  seq: number;
  feedId: string;
  label: string;
  capturedAt: LedgerClock;
  width: number;
  height: number;
  /** Encode facts when this frame was exported to a blob (null = in-memory canvas only). */
  encode: { format: string; quality: number | null; bytes: number; bitsPerPixel: number } | null;
};

export type NativeTimelineStep = {
  step: string;
  at: LedgerClock;
  /** Delta from the previous timeline step, ms. */
  deltaMs: number | null;
  note?: string;
};

export type NativeTripEntry = {
  kind: "native";
  id: string;
  seq: number;
  label: string;
  facing: "user" | "environment";
  timeline: NativeTimelineStep[];
  trust: {
    pressIsTrusted: boolean | null;
    changeIsTrusted: boolean | null;
    filesApiNative: boolean | null;
  };
  /** Securing-hold length actually drawn from the bell curve, ms. */
  holdMs: number | null;
  file: {
    name: string;
    declaredType: string;
    bytes: number;
    lastModifiedIso: string;
    /** file.lastModified minus the press moment, ms (negative = file predates the press). */
    lastModifiedMinusPressMs: number | null;
    width: number | null;
    height: number | null;
  } | null;
  /** Complete raw metadata dump — every readable EXIF/maker tag in the file. */
  exif: { tagCount: number; tags: Record<string, string> } | null;
  /** Sent-vs-received cross-checks (photo vs session-observed device facts). */
  crossChecks: DiffRow[];
};

export type LedgerEntry = FeedEntry | ClipEntry | FrameEntry | NativeTripEntry;

export type CaptureLedgerData = {
  sessionLabel: string;
  startedAt: LedgerClock | null;
  entries: LedgerEntry[];
  events: LedgerEvent[];
};

// ── Store ─────────────────────────────────────────────────────────────────────

let store: CaptureLedgerData = { sessionLabel: "", startedAt: null, entries: [], events: [] };
let seqCounter = 0;
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  // Replace the top-level object so useSyncExternalStore snapshots change.
  store = { ...store, entries: [...store.entries], events: [...store.events] };
  listeners.forEach((l) => l());
}

export function subscribeLedger(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getLedgerVersion(): number {
  return version;
}

export function getLedger(): CaptureLedgerData {
  return store;
}

export function ledgerReset(sessionLabel: string): void {
  store = { sessionLabel, startedAt: ledgerNow(), entries: [], events: [] };
  seqCounter = 0;
  bump();
}

function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

function ensureStarted(): void {
  if (!store.startedAt) {
    store.startedAt = ledgerNow();
    if (!store.sessionLabel) store.sessionLabel = "Ad-hoc session";
  }
}

function pushEvent(refId: string, text: string): void {
  store.events.push({ seq: nextSeq(), at: ledgerNow(), refId, text });
}

function findEntry<T extends LedgerEntry>(id: string, kind: T["kind"]): T | null {
  const e = store.entries.find((x) => x.id === id && x.kind === kind);
  return (e as T | undefined) ?? null;
}

// ── Dump helpers ──────────────────────────────────────────────────────────────

/** Full own-property dump of a settings/capabilities object (JSON-safe). */
function dumpObject(obj: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj == null || typeof obj !== "object") return out;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    if (v == null) continue;
    if (typeof v === "object") {
      try {
        out[key] = JSON.parse(JSON.stringify(v)) as unknown;
      } catch {
        out[key] = String(v);
      }
    } else {
      out[key] = v;
    }
  }
  return out;
}

function fmtValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return String(v);
}

/** Standard honesty rows for a live feed. */
function feedNotExposedRows(): { field: string; reason: string }[] {
  return [
    {
      field: "Live-feed wire bitrate",
      reason:
        "Not exposed by the browser — MediaStreamTrack has no bitrate API; a live camera feed is decoded frames, not an encoded stream. Only a recorded clip's average bitrate can be computed (bytes ÷ duration) and is reported on its clip entry.",
    },
    {
      field: "Raw sensor pixel format",
      reason: "Not exposed by the browser — getUserMedia delivers decoded RGB frames; the sensor's Bayer/YUV wire format never reaches JavaScript.",
    },
    {
      field: "Exact permission-prompt display moment",
      reason:
        "Not exposed by the browser — no event fires when the permission UI appears. The request→grant latency recorded above is the closest measurable envelope (it includes the user's decision time on a first ask and is ~0 on a remembered grant).",
    },
  ];
}

// ── Diff engine (requested constraints vs delivered settings) ────────────────

type ConstraintValue = number | string | boolean | { exact?: number | string; ideal?: number | string; min?: number; max?: number };

function constraintTargets(v: ConstraintValue): { label: string; exact?: number | string; ideal?: number | string; min?: number; max?: number } {
  if (typeof v === "object" && v !== null) {
    return { label: JSON.stringify(v), exact: v.exact, ideal: v.ideal, min: v.min, max: v.max };
  }
  return { label: JSON.stringify(v), ideal: v as number | string };
}

function numbersClose(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/**
 * Field-by-field comparison of the video constraints the site sent vs the
 * settings the track delivered. Every requested field gets a row — agreement
 * is shown too, never silently skipped. `ideal` mismatches are honest
 * "differs" rows with a note that ideal is a preference, not a demand.
 */
export function diffConstraintsVsSettings(video: MediaTrackConstraints | boolean, settings: Record<string, unknown>): DiffRow[] {
  const rows: DiffRow[] = [];
  if (typeof video === "boolean") {
    rows.push({
      field: "video",
      sent: String(video),
      received: `${fmtValue(settings.width)}×${fmtValue(settings.height)} @ ${fmtValue(settings.frameRate)}fps`,
      verdict: "info",
      note: "Bare `video: true` requests any camera — the browser chose the defaults shown.",
    });
    return rows;
  }
  const numericFields: { key: "width" | "height" | "frameRate" | "aspectRatio"; tol: number }[] = [
    { key: "width", tol: 0 },
    { key: "height", tol: 0 },
    { key: "frameRate", tol: 1.5 },
    { key: "aspectRatio", tol: 0.01 },
  ];
  for (const { key, tol } of numericFields) {
    const c = video[key] as ConstraintValue | undefined;
    if (c == null) continue;
    const got = settings[key];
    const gotNum = typeof got === "number" ? got : null;
    const t = constraintTargets(c);
    let verdict: DiffVerdict;
    let note: string | undefined;
    if (gotNum == null) {
      verdict = "not-exposed";
      note = "The track did not report this setting on this browser.";
    } else if (t.exact != null && typeof t.exact === "number") {
      verdict = numbersClose(gotNum, t.exact, tol) ? "match" : "differs";
      if (verdict === "differs") note = "`exact` was requested — a differing delivery means the browser substituted (should have thrown OverconstrainedError).";
    } else if (t.min != null && gotNum < t.min - tol) {
      verdict = "differs";
      note = `Delivered value is below the requested minimum (${t.min}).`;
    } else if (t.max != null && gotNum > t.max + tol) {
      verdict = "differs";
      note = `Delivered value is above the requested maximum (${t.max}).`;
    } else if (t.ideal != null && typeof t.ideal === "number") {
      verdict = numbersClose(gotNum, t.ideal, Math.max(tol, 0.5)) ? "match" : "differs";
      if (verdict === "differs") note = "`ideal` is a preference, not a demand — the browser delivered the closest mode the sensor supports.";
    } else {
      verdict = "match";
    }
    rows.push({ field: key, sent: t.label, received: fmtValue(got), verdict, note });
  }
  if (video.facingMode != null) {
    const t = constraintTargets(video.facingMode as ConstraintValue);
    const want = String(t.exact ?? t.ideal ?? "");
    const got = settings.facingMode;
    rows.push({
      field: "facingMode",
      sent: t.label,
      received: fmtValue(got),
      verdict: got == null ? "not-exposed" : String(got) === want ? "match" : "differs",
      note: got == null ? "Some browsers omit facingMode from getSettings() — the device label above is the fallback evidence." : undefined,
    });
  }
  if (video.deviceId != null) {
    const t = constraintTargets(video.deviceId as ConstraintValue);
    const want = String(t.exact ?? t.ideal ?? "");
    const got = settings.deviceId;
    rows.push({
      field: "deviceId",
      sent: `${JSON.stringify(video.deviceId).slice(0, 26)}…`,
      received: got ? `${String(got).slice(0, 20)}…` : "—",
      verdict: got == null ? "not-exposed" : String(got) === want ? "match" : "differs",
    });
  }
  // Delivered-but-not-requested facts are still shown (info rows).
  for (const key of ["width", "height", "frameRate", "facingMode"] as const) {
    if ((video as Record<string, unknown>)[key] == null && settings[key] != null) {
      rows.push({
        field: key,
        sent: "(not requested)",
        received: fmtValue(settings[key]),
        verdict: "info",
        note: "The site did not constrain this field — the value is the browser/sensor default.",
      });
    }
  }
  return rows;
}

// ── Feed API ──────────────────────────────────────────────────────────────────

export function ledgerBeginFeed(purpose: string, constraints: MediaStreamConstraints): string {
  ensureStarted();
  const id = `feed-${store.entries.filter((e) => e.kind === "feed").length + 1}`;
  const entry: FeedEntry = {
    kind: "feed",
    id,
    seq: nextSeq(),
    purpose,
    requestSentJson: JSON.stringify(constraints, null, 2),
    requestedAt: ledgerNow(),
    grantedAt: null,
    grantLatencyMs: null,
    firstFrameAt: null,
    firstFrameLatencyMs: null,
    error: null,
    received: null,
    diffs: [],
    telemetry: { framesObserved: null, measuredFps: null, resolutionChanges: [] },
    stoppedAt: null,
    lifetimeMs: null,
    notExposed: feedNotExposedRows(),
  };
  store.entries.push(entry);
  pushEvent(id, `getUserMedia REQUEST SENT — ${purpose}`);
  bump();
  return id;
}

export function ledgerFeedDenied(feedId: string, error: string): void {
  const e = findEntry<FeedEntry>(feedId, "feed");
  if (!e) return;
  e.error = error;
  e.stoppedAt = ledgerNow();
  e.lifetimeMs = Math.round((e.stoppedAt.perfMs - e.requestedAt.perfMs) * 10) / 10;
  pushEvent(feedId, `getUserMedia REJECTED after ${e.lifetimeMs}ms — ${error}`);
  bump();
}

/** Records the grant: full settings/capabilities dumps, diffs, device enumeration. */
export async function ledgerFeedGranted(feedId: string, stream: MediaStream): Promise<void> {
  const e = findEntry<FeedEntry>(feedId, "feed");
  if (!e) return;
  e.grantedAt = ledgerNow();
  e.grantLatencyMs = Math.round((e.grantedAt.perfMs - e.requestedAt.perfMs) * 10) / 10;
  const track = stream.getVideoTracks()[0] ?? null;
  let settings: Record<string, unknown> = {};
  let capabilities: Record<string, unknown> | null = null;
  let constraintsInEffect: Record<string, unknown> | null = null;
  try {
    settings = dumpObject(track?.getSettings?.());
  } catch {
    // settings dump is best-effort
  }
  try {
    capabilities = track?.getCapabilities ? dumpObject(track.getCapabilities()) : null;
  } catch {
    capabilities = null;
  }
  try {
    constraintsInEffect = track?.getConstraints ? dumpObject(track.getConstraints()) : null;
  } catch {
    constraintsInEffect = null;
  }
  const w = typeof settings.width === "number" ? settings.width : null;
  const h = typeof settings.height === "number" ? settings.height : null;
  let enumeratedCameras: { label: string; deviceId: string }[] = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    enumeratedCameras = devices.filter((d) => d.kind === "videoinput").map((d) => ({ label: d.label, deviceId: d.deviceId }));
  } catch {
    enumeratedCameras = [];
  }
  e.received = {
    trackLabel: track?.label ?? "",
    deviceId: typeof settings.deviceId === "string" ? settings.deviceId : null,
    groupId: typeof settings.groupId === "string" ? settings.groupId : null,
    settings,
    capabilities,
    constraintsInEffect,
    computedAspectRatio: w && h ? (w / h).toFixed(4) : null,
    enumeratedCameras,
  };
  let requestedVideo: MediaTrackConstraints | boolean = true;
  try {
    const parsed = JSON.parse(e.requestSentJson) as MediaStreamConstraints;
    requestedVideo = (parsed.video as MediaTrackConstraints | boolean | undefined) ?? true;
  } catch {
    requestedVideo = true;
  }
  e.diffs = diffConstraintsVsSettings(requestedVideo, settings);
  pushEvent(
    feedId,
    `getUserMedia GRANTED after ${e.grantLatencyMs}ms — "${track?.label ?? "?"}" delivering ${fmtValue(settings.width)}×${fmtValue(settings.height)} @ ${fmtValue(settings.frameRate)}fps (aspect ${e.received.computedAspectRatio ?? "?"})`
  );
  bump();
}

export function ledgerFeedFirstFrame(feedId: string): void {
  const e = findEntry<FeedEntry>(feedId, "feed");
  if (!e || e.firstFrameAt) return;
  e.firstFrameAt = ledgerNow();
  e.firstFrameLatencyMs = e.grantedAt ? Math.round((e.firstFrameAt.perfMs - e.grantedAt.perfMs) * 10) / 10 : null;
  pushEvent(feedId, `First video frame ${e.firstFrameLatencyMs != null ? `${e.firstFrameLatencyMs}ms after grant` : "arrived"}`);
  bump();
}

export function ledgerFeedResolutionChange(feedId: string, from: string, to: string): void {
  const e = findEntry<FeedEntry>(feedId, "feed");
  if (!e) return;
  e.telemetry.resolutionChanges.push({ at: ledgerNow(), from, to });
  pushEvent(feedId, `Mid-feed resolution change ${from} → ${to}`);
  bump();
}

export function ledgerFeedTelemetry(feedId: string, framesObserved: number | null, measuredFps: number | null): void {
  const e = findEntry<FeedEntry>(feedId, "feed");
  if (!e) return;
  if (framesObserved != null) e.telemetry.framesObserved = framesObserved;
  if (measuredFps != null) e.telemetry.measuredFps = measuredFps;
}

export function ledgerFeedStopped(feedId: string): void {
  const e = findEntry<FeedEntry>(feedId, "feed");
  if (!e || e.stoppedAt) return;
  e.stoppedAt = ledgerNow();
  e.lifetimeMs = Math.round((e.stoppedAt.perfMs - e.requestedAt.perfMs) * 10) / 10;
  pushEvent(
    feedId,
    `Feed stopped — lifetime ${e.lifetimeMs?.toLocaleString("en-US")}ms${e.telemetry.framesObserved != null ? ` · ${e.telemetry.framesObserved} frames observed` : ""}${e.telemetry.measuredFps != null ? ` · ${e.telemetry.measuredFps}fps measured` : ""}`
  );
  bump();
}

// ── Clip API ──────────────────────────────────────────────────────────────────

export function ledgerBeginClip(feedId: string, purpose: string, mime: string): string {
  ensureStarted();
  const id = `clip-${store.entries.filter((e) => e.kind === "clip").length + 1}`;
  const container = mime.includes("mp4") ? "MP4" : mime.includes("webm") ? "WebM" : mime.split(";")[0] || "unknown";
  const codecMatch = /codecs=([^;]+)/.exec(mime);
  const entry: ClipEntry = {
    kind: "clip",
    id,
    seq: nextSeq(),
    feedId,
    purpose,
    mime,
    container,
    codecs: codecMatch?.[1] ?? "browser default (not declared in the mime string)",
    startedAt: ledgerNow(),
    stoppedAt: null,
    durationMs: null,
    bytes: null,
    avgKbps: null,
    note: null,
  };
  store.entries.push(entry);
  pushEvent(id, `Clip recorder started on ${feedId} (${mime})`);
  bump();
  return id;
}

export function ledgerClipFinished(clipId: string, blob: Blob | null): void {
  const e = findEntry<ClipEntry>(clipId, "clip");
  if (!e) return;
  e.stoppedAt = ledgerNow();
  e.durationMs = Math.round((e.stoppedAt.perfMs - e.startedAt.perfMs) * 10) / 10;
  if (blob) {
    e.bytes = blob.size;
    e.avgKbps = e.durationMs > 0 ? Math.round(((blob.size * 8) / e.durationMs) * 10) / 10 : null;
    pushEvent(clipId, `Clip finished — ${blob.size.toLocaleString("en-US")} bytes over ${e.durationMs}ms ≈ ${e.avgKbps} kbps average`);
  } else {
    e.note = "Recorder produced no data (unsupported codec or torn-down track) — frames-only capture.";
    pushEvent(clipId, "Clip finished with NO data — frames-only capture");
  }
  bump();
}

// ── Frame API ─────────────────────────────────────────────────────────────────

export function ledgerRecordFrame(feedId: string, label: string, width: number, height: number): string {
  ensureStarted();
  const id = `frame-${store.entries.filter((e) => e.kind === "frame").length + 1}`;
  const entry: FrameEntry = { kind: "frame", id, seq: nextSeq(), feedId, label, capturedAt: ledgerNow(), width, height, encode: null };
  store.entries.push(entry);
  pushEvent(id, `Frame sampled from ${feedId} — ${width}×${height} (${label})`);
  bump();
  return id;
}

export function ledgerFrameEncoded(frameId: string, format: string, quality: number | null, bytes: number): void {
  const e = findEntry<FrameEntry>(frameId, "frame");
  if (!e) return;
  const px = e.width * e.height;
  e.encode = { format, quality, bytes, bitsPerPixel: px > 0 ? Math.round(((bytes * 8) / px) * 1000) / 1000 : 0 };
  pushEvent(frameId, `Frame encoded to ${format}${quality != null ? ` q=${quality}` : ""} — ${bytes.toLocaleString("en-US")} bytes (${e.encode.bitsPerPixel} bits/px)`);
  bump();
}

// ── Native round-trip API ─────────────────────────────────────────────────────

export function ledgerBeginNativeTrip(label: string, facing: "user" | "environment"): string {
  ensureStarted();
  const id = `native-${store.entries.filter((e) => e.kind === "native").length + 1}`;
  const entry: NativeTripEntry = {
    kind: "native",
    id,
    seq: nextSeq(),
    label,
    facing,
    timeline: [],
    trust: { pressIsTrusted: null, changeIsTrusted: null, filesApiNative: null },
    holdMs: null,
    file: null,
    exif: null,
    crossChecks: [],
  };
  store.entries.push(entry);
  pushEvent(id, `Native camera round-trip opened — ${label} (${facing === "user" ? "front" : "back"} camera requested via capture="${facing}")`);
  bump();
  return id;
}

export function ledgerNativeStep(tripId: string, step: string, note?: string): void {
  const e = findEntry<NativeTripEntry>(tripId, "native");
  if (!e) return;
  const at = ledgerNow();
  const prev = e.timeline[e.timeline.length - 1];
  e.timeline.push({ step, at, deltaMs: prev ? Math.round((at.perfMs - prev.at.perfMs) * 10) / 10 : null, note });
  pushEvent(tripId, `${e.label}: ${step}${note ? ` — ${note}` : ""}`);
  bump();
}

export function ledgerNativeTrust(tripId: string, trust: Partial<NativeTripEntry["trust"]>): void {
  const e = findEntry<NativeTripEntry>(tripId, "native");
  if (!e) return;
  e.trust = { ...e.trust, ...trust };
  bump();
}

export function ledgerNativeHold(tripId: string, holdMs: number): void {
  const e = findEntry<NativeTripEntry>(tripId, "native");
  if (!e) return;
  e.holdMs = Math.round(holdMs * 10) / 10;
  ledgerNativeStep(tripId, "Securing hold complete", `${e.holdMs}ms drawn from the 1–2s bell curve — recorded round-trip timings include this hold`);
}

/** Truncation guard for giant tag payloads (maker-note byte arrays etc.). */
function tagToString(key: string, tag: unknown): string {
  const t = tag as { description?: unknown; value?: unknown } | null;
  let raw: unknown = t && typeof t === "object" && "description" in t && t.description != null && t.description !== "" ? t.description : t?.value;
  if (raw == null) raw = tag;
  let s: string;
  if (Array.isArray(raw)) {
    s = raw.length > 32 ? `[${raw.length}-element array] ${JSON.stringify(raw.slice(0, 16))}…` : JSON.stringify(raw);
  } else if (typeof raw === "object") {
    try {
      s = JSON.stringify(raw);
    } catch {
      s = String(raw);
    }
  } else {
    s = String(raw);
  }
  if (s.length > 300) s = `${s.slice(0, 300)}… (${s.length} chars total)`;
  return s;
}

/**
 * Complete raw metadata dump: every readable EXIF/TIFF/GPS/maker tag in the
 * file (not a summary). Values are stringified; oversized binary payloads are
 * length-annotated instead of omitted.
 */
export async function ledgerNativeFileFacts(tripId: string, file: File, pressedEpochMs: number | null): Promise<void> {
  const e = findEntry<NativeTripEntry>(tripId, "native");
  if (!e) return;
  e.file = {
    name: file.name,
    declaredType: file.type || "unknown",
    bytes: file.size,
    lastModifiedIso: new Date(file.lastModified).toISOString(),
    lastModifiedMinusPressMs: pressedEpochMs != null && pressedEpochMs > 0 ? file.lastModified - pressedEpochMs : null,
    width: null,
    height: null,
  };
  pushEvent(
    tripId,
    `${e.label}: file facts — "${file.name}" · ${file.size.toLocaleString("en-US")} bytes · declared ${file.type || "unknown"} · lastModified ${e.file.lastModifiedIso}${e.file.lastModifiedMinusPressMs != null ? ` (${e.file.lastModifiedMinusPressMs >= 0 ? "+" : ""}${e.file.lastModifiedMinusPressMs.toLocaleString("en-US")}ms vs press)` : ""}`
  );
  bump();
  try {
    const buffer = await file.arrayBuffer();
    const tags = ExifReader.load(buffer);
    const dump: Record<string, string> = {};
    for (const key of Object.keys(tags)) {
      if (key === "Thumbnail") {
        dump[key] = "[embedded thumbnail — binary payload recorded by length only]";
        continue;
      }
      dump[key] = tagToString(key, tags[key]);
    }
    e.exif = { tagCount: Object.keys(dump).length, tags: dump };
    const w = Number.parseInt(dump["Image Width"] ?? dump.PixelXDimension ?? dump.ImageWidth ?? "", 10);
    const h = Number.parseInt(dump["Image Height"] ?? dump.PixelYDimension ?? dump.ImageHeight ?? "", 10);
    if (e.file && Number.isFinite(w) && Number.isFinite(h)) {
      e.file.width = w;
      e.file.height = h;
    }
    pushEvent(tripId, `${e.label}: raw metadata dump complete — ${e.exif.tagCount} tags read`);
  } catch (err) {
    e.exif = { tagCount: 0, tags: { "(parse error)": err instanceof Error ? err.message : String(err) } };
    pushEvent(tripId, `${e.label}: metadata parse failed — recorded honestly (0 readable tags)`);
  }
  buildNativeCrossChecks(e);
  bump();
}

/**
 * Sent-vs-received cross-checks for a native photo against everything the
 * session observed live: claimed camera identity vs enumerated devices, photo
 * pixels vs known sensor maximums, file clock vs session clock. Rows that
 * cannot be decided are explicit "not-exposed"/"info" — never guessed.
 */
function buildNativeCrossChecks(e: NativeTripEntry): void {
  const rows: DiffRow[] = [];
  const feeds = store.entries.filter((x): x is FeedEntry => x.kind === "feed" && x.received != null);
  const exif = e.exif?.tags ?? {};
  const make = exif.Make ?? null;
  const model = exif.Model ?? null;
  const cameraLabels = [...new Set(feeds.flatMap((f) => f.received?.enumeratedCameras.map((c) => c.label) ?? []))].filter(Boolean);
  if (make || model) {
    rows.push({
      field: "Claimed camera identity (EXIF Make/Model)",
      sent: [make, model].filter(Boolean).join(" "),
      received: cameraLabels.length > 0 ? cameraLabels.join(" · ") : "(no camera labels enumerated this session)",
      verdict: "info",
      note: "Browser camera labels never carry the phone's marketing model name, so direct equality cannot be computed — both sides are recorded verbatim for manual comparison. A mismatch in vendor family (e.g. Apple EXIF on a device enumerating Android-style labels) is reviewable evidence.",
    });
  } else {
    rows.push({
      field: "Claimed camera identity (EXIF Make/Model)",
      sent: "(absent from the file)",
      received: cameraLabels.length > 0 ? cameraLabels.join(" · ") : "(no camera labels enumerated this session)",
      verdict: "info",
      note: "The photo carries no Make/Model tags — metadata absence is scored by the forensic engine, not here.",
    });
  }
  const maxCapPx = feeds.reduce((best, f) => {
    const caps = f.received?.capabilities;
    const wc = caps?.width as { max?: number } | undefined;
    const hc = caps?.height as { max?: number } | undefined;
    if (wc?.max && hc?.max) return Math.max(best, wc.max * hc.max);
    return best;
  }, 0);
  if (e.file?.width && e.file.height) {
    const photoPx = e.file.width * e.file.height;
    if (maxCapPx > 0) {
      const sameFacing = e.facing === "user"; // live feeds in these flows are front-camera
      rows.push({
        field: "Photo resolution vs live-probed sensor maximum",
        sent: `${e.file.width}×${e.file.height} (${(photoPx / 1e6).toFixed(1)} MP)`,
        received: `session-probed max ≈ ${(maxCapPx / 1e6).toFixed(1)} MP${sameFacing ? " (same facing)" : " (front camera — the photo used the back camera, so this is a floor, not a ceiling)"}`,
        verdict: sameFacing && photoPx > maxCapPx * 1.15 ? "differs" : "info",
        note:
          sameFacing && photoPx > maxCapPx * 1.15
            ? "The photo claims more pixels than the same-facing sensor reported as its maximum during this session."
            : "Native camera apps often exceed getUserMedia video-mode maximums (still-photo pipelines use the full sensor) — informational, not an accusation.",
      });
    } else {
      rows.push({
        field: "Photo resolution vs live-probed sensor maximum",
        sent: `${e.file.width}×${e.file.height}`,
        received: "not comparable",
        verdict: "not-exposed",
        note: "No live feed exposed width/height capabilities this session, so there is no probed maximum to compare against.",
      });
    }
  }
  if (e.file) {
    const lm = e.file.lastModifiedMinusPressMs;
    rows.push({
      field: "File clock vs session clock",
      sent: `file lastModified ${e.file.lastModifiedIso}`,
      received: lm != null ? `${lm >= 0 ? "+" : ""}${lm.toLocaleString("en-US")}ms relative to the shutter press` : "press moment untracked",
      verdict: lm != null && lm < -90_000 ? "differs" : lm != null ? "match" : "info",
      note:
        lm != null && lm < -90_000
          ? "The file's own timestamp predates the press by more than the 90s tolerance — a pre-existing file was handed to the picker."
          : "A fresh camera capture is written during the round-trip, so its timestamp lands between press and file arrival.",
    });
  }
  const exifDto = exif.DateTimeOriginal ?? exif.DateTime ?? null;
  rows.push({
    field: "EXIF capture time vs session time",
    sent: exifDto ?? "(absent from the file)",
    received: e.timeline.find((t) => t.step.toLowerCase().includes("file"))?.at.iso ?? "—",
    verdict: exifDto ? "info" : "not-exposed",
    note: exifDto
      ? "EXIF DateTimeOriginal has whole-second resolution and uses the camera's local clock (no timezone) — exact-ms equality is physically impossible; agreement within the round-trip window is the honest expectation. The forensic engine scores the timestamp battery separately."
      : "The photo carries no EXIF capture time — nothing to compare.",
  });
  e.crossChecks = rows;
}

// ── Export builders ───────────────────────────────────────────────────────────

function clockLine(c: LedgerClock | null): string {
  if (!c) return "—";
  return `${c.iso} (monotonic ${c.perfMs.toLocaleString("en-US")}ms)`;
}

const DIFF_TAG: Record<DiffVerdict, string> = { match: "MATCH", differs: "DIFFERS", info: "INFO", "not-exposed": "NOT EXPOSED" };

/** Complete readable ledger text — appended to the session text export. */
export function buildLedgerText(): string {
  const d = store;
  const lines: string[] = [
    "━━━ CAPTURE FEED LEDGER (every camera interaction, millisecond-exact) ━━━",
    `Session: ${d.sessionLabel || "—"} · started ${clockLine(d.startedAt)}`,
    "",
    "CHRONOLOGICAL EVENT TIMELINE:",
  ];
  for (const ev of d.events) {
    lines.push(`  ${offsetLabel(ev.at, d.startedAt).padStart(14)} · ${ev.at.iso} · [${ev.refId}] ${ev.text}`);
  }
  for (const entry of d.entries) {
    if (entry.kind === "feed") {
      lines.push(
        "",
        `── LIVE FEED ${entry.id.toUpperCase()} — ${entry.purpose} ──`,
        "REQUEST SENT (verbatim getUserMedia constraints):",
        ...entry.requestSentJson.split("\n").map((l) => `  ${l}`),
        `Requested at: ${clockLine(entry.requestedAt)}`,
        entry.error
          ? `REJECTED: ${entry.error} (after ${entry.lifetimeMs ?? "?"}ms)`
          : `Granted at: ${clockLine(entry.grantedAt)} — ${entry.grantLatencyMs ?? "?"}ms after the request (includes the user's permission decision on a first ask)`,
        `First frame: ${clockLine(entry.firstFrameAt)}${entry.firstFrameLatencyMs != null ? ` — ${entry.firstFrameLatencyMs}ms after grant` : ""}`
      );
      if (entry.received) {
        lines.push(
          `RECEIVED — device: "${entry.received.trackLabel}" · deviceId ${entry.received.deviceId ? `${entry.received.deviceId.slice(0, 18)}…` : "—"} · groupId ${entry.received.groupId ? `${entry.received.groupId.slice(0, 18)}…` : "—"}`,
          `Computed delivered aspect ratio: ${entry.received.computedAspectRatio ?? "—"}`,
          "Full track settings dump (every exposed key):",
          ...Object.entries(entry.received.settings).map(([k, v]) => `  ${k}: ${fmtValue(v)}`),
          "Full device capability sheet at grant time:",
          ...(entry.received.capabilities
            ? Object.entries(entry.received.capabilities).map(([k, v]) => `  ${k}: ${fmtValue(v)}`)
            : ["  (getCapabilities not supported on this browser)"]),
          `Cameras enumerated at grant time: ${entry.received.enumeratedCameras.map((c) => c.label || "(unlabelled)").join(" · ") || "—"}`
        );
      }
      if (entry.diffs.length > 0) {
        lines.push("REQUESTED vs RECEIVED (every field, agreement shown too):");
        for (const r of entry.diffs) {
          lines.push(`  [${DIFF_TAG[r.verdict]}] ${r.field}: sent ${r.sent} → received ${r.received}${r.note ? ` — ${r.note}` : ""}`);
        }
      }
      lines.push(
        `Lifetime telemetry: ${entry.telemetry.framesObserved ?? "?"} frames observed · measured ${entry.telemetry.measuredFps ?? "?"}fps · ${entry.telemetry.resolutionChanges.length} mid-feed resolution change(s)`
      );
      for (const rc of entry.telemetry.resolutionChanges) lines.push(`  resolution change ${rc.from} → ${rc.to} at ${clockLine(rc.at)}`);
      lines.push(`Stopped: ${clockLine(entry.stoppedAt)} · total lifetime ${entry.lifetimeMs != null ? `${entry.lifetimeMs.toLocaleString("en-US")}ms` : "—"}`);
      lines.push("Not exposed by the browser (recorded honestly, never guessed):");
      for (const n of entry.notExposed) lines.push(`  ${n.field}: ${n.reason}`);
    } else if (entry.kind === "clip") {
      lines.push(
        "",
        `── RECORDED CLIP ${entry.id.toUpperCase()} — ${entry.purpose} (from ${entry.feedId}) ──`,
        `Container/codec actually used: ${entry.container} · ${entry.codecs} (mime "${entry.mime}")`,
        `Recording started: ${clockLine(entry.startedAt)}`,
        `Recording stopped: ${clockLine(entry.stoppedAt)} · duration ${entry.durationMs != null ? `${entry.durationMs.toLocaleString("en-US")}ms` : "—"}`,
        `Size: ${entry.bytes != null ? `${entry.bytes.toLocaleString("en-US")} bytes` : "—"} · average bitrate ${entry.avgKbps != null ? `${entry.avgKbps} kbps (computed: bytes ÷ duration)` : "—"}`
      );
      if (entry.note) lines.push(`Note: ${entry.note}`);
    } else if (entry.kind === "frame") {
      lines.push(
        "",
        `── STILL FRAME ${entry.id.toUpperCase()} — ${entry.label} (from ${entry.feedId}) ──`,
        `Captured: ${clockLine(entry.capturedAt)} · ${entry.width}×${entry.height}`,
        entry.encode
          ? `Encoded: ${entry.encode.format}${entry.encode.quality != null ? ` at quality ${entry.encode.quality}` : ""} · ${entry.encode.bytes.toLocaleString("en-US")} bytes · ${entry.encode.bitsPerPixel} bits/pixel effective`
          : "Encoded: not individually exported — in-memory canvas used for motion analysis only"
      );
    } else {
      lines.push("", `── NATIVE CAMERA ROUND-TRIP ${entry.id.toUpperCase()} — ${entry.label} (${entry.facing === "user" ? "front" : "back"} camera) ──`);
      lines.push("Millisecond timeline (each step wall-clock + monotonic, delta from previous):");
      for (const t of entry.timeline) {
        lines.push(`  ${t.step}: ${clockLine(t.at)}${t.deltaMs != null ? ` · Δ ${t.deltaMs.toLocaleString("en-US")}ms` : ""}${t.note ? ` — ${t.note}` : ""}`);
      }
      lines.push(
        `Trust facts: press ${entry.trust.pressIsTrusted == null ? "untracked" : entry.trust.pressIsTrusted ? "user-initiated (isTrusted)" : "SCRIPT-FIRED"} · change event ${entry.trust.changeIsTrusted == null ? "untracked" : entry.trust.changeIsTrusted ? "user-initiated (isTrusted)" : "SCRIPT-DISPATCHED"} · files API ${entry.trust.filesApiNative == null ? "unaudited" : entry.trust.filesApiNative ? "native accessor" : "WRAPPED accessor"}`,
        `Securing hold actually drawn: ${entry.holdMs != null ? `${entry.holdMs}ms (bell curve 1000–2000ms)` : "—"}`
      );
      if (entry.file) {
        lines.push(
          `File received: "${entry.file.name}" · declared type ${entry.file.declaredType} · ${entry.file.bytes.toLocaleString("en-US")} bytes · ${entry.file.width && entry.file.height ? `${entry.file.width}×${entry.file.height}` : "dimensions unread"}`,
          `File's own lastModified: ${entry.file.lastModifiedIso}${entry.file.lastModifiedMinusPressMs != null ? ` (${entry.file.lastModifiedMinusPressMs >= 0 ? "+" : ""}${entry.file.lastModifiedMinusPressMs.toLocaleString("en-US")}ms vs press)` : ""}`
        );
      }
      if (entry.exif) {
        lines.push(`COMPLETE RAW METADATA DUMP — ${entry.exif.tagCount} tags (every readable EXIF/TIFF/GPS/maker tag):`);
        for (const [k, v] of Object.entries(entry.exif.tags)) lines.push(`  ${k}: ${v}`);
      }
      if (entry.crossChecks.length > 0) {
        lines.push("SENT vs RECEIVED CROSS-CHECKS:");
        for (const r of entry.crossChecks) {
          lines.push(`  [${DIFF_TAG[r.verdict]}] ${r.field}: ${r.sent} ⇄ ${r.received}${r.note ? ` — ${r.note}` : ""}`);
        }
      }
    }
  }
  lines.push("", "━━━ END OF CAPTURE FEED LEDGER ━━━");
  return lines.join("\n");
}

/** Structured ledger object — merged into the session JSON export and the standalone download. */
export function buildLedgerJsonObject(): Record<string, unknown> {
  const d = store;
  return {
    sessionLabel: d.sessionLabel,
    startedAt: d.startedAt,
    eventTimeline: d.events.map((ev) => ({
      seq: ev.seq,
      wallClock: ev.at.iso,
      epochMs: ev.at.epochMs,
      monotonicMs: ev.at.perfMs,
      offsetFromStartMs: d.startedAt ? Math.round((ev.at.perfMs - d.startedAt.perfMs) * 10) / 10 : null,
      ref: ev.refId,
      event: ev.text,
    })),
    entries: d.entries,
    honesty:
      "Fields the browser physically cannot expose are recorded as explicit not-exposed rows with reasons (see each feed's notExposed list and cross-check verdicts) — never omitted, never guessed.",
  };
}
