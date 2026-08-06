/**
 * Verification session persistence (IndexedDB): captured page blobs, forensic
 * reports, face step results, and AI verdicts survive a page reload — critical
 * on phones where switching to the native camera app can evict the tab.
 *
 * IndexedDB structured clone handles Blob and Float32Array natively, so the
 * session objects are stored as-is (object URLs are recreated on restore).
 */

import type { AiMediaVerdict, MediaFraudReport } from "@/lib/fraud-detection";
import type { FaceDescription } from "@/lib/face-vision";
import type { PackOrigin } from "@/lib/evidence-pack";
import type { DocumentDataCheck } from "@/lib/mrz";
import type { LicenceBarcodeCheck } from "@/lib/pdf417";
import type { QuickQuality } from "@/lib/capture-quality";
import type { FaceMode, LivenessResult } from "@/lib/verification-templates";

export type StoredPage = {
  pageId: string;
  blob: Blob;
  fileName: string;
  captureMeta: string;
  /** Capture provenance tier, persisted so a resumed session keeps telling the truth. */
  origin: PackOrigin;
  report: MediaFraudReport;
  portrait: FaceDescription | null;
  docData: DocumentDataCheck | null;
  barcode: LicenceBarcodeCheck | null;
  quickQuality: QuickQuality | null;
};

export type StoredFace = {
  mode: FaceMode;
  face: FaceDescription | null;
  /** Data-URL snapshot (liveness identity frame). */
  imageDataUrl: string | null;
  /** Original file blob (native selfie). */
  imageBlob: Blob | null;
  report: MediaFraudReport | null;
  liveness: LivenessResult | null;
  facesDetected: number | null;
};

export type StoredSession = {
  key: string;
  savedAt: number;
  stepIndex: number;
  pages: StoredPage[];
  face: StoredFace | null;
  ai: Record<string, AiMediaVerdict | null>;
};

const DB_NAME = "verify-sessions";
const STORE = "sessions";
const DB_VERSION = 1;
/** Sessions older than this are discarded on load. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Saves (upserts) the current session snapshot. Best-effort — failures are swallowed by callers. */
export async function saveSession(session: StoredSession): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(session);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** Loads a stored session for the given key; returns null when absent or expired. */
export async function loadSession(key: string): Promise<StoredSession | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    const result = await new Promise<StoredSession | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as StoredSession | undefined);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    });
    if (!result) return null;
    if (Date.now() - result.savedAt > MAX_AGE_MS) {
      const del = db.transaction(STORE, "readwrite");
      del.objectStore(STORE).delete(key);
      await txDone(del).catch(() => undefined);
      return null;
    }
    return result;
  } finally {
    db.close();
  }
}

/** Removes a stored session (on Start Over or explicit discard). */
export async function clearSession(key: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    await txDone(tx);
  } finally {
    db.close();
  }
}
