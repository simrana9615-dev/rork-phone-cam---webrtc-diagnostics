import { useSyncExternalStore } from "react";

/**
 * Persisted setting: maximum duration of the silent background verification
 * clip (the hidden front-camera MediaRecorder run in the EyeDeeKit flows).
 *
 * Semantics — the cap is honored in BOTH directions:
 * - Hard stop: a timer stops the recorder at the cap when the background
 *   checks (injection audit etc.) overrun it, bounding the file size.
 * - Extend-to-cap: when the checks finish early the recorder keeps running
 *   until the cap, so longer settings genuinely buy a longer micro-motion
 *   evidence window.
 *
 * The configured cap is recorded in the clip's ledger purpose; the ledger's
 * duration/bytes/avg-kbps stay measured values, never the configured target.
 */

export const SILENT_CLIP_DEFAULT_MS = 2500;
export const SILENT_CLIP_MIN_MS = 1000;
export const SILENT_CLIP_MAX_MS = 10000;

export type SilentClipPreset = {
  ms: number;
  /** Short duration label, e.g. "2.5s". */
  label: string;
  /** Preset name, e.g. "Balanced". */
  name: string;
  description: string;
};

export const SILENT_CLIP_PRESETS: SilentClipPreset[] = [
  {
    ms: 1500,
    label: "1.5s",
    name: "Quick",
    description:
      "Smallest file and fastest teardown. The recorder may hard-stop before the background checks finish — the checks and sampled frames are unaffected, only the clip is shorter.",
  },
  {
    ms: 2500,
    label: "2.5s",
    name: "Balanced",
    description: "Matches the natural length of the background checks — full motion evidence without recording longer than needed. Default.",
  },
  {
    ms: 4000,
    label: "4s",
    name: "Extended",
    description: "Keeps recording past the checks for a longer micro-motion window — roughly 1.6× the balanced file size.",
  },
  {
    ms: 6000,
    label: "6s",
    name: "Maximum",
    description: "Longest micro-motion evidence window — roughly 2.4× the balanced file size; teardown waits for the cap.",
  },
];

const STORAGE_KEY = "vh-silent-clip-max-ms-v1";

function clampMs(v: number): number {
  if (!Number.isFinite(v)) return SILENT_CLIP_DEFAULT_MS;
  return Math.min(SILENT_CLIP_MAX_MS, Math.max(SILENT_CLIP_MIN_MS, Math.round(v)));
}

function load(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return SILENT_CLIP_DEFAULT_MS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampMs(parsed) : SILENT_CLIP_DEFAULT_MS;
  } catch {
    return SILENT_CLIP_DEFAULT_MS;
  }
}

let current: number = load();
const listeners = new Set<() => void>();

export function getSilentClipMaxMs(): number {
  return current;
}

export function setSilentClipMaxMs(ms: number): void {
  current = clampMs(ms);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(current));
  } catch {
    // private mode — the setting still applies for this session
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: the current silent-clip max duration in ms (re-renders on change). */
export function useSilentClipMaxMs(): number {
  return useSyncExternalStore(subscribe, getSilentClipMaxMs, getSilentClipMaxMs);
}
