import ExifReader, { type Tags as ExifTags } from "exifreader";

import type { MediaFraudReport } from "./fraud-detection";

export type LogLevel = "info" | "success" | "warn" | "error" | "debug";

export type LogEntry = {
  id: string;
  ts: string;
  level: LogLevel;
  message: string;
};

/** Millisecond provenance facts recorded around one native camera round-trip. */
export type NativeTripFacts = {
  /** Epoch ms when the capture button was pressed. */
  pressedAt: number;
  changeIsTrusted?: boolean;
  elapsedSincePressMs?: number;
  pageLoadedAt?: number;
  filesApiNative?: boolean;
  pressIsTrusted?: boolean;
  pageHiddenDuring?: boolean;
};

export type GalleryItem = {
  id: string;
  blob: Blob;
  url: string;
  name: string;
  source: "shutter" | "native" | "file";
  createdAt: string;
  /** Epoch ms when the item entered the gallery (post-screening) — used by the per-photo timeline export. */
  createdAtEpochMs: number;
  size: number;
  mimeType: string;
  dimensions?: { width: number; height: number };
  exifSummary: string;
  binaryMarkers: string;
  hasExif: boolean;
  /** Automatic fraud screening result attached on arrival. */
  fraud?: MediaFraudReport;
  /** Present only for native captures — round-trip provenance recorded at capture time. */
  nativeTrip?: NativeTripFacts;
};

export type StatusTone = "ok" | "bad" | "warn" | "neutral";

export type EnvStatus = {
  label: string;
  value: string;
  tone: StatusTone;
};

export type ConstraintDraft = {
  minWidth: string;
  minHeight: string;
  maxWidth: string;
  maxHeight: string;
  idealWidth: string;
  idealHeight: string;
  frameRate: string;
  aspectRatio: string;
};

export type CropState = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ResolutionPreset = "max" | "hd" | "720p" | "custom";

export function nowTime(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

export function createLogId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function makeLog(level: LogLevel, message: string): LogEntry {
  return {
    id: createLogId(),
    ts: nowTime(),
    level,
    message,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function hasMediaDevices(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export function hasImageCapture(): boolean {
  return typeof window !== "undefined" && "ImageCapture" in window;
}

export function isSecureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext;
}

export function checkJpegMarkers(buffer: ArrayBuffer): {
  hasSOI: boolean;
  hasAPP1: boolean;
  hasExifAscii: boolean;
  summary: string;
} {
  const bytes = new Uint8Array(buffer);
  const hasSOI = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  let hasAPP1 = false;
  let hasExifAscii = false;

  if (bytes.length >= 4) {
    for (let i = 0; i < Math.min(bytes.length - 1, 64); i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xe1) {
        hasAPP1 = true;
        break;
      }
    }
  }

  const ascii = new TextDecoder("ascii").decode(bytes.slice(0, Math.min(bytes.length, 256)));
  hasExifAscii = ascii.includes("Exif");

  const parts = [
    hasSOI ? "SOI ✓" : "SOI ✗",
    hasAPP1 ? "APP1 ✓" : "APP1 ✗",
    hasExifAscii ? "Exif ASCII ✓" : "Exif ASCII ✗",
  ];

  return {
    hasSOI,
    hasAPP1,
    hasExifAscii,
    summary: parts.join(" · "),
  };
}

export function summarizeExifTags(tags: ExifTags): string {
  const pick = (key: string): string | null => {
    const tag = tags[key];
    if (!tag) return null;
    const value = "description" in tag ? tag.description : String(tag);
    if (value == null || value === "") return null;
    return `${key}: ${value}`;
  };

  const keys = [
    "Make",
    "Model",
    "DateTimeOriginal",
    "DateTime",
    "Orientation",
    "GPSLatitude",
    "GPSLongitude",
    "LensModel",
    "FocalLength",
    "FNumber",
    "ISOSpeedRatings",
    "ExposureTime",
    "ImageWidth",
    "ImageHeight",
    "PixelXDimension",
    "PixelYDimension",
  ];

  const lines = keys.map(pick).filter((line): line is string => !!line);
  if (lines.length === 0) {
    const allKeys = Object.keys(tags).filter((k) => !k.startsWith("Thumbnail"));
    if (allKeys.length === 0) return "No EXIF tags found";
    return `Tags present (${allKeys.length}): ${allKeys.slice(0, 12).join(", ")}${allKeys.length > 12 ? "…" : ""}`;
  }
  return lines.join(" | ");
}

export async function analyzeImageBlob(blob: Blob): Promise<{
  hasExif: boolean;
  exifSummary: string;
  binaryMarkers: string;
  dimensions?: { width: number; height: number };
}> {
  const buffer = await blob.arrayBuffer();
  const markers = checkJpegMarkers(buffer);

  let hasExif = markers.hasAPP1 || markers.hasExifAscii;
  let exifSummary = "EXIF parse skipped (non-JPEG or empty)";
  let dimensions: { width: number; height: number } | undefined;

  try {
    const tags = ExifReader.load(buffer, { expanded: false });
    exifSummary = summarizeExifTags(tags);
    hasExif = hasExif || Object.keys(tags).length > 0;

    const w =
      (tags["Image Width"] as { value?: number } | undefined)?.value ??
      (tags.PixelXDimension as { value?: number } | undefined)?.value ??
      (tags.ImageWidth as { value?: number } | undefined)?.value;
    const h =
      (tags["Image Height"] as { value?: number } | undefined)?.value ??
      (tags.PixelYDimension as { value?: number } | undefined)?.value ??
      (tags.ImageHeight as { value?: number } | undefined)?.value;

    if (typeof w === "number" && typeof h === "number") {
      dimensions = { width: w, height: h };
    }
  } catch {
    exifSummary = "ExifReader could not parse metadata";
  }

  if (!dimensions) {
    dimensions = await readImageDimensions(blob);
  }

  return {
    hasExif,
    exifSummary,
    binaryMarkers: markers.summary,
    dimensions,
  };
}

function readImageDimensions(blob: Blob): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(undefined);
    };
    img.src = url;
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function trackSettings(track: MediaStreamTrack | null | undefined): MediaTrackSettings | null {
  try {
    return track?.getSettings?.() ?? null;
  } catch {
    return null;
  }
}

export function trackCapabilities(track: MediaStreamTrack | null | undefined): MediaTrackCapabilities | null {
  try {
    return track?.getCapabilities?.() ?? null;
  } catch {
    return null;
  }
}

export function formatSettings(settings: MediaTrackSettings | null): string {
  if (!settings) return "no settings";
  const bits: string[] = [];
  if (settings.width && settings.height) bits.push(`${settings.width}×${settings.height}`);
  if (settings.frameRate != null) bits.push(`${Math.round(settings.frameRate)}fps`);
  if (settings.facingMode) bits.push(`facing=${settings.facingMode}`);
  if (settings.deviceId) bits.push(`deviceId=${settings.deviceId.slice(0, 10)}…`);
  if (settings.aspectRatio != null) bits.push(`ar=${Number(settings.aspectRatio).toFixed(3)}`);
  if ((settings as MediaTrackSettings & { zoom?: number }).zoom != null) {
    bits.push(`zoom=${(settings as MediaTrackSettings & { zoom?: number }).zoom}`);
  }
  if ((settings as MediaTrackSettings & { torch?: boolean }).torch != null) {
    bits.push(`torch=${(settings as MediaTrackSettings & { torch?: boolean }).torch}`);
  }
  return bits.join(" · ") || JSON.stringify(settings);
}

export function formatCapabilities(caps: MediaTrackCapabilities | null): string {
  if (!caps) return "no capabilities";
  const bits: string[] = [];
  const width = caps.width as { min?: number; max?: number } | undefined;
  const height = caps.height as { min?: number; max?: number } | undefined;
  const frameRate = caps.frameRate as { min?: number; max?: number } | undefined;
  const zoom = (caps as MediaTrackCapabilities & { zoom?: { min?: number; max?: number } }).zoom;
  const torch = (caps as MediaTrackCapabilities & { torch?: boolean }).torch;

  if (width?.max && height?.max) bits.push(`max ${width.max}×${height.max}`);
  if (width?.min && height?.min) bits.push(`min ${width.min}×${height.min}`);
  if (frameRate?.max != null) bits.push(`fps max ${frameRate.max}`);
  if (zoom?.max != null) bits.push(`zoom ${zoom.min ?? 1}–${zoom.max}`);
  if (torch) bits.push("torch supported");
  if (caps.facingMode?.length) bits.push(`facing=${caps.facingMode.join(",")}`);
  return bits.join(" · ") || "capabilities present";
}

export function buildVideoConstraints(options: {
  facingMode?: "user" | "environment";
  deviceId?: string;
  width?: number | { min?: number; max?: number; ideal?: number };
  height?: number | { min?: number; max?: number; ideal?: number };
  frameRate?: number | { min?: number; max?: number; ideal?: number };
  aspectRatio?: number | { exact?: number; ideal?: number };
}): MediaStreamConstraints {
  const video: MediaTrackConstraints = {};

  if (options.deviceId) {
    video.deviceId = { exact: options.deviceId };
  } else if (options.facingMode) {
    video.facingMode = { ideal: options.facingMode };
  }

  if (options.width !== undefined) video.width = options.width;
  if (options.height !== undefined) video.height = options.height;
  if (options.frameRate !== undefined) video.frameRate = options.frameRate;
  if (options.aspectRatio !== undefined) video.aspectRatio = options.aspectRatio;

  return { audio: false, video };
}

export function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export function constraintsFromDraft(
  draft: ConstraintDraft,
  mode:
    | "both-min"
    | "only-min-width"
    | "only-min-height"
    | "only-max"
    | "full"
    | "custom"
): MediaTrackConstraints {
  const minW = parseOptionalNumber(draft.minWidth);
  const minH = parseOptionalNumber(draft.minHeight);
  const maxW = parseOptionalNumber(draft.maxWidth);
  const maxH = parseOptionalNumber(draft.maxHeight);
  const idealW = parseOptionalNumber(draft.idealWidth);
  const idealH = parseOptionalNumber(draft.idealHeight);
  const fps = parseOptionalNumber(draft.frameRate);
  const ar = parseOptionalNumber(draft.aspectRatio);

  const video: MediaTrackConstraints = {};

  if (mode === "only-min-width") {
    if (minW != null) video.width = { min: minW };
  } else if (mode === "only-min-height") {
    if (minH != null) video.height = { min: minH };
  } else if (mode === "both-min") {
    if (minW != null) video.width = { min: minW };
    if (minH != null) video.height = { min: minH };
  } else if (mode === "only-max") {
    if (maxW != null) video.width = { max: maxW };
    if (maxH != null) video.height = { max: maxH };
  } else {
    const width: { min?: number; max?: number; ideal?: number } = {};
    const height: { min?: number; max?: number; ideal?: number } = {};
    if (minW != null) width.min = minW;
    if (maxW != null) width.max = maxW;
    if (idealW != null) width.ideal = idealW;
    if (minH != null) height.min = minH;
    if (maxH != null) height.max = maxH;
    if (idealH != null) height.ideal = idealH;
    if (Object.keys(width).length) video.width = width;
    if (Object.keys(height).length) video.height = height;
  }

  if (fps != null) video.frameRate = { ideal: fps };
  if (ar != null) video.aspectRatio = { ideal: ar };

  return video;
}

export function defaultConstraintDraft(): ConstraintDraft {
  return {
    minWidth: "1280",
    minHeight: "720",
    maxWidth: "3840",
    maxHeight: "2160",
    idealWidth: "1920",
    idealHeight: "1080",
    frameRate: "30",
    aspectRatio: "",
  };
}

export function defaultCrop(): CropState {
  return { left: 0, top: 0, width: 100, height: 100 };
}

export async function captureFromVideo(video: HTMLVideoElement): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error("Video has no frame yet (videoWidth/videoHeight is 0)");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2d canvas context");
  ctx.drawImage(video, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95);
  });
  if (!blob) throw new Error("canvas.toBlob returned null");
  return blob;
}

export async function captureWithImageCapture(track: MediaStreamTrack): Promise<Blob> {
  // ImageCapture is not in all TS libs; use runtime check
  const ImageCaptureCtor = (window as unknown as { ImageCapture?: new (track: MediaStreamTrack) => {
    takePhoto: () => Promise<Blob>;
  } }).ImageCapture;

  if (!ImageCaptureCtor) {
    throw new Error("ImageCapture API not available");
  }

  const capture = new ImageCaptureCtor(track);
  return capture.takePhoto();
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      // ignore
    }
  });
}

export type SuiteTestResult = {
  id: string;
  name: string;
  ok: boolean;
  granted?: string;
  error?: string;
  durationMs: number;
};

export type SuiteTestDef = {
  name: string;
  build: (facing: "user" | "environment") => MediaTrackConstraints;
};

/**
 * Every getUserMedia request pattern this app exposes, parametrized by facing.
 * facingMode uses `exact` inside the suite so the requested camera is guaranteed
 * (or the browser throws OverconstrainedError — which is itself a valid result).
 */
export const SUITE_TESTS: SuiteTestDef[] = [
  { name: "facingMode exact", build: (f) => ({ facingMode: { exact: f } }) },
  { name: "facingMode ideal", build: (f) => ({ facingMode: { ideal: f } }) },
  {
    name: "720p ideal",
    build: (f) => ({ facingMode: { exact: f }, width: { ideal: 1280 }, height: { ideal: 720 } }),
  },
  {
    name: "1080p ideal",
    build: (f) => ({ facingMode: { exact: f }, width: { ideal: 1920 }, height: { ideal: 1080 } }),
  },
  {
    name: "4K ideal",
    build: (f) => ({ facingMode: { exact: f }, width: { ideal: 3840 }, height: { ideal: 2160 } }),
  },
  {
    name: "Impossible 8K ideal",
    build: (f) => ({ facingMode: { exact: f }, width: { ideal: 7680 }, height: { ideal: 4320 } }),
  },
  { name: "ONLY minWidth 1280", build: (f) => ({ facingMode: { exact: f }, width: { min: 1280 } }) },
  { name: "ONLY minHeight 720", build: (f) => ({ facingMode: { exact: f }, height: { min: 720 } }) },
  {
    name: "Both min 1280×720",
    build: (f) => ({ facingMode: { exact: f }, width: { min: 1280 }, height: { min: 720 } }),
  },
  {
    name: "ONLY max 640×480",
    build: (f) => ({ facingMode: { exact: f }, width: { max: 640 }, height: { max: 480 } }),
  },
  {
    name: "Extreme min 4K",
    build: (f) => ({ facingMode: { exact: f }, width: { min: 3840 }, height: { min: 2160 } }),
  },
  { name: "60fps ideal", build: (f) => ({ facingMode: { exact: f }, frameRate: { ideal: 60 } }) },
  { name: "240fps ideal", build: (f) => ({ facingMode: { exact: f }, frameRate: { ideal: 240 } }) },
  { name: "min 120fps (hard)", build: (f) => ({ facingMode: { exact: f }, frameRate: { min: 120 } }) },
  {
    name: "Portrait 1080×1920 + 9:16",
    build: (f) => ({
      facingMode: { exact: f },
      width: { ideal: 1080 },
      height: { ideal: 1920 },
      aspectRatio: { ideal: 9 / 16 },
    }),
  },
  {
    name: "Landscape 1920×1080 + 16:9",
    build: (f) => ({
      facingMode: { exact: f },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      aspectRatio: { ideal: 16 / 9 },
    }),
  },
  { name: "aspectRatio 16/9 only", build: (f) => ({ facingMode: { exact: f }, aspectRatio: { ideal: 16 / 9 } }) },
  {
    name: "aspectRatio exact 1 (square)",
    build: (f) => ({ facingMode: { exact: f }, aspectRatio: { exact: 1 } }),
  },
  {
    name: "Extreme mix min 4K + 120fps",
    build: (f) => ({
      facingMode: { exact: f },
      width: { min: 3840 },
      height: { min: 2160 },
      frameRate: { ideal: 120 },
    }),
  },
];

/**
 * Runs one getUserMedia probe: request, read granted settings + capabilities, stop tracks.
 */
export async function probeConstraints(video: MediaTrackConstraints): Promise<{
  settings: MediaTrackSettings | null;
  capabilities: MediaTrackCapabilities | null;
  trackLabel: string;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  try {
    const track = stream.getVideoTracks()[0] ?? null;
    return {
      settings: trackSettings(track),
      capabilities: trackCapabilities(track),
      trackLabel: track?.label ?? "",
    };
  } finally {
    stopStream(stream);
  }
}
