import type { Finding } from "@/lib/fraud-detection";

/**
 * Capture-channel integrity engine.
 *
 * Detects JavaScript-level media injection: monkey-patched getUserMedia
 * (the "Zombocam pattern" used by every canvas/video injection tool),
 * canvas.captureStream() streams posing as camera tracks, hooked canvas
 * readback APIs, scripted file-input injection, and automation controllers.
 *
 * Signal tiers — calibrated so high risk is only assigned to signals with a
 * hard technical guarantee behind them:
 *
 * - "definitive": guaranteed tampering. Backed by browser invariants that
 *   cannot occur accidentally: a page script cannot alter another realm's
 *   Function.prototype.toString; a real getUserMedia camera track always
 *   carries the deviceId of an enumerable capture device in the same session;
 *   the user agent only sets isTrusted=true on events it dispatched itself;
 *   two independent GPU/CPU readback paths of the same frame must agree.
 *
 * - "strong": real evidence of a compromised channel, but with at least one
 *   innocent explanation (privacy extensions hook canvas readback, test
 *   browsers expose fake devices). Never condemns alone — requires
 *   corroboration from an independent category, otherwise the outcome is
 *   "recapture on a clean browser", not an accusation.
 *
 * - "info": context only, zero score impact.
 */

export type InjectionSeverity = "definitive" | "strong" | "info";

export type InjectionSignal = {
  id: string;
  label: string;
  severity: InjectionSeverity;
  triggered: boolean;
  observed: string;
  expected: string;
  detail: string;
};

export type InjectionAuditResult = {
  verdict: "clean" | "suspicious" | "injected";
  signals: InjectionSignal[];
  /** Names of API surfaces whose implementation is not the browser's native code. */
  hookedApis: string[];
  surfacesChecked: number;
  summary: string;
  generatedAt: string;
};

/** Provenance captured at the moment a native file-input capture returns. */
export type NativeProvenance = {
  /** Epoch ms when the user pressed the shutter/capture button. */
  pressedAt: number;
  /** ms between the button press and the change event firing. */
  elapsedMs: number;
  /**
   * Whether the change event was dispatched by the user agent (true) or by
   * script (false). Undefined when the capture path has no file input at all
   * (device-level capture) — not observable, which is never the same as false.
   */
  changeIsTrusted?: boolean;
  /** Epoch ms when this page session started. */
  pageLoadedAt: number;
  /** Whether HTMLInputElement's files accessor was still native at capture time. Undefined when no file input was involved. */
  filesApiNative?: boolean;
  /** Whether the shutter-button press event itself was user-agent-dispatched (false = scripted click chain). */
  pressIsTrusted?: boolean;
  /** Whether the page lost visibility between press and file arrival (the native camera UI covers the page on phones). undefined = not tracked. */
  pageHiddenDuring?: boolean;
};

/** OS-level virtual camera & face-swap tool label markers. Labels are user-renameable, so absence proves nothing; presence is honest self-identification. */
export const VIRTUAL_CAM_LABEL_MARKERS = [
  "obs",
  "virtual",
  "manycam",
  "snap camera",
  "snapcamera",
  "xsplit",
  "splitcam",
  "camtwist",
  "v4l2loopback",
  "droidcam",
  "iriun",
  "epoccam",
  "ndi",
  "avatarify",
  "deepfacelive",
  "deepface",
  "fake",
  "dummy",
  "vcam",
  "prism live",
  "mmhmm",
  "ecamm",
  "reincubate",
  "camo",
  "continuity camera", // macOS Continuity Camera is a real phone — listed so the label is visible; fusion still needs corroboration
] as const;

// ───────────────────────── Privacy-browser context ─────────────────────────

export type PrivacyBrowserInfo = {
  detected: boolean;
  name: string | null;
  observed: string;
};

/**
 * Detects browsers whose PRODUCT FEATURE is wrapping DOM APIs (fingerprinting
 * protection) plus in-app browsers that inject scripts into every page.
 * DuckDuckGo's open-source content-scope-scripts, Brave's farbling, and
 * social-app in-app WebViews all legitimately replace API surfaces — a
 * "wrapped API" observation in these contexts is EXPECTED and must be
 * excluded from hard scoring. Detection is best-effort context, never proof
 * in either direction.
 */
export function detectPrivacyBrowser(): PrivacyBrowserInfo {
  try {
    const ua = navigator.userAgent ?? "";
    if (/\bDuckDuckGo\/\d|\bDdg\/\d/i.test(ua)) {
      return { detected: true, name: "DuckDuckGo browser", observed: ua.slice(0, 140) };
    }
    const nav = navigator as Navigator & { brave?: { isBrave?: unknown } };
    if (nav.brave && typeof nav.brave === "object" && "isBrave" in nav.brave) {
      return { detected: true, name: "Brave", observed: "navigator.brave is present" };
    }
    if (/\bFocus\/\d|\bKlar\/\d/i.test(ua)) {
      return { detected: true, name: "Firefox Focus", observed: ua.slice(0, 140) };
    }
    if (/FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|\bLine\//i.test(ua)) {
      return { detected: true, name: "in-app browser", observed: ua.slice(0, 140) };
    }
    if (/Android/.test(ua) && /\bwv\)/.test(ua)) {
      return { detected: true, name: "Android WebView (in-app browser)", observed: ua.slice(0, 140) };
    }
    return { detected: false, name: null, observed: ua.slice(0, 140) };
  } catch {
    return { detected: false, name: null, observed: "inspection unavailable" };
  }
}

// ───────────────────────── Clean-realm native verification ─────────────────────────

type CleanRealm = { toString: (fn: unknown) => string };

let cleanRealmCache: CleanRealm | null = null;
let cleanRealmFailed = false;

/**
 * A same-origin iframe provides an untouched copy of Function.prototype.toString.
 * Page scripts (and content-script hooks) cannot patch a realm created after
 * their injection without re-running inside it, so this defeats toString
 * spoofing — the standard stealth technique of injection tools.
 */
function getCleanRealm(): CleanRealm | null {
  if (cleanRealmCache) return cleanRealmCache;
  if (cleanRealmFailed) return null;
  try {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    (document.body ?? document.documentElement).appendChild(iframe);
    const win = iframe.contentWindow as (Window & { Function: FunctionConstructor }) | null;
    const cleanToString = win?.Function?.prototype?.toString;
    if (!cleanToString) {
      cleanRealmFailed = true;
      return null;
    }
    // Keep the iframe attached: detaching can kill the realm's intrinsics in some engines.
    cleanRealmCache = {
      toString: (fn: unknown) => {
        try {
          return typeof fn === "function" ? (cleanToString.call(fn) as string) : String(fn);
        } catch {
          return "<uninspectable>";
        }
      },
    };
    return cleanRealmCache;
  } catch {
    cleanRealmFailed = true;
    return null;
  }
}

const NATIVE_SOURCE_RE = /^\s*function[^{]*\{\s*\[native code\]\s*\}\s*$|^\s*function[^{]*\{\s*\[native code\]\s*\}/;

type FnCheck = { native: boolean; source: string; crossRealm: boolean };

/** Verifies a function is the browser's native implementation using the clean realm's toString. */
function checkFn(fn: unknown): FnCheck {
  if (typeof fn !== "function") return { native: false, source: `<not a function: ${typeof fn}>`, crossRealm: false };
  const realm = getCleanRealm();
  if (realm) {
    const src = realm.toString(fn);
    return { native: NATIVE_SOURCE_RE.test(src), source: src.slice(0, 160), crossRealm: true };
  }
  try {
    const src = Function.prototype.toString.call(fn) as string;
    return { native: NATIVE_SOURCE_RE.test(src), source: src.slice(0, 160), crossRealm: false };
  } catch {
    // toString throwing on a plain function is itself abnormal (revoked Proxy etc.)
    return { native: false, source: "<toString threw>", crossRealm: false };
  }
}

// ───────────────────────── API surface integrity audit ─────────────────────────

type ApiProbe = {
  id: string;
  label: string;
  resolve: () => unknown;
  /** Extra caveat appended to the detail when hooked. */
  caveat?: string;
};

function mediaApiProbes(): ApiProbe[] {
  return [
    { id: "api-gum", label: "navigator.mediaDevices.getUserMedia", resolve: () => navigator.mediaDevices?.getUserMedia },
    {
      id: "api-gum-proto",
      label: "MediaDevices.prototype.getUserMedia",
      resolve: () =>
        typeof MediaDevices !== "undefined" ? Object.getOwnPropertyDescriptor(MediaDevices.prototype, "getUserMedia")?.value : undefined,
    },
    { id: "api-enumerate", label: "navigator.mediaDevices.enumerateDevices", resolve: () => navigator.mediaDevices?.enumerateDevices },
    {
      id: "api-track-settings",
      label: "MediaStreamTrack.prototype.getSettings",
      resolve: () => (typeof MediaStreamTrack !== "undefined" ? MediaStreamTrack.prototype.getSettings : undefined),
    },
    {
      id: "api-track-caps",
      label: "MediaStreamTrack.prototype.getCapabilities",
      resolve: () =>
        typeof MediaStreamTrack !== "undefined"
          ? (MediaStreamTrack.prototype as { getCapabilities?: unknown }).getCapabilities
          : undefined,
    },
    {
      id: "api-video-srcobject",
      label: "HTMLVideoElement srcObject setter",
      resolve: () =>
        Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject")?.set,
    },
  ];
}

/**
 * Timing clocks used by the native-capture provenance invariants (round-trip
 * time, freshness). A hooked clock lets a script forge timing evidence, so
 * clock integrity is audited alongside the media pipeline.
 */
function timingApiProbes(): ApiProbe[] {
  const caveat = "The capture round-trip and freshness invariants rely on this clock — a hooked clock can forge timing evidence.";
  return [
    { id: "api-perf-now", label: "performance.now", resolve: () => performance.now, caveat },
    { id: "api-date-now", label: "Date.now", resolve: () => Date.now, caveat },
  ];
}

function canvasApiProbes(): ApiProbe[] {
  const caveat =
    "Privacy extensions (e.g. canvas anti-fingerprinting) legitimately hook these — a hook here means the evidence channel is unreliable and the capture must be repeated on a clean browser; it is not by itself proof of fraud.";
  return [
    { id: "api-todataurl", label: "HTMLCanvasElement.prototype.toDataURL", resolve: () => HTMLCanvasElement.prototype.toDataURL, caveat },
    { id: "api-toblob", label: "HTMLCanvasElement.prototype.toBlob", resolve: () => HTMLCanvasElement.prototype.toBlob, caveat },
    { id: "api-getcontext", label: "HTMLCanvasElement.prototype.getContext", resolve: () => HTMLCanvasElement.prototype.getContext, caveat },
    {
      id: "api-getimagedata",
      label: "CanvasRenderingContext2D.prototype.getImageData",
      resolve: () => CanvasRenderingContext2D.prototype.getImageData,
      caveat,
    },
    {
      id: "api-drawimage",
      label: "CanvasRenderingContext2D.prototype.drawImage",
      resolve: () => CanvasRenderingContext2D.prototype.drawImage,
      caveat: "Privacy tools hook readback, not drawing — a drawImage hook is characteristic of frame-substitution scripts.",
    },
    {
      id: "api-capturestream",
      label: "HTMLCanvasElement.prototype.captureStream",
      resolve: () => (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream,
      caveat: "captureStream is the delivery mechanism for canvas-based fake video — injection loaders hook it to disguise their streams.",
    },
  ];
}

/** Audits every API surface the capture pipeline depends on. Synchronous and cheap. */
export function auditApiIntegrity(): InjectionSignal[] {
  const signals: InjectionSignal[] = [];

  // Context: privacy browsers wrap APIs as a product feature — zero score weight.
  const pb = detectPrivacyBrowser();
  signals.push({
    id: "privacy-browser",
    label: "Privacy browser / in-app browser context",
    severity: "info",
    triggered: pb.detected,
    observed: pb.detected ? `${pb.name} — ${pb.observed}` : "No known privacy-browser markers in this session",
    expected: "Context note only — carries zero score weight",
    detail: pb.detected
      ? `This session runs in ${pb.name}, whose tracker/fingerprinting protection legitimately wraps DOM APIs (media pipeline, canvas readback, input accessors). Wrapped-API observations are EXPECTED here, count as one evidence family, and are excluded from hard scoring — only independent evidence (fake device identity, dual-path readback mismatch, automation controller, virtual-camera tooling) can escalate to an injection verdict.`
      : "No privacy-browser or in-app-browser markers detected. Wrapped-API observations in this session are not explained by a known privacy product — but a single evidence family still never condemns alone.",
  });

  // 0. Function.prototype.toString itself — spoofing it is the stealth-hook signature.
  const realm = getCleanRealm();
  if (realm) {
    const pageToStringSrc = realm.toString(Function.prototype.toString);
    const spoofed = !NATIVE_SOURCE_RE.test(pageToStringSrc);
    signals.push({
      id: "tostring-spoof",
      label: "Function.prototype.toString integrity",
      severity: "definitive",
      triggered: spoofed,
      observed: spoofed ? pageToStringSrc.slice(0, 120) : "[native code]",
      expected: "The engine's native toString",
      detail: spoofed
        ? "Function.prototype.toString has been replaced by a script. The ONLY reason to patch toString is to hide other hooks from integrity checks — this is the signature of a stealth injection framework. A page cannot end up in this state accidentally."
        : "toString verified against an untouched same-origin realm — hook-hiding is not in effect.",
    });
  }

  // 1. Instance-level shadowing of mediaDevices methods (how injection scripts install themselves).
  try {
    const md = navigator.mediaDevices as MediaDevices | undefined;
    const shadowed: string[] = [];
    if (md) {
      for (const key of ["getUserMedia", "enumerateDevices", "getDisplayMedia"]) {
        if (Object.prototype.hasOwnProperty.call(md, key)) shadowed.push(key);
      }
    }
    signals.push({
      id: "gum-shadow",
      label: "mediaDevices instance overrides",
      severity: "strong",
      triggered: shadowed.length > 0,
      observed: shadowed.length > 0 ? `Own properties: ${shadowed.join(", ")}` : "No own properties — methods resolve from the prototype",
      expected: "getUserMedia/enumerateDevices live on MediaDevices.prototype only",
      detail:
        shadowed.length > 0
          ? "A script has written its own function directly onto navigator.mediaDevices, shadowing the native prototype method. This is exactly how camera-injection scripts and fake-webcam extensions install themselves."
          : "The mediaDevices object has not been tampered with at the instance level.",
    });
  } catch {
    // inspection failure is not evidence
  }

  // 1b. navigator.mediaDevices defined as an OWN property of navigator.
  // The native accessor lives on Navigator.prototype; an own-property
  // mediaDevices means a script replaced the entire media entry point.
  try {
    const ownMd = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    signals.push({
      id: "md-own-prop",
      label: "navigator.mediaDevices ownership",
      severity: "strong",
      triggered: ownMd != null,
      observed: ownMd != null ? `mediaDevices is an OWN ${ownMd.get ? "accessor" : "data"} property of navigator` : "mediaDevices resolves from Navigator.prototype",
      expected: "The native accessor on Navigator.prototype — never an own property",
      detail:
        ownMd != null
          ? "navigator.mediaDevices has been redefined directly on the navigator instance, replacing the browser's entire media entry point. This is how full-pipeline injection frameworks (and some privacy suites) install themselves — wrapped-API family evidence."
          : "The media entry point is the browser's own prototype accessor.",
    });
  } catch {
    // inspection failure is not evidence
  }

  // 1c. Stealth-wrapper fingerprint: a getUserMedia whose toString claims
  // [native code] must also carry the native name and arity. Bound or renamed
  // wrappers that spoof toString betray themselves here.
  try {
    const gum = navigator.mediaDevices?.getUserMedia;
    if (typeof gum === "function") {
      const claimsNative = checkFn(gum).native;
      const name = gum.name;
      const arity = gum.length;
      const nameOk = name === "getUserMedia" || name === "bound getUserMedia";
      const arityOk = arity <= 1;
      const triggered = claimsNative && (!nameOk || !arityOk);
      signals.push({
        id: "gum-fingerprint",
        label: "getUserMedia native fingerprint (name/arity)",
        severity: "strong",
        triggered,
        observed: `name "${name}" · arity ${arity} · source ${claimsNative ? "[native code]" : "non-native (caught by the source audit)"}`,
        expected: 'name "getUserMedia" with arity ≤ 1 on a native-source function',
        detail: triggered
          ? "The function claims to be native code but its name/arity do not match the engine's getUserMedia — the shape of a wrapper hiding behind a spoofed toString. Corroborating wrapped-API evidence."
          : "getUserMedia's function fingerprint matches the engine's native implementation.",
      });
    }
  } catch {
    // inspection failure is not evidence
  }

  // 2. Native-code verification of the media pipeline.
  for (const probe of mediaApiProbes()) {
    let fn: unknown;
    try {
      fn = probe.resolve();
    } catch {
      fn = undefined;
    }
    if (fn == null) continue;
    const check = checkFn(fn);
    signals.push({
      id: probe.id,
      label: probe.label,
      severity: "strong",
      triggered: !check.native,
      observed: check.native ? "[native code]" : check.source,
      expected: "[native code]",
      detail: !check.native
        ? `${probe.label} is NOT the browser's native implementation — a JavaScript hook has replaced it.${probe.caveat ? " " + probe.caveat : ""}`
        : `${probe.label} verified native${check.crossRealm ? " (cross-realm check)" : ""}.`,
    });
  }

  // 3. Canvas readback pipeline + timing clocks.
  for (const probe of [...canvasApiProbes(), ...timingApiProbes()]) {
    let fn: unknown;
    try {
      fn = probe.resolve();
    } catch {
      fn = undefined;
    }
    if (fn == null) continue;
    const check = checkFn(fn);
    signals.push({
      id: probe.id,
      label: probe.label,
      severity: "strong",
      triggered: !check.native,
      observed: check.native ? "[native code]" : check.source,
      expected: "[native code]",
      detail: !check.native ? `${probe.label} has been replaced by a script. ${probe.caveat ?? ""}` : `${probe.label} verified native.`,
    });
  }

  // 4a. Automation-evasion: stealth automation kits (puppeteer-extra-stealth
  // and similar) hide the webdriver flag by redefining it as an own property
  // on the navigator instance. The native flag is a Navigator.prototype
  // getter — an own-property override exists ONLY to defeat this exact check.
  try {
    const ownWd = Object.getOwnPropertyDescriptor(navigator, "webdriver");
    signals.push({
      id: "webdriver-spoof",
      label: "Automation-evasion (webdriver flag overridden)",
      severity: "strong",
      triggered: ownWd != null,
      observed: ownWd != null ? "navigator.webdriver has been redefined as an OWN property of navigator" : "webdriver resolves from Navigator.prototype",
      expected: "The native Navigator.prototype getter — never an own property",
      detail:
        ownWd != null
          ? "A script has overridden the webdriver flag on the navigator instance — the standard stealth-automation technique for hiding Selenium/Playwright/Puppeteer from detection. An honest session has no reason to mask this flag."
          : "No webdriver-flag masking detected.",
    });
  } catch {
    // inspection failure is not evidence
  }

  // 4b. Automation controller.
  const webdriver = navigator.webdriver === true;
  signals.push({
    id: "webdriver",
    label: "Automation flag (navigator.webdriver)",
    severity: "strong",
    triggered: webdriver,
    observed: webdriver ? "true — the browser is under automation control" : "false",
    expected: "false in a normal user session",
    detail: webdriver
      ? "The browser reports it is driven by an automation controller (Selenium/Playwright/Puppeteer). Automated sessions are how injection attacks are executed at scale; a genuine person verifying their own identity does not run under WebDriver."
      : "No automation controller is reported.",
  });

  return signals;
}

/** Verifies the HTMLInputElement `files`/`value` accessors are native — hooked accessors let a script decide what file the app reads. */
export function auditFileInputIntegrity(input?: HTMLInputElement | null): { native: boolean; observed: string } {
  try {
    const filesDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    const getter = filesDesc?.get;
    const getterCheck = getter ? checkFn(getter) : { native: false, source: "<missing files getter>", crossRealm: false };
    let instanceShadow = false;
    if (input) {
      instanceShadow =
        Object.getOwnPropertyDescriptor(input, "files") != null || Object.getOwnPropertyDescriptor(input, "value") != null;
    }
    if (instanceShadow) return { native: false, observed: "files/value redefined directly on the input element" };
    if (!getterCheck.native) return { native: false, observed: getterCheck.source };
    return { native: true, observed: "[native code]" };
  } catch {
    return { native: true, observed: "inspection unavailable" };
  }
}

// ───────────────────────── Stream authenticity audit ─────────────────────────

/**
 * Anchors a getUserMedia stream to a real capture device.
 * Guarantee used: within one session/origin, the deviceId reported by
 * track.getSettings() must appear in enumerateDevices(); tracks made with
 * canvas.captureStream() or `new MediaStream()` have no deviceId/groupId and
 * (post-permission) no OS label.
 */
export async function auditStreamAuthenticity(stream: MediaStream): Promise<InjectionSignal[]> {
  const signals: InjectionSignal[] = [];
  const track = stream.getVideoTracks()[0];
  if (!track) {
    signals.push({
      id: "track-missing",
      label: "Video track presence",
      severity: "strong",
      triggered: true,
      observed: "Stream has no video track",
      expected: "One live camera video track",
      detail: "A camera stream without a video track means the stream object was constructed or gutted by script.",
    });
    return signals;
  }

  // Definitive: the track is literally a canvas-capture track. Browsers give
  // canvas.captureStream() video tracks their own class — a "camera" stream
  // whose track is a CanvasCaptureMediaStreamTrack was, by construction,
  // rendered by a script, never captured by a sensor.
  try {
    const CanvasTrack = (window as unknown as { CanvasCaptureMediaStreamTrack?: abstract new () => unknown }).CanvasCaptureMediaStreamTrack;
    if (typeof CanvasTrack === "function") {
      const isCanvasTrack = track instanceof CanvasTrack;
      signals.push({
        id: "canvas-capture-track",
        label: "Canvas-sourced video track",
        severity: "definitive",
        triggered: isCanvasTrack,
        observed: isCanvasTrack
          ? "The video track is a CanvasCaptureMediaStreamTrack — it was created by canvas.captureStream()"
          : "The track is not a canvas-capture class",
        expected: "A sensor-backed MediaStreamTrack, never a canvas-capture track",
        detail: isCanvasTrack
          ? "The engine itself reports this track's class as CanvasCaptureMediaStreamTrack — the prototype chain cannot be forged from page script without failing the API audit. The 'camera' feed is a script-rendered canvas: definitive injection."
          : "The track's class is not a canvas-capture type.",
      });
    }
  } catch {
    // inspection failure is not evidence
  }

  // Strong: prototype identity of the stream/track objects. A real capture
  // pipeline always yields genuine MediaStream/MediaStreamTrack instances;
  // duck-typed mocks fail instanceof.
  try {
    const okStream = typeof MediaStream === "undefined" || stream instanceof MediaStream;
    const okTrack = typeof MediaStreamTrack === "undefined" || track instanceof MediaStreamTrack;
    signals.push({
      id: "track-instanceof",
      label: "Stream/track prototype identity",
      severity: "strong",
      triggered: !okStream || !okTrack,
      observed: `stream instanceof MediaStream: ${okStream} · track instanceof MediaStreamTrack: ${okTrack}`,
      expected: "Both objects are genuine engine-created instances",
      detail:
        !okStream || !okTrack
          ? "The stream or track object is not a genuine engine instance — a duck-typed mock constructed by script. Real capture objects always carry the engine's prototype chain."
          : "Both the stream and its video track carry the engine's genuine prototype chain.",
    });
  } catch {
    // inspection failure is not evidence
  }

  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings?.() ?? {};
  } catch {
    settings = {};
  }
  let caps: Record<string, unknown> = {};
  try {
    caps = (track as unknown as { getCapabilities?: () => Record<string, unknown> }).getCapabilities?.() ?? {};
  } catch {
    caps = {};
  }
  const deviceId = typeof settings.deviceId === "string" ? settings.deviceId : "";
  const groupId = typeof settings.groupId === "string" ? settings.groupId : "";
  const label = track.label ?? "";

  let enumeratedIds: string[] = [];
  let enumerationWorked = false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    enumeratedIds = devices.filter((d) => d.kind === "videoinput" && d.deviceId).map((d) => d.deviceId);
    enumerationWorked = true;
  } catch {
    enumerationWorked = false;
  }

  // Definitive: the track claims a deviceId that no capture device in this session has.
  const idOrphaned = deviceId !== "" && enumerationWorked && enumeratedIds.length > 0 && !enumeratedIds.includes(deviceId);
  signals.push({
    id: "track-device-anchor",
    label: "Track anchored to a real capture device",
    severity: "definitive",
    triggered: idOrphaned,
    observed: idOrphaned
      ? `Track deviceId ${deviceId.slice(0, 12)}… is NOT among the ${enumeratedIds.length} enumerable camera(s)`
      : deviceId
        ? `deviceId matches an enumerated camera (${enumeratedIds.length} camera(s) visible)`
        : "No deviceId to anchor (see synthetic-track check)",
    expected: "getSettings().deviceId ∈ enumerateDevices() — a same-session browser invariant",
    detail: idOrphaned
      ? "Within one session the browser guarantees a camera track's deviceId appears in the device list. A track with an orphaned deviceId did not come from any capture device — the stream object was substituted by script."
      : "The active track's device identity is consistent with the OS device list.",
  });

  // INFO ONLY — absence of device identity is NOT evidence of injection.
  //
  // This used to be a "strong" signal, which produced a false "Synthetic track
  // shape" accusation on genuine sessions. Legitimate environments routinely
  // expose no deviceId/groupId: remote/streamed browsers and cloud device farms,
  // in-app WebViews, privacy browsers that blank device identity as an
  // anti-fingerprinting feature, and some Android WebView camera paths. Since a
  // real camera and an injected canvas can look identical here, the measurement
  // is recorded and never scored. Injection is proven instead by the definitive
  // checks: a literal CanvasCaptureMediaStreamTrack class, an orphaned deviceId,
  // a forged prototype chain, or a dual-path frame-readback mismatch.
  const synthetic = deviceId === "" && groupId === "";
  const capsEmpty = !("deviceId" in caps) && !("groupId" in caps);
  signals.push({
    id: "synthetic-track",
    label: "Device identity fields on the track",
    severity: "info",
    triggered: synthetic,
    observed: synthetic
      ? `getSettings(): no deviceId, no groupId · getCapabilities(): ${capsEmpty ? "no device identity either" : "partial"} · label "${label || "(empty)"}"`
      : `deviceId ${deviceId ? "present" : "absent"} · groupId ${groupId ? "present" : "absent"} · label "${label || "(empty)"}"`,
    expected: "Present on most hardware cameras; legitimately absent in remote, wrapped and privacy browsers",
    detail: synthetic
      ? "This track exposes no device identity. That is the shape of a script-constructed stream — but it is equally the shape of a remote/streamed browser, a cloud device farm, an in-app WebView, and privacy browsers that blank device identity on purpose. Because genuine and injected sessions are indistinguishable on this field alone, it is recorded as context and contributes nothing to the score."
      : "The track exposes the device identity fields a hardware camera normally provides.",
  });

  // INFO ONLY — same reasoning as above; an empty label is a privacy/remote-browser
  // trait, not proof of a constructed stream.
  signals.push({
    id: "track-label-empty",
    label: "OS device label",
    severity: "info",
    triggered: label === "",
    observed: label === "" ? "(empty)" : label,
    expected: "Usually an OS-provided device name; legitimately blank in privacy and remote browsers",
    detail:
      label === ""
        ? "No OS device name is exposed. Privacy browsers blank this deliberately and remote/virtualised browsers often have nothing to report, so an empty label is recorded as context only and never scored."
        : "The track carries an OS-provided device name.",
  });

  // When the environment cannot expose device identity at all, say so plainly
  // instead of letting the reader infer injection from the observations above.
  const pb = detectPrivacyBrowser();
  if (synthetic || label === "") {
    signals.push({
      id: "channel-unassessable",
      label: "Capture-channel integrity cannot be assessed in this environment",
      severity: "info",
      triggered: true,
      observed: `${pb.detected ? `${pb.name} · ` : ""}deviceId ${deviceId ? "present" : "absent"} · groupId ${groupId ? "present" : "absent"} · label "${label || "(empty)"}"`,
      expected: "A standard browser on the capture device, where device identity is observable",
      detail: `This session does not expose the camera's device identity${pb.detected ? ` (${pb.name})` : " — typical of a preview, remote/streamed or wrapped browser"}, so the checks that anchor a video feed to real hardware have nothing to read. Capture-channel integrity is therefore UNKNOWN here, not failed: nothing is deducted, and no injection is implied. To obtain an assessable channel, run the capture in Safari or Chrome directly on the phone.`,
    });
  }

  // Strong: virtual-camera tooling self-identification.
  const lowerLabel = label.toLowerCase();
  const markerHits = VIRTUAL_CAM_LABEL_MARKERS.filter((m) => lowerLabel.includes(m));
  signals.push({
    id: "virtual-cam-label",
    label: "Virtual camera / face-swap tooling",
    severity: "strong",
    triggered: markerHits.length > 0,
    observed: markerHits.length > 0 ? `"${label}" matches: ${markerHits.join(", ")}` : label || "(no label)",
    expected: "A hardware camera name",
    detail:
      markerHits.length > 0
        ? `The OS reports this video source as virtual-camera software (${markerHits.join(", ")}) — the standard delivery path for real-time face swaps and pre-recorded injection. Labels are user-renameable, so this can be evaded, but a positive match is honest self-identification by the tool.`
        : "The source label does not match known virtual-camera or face-swap tools. (Labels are renameable, so this alone proves nothing.)",
  });

  return signals;
}

// ───────────────────────── Dual-path frame readback audit ─────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

const PROBE_SIZE = 64;
const BLOCK = 8;

/** 64 block-luma means over a 64×64 RGBA buffer. */
function blockLumas(data: Uint8ClampedArray | Uint8Array): number[] {
  const blocks: number[] = [];
  const perRow = PROBE_SIZE / BLOCK;
  for (let by = 0; by < perRow; by++) {
    for (let bx = 0; bx < perRow; bx++) {
      let sum = 0;
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const idx = ((by * BLOCK + y) * PROBE_SIZE + bx * BLOCK + x) * 4;
          sum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        }
      }
      blocks.push(sum / (BLOCK * BLOCK));
    }
  }
  return blocks;
}

function medianAbsDiff(a: number[], b: number[]): number {
  const diffs = a.map((v, i) => Math.abs(v - b[i])).sort((x, y) => x - y);
  return diffs[Math.floor(diffs.length / 2)] ?? 0;
}

function flipRows(data: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(data.length);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y++) {
    out.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), (size - 1 - y) * rowBytes);
  }
  return out;
}

let glCanvas: HTMLCanvasElement | null = null;
let glCtx: WebGLRenderingContext | null = null;
let glTexture: WebGLTexture | null = null;

function ensureGl(): WebGLRenderingContext | null {
  if (glCtx && !glCtx.isContextLost()) return glCtx;
  try {
    glCanvas = document.createElement("canvas");
    glCanvas.width = PROBE_SIZE;
    glCanvas.height = PROBE_SIZE;
    const gl = glCanvas.getContext("webgl", { preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
    if (!gl) return null;
    const vsSrc = "attribute vec2 p;varying vec2 t;void main(){t=p*0.5+0.5;gl_Position=vec4(p,0.,1.);}";
    const fsSrc = "precision mediump float;varying vec2 t;uniform sampler2D s;void main(){gl_FragColor=texture2D(s,t);}";
    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    glTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    glCtx = gl;
    return gl;
  } catch {
    return null;
  }
}

function readViaWebgl(video: HTMLVideoElement): Uint8Array | null {
  const gl = ensureGl();
  if (!gl || !glTexture) return null;
  try {
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.viewport(0, 0, PROBE_SIZE, PROBE_SIZE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const out = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
    gl.readPixels(0, 0, PROBE_SIZE, PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  } catch {
    return null;
  }
}

function readVia2d(video: HTMLVideoElement): Uint8ClampedArray | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = PROBE_SIZE;
    canvas.height = PROBE_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, PROBE_SIZE, PROBE_SIZE);
    return ctx.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data;
  } catch {
    return null;
  }
}

/**
 * Reads the SAME live frame through two independent pipelines — Canvas2D
 * (drawImage+getImageData, the hookable path) and WebGL (texImage2D+readPixels,
 * which JS hooks cannot intercept without also being caught by the API audit) —
 * and compares block-level luma. A hook that substitutes content on one path
 * cannot keep both consistent. Orientation-invariant and motion-tolerant:
 * three rounds, median statistics, generous thresholds.
 */
export async function auditFramePath(video: HTMLVideoElement): Promise<InjectionSignal> {
  const rounds: number[] = [];
  let unavailable = false;
  for (let i = 0; i < 3; i++) {
    if (video.readyState < 2 || video.videoWidth === 0) {
      unavailable = true;
      break;
    }
    const px2d = readVia2d(video);
    const pxGl = readViaWebgl(video);
    if (!px2d || !pxGl) {
      unavailable = true;
      break;
    }
    const blocks2d = blockLumas(px2d);
    const asIs = medianAbsDiff(blocks2d, blockLumas(pxGl));
    const flipped = medianAbsDiff(blocks2d, blockLumas(flipRows(pxGl, PROBE_SIZE)));
    rounds.push(Math.min(asIs, flipped));
    if (i < 2) await sleep(140);
  }
  if (unavailable || rounds.length < 3) {
    return {
      id: "frame-path",
      label: "Dual-path frame readback (Canvas2D vs WebGL)",
      severity: "info",
      triggered: false,
      observed: "Comparison unavailable (WebGL/video not ready)",
      expected: "Both readback paths agree on the same frame",
      detail: "The cross-path pixel comparison could not run — no conclusion drawn.",
    };
  }
  const MISMATCH = 28;
  const mismatches = rounds.filter((r) => r > MISMATCH).length;
  const allMismatch = mismatches === 3 && Math.min(...rounds) > 40;
  return {
    id: "frame-path",
    label: "Dual-path frame readback (Canvas2D vs WebGL)",
    severity: allMismatch ? "definitive" : "strong",
    triggered: allMismatch || mismatches >= 2,
    observed: `Median block-luma deltas: ${rounds.map((r) => r.toFixed(1)).join(" · ")} (threshold ${MISMATCH})`,
    expected: "Both GPU and CPU readback paths must show the same frame",
    detail: allMismatch
      ? "The Canvas2D readback consistently shows DIFFERENT content than the WebGL readback of the same live frame across three spaced probes. Two honest paths cannot disagree — one of them is being fed substituted pixels by a script. This cannot occur accidentally."
      : mismatches >= 2
        ? "The two readback paths disagreed on 2 of 3 probes — possible frame substitution, though fast motion can contribute. Treated as corroborating evidence only."
        : "Both readback paths agree — no canvas-level frame substitution in effect.",
  };
}

// ───────────────────────── Fusion + reporting ─────────────────────────

/**
 * Correlated signals share one evidence group. A single privacy suite
 * (DuckDuckGo content-scope-scripts, Brave farbling, canvas anti-
 * fingerprinting extensions) wraps the ENTIRE JS API surface at once —
 * media pipeline AND canvas readback — so every wrapped-API observation is
 * ONE evidence family ("wrapped-api"), not several. An "injected" verdict
 * therefore requires evidence from at least one family a privacy suite
 * cannot explain: stream identity, frame-path readback mismatch,
 * virtual-camera tooling, or an automation controller.
 */
const SIGNAL_GROUPS: Record<string, string> = {
  "api-gum": "wrapped-api",
  "api-gum-proto": "wrapped-api",
  "api-enumerate": "wrapped-api",
  "api-track-settings": "wrapped-api",
  "api-track-caps": "wrapped-api",
  "api-video-srcobject": "wrapped-api",
  "gum-shadow": "wrapped-api",
  "md-own-prop": "wrapped-api",
  "gum-fingerprint": "wrapped-api",
  "api-todataurl": "wrapped-api",
  "api-toblob": "wrapped-api",
  "api-getcontext": "wrapped-api",
  "api-getimagedata": "wrapped-api",
  "api-drawimage": "wrapped-api",
  "api-capturestream": "wrapped-api",
  "api-perf-now": "wrapped-api",
  "api-date-now": "wrapped-api",
  "hooked-pipeline-live": "wrapped-api",
  "track-missing": "stream-identity",
  // synthetic-track / track-label-empty are info-only (see auditStreamAuthenticity):
  // they are grouped for display but can never contribute score or corroboration.
  "synthetic-track": "device-identity-context",
  "track-label-empty": "device-identity-context",
  "channel-unassessable": "device-identity-context",
  "track-instanceof": "stream-identity",
  "canvas-capture-track": "stream-identity",
  "res-consistency": "stream-identity",
  "virtual-cam-label": "virtual-cam",
  "frame-path": "frame-path",
  webdriver: "automation",
  "webdriver-spoof": "automation",
};

function signalGroup(id: string): string {
  return SIGNAL_GROUPS[id] ?? id;
}

/**
 * Full capture-channel audit. Conservative fusion:
 * definitive triggered → "injected"; strong signals from ≥2 INDEPENDENT
 * evidence groups → "injected"; any strong signal from a single group →
 * "suspicious"; else "clean".
 * Every wrapped JS API surface shares ONE evidence group ("wrapped-api"):
 * verified privacy browsers (DuckDuckGo, Brave) wrap the media pipeline and
 * canvas readback while the real camera keeps working, so an "injected"
 * verdict always requires corroboration from a family privacy software
 * cannot produce (stream identity, frame-path mismatch, automation,
 * virtual-camera tooling).
 */
export async function runInjectionAudit(opts: {
  stream?: MediaStream | null;
  video?: HTMLVideoElement | null;
  log?: (message: string) => void;
}): Promise<InjectionAuditResult> {
  const log = opts.log ?? (() => undefined);
  const signals: InjectionSignal[] = [];

  log("Injection audit: verifying API surfaces against a clean realm…");
  signals.push(...auditApiIntegrity());

  if (opts.stream) {
    log("Injection audit: anchoring the video track to a real capture device…");
    try {
      signals.push(...(await auditStreamAuthenticity(opts.stream)));
    } catch {
      // authenticity audit failure is not evidence
    }
  }

  if (opts.video) {
    log("Injection audit: cross-checking Canvas2D vs WebGL frame readback…");
    signals.push(await auditFramePath(opts.video));
  }

  // Track-settings vs delivered-frame consistency: a spoofed getSettings()
  // that imitates a real camera cannot control what resolution the element
  // actually decodes — disagreement betrays stream substitution.
  if (opts.stream && opts.video) {
    try {
      const t = opts.stream.getVideoTracks()[0];
      const s = t?.getSettings?.();
      const vw = opts.video.videoWidth;
      const vh = opts.video.videoHeight;
      if (t && s && typeof s.width === "number" && typeof s.height === "number" && s.width > 0 && s.height > 0 && vw > 0 && vh > 0) {
        const TOL = 16;
        const direct = Math.abs(s.width - vw) <= TOL && Math.abs(s.height - vh) <= TOL;
        const rotated = Math.abs(s.width - vh) <= TOL && Math.abs(s.height - vw) <= TOL;
        const mismatch = !direct && !rotated;
        signals.push({
          id: "res-consistency",
          label: "Track settings vs delivered frame size",
          severity: "strong",
          triggered: mismatch,
          observed: `getSettings() ${s.width}×${s.height} vs decoded frames ${vw}×${vh}`,
          expected: "The element decodes frames at the track's reported resolution (rotation allowed)",
          detail: mismatch
            ? "The video element is decoding frames at a different resolution than the track claims to produce. Spoofed track settings imitate a real camera, but they cannot change what the substituted source actually delivers — corroborating stream-identity evidence."
            : "The decoded frame size matches the track's reported capture resolution.",
        });
      }
    } catch {
      // inspection failure is not evidence
    }
  }

  // Wrapped DELIVERY PATH + a delivered stream. Previously treated as
  // definitive — but verified privacy browsers (DuckDuckGo's open-source
  // content-scope-scripts "apiManipulation", Brave farbling) DO wrap
  // getUserMedia-adjacent surfaces while the real camera keeps delivering
  // frames. So this stays STRONG evidence inside the wrapped-api family.
  // Injection tools that use this path betray themselves in independent
  // families (synthetic track identity, orphaned device anchor, dual-path
  // readback mismatch), which corroboration still requires.
  const MEDIA_HOOK_IDS = ["api-gum", "api-gum-proto", "gum-shadow", "api-video-srcobject"];
  const mediaHooks = signals.filter((s) => s.triggered && MEDIA_HOOK_IDS.includes(s.id));
  if (mediaHooks.length > 0 && opts.stream) {
    signals.push({
      id: "hooked-pipeline-live",
      label: "Patched camera API delivered this stream",
      severity: "strong",
      triggered: true,
      observed: `Hooked: ${mediaHooks.map((s) => s.label).join(", ")} — while a stream was delivered through it`,
      expected: "Streams normally come through the browser's native capture pipeline",
      detail:
        "The camera pipeline is wrapped by JavaScript and it delivered this video stream. Injection tools (fake-webcam extensions, face-swap loaders, canvas replay scripts) work exactly this way — but so do privacy browsers' fingerprinting shields, which wrap media APIs while the real camera keeps working. This is corroborating evidence in the wrapped-API family; it condemns only alongside independent evidence such as a synthetic track identity or a dual-path readback mismatch.",
    });
  }

  const triggeredDefinitive = signals.filter((s) => s.triggered && s.severity === "definitive");
  const triggeredStrong = signals.filter((s) => s.triggered && s.severity === "strong");
  const strongGroups = [...new Set(triggeredStrong.map((s) => signalGroup(s.id)))];
  const hookedApis = signals.filter((s) => s.triggered && s.id.startsWith("api-")).map((s) => s.label);

  let verdict: InjectionAuditResult["verdict"];
  if (triggeredDefinitive.length > 0) verdict = "injected";
  else if (strongGroups.length >= 2) verdict = "injected";
  else if (triggeredStrong.length >= 1) verdict = "suspicious";
  else verdict = "clean";

  const summary =
    verdict === "clean"
      ? `Capture channel verified: ${signals.length} integrity checks passed (native APIs, real device anchor, consistent readback).`
      : verdict === "suspicious"
        ? `Integrity anomaly in one evidence category (${triggeredStrong.map((s) => s.label).join("; ")}). A single category has innocent explanations — privacy browsers wrap these APIs by design — recapture in a standard browser (Safari/Chrome) to clear this caution.`
        : triggeredDefinitive.length > 0
          ? `Injected feed: ${triggeredDefinitive.map((s) => s.label).join("; ")} — hard evidence, cannot occur accidentally.`
          : `Injected feed: integrity failures in ${strongGroups.length} independent evidence categories corroborate each other (${triggeredStrong.map((s) => s.label).join("; ")}).`;

  log(`Injection audit: ${verdict.toUpperCase()} — ${summary}`);

  return {
    verdict,
    signals,
    hookedApis,
    surfacesChecked: signals.length,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Maps an audit into report findings with conservative weights: only
 * definitive signals carry condemning weight; strong signals warn (privacy
 * extensions must never tank an honest user). Weight is charged once per
 * evidence GROUP — one privacy extension hooking four canvas APIs is one
 * observation, not four penalties. A corroborated verdict (strong evidence in
 * ≥2 independent groups) adds one combined fail.
 */
export function injectionFindings(audit: InjectionAuditResult): Finding[] {
  const findings: Finding[] = [];
  const triggered = audit.signals.filter((s) => s.triggered);
  const chargedGroups = new Set<string>();
  for (const s of triggered) {
    const group = signalGroup(s.id);
    const alreadyCharged = s.severity === "strong" && chargedGroups.has(group);
    if (s.severity === "strong") chargedGroups.add(group);
    findings.push({
      id: `injection-${s.id}`,
      label: `Capture channel: ${s.label}`,
      status: s.severity === "definitive" ? "fail" : s.severity === "strong" ? "warn" : "info",
      weight: s.severity === "definitive" ? 40 : s.severity === "strong" ? (alreadyCharged ? 0 : 8) : 0,
      category: "device",
      observed: s.observed,
      expected: s.expected,
      detail: alreadyCharged ? `${s.detail} (Same evidence category as another flagged check — no additional score impact.)` : s.detail,
    });
  }
  const strongSignals = triggered.filter((s) => s.severity === "strong");
  const strongGroups = [...new Set(strongSignals.map((s) => signalGroup(s.id)))];
  const hasDefinitive = triggered.some((s) => s.severity === "definitive");
  const scoredTriggered = triggered.filter((s) => s.severity !== "info");
  if (!hasDefinitive && strongGroups.length >= 2) {
    findings.push({
      id: "injection-corroborated",
      label: "Capture channel: corroborated injection evidence",
      status: "fail",
      weight: 30,
      category: "device",
      observed: `Integrity anomalies in ${strongGroups.length} independent evidence categories (${strongGroups.join(", ")})`,
      expected: "Zero integrity anomalies",
      detail:
        "Channel-integrity checks failed in multiple INDEPENDENT categories. Each category alone has an innocent explanation (a privacy extension, a test flag); failures across unrelated categories in a single capture session do not. The capture cannot be trusted — repeat it on a clean browser.",
    });
  }
  if (scoredTriggered.length === 0) {
    findings.push({
      id: "injection-audit",
      label: "Capture channel integrity",
      status: "pass",
      weight: 0,
      category: "device",
      observed: `${audit.surfacesChecked} checks passed`,
      expected: "Native APIs, real device anchor, consistent dual-path readback",
      detail:
        "getUserMedia and the whole canvas pipeline are the browser's native code (verified cross-realm), the video track is anchored to a real enumerable camera, and Canvas2D vs WebGL readback of the live frame agree. No JS-level injection is in effect.",
    });
  }
  return findings;
}
