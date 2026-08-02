/**
 * ICAO Doc 9303 MRZ engine — the same deterministic document-data validation
 * IDVerse (DocXtract) and Innovatrics IDKit/DOT run server-side:
 * - TD1/TD2/TD3 MRZ parsing with per-field check-digit validation (weights 7-3-1)
 * - date plausibility + expiry validation
 * - MRZ ↔ visual-zone cross-validation (Innovatrics "TextConsistency" check)
 *
 * The MRZ text itself is read by the vision model (extractDocumentData); every
 * validation below is pure local math — an altered digit breaks the checksums.
 */

import type { Finding } from "@/lib/fraud-detection";
import { extractDocumentData, type DocumentExtraction } from "@/lib/ai-verdict";

export type MrzFormat = "TD1" | "TD2" | "TD3";

export type MrzCheckDigit = {
  field: string;
  value: string;
  expected: string;
  actual: string;
  ok: boolean;
  /** Composite digits cover other fields; a lone composite failure usually means one misread char. */
  composite: boolean;
};

export type ParsedMrz = {
  format: MrzFormat;
  documentCode: string;
  issuingState: string;
  surname: string;
  givenNames: string;
  documentNumber: string;
  nationality: string;
  birthDateIso: string | null;
  expiryDateIso: string | null;
  sex: string;
  checkDigits: MrzCheckDigit[];
  fieldFailures: number;
  compositeFailed: boolean;
};

export type DocDataOutcome = "consistent" | "mismatch" | "checksum-failed" | "unreadable" | "no-mrz";

/** One line of the confidence ledger: what was checked, points earned vs available. */
export type ConfidencePart = {
  id: string;
  label: string;
  earned: number;
  max: number;
  observed: string;
  ok: boolean;
};

/**
 * Deterministic document-data confidence. `score` is null when the document
 * carries no MRZ (e.g. Australian state licences) — "N/A", never a misleading
 * low percentage.
 */
export type DocConfidence = {
  score: number | null;
  label: string;
  parts: ConfidencePart[];
  /** Human-readable formula summary, e.g. "78/95 points → 82%". */
  note: string;
};

export type DocumentDataCheck = {
  outcome: DocDataOutcome;
  summary: string;
  extraction: DocumentExtraction;
  mrz: ParsedMrz | null;
  findings: Finding[];
  generatedAt: string;
};

const MRZ_WEIGHTS = [7, 3, 1] as const;

function charValue(c: string): number | null {
  if (c === "<") return 0;
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55;
  return null;
}

/** ICAO 9303 check digit: Σ value×weight (7,3,1 cycling) mod 10. */
export function computeCheckDigit(field: string): string | null {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = charValue(field[i]);
    if (v == null) return null;
    sum += v * MRZ_WEIGHTS[i % 3];
  }
  return String(sum % 10);
}

function digitEntry(field: string, value: string, actual: string, composite = false): MrzCheckDigit {
  const expected = computeCheckDigit(value) ?? "?";
  const ok = expected !== "?" && (actual === expected || (actual === "<" && expected === "0"));
  return { field, value, expected, actual, ok, composite };
}

function yymmddToIso(s: string, kind: "birth" | "expiry"): string | null {
  if (!/^\d{6}$/.test(s)) return null;
  const yy = parseInt(s.slice(0, 2), 10);
  const mm = parseInt(s.slice(2, 4), 10);
  const dd = parseInt(s.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const nowYY = new Date().getFullYear() % 100;
  // Birth dates prefer the past (a two-digit year after the current year must be
  // 19xx); expiry dates always resolve to 20xx — no genuine document in
  // circulation expires in the 1900s, and mapping high two-digit years to 19xx
  // would falsely flag long-validity documents as expired forgeries.
  const century = kind === "birth" ? (yy > nowYY ? 1900 : 2000) : 2000;
  return `${century + yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Returns the alternate-century candidate for an ISO date (1937-05-01 ↔
 * 2037-05-01). Used by the zone cross-check so an ambiguous two-digit year
 * never produces a false MRZ↔printed mismatch on its own.
 */
function alternateCenturyIso(iso: string): string | null {
  const m = /^(19|20)(\d{2}-\d{2}-\d{2})$/.exec(iso);
  if (!m) return null;
  return `${m[1] === "19" ? "20" : "19"}${m[2]}`;
}

function cleanField(s: string): string {
  return s.replace(/</g, " ").replace(/\s+/g, " ").trim();
}

/**
 * ICAO 9303 sex marker: F, M or < (unspecified). Several issuers — Australia
 * since 2011, plus the US, Canada, NZ and others — legally print X for
 * non-binary holders, so X must parse as valid, never as a suspicious glyph.
 */
function parseSex(c: string): string {
  if (c === "M" || c === "F" || c === "X") return c;
  if (c === "<") return "unspecified";
  return "?";
}

function parseNames(nameField: string): { surname: string; givenNames: string } {
  const sep = nameField.indexOf("<<");
  if (sep === -1) return { surname: cleanField(nameField), givenNames: "" };
  return { surname: cleanField(nameField.slice(0, sep)), givenNames: cleanField(nameField.slice(sep + 2)) };
}

function normalizeLine(line: string, expectedLen: number): string | null {
  let s = line.toUpperCase().replace(/\s+/g, "");
  if (Math.abs(s.length - expectedLen) > 2) return null;
  if (s.length < expectedLen) s = s.padEnd(expectedLen, "<");
  if (s.length > expectedLen) s = s.slice(0, expectedLen);
  return s;
}

/** Parses TD1 (3×30), TD2 (2×36), or TD3 (2×44) MRZ lines and validates every check digit. */
export function parseMrz(rawLines: string[]): ParsedMrz | null {
  const lines = rawLines.map((l) => l.toUpperCase().replace(/\s+/g, "")).filter((l) => l.length >= 20);
  if (lines.length === 3) {
    const l1 = normalizeLine(lines[0], 30);
    const l2 = normalizeLine(lines[1], 30);
    const l3 = normalizeLine(lines[2], 30);
    if (!l1 || !l2 || !l3) return null;
    const digits: MrzCheckDigit[] = [
      digitEntry("Document number", l1.slice(5, 14), l1[14]),
      digitEntry("Date of birth", l2.slice(0, 6), l2[6]),
      digitEntry("Expiry date", l2.slice(8, 14), l2[14]),
      digitEntry("Composite", l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29), l2[29], true),
    ];
    const names = parseNames(l3);
    return {
      format: "TD1",
      documentCode: cleanField(l1.slice(0, 2)),
      issuingState: cleanField(l1.slice(2, 5)),
      ...names,
      documentNumber: cleanField(l1.slice(5, 14)).replace(/\s/g, ""),
      nationality: cleanField(l2.slice(15, 18)),
      birthDateIso: yymmddToIso(l2.slice(0, 6), "birth"),
      expiryDateIso: yymmddToIso(l2.slice(8, 14), "expiry"),
      sex: parseSex(l2[7]),
      checkDigits: digits,
      fieldFailures: digits.filter((d) => !d.composite && !d.ok).length,
      compositeFailed: digits.some((d) => d.composite && !d.ok),
    };
  }
  if (lines.length === 2) {
    const isTd3 = Math.max(lines[0].length, lines[1].length) >= 40;
    const len = isTd3 ? 44 : 36;
    const l1 = normalizeLine(lines[0], len);
    const l2 = normalizeLine(lines[1], len);
    if (!l1 || !l2) return null;
    const names = parseNames(l1.slice(5));
    if (isTd3) {
      const digits: MrzCheckDigit[] = [
        digitEntry("Document number", l2.slice(0, 9), l2[9]),
        digitEntry("Date of birth", l2.slice(13, 19), l2[19]),
        digitEntry("Expiry date", l2.slice(21, 27), l2[27]),
        digitEntry("Personal number", l2.slice(28, 42), l2[42]),
        digitEntry("Composite", l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43), l2[43], true),
      ];
      return {
        format: "TD3",
        documentCode: cleanField(l1.slice(0, 2)),
        issuingState: cleanField(l1.slice(2, 5)),
        ...names,
        documentNumber: cleanField(l2.slice(0, 9)).replace(/\s/g, ""),
        nationality: cleanField(l2.slice(10, 13)),
        birthDateIso: yymmddToIso(l2.slice(13, 19), "birth"),
        expiryDateIso: yymmddToIso(l2.slice(21, 27), "expiry"),
        sex: parseSex(l2[20]),
        checkDigits: digits,
        fieldFailures: digits.filter((d) => !d.composite && !d.ok).length,
        compositeFailed: digits.some((d) => d.composite && !d.ok),
      };
    }
    const digits: MrzCheckDigit[] = [
      digitEntry("Document number", l2.slice(0, 9), l2[9]),
      digitEntry("Date of birth", l2.slice(13, 19), l2[19]),
      digitEntry("Expiry date", l2.slice(21, 27), l2[27]),
      digitEntry("Composite", l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 35), l2[35], true),
    ];
    return {
      format: "TD2",
      documentCode: cleanField(l1.slice(0, 2)),
      issuingState: cleanField(l1.slice(2, 5)),
      ...names,
      documentNumber: cleanField(l2.slice(0, 9)).replace(/\s/g, ""),
      nationality: cleanField(l2.slice(10, 13)),
      birthDateIso: yymmddToIso(l2.slice(13, 19), "birth"),
      expiryDateIso: yymmddToIso(l2.slice(21, 27), "expiry"),
      sex: parseSex(l2[20]),
      checkDigits: digits,
      fieldFailures: digits.filter((d) => !d.composite && !d.ok).length,
      compositeFailed: digits.some((d) => d.composite && !d.ok),
    };
  }
  return null;
}

/**
 * Issuer-aware plausibility checks — currently Australia (DFAT). These only
 * ever run when the MRZ says the issuer is AUS, so they can never create
 * false positives for other countries' documents.
 *
 * Facts (DFAT / Microsoft Purview AU-passport entity definition):
 * - Current passport numbers: two letters (PA PB PC PD PE PF PU PW PX PZ) + 7 digits
 * - Legacy series still in circulation: one letter + 7 digits (e.g. N1234567)
 * - Maximum validity is 10 years (adults); 5 years for children/seniors
 * - Ordinary passports are citizen documents — nationality reads AUS
 */
function australianPassportFindings(mrz: ParsedMrz): Finding[] {
  if (mrz.format !== "TD3" || mrz.issuingState !== "AUS") return [];
  const findings: Finding[] = [];
  const num = mrz.documentNumber;
  const modernSeries = /^P[ABCDEFUWXZ]\d{7}$/.test(num);
  const legacySeries = !modernSeries && /^[A-Z]\d{7}$/.test(num);
  if (num.length > 0) {
    findings.push(
      modernSeries || legacySeries
        ? {
            id: "au-passport-number",
            label: "Australian passport number format",
            status: "pass",
            weight: 0,
            category: "document",
            observed: `${num} (${modernSeries ? "current two-letter series" : "legacy single-letter series"})`,
            expected: "P?######## (two letters + 7 digits) or legacy letter + 7 digits",
            detail: "The document number matches a real DFAT series — corroborates a genuine Australian passport.",
          }
        : {
            id: "au-passport-number",
            label: "Australian passport number format",
            status: "warn",
            weight: 6,
            category: "document",
            observed: num,
            expected: "Two letters (PA/PB/PC/PD/PE/PF/PU/PW/PX/PZ) + 7 digits, or legacy letter + 7 digits",
            detail:
              "The number does not match any Australian passport series DFAT has issued. Check for an OCR misread first (O\u21940, I\u21941, B\u21948 are common in MRZ reads) — if the retake reads the same, the number is fabricated.",
          }
    );
  }
  if (mrz.expiryDateIso) {
    const yearsAhead = (new Date(mrz.expiryDateIso).getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
    if (yearsAhead > 10.2) {
      findings.push({
        id: "au-passport-validity",
        label: "Australian passport validity span",
        status: "warn",
        weight: 8,
        category: "document",
        observed: `Expires ${mrz.expiryDateIso} (${yearsAhead.toFixed(1)} years from today)`,
        expected: "Australian passports are valid at most 10 years",
        detail:
          "DFAT issues 10-year passports to adults and 5-year passports to children — no genuine Australian passport can expire more than 10 years from now. A longer span means a misread expiry digit or a fabricated date.",
      });
    }
  }
  if (mrz.documentCode.startsWith("P") && mrz.nationality.length === 3 && mrz.nationality !== "AUS") {
    findings.push({
      id: "au-passport-nationality",
      label: "Issuer vs nationality",
      status: "warn",
      weight: 6,
      category: "document",
      observed: `Issuer AUS but nationality "${mrz.nationality}"`,
      expected: "AUS — Australian passports are citizen-only documents",
      detail:
        "An ordinary Australian passport is only issued to Australian citizens, so nationality always reads AUS. (DFAT travel documents for non-citizens use different document codes.) Verify the OCR read before concluding — a one-letter misread is possible.",
    });
  }
  return findings;
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
 * Runs the full document data check: vision-model OCR of MRZ + visual zone,
 * then local ICAO 9303 checksum validation and MRZ↔VIZ cross-checks.
 */
export async function runDocumentDataCheck(blob: Blob, docType: "passport" | "licence" | "unknown"): Promise<DocumentDataCheck> {
  const extraction = await extractDocumentData(blob);
  return validateExtraction(extraction, docType);
}

/** Pure validation over an extraction — separated for testability. */
export function validateExtraction(extraction: DocumentExtraction, docType: "passport" | "licence" | "unknown"): DocumentDataCheck {
  const findings: Finding[] = [];
  const viz = extraction.visual;

  if (!extraction.mrzReadable || extraction.mrzLines.length === 0) {
    if (docType === "passport") {
      findings.push({
        id: "mrz-present",
        label: "MRZ presence",
        status: "warn",
        weight: 10,
        category: "document",
        observed: "No machine-readable zone found",
        expected: "Passports carry a 2×44 MRZ on the photo page",
        detail:
          "The vision OCR could not read an MRZ. Every ICAO passport has one — either the MRZ is cropped/glared out (retake with the two bottom code lines fully visible) or the page is not a real passport photo page.",
      });
      return {
        outcome: "no-mrz",
        summary: "No MRZ readable — retake with the two bottom code lines visible, or the page is not a passport photo page.",
        extraction,
        mrz: null,
        findings,
        generatedAt: new Date().toISOString(),
      };
    }
    findings.push({
      id: "mrz-present",
      label: "MRZ presence",
      status: "info",
      weight: 0,
      category: "document",
      observed: "No machine-readable zone found",
      detail:
        docType === "licence"
          ? "Driver's licences carry no MRZ. US/Canadian licences put their data in a PDF417 barcode on the back; Australian state and territory licences have no public machine-readable data layer at all — visual fields only, nothing suspicious."
          : "No MRZ on this document — checksum validation unavailable, visual fields only.",
    });
    return {
      outcome: "no-mrz",
      summary: "No MRZ on this document type — visual-zone data only.",
      extraction,
      mrz: null,
      findings,
      generatedAt: new Date().toISOString(),
    };
  }

  const mrz = parseMrz(extraction.mrzLines);
  if (!mrz) {
    findings.push({
      id: "mrz-format",
      label: "MRZ format",
      status: "warn",
      weight: 8,
      category: "document",
      observed: `Lines of length ${extraction.mrzLines.map((l) => l.replace(/\s+/g, "").length).join("/")}`,
      expected: "TD3 2×44, TD2 2×36 or TD1 3×30",
      detail: "MRZ text was found but does not fit any ICAO 9303 layout — either a poor OCR read (retake sharper, no glare on the code lines) or a fabricated zone.",
    });
    return {
      outcome: "unreadable",
      summary: "MRZ found but unparseable — retake sharper or treat the zone as suspect.",
      extraction,
      mrz: null,
      findings,
      generatedAt: new Date().toISOString(),
    };
  }

  findings.push({
    id: "mrz-format",
    label: "MRZ format",
    status: "pass",
    weight: 0,
    category: "document",
    observed: `${mrz.format} · doc code ${mrz.documentCode || "?"} · issuer ${mrz.issuingState || "?"}`,
    expected: "Valid ICAO 9303 layout",
    detail: `Machine-readable zone parses cleanly as ${mrz.format === "TD3" ? "a passport (2×44)" : mrz.format === "TD1" ? "an ID card (3×30)" : "a TD2 document (2×36)"}.`,
  });

  if (docType === "passport" && mrz.format !== "TD3") {
    findings.push({
      id: "mrz-doctype",
      label: "Document type consistency",
      status: "warn",
      weight: 8,
      category: "document",
      observed: `${mrz.format} MRZ on a step expecting a passport`,
      expected: "TD3 (2 lines × 44) with document code P",
      detail: "The MRZ layout belongs to an ID card, not a passport photo page — the wrong document may have been presented.",
    });
  } else if (docType === "passport" && !mrz.documentCode.startsWith("P")) {
    findings.push({
      id: "mrz-doctype",
      label: "Document type consistency",
      status: "warn",
      weight: 6,
      category: "document",
      observed: `Document code "${mrz.documentCode}"`,
      expected: "P (passport)",
      detail: "TD3 layout but the document code is not P — unusual for a passport photo page.",
    });
  }

  // ICAO 9303 check digits — an altered digit breaks the checksum math.
  const failedFields = mrz.checkDigits.filter((d) => !d.composite && !d.ok);
  const digitSummary = mrz.checkDigits.map((d) => `${d.field}: ${d.ok ? "OK" : `FAIL (printed ${d.actual}, computed ${d.expected})`}`).join(" · ");
  if (mrz.fieldFailures >= 2) {
    findings.push({
      id: "mrz-checksums",
      label: "ICAO 9303 check digits",
      status: "fail",
      weight: 22,
      category: "document",
      observed: digitSummary,
      expected: "All check digits valid (weights 7-3-1 mod 10)",
      detail: `${mrz.fieldFailures} independent field check digits fail. One failure can be an OCR misread; multiple failing digits across different fields is the classic signature of edited MRZ data (the forger changed values without recomputing the checksums).`,
    });
  } else if (mrz.fieldFailures === 1 || mrz.compositeFailed) {
    findings.push({
      id: "mrz-checksums",
      label: "ICAO 9303 check digits",
      status: "warn",
      weight: 10,
      category: "document",
      observed: digitSummary,
      expected: "All check digits valid (weights 7-3-1 mod 10)",
      detail: `${failedFields.length > 0 ? `The ${failedFields[0].field.toLowerCase()} check digit fails.` : "Only the composite check digit fails."} A single failure is equally consistent with one misread character (retake sharper, MRZ fully lit) or one altered character — re-scan before concluding.`,
    });
  } else {
    findings.push({
      id: "mrz-checksums",
      label: "ICAO 9303 check digits",
      status: "pass",
      weight: 0,
      category: "document",
      observed: digitSummary,
      expected: "All check digits valid",
      detail: "Every ICAO 9303 check digit validates — document number, dates and composite are internally consistent.",
    });
  }

  // Date plausibility + expiry.
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  if (mrz.birthDateIso) {
    const age = (now.getTime() - new Date(mrz.birthDateIso).getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 0 || age > 120) {
      findings.push({
        id: "mrz-dob",
        label: "Birth date plausibility",
        status: "warn",
        weight: 8,
        category: "document",
        observed: `${mrz.birthDateIso} (age ${age.toFixed(0)})`,
        expected: "Age between 0 and 120",
        detail: "The MRZ birth date is implausible — misread or fabricated.",
      });
    }
  }
  if (mrz.expiryDateIso) {
    findings.push(
      mrz.expiryDateIso < todayIso
        ? {
            id: "mrz-expiry",
            label: "Document expiry",
            status: "warn",
            weight: 8,
            category: "document",
            observed: `Expired ${mrz.expiryDateIso}`,
            expected: `Valid on ${todayIso}`,
            detail: "The document is expired. Not fraud by itself, but expired documents are rejected by every verification policy.",
          }
        : {
            id: "mrz-expiry",
            label: "Document expiry",
            status: "pass",
            weight: 0,
            category: "document",
            observed: `Valid until ${mrz.expiryDateIso}`,
            expected: `Valid on ${todayIso}`,
            detail: "Document is within its validity period.",
          }
    );
  }

  // MRZ ↔ visual zone cross-validation (Innovatrics "TextConsistency").
  let mismatches = 0;
  const cross = (id: string, label: string, mrzVal: string | null, vizVal: string | null, exact: boolean, isDate = false) => {
    if (!mrzVal || !vizVal) return;
    const a = normAlnum(mrzVal);
    const b = normAlnum(vizVal);
    if (a.length === 0 || b.length === 0) return;
    const exactMatch = (x: string, y: string) => x === y || x.includes(y) || y.includes(x);
    // MRZ years are two-digit, so the resolved century is a guess. For dates,
    // also accept the alternate-century candidate — an ambiguous printed year
    // must never produce a forgery-weight mismatch on its own.
    const altIso = isDate ? alternateCenturyIso(mrzVal) : null;
    const ok = exact
      ? exactMatch(a, b) || (altIso != null && exactMatch(normAlnum(altIso), b))
      : nameTokens(mrzVal).filter((t) => nameTokens(vizVal).includes(t)).length >= Math.max(1, Math.ceil(nameTokens(mrzVal).length / 2));
    if (!ok) mismatches++;
    findings.push({
      id,
      label,
      status: ok ? "pass" : "fail",
      weight: ok ? 0 : 16,
      category: "document",
      observed: `MRZ "${mrzVal}" vs printed "${vizVal}"`,
      expected: "Machine zone and printed zone must agree",
      detail: ok
        ? "The machine-readable value matches the printed value — zones agree."
        : "The machine zone and the printed zone disagree. Genuine documents are printed from one record; a mismatch means one zone was altered (classic photo-substitution/field-edit signature). Verify the OCR read before concluding.",
    });
  };
  cross("viz-cross-number", "Document number: MRZ vs printed", mrz.documentNumber, viz.documentNumber, true);
  cross("viz-cross-dob", "Birth date: MRZ vs printed", mrz.birthDateIso, viz.birthDate, true, true);
  cross("viz-cross-expiry", "Expiry date: MRZ vs printed", mrz.expiryDateIso, viz.expiryDate, true, true);
  cross("viz-cross-name", "Name: MRZ vs printed", `${mrz.surname} ${mrz.givenNames}`.trim(), viz.fullName, false);

  // Issuer-aware plausibility (only fires for the issuer it targets).
  findings.push(...australianPassportFindings(mrz));

  const outcome: DocDataOutcome = mrz.fieldFailures >= 2 ? "checksum-failed" : mismatches > 0 ? "mismatch" : "consistent";
  const summary =
    outcome === "checksum-failed"
      ? `${mrz.fieldFailures} ICAO check digits fail — MRZ data was altered or badly misread.`
      : outcome === "mismatch"
        ? `${mismatches} field(s) disagree between the MRZ and the printed zone.`
        : `MRZ parses as ${mrz.format}, all check digits valid${mrz.compositeFailed || mrz.fieldFailures === 1 ? " except one (see findings)" : ""}, zones agree.`;

  return { outcome, summary, extraction, mrz, findings, generatedAt: new Date().toISOString() };
}

/**
 * Deterministic document-data confidence (0–100%) computed from hard checks
 * only — ICAO check digits, date validity, format/series recognition, and
 * MRZ↔printed-zone agreement. Pure math over an existing DocumentDataCheck:
 * recomputing never re-runs OCR and never changes any verdict.
 *
 * Weights (normalized over the parts that actually apply to this document):
 * - MRZ layout recognised — 10
 * - ICAO 9303 check digits — 40, proportional to digits passing
 * - Birth date plausible — 10
 * - Expiry valid + not expired — 10
 * - MRZ↔printed zone agreement — 25, proportional (only when cross-checks ran)
 * - Australian series match — 10 (AUS TD3 only)
 * - Australian ≤10-year validity span — 5 (AUS TD3 only)
 *
 * No MRZ (e.g. Australian state licences) → score null ("N/A"), never a
 * misleading low percentage.
 */
export function computeDocConfidence(check: DocumentDataCheck): DocConfidence {
  if (check.outcome === "no-mrz") {
    return {
      score: null,
      label: "N/A — no machine zone",
      parts: [],
      note: "This document type carries no MRZ, so checksum-based confidence does not apply — absence of a machine zone is expected and carries no suspicion.",
    };
  }
  const mrz = check.mrz;
  if (!mrz) {
    return {
      score: 0,
      label: "0%",
      parts: [
        {
          id: "format",
          label: "MRZ layout recognised",
          earned: 0,
          max: 100,
          observed: "MRZ text found but does not fit TD1 (3×30), TD2 (2×36) or TD3 (2×44)",
          ok: false,
        },
      ],
      note: "0/100 points — the machine zone could not be parsed, so no check digit or date validation was possible. Retake sharper with the code lines glare-free.",
    };
  }

  const parts: ConfidencePart[] = [];
  const finding = (id: string) => check.findings.find((f) => f.id === id);

  parts.push({
    id: "format",
    label: `MRZ layout recognised (${mrz.format})`,
    earned: 10,
    max: 10,
    observed: `Parses cleanly as ${mrz.format} · doc code ${mrz.documentCode || "?"} · issuer ${mrz.issuingState || "?"}`,
    ok: true,
  });

  const digitsOk = mrz.checkDigits.filter((d) => d.ok).length;
  const digitsTotal = mrz.checkDigits.length;
  parts.push({
    id: "check-digits",
    label: `ICAO 9303 check digits (${digitsOk}/${digitsTotal})`,
    earned: Math.round((40 * digitsOk) / Math.max(1, digitsTotal)),
    max: 40,
    observed: mrz.checkDigits.map((d) => `${d.field} ${d.ok ? "✓" : `✗ (printed ${d.actual}, computed ${d.expected})`}`).join(" · "),
    ok: digitsOk === digitsTotal,
  });

  const dobIssue = finding("mrz-dob");
  const birthOk = mrz.birthDateIso != null && !dobIssue;
  parts.push({
    id: "birth-date",
    label: "Birth date plausible",
    earned: birthOk ? 10 : 0,
    max: 10,
    observed: mrz.birthDateIso ? `${mrz.birthDateIso}${dobIssue ? " — implausible age" : " — plausible, in the past"}` : "birth date not parseable from the MRZ",
    ok: birthOk,
  });

  const expiryFinding = finding("mrz-expiry");
  const expiryOk = expiryFinding?.status === "pass";
  parts.push({
    id: "expiry",
    label: "Expiry valid, not expired",
    earned: expiryOk ? 10 : 0,
    max: 10,
    observed: mrz.expiryDateIso ? (expiryOk ? `valid until ${mrz.expiryDateIso}` : `expired or invalid — ${mrz.expiryDateIso}`) : "expiry date not parseable from the MRZ",
    ok: expiryOk,
  });

  const auSeries = finding("au-passport-number");
  if (auSeries) {
    const ok = auSeries.status === "pass";
    parts.push({
      id: "au-series",
      label: "Australian passport number series (DFAT)",
      earned: ok ? 10 : 0,
      max: 10,
      observed: auSeries.observed ?? mrz.documentNumber,
      ok,
    });
  }
  if (mrz.format === "TD3" && mrz.issuingState === "AUS" && mrz.expiryDateIso) {
    const auSpan = finding("au-passport-validity");
    parts.push({
      id: "au-validity-span",
      label: "Validity span ≤ 10 years (DFAT maximum)",
      earned: auSpan ? 0 : 5,
      max: 5,
      observed: auSpan ? auSpan.observed ?? "exceeds the 10-year maximum" : `expires ${mrz.expiryDateIso} — within the 10-year DFAT maximum`,
      ok: !auSpan,
    });
  }

  const crossChecks = check.findings.filter((f) => f.id.startsWith("viz-cross-"));
  if (crossChecks.length > 0) {
    const passed = crossChecks.filter((f) => f.status === "pass").length;
    parts.push({
      id: "zone-agreement",
      label: `MRZ ↔ printed zone agreement (${passed}/${crossChecks.length})`,
      earned: Math.round((25 * passed) / crossChecks.length),
      max: 25,
      observed: crossChecks.map((f) => `${f.label.split(":")[0]} ${f.status === "pass" ? "✓" : "✗"}`).join(" · "),
      ok: passed === crossChecks.length,
    });
  }

  const max = parts.reduce((a, p) => a + p.max, 0);
  const earned = parts.reduce((a, p) => a + p.earned, 0);
  const score = Math.round((100 * earned) / Math.max(1, max));
  return {
    score,
    label: `${score}%`,
    parts,
    note: `${earned}/${max} points across ${parts.length} deterministic checks → ${score}%. Every point is hard math (check digits, date rules, series formats) — no model opinions.`,
  };
}
