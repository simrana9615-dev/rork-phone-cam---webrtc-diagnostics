import type { AiMediaVerdict } from "./fraud-detection";

/**
 * Deep AI verdict via the Rork Toolkit proxy → Vercel AI Gateway chat completions.
 * Model: google/gemini-3.5-flash (vision). Endpoint: /v2/vercel/v1/chat/completions.
 */
const MODEL_ID = "google/gemini-3.5-flash";

const TOOLKIT_URL: string | undefined = import.meta.env.EXPO_PUBLIC_TOOLKIT_URL as string | undefined;
const TOOLKIT_KEY: string | undefined = import.meta.env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY as string | undefined;

export function aiVerdictAvailable(): boolean {
  return !!TOOLKIT_URL && !!TOOLKIT_KEY;
}

/** Vercel edge rejects bodies > 4.5 MB; keep total raw image bytes well under that. */
const TOTAL_IMAGE_BYTE_BUDGET = 2_500_000;

const RESIZE_LADDER: { maxEdge: number; quality: number }[] = [
  { maxEdge: 1280, quality: 0.82 },
  { maxEdge: 1024, quality: 0.78 },
  { maxEdge: 832, quality: 0.74 },
  { maxEdge: 640, quality: 0.7 },
  { maxEdge: 512, quality: 0.65 },
];

function dataUrlRawBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  return Math.floor(b64.length * 0.75);
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Browser cannot decode this image format"));
    };
    img.src = url;
  });
}

function drawToDataUrl(source: CanvasImageSource, srcW: number, srcH: number, maxEdge: number, quality: number): string {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.max(8, Math.round(srcW * scale));
  const h = Math.max(8, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2d context unavailable");
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Re-encodes an image against a byte budget using the resize/quality ladder. */
export async function resizeImageForAi(blob: Blob, maxBytes: number): Promise<string> {
  const img = await loadImage(blob);
  for (const step of RESIZE_LADDER) {
    const dataUrl = drawToDataUrl(img, img.naturalWidth, img.naturalHeight, step.maxEdge, step.quality);
    if (dataUrlRawBytes(dataUrl) <= maxBytes) return dataUrl;
  }
  throw new Error("IMAGE_TOO_LARGE: could not fit the image within the upload budget");
}

/** Samples frames evenly across a video's timeline and returns JPEG data URLs. */
export async function extractVideoFrames(blob: Blob, count: number, perFrameBytes: number): Promise<string[]> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Video metadata load timed out")), 15000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Browser cannot decode this video (codec unsupported)"));
      };
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("Video has no decodable video track");
    }

    const fractions = duration > 0 ? [0.08, 0.3, 0.5, 0.72, 0.92].slice(0, count) : [0];
    const frames: string[] = [];

    for (const fraction of fractions) {
      const target = duration * fraction;
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(`Seek to ${target.toFixed(1)}s timed out`)), 10000);
        const onSeeked = () => {
          window.clearTimeout(timeout);
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = Math.max(0.05, target);
      });

      for (const step of RESIZE_LADDER) {
        const dataUrl = drawToDataUrl(video, video.videoWidth, video.videoHeight, Math.min(step.maxEdge, 800), step.quality);
        if (dataUrlRawBytes(dataUrl) <= perFrameBytes) {
          frames.push(dataUrl);
          break;
        }
      }
    }

    if (frames.length === 0) throw new Error("Could not extract any frames within the upload budget");
    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}

const IMAGE_SYSTEM_PROMPT = `You are a forensic media analyst specializing in detecting AI-generated and manipulated images, including deepfakes.
Inspect the image for: anatomy errors (hands, teeth, ears, eyes), face-swap blending boundaries along the jawline/hairline, mismatched skin texture between face and neck, unnatural eye geometry or dead specular highlights, asymmetrical or impossible lighting and shadows, inconsistent reflections, garbled or pseudo-text, texture over-smoothing or "plastic skin", background warping, repeating patterns, chromatic inconsistencies, splice edges, clone stamps, moiré/pixel-grid patterns from re-photographed screens, and physically impossible geometry.
Be conservative: real photos are often compressed, noisy, or oddly lit — do not call a file fake on one weak cue. Require multiple independent artifacts for high confidence, and report confidence honestly.
Respond with STRICT JSON only, no markdown fences, matching:
{"verdict":"authentic"|"ai-generated"|"manipulated"|"uncertain","confidence":0-100,"reasoning":"2-4 sentences","indicators":["short indicator", ...]}`;

const VIDEO_SYSTEM_PROMPT = `You are a forensic media analyst specializing in detecting AI-generated video, deepfakes, and injected/replayed feeds.
You receive several frames sampled across one video's timeline, in chronological order.
Inspect for: temporal identity drift between frames (face/objects subtly changing identity), face-swap blending boundaries along jawline/hairline, unnatural eyes/teeth, lighting direction inconsistent across frames or between face and scene, morphing objects, garbled text, impossible physics, AI texture smoothing, warped backgrounds, moiré/banding from a re-filmed display, and frozen/static frames posing as live footage.
Be conservative: compression artifacts and low light mimic some cues — require multiple independent artifacts for high confidence, and report confidence honestly.
Respond with STRICT JSON only, no markdown fences, matching:
{"verdict":"authentic"|"ai-generated"|"manipulated"|"uncertain","confidence":0-100,"reasoning":"2-4 sentences","indicators":["short indicator", ...]}`;

const EXTRACTION_SYSTEM_PROMPT = `You are the OCR stage of an identity-verification pipeline (equivalent to IDVerse DocXtract / Innovatrics document inspection). You receive one photo of an identity document.
Task 1 — MRZ: if a Machine Readable Zone is visible (2 or 3 lines of monospaced OCR-B text with "<" fillers: passports 2 lines x 44 chars, ID cards 3 lines x 30, other IDs 2 lines x 36), transcribe it VERBATIM character by character, including every "<" filler and preserving exact line lengths. Do NOT correct, normalize, or guess characters — transcribe exactly what is printed even if a checksum would fail. If no MRZ is visible return an empty array.
Task 2 — visual zone: read the printed human-readable fields only (never copy from the MRZ): full name, document number, date of birth, expiry date, nationality, document type. Dates as YYYY-MM-DD. Use null for unreadable or absent fields.
Date order: Australia, the UK, NZ and most of Europe print dates DAY-FIRST (DD/MM/YYYY or "14 JAN 2030"). NEVER assume US month-first order — resolve ambiguous numeric dates from the printed month name or field label, and if the order is truly ambiguous prefer day-first.
Australian driver licences: each state/territory (NSW, VIC, QLD, WA, SA, TAS, ACT, NT) has its own layout. Report the LICENCE NUMBER as documentNumber — NOT the separate card number (a second anti-fraud number printed on modern Australian licences). Put the card number in notes as "card number: ...". Include the issuing state in documentType (e.g. "NSW driver licence").
Australian passports: document number is two letters + 7 digits (e.g. PA1234567); sex may legally be X.
Task 3 — note visible anomalies as short strings (e.g. "portrait edge halo", "font weight differs on expiry field", "no hologram sheen", "glare covers MRZ").
Respond with STRICT JSON only, no markdown fences, matching:
{"mrzLines":["line1","line2"],"visual":{"fullName":string|null,"documentNumber":string|null,"birthDate":string|null,"expiryDate":string|null,"nationality":string|null,"documentType":string|null},"notes":["..."]}`;

export type DocumentExtraction = {
  mrzLines: string[];
  mrzReadable: boolean;
  visual: {
    fullName: string | null;
    documentNumber: string | null;
    birthDate: string | null;
    expiryDate: string | null;
    nationality: string | null;
    documentType: string | null;
  };
  notes: string[];
  model: string;
};

type ChatImagePart = { type: "image_url"; image_url: { url: string } };
type ChatTextPart = { type: "text"; text: string };

function parseVerdictJson(content: string): Omit<AiMediaVerdict, "model" | "framesAnalyzed"> {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) text = text.slice(braceStart, braceEnd + 1);

  const parsed = JSON.parse(text) as {
    verdict?: string;
    confidence?: number;
    reasoning?: string;
    indicators?: unknown;
  };
  const verdict =
    parsed.verdict === "ai-generated" || parsed.verdict === "manipulated" || parsed.verdict === "authentic"
      ? parsed.verdict
      : "uncertain";
  const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 0))));
  const indicators = Array.isArray(parsed.indicators)
    ? parsed.indicators.filter((i): i is string => typeof i === "string").slice(0, 8)
    : [];
  return {
    verdict,
    confidence,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning returned.",
    indicators,
  };
}

async function callVisionModel(systemPrompt: string, userText: string, imageDataUrls: string[]): Promise<string> {
  if (!TOOLKIT_URL || !TOOLKIT_KEY) {
    throw new Error("AI verdict unavailable: toolkit credentials are not configured");
  }
  const content: (ChatTextPart | ChatImagePart)[] = [
    { type: "text", text: userText },
    ...imageDataUrls.map<ChatImagePart>((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const res = await fetch(`${TOOLKIT_URL}/v2/vercel/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOOLKIT_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_ID,
      temperature: 0.1,
      max_tokens: 900,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI response contained no content");
  return text;
}

function parseExtractionJson(content: string): Omit<DocumentExtraction, "model"> {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) text = text.slice(braceStart, braceEnd + 1);
  const parsed = JSON.parse(text) as {
    mrzLines?: unknown;
    visual?: Record<string, unknown>;
    notes?: unknown;
  };
  const mrzLines = Array.isArray(parsed.mrzLines)
    ? parsed.mrzLines.filter((l): l is string => typeof l === "string" && l.replace(/\s+/g, "").length >= 20).slice(0, 3)
    : [];
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const v = parsed.visual ?? {};
  return {
    mrzLines,
    mrzReadable: mrzLines.length >= 2,
    visual: {
      fullName: str(v.fullName),
      documentNumber: str(v.documentNumber),
      birthDate: str(v.birthDate),
      expiryDate: str(v.expiryDate),
      nationality: str(v.nationality),
      documentType: str(v.documentType),
    },
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === "string").slice(0, 8) : [],
  };
}

/**
 * Vision-model OCR of an ID document: verbatim MRZ transcription + printed
 * visual-zone fields. Validation happens locally (ICAO 9303, see lib/mrz.ts).
 */
export async function extractDocumentData(blob: Blob): Promise<DocumentExtraction> {
  const dataUrl = await resizeImageForAi(blob, TOTAL_IMAGE_BYTE_BUDGET);
  const raw = await callVisionModel(
    EXTRACTION_SYSTEM_PROMPT,
    "Transcribe the MRZ verbatim and read the printed visual-zone fields. Return the strict JSON.",
    [dataUrl]
  );
  return { ...parseExtractionJson(raw), model: MODEL_ID };
}

/** Sends a photo to the vision model for a fake/real verdict. */
export async function requestImageAiVerdict(blob: Blob): Promise<AiMediaVerdict> {
  const dataUrl = await resizeImageForAi(blob, TOTAL_IMAGE_BYTE_BUDGET);
  const raw = await callVisionModel(
    IMAGE_SYSTEM_PROMPT,
    "Analyze this image and return the strict JSON verdict.",
    [dataUrl]
  );
  return { ...parseVerdictJson(raw), model: MODEL_ID };
}

/** Samples frames across a video and sends them to the vision model for a verdict. */
export async function requestVideoAiVerdict(blob: Blob): Promise<AiMediaVerdict> {
  const frameCount = 4;
  const frames = await extractVideoFrames(blob, frameCount, Math.floor(TOTAL_IMAGE_BYTE_BUDGET / frameCount));
  const raw = await callVisionModel(
    VIDEO_SYSTEM_PROMPT,
    `These are ${frames.length} frames sampled chronologically across one video. Analyze them together and return the strict JSON verdict.`,
    frames
  );
  return { ...parseVerdictJson(raw), model: MODEL_ID, framesAnalyzed: frames.length };
}
