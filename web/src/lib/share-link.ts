/**
 * Temporary share links for verification session summaries.
 *
 * The summary itself is compressed (deflate-raw) and base64url-encoded into
 * the URL FRAGMENT — nothing is ever uploaded or stored on a server, and
 * fragments are not sent in HTTP requests, so the data lives only inside the
 * link. Links self-expire: the creation timestamp is embedded and the viewer
 * refuses to render summaries older than the TTL.
 */

import type { FaceCompare, FaceStepResult, OverallResult, PageResult, SessionAiVerdicts, VerificationTemplate } from "@/lib/verification-templates";

export const SHARE_TTL_MS = 72 * 60 * 60 * 1000;

export type ShareAi = { verdict: string; confidence: number } | null;

export type SharePage = {
  label: string;
  verdict: string;
  score: number;
  confidence: number;
  outcome: string | null;
  data: string | null;
  barcode: string | null;
  ai: ShareAi;
};

export type ShareFace = {
  mode: string;
  faceCaptured: boolean;
  liveness: string | null;
  bpm: number | null;
  faces: number | null;
  score: number | null;
  ai: ShareAi;
} | null;

export type ShareMatch = { verdict: string; similarity: number; distance: number } | null;

export type ShareSummary = {
  v: 1;
  template: string;
  templateId: string;
  doc: string;
  /** Creation epoch ms — drives link expiry. */
  at: number;
  verdict: "pass" | "review" | "fail";
  reasons: string[];
  actions: string[];
  pages: SharePage[];
  face: ShareFace;
  match: ShareMatch;
};

const clip = (s: string): string => (s.length > 220 ? `${s.slice(0, 217)}…` : s);

function toShareAi(v: SessionAiVerdicts[string]): ShareAi {
  return v ? { verdict: v.verdict, confidence: v.confidence } : null;
}

/** Builds the compact, image-free summary embedded in a share link. */
export function buildShareSummary(
  template: VerificationTemplate,
  pages: PageResult[],
  face: FaceStepResult | null,
  compare: FaceCompare | null,
  overall: OverallResult,
  ai: SessionAiVerdicts
): ShareSummary {
  return {
    v: 1,
    template: template.name,
    templateId: template.id,
    doc: template.doc,
    at: Date.now(),
    verdict: overall.verdict,
    reasons: overall.reasons.slice(0, 8).map(clip),
    actions: overall.correctiveActions.slice(0, 8).map(clip),
    pages: pages.map((p) => ({
      label: p.page.label,
      verdict: p.report.verdictLabel,
      score: p.report.score,
      confidence: p.report.confidence,
      outcome: p.report.docOutcome ?? null,
      data: p.docData?.outcome ?? null,
      barcode: p.barcode?.outcome ?? null,
      ai: toShareAi(ai[p.page.id] ?? null),
    })),
    face: face
      ? {
          mode: face.mode,
          faceCaptured: face.face != null,
          liveness: face.liveness?.verdict ?? null,
          bpm: face.liveness?.pulse?.bpm ?? null,
          faces: face.facesDetected ?? null,
          score: face.report?.score ?? null,
          ai: toShareAi(ai.selfie ?? null),
        }
      : null,
    match: compare
      ? { verdict: compare.outcome.verdict, similarity: compare.outcome.similarity, distance: compare.outcome.distance }
      : null,
  };
}

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Byte-in/byte-out transform shape shared by Compression/DecompressionStream. */
type ByteTransform = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

async function pipeBytes(bytes: Uint8Array, transform: ByteTransform): Promise<Uint8Array> {
  // Copy into a plain ArrayBuffer — Blob rejects views over SharedArrayBuffer-typed buffers.
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const readable = new Blob([buffer]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(readable).arrayBuffer());
}

/** Payload format: "1.<b64url deflate-raw>" (compressed) or "0.<b64url utf8>" (fallback). */
export async function encodeShareSummary(summary: ShareSummary): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(summary));
  if (typeof CompressionStream !== "undefined") {
    try {
      const packed = await pipeBytes(json, new CompressionStream("deflate-raw") as unknown as ByteTransform);
      return `1.${toB64Url(packed)}`;
    } catch {
      // fall through to the uncompressed format
    }
  }
  return `0.${toB64Url(json)}`;
}

export async function decodeShareSummary(payload: string): Promise<ShareSummary> {
  if (payload.length < 3 || payload[1] !== ".") throw new Error("This link does not contain a valid shared summary.");
  const mode = payload[0];
  let body: Uint8Array;
  try {
    body = fromB64Url(payload.slice(2));
  } catch {
    throw new Error("The shared summary data is corrupted — the link was probably truncated when copied.");
  }
  let jsonBytes: Uint8Array;
  if (mode === "1") {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decode compressed share links — try a current browser.");
    try {
      jsonBytes = await pipeBytes(body, new DecompressionStream("deflate-raw") as unknown as ByteTransform);
    } catch {
      throw new Error("The shared summary data is corrupted — the link was probably truncated when copied.");
    }
  } else if (mode === "0") {
    jsonBytes = body;
  } else {
    throw new Error("Unknown share-link format version.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw new Error("The shared summary data is corrupted — the link was probably truncated when copied.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { at?: unknown }).at !== "number" ||
    !["pass", "review", "fail"].includes(String((parsed as { verdict?: unknown }).verdict)) ||
    !Array.isArray((parsed as { pages?: unknown }).pages)
  ) {
    throw new Error("This link does not contain a valid shared summary.");
  }
  return sanitizeSummary(parsed as Record<string, unknown>);
}

const asStr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asNum = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const asNumOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asStrOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asStrArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : []);

function sanitizeAi(v: unknown): ShareAi {
  if (typeof v !== "object" || v === null) return null;
  const o = v as { verdict?: unknown; confidence?: unknown };
  if (typeof o.verdict !== "string") return null;
  return { verdict: o.verdict, confidence: asNum(o.confidence) };
}

/**
 * Coerces every decoded field to its expected primitive type so a forged or
 * corrupted link can never crash the viewer (React throws when asked to
 * render a non-primitive child). Also clamps a future creation timestamp to
 * "now" so a crafted link cannot claim more than the 72 h TTL.
 */
function sanitizeSummary(p: Record<string, unknown>): ShareSummary {
  const pages: SharePage[] = (p.pages as unknown[]).slice(0, 8).map((raw): SharePage => {
    const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      label: asStr(o.label, "Document page"),
      verdict: asStr(o.verdict, "unknown"),
      score: asNum(o.score),
      confidence: asNum(o.confidence),
      outcome: asStrOrNull(o.outcome),
      data: asStrOrNull(o.data),
      barcode: asStrOrNull(o.barcode),
      ai: sanitizeAi(o.ai),
    };
  });
  const rawFace = typeof p.face === "object" && p.face !== null ? (p.face as Record<string, unknown>) : null;
  const face: ShareFace = rawFace
    ? {
        mode: asStr(rawFace.mode, "unknown"),
        faceCaptured: rawFace.faceCaptured === true,
        liveness: asStrOrNull(rawFace.liveness),
        bpm: asNumOrNull(rawFace.bpm),
        faces: asNumOrNull(rawFace.faces),
        score: asNumOrNull(rawFace.score),
        ai: sanitizeAi(rawFace.ai),
      }
    : null;
  const rawMatch = typeof p.match === "object" && p.match !== null ? (p.match as Record<string, unknown>) : null;
  const match: ShareMatch =
    rawMatch && typeof rawMatch.verdict === "string"
      ? { verdict: rawMatch.verdict, similarity: asNum(rawMatch.similarity), distance: asNum(rawMatch.distance) }
      : null;
  return {
    v: 1,
    template: asStr(p.template, "Verification session"),
    templateId: asStr(p.templateId),
    doc: asStr(p.doc),
    at: Math.min(asNum(p.at), Date.now()),
    verdict: p.verdict as ShareSummary["verdict"],
    reasons: asStrArray(p.reasons),
    actions: asStrArray(p.actions),
    pages,
    face,
    match,
  };
}

export function shareExpiry(summary: ShareSummary): { expired: boolean; expiresAt: number; remainingMs: number } {
  const expiresAt = summary.at + SHARE_TTL_MS;
  const remainingMs = expiresAt - Date.now();
  return { expired: remainingMs <= 0, expiresAt, remainingMs };
}
