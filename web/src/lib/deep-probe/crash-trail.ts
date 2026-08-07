/**
 * A breadcrumb trail that outlives the tab.
 *
 * The archive build has been killing the browser outright, which is precisely
 * why there has been nothing to read afterwards: a tab that is killed by the
 * operating system runs no error handler, flushes no console and fires no
 * event. Anything we want to know about the death has to already be on disk
 * before it happens.
 *
 * So every step writes a short note to `localStorage` before it starts, and the
 * next visit reads whatever the last run left behind. If the trail says the run
 * finished, it is discarded. If it says a step was in flight and never closed,
 * that step is where the tab died.
 *
 * ## Telling the two deaths apart
 *
 * Running out of memory and being killed for not responding look identical from
 * the outside, and they need opposite fixes. One measurement separates them: a
 * heartbeat on a timer.
 *
 *   • A blocked main thread cannot service a timer. If the heartbeat stops at
 *     the same moment a step begins, that step froze the thread and the OS
 *     killed an unresponsive page.
 *   • If the heartbeat kept ticking for seconds after the step began and then
 *     stopped dead, the thread was responsive right up to the end — which is
 *     what running out of memory looks like.
 *
 * The heap figures are recorded alongside, where the browser exposes them, so a
 * climbing allocation curve can corroborate. WebKit exposes neither, which is
 * exactly why the heartbeat rather than the heap is the primary signal.
 *
 * Cost discipline: the hot path writes one small key (~200 bytes). The full
 * trail is flushed on a throttle, so a per-capture loop of several hundred
 * steps does not turn into several hundred serialisations of a growing array.
 */

const TRAIL_KEY = "deep-probe.trail.v1";
const STEP_KEY = "deep-probe.trail-step.v1";
const BEAT_KEY = "deep-probe.trail-beat.v1";

/** Full trail flush interval. The live step pointer is written every mark. */
const FLUSH_MS = 400;
/** Heartbeat period. Short enough to time a freeze, long enough to be free. */
export const HEARTBEAT_MS = 250;
/**
 * A heartbeat gap wider than this means the main thread was blocked rather than
 * merely busy. Timers on a loaded phone drift, so the threshold sits well above
 * ordinary jitter — a gap this size is a freeze, not scheduling noise.
 */
export const FREEZE_GAP_MS = 1500;
/** Head entries always kept; the rest of the trail is a rolling tail. */
const HEAD_KEEP = 20;
const TAIL_KEEP = 90;

/** One step of a run, recorded before the step starts. */
export type Breadcrumb = {
  /** What is about to happen, in words a reader can act on. */
  step: string;
  /** Milliseconds since the trail started. */
  atMs: number;
  /** How long the previous step took. Null for the first. */
  prevMs: number | null;
  /** `performance.memory.usedJSHeapSize`, where the browser exposes it. */
  heapBytes: number | null;
  /** Bytes of capture data alive at this moment, as the caller counts them. */
  heldBytes: number | null;
};

export type TrailOutcome = "running" | "complete" | "failed" | "left";

export type Trail = {
  version: 1;
  runId: string;
  startedAt: string;
  /** Free-form run context — scope, capture count, whether a ZIP was asked for. */
  context: Record<string, string | number | boolean>;
  steps: Breadcrumb[];
  /** Steps dropped from the middle when the trail outgrew its cap. */
  dropped: number;
  heapLimitBytes: number | null;
  outcome: TrailOutcome;
  /** Set when the run ended in the ordinary way. */
  finishedAt: string | null;
  /** Set when the run threw. A thrown error is not a crash — the tab survived. */
  error: string | null;
};

/** The live pointer, rewritten on every mark. Deliberately tiny. */
type StepPointer = {
  runId: string;
  step: string;
  atMs: number;
  atEpoch: number;
  index: number;
  heapBytes: number | null;
  heldBytes: number | null;
};

type Beat = { runId: string; atMs: number; atEpoch: number };

function store(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    // Safari in private mode has the object but throws on write.
    localStorage.setItem("deep-probe.probe", "1");
    localStorage.removeItem("deep-probe.probe");
    return localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    // A full quota must never take the run down with it. The trail is a
    // diagnostic aid; losing it is a smaller loss than losing the run.
  }
}

type HeapWindow = { performance?: { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } } };

function heapUsed(): number | null {
  if (typeof performance === "undefined") return null;
  const memory = (performance as unknown as HeapWindow["performance"])?.memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
}

function heapLimit(): number | null {
  if (typeof performance === "undefined") return null;
  const memory = (performance as unknown as HeapWindow["performance"])?.memory;
  return typeof memory?.jsHeapSizeLimit === "number" ? memory.jsHeapSizeLimit : null;
}

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

let active: Trail | null = null;
let activeStartMs = 0;
let lastStepMs = 0;
let lastFlushMs = 0;
let beatTimer: number | null = null;
let heldBytesNow: number | null = null;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function flush(force: boolean): void {
  if (!active) return;
  const at = nowMs();
  if (!force && at - lastFlushMs < FLUSH_MS) return;
  lastFlushMs = at;
  writeJson(TRAIL_KEY, active);
}

function beat(): void {
  if (!active) return;
  const payload: Beat = { runId: active.runId, atMs: nowMs() - activeStartMs, atEpoch: Date.now() };
  writeJson(BEAT_KEY, payload);
}

/**
 * Opens a trail. Any unfinished trail already on disk is left alone — call
 * `takeCrashReport()` first if you want to read it, because this overwrites it.
 */
export function startTrail(context: Record<string, string | number | boolean>): string {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  activeStartMs = nowMs();
  lastStepMs = 0;
  lastFlushMs = 0;
  active = {
    version: 1,
    runId,
    startedAt: new Date().toISOString(),
    context,
    steps: [],
    dropped: 0,
    heapLimitBytes: heapLimit(),
    outcome: "running",
    finishedAt: null,
    error: null,
  };
  flush(true);
  beat();
  if (typeof window !== "undefined" && beatTimer == null) {
    beatTimer = window.setInterval(beat, HEARTBEAT_MS);
  }
  return runId;
}

/** Tells the trail how much capture data is alive, so a mark can record it. */
export function setHeldBytes(bytes: number | null): void {
  heldBytesNow = bytes;
}

/**
 * Records that a step is about to start. Call this BEFORE the work, never
 * after: a step that is never reached again is the one that killed the tab, and
 * that is only knowable if its start was written down.
 */
export function mark(step: string): void {
  if (!active) return;
  const at = nowMs() - activeStartMs;
  const crumb: Breadcrumb = {
    step,
    atMs: Math.round(at),
    prevMs: active.steps.length === 0 ? null : Math.round(at - lastStepMs),
    heapBytes: heapUsed(),
    heldBytes: heldBytesNow,
  };
  lastStepMs = at;
  active.steps.push(crumb);
  if (active.steps.length > HEAD_KEEP + TAIL_KEEP) {
    active.steps.splice(HEAD_KEEP, 1);
    active.dropped += 1;
  }
  const pointer: StepPointer = {
    runId: active.runId,
    step,
    atMs: crumb.atMs,
    atEpoch: Date.now(),
    index: active.steps.length + active.dropped,
    heapBytes: crumb.heapBytes,
    heldBytes: crumb.heldBytes,
  };
  writeJson(STEP_KEY, pointer);
  // The opening steps are always flushed. They are the baseline the heap
  // comparison is made against, and a run that dies in its first second would
  // otherwise leave a trail with no head to compare to. The throttle then takes
  // over for the long tail, where one more step is worth far less.
  flush(active.steps.length <= HEAD_KEEP);
}

/** Closes the trail cleanly. Nothing is reported to the next visit. */
export function finishTrail(outcome: Exclude<TrailOutcome, "running">, error?: string): void {
  if (!active) return;
  active.outcome = outcome;
  active.finishedAt = new Date().toISOString();
  active.error = error ?? null;
  flush(true);
  stopHeartbeat();
  active = null;
}

/** Stops the heartbeat without closing the trail. Used on unmount. */
export function stopHeartbeat(): void {
  if (beatTimer != null && typeof window !== "undefined") {
    window.clearInterval(beatTimer);
  }
  beatTimer = null;
}

/**
 * Marks the trail as deliberately left — a reload or a navigation, not a crash.
 * Wired to `pagehide`, which fires for an ordinary departure but not for an OS
 * kill. That difference is the whole reason to record it.
 */
export function markLeft(): void {
  if (!active || active.outcome !== "running") return;
  active.outcome = "left";
  active.finishedAt = new Date().toISOString();
  flush(true);
}

/* ------------------------------------------------------------------ *
 * Reading it back
 * ------------------------------------------------------------------ */

export type CrashCause = "out-of-memory" | "unresponsive" | "left-deliberately" | "threw" | "undetermined";

export type CrashReport = {
  runId: string;
  startedAt: string;
  context: Record<string, string | number | boolean>;
  /** The step that was in flight when the trail stopped. */
  diedIn: string;
  /** Position of that step in the whole run, dropped entries included. */
  diedAtIndex: number;
  /** Milliseconds from the start of the run to that step beginning. */
  diedAtMs: number;
  /** How long the step before it took, when there was one. */
  previousStepMs: number | null;
  /** The gap between the step starting and the last heartbeat. */
  silenceAfterMs: number | null;
  heapBytes: number | null;
  heapLimitBytes: number | null;
  heldBytes: number | null;
  /** Heap at the first recorded step, for the climbing-versus-flat question. */
  heapAtStartBytes: number | null;
  cause: CrashCause;
  /** One sentence naming the cause and the evidence for it. */
  verdict: string;
  steps: Breadcrumb[];
  dropped: number;
  error: string | null;
};

function classify(trail: Trail, pointer: StepPointer | null, silenceAfterMs: number | null): { cause: CrashCause; verdict: string } {
  if (trail.outcome === "left") {
    return { cause: "left-deliberately", verdict: "The page was closed or reloaded on purpose. This is not a crash." };
  }
  if (trail.outcome === "failed") {
    return {
      cause: "threw",
      verdict: `The run reported an error and stayed alive: ${trail.error ?? "no message"}. The tab was never killed, so this is a bug rather than a resource death.`,
    };
  }

  const heapNow = pointer?.heapBytes ?? trail.steps[trail.steps.length - 1]?.heapBytes ?? null;
  const heapStart = trail.steps[0]?.heapBytes ?? null;
  const limit = trail.heapLimitBytes;
  const nearLimit = heapNow != null && limit != null && limit > 0 ? heapNow / limit > 0.7 : false;
  const climbed = heapNow != null && heapStart != null && heapStart > 0 ? heapNow / heapStart > 1.6 : false;
  const froze = silenceAfterMs != null && silenceAfterMs < FREEZE_GAP_MS;

  if (froze) {
    return {
      cause: "unresponsive",
      verdict:
        "The heartbeat stopped at the same moment this step began, so the step blocked the main thread and the browser killed a page that had stopped responding. Memory was not the cause.",
    };
  }
  if (nearLimit) {
    return {
      cause: "out-of-memory",
      verdict: `Memory was at ${Math.round(((heapNow ?? 0) / (limit ?? 1)) * 100)}% of this browser's heap limit when the step began, and the page was still responding. That is running out of memory, not a freeze.`,
    };
  }
  if (climbed && silenceAfterMs != null && silenceAfterMs >= FREEZE_GAP_MS) {
    return {
      cause: "out-of-memory",
      verdict: `The heap had grown ${(heapNow! / heapStart!).toFixed(1)}× since the run started and the page was still answering its timer when it died. That points at allocation rather than a frozen thread.`,
    };
  }
  if (silenceAfterMs != null && silenceAfterMs >= FREEZE_GAP_MS) {
    return {
      cause: "undetermined",
      verdict: `The page kept responding for ${(silenceAfterMs / 1000).toFixed(1)}s into this step and then stopped. It was not frozen. This browser does not report heap use, so running out of memory cannot be confirmed from the inside — but nothing else fits.`,
    };
  }
  return {
    cause: "undetermined",
    verdict: "The trail ends at this step. There is not enough recorded to say which of the two deaths it was, and guessing would be worse than saying so.",
  };
}

/**
 * Reads the previous run's trail and clears it, so a crash is reported exactly
 * once. Returns null when the last run ended normally or there was none.
 */
export function takeCrashReport(): CrashReport | null {
  const trail = readJson<Trail>(TRAIL_KEY);
  const pointer = readJson<StepPointer>(STEP_KEY);
  const heartbeat = readJson<Beat>(BEAT_KEY);
  clearTrail();
  if (!trail || trail.version !== 1) return null;
  if (trail.outcome === "complete") return null;

  // The pointer is authoritative for which step was in flight: it is rewritten
  // on every mark, whereas the full trail is flushed on a throttle. A trail with
  // no steps and no pointer is a run that died before doing anything, which is
  // not worth reporting; a trail with a pointer always is.
  const live = pointer && pointer.runId === trail.runId ? pointer : null;
  if (trail.steps.length === 0 && !live && trail.outcome === "running") return null;
  const lastStep = trail.steps[trail.steps.length - 1] ?? null;
  const diedIn = live?.step ?? lastStep?.step ?? "(nothing was recorded)";
  const diedAtMs = live?.atMs ?? lastStep?.atMs ?? 0;
  const silenceAfterMs = heartbeat && heartbeat.runId === trail.runId ? Math.max(0, Math.round(heartbeat.atMs - diedAtMs)) : null;
  const { cause, verdict } = classify(trail, live, silenceAfterMs);

  return {
    runId: trail.runId,
    startedAt: trail.startedAt,
    context: trail.context,
    diedIn,
    diedAtIndex: live?.index ?? trail.steps.length + trail.dropped,
    diedAtMs,
    previousStepMs: lastStep?.prevMs ?? null,
    silenceAfterMs,
    heapBytes: live?.heapBytes ?? lastStep?.heapBytes ?? null,
    heapLimitBytes: trail.heapLimitBytes,
    heldBytes: live?.heldBytes ?? lastStep?.heldBytes ?? null,
    heapAtStartBytes: trail.steps[0]?.heapBytes ?? null,
    cause,
    verdict,
    steps: trail.steps,
    dropped: trail.dropped,
    error: trail.error,
  };
}

/** Removes every trace of the last trail. */
export function clearTrail(): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(TRAIL_KEY);
    s.removeItem(STEP_KEY);
    s.removeItem(BEAT_KEY);
  } catch {
    // Nothing to do — a storage that refuses removal will refuse writes too.
  }
}

function mb(bytes: number | null): string {
  return bytes == null ? "not reported by this browser" : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The whole trail as pasteable text, for handing back to whoever is fixing it. */
export function crashTrailText(report: CrashReport): string {
  const lines: string[] = [
    "DEEP PROBE — WHAT THE LAST RUN WAS DOING WHEN IT DIED",
    "=".repeat(78),
    "",
    `Run started       ${report.startedAt}`,
    `Died in step      ${report.diedIn}`,
    `Step number       ${report.diedAtIndex}`,
    `Time into the run ${(report.diedAtMs / 1000).toFixed(1)}s`,
    `Previous step     ${report.previousStepMs == null ? "n/a — this was the first" : `${report.previousStepMs} ms`}`,
    `Answered timers   ${report.silenceAfterMs == null ? "no heartbeat recorded" : `for ${(report.silenceAfterMs / 1000).toFixed(2)}s after the step began`}`,
    `Heap at that step ${mb(report.heapBytes)}${report.heapLimitBytes != null ? ` of ${mb(report.heapLimitBytes)}` : ""}`,
    `Heap at run start ${mb(report.heapAtStartBytes)}`,
    `Capture bytes     ${mb(report.heldBytes)}`,
    "",
    "READING",
    "-".repeat(78),
    report.verdict,
    "",
    "HOW THAT IS DECIDED",
    "-".repeat(78),
    `A timer ticks every ${HEARTBEAT_MS} ms while a run is in progress. A blocked main thread cannot service`,
    "a timer, so if the last tick lands at the same moment a step starts, that step froze the thread and",
    "the browser killed an unresponsive page. If ticks carried on for seconds into the step and then",
    "stopped dead, the thread was healthy and something else ended the tab — which on a phone means",
    "memory. The heap figures corroborate where the browser reports them; WebKit reports neither, which",
    "is exactly why the heartbeat and not the heap is the primary signal.",
    "",
    "RUN CONTEXT",
    "-".repeat(78),
    ...Object.entries(report.context).map(([key, value]) => `  ${key.padEnd(22)} ${String(value)}`),
    "",
    "EVERY STEP RECORDED",
    "-".repeat(78),
    "  at (s)   took (ms)  heap (MB)  held (MB)  step",
  ];
  if (report.dropped > 0) {
    lines.push(`  (${report.dropped} step(s) from the middle of the run were dropped to keep this trail small)`);
  }
  for (const step of report.steps) {
    lines.push(
      `  ${(step.atMs / 1000).toFixed(1).padStart(7)}  ${(step.prevMs == null ? "-" : String(step.prevMs)).padStart(9)}  ${(step.heapBytes == null ? "-" : (step.heapBytes / 1024 / 1024).toFixed(0)).padStart(9)}  ${(step.heldBytes == null ? "-" : (step.heldBytes / 1024 / 1024).toFixed(0)).padStart(9)}  ${step.step}`
    );
  }
  lines.push("", `  ${"".padStart(7)}  ${"".padStart(9)}  ${"".padStart(9)}  ${"".padStart(9)}  ← the run ended here`, "");
  return lines.join("\n");
}
