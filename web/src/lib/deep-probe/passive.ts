/**
 * The passive dump — everything a website can read about your device without
 * asking for anything at all.
 *
 * This is the quiet half of the sweep, and arguably the more revealing one:
 * no prompt appears, no indicator lights up, and there is nothing to decline.
 * Collected in one pass and labelled plainly so a reader can see which facts
 * cost a permission and which were simply handed over.
 *
 * Nothing here is a fingerprint *score*. The app reports the readings; drawing
 * conclusions about how identifying they are is left to the reader, because a
 * confident-sounding uniqueness number would be a guess dressed up as a
 * measurement.
 */

export type PassiveGroup = {
  title: string;
  note: string;
  rows: { label: string; value: string }[];
};

function safe(fn: () => string | null | undefined): string {
  try {
    const v = fn();
    return v == null || v === "" ? "(not exposed)" : v;
  } catch (err) {
    return `(threw: ${err instanceof Error ? err.name : "error"})`;
  }
}

function webglInfo(): { renderer: string; vendor: string; version: string; extensions: number; maxTexture: string } {
  const out = { renderer: "(no WebGL context)", vendor: "(no WebGL context)", version: "(no WebGL context)", extensions: 0, maxTexture: "—" };
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return out;
    const debug = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
    out.renderer = String((debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "unknown");
    out.vendor = String((debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)) ?? "unknown");
    out.version = String(gl.getParameter(gl.VERSION) ?? "unknown");
    out.extensions = gl.getSupportedExtensions()?.length ?? 0;
    out.maxTexture = String(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? "—");
  } catch {
    // leave defaults
  }
  return out;
}

const MEDIA_TYPES: string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
  "video/mp4",
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="hvc1"',
  "video/webm",
  'video/webm; codecs="vp8"',
  'video/webm; codecs="vp9"',
  'video/webm; codecs="av01.0.05M.08"',
  "audio/mpeg",
  "audio/mp4",
  'audio/mp4; codecs="mp4a.40.2"',
  "audio/ogg",
  'audio/ogg; codecs="opus"',
  "audio/wav",
];

function canPlay(): { label: string; value: string }[] {
  const video = document.createElement("video");
  const audio = document.createElement("audio");
  return MEDIA_TYPES.map((type) => {
    const el = type.startsWith("audio/") ? audio : video;
    const play = type.startsWith("image/") ? "" : el.canPlayType(type);
    if (type.startsWith("image/")) {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const encodes = canvas.toDataURL(type).startsWith(`data:${type}`);
      return { label: type, value: encodes ? "canvas can encode it" : "canvas cannot encode it" };
    }
    return { label: type, value: play === "" ? "no" : play };
  });
}

type NetworkInformationLike = { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean; type?: string };
type BatteryLike = { level: number; charging: boolean; chargingTime: number; dischargingTime: number };

/** Reads everything available without a prompt. Async only because battery status is a promise. */
export async function collectPassive(): Promise<PassiveGroup[]> {
  const groups: PassiveGroup[] = [];
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { platform?: string; mobile?: boolean; brands?: { brand: string; version: string }[] };
    connection?: NetworkInformationLike;
    getBattery?: () => Promise<BatteryLike>;
    pdfViewerEnabled?: boolean;
    webdriver?: boolean;
  };

  groups.push({
    title: "Identity strings",
    note: "Sent on every request or readable in one line of script. No permission exists for any of these.",
    rows: [
      { label: "User agent", value: safe(() => navigator.userAgent) },
      { label: "Platform", value: safe(() => navigator.platform) },
      { label: "UA-CH platform", value: safe(() => (nav.userAgentData?.platform ? `${nav.userAgentData.platform}${nav.userAgentData.mobile ? " (mobile)" : ""}` : null)) },
      { label: "UA-CH brands", value: safe(() => nav.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(", ") ?? null) },
      { label: "Vendor", value: safe(() => navigator.vendor) },
      { label: "Languages", value: safe(() => navigator.languages?.join(", ") ?? navigator.language) },
      { label: "Automation flag (navigator.webdriver)", value: safe(() => String(nav.webdriver ?? false)) },
      { label: "PDF viewer enabled", value: safe(() => String(nav.pdfViewerEnabled ?? "not exposed")) },
      { label: "Do Not Track", value: safe(() => navigator.doNotTrack ?? "not set") },
      { label: "Cookies enabled", value: safe(() => String(navigator.cookieEnabled)) },
    ],
  });

  groups.push({
    title: "Hardware",
    note: "How much machine you have. Combined, these narrow a device down considerably.",
    rows: [
      { label: "Processor threads", value: safe(() => String(navigator.hardwareConcurrency ?? "not exposed")) },
      { label: "Device memory (rounded)", value: safe(() => (nav.deviceMemory != null ? `${nav.deviceMemory} GB` : null)) },
      { label: "Maximum touch points", value: safe(() => String(navigator.maxTouchPoints ?? 0)) },
      { label: "Screen", value: safe(() => `${screen.width}×${screen.height} logical · ${screen.width * devicePixelRatio}×${screen.height * devicePixelRatio} physical`) },
      { label: "Available screen area", value: safe(() => `${screen.availWidth}×${screen.availHeight}`) },
      { label: "Device pixel ratio", value: safe(() => String(devicePixelRatio)) },
      { label: "Colour depth", value: safe(() => `${screen.colorDepth}-bit (${screen.pixelDepth}-bit pixel depth)`) },
      { label: "Viewport", value: safe(() => `${innerWidth}×${innerHeight}`) },
      { label: "Screen orientation", value: safe(() => `${screen.orientation?.type ?? "unknown"} at ${screen.orientation?.angle ?? "?"}°`) },
      { label: "Wide colour gamut", value: safe(() => (matchMedia("(color-gamut: p3)").matches ? "Display P3 or wider" : matchMedia("(color-gamut: srgb)").matches ? "sRGB" : "below sRGB")) },
      { label: "HDR", value: safe(() => (matchMedia("(dynamic-range: high)").matches ? "high dynamic range" : "standard dynamic range")) },
    ],
  });

  const gl = webglInfo();
  groups.push({
    title: "Graphics",
    note: "The GPU string alone is often enough to name the exact phone model.",
    rows: [
      { label: "WebGL renderer", value: gl.renderer },
      { label: "WebGL vendor", value: gl.vendor },
      { label: "WebGL version", value: gl.version },
      { label: "WebGL extensions", value: `${gl.extensions} supported` },
      { label: "Max texture size", value: gl.maxTexture },
      { label: "WebGPU", value: safe(() => ("gpu" in navigator ? "available" : "not available")) },
    ],
  });

  const conn = nav.connection;
  groups.push({
    title: "Network",
    note: "Connection quality, readable continuously and without a prompt.",
    rows: [
      { label: "Online", value: safe(() => String(navigator.onLine)) },
      { label: "Effective type", value: safe(() => conn?.effectiveType ?? null) },
      { label: "Downlink estimate", value: safe(() => (conn?.downlink != null ? `${conn.downlink} Mbps` : null)) },
      { label: "Round-trip time estimate", value: safe(() => (conn?.rtt != null ? `${conn.rtt} ms` : null)) },
      { label: "Data saver", value: safe(() => (conn?.saveData != null ? String(conn.saveData) : null)) },
      { label: "Connection type", value: safe(() => conn?.type ?? null) },
    ],
  });

  const battery: { label: string; value: string }[] = [];
  if (typeof nav.getBattery === "function") {
    try {
      const b = await nav.getBattery();
      battery.push(
        { label: "Charge level", value: `${Math.round(b.level * 100)}%` },
        { label: "Charging", value: String(b.charging) },
        { label: "Time to full", value: Number.isFinite(b.chargingTime) ? `${Math.round(b.chargingTime / 60)} min` : "not charging / unknown" },
        { label: "Time to empty", value: Number.isFinite(b.dischargingTime) ? `${Math.round(b.dischargingTime / 60)} min` : "unknown" }
      );
    } catch {
      battery.push({ label: "Battery status", value: "(the API exists but refused to answer)" });
    }
  } else {
    battery.push({
      label: "Battery status",
      value: "(not exposed — Safari and Firefox removed this API because the charge level made an effective short-term identifier)",
    });
  }
  groups.push({ title: "Power", note: "No permission has ever existed for this.", rows: battery });

  let storage = "(not exposed)";
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate) {
      storage = `${((estimate.usage ?? 0) / 1024 / 1024).toFixed(1)} MB used of ${((estimate.quota ?? 0) / 1024 / 1024 / 1024).toFixed(2)} GB quota`;
    }
  } catch {
    storage = "(the API exists but refused to answer)";
  }
  groups.push({
    title: "Locale, time and storage",
    note: "Time zone plus language is a strong regional signal on its own.",
    rows: [
      { label: "Time zone", value: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone) },
      { label: "UTC offset", value: safe(() => `${-new Date().getTimezoneOffset()} minutes`) },
      { label: "Calendar / numbering", value: safe(() => `${Intl.DateTimeFormat().resolvedOptions().calendar} / ${Intl.DateTimeFormat().resolvedOptions().numberingSystem}`) },
      { label: "Storage estimate", value: storage },
      { label: "Local storage", value: safe(() => (typeof localStorage !== "undefined" ? "available" : null)) },
      { label: "IndexedDB", value: safe(() => ("indexedDB" in window ? "available" : null)) },
    ],
  });

  groups.push({
    title: "Display preferences",
    note: "Accessibility and appearance settings, readable via media queries.",
    rows: [
      { label: "Colour scheme", value: safe(() => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) },
      { label: "Reduced motion", value: safe(() => String(matchMedia("(prefers-reduced-motion: reduce)").matches)) },
      { label: "Reduced transparency", value: safe(() => String(matchMedia("(prefers-reduced-transparency: reduce)").matches)) },
      { label: "Increased contrast", value: safe(() => String(matchMedia("(prefers-contrast: more)").matches)) },
      { label: "Forced colours", value: safe(() => String(matchMedia("(forced-colors: active)").matches)) },
      { label: "Inverted colours", value: safe(() => String(matchMedia("(inverted-colors: inverted)").matches)) },
      { label: "Pointer", value: safe(() => (matchMedia("(pointer: coarse)").matches ? "coarse (touch)" : matchMedia("(pointer: fine)").matches ? "fine" : "none")) },
      { label: "Hover capable", value: safe(() => String(matchMedia("(hover: hover)").matches)) },
      { label: "Display mode", value: safe(() => (matchMedia("(display-mode: standalone)").matches ? "standalone (installed)" : "browser tab")) },
    ],
  });

  groups.push({
    title: "Media format support",
    note: "Which codecs this device can decode. The exact combination varies by hardware and OS version.",
    rows: canPlay(),
  });

  const apis: { label: string; value: string }[] = [
    ["getUserMedia", () => !!navigator.mediaDevices?.getUserMedia],
    ["enumerateDevices", () => typeof navigator.mediaDevices?.enumerateDevices === "function"],
    ["ImageCapture", () => "ImageCapture" in window],
    ["MediaRecorder", () => "MediaRecorder" in window],
    ["BarcodeDetector", () => "BarcodeDetector" in window],
    ["FaceDetector", () => "FaceDetector" in window],
    ["requestVideoFrameCallback", () => "requestVideoFrameCallback" in HTMLVideoElement.prototype],
    ["WebCodecs (VideoEncoder)", () => "VideoEncoder" in window],
    ["CompressionStream", () => "CompressionStream" in window],
    ["crypto.subtle", () => typeof crypto !== "undefined" && !!crypto.subtle],
    ["Service workers", () => "serviceWorker" in navigator],
    ["Web Share", () => typeof navigator.share === "function"],
    ["Web Share (files)", () => typeof navigator.canShare === "function"],
    ["Vibration", () => "vibrate" in navigator],
    ["Speech synthesis", () => "speechSynthesis" in window],
    ["Speech recognition", () => "SpeechRecognition" in window || "webkitSpeechRecognition" in window],
    ["WebXR", () => "xr" in navigator],
    ["Gamepads", () => typeof navigator.getGamepads === "function"],
    ["Credential management", () => "credentials" in navigator],
    ["Payment request", () => "PaymentRequest" in window],
    ["Virtual keyboard", () => "virtualKeyboard" in navigator],
    ["Screen wake lock", () => "wakeLock" in navigator],
    ["Compute pressure", () => "PressureObserver" in window],
    ["Device posture", () => "devicePosture" in navigator],
    ["OffscreenCanvas", () => "OffscreenCanvas" in window],
    ["SharedArrayBuffer (cross-origin isolated)", () => "SharedArrayBuffer" in window],
  ].map(([label, probe]) => ({ label: label as string, value: (probe as () => boolean)() ? "available" : "not available" }));

  groups.push({
    title: "API surface",
    note: "Which capabilities exist here at all. A missing API is a fact about the browser, never about you.",
    rows: apis,
  });

  return groups;
}

/** Renders the passive dump as the plain text that goes into the archive. */
export function passiveText(groups: PassiveGroup[], permissionStates: { name: string; state: string | null }[]): string {
  const lines: string[] = [
    "PASSIVE ENVIRONMENT DUMP",
    "=".repeat(70),
    `Read at ${new Date().toISOString()}`,
    "",
    "Everything below was readable WITHOUT any prompt, indicator or opportunity to decline. That is the",
    "point of this file: the permission ledger covers what you were asked for, and this covers what was",
    "simply taken. Neither is an accusation — it is how the web platform works today.",
    "",
    "This app does not compute a uniqueness or fingerprint score. Any such number would depend on a",
    "population this app cannot see, so it would be a guess wearing the costume of a measurement.",
    "",
  ];
  for (const group of groups) {
    lines.push("", `── ${group.title.toUpperCase()} ──`, `   ${group.note}`, "");
    const width = Math.max(...group.rows.map((r) => r.label.length));
    for (const row of group.rows) lines.push(`   ${row.label.padEnd(width)}  ${row.value}`);
  }

  lines.push(
    "",
    "── PERMISSION STATES AS THE BROWSER REPORTS THEM ──",
    "   navigator.permissions.query() for every name any current browser answers to. A null means this",
    "   browser refuses to answer for that name, which is itself a difference between browsers — it is not",
    "   the same as 'prompt'.",
    ""
  );
  const width = Math.max(...permissionStates.map((p) => p.name.length));
  for (const p of permissionStates) {
    lines.push(`   ${p.name.padEnd(width)}  ${p.state ?? "(this browser will not answer for that name)"}`);
  }
  return lines.join("\n");
}
