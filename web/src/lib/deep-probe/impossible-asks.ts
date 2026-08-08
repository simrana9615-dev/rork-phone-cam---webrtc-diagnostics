/**
 * The impossible asks.
 *
 * Every other stage of this run asks a camera for something it can plausibly
 * do. This one asks for things it cannot: one pixel wide, a thousand frames a
 * second, a square that is also widescreen, a setting name no camera has ever
 * had, a camera that does not exist.
 *
 * The reason is narrow and worth stating. Succeeding is easy to imitate — any
 * pipeline can hand back a 1280×720 frame and a plausible settings object. It
 * is REFUSING that is hard to imitate, because a real media stack refuses in a
 * very particular way: a specific error name, a specific constraint named as
 * the one it objected to, after a specific amount of time, and identically
 * every time you ask. Three separate things to get right, none of them
 * documented as a whole, and all three visible from JavaScript. A pipeline
 * that is not a camera tends to get one of them wrong — or, far more often,
 * cheerfully agrees to the impossible.
 *
 * The honesty rules are the same as everywhere else in Deep Probe, and one of
 * them matters more here than anywhere:
 *
 *   • A refusal is a RESULT, not an error. `OverconstrainedError` is the
 *     platform stating a limit, which is the entire point of this stage. It is
 *     never reported as a fault, in this app or in the device.
 *   • Agreeing to an impossible ask is also just a result. It is recorded and
 *     described, and no conclusion is drawn from it. Deep Probe has no verdict,
 *     no score and no finding.
 *   • "Not attempted" is its own outcome and never wears a refusal's clothes.
 *   • Where the standards genuinely say what should happen, this file says so
 *     and names it as the standard's claim. Where they do not, it says that
 *     instead of inventing an expectation.
 *
 * Not one photograph is taken here. Nothing in this stage produces an image.
 */

import { CAMERA_OPEN_TIMEOUT_MS, isCameraTimeout, openMediaWithDeadline, withCameraDeadline, type LateArrival } from "./camera-timeout";

/** Which kind of impossible thing an ask is. */
export type AskFamily =
  | "impossible-size"
  | "impossible-rate"
  | "contradiction"
  | "malformed"
  | "invented-key"
  | "beyond-control"
  | "concurrent"
  | "phantom-device"
  | "repeat"
  | "synonym"
  | "recovery"
  | "live-apply"
  | "after-stop";

export const FAMILY_LABEL: Record<AskFamily, string> = {
  "impossible-size": "Sizes that cannot exist",
  "impossible-rate": "Frame rates that cannot exist",
  contradiction: "Requests that contradict themselves",
  malformed: "Malformed values",
  "invented-key": "Invented setting names",
  "beyond-control": "Controls pushed past their stated limits",
  concurrent: "The same camera opened twice at once",
  "phantom-device": "A camera that does not exist",
  repeat: "The same ask sent twice",
  synonym: "The same ask written two ways",
  recovery: "A possible ask straight after an impossible one",
  "live-apply": "An impossible demand made of a running camera",
  "after-stop": "A demand made of a camera already switched off",
};

/** How an ask is delivered. */
export type AskVia = "open" | "open-twice" | "apply-live" | "apply-stopped";

export type ImpossibleAsk = {
  id: string;
  family: AskFamily;
  /** What is being asked for, in words. */
  asked: string;
  /**
   * What ought to happen, and whose claim that is. Where no standard settles
   * the question this says so rather than inventing a rule to be broken.
   */
  expectation: string;
  constraints: MediaTrackConstraints;
  via: AskVia;
  /** Part of the short battery. The short battery is the whole battery minus the slow half. */
  core: boolean;
  /** True when a second camera would answer this identically by construction. */
  oncePerRun?: boolean;
  /** The ask this one repeats verbatim, so the two answers can be compared. */
  repeatOf?: string;
  /** The ask this one means exactly the same thing as, written differently. */
  synonymOf?: string;
};

/** What came back. */
export type AskOutcome =
  /** The platform stated a limit. The most informative answer there is. */
  | "refused"
  /** The platform agreed to it. */
  | "granted"
  /** The value itself was rejected before any camera was consulted — a TypeError from the binding layer. */
  | "rejected-value"
  /** The request passed the camera deadline without answering. Not a refusal. */
  | "timed-out"
  /** Never sent, and the reason is on the answer. Not a refusal either. */
  | "not-attempted";

export type ImpossibleAnswer = {
  askId: string;
  family: AskFamily;
  asked: string;
  expectation: string;
  via: AskVia;
  deviceLabel: string;
  deviceId: string | null;
  outcome: AskOutcome;
  /** The error name exactly as thrown. Null when nothing was thrown. */
  errorName: string | null;
  /** The message exactly as thrown, untrimmed. The wording is itself an engine trait. */
  errorMessage: string | null;
  /** `OverconstrainedError.constraint` — which setting the platform blamed. */
  blamedConstraint: string | null;
  durationMs: number;
  /** `getSettings()` after the ask, when there was anything to read. */
  grantedSettings: Record<string, unknown> | null;
  granted: string | null;
  /** For the asks made of a running camera: what the settings were beforehand. */
  settingsBefore: Record<string, unknown> | null;
  /**
   * Whether a running camera's settings moved. Only meaningful on `apply-live`
   * asks; null everywhere else, and null is not "no".
   */
  changedLiveTrack: boolean | null;
  /** What this answer says, plainly, with no conclusion drawn from it. */
  reading: string;
  notes: string[];
};

export type ImpossibleReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scope: AskScope;
  answers: ImpossibleAnswer[];
  /** Places where the answers disagree with each other. Observations, not accusations. */
  observations: string[];
  aborted: boolean;
  notes: string[];
};

export type AskScope = "full" | "short";

/** One camera to interrogate. Either pinned by id, or named only by side. */
export type ImpossibleTarget = {
  deviceId: string | null;
  facingMode: "user" | "environment" | null;
  label: string;
  /** What this camera said about itself, so "beyond its stated limits" means something. */
  capabilities: MediaTrackCapabilities | null;
};

/**
 * A well-formed device id that belongs to nothing.
 *
 * Sixty-four hex characters, which is the shape every browser hands out, so a
 * platform cannot dismiss it as malformed — it has to actually look for it and
 * fail to find it.
 */
export const PHANTOM_DEVICE_ID = "deadbeef".repeat(8);

/** The paragraph the archive uses to explain what this stage is. */
export const IMPOSSIBLE_POLICY = [
  "Every request in this section was designed to be impossible, or to contradict itself, or to be so",
  "malformed that no camera could act on it. None of them is a fault in the app and none of them is a fault",
  "in the device.",
  "",
  "The reason for asking is that succeeding is easy to imitate and refusing is not. Any pipeline can hand",
  "back a plausible frame and a plausible settings object. A real media stack refuses in a very specific",
  "way — a specific error name, a specific constraint named as the one it objected to, after a specific",
  "amount of time, identically on every attempt. That is three separate things to get right, none of them",
  "documented in one place, all three readable from JavaScript.",
  "",
  "A REFUSED row is therefore the informative one, not the failed one. A GRANTED row means the platform",
  "agreed to something impossible, which is recorded and described and nothing more: Deep Probe states what",
  "happened and does not decide what it means about you or your device.",
  "",
  "REJECTED VALUE means the number or string never reached a camera at all — the browser's own type layer",
  "threw it out first, which is what should happen for a not-a-number frame rate. NOT ATTEMPTED means the",
  "ask was never sent, with the reason on the row; it is not a refusal, not a limit and not a timeout.",
  "TIMED OUT means the request passed the camera deadline without answering and was abandoned.",
  "",
  "No photograph is taken anywhere in this stage.",
].join("\n");

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

type ControlCaps = MediaTrackCapabilities & {
  zoom?: { min?: number; max?: number };
  torch?: boolean;
  pan?: { min?: number; max?: number };
  tilt?: { min?: number; max?: number };
};

/** Constraint objects the DOM types model as closed. The keys are real; the type definition is not the point here. */
function loose(value: Record<string, unknown>): MediaTrackConstraints {
  return value as unknown as MediaTrackConstraints;
}

function advanced(set: Record<string, unknown>): MediaTrackConstraints {
  return { advanced: [set] } as unknown as MediaTrackConstraints;
}

function pinOf(target: ImpossibleTarget): Record<string, unknown> {
  if (target.deviceId) return { deviceId: { exact: target.deviceId } };
  if (target.facingMode) return { facingMode: { exact: target.facingMode } };
  return {};
}

/**
 * The whole battery for one camera.
 *
 * `scope: "short"` keeps the core asks only — the ones that answer fastest and
 * discriminate hardest. Nothing is silently dropped: the runner reports which
 * scope it used and the archive says what the other scope would have added.
 */
export function impossibleAsksFor(target: ImpossibleTarget, scope: AskScope = "full"): ImpossibleAsk[] {
  const pin = pinOf(target);
  const caps = target.capabilities as ControlCaps | null;
  const zoomMax = typeof caps?.zoom?.max === "number" ? caps.zoom.max : null;
  const torchAdvertised = caps?.torch === true;
  const panAdvertised = caps?.pan != null;
  const tiltAdvertised = caps?.tilt != null;
  const opposite = target.facingMode === "user" ? "environment" : "user";

  const asks: ImpossibleAsk[] = [
    {
      id: "size-one-pixel",
      family: "impossible-size",
      asked: "exactly 1×1 — a single pixel",
      expectation:
        "No sensor produces a 1×1 frame, so a platform that measures the request against real hardware has to refuse it with OverconstrainedError. One that quietly scales a real frame down to it, or agrees and then delivers something else entirely, is doing something the hardware cannot.",
      constraints: loose({ ...pin, width: { exact: 1 }, height: { exact: 1 } }),
      via: "open",
      core: true,
    },
    {
      id: "size-absurd",
      family: "impossible-size",
      asked: "exactly 99999×99999 — roughly ten gigapixels",
      expectation: "Far beyond any sensor and beyond most texture limits too. OverconstrainedError is the expected answer, and the constraint the platform names as the offending one is the interesting half.",
      constraints: loose({ ...pin, width: { exact: 99999 }, height: { exact: 99999 } }),
      via: "open",
      core: true,
    },
    {
      id: "size-inverted-range",
      family: "impossible-size",
      asked: "a width range whose floor is above its ceiling — min 4000, max 100",
      expectation: "The specification is unambiguous: a range with min above max cannot be satisfied by anything, so this must fail with OverconstrainedError without a camera ever being consulted about it.",
      constraints: loose({ ...pin, width: { min: 4000, max: 100 } }),
      via: "open",
      core: true,
    },
    {
      id: "rate-zero",
      family: "impossible-rate",
      asked: "exactly 0 frames a second",
      expectation: "A camera delivering zero frames is not delivering video. Whether a platform refuses this outright or accepts it and then reports a real frame rate back is entirely undocumented, and both answers have been seen.",
      constraints: loose({ ...pin, frameRate: { exact: 0 } }),
      via: "open",
      core: true,
    },
    {
      id: "rate-thousand",
      family: "impossible-rate",
      asked: "exactly 1000 frames a second",
      expectation: "No phone camera runs at a thousand frames a second. A platform reading its own hardware refuses; one that treats the number as a wish grants it and hands back thirty.",
      constraints: loose({ ...pin, frameRate: { exact: 1000 } }),
      via: "open",
      core: true,
    },
    {
      id: "rate-inverted-range",
      family: "impossible-rate",
      asked: "a frame-rate range whose floor is above its ceiling — min 240, max 1",
      expectation: "Unsatisfiable by construction, exactly like the inverted width range. The two are here as a pair because a platform that catches one and not the other is checking ranges in only one place.",
      constraints: loose({ ...pin, frameRate: { min: 240, max: 1 } }),
      via: "open",
      core: false,
    },
    {
      id: "shape-square-widescreen",
      family: "contradiction",
      asked: "exactly 1080×1080 while also demanding an aspect ratio of 1.7778",
      expectation:
        "The size given is square; the ratio demanded is widescreen. They cannot both hold. Which half a platform honours — the size, the ratio, or neither — is a fingerprint, because nothing specifies a priority between them.",
      constraints: loose({ ...pin, width: { exact: 1080 }, height: { exact: 1080 }, aspectRatio: { exact: 1.7778 } }),
      via: "open",
      core: true,
    },
    {
      id: "invented-keys",
      family: "invented-key",
      asked: 'three settings no camera has ever had — "sparkleMode", "teleportRange", "quantumFocus"',
      expectation:
        "The specification says a platform must ignore constraints it does not recognise, so this should open a camera perfectly normally, as though nothing unusual had been asked. A platform that REFUSES it is validating against a list it should not have, and one that reports these back in its settings has invented them.",
      constraints: loose({ ...pin, sparkleMode: { exact: "aurora" }, teleportRange: { min: 3 }, quantumFocus: true }),
      via: "open",
      core: true,
    },
    {
      id: "invented-with-real",
      family: "invented-key",
      asked: 'a perfectly ordinary 640-wide request with one invented setting bolted on — "holographicDepth"',
      expectation: "The real half should be honoured and the invented half ignored. A refusal here says the unknown key poisoned a request that would otherwise have succeeded — which is the same platform behaviour as above, seen from the other side.",
      constraints: loose({ ...pin, width: { exact: 640 }, holographicDepth: { exact: 9 } }),
      via: "open",
      core: false,
    },
    {
      id: "malformed-negative-width",
      family: "malformed",
      asked: "a width of exactly -1",
      expectation:
        "Width is an unsigned integer in the standard, and the language binding converts a negative number into a very large positive one rather than rejecting it — -1 becomes 4294967295. So the honest expectation is not a type error but an OverconstrainedError about an impossibly large width, and a platform that reports anything else has taken its own route.",
      constraints: loose({ ...pin, width: { exact: -1 } }),
      via: "open",
      core: true,
    },
    {
      id: "malformed-fraction-width",
      family: "malformed",
      asked: "a width of exactly 640.5 — a fraction where a whole number belongs",
      expectation: "The binding layer should truncate this to 640 before any camera sees it, so a 640-wide camera ought to answer normally. A refusal means the fraction survived further into the stack than it should have.",
      constraints: loose({ ...pin, width: { exact: 640.5 } }),
      via: "open",
      core: false,
    },
    {
      id: "malformed-nan-rate",
      family: "malformed",
      asked: "a frame rate of not-a-number",
      expectation: "Frame rate is a floating-point value in the standard, and the language binding rejects non-finite values with a TypeError before a camera is ever consulted. Anything other than a TypeError here means the value got past a check it should not have.",
      constraints: loose({ ...pin, frameRate: { exact: Number.NaN } }),
      via: "open",
      core: true,
    },
    {
      id: "malformed-infinite-rate",
      family: "malformed",
      asked: "a frame rate of infinity",
      expectation: "Same rule as not-a-number: infinity is not a finite floating-point value, so a TypeError from the binding layer is the expected answer and an OverconstrainedError would mean it reached the camera.",
      constraints: loose({ ...pin, frameRate: { exact: Number.POSITIVE_INFINITY } }),
      via: "open",
      core: false,
    },
    {
      id: "malformed-empty-string-width",
      family: "malformed",
      asked: 'a width of "" — empty text where a number belongs',
      expectation: "Empty text converts to zero under the standard binding rules, so this is really a request for a zero-pixel-wide camera and OverconstrainedError is the expected answer. What the platform NAMES as the offending constraint is the part worth reading.",
      constraints: loose({ ...pin, width: { exact: "" } }),
      via: "open",
      core: false,
    },
    {
      id: "phantom-device",
      family: "phantom-device",
      asked: "a camera whose id is sixty-four hex characters belonging to nothing at all",
      expectation:
        "The id is well formed, so it cannot be dismissed as malformed — the platform has to look for it and fail. OverconstrainedError naming deviceId is the expected answer. Opening SOME camera instead would mean an exact device request is being treated as a preference.",
      constraints: loose({ deviceId: { exact: PHANTOM_DEVICE_ID } }),
      via: "open",
      core: true,
      oncePerRun: true,
    },
    {
      id: "repeat-size-absurd",
      family: "repeat",
      asked: "exactly 99999×99999 again, sent immediately after the first time",
      expectation:
        "A real stack refuses this identically both times, with the same error, the same named constraint and roughly the same timing. Drift between the two answers is itself the finding, which is why the pair is here rather than one ask on its own.",
      constraints: loose({ ...pin, width: { exact: 99999 }, height: { exact: 99999 } }),
      via: "open",
      core: true,
      repeatOf: "size-absurd",
    },
    {
      id: "synonym-exact",
      family: "synonym",
      asked: "exactly 640 wide, written as an exact value",
      expectation: "This and the next ask mean precisely the same thing under the standard. They are sent as a pair for one reason: they must answer identically, and on some platforms they do not.",
      constraints: loose({ ...pin, width: { exact: 640 } }),
      via: "open",
      core: false,
    },
    {
      id: "synonym-min-max",
      family: "synonym",
      asked: "640 wide, written as a range from 640 to 640",
      expectation: "A range whose floor and ceiling are the same number is an exact value by definition. Any difference between this answer and the previous one is a difference in the platform, not in the request.",
      constraints: loose({ ...pin, width: { min: 640, max: 640 } }),
      via: "open",
      core: false,
      synonymOf: "synonym-exact",
    },
  ];

  if (target.deviceId && target.facingMode) {
    asks.push({
      id: "pin-versus-facing",
      family: "contradiction",
      asked: `this exact camera pinned by id, while demanding the ${opposite === "user" ? "front" : "back"} camera by side`,
      expectation:
        "Two exact requests naming two different cameras. Both cannot be honoured. A platform that refuses is treating both as binding; one that opens a camera anyway has silently decided which of your two instructions matters more, and which one it picked is the finding.",
      constraints: loose({ deviceId: { exact: target.deviceId }, facingMode: { exact: opposite } }),
      via: "open",
      core: true,
    });
  }

  // The ordinary request closes the opening block, always. It is the one ask in
  // the battery that must simply work, and putting it last is what makes it a
  // check on everything above it rather than one more row beside them.
  asks.push(
    {
      id: "recovery-plain",
      family: "recovery",
      asked: "an ordinary request with no constraint but the camera itself, sent straight after the impossible ones",
      expectation:
        "This must simply work. It is here because some stacks are left wedged by a run of bad requests and afterwards return a dead track, a frozen frame or nothing at all. If this one fails, everything above it was answered by a pipeline that was already in trouble, and the archive says so rather than reading the refusals as clean results.",
      constraints: loose({ ...pin }),
      via: "open",
      core: true,
    },
    {
      id: "live-size-impossible",
      family: "live-apply",
      asked: "99999 pixels wide demanded of a camera that is already running",
      expectation:
        "The specification is explicit here: when a change to a running track cannot be satisfied, it must fail AND the track's settings must be left exactly as they were. This ask records the settings before and after, so a platform that quietly moved the picture while reporting failure has nowhere to hide.",
      constraints: loose({ width: { exact: 99999 } }),
      via: "apply-live",
      core: true,
    },
    {
      id: "live-invented-key",
      family: "live-apply",
      asked: 'an invented setting — "chronoStabilise" — demanded of a running camera',
      expectation: "Unrecognised settings must be ignored, so a running camera should accept this and change nothing. A refusal means the platform is validating names, and a change means it invented a meaning for one.",
      constraints: loose({ chronoStabilise: { exact: true } }),
      via: "apply-live",
      core: false,
    },
    {
      id: "live-zoom-beyond",
      family: "beyond-control",
      asked: zoomMax != null ? `zoom set to ${zoomMax * 4}, four times the maximum this camera itself published (${zoomMax})` : "zoom set to 100 on a camera that published no zoom range at all",
      expectation:
        zoomMax != null
          ? "The camera stated its own ceiling moments ago. Refusing its own published maximum being exceeded is the consistent answer; granting it means the published ceiling was not a real one."
          : "This camera published no zoom range, so there is nothing to exceed and the ask should simply be refused or ignored. A camera that accepts a zoom it never advertised is worth a line in the record.",
      constraints: advanced({ zoom: zoomMax != null ? zoomMax * 4 : 100 }),
      via: "apply-live",
      core: true,
    },
    {
      id: "live-pan-tilt",
      family: "beyond-control",
      asked: panAdvertised || tiltAdvertised ? "pan and tilt driven far past their published ranges" : "pan and tilt on a camera that published neither",
      expectation: "Phone cameras do not physically pan or tilt. A platform that reports success here is agreeing to move something that does not move.",
      constraints: advanced({ pan: 1000, tilt: -1000 }),
      via: "apply-live",
      core: false,
    }
  );

  if (!torchAdvertised) {
    asks.push({
      id: "live-torch-unclaimed",
      family: "beyond-control",
      asked: "the flash switched on, on a camera that says it has no flash",
      expectation:
        "This camera's own capability list contains no torch. Asking for one should be refused or ignored. It is asked precisely because the camera denied having one — where a torch IS advertised the ordinary sweep already fires it once, and this ask is left out rather than firing it a second time.",
      constraints: advanced({ torch: true }),
      via: "apply-live",
      core: false,
    });
  }

  asks.push(
    {
      id: "after-stop-apply",
      family: "after-stop",
      asked: "an ordinary 640-wide change demanded of a camera that has already been switched off",
      expectation:
        "No standard settles this cleanly, so nothing is expected of it. A rejection, a silent success and a settings object that still describes the dead track have all been seen, and which one this platform does is recorded exactly as it happened.",
      constraints: loose({ width: { exact: 640 } }),
      via: "apply-stopped",
      core: true,
    },
    {
      id: "concurrent-open",
      family: "concurrent",
      asked: "the same camera opened twice in the same instant, with neither request waiting for the other",
      expectation:
        "Nothing specifies what should happen. The camera may be shared between both requests, the second may queue behind the first, or it may be refused outright as busy. All three are real platform behaviours and they are one of the sharper differences between engines.",
      constraints: loose({ ...pin }),
      via: "open-twice",
      core: true,
    }
  );

  return scope === "short" ? asks.filter((ask) => ask.core) : asks;
}

/* ------------------------------------------------------------------ *
 * Reading the answers
 * ------------------------------------------------------------------ */

function errorNameOf(err: unknown): string {
  if (err instanceof DOMException) return err.name;
  return err instanceof Error ? err.name : "unknown";
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message || "(the error carried no message)";
  return String(err);
}

/** `OverconstrainedError.constraint` — the setting the platform blamed, when it named one. */
function blamedConstraint(err: unknown): string | null {
  const named = err as { constraint?: unknown } | null;
  return typeof named?.constraint === "string" && named.constraint.length > 0 ? named.constraint : null;
}

function outcomeFor(err: unknown): AskOutcome {
  if (isCameraTimeout(err)) return "timed-out";
  return errorNameOf(err) === "TypeError" ? "rejected-value" : "refused";
}

function verbatim(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function shortSettings(settings: Record<string, unknown> | null): string | null {
  if (!settings) return null;
  const bits: string[] = [];
  if (typeof settings.width === "number" && typeof settings.height === "number") bits.push(`${settings.width}×${settings.height}`);
  if (typeof settings.frameRate === "number") bits.push(`${Math.round(settings.frameRate * 100) / 100} fps`);
  if (typeof settings.facingMode === "string") bits.push(settings.facingMode);
  if (typeof settings.aspectRatio === "number") bits.push(`AR ${Math.round(settings.aspectRatio * 1000) / 1000}`);
  if (typeof settings.zoom === "number") bits.push(`zoom ${settings.zoom}`);
  if (typeof settings.torch === "boolean") bits.push(`torch ${settings.torch}`);
  return bits.join(" · ") || "(the settings object was empty)";
}

/**
 * What one answer says, in plain words, with nothing concluded from it.
 *
 * Deliberately descriptive: it names what happened and what that tells you
 * about this platform's behaviour, and stops there.
 */
export function impossibleReading(ask: ImpossibleAsk, answer: Pick<ImpossibleAnswer, "outcome" | "errorName" | "errorMessage" | "blamedConstraint" | "granted" | "changedLiveTrack" | "durationMs">): string {
  const took = `${answer.durationMs} ms`;
  switch (answer.outcome) {
    case "refused": {
      const blame = answer.blamedConstraint ? ` and named "${answer.blamedConstraint}" as the setting it objected to` : " without naming which setting it objected to, which is allowed but less specific than most engines manage";
      return `Refused after ${took}. The platform answered ${answer.errorName}${blame}. A refusal is the informative answer here: the request was measured against something real and turned down.`;
    }
    case "granted": {
      const got = answer.granted ? ` What came back was ${answer.granted}.` : "";
      const moved =
        ask.via === "apply-live" ? (answer.changedLiveTrack === true ? " The running camera's settings DID move as a result." : " The running camera's settings did not move.") : "";
      return `Granted after ${took}. The platform accepted this without complaint.${got}${moved} That is recorded as what happened and nothing is concluded from it.`;
    }
    case "rejected-value":
      return `The value was thrown out after ${took}, before any camera was consulted — ${answer.errorName}. This is the browser's own type layer refusing to carry the value, which for a value of this shape is the expected place for it to stop.`;
    case "timed-out":
      return `No answer within the ${(CAMERA_OPEN_TIMEOUT_MS / 1000).toFixed(0)}-second camera deadline, so the request was abandoned after ${took}. A timeout is not a refusal, not a limit the camera stated and not evidence about the hardware.`;
    default:
      return `Not attempted. ${answer.errorMessage ?? "The reason is recorded on this row."} This is not a refusal and nothing is inferred from it.`;
  }
}

function answerFrom(ask: ImpossibleAsk, target: ImpossibleTarget, partial: Partial<ImpossibleAnswer> & { outcome: AskOutcome; durationMs: number }): ImpossibleAnswer {
  const base: ImpossibleAnswer = {
    askId: ask.id,
    family: ask.family,
    asked: ask.asked,
    expectation: ask.expectation,
    via: ask.via,
    deviceLabel: target.label,
    deviceId: target.deviceId,
    outcome: partial.outcome,
    errorName: partial.errorName ?? null,
    errorMessage: partial.errorMessage ?? null,
    blamedConstraint: partial.blamedConstraint ?? null,
    durationMs: partial.durationMs,
    grantedSettings: partial.grantedSettings ?? null,
    granted: partial.granted ?? null,
    settingsBefore: partial.settingsBefore ?? null,
    changedLiveTrack: partial.changedLiveTrack ?? null,
    reading: "",
    notes: partial.notes ?? [],
  };
  return { ...base, reading: impossibleReading(ask, base) };
}

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

export type ImpossibleRoundOptions = {
  scope?: AskScope;
  onProgress?: (message: string) => void;
  onAnswer?: (answer: ImpossibleAnswer) => void;
  shouldAbort?: () => boolean;
  waitWhilePaused?: () => Promise<void>;
  /** Polled between asks. Returning true leaves the rest of the battery untried. */
  outOfTime?: () => boolean;
  /** Called with the asks that were never sent, and why. Never counted as refusals. */
  onUntried?: (asks: ImpossibleAsk[], reason: string) => void;
  onLate?: (late: LateArrival) => void;
  /** Ask ids already sent once in this run. Asks marked once-per-run are skipped when listed here. */
  askedOnce?: Set<string>;
  onNote?: (note: string) => void;
};

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }
}

/**
 * Sends one camera the whole battery.
 *
 * The order is not arbitrary. The opening asks run first and end with the
 * ordinary request, so a stack left wedged by them is caught immediately; that
 * same open supplies the live track the running-camera asks need, which is then
 * stopped to answer the switched-off ask; and the two-at-once ask goes last
 * because it is the only one that deliberately leaves two cameras open.
 */
export async function runImpossibleRound(target: ImpossibleTarget, options: ImpossibleRoundOptions = {}): Promise<ImpossibleAnswer[]> {
  const scope = options.scope ?? "full";
  const asks = impossibleAsksFor(target, scope);
  const answers: ImpossibleAnswer[] = [];
  const seen = options.askedOnce;

  const push = (answer: ImpossibleAnswer): void => {
    answers.push(answer);
    options.onAnswer?.(answer);
  };

  /** True when the caller wants out. Untried asks are reported, never invented. */
  const halt = async (remaining: ImpossibleAsk[]): Promise<boolean> => {
    await options.waitWhilePaused?.();
    if (options.shouldAbort?.()) {
      if (remaining.length > 0) options.onUntried?.(remaining, "You stopped the run before these asks were sent. They were never asked, which is not the same as being refused.");
      return true;
    }
    if (options.outOfTime?.()) {
      if (remaining.length > 0)
        options.onUntried?.(remaining, `${target.label} reached its share of the run's time before these asks were sent. They were never asked; nothing is inferred about what they would have returned.`);
      return true;
    }
    return false;
  };

  const opens = asks.filter((ask) => ask.via === "open");
  const liveAsks = asks.filter((ask) => ask.via === "apply-live");
  const stoppedAsks = asks.filter((ask) => ask.via === "apply-stopped");
  const twiceAsks = asks.filter((ask) => ask.via === "open-twice");

  let liveStream: MediaStream | null = null;

  for (const [index, ask] of opens.entries()) {
    if (await halt([...opens.slice(index), ...liveAsks, ...stoppedAsks, ...twiceAsks])) {
      stopStream(liveStream);
      return answers;
    }
    if (ask.oncePerRun && seen?.has(ask.id)) {
      options.onNote?.(
        `${target.label}: "${ask.asked}" was not repeated here. It names no camera in particular, so a second camera would answer it by exactly the same route as the first, and that answer is already recorded above.`
      );
      continue;
    }
    seen?.add(ask.id);
    options.onProgress?.(`${target.label} — ${ask.asked}`);

    const started = performance.now();
    try {
      const stream = await openMediaWithDeadline({ audio: false, video: ask.constraints }, { what: `${target.label} (${ask.asked})`, onLate: options.onLate });
      const track = stream.getVideoTracks()[0] ?? null;
      const settings = verbatim(track?.getSettings?.() ?? null);
      push(
        answerFrom(ask, target, {
          outcome: "granted",
          durationMs: Math.round(performance.now() - started),
          grantedSettings: settings,
          granted: shortSettings(settings),
          notes: track == null ? ["The open succeeded but carried no video track, which is itself unusual."] : [],
        })
      );
      // The ordinary request at the end of the block is kept open on purpose:
      // it is the track the running-camera asks are made of, so they cost no
      // extra camera cycle and no extra prompt.
      if (ask.family === "recovery" && track != null) {
        stopStream(liveStream);
        liveStream = stream;
      } else {
        stopStream(stream);
      }
    } catch (err) {
      push(
        answerFrom(ask, target, {
          outcome: outcomeFor(err),
          durationMs: Math.round(performance.now() - started),
          errorName: errorNameOf(err),
          errorMessage: errorMessageOf(err),
          blamedConstraint: blamedConstraint(err),
        })
      );
    }
  }

  const liveTrack = liveStream?.getVideoTracks()[0] ?? null;
  if (liveTrack == null && (liveAsks.length > 0 || stoppedAsks.length > 0)) {
    const reason =
      "These asks need a camera that is already running, and the ordinary re-open that would have supplied one did not produce a track. They were never sent — that is not a refusal, and nothing is inferred about what they would have returned.";
    options.onUntried?.([...liveAsks, ...stoppedAsks], reason);
  }

  if (liveTrack != null) {
    for (const [index, ask] of liveAsks.entries()) {
      if (await halt([...liveAsks.slice(index), ...stoppedAsks, ...twiceAsks])) {
        stopStream(liveStream);
        return answers;
      }
      options.onProgress?.(`${target.label} — ${ask.asked}`);
      const before = verbatim(liveTrack.getSettings?.() ?? null);
      const started = performance.now();
      try {
        await withCameraDeadline(liveTrack.applyConstraints(ask.constraints), { what: `${target.label} (${ask.asked})`, onLate: options.onLate });
        const after = verbatim(liveTrack.getSettings?.() ?? null);
        push(
          answerFrom(ask, target, {
            outcome: "granted",
            durationMs: Math.round(performance.now() - started),
            settingsBefore: before,
            grantedSettings: after,
            granted: shortSettings(after),
            changedLiveTrack: JSON.stringify(before) !== JSON.stringify(after),
          })
        );
      } catch (err) {
        const after = verbatim(liveTrack.getSettings?.() ?? null);
        push(
          answerFrom(ask, target, {
            outcome: outcomeFor(err),
            durationMs: Math.round(performance.now() - started),
            errorName: errorNameOf(err),
            errorMessage: errorMessageOf(err),
            blamedConstraint: blamedConstraint(err),
            settingsBefore: before,
            grantedSettings: after,
            granted: shortSettings(after),
            changedLiveTrack: JSON.stringify(before) !== JSON.stringify(after),
          })
        );
      }
    }

    // Put the flash out before anything else, in case one of the asks above
    // lit it. The sweep has the same rule and for the same reason.
    try {
      await liveTrack.applyConstraints(advanced({ torch: false }));
    } catch {
      // this camera never had a controllable torch
    }

    for (const [index, ask] of stoppedAsks.entries()) {
      if (await halt([...stoppedAsks.slice(index), ...twiceAsks])) {
        stopStream(liveStream);
        return answers;
      }
      options.onProgress?.(`${target.label} — ${ask.asked}`);
      const before = verbatim(liveTrack.getSettings?.() ?? null);
      stopStream(liveStream);
      const started = performance.now();
      try {
        await withCameraDeadline(liveTrack.applyConstraints(ask.constraints), { what: `${target.label} (${ask.asked})`, onLate: options.onLate });
        const after = verbatim(liveTrack.getSettings?.() ?? null);
        push(
          answerFrom(ask, target, {
            outcome: "granted",
            durationMs: Math.round(performance.now() - started),
            settingsBefore: before,
            grantedSettings: after,
            granted: shortSettings(after),
            notes: [`The track's readyState at the moment of the ask was "${liveTrack.readyState}".`],
          })
        );
      } catch (err) {
        push(
          answerFrom(ask, target, {
            outcome: outcomeFor(err),
            durationMs: Math.round(performance.now() - started),
            errorName: errorNameOf(err),
            errorMessage: errorMessageOf(err),
            blamedConstraint: blamedConstraint(err),
            settingsBefore: before,
            notes: [`The track's readyState at the moment of the ask was "${liveTrack.readyState}".`],
          })
        );
      }
    }
  }

  stopStream(liveStream);

  for (const [index, ask] of twiceAsks.entries()) {
    if (await halt(twiceAsks.slice(index))) return answers;
    options.onProgress?.(`${target.label} — ${ask.asked}`);
    const started = performance.now();
    const [first, second] = await Promise.allSettled([
      openMediaWithDeadline({ audio: false, video: ask.constraints }, { what: `${target.label} (first of two at once)`, onLate: options.onLate }),
      openMediaWithDeadline({ audio: false, video: ask.constraints }, { what: `${target.label} (second of two at once)`, onLate: options.onLate }),
    ]);
    const durationMs = Math.round(performance.now() - started);
    const streams = [first, second].map((result) => (result.status === "fulfilled" ? result.value : null));
    const tracks = streams.map((stream) => stream?.getVideoTracks()[0] ?? null);
    const notes: string[] = [];
    if (first.status === "fulfilled" && second.status === "fulfilled") {
      const sameTrack = tracks[0] != null && tracks[1] != null && tracks[0].id === tracks[1].id;
      notes.push(
        sameTrack
          ? "Both requests came back with the SAME track id, so the platform handed one camera to both callers rather than opening it twice."
          : "Both requests came back with DIFFERENT track ids, so the platform opened the camera twice over and both callers hold their own."
      );
      const settingsA = shortSettings(verbatim(tracks[0]?.getSettings?.() ?? null));
      const settingsB = shortSettings(verbatim(tracks[1]?.getSettings?.() ?? null));
      if (settingsA !== settingsB) notes.push(`The two tracks do not describe themselves the same way: "${settingsA ?? "none"}" against "${settingsB ?? "none"}".`);
      push(
        answerFrom(ask, target, {
          outcome: "granted",
          durationMs,
          grantedSettings: verbatim(tracks[0]?.getSettings?.() ?? null),
          granted: settingsA,
          notes,
        })
      );
    } else {
      const failure = first.status === "rejected" ? first.reason : second.status === "rejected" ? second.reason : null;
      const bothFailed = first.status === "rejected" && second.status === "rejected";
      notes.push(
        bothFailed
          ? "Neither request succeeded, so this platform would not open the camera at all while another request for it was in flight."
          : "One of the two succeeded and the other did not, which is the platform serialising access rather than sharing it."
      );
      push(
        answerFrom(ask, target, {
          outcome: outcomeFor(failure),
          durationMs,
          errorName: errorNameOf(failure),
          errorMessage: errorMessageOf(failure),
          blamedConstraint: blamedConstraint(failure),
          notes,
        })
      );
    }
    for (const stream of streams) stopStream(stream);
  }

  return answers;
}

/* ------------------------------------------------------------------ *
 * Where the answers disagree with each other
 * ------------------------------------------------------------------ */

function byId(answers: ImpossibleAnswer[], askId: string, deviceLabel: string): ImpossibleAnswer | null {
  return answers.find((answer) => answer.askId === askId && answer.deviceLabel === deviceLabel) ?? null;
}

/**
 * Lines up the answers against each other and names the places they disagree.
 *
 * Every entry is an observation of something that WAS seen, phrased as such.
 * None of them is a verdict, a score or an accusation, and none of them says a
 * device is or is not what it claims to be — that is not a judgement this app
 * makes anywhere.
 */
export function impossibleObservations(answers: ImpossibleAnswer[]): string[] {
  const observations: string[] = [];
  const devices = Array.from(new Set(answers.map((answer) => answer.deviceLabel)));

  for (const device of devices) {
    const here = answers.filter((answer) => answer.deviceLabel === device);

    for (const answer of here) {
      const twin = answer.askId === "repeat-size-absurd" ? byId(answers, "size-absurd", device) : null;
      if (!twin) continue;
      if (twin.errorName !== answer.errorName || twin.blamedConstraint !== answer.blamedConstraint) {
        observations.push(
          `${device}: the same impossible size was refused two different ways on two consecutive attempts — first "${twin.errorName ?? twin.outcome}"${twin.blamedConstraint ? ` blaming ${twin.blamedConstraint}` : ""}, then "${answer.errorName ?? answer.outcome}"${answer.blamedConstraint ? ` blaming ${answer.blamedConstraint}` : ""}. Nothing about the request changed between them.`
        );
      } else if (twin.durationMs > 0 && (answer.durationMs > twin.durationMs * 4 + 50 || twin.durationMs > answer.durationMs * 4 + 50)) {
        observations.push(
          `${device}: the same impossible size was refused identically twice, but the two answers took very different lengths of time — ${twin.durationMs} ms and then ${answer.durationMs} ms. The refusal is stable; the timing is not.`
        );
      }
    }

    const exact = byId(here, "synonym-exact", device);
    const range = byId(here, "synonym-min-max", device);
    if (exact && range && (exact.outcome !== range.outcome || exact.errorName !== range.errorName)) {
      observations.push(
        `${device}: 640 wide written as an exact value and 640 wide written as a range from 640 to 640 mean the same thing, and this platform answered them differently — "${exact.outcome}" against "${range.outcome}".`
      );
    }

    for (const answer of here) {
      if (answer.outcome !== "granted") continue;
      if (answer.family === "impossible-size" || answer.family === "impossible-rate" || answer.family === "contradiction") {
        observations.push(`${device}: an impossible request was granted rather than refused — ${answer.asked}. What came back was ${answer.granted ?? "a track that reported no settings"}.`);
      }
      if (answer.family === "phantom-device") {
        observations.push(`${device}: a camera id belonging to nothing was accepted, and a camera opened anyway — ${answer.granted ?? "with no settings reported"}. An exact device request was treated as a preference rather than an instruction.`);
      }
      if (answer.askId === "live-size-impossible" && answer.changedLiveTrack === true) {
        observations.push(`${device}: a change that could not be satisfied was accepted by a running camera AND the running camera's settings moved — from "${shortSettings(answer.settingsBefore) ?? "unknown"}" to "${answer.granted ?? "unknown"}".`);
      }
      if (answer.family === "beyond-control" && answer.changedLiveTrack === false) {
        observations.push(`${device}: a control was pushed past its published limit, the platform reported success, and the camera's settings did not move — ${answer.asked}.`);
      }
      if (answer.askId === "live-torch-unclaimed") {
        observations.push(`${device}: the flash was switched on for a camera whose own capability list contains no flash at all.`);
      }
    }

    for (const answer of here) {
      if (answer.family === "invented-key" && answer.outcome === "refused") {
        observations.push(
          `${device}: a request carrying setting names that do not exist was refused (${answer.errorName ?? "no error name"}${answer.blamedConstraint ? `, blaming ${answer.blamedConstraint}` : ""}). Unrecognised settings are supposed to be ignored, so this platform is checking names against a list.`
        );
      }
      if (answer.askId === "live-size-impossible" && answer.outcome === "refused" && answer.changedLiveTrack === true) {
        observations.push(
          `${device}: a change to a running camera was refused and the camera's settings moved anyway — from "${shortSettings(answer.settingsBefore) ?? "unknown"}" to "${shortSettings(answer.grantedSettings) ?? "unknown"}". A failed change is supposed to leave the picture exactly as it was.`
        );
      }
      if (answer.family === "recovery" && answer.outcome !== "granted") {
        observations.push(
          `${device}: the ordinary request sent straight after the impossible ones did not succeed (${answer.errorName ?? answer.outcome}). Every answer above it on this camera came from a pipeline that was in this state by the end of the round, which is worth knowing before reading them as clean results.`
        );
      }
    }
  }

  const grouped = new Map<string, ImpossibleAnswer[]>();
  for (const answer of answers) {
    const list = grouped.get(answer.askId) ?? [];
    list.push(answer);
    grouped.set(answer.askId, list);
  }
  for (const [askId, list] of grouped) {
    if (list.length < 2 || askId === "recovery-plain") continue;
    const shapes = Array.from(new Set(list.map((answer) => `${answer.outcome}/${answer.errorName ?? "-"}/${answer.blamedConstraint ?? "-"}`)));
    if (shapes.length > 1) {
      observations.push(
        `The same ask was answered differently by different cameras on this one phone — "${list[0].asked}" produced ${shapes.length} different answers: ${list.map((answer) => `${answer.deviceLabel} → ${answer.outcome}${answer.errorName ? ` (${answer.errorName})` : ""}`).join("; ")}.`
      );
    }
  }

  return observations;
}

/* ------------------------------------------------------------------ *
 * The standalone mode
 * ------------------------------------------------------------------ */

export type ImpossibleProbeOptions = {
  scope?: AskScope;
  onProgress?: (message: string, done: number, total: number) => void;
  shouldAbort?: () => boolean;
  waitWhilePaused?: () => Promise<void>;
};

/** The two sides the standalone mode interrogates, in order. */
export const PROBE_SIDES: { facing: "environment" | "user"; label: string }[] = [
  { facing: "environment", label: "Back camera" },
  { facing: "user", label: "Front camera" },
];

/**
 * The impossible round on its own, with no sweep around it.
 *
 * One plain open per side first — which is what earns the camera permission and
 * reads the capability list the "beyond its stated limits" asks are measured
 * against — then the battery. No permission sweep, no sensors, no shots by
 * hand, and no photograph anywhere.
 */
export async function runImpossibleProbe(options: ImpossibleProbeOptions = {}): Promise<ImpossibleReport> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const answers: ImpossibleAnswer[] = [];
  const notes: string[] = [];
  const scope = options.scope ?? "full";
  const askedOnce = new Set<string>();
  let aborted = false;

  if (!navigator.mediaDevices?.getUserMedia) {
    notes.push("This browser exposes no navigator.mediaDevices.getUserMedia, so no camera could be asked anything. Nothing below is a refusal — the API is simply absent.");
    return { startedAt, finishedAt: new Date().toISOString(), durationMs: 0, scope, answers, observations: [], aborted, notes };
  }

  const perSide = impossibleAsksFor({ deviceId: null, facingMode: "environment", label: "x", capabilities: null }, scope).length + 1;
  const total = Math.max(1, perSide * PROBE_SIDES.length);
  let done = 0;

  for (const side of PROBE_SIDES) {
    await options.waitWhilePaused?.();
    if (options.shouldAbort?.()) {
      aborted = true;
      break;
    }
    done += 1;
    options.onProgress?.(`${side.label} — opening it once, plainly, to read what it says about itself`, done, total);

    let capabilities: MediaTrackCapabilities | null = null;
    let deviceId: string | null = null;
    try {
      const stream = await openMediaWithDeadline({ audio: false, video: { facingMode: { ideal: side.facing } } }, { what: `${side.label} (the plain open this round is measured against)` });
      const track = stream.getVideoTracks()[0] ?? null;
      try {
        capabilities = track?.getCapabilities?.() ?? null;
      } catch {
        capabilities = null;
      }
      const settings = track?.getSettings?.() ?? null;
      deviceId = typeof settings?.deviceId === "string" ? settings.deviceId : null;
      stopStream(stream);
    } catch (err) {
      notes.push(
        `${side.label}: the plain open that begins this round did not succeed (${errorNameOf(err)}: ${errorMessageOf(err)}). The battery was still sent, pinned by side rather than by camera id, and the asks that are measured against a camera's own published limits had nothing to measure against — each of those says so on its own row.`
      );
    }

    const target: ImpossibleTarget = { deviceId, facingMode: side.facing, label: side.label, capabilities };
    const roundAnswers = await runImpossibleRound(target, {
      scope,
      askedOnce,
      shouldAbort: options.shouldAbort,
      waitWhilePaused: options.waitWhilePaused,
      onNote: (note) => notes.push(note),
      onUntried: (untried, reason) => notes.push(`${side.label}: ${untried.length} ask(s) were left untried. ${reason}`),
      onProgress: (message) => {
        done += 1;
        options.onProgress?.(message, Math.min(done, total), total);
      },
    });
    answers.push(...roundAnswers);
    if (options.shouldAbort?.()) {
      aborted = true;
      break;
    }
  }

  if (aborted) notes.push("You stopped this run before it finished. Every answer above really happened; the asks that never ran are simply absent, and none of them is recorded as a refusal.");

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    scope,
    answers,
    observations: impossibleObservations(answers),
    aborted,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const OUTCOME_TAG: Record<AskOutcome, string> = {
  refused: "[REFUSED      ]",
  granted: "[GRANTED      ]",
  "rejected-value": "[VALUE REJECTED]",
  "timed-out": "[TIMED OUT    ]",
  "not-attempted": "[NOT ATTEMPTED]",
};

/** The readable record of the impossible round, for the archive. */
export function impossibleText(answers: ImpossibleAnswer[], observations: string[], notes: string[] = []): string {
  const lines: string[] = ["THE IMPOSSIBLE ASKS", "=".repeat(78), "", IMPOSSIBLE_POLICY, ""];

  if (answers.length === 0) {
    lines.push("No impossible ask was sent in this run. Nothing here is a refusal; the round simply did not run.", "");
    if (notes.length > 0) lines.push("NOTES", "-".repeat(78), ...notes.map((note) => `  - ${note}`));
    return lines.join("\n");
  }

  const devices = Array.from(new Set(answers.map((answer) => answer.deviceLabel)));
  for (const device of devices) {
    const here = answers.filter((answer) => answer.deviceLabel === device);
    const refused = here.filter((answer) => answer.outcome === "refused").length;
    const granted = here.filter((answer) => answer.outcome === "granted").length;
    lines.push("", "=".repeat(78), `${device} — ${here.length} impossible ask(s): ${refused} refused, ${granted} granted`, "=".repeat(78));
    let family: AskFamily | null = null;
    for (const answer of here) {
      if (answer.family !== family) {
        family = answer.family;
        lines.push("", `  ${FAMILY_LABEL[family].toUpperCase()}`, `  ${"-".repeat(74)}`);
      }
      lines.push(
        "",
        `  ${OUTCOME_TAG[answer.outcome]} ${answer.asked}`,
        `      took       ${answer.durationMs} ms`,
        `      answer     ${answer.errorName ?? (answer.granted ?? "no error and no settings were reported")}`
      );
      if (answer.errorMessage) lines.push(`      message    ${answer.errorMessage}`);
      if (answer.blamedConstraint) lines.push(`      blamed     ${answer.blamedConstraint}`);
      if (answer.settingsBefore) lines.push(`      before     ${shortSettings(answer.settingsBefore) ?? "(none)"}`);
      if (answer.grantedSettings) lines.push(`      after      ${shortSettings(answer.grantedSettings) ?? "(none)"}`);
      if (answer.changedLiveTrack != null) lines.push(`      moved      ${answer.changedLiveTrack ? "yes — the running camera's settings changed" : "no — the running camera's settings are unchanged"}`);
      lines.push(...wrapInto("      expected   ", answer.expectation), ...wrapInto("      reading    ", answer.reading));
      for (const note of answer.notes) lines.push(...wrapInto("      note       ", note));
    }
  }

  lines.push("", "", "=".repeat(78), `WHERE THE ANSWERS DISAGREE WITH EACH OTHER (${observations.length})`, "=".repeat(78), "");
  if (observations.length === 0) {
    lines.push("Nothing in this round contradicted anything else in it. Every refusal was consistent with every other", "refusal, and no published limit was exceeded. That is an observation, not a pass mark.", "");
  } else {
    lines.push(
      "Each line below is something that WAS seen, set beside something else that was also seen. They are",
      "observations and nothing more: Deep Probe reaches no verdict, scores nothing and accuses nobody.",
      ""
    );
    for (const observation of observations) lines.push(...wrapInto("  · ", observation), "");
  }

  if (notes.length > 0) lines.push("", "NOTES", "-".repeat(78), ...notes.flatMap((note) => wrapInto("  - ", note)));
  return lines.join("\n");
}

function wrapInto(prefix: string, text: string): string[] {
  const width = 78 - prefix.length;
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.map((entry, index) => (index === 0 ? `${prefix}${entry}` : `${" ".repeat(prefix.length)}${entry}`));
}
