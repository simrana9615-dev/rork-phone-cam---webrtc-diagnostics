/**
 * Which of the three Deep Probe runs you are about to start.
 *
 * The full run is the broad one: every permission, every sensor, every camera at
 * every size, shape, frame rate and control mode that camera says it supports,
 * plus the shots you take by hand. It is under a quarter of an hour on most
 * phones — the plan is cut to each camera's own stated limits, and a photograph
 * is not taken twice of the same size down the same path.
 *
 * The 640-only run is a single question asked twice. It opens the back camera
 * and the front camera with `width: 640` as the ONLY constraint — no height, no
 * aspect ratio, no frame rate, no device pin — and records what the phone
 * decided on your behalf. Two opens, about a minute.
 *
 * That question is worth its own mode because it is the one a real website
 * actually asks. Video-chat and scanner sites overwhelmingly send a bare width
 * and let the platform fill in the rest, and what the platform fills in is
 * entirely undocumented: which physical camera opens, what height comes back,
 * what aspect ratio it picks, what frame rate it settles on. The full sweep
 * cannot answer it, because the full sweep pins the device and states both
 * dimensions — by design, since it is measuring the range rather than the
 * default.
 *
 * The impossible run is the third, and it is the opposite of both: it asks each
 * side of the phone for things no camera can do — one pixel wide, a thousand
 * frames a second, a square that is also widescreen, a setting name that does
 * not exist, a camera that does not exist — and records how the platform
 * refuses. It exists as a mode of its own because succeeding is easy to
 * imitate and refusing correctly is not: a refusal carries an error name, a
 * named constraint and a timing, and all three have to be right. Not one
 * photograph is taken in it.
 *
 * The choice is made on the way in rather than mid-run, because it decides what
 * the run IS. It is persisted for the same reason the export choice is: this is
 * the page most likely to kill the tab, and the second attempt should not have
 * to re-derive what the first one wanted.
 */

import { useCallback, useEffect, useState } from "react";

export type RunMode = "full" | "width-640" | "impossible";

export const DEFAULT_RUN_MODE: RunMode = "full";

/** The width the investigation asks for, and the only thing it asks for. */
export const PROBE_WIDTH = 640;

const KEY = "deep-probe.mode.v1";

/** Every mounted hook, so two views of the mode can never drift apart. */
const listeners = new Set<(next: RunMode) => void>();

function coerce(raw: unknown): RunMode {
  if (raw === "width-640") return "width-640";
  if (raw === "impossible") return "impossible";
  return DEFAULT_RUN_MODE;
}

/**
 * The stored mode, or the default.
 *
 * Anything unreadable falls back to the full run rather than to the short one:
 * a person who does not remember choosing should get the run this page is for,
 * not a one-minute subset of it.
 */
export function readRunMode(): RunMode {
  try {
    return coerce(window.localStorage.getItem(KEY));
  } catch {
    return DEFAULT_RUN_MODE;
  }
}

/** Persists the mode and tells every mounted view about it. */
export function writeRunMode(next: RunMode): void {
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // Private browsing, a full quota, or storage denied outright. The choice
    // still applies to this session; only its memory across visits is lost.
  }
  for (const listener of listeners) listener(next);
}

/** Wipes the stored mode. Used by tests and by nothing else. */
export function clearRunMode(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — an unreadable store is also an unwritable one.
  }
}

export const RUN_MODE_INFO: Record<RunMode, { label: string; blurb: string; cost: string }> = {
  full: {
    label: "The full run",
    blurb:
      "Every permission this app knows how to ask for, real recordings from every sensor that was granted, then every camera asked for every size, shape, frame rate and control mode it says it supports — and photographed exactly TWICE while it answers, once at its ceiling down the browser's own photo path and once at its smallest rung down the path this app encodes. Every other row is still asked and still recorded; it simply takes no picture, and says so. The time that saves goes on a battery of impossible asks per camera: sizes that cannot exist, self-contradicting demands, malformed numbers, invented setting names, controls pushed past their published limits. Then the shots you take yourself: two through the phone's own camera app — the first naming NO camera, so you find out which one this phone opens when a page asks for none, and the second asking for the opposite — one request that contradicts itself, up to five photos from a single trip to your library, and the same photo handed back in three different shapes so the run can say what each one loses.",
    cost: "Two trips to the camera, one self-contradicting request, and four to the picker. Two photographs per camera, no more. The length depends on how many cameras this phone has — the run works it out before it starts and tells you what it actually took at the end.",
  },
  "width-640": {
    label: "640 wide, and nothing else",
    blurb:
      "One question, asked twice. The back camera and then the front camera are opened with a width of 640 as the ONLY constraint — no height, no aspect ratio, no frame rate, no device pinned — and the run records exactly what the phone decided on your behalf: the size it gave, the shape it chose, the frame rate it picked, which physical camera it opened, and everything that camera says about itself. A short round of impossible asks follows each side, because the same open is already paid for.",
    cost: "Two camera opens and four photos taken for you, then a short round of impossible asks down each side — about a minute and a half.",
  },
  impossible: {
    label: "Impossible asks, and nothing else",
    blurb:
      "The back camera and the front camera are asked for things no camera can do: one pixel wide, ninety-nine thousand pixels wide, zero frames a second, a thousand frames a second, a range whose floor sits above its own ceiling, a square size demanded alongside a widescreen shape, this camera pinned by name while the other side is insisted upon, negative numbers, fractions, not-a-number, infinity, empty text where a number belongs, setting names that do not exist, zoom past the maximum the camera itself just published, a flash on a camera that says it has none, the same camera opened twice in the same instant, a camera id belonging to nothing, and an impossible demand made of a camera that is already running and then of one already switched off. Each ask is sent twice where drift would show, and an ordinary request follows the battery to prove the pipeline still works. Succeeding is easy to imitate; refusing correctly — the right error, naming the right setting, in the right time, identically every time — is not.",
    cost: "About a minute. Two camera opens to begin with, and NOT ONE photograph taken anywhere in it.",
  },
};

/** A short summary for a card that has no room for a paragraph. */
export function summariseMode(mode: RunMode): string {
  if (mode === "width-640") return "640-wide investigation · two opens, about a minute";
  if (mode === "impossible") return "impossible asks only · about a minute, no photographs";
  return "the full run · every permission, every camera, every setting";
}

/**
 * How much of the user's attention the hand-shot stage wants, itemised.
 *
 * Written out rather than summarised because the shape of this stage changed:
 * it is no longer one shot per named side, and a card that still described it
 * that way would be describing a stage that no longer exists.
 */
export const MANUAL_STAGE_COST: string[] = [
  "2 trips to the camera app — the first names no camera, the second asks for the opposite of whatever the first turned out to be.",
  "1 trip that contradicts itself: the camera demanded and the library demanded in the same request.",
  "1 picker tap for the library original, which is the request that names the phone's own format rather than letting it convert.",
  "1 picker tap that brings back up to 5 photos at once.",
  "2 more picker taps for the same photo in its other two shapes.",
  "1 viewfinder shot for the whole run, plus one more on any camera the sweep watched actually zoom.",
];

/**
 * The mode, shared. Reads the stored value on mount rather than at module load
 * so a server render or a test with no `localStorage` cannot throw, and
 * subscribes so the dashboard card and the run page stay in step.
 */
export function useRunMode(): [RunMode, (next: RunMode) => void] {
  const [mode, setMode] = useState<RunMode>(DEFAULT_RUN_MODE);

  useEffect(() => {
    setMode(readRunMode());
    const listener = (next: RunMode): void => setMode(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const update = useCallback((next: RunMode): void => {
    setMode(next);
    writeRunMode(next);
  }, []);

  return [mode, update];
}
