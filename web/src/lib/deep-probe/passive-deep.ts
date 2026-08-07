/**
 * The deep passive probe — the second half of "what a page can read without
 * asking", covering the readings that take real work to extract rather than a
 * single property access.
 *
 * `passive.ts` collects the one-line reads. This file collects the rest: the
 * high-entropy client hints, the full graphics parameter set, the audio stack,
 * rendering signatures, font metrics, hardware codec support, and the engine
 * behaviours that pin a browser build. These are the readings a serious
 * fingerprinting script actually uses, and leaving them out would have made the
 * passive dump look far more modest than the truth.
 *
 * Two honesty rules specific to this file:
 *
 * 1. **A rendering signature is not an identifier.** The canvas, WebGL and audio
 *    hashes below are computed over *this app's own test patterns*. They are
 *    stable for a given device + browser + driver combination, which is exactly
 *    what makes them useful to a tracker — but the number itself is meaningless
 *    outside this app, and cannot be compared against anyone else's fingerprint
 *    database. Every hash row says so.
 * 2. **A probe that fails is recorded as a failed probe.** Never as an absent
 *    capability. The two look identical in a results table and mean opposite
 *    things, so failures carry the thrown error's name.
 */

import type { PassiveGroup } from "./passive";

type Row = { label: string; value: string };

const NOT_EXPOSED = "(not exposed)";

/** Wraps a probe so one thrown error cannot take down the whole dump. */
function safeRow(label: string, fn: () => string | null | undefined): Row {
  try {
    const value = fn();
    return { label, value: value == null || value === "" ? NOT_EXPOSED : value };
  } catch (err) {
    return { label, value: `(threw: ${err instanceof Error ? err.name : "error"})` };
  }
}

/** Resolves to a fallback rather than hanging the run on a promise that never settles. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Hashing
 * ------------------------------------------------------------------ */

/**
 * FNV-1a run twice with different offsets to give 64 bits of output. Chosen
 * over SHA-256 because it is synchronous — `crypto.subtle` is async, and these
 * hashes sit inside otherwise-synchronous rendering probes.
 *
 * This is a *signature*, not a security digest: it identifies a rendering
 * pipeline, and nothing depends on it being collision-resistant.
 */
export function fnv1aHex(bytes: ArrayLike<number>): string {
  let a = 0x811c9dc5 >>> 0;
  let b = 0x811c9dc5 ^ 0x5f5e100;
  b = b >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] & 0xff;
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x01000193) >>> 0;
    b = (b ^ (b >>> 7)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Hashes floats by quantising first, so tiny denormal noise cannot change the result. */
export function hashFloats(values: ArrayLike<number>, precision = 1e7): string {
  const bytes: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const quantised = Math.round(values[i] * precision);
    bytes.push(quantised & 0xff, (quantised >>> 8) & 0xff, (quantised >>> 16) & 0xff, (quantised >>> 24) & 0xff);
  }
  return fnv1aHex(bytes);
}

/* ------------------------------------------------------------------ *
 * Client hints — the single most identifying prompt-free read on Android
 * ------------------------------------------------------------------ */

type HighEntropyHints = {
  architecture?: string;
  bitness?: string;
  model?: string;
  platform?: string;
  platformVersion?: string;
  uaFullVersion?: string;
  fullVersionList?: { brand: string; version: string }[];
  formFactors?: string[];
  wow64?: boolean;
};

const HINT_KEYS: string[] = [
  "architecture",
  "bitness",
  "model",
  "platform",
  "platformVersion",
  "uaFullVersion",
  "fullVersionList",
  "formFactors",
  "wow64",
];

async function clientHints(): Promise<Row[]> {
  const nav = navigator as Navigator & {
    userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<HighEntropyHints> };
  };
  const getter = nav.userAgentData?.getHighEntropyValues;
  if (typeof getter !== "function" || !nav.userAgentData) {
    return [
      {
        label: "High-entropy client hints",
        value: "(not exposed — Safari and Firefox do not implement User-Agent Client Hints at all, so this whole group is Chromium-only)",
      },
    ];
  }
  const hints = await withTimeout(getter.call(nav.userAgentData, HINT_KEYS), 2000, {} as HighEntropyHints).catch(() => ({}) as HighEntropyHints);
  return [
    { label: "Device model", value: hints.model || "(empty — desktop Chromium and iOS report no model)" },
    { label: "Platform version", value: hints.platformVersion || NOT_EXPOSED },
    { label: "CPU architecture", value: hints.architecture || NOT_EXPOSED },
    { label: "CPU bitness", value: hints.bitness || NOT_EXPOSED },
    { label: "Full browser version", value: hints.uaFullVersion || NOT_EXPOSED },
    {
      label: "Full version list",
      value: hints.fullVersionList?.map((b) => `${b.brand} ${b.version}`).join(", ") || NOT_EXPOSED,
    },
    { label: "Form factors", value: hints.formFactors?.join(", ") || NOT_EXPOSED },
    { label: "WOW64", value: hints.wow64 == null ? NOT_EXPOSED : String(hints.wow64) },
  ];
}

/* ------------------------------------------------------------------ *
 * Graphics detail
 * ------------------------------------------------------------------ */

function paramString(gl: WebGLRenderingContext | WebGL2RenderingContext, param: number): string {
  try {
    const value: unknown = gl.getParameter(param);
    if (value == null) return "(null)";
    if (Array.isArray(value)) return value.join(", ");
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>).join(", ");
    return String(value);
  } catch {
    return "(threw)";
  }
}

function precisionRow(gl: WebGLRenderingContext | WebGL2RenderingContext, shader: number, precision: number, name: string): Row | null {
  try {
    const format = gl.getShaderPrecisionFormat(shader, precision);
    if (!format) return null;
    return { label: name, value: `range ±${format.rangeMin}/${format.rangeMax}, precision ${format.precision}` };
  } catch {
    return null;
  }
}

function graphicsDetail(): Row[] {
  const rows: Row[] = [];
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement("canvas");
  } catch {
    return [{ label: "WebGL detail", value: "(no canvas available)" }];
  }
  const gl2 = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  const gl = gl2 ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
  if (!gl) return [{ label: "WebGL detail", value: "(no WebGL context)" }];

  rows.push({ label: "WebGL generation", value: gl2 ? "WebGL 2 available" : "WebGL 1 only" });
  rows.push({ label: "Shading language", value: paramString(gl, gl.SHADING_LANGUAGE_VERSION) });

  const params: [string, number][] = [
    ["Max texture size", gl.MAX_TEXTURE_SIZE],
    ["Max cube map size", gl.MAX_CUBE_MAP_TEXTURE_SIZE],
    ["Max renderbuffer size", gl.MAX_RENDERBUFFER_SIZE],
    ["Max viewport dimensions", gl.MAX_VIEWPORT_DIMS],
    ["Max vertex attributes", gl.MAX_VERTEX_ATTRIBS],
    ["Max vertex uniform vectors", gl.MAX_VERTEX_UNIFORM_VECTORS],
    ["Max fragment uniform vectors", gl.MAX_FRAGMENT_UNIFORM_VECTORS],
    ["Max varying vectors", gl.MAX_VARYING_VECTORS],
    ["Max texture image units", gl.MAX_TEXTURE_IMAGE_UNITS],
    ["Max combined texture units", gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS],
    ["Aliased line width range", gl.ALIASED_LINE_WIDTH_RANGE],
    ["Aliased point size range", gl.ALIASED_POINT_SIZE_RANGE],
    ["Red/green/blue/alpha bits", gl.RED_BITS],
    ["Depth bits", gl.DEPTH_BITS],
    ["Stencil bits", gl.STENCIL_BITS],
  ];
  for (const [label, param] of params) rows.push({ label, value: paramString(gl, param) });

  const anisotropic = gl.getExtension("EXT_texture_filter_anisotropic") as { MAX_TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
  rows.push({
    label: "Max anisotropy",
    value: anisotropic ? paramString(gl, anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : "(extension not supported)",
  });

  const precisions: (Row | null)[] = [
    precisionRow(gl, gl.VERTEX_SHADER, gl.HIGH_FLOAT, "Vertex shader high float"),
    precisionRow(gl, gl.FRAGMENT_SHADER, gl.HIGH_FLOAT, "Fragment shader high float"),
    precisionRow(gl, gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT, "Fragment shader medium float"),
    precisionRow(gl, gl.FRAGMENT_SHADER, gl.HIGH_INT, "Fragment shader high int"),
  ];
  for (const row of precisions) if (row) rows.push(row);

  // Naming the extensions, not counting them. The count collapses a list that
  // differs meaningfully between drivers into a single weak number.
  let extensions: string[] = [];
  try {
    extensions = gl.getSupportedExtensions() ?? [];
  } catch {
    extensions = [];
  }
  rows.push({ label: "WebGL extension names", value: extensions.length > 0 ? extensions.slice().sort().join(" ") : NOT_EXPOSED });
  return rows;
}

type GpuAdapterLike = {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  features?: Iterable<string>;
  limits?: Record<string, number>;
  requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; device?: string; description?: string }>;
};

const NOTABLE_GPU_LIMITS: string[] = [
  "maxTextureDimension2D",
  "maxBufferSize",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxStorageBufferBindingSize",
  "maxUniformBufferBindingSize",
  "maxBindGroups",
];

async function webgpuDetail(): Promise<Row[]> {
  // Cast through `unknown`: the DOM lib's own `GPUAdapter` predates `adapter.info`,
  // so intersecting with `Navigator` would type the newer field out of existence.
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return [{ label: "WebGPU", value: "not available in this browser" }];
  try {
    const adapter = await withTimeout(gpu.requestAdapter(), 3000, null);
    if (!adapter) return [{ label: "WebGPU", value: "available, but no adapter was returned (blocked driver or software fallback disabled)" }];
    const info = adapter.info ?? (adapter.requestAdapterInfo ? await withTimeout(adapter.requestAdapterInfo(), 2000, undefined) : undefined);
    const rows: Row[] = [
      { label: "WebGPU adapter vendor", value: info?.vendor || NOT_EXPOSED },
      { label: "WebGPU adapter architecture", value: info?.architecture || NOT_EXPOSED },
      { label: "WebGPU adapter device", value: info?.device || NOT_EXPOSED },
      { label: "WebGPU adapter description", value: info?.description || NOT_EXPOSED },
    ];
    const features = adapter.features ? Array.from(adapter.features).sort() : [];
    rows.push({ label: "WebGPU features", value: features.length > 0 ? features.join(" ") : "none reported" });
    const limits = adapter.limits;
    if (limits) {
      const notable = NOTABLE_GPU_LIMITS.filter((key) => typeof limits[key] === "number").map((key) => `${key}=${limits[key]}`);
      rows.push({ label: "WebGPU limits", value: notable.length > 0 ? notable.join(" ") : "none readable" });
    }
    return rows;
  } catch (err) {
    return [{ label: "WebGPU", value: `(probe threw: ${err instanceof Error ? err.name : "error"})` }];
  }
}

/* ------------------------------------------------------------------ *
 * Rendering signatures
 * ------------------------------------------------------------------ */

function canvasSignature(): Row[] {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 80;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [{ label: "Canvas 2D signature", value: "(no 2D context)" }];
    ctx.textBaseline = "top";
    ctx.font = '14px "Arial"';
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 125, 30);
    ctx.fillStyle = "#069";
    ctx.fillText("Deep Probe \u{1F4F7} \u00e9\u00e8\u00ea\u00e7 \u0906", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("Deep Probe \u{1F4F7} \u00e9\u00e8\u00ea\u00e7 \u0906", 4, 25);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgb(255,0,255)";
    ctx.beginPath();
    ctx.arc(50, 50, 25, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.fillStyle = "rgb(0,255,255)";
    ctx.beginPath();
    ctx.arc(100, 50, 25, 0, Math.PI * 2, true);
    ctx.fill();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonZero = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) nonZero += 1;
    return [
      { label: "Canvas 2D signature", value: fnv1aHex(data) },
      { label: "Canvas 2D coverage", value: `${nonZero} of ${data.length / 4} pixels painted` },
    ];
  } catch (err) {
    return [{ label: "Canvas 2D signature", value: `(probe threw: ${err instanceof Error ? err.name : "error"})` }];
  }
}

function webglSignature(): Row[] {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const gl = (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return [{ label: "WebGL render signature", value: "(no WebGL context)" }];

    const vertex = gl.createShader(gl.VERTEX_SHADER);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return [{ label: "WebGL render signature", value: "(shader allocation failed)" }];

    gl.shaderSource(vertex, "attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.0,1.0);}");
    gl.compileShader(vertex);
    gl.shaderSource(
      fragment,
      "precision highp float;varying vec2 v;void main(){float d=sin(v.x*12.0)*cos(v.y*9.0);gl_FragColor=vec4(abs(d),v.x*0.5+0.5,v.y*0.5+0.5,1.0);}"
    );
    gl.compileShader(fragment);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return [{ label: "WebGL render signature", value: "(program did not link)" }];
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, 128, 128);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const pixels = new Uint8Array(128 * 128 * 4);
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return [{ label: "WebGL render signature", value: fnv1aHex(pixels) }];
  } catch (err) {
    return [{ label: "WebGL render signature", value: `(probe threw: ${err instanceof Error ? err.name : "error"})` }];
  }
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

async function audioSignature(): Promise<Row[]> {
  const win = window as Window & { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = win.OfflineAudioContext ?? win.webkitOfflineAudioContext;
  if (!Ctor) return [{ label: "Audio DSP signature", value: "(OfflineAudioContext not available)" }];
  try {
    const ctx = new Ctor(1, 5000, 44100);
    const oscillator = ctx.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = 10000;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -50;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;
    oscillator.connect(compressor);
    compressor.connect(ctx.destination);
    oscillator.start(0);
    const buffer = await withTimeout(ctx.startRendering(), 4000, null);
    if (!buffer) return [{ label: "Audio DSP signature", value: "(rendering did not finish in time)" }];
    const channel = buffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < channel.length; i += 1) sum += Math.abs(channel[i]);
    return [
      { label: "Audio DSP signature", value: hashFloats(channel) },
      { label: "Audio DSP sum", value: sum.toPrecision(12) },
    ];
  } catch (err) {
    return [{ label: "Audio DSP signature", value: `(probe threw: ${err instanceof Error ? err.name : "error"})` }];
  }
}

function audioStack(): Row[] {
  const win = window as Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = win.AudioContext ?? win.webkitAudioContext;
  if (!Ctor) return [{ label: "Audio stack", value: "(Web Audio not available)" }];
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    const destination = ctx.destination;
    const rows: Row[] = [
      { label: "Audio sample rate", value: `${ctx.sampleRate} Hz` },
      { label: "Audio base latency", value: ctx.baseLatency != null ? `${(ctx.baseLatency * 1000).toFixed(3)} ms` : NOT_EXPOSED },
      {
        label: "Audio output latency",
        value: typeof ctx.outputLatency === "number" ? `${(ctx.outputLatency * 1000).toFixed(3)} ms` : NOT_EXPOSED,
      },
      { label: "Audio max channels", value: String(destination.maxChannelCount) },
      { label: "Audio context state", value: ctx.state },
    ];
    return rows;
  } catch (err) {
    return [{ label: "Audio stack", value: `(probe threw: ${err instanceof Error ? err.name : "error"})` }];
  } finally {
    try {
      void ctx?.close();
    } catch {
      // closing is best-effort
    }
  }
}

/* ------------------------------------------------------------------ *
 * Fonts — no permission required, unlike the local-fonts enumeration
 * ------------------------------------------------------------------ */

/**
 * Fonts probed by metric comparison. Chosen to span platforms: a hit on
 * "Helvetica Neue" says iOS, "Roboto" says Android, "Segoe UI" says Windows.
 */
export const FONT_PROBES: string[] = [
  "Arial",
  "Arial Black",
  "Arial Narrow",
  "Avenir",
  "Avenir Next",
  "Baskerville",
  "Bodoni 72",
  "Bookman",
  "Cambria",
  "Candara",
  "Comic Sans MS",
  "Consolas",
  "Courier",
  "Courier New",
  "Didot",
  "Droid Sans",
  "Franklin Gothic",
  "Futura",
  "Garamond",
  "Geneva",
  "Georgia",
  "Gill Sans",
  "Helvetica",
  "Helvetica Neue",
  "Hiragino Sans",
  "Impact",
  "Lucida Grande",
  "Menlo",
  "Monaco",
  "Noto Sans",
  "Optima",
  "Palatino",
  "Papyrus",
  "PingFang SC",
  "Roboto",
  "Rockwell",
  "Segoe UI",
  "SF Pro Text",
  "Tahoma",
  "Thonburi",
  "Times",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
  "Zapfino",
];

const FONT_BASELINES: string[] = ["monospace", "sans-serif", "serif"];
const FONT_SAMPLE = "mmmmmmmmmmlli\u00c9W@1I0O";

/**
 * Detects installed fonts by measuring text width against the three generic
 * families. A font that renders at a different width from all three baselines
 * is present; one that matches every baseline fell back and is absent.
 *
 * This needs no permission at all — the `local-fonts` permission in the tier-3
 * sweep governs *enumerating* the full list, not probing for known names.
 */
function fontProbe(): Row[] {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return [{ label: "Font detection", value: "(no 2D context)" }];
    const measure = (family: string): number => {
      ctx.font = `72px ${family}`;
      return ctx.measureText(FONT_SAMPLE).width;
    };
    const baselines = FONT_BASELINES.map(measure);
    const present: string[] = [];
    for (const font of FONT_PROBES) {
      const differs = FONT_BASELINES.some((baseline, index) => {
        const width = measure(`"${font}", ${baseline}`);
        return Math.abs(width - baselines[index]) > 0.5;
      });
      if (differs) present.push(font);
    }
    const absent = FONT_PROBES.filter((f) => !present.includes(f));
    return [
      { label: "Fonts present", value: present.length > 0 ? present.join(" · ") : "none of the probed set" },
      { label: "Fonts absent", value: absent.length > 0 ? absent.join(" · ") : "none — every probed font is installed" },
      { label: "Fonts probed", value: `${FONT_PROBES.length} names, by width comparison against monospace/sans-serif/serif` },
    ];
  } catch (err) {
    return [{ label: "Font detection", value: `(probe threw: ${err instanceof Error ? err.name : "error"})` }];
  }
}

/* ------------------------------------------------------------------ *
 * Codec detail — hardware decode/encode, which canPlayType cannot see
 * ------------------------------------------------------------------ */

const DECODE_CONFIGS: { label: string; contentType: string; width: number; height: number; bitrate: number; framerate: number }[] = [
  { label: "H.264 1080p30", contentType: 'video/mp4; codecs="avc1.42E01E"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 },
  { label: "H.264 4K60", contentType: 'video/mp4; codecs="avc1.640033"', width: 3840, height: 2160, bitrate: 20000000, framerate: 60 },
  { label: "HEVC 4K60", contentType: 'video/mp4; codecs="hvc1.1.6.L153.B0"', width: 3840, height: 2160, bitrate: 20000000, framerate: 60 },
  { label: "VP9 1080p30", contentType: 'video/webm; codecs="vp09.00.10.08"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 },
  { label: "AV1 1080p30", contentType: 'video/mp4; codecs="av01.0.05M.08"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 },
];

const RECORDER_TYPES: string[] = [
  "video/mp4",
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="hvc1"',
  "video/webm",
  'video/webm; codecs="vp8"',
  'video/webm; codecs="vp9"',
  'video/webm; codecs="h264"',
  'video/webm; codecs="av01"',
  "audio/webm",
  'audio/webm; codecs="opus"',
  "audio/mp4",
  'audio/mp4; codecs="mp4a.40.2"',
];

type MediaCapabilitiesLike = {
  decodingInfo: (config: unknown) => Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }>;
};

async function codecDetail(): Promise<Row[]> {
  const rows: Row[] = [];
  const caps = (navigator as Navigator & { mediaCapabilities?: MediaCapabilitiesLike }).mediaCapabilities;
  if (!caps?.decodingInfo) {
    rows.push({ label: "Media Capabilities", value: "(not available — only the coarse canPlayType answer exists here)" });
  } else {
    for (const config of DECODE_CONFIGS) {
      try {
        const result = await withTimeout(
          caps.decodingInfo({
            type: "media-source",
            video: {
              contentType: config.contentType,
              width: config.width,
              height: config.height,
              bitrate: config.bitrate,
              framerate: config.framerate,
            },
          }),
          2000,
          null as { supported: boolean; smooth: boolean; powerEfficient: boolean } | null
        );
        rows.push({
          label: `Decode ${config.label}`,
          value: result
            ? `${result.supported ? "supported" : "unsupported"}${result.supported ? `, ${result.smooth ? "smooth" : "not smooth"}, ${result.powerEfficient ? "hardware-accelerated" : "software (not power efficient)"}` : ""}`
            : "(query timed out)",
        });
      } catch (err) {
        rows.push({ label: `Decode ${config.label}`, value: `(threw: ${err instanceof Error ? err.name : "error"})` });
      }
    }
  }

  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    rows.push({ label: "MediaRecorder encoders", value: "(MediaRecorder not available)" });
  } else {
    const supported = RECORDER_TYPES.filter((type) => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch {
        return false;
      }
    });
    rows.push({ label: "MediaRecorder encoders", value: supported.length > 0 ? supported.join(" · ") : "none of the probed types" });
    rows.push({
      label: "MediaRecorder refused",
      value: RECORDER_TYPES.filter((t) => !supported.includes(t)).join(" · ") || "none — every probed type is supported",
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Speech voices and the WebRTC offer
 * ------------------------------------------------------------------ */

async function speechVoices(): Promise<Row[]> {
  if (typeof speechSynthesis === "undefined") return [{ label: "Speech voices", value: "(speech synthesis not available)" }];
  const read = (): SpeechSynthesisVoice[] => {
    try {
      return speechSynthesis.getVoices();
    } catch {
      return [];
    }
  };
  let voices = read();
  if (voices.length === 0) {
    // The list populates asynchronously on most engines; give it one bounded chance.
    voices = await withTimeout(
      new Promise<SpeechSynthesisVoice[]>((resolve) => {
        const handler = (): void => resolve(read());
        speechSynthesis.addEventListener("voiceschanged", handler, { once: true });
      }),
      1500,
      []
    );
  }
  if (voices.length === 0) return [{ label: "Speech voices", value: "none reported (the list can stay empty until a page speaks)" }];
  const local = voices.filter((v) => v.localService);
  return [
    { label: "Speech voice count", value: `${voices.length} (${local.length} on-device, ${voices.length - local.length} network)` },
    { label: "Speech voice languages", value: Array.from(new Set(voices.map((v) => v.lang))).sort().join(" ") },
    { label: "Speech voice names", value: voices.map((v) => v.name).sort().join(" · ") },
  ];
}

/**
 * Pulls the codec and header-extension list out of an SDP offer. Exported for
 * tests: the parse must not depend on a real peer connection.
 */
export function summariseSdp(sdp: string): { codecs: string[]; extensions: string[]; mids: string[] } {
  const codecs: string[] = [];
  const extensions: string[] = [];
  const mids: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const rtpmap = /^a=rtpmap:\d+ (.+)$/.exec(line);
    if (rtpmap) {
      const name = rtpmap[1].trim();
      if (!codecs.includes(name)) codecs.push(name);
      continue;
    }
    const extmap = /^a=extmap:\d+(?:\/\w+)? (.+)$/.exec(line);
    if (extmap) {
      const uri = extmap[1].trim();
      if (!extensions.includes(uri)) extensions.push(uri);
      continue;
    }
    const mid = /^a=mid:(.+)$/.exec(line);
    if (mid) mids.push(mid[1].trim());
  }
  return { codecs, extensions, mids };
}

async function webrtcOffer(): Promise<Row[]> {
  if (typeof RTCPeerConnection === "undefined") return [{ label: "WebRTC", value: "(RTCPeerConnection not available)" }];
  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection();
    pc.createDataChannel("probe");
    try {
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
    } catch {
      // Older engines reject addTransceiver; the data channel alone still yields an SDP.
    }
    const offer = await withTimeout(pc.createOffer(), 3000, null);
    if (!offer?.sdp) return [{ label: "WebRTC", value: "(no offer produced)" }];
    const { codecs, extensions } = summariseSdp(offer.sdp);
    return [
      { label: "WebRTC codecs offered", value: codecs.length > 0 ? codecs.join(" · ") : "none listed" },
      { label: "WebRTC header extensions", value: extensions.length > 0 ? extensions.join(" · ") : "none listed" },
      {
        label: "WebRTC SDP signature",
        value: `${fnv1aHex(new TextEncoder().encode(offer.sdp.replace(/\d{6,}/g, "N")))} (session ids masked before hashing)`,
      },
    ];
  } catch (err) {
    return [{ label: "WebRTC", value: `(probe threw: ${err instanceof Error ? err.name : "error"})` }];
  } finally {
    try {
      pc?.close();
    } catch {
      // best effort
    }
  }
}

/* ------------------------------------------------------------------ *
 * Engine behaviour and extra media queries
 * ------------------------------------------------------------------ */

/** Smallest non-zero gap between consecutive clock reads — browsers deliberately coarsen this. */
export function clockResolutionFrom(samples: number[]): number | null {
  let smallest = Infinity;
  for (let i = 1; i < samples.length; i += 1) {
    const delta = samples[i] - samples[i - 1];
    if (delta > 0 && delta < smallest) smallest = delta;
  }
  return Number.isFinite(smallest) ? smallest : null;
}

const CSS_PROBES: string[] = [
  "color: color(display-p3 1 0 0)",
  "backdrop-filter: blur(1px)",
  "aspect-ratio: 1/1",
  "content-visibility: auto",
  "text-wrap: balance",
  "anchor-name: --a",
  "field-sizing: content",
  "scrollbar-gutter: stable",
  "overflow: clip",
  "translate: 1px",
  "-webkit-touch-callout: none",
  "font-size-adjust: 0.5",
  "corner-shape: squircle",
];

const EXTRA_MEDIA_QUERIES: [string, string][] = [
  ["Any pointer coarse", "(any-pointer: coarse)"],
  ["Any pointer fine", "(any-pointer: fine)"],
  ["Any hover", "(any-hover: hover)"],
  ["Monochrome", "(monochrome)"],
  ["Update frequency fast", "(update: fast)"],
  ["Scripting enabled", "(scripting: enabled)"],
  ["Reduced data", "(prefers-reduced-data: reduce)"],
  ["Video dynamic range high", "(video-dynamic-range: high)"],
  ["Orientation portrait", "(orientation: portrait)"],
  ["Overflow block scroll", "(overflow-block: scroll)"],
  ["Colour gamut rec2020", "(color-gamut: rec2020)"],
  ["Standalone display", "(display-mode: standalone)"],
  ["Fullscreen display", "(display-mode: fullscreen)"],
];

function safeAreaInsets(): Row {
  try {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const value = `top ${style.paddingTop} right ${style.paddingRight} bottom ${style.paddingBottom} left ${style.paddingLeft}`;
    probe.remove();
    return { label: "Safe-area insets", value };
  } catch (err) {
    return { label: "Safe-area insets", value: `(probe threw: ${err instanceof Error ? err.name : "error"})` };
  }
}

function engineBehaviour(): Row[] {
  const rows: Row[] = [];

  const clock: number[] = [];
  for (let i = 0; i < 5000; i += 1) clock.push(performance.now());
  const resolution = clockResolutionFrom(clock);
  rows.push({
    label: "Clock resolution",
    value: resolution != null ? `${resolution} ms smallest observed step` : "no step observed in 5000 reads",
  });
  rows.push({
    label: "Cross-origin isolated",
    value: String((window as Window & { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false),
  });

  // Transcendental results differ between engine/libm builds by the last bits.
  const maths = [Math.sin(1e300), Math.tan(-1e308), Math.acos(0.123456789), Math.exp(1.5), Math.sinh(1), Math.pow(Math.PI, -100)];
  rows.push({ label: "Math signature", value: maths.map((n) => n.toExponential(17)).join(" ") });

  rows.push(
    safeRow("Error stack format", () => {
      try {
        throw new Error("probe");
      } catch (err) {
        const stack = err instanceof Error ? (err.stack ?? "") : "";
        return stack.split("\n")[0]?.slice(0, 60) ?? "(empty)";
      }
    })
  );

  rows.push(
    safeRow("Intl detail", () => {
      const options = Intl.DateTimeFormat().resolvedOptions() as Intl.ResolvedDateTimeFormatOptions & { hourCycle?: string };
      return `${options.locale} hourCycle=${options.hourCycle ?? "?"} tz=${options.timeZone}`;
    })
  );
  rows.push(
    safeRow("Date part order", () => {
      const parts = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).formatToParts(new Date(0));
      return parts.map((p) => p.type).join(" ");
    })
  );
  rows.push(safeRow("Timezone display name", () => new Date(0).toString().replace(/^[^(]*/, "").slice(0, 60) || "(none)"));
  rows.push(
    safeRow("Number formatting", () => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(1234567.891))
  );
  rows.push(
    safeRow("Collation order", () => {
      const words = ["z", "\u00e4", "a", "\u00f6", "o", "\u00e5"];
      return words.slice().sort(new Intl.Collator().compare).join("");
    })
  );

  const supported = CSS_PROBES.filter((rule) => {
    try {
      return CSS.supports(rule);
    } catch {
      return false;
    }
  });
  rows.push({ label: "CSS features supported", value: supported.join(" · ") || "none of the probed set" });
  rows.push({
    label: "CSS features unsupported",
    value: CSS_PROBES.filter((r) => !supported.includes(r)).join(" · ") || "none — every probed feature is supported",
  });

  const perf = performance as Performance & { memory?: { jsHeapSizeLimit: number; totalJSHeapSize: number } };
  rows.push({
    label: "JS heap limit",
    value: perf.memory ? `${(perf.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(0)} MB limit` : "(not exposed — Chromium only)",
  });

  const nav = navigator as Navigator & { plugins?: { length: number; item: (i: number) => { name: string } | null } };
  rows.push(
    safeRow("Plugins", () => {
      const plugins = nav.plugins;
      if (!plugins || plugins.length === 0) return "none";
      const names: string[] = [];
      for (let i = 0; i < plugins.length; i += 1) names.push(plugins.item(i)?.name ?? "?");
      return names.join(" · ");
    })
  );

  rows.push(safeRow("Visual viewport", () => (visualViewport ? `${visualViewport.width}×${visualViewport.height} at scale ${visualViewport.scale}` : null)));
  rows.push(safeRow("Screen extended", () => String((screen as Screen & { isExtended?: boolean }).isExtended ?? "not exposed")));
  rows.push(safeAreaInsets());

  for (const [label, query] of EXTRA_MEDIA_QUERIES) {
    rows.push(safeRow(label, () => String(matchMedia(query).matches)));
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

/**
 * Runs every deep probe. All are individually guarded and time-bounded, so a
 * hostile or half-implemented API cannot stall or abort the dump.
 */
export async function collectDeepPassive(): Promise<PassiveGroup[]> {
  const [hints, gpu, audioHash, codecs, voices, rtc] = await Promise.all([
    clientHints().catch(() => [{ label: "High-entropy client hints", value: "(probe failed)" }]),
    webgpuDetail().catch(() => [{ label: "WebGPU", value: "(probe failed)" }]),
    audioSignature().catch(() => [{ label: "Audio DSP signature", value: "(probe failed)" }]),
    codecDetail().catch(() => [{ label: "Codec detail", value: "(probe failed)" }]),
    speechVoices().catch(() => [{ label: "Speech voices", value: "(probe failed)" }]),
    webrtcOffer().catch(() => [{ label: "WebRTC", value: "(probe failed)" }]),
  ]);

  return [
    {
      title: "Device model strings",
      note: "User-Agent Client Hints. On Android this names the exact handset with no prompt of any kind — the single most identifying prompt-free read on the platform.",
      rows: hints,
    },
    {
      title: "Graphics detail",
      note: "Driver limits and the named extension list. The combination pins the GPU and driver build far more tightly than the renderer string alone.",
      rows: [...graphicsDetail(), ...gpu],
    },
    {
      title: "Rendering signatures",
      note: "Hashes of this app's own test patterns, rendered on this device. Stable per device + browser + driver, which is exactly what makes them trackable — but they are only comparable to another Deep Probe run, never to a third-party fingerprint database.",
      rows: [...canvasSignature(), ...webglSignature(), ...audioHash],
    },
    {
      title: "Audio stack",
      note: "Sample rate and latency come from the real output hardware, and no permission is involved — this is not microphone access.",
      rows: audioStack(),
    },
    {
      title: "Fonts",
      note: "Detected by measuring text width, which needs no permission. The local-fonts prompt in the tier-3 sweep governs enumerating the whole list, not probing for known names.",
      rows: fontProbe(),
    },
    {
      title: "Codec detail",
      note: "Which formats decode in hardware rather than merely decoding at all, plus the encoder set. This tracks the chipset, not just the browser.",
      rows: codecs,
    },
    {
      title: "Installed voices",
      note: "The speech voice list reflects installed OS language packs — a strong locale and OS-version signal.",
      rows: voices,
    },
    {
      title: "Real-time stack",
      note: "Read from a local WebRTC offer that is never sent anywhere. The codec and header-extension list pins the browser build.",
      rows: rtc,
    },
    {
      title: "Engine behaviour",
      note: "How this engine rounds, formats, sorts and reports. Each row is weak alone; together they identify the JavaScript engine and version.",
      rows: engineBehaviour(),
    },
  ];
}
