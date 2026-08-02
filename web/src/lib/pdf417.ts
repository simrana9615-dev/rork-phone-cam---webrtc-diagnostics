/**
 * Licence-back data layer: PDF417 barcode reading (native BarcodeDetector with
 * a ZXing fallback, rotation-tolerant) plus AAMVA payload parsing and
 * deterministic cross-checks against the front-side OCR — the driver's-licence
 * equivalent of the passport MRZ check.
 *
 * The barcode decode is fully local and deterministic. Cross-checks compare it
 * against the (model-based) front-side OCR, so a single field disagreement is
 * treated as REVIEW (possible OCR misread) and only multiple corroborated
 * mismatches reach FAIL — same policy as the MRZ↔VIZ validation.
 */

import type { Finding } from "@/lib/fraud-detection";
import type { DocumentDataCheck } from "@/lib/mrz";

export type AamvaFields = {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  fullName: string | null;
  birthDate: string | null;
  expiryDate: string | null;
  issueDate: string | null;
  documentNumber: string | null;
  sex: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressPostal: string | null;
  country: string | null;
  issuerIin: string | null;
  aamvaVersion: number | null;
};

export type LicenceBarcodeCheck = {
  outcome: "parsed" | "raw-only" | "unreadable";
  summary: string;
  /** Which decoder produced the read. */
  engine: string | null;
  raw: string | null;
  fields: AamvaFields | null;
  findings: Finding[];
  generatedAt: string;
};

type DetectedBarcode = { rawValue: string; format: string };
type BarcodeDetectorLike = { detect(source: ImageBitmapSource): Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = (new (opts?: { formats?: string[] }) => BarcodeDetectorLike) & {
  getSupportedFormats?: () => Promise<string[]>;
};

const DECODE_EDGE = 1800;

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
      reject(new Error("Cannot decode image for barcode reading"));
    };
    img.src = url;
  });
}

function drawRotated(img: HTMLImageElement, degrees: 0 | 90 | 180 | 270): HTMLCanvasElement {
  const scale = Math.min(1, DECODE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(16, Math.round(img.naturalWidth * scale));
  const h = Math.max(16, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  const swap = degrees === 90 || degrees === 270;
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return canvas;
}

/** Reads a PDF417 barcode from a photo. Tries the native BarcodeDetector, then ZXing across 4 rotations. */
export async function readPdf417(blob: Blob, onStep?: (msg: string) => void): Promise<{ raw: string; engine: string } | null> {
  const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (BD) {
    try {
      const supported = (await BD.getSupportedFormats?.()) ?? [];
      if (supported.length === 0 || supported.includes("pdf417")) {
        onStep?.("Scanning for PDF417 with the native BarcodeDetector…");
        const bmp = await createImageBitmap(blob);
        try {
          const detector = new BD({ formats: ["pdf417"] });
          const codes = await detector.detect(bmp);
          const hit = codes.find((c) => c.rawValue.length > 0);
          if (hit) return { raw: hit.rawValue, engine: "BarcodeDetector (native)" };
        } finally {
          bmp.close();
        }
      }
    } catch {
      // fall through to ZXing
    }
  }

  onStep?.("Scanning for PDF417 with ZXing (4 rotations)…");
  try {
    const [{ BrowserPDF417Reader }, { DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
    const hints = new Map<import("@zxing/library").DecodeHintType, unknown>();
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserPDF417Reader(hints as Map<import("@zxing/library").DecodeHintType, never>);
    const img = await loadImage(blob);
    for (const degrees of [0, 90, 270, 180] as const) {
      try {
        const canvas = drawRotated(img, degrees);
        const result = reader.decodeFromCanvas(canvas);
        const text = result.getText();
        if (text && text.length > 0) return { raw: text, engine: `ZXing PDF417 (rotated ${degrees}°)` };
      } catch {
        // NotFoundException for this rotation — try the next one
      }
    }
  } catch {
    // ZXing unavailable or image undecodable
  }
  return null;
}

function aamvaDate(value: string | undefined, country: string | null): string | null {
  if (!value) return null;
  const d = value.replace(/\D/g, "");
  if (d.length !== 8) return null;
  const firstTwo = parseInt(d.slice(0, 2), 10);
  if (country === "CAN" || firstTwo > 12) {
    // CCYYMMDD (Canada, and any value where MMDDCCYY is impossible)
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  return `${d.slice(4, 8)}-${d.slice(0, 2)}-${d.slice(2, 4)}`;
}

const clean = (s: string | undefined): string | null => {
  if (!s) return null;
  const t = s.replace(/,+$/, "").trim();
  return t.length > 0 && t !== "NONE" ? t : null;
};

/** Parses an AAMVA DL/ID payload into named fields. Returns null when the payload is not AAMVA. */
export function parseAamva(raw: string): { fields: AamvaFields; elements: Record<string, string> } | null {
  const ansiIdx = raw.indexOf("ANSI ");
  const aamvaIdx = raw.indexOf("AAMVA");
  const headerIdx = ansiIdx >= 0 ? ansiIdx + 5 : aamvaIdx >= 0 ? aamvaIdx + 5 : -1;
  if (headerIdx === -1) return null;
  const header = raw.slice(headerIdx);
  const iin = /^\d{6}/.test(header) ? header.slice(0, 6) : null;
  const versionStr = header.slice(6, 8);
  const aamvaVersion = /^\d{2}$/.test(versionStr) ? parseInt(versionStr, 10) : null;

  const elements: Record<string, string> = {};
  const re = /(D[A-D][A-Z])([^\n\r\u001e\u001c\u001d]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const code = m[1];
    if (!(code in elements)) elements[code] = m[2].trim();
  }
  if (Object.keys(elements).length < 3) return null;

  const country = clean(elements.DCG);
  const lastName = clean(elements.DCS) ?? clean(elements.DAB);
  const firstName = clean(elements.DAC) ?? clean(elements.DCT);
  const fullFromParts = [firstName, clean(elements.DAD), lastName].filter(Boolean).join(" ");
  const fields: AamvaFields = {
    firstName,
    middleName: clean(elements.DAD),
    lastName,
    fullName: clean(elements.DAA) ?? (fullFromParts.length > 0 ? fullFromParts : null),
    birthDate: aamvaDate(elements.DBB, country),
    expiryDate: aamvaDate(elements.DBA, country),
    issueDate: aamvaDate(elements.DBD, country),
    documentNumber: clean(elements.DAQ),
    sex: elements.DBC === "1" ? "M" : elements.DBC === "2" ? "F" : clean(elements.DBC),
    addressStreet: clean(elements.DAG),
    addressCity: clean(elements.DAI),
    addressState: clean(elements.DAJ),
    addressPostal: clean(elements.DAK),
    country,
    issuerIin: iin,
    aamvaVersion,
  };
  return { fields, elements };
}

/**
 * Full licence-back data check: decode PDF417, parse AAMVA, validate dates.
 * Cross-checks against the front happen separately (see crossCheckLicenceData)
 * because the front-side OCR may complete later.
 */
export async function runLicenceBackCheck(blob: Blob, onStep?: (msg: string) => void): Promise<LicenceBarcodeCheck> {
  const findings: Finding[] = [];
  const generatedAt = new Date().toISOString();
  const read = await readPdf417(blob, onStep);

  if (!read) {
    findings.push({
      id: "barcode-read",
      label: "PDF417 barcode decode",
      status: "info",
      weight: 0,
      category: "document",
      observed: "No PDF417 barcode decoded (native detector + ZXing, 4 rotations)",
      expected: "US/Canadian licences carry an AAMVA PDF417 on the back; most other issuers do not",
      detail:
        "No barcode could be decoded. Only US and Canadian licences carry an AAMVA PDF417 — Australian state/territory licences (NSW, VIC, QLD, WA, SA, TAS, ACT, NT), UK and EU licences have no public PDF417 data layer, so its absence there is expected and carries zero suspicion. If this IS a US or Canadian licence, retake with the barcode sharp, flat, and glare-free — the data cross-check needs it.",
    });
    return {
      outcome: "unreadable",
      summary: "No PDF417 decoded — expected for non-North-American licences (incl. all Australian states); otherwise the barcode is blurred/glared. Data cross-check unavailable.",
      engine: null,
      raw: null,
      fields: null,
      findings,
      generatedAt,
    };
  }

  findings.push({
    id: "barcode-read",
    label: "PDF417 barcode decode",
    status: "pass",
    weight: 0,
    category: "document",
    observed: `${read.raw.length} characters via ${read.engine}`,
    expected: "A decodable PDF417 symbol",
    detail: "The barcode decodes cleanly — the symbol is intact and machine-readable. Decoding is deterministic local math, no AI involved.",
  });

  const parsed = parseAamva(read.raw);
  if (!parsed) {
    findings.push({
      id: "barcode-aamva",
      label: "AAMVA payload structure",
      status: "info",
      weight: 0,
      category: "document",
      observed: `Decoded text does not start with the AAMVA/ANSI header (first chars: "${read.raw.slice(0, 24).replace(/[\n\r]/g, "␊")}")`,
      expected: "@\\n…ANSI <IIN><version>… with D?? data elements",
      detail: "The barcode holds non-AAMVA data — normal for non-North-American documents (Australian licences that do carry a barcode use proprietary state payloads, not AAMVA). Field-level cross-checks against the front are unavailable; this carries no suspicion.",
    });
    return {
      outcome: "raw-only",
      summary: "Barcode decoded but the payload is not AAMVA — no structured fields to cross-check.",
      engine: read.engine,
      raw: read.raw,
      fields: null,
      findings,
      generatedAt,
    };
  }

  const f = parsed.fields;
  findings.push({
    id: "barcode-aamva",
    label: "AAMVA payload structure",
    status: "pass",
    weight: 0,
    category: "document",
    observed: `AAMVA v${f.aamvaVersion ?? "?"} · issuer IIN ${f.issuerIin ?? "?"} · ${Object.keys(parsed.elements).length} data elements`,
    expected: "Valid AAMVA DL/ID payload",
    detail: "The payload parses as a standard AAMVA driver's licence record — name, dates, and licence number are machine-readable.",
  });

  const todayIso = new Date().toISOString().slice(0, 10);
  if (f.expiryDate) {
    findings.push(
      f.expiryDate < todayIso
        ? {
            id: "barcode-expiry",
            label: "Licence expiry (barcode)",
            status: "warn",
            weight: 8,
            category: "document",
            observed: `Expired ${f.expiryDate}`,
            expected: `Valid on ${todayIso}`,
            detail: "The barcode says the licence is expired. Not fraud by itself, but expired documents are rejected by every verification policy.",
          }
        : {
            id: "barcode-expiry",
            label: "Licence expiry (barcode)",
            status: "pass",
            weight: 0,
            category: "document",
            observed: `Valid until ${f.expiryDate}`,
            expected: `Valid on ${todayIso}`,
            detail: "The licence is within its validity period per the barcode.",
          }
    );
  }
  if (f.birthDate) {
    const age = (Date.now() - new Date(f.birthDate).getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 10 || age > 120) {
      findings.push({
        id: "barcode-dob",
        label: "Birth date plausibility (barcode)",
        status: "warn",
        weight: 8,
        category: "document",
        observed: `${f.birthDate} (age ${age.toFixed(0)})`,
        expected: "A plausible licence-holder age",
        detail: "The barcode birth date is implausible for a driver's licence — corrupt read or fabricated payload.",
      });
    }
  }

  return {
    outcome: "parsed",
    summary: `AAMVA v${f.aamvaVersion ?? "?"} parsed — ${[f.fullName, f.documentNumber ? `no. ${f.documentNumber}` : null, f.birthDate ? `born ${f.birthDate}` : null].filter(Boolean).join(" · ") || "fields read"}.`,
    engine: read.engine,
    raw: read.raw,
    fields: f,
    findings,
    generatedAt,
  };
}

const normAlnum = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function nameTokens(s: string): string[] {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Deterministic barcode ↔ front-OCR cross-checks (the licence equivalent of
 * MRZ↔VIZ). A single mismatch stays WARN (front OCR can misread); two or more
 * corroborated mismatches escalate every mismatched field to FAIL.
 */
export function crossCheckLicenceData(barcode: AamvaFields, front: DocumentDataCheck): Finding[] {
  const viz = front.extraction.visual;
  type Cmp = { id: string; label: string; barcodeVal: string; frontVal: string; ok: boolean };
  const comparisons: Cmp[] = [];

  const compareExact = (id: string, label: string, a: string | null, b: string | null) => {
    if (!a || !b) return;
    const na = normAlnum(a);
    const nb = normAlnum(b);
    if (na.length === 0 || nb.length === 0) return;
    comparisons.push({ id, label, barcodeVal: a, frontVal: b, ok: na === nb || na.includes(nb) || nb.includes(na) });
  };
  compareExact("cross-back-number", "Licence number: barcode vs front", barcode.documentNumber, viz.documentNumber);
  compareExact("cross-back-dob", "Birth date: barcode vs front", barcode.birthDate, viz.birthDate);
  compareExact("cross-back-expiry", "Expiry date: barcode vs front", barcode.expiryDate, viz.expiryDate);

  if (barcode.fullName && viz.fullName) {
    const bTokens = nameTokens(barcode.fullName);
    const vTokens = nameTokens(viz.fullName);
    if (bTokens.length > 0 && vTokens.length > 0) {
      const overlap = bTokens.filter((t) => vTokens.includes(t)).length;
      comparisons.push({
        id: "cross-back-name",
        label: "Name: barcode vs front",
        barcodeVal: barcode.fullName,
        frontVal: viz.fullName,
        ok: overlap >= Math.max(1, Math.ceil(Math.min(bTokens.length, vTokens.length) / 2)),
      });
    }
  }

  const mismatches = comparisons.filter((c) => !c.ok).length;
  return comparisons.map((c) => ({
    id: c.id,
    label: c.label,
    status: c.ok ? "pass" : mismatches >= 2 ? "fail" : "warn",
    weight: c.ok ? 0 : mismatches >= 2 ? 16 : 10,
    category: "document",
    observed: `barcode "${c.barcodeVal}" vs front "${c.frontVal}"`,
    expected: "The barcode and the printed front must agree",
    detail: c.ok
      ? "The machine-readable barcode value matches the printed front — both sides come from one record."
      : mismatches >= 2
        ? "Multiple fields disagree between the deterministic barcode read and the printed front. Genuine licences are printed from one record — corroborated disagreement is the classic altered-front signature."
        : "This field disagrees between the barcode and the front-side OCR. A single disagreement can be an OCR misread of the front — retake the front sharper before concluding.",
  }));
}
