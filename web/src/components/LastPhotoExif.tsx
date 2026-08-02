import ExifReader from "exifreader";
import { CalendarClock, ChevronDown, Download, ExternalLink, ImageOff, Loader2, MapPin, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import type { MediaFraudReport } from "@/lib/fraud-detection";
import { cn } from "@/lib/utils";

/** One observed event in a photo's capture/verification timeline. Facts only — events without a usable wall-clock timestamp carry `epochMs: null`. */
export type ExifTimelineEvent = {
  label: string;
  /** Epoch ms wall-clock timestamp, or null when the fact has no timestamp (e.g. a boolean observation). */
  epochMs: number | null;
  detail?: string;
};

/** Capture context a caller can attach so the JSON export includes the photo's verification timeline and screening verdict. */
export type ExifExportMeta = {
  fileName: string;
  source: string;
  timeline: ExifTimelineEvent[];
  screening?: MediaFraudReport | null;
};

/** The newest natively captured photo, as tracked by the diagnostic hub. */
export type LastPhotoShot = {
  file: File;
  label: string;
  receivedAt: number;
  /** Attached once the gallery item (with screening) exists — enables the timeline in the JSON export. */
  exportMeta?: ExifExportMeta;
};

type RawTag = { description?: unknown; value?: unknown };
type RawTagMap = Record<string, RawTag | undefined>;

type ParsedExif = {
  tagCount: number;
  dump: Record<string, string>;
  device: { make: string | null; model: string | null; software: string | null };
  timestamp: {
    value: string | null;
    sourceTag: string | null;
    offset: string | null;
    subSec: string | null;
    gpsUtc: string | null;
    deltaVsLastModifiedMs: number | null;
  };
  gps: { lat: number; lon: number; altitude: string | null; refNote: string } | null;
  extras: { label: string; value: string }[];
};

type ParseState =
  | { status: "parsing" }
  | { status: "done"; parsed: ParsedExif }
  | { status: "error"; message: string };

function desc(tags: RawTagMap, key: string): string | null {
  const t = tags[key];
  if (!t || t.description == null) return null;
  const s = String(t.description).trim();
  return s.length > 0 ? s : null;
}

function refLetter(tags: RawTagMap, key: string): string {
  const t = tags[key];
  if (!t) return "";
  if (Array.isArray(t.value) && (t.value as unknown[]).length > 0) return String((t.value as unknown[])[0] ?? "");
  return String(t.description ?? "");
}

/** Signed decimal degrees from ExifReader's unsigned description + the hemisphere ref tag. */
function signedCoord(tags: RawTagMap, valueKey: string, refKey: string): number | null {
  const raw = desc(tags, valueKey);
  if (raw == null) return null;
  const abs = Number.parseFloat(raw);
  if (!Number.isFinite(abs)) return null;
  const ref = refLetter(tags, refKey).trim().toUpperCase();
  const negative = ref.startsWith("S") || ref.startsWith("W");
  return negative ? -Math.abs(abs) : Math.abs(abs);
}

/** Parses the EXIF "YYYY:MM:DD HH:MM:SS" clock as local time; null when malformed. */
function parseExifClock(s: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(t) ? t : null;
}

function stringifyTag(key: string, tag: RawTag | undefined): string {
  if (!tag) return "(unreadable)";
  if (key === "Thumbnail") return "[embedded thumbnail — binary payload omitted]";
  let s: string;
  if (tag.description != null && String(tag.description).trim().length > 0) {
    s = String(tag.description);
  } else if (tag.value != null) {
    try {
      s = JSON.stringify(tag.value);
    } catch {
      s = String(tag.value);
    }
  } else {
    s = "(empty)";
  }
  if (s.length > 260) s = `${s.slice(0, 260)}… (+${(s.length - 260).toLocaleString("en-US")} chars)`;
  return s;
}

const EXTRA_ROWS: [key: string, label: string][] = [
  ["LensModel", "Lens"],
  ["ExposureTime", "Exposure"],
  ["FNumber", "Aperture"],
  ["ISOSpeedRatings", "ISO"],
  ["FocalLength", "Focal length"],
  ["FocalLengthIn35mmFilm", "Focal (35mm eq)"],
  ["DigitalZoomRatio", "Digital zoom"],
  ["Flash", "Flash"],
  ["WhiteBalance", "White balance"],
  ["Orientation", "Orientation"],
  ["Image Width", "Pixel width"],
  ["Image Height", "Pixel height"],
  ["ColorSpace", "Color space"],
];

async function parsePhoto(file: Blob): Promise<ParsedExif> {
  const buffer = await file.arrayBuffer();
  const tags = ExifReader.load(buffer) as unknown as RawTagMap;
  const dump: Record<string, string> = {};
  for (const key of Object.keys(tags).sort((a, b) => a.localeCompare(b))) dump[key] = stringifyTag(key, tags[key]);

  const tsCandidates: [key: string, label: string][] = [
    ["DateTimeOriginal", "DateTimeOriginal (shutter moment)"],
    ["DateTimeDigitized", "DateTimeDigitized"],
    ["DateTime", "DateTime (file write clock)"],
  ];
  let tsValue: string | null = null;
  let tsSource: string | null = null;
  for (const [key, label] of tsCandidates) {
    const v = desc(tags, key);
    if (v != null) {
      tsValue = v;
      tsSource = label;
      break;
    }
  }
  const parsedClock = tsValue != null ? parseExifClock(tsValue) : null;
  const lastModified = file instanceof File ? file.lastModified : null;
  const gpsDate = desc(tags, "GPSDateStamp");
  const gpsTime = desc(tags, "GPSTimeStamp");

  const lat = signedCoord(tags, "GPSLatitude", "GPSLatitudeRef");
  const lon = signedCoord(tags, "GPSLongitude", "GPSLongitudeRef");
  const altitude = desc(tags, "GPSAltitude");
  const altRef = desc(tags, "GPSAltitudeRef");
  const latRef = refLetter(tags, "GPSLatitudeRef").trim();
  const lonRef = refLetter(tags, "GPSLongitudeRef").trim();

  const extras: { label: string; value: string }[] = [];
  for (const [key, label] of EXTRA_ROWS) {
    const v = desc(tags, key);
    if (v != null) extras.push({ label, value: v });
  }

  return {
    tagCount: Object.keys(dump).length,
    dump,
    device: { make: desc(tags, "Make"), model: desc(tags, "Model"), software: desc(tags, "Software") },
    timestamp: {
      value: tsValue,
      sourceTag: tsSource,
      offset: desc(tags, "OffsetTimeOriginal") ?? desc(tags, "OffsetTime"),
      subSec: desc(tags, "SubSecTimeOriginal"),
      gpsUtc: gpsDate != null && gpsTime != null ? `${gpsDate} ${gpsTime} UTC (satellite clock)` : null,
      deltaVsLastModifiedMs: parsedClock != null && lastModified != null ? lastModified - parsedClock : null,
    },
    gps:
      lat != null && lon != null
        ? {
            lat,
            lon,
            altitude: altitude != null ? `${altitude}${altRef ? ` (${altRef})` : ""}` : null,
            refNote: `refs ${latRef || "absent"}/${lonRef || "absent"}`,
          }
        : null,
    extras,
  };
}

/** Assembles the honest JSON payload: file facts, parsed EXIF (or the parse error), the observed timeline, and the screening verdict — heavy rendered image payloads excluded with an explicit note. */
function buildInspectionExport(file: Blob, state: ParseState, meta: ExifExportMeta | undefined): Record<string, unknown> {
  let lastEpoch: number | null = null;
  const events = (meta?.timeline ?? []).map((ev, i) => {
    const delta = ev.epochMs != null && lastEpoch != null ? ev.epochMs - lastEpoch : null;
    if (ev.epochMs != null) lastEpoch = ev.epochMs;
    return {
      seq: i + 1,
      at: ev.epochMs != null ? new Date(ev.epochMs).toISOString() : null,
      epochMs: ev.epochMs,
      deltaFromPreviousTimestampedEventMs: delta,
      label: ev.label,
      detail: ev.detail ?? null,
    };
  });

  const screening = meta?.screening
    ? {
        available: true,
        engine: meta.screening.telemetry?.engine ?? null,
        generatedAt: meta.screening.generatedAt,
        verdict: meta.screening.verdict,
        verdictLabel: meta.screening.verdictLabel,
        authenticityScore: meta.screening.score,
        evidenceConfidence: meta.screening.confidence,
        findings: meta.screening.findings.map((f) => ({
          id: f.id,
          label: f.label,
          status: f.status,
          detail: f.detail,
          observed: f.observed ?? null,
          expected: f.expected ?? null,
          category: f.category ?? null,
          weight: f.weight,
        })),
        categories: meta.screening.categories,
        retakeAdvice: meta.screening.retakeAdvice,
        telemetry: meta.screening.telemetry ?? null,
        note: "Findings, scores, and telemetry exported verbatim. Rendered heat-map/chart image payloads (ELA maps, visuals) are intentionally omitted from this JSON — view them in the on-screen report.",
      }
    : { available: false, note: "No fraud screening is attached to this photo." };

  return {
    format: "verification-hub/exif-inspection@1",
    exportedAt: new Date().toISOString(),
    file: {
      name: meta?.fileName ?? (file instanceof File ? file.name : null),
      mimeType: file.type || null,
      sizeBytes: file.size,
      lastModified: file instanceof File ? new Date(file.lastModified).toISOString() : null,
      lastModifiedNote:
        file instanceof File
          ? "declared by the OS/filesystem — not measured by this app"
          : "in-browser blob — no filesystem clock exists for this object",
    },
    source: meta?.source ?? null,
    exif:
      state.status === "done"
        ? {
            parsed: true,
            tagCount: state.parsed.tagCount,
            headline: {
              device: {
                presentInFile: state.parsed.device.make != null || state.parsed.device.model != null,
                make: state.parsed.device.make,
                model: state.parsed.device.model,
                software: state.parsed.device.software,
              },
              captureTimestamp: {
                presentInFile: state.parsed.timestamp.value != null,
                value: state.parsed.timestamp.value,
                sourceTag: state.parsed.timestamp.sourceTag,
                timezoneOffset: state.parsed.timestamp.offset,
                subSecond: state.parsed.timestamp.subSec,
                gpsUtcClock: state.parsed.timestamp.gpsUtc,
                deltaVsFileLastModifiedMs: state.parsed.timestamp.deltaVsLastModifiedMs,
              },
              geolocation: state.parsed.gps
                ? {
                    presentInFile: true,
                    latitude: state.parsed.gps.lat,
                    longitude: state.parsed.gps.lon,
                    altitude: state.parsed.gps.altitude,
                    hemisphereRefs: state.parsed.gps.refNote,
                  }
                : { presentInFile: false },
            },
            captureParameters: state.parsed.extras,
            rawTags: state.parsed.dump,
            rawTagsNote: "Every readable tag, stringified verbatim (values over 260 chars truncated with an explicit marker; embedded thumbnail binary omitted).",
          }
        : {
            parsed: false,
            error: state.status === "error" ? state.message : "parse still in progress",
            note: "Zero readable tags is itself a finding — original camera files always carry EXIF; stripped files usually passed through an editor, messenger, screenshot, or in-browser canvas pipeline.",
          },
    verificationTimeline: {
      recorded: events.length > 0,
      clockNote:
        events.length > 0
          ? "Epoch-millisecond wall-clock timestamps from this device's clock, recorded live at capture time. Deltas are computed between consecutive timestamped events; events without a timestamp are boolean observations."
          : "No session timeline was recorded for this photo — it was inspected without capture context. Nothing is reconstructed after the fact.",
      events,
    },
    screening,
    honesty:
      "Facts are read verbatim from the file; absent tags are reported absent, never inferred. Timeline events are only those actually observed this session. Parsing and export happen locally — the photo never leaves the device.",
  };
}

function FactTile({
  icon,
  title,
  present,
  children,
  absentReason,
}: {
  icon: React.ReactNode;
  title: string;
  present: boolean;
  children?: React.ReactNode;
  absentReason: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-2.5",
        present ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={cn(present ? "text-emerald-400" : "text-amber-400")}>{icon}</span>
        {title}
        <span
          className={cn(
            "ml-auto rounded-md border px-1.5 py-0.5 text-[8.5px] font-bold tracking-wide",
            present ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300"
          )}
        >
          {present ? "IN FILE" : "NOT IN FILE"}
        </span>
      </div>
      {present ? (
        <div className="mt-1.5">{children}</div>
      ) : (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">{absentReason}</p>
      )}
    </div>
  );
}

/**
 * Reusable EXIF inspection panel: parses a photo blob locally on mount and
 * renders device / timestamp / geolocation headline tiles (absent tags
 * reported absent, never inferred), capture-parameter chips, and the complete
 * raw tag dump. The Δ-vs-lastModified row only appears for real File objects
 * — a plain Blob has no filesystem clock, so nothing is invented. A download
 * button exports the raw metadata plus the photo's verification timeline
 * (when capture context was recorded) as a structured JSON file.
 */
export function ExifInspector({ file, exportMeta }: { file: Blob; exportMeta?: ExifExportMeta }) {
  const [state, setState] = useState<ParseState>({ status: "parsing" });
  const [dumpOpen, setDumpOpen] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "parsing" });
    setDumpOpen(false);
    parsePhoto(file)
      .then((parsed) => {
        if (!cancelled) setState({ status: "done", parsed });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const downloadExport = () => {
    const payload = buildInspectionExport(file, state, exportMeta);
    const rawBase = exportMeta?.fileName || (file instanceof File ? file.name : "") || "photo";
    const fileName = `${rawBase.replace(/\.[a-z0-9]+$/i, "")}.exif-inspection.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    console.log(`[ExifInspector] JSON export downloaded: ${fileName}`);
  };

  const delta = state.status === "done" ? state.parsed.timestamp.deltaVsLastModifiedMs : null;
  const deviceLine = (() => {
    if (state.status !== "done") return "";
    const { make, model } = state.parsed.device;
    if (model != null && make != null) return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
    return model ?? make ?? "";
  })();

  return (
    <div className="space-y-2">
      {state.status === "parsing" ? (
        <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/40 p-3 text-[11px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading metadata locally…
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[11px] leading-relaxed text-rose-200">
          Metadata could not be parsed: {state.message}. Zero readable tags is itself a finding — original camera files always carry
          EXIF; stripped files usually passed through an editor, messenger, or screenshot pipeline. In-browser canvas exports carry no
          camera metadata by design.
        </div>
      ) : null}

      {state.status === "done" ? (
        <>
          <div className="grid gap-2">
            <FactTile
              icon={<Smartphone className="h-3.5 w-3.5" />}
              title="Device"
              present={state.parsed.device.make != null || state.parsed.device.model != null}
              absentReason="No Make/Model tags — screenshots, downloads, in-browser canvas exports, and messaging-app re-saves strip device identity. A fresh camera-app capture always carries it."
            >
              <p className="text-[13px] font-semibold leading-tight">{deviceLine}</p>
              {state.parsed.device.software ? (
                <p className="mono mt-0.5 text-[10px] text-muted-foreground">Software: {state.parsed.device.software}</p>
              ) : null}
            </FactTile>

            <FactTile
              icon={<CalendarClock className="h-3.5 w-3.5" />}
              title="Capture timestamp"
              present={state.parsed.timestamp.value != null}
              absentReason="No DateTimeOriginal/DateTime tags in the file — the capture moment was not recorded or was stripped in transit."
            >
              <p className="mono text-[13px] font-semibold leading-tight">{state.parsed.timestamp.value}</p>
              <p className="mono mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {state.parsed.timestamp.sourceTag}
                {state.parsed.timestamp.subSec ? ` · sub-second .${state.parsed.timestamp.subSec}` : ""}
                {state.parsed.timestamp.offset
                  ? ` · timezone ${state.parsed.timestamp.offset}`
                  : " · no timezone tag (EXIF clocks are whole-second local time)"}
                {state.parsed.timestamp.gpsUtc ? ` · ${state.parsed.timestamp.gpsUtc}` : ""}
                {delta != null ? ` · Δ vs file lastModified ${delta >= 0 ? "+" : "−"}${(Math.abs(delta) / 1000).toFixed(1)}s` : ""}
              </p>
            </FactTile>

            <FactTile
              icon={<MapPin className="h-3.5 w-3.5" />}
              title="Geolocation"
              present={state.parsed.gps != null}
              absentReason="No GPS tags — normal, not suspicious: browser-mediated captures usually strip location, and camera apps only embed it when they hold location permission."
            >
              {state.parsed.gps ? (
                <>
                  <p className="mono text-[13px] font-semibold leading-tight">
                    {state.parsed.gps.lat.toFixed(6)}, {state.parsed.gps.lon.toFixed(6)}
                  </p>
                  <p className="mono mt-0.5 text-[10px] text-muted-foreground">
                    {state.parsed.gps.altitude ? `altitude ${state.parsed.gps.altitude} · ` : ""}
                    {state.parsed.gps.refNote}
                  </p>
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${state.parsed.gps.lat}&mlon=${state.parsed.gps.lon}#map=16/${state.parsed.gps.lat}/${state.parsed.gps.lon}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 rounded-lg border border-border/70 bg-background/60 px-2 py-1 text-[10px] font-semibold text-foreground transition-colors hover:bg-background"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open on map
                  </a>
                </>
              ) : null}
            </FactTile>
          </div>

          {state.parsed.extras.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {state.parsed.extras.map((row) => (
                <span key={row.label} className="mono rounded-md border border-border/70 bg-background/50 px-1.5 py-0.5 text-[9.5px] text-muted-foreground">
                  <span className="font-semibold text-foreground/80">{row.label}</span> {row.value}
                </span>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setDumpOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-xl border border-border/70 bg-background/40 px-3 py-2 text-left text-[11px] font-semibold transition-colors hover:bg-background/60"
            aria-expanded={dumpOpen}
          >
            Complete raw tag dump ({state.parsed.tagCount} tags)
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", dumpOpen && "rotate-180")} />
          </button>
          {dumpOpen ? (
            <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-xl border border-border/70 bg-background/40 p-2.5">
              {Object.entries(state.parsed.dump).map(([k, v]) => (
                <p key={k} className="mono break-all text-[9.5px] leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground/80">{k}:</span> {v}
                </p>
              ))}
            </div>
          ) : null}

          <p className="text-[9.5px] leading-snug text-muted-foreground/70">
            Parsed locally with ExifReader — the file never leaves this device. Facts are read verbatim; absent tags are reported
            absent, never inferred.
          </p>
        </>
      ) : null}

      {state.status !== "parsing" ? (
        <>
          <button
            type="button"
            onClick={downloadExport}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20"
          >
            <Download className="h-3.5 w-3.5" />
            Download JSON — raw metadata + verification timeline
          </button>
          {!exportMeta ? (
            <p className="text-[9.5px] leading-snug text-muted-foreground/70">
              No capture timeline was recorded for this photo — the export says so explicitly instead of reconstructing one.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Diagnostic-hub view of the newest captured photo's EXIF: file facts line +
 * the reusable ExifInspector panel, with an explicit empty state before the
 * first capture of the session.
 */
export default function LastPhotoExif({ shot }: { shot: LastPhotoShot | null }) {
  if (!shot) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-border/70 bg-background/40 p-3">
        <ImageOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No photo captured yet this session. Use the capture buttons above (any capture engine) — the newest photo's metadata is
          extracted here automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="mono break-all text-[10px] leading-relaxed text-muted-foreground">
        {shot.file.name || "(unnamed)"} · {(shot.file.size / 1024).toFixed(0)} KB · {shot.file.type || "unknown type"} · via {shot.label} ·
        file lastModified {new Date(shot.file.lastModified).toISOString()}
      </p>
      <ExifInspector file={shot.file} exportMeta={shot.exportMeta} />
    </div>
  );
}
