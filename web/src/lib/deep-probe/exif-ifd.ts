/**
 * A raw walk of the EXIF/TIFF directories.
 *
 * The archive already carries a friendly tag listing from a metadata library.
 * This is the other half, and for correlation work it is the more useful one: it
 * reports every entry as it is physically stored — tag ID, TIFF type, component
 * count and the undecoded value — rather than a formatted rendering of it.
 *
 * That distinction is the whole point. `ExposureTime` presented as `0.016667`
 * and `ExposureTime` stored as the rational `1/60` are the same reading and
 * different bytes, and only one of them tells you what to write. A library that
 * helpfully normalises rationals to decimals has destroyed exactly the detail
 * needed here.
 *
 * The walk also records structure a tag list cannot express: byte order, the
 * order the directories appear in, which sub-IFDs exist, and where IFD1 sits.
 */

export type IfdEntry = {
  /** Tag number as stored, hex. */
  tagHex: string;
  tag: number;
  /** Dictionary name, or null when no dictionary names it. Unnamed is not the same as absent. */
  name: string | null;
  typeCode: number;
  typeName: string;
  count: number;
  /** Total bytes the value occupies. */
  valueBytes: number;
  /** True when the value fits in the 4-byte slot and has no separate offset. */
  inline: boolean;
  /** Where the value actually lives. */
  valueOffset: number;
  /** The value in its stored form: rationals as num/den, ASCII quoted, undefined as hex. */
  raw: string;
};

export type IfdBlock = {
  /** IFD0, ExifIFD, GPS, Interop, IFD1. */
  name: string;
  offset: number;
  entryCount: number;
  entries: IfdEntry[];
  /** Offset of the next IFD in the chain, 0 when this is the last. */
  nextOffset: number;
};

export type ExifIfdReport = {
  found: boolean;
  /** Where the TIFF header starts inside the file. */
  tiffOffset: number;
  byteOrder: "II (little-endian)" | "MM (big-endian)" | "unknown";
  /** The 42 magic number, which should be exactly 42. */
  magic: number | null;
  blocks: IfdBlock[];
  /** Directory names in the order they were reached. */
  ifdOrder: string[];
  hasIfd1: boolean;
  makerNote: { bytes: number; offset: number; signature: string } | null;
  /** ColorSpace tag value: 1 = sRGB, 65535 = uncalibrated (Apple's Display P3 marker). */
  colorSpace: number | null;
  interopIndex: string | null;
  /** Present GPS tags with their reference tags resolved. */
  gps: { tag: string; value: string }[];
  warnings: string[];
};

const TYPE_NAMES: Record<number, string> = {
  1: "BYTE",
  2: "ASCII",
  3: "SHORT",
  4: "LONG",
  5: "RATIONAL",
  6: "SBYTE",
  7: "UNDEFINED",
  8: "SSHORT",
  9: "SLONG",
  10: "SRATIONAL",
  11: "FLOAT",
  12: "DOUBLE",
  13: "IFD",
};

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

/** Tags the correlation work asks for by name, plus the usual neighbours. */
const TAG_NAMES: Record<number, string> = {
  0x0100: "ImageWidth",
  0x0101: "ImageLength",
  0x0102: "BitsPerSample",
  0x0103: "Compression",
  0x0106: "PhotometricInterpretation",
  0x010e: "ImageDescription",
  0x010f: "Make",
  0x0110: "Model",
  0x0111: "StripOffsets",
  0x0112: "Orientation",
  0x0115: "SamplesPerPixel",
  0x0116: "RowsPerStrip",
  0x0117: "StripByteCounts",
  0x011a: "XResolution",
  0x011b: "YResolution",
  0x011c: "PlanarConfiguration",
  0x0128: "ResolutionUnit",
  0x0131: "Software",
  0x0132: "DateTime",
  0x013b: "Artist",
  0x013c: "HostComputer",
  0x013e: "WhitePoint",
  0x013f: "PrimaryChromaticities",
  0x0201: "JPEGInterchangeFormat (thumbnail offset)",
  0x0202: "JPEGInterchangeFormatLength (thumbnail bytes)",
  0x0211: "YCbCrCoefficients",
  0x0212: "YCbCrSubSampling",
  0x0213: "YCbCrPositioning",
  0x0214: "ReferenceBlackWhite",
  0x8298: "Copyright",
  0x829a: "ExposureTime",
  0x829d: "FNumber",
  0x8769: "ExifIFDPointer",
  0x8822: "ExposureProgram",
  0x8824: "SpectralSensitivity",
  0x8825: "GPSInfoIFDPointer",
  0x8827: "PhotographicSensitivity (ISO)",
  0x8828: "OECF",
  0x8830: "SensitivityType",
  0x8831: "StandardOutputSensitivity",
  0x8832: "RecommendedExposureIndex",
  0x8833: "ISOSpeed",
  0x9000: "ExifVersion",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x9010: "OffsetTime",
  0x9011: "OffsetTimeOriginal",
  0x9012: "OffsetTimeDigitized",
  0x9101: "ComponentsConfiguration",
  0x9102: "CompressedBitsPerPixel",
  0x9201: "ShutterSpeedValue",
  0x9202: "ApertureValue",
  0x9203: "BrightnessValue",
  0x9204: "ExposureBiasValue",
  0x9205: "MaxApertureValue",
  0x9206: "SubjectDistance",
  0x9207: "MeteringMode",
  0x9208: "LightSource",
  0x9209: "Flash",
  0x920a: "FocalLength",
  0x9214: "SubjectArea",
  0x927c: "MakerNote",
  0x9286: "UserComment",
  0x9290: "SubSecTime",
  0x9291: "SubSecTimeOriginal",
  0x9292: "SubSecTimeDigitized",
  0xa000: "FlashpixVersion",
  0xa001: "ColorSpace",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
  0xa004: "RelatedSoundFile",
  0xa005: "InteroperabilityIFDPointer",
  0xa20e: "FocalPlaneXResolution",
  0xa20f: "FocalPlaneYResolution",
  0xa210: "FocalPlaneResolutionUnit",
  0xa214: "SubjectLocation",
  0xa215: "ExposureIndex",
  0xa217: "SensingMethod",
  0xa300: "FileSource",
  0xa301: "SceneType",
  0xa302: "CFAPattern",
  0xa401: "CustomRendered",
  0xa402: "ExposureMode",
  0xa403: "WhiteBalance",
  0xa404: "DigitalZoomRatio",
  0xa405: "FocalLengthIn35mmFilm",
  0xa406: "SceneCaptureType",
  0xa407: "GainControl",
  0xa408: "Contrast",
  0xa409: "Saturation",
  0xa40a: "Sharpness",
  0xa40c: "SubjectDistanceRange",
  0xa420: "ImageUniqueID",
  0xa430: "CameraOwnerName",
  0xa431: "BodySerialNumber",
  0xa432: "LensSpecification",
  0xa433: "LensMake",
  0xa434: "LensModel",
  0xa435: "LensSerialNumber",
  0xa460: "CompositeImage",
  0xa461: "CompositeImageCount",
  0xa462: "CompositeImageExposureTimes",
  0xa500: "Gamma",
};

const GPS_TAG_NAMES: Record<number, string> = {
  0x0000: "GPSVersionID",
  0x0001: "GPSLatitudeRef",
  0x0002: "GPSLatitude",
  0x0003: "GPSLongitudeRef",
  0x0004: "GPSLongitude",
  0x0005: "GPSAltitudeRef",
  0x0006: "GPSAltitude",
  0x0007: "GPSTimeStamp",
  0x0008: "GPSSatellites",
  0x0009: "GPSStatus",
  0x000a: "GPSMeasureMode",
  0x000b: "GPSDOP",
  0x000c: "GPSSpeedRef",
  0x000d: "GPSSpeed",
  0x000e: "GPSTrackRef",
  0x000f: "GPSTrack",
  0x0010: "GPSImgDirectionRef",
  0x0011: "GPSImgDirection",
  0x0012: "GPSMapDatum",
  0x0013: "GPSDestLatitudeRef",
  0x0014: "GPSDestLatitude",
  0x0015: "GPSDestLongitudeRef",
  0x0016: "GPSDestLongitude",
  0x0017: "GPSDestBearingRef",
  0x0018: "GPSDestBearing",
  0x001d: "GPSDateStamp",
  0x001f: "GPSHPositioningError",
};

const INTEROP_TAG_NAMES: Record<number, string> = { 0x0001: "InteroperabilityIndex", 0x0002: "InteroperabilityVersion" };

function nameFor(tag: number, block: string): string | null {
  if (block === "GPS") return GPS_TAG_NAMES[tag] ?? null;
  if (block === "Interop") return INTEROP_TAG_NAMES[tag] ?? null;
  return TAG_NAMES[tag] ?? null;
}

/** Renders a value exactly as stored — the reason this module exists. */
function readValue(view: DataView, bytes: Uint8Array, at: number, type: number, count: number, little: boolean): string {
  const cap = 24;
  const shown = Math.min(count, cap);
  const suffix = count > cap ? ` … (+${count - cap} more)` : "";
  try {
    switch (type) {
      case 2: {
        let text = "";
        let nulTerminated = false;
        for (let i = 0; i < count; i += 1) {
          const b = bytes[at + i];
          if (b === 0) {
            nulTerminated = i === count - 1;
            break;
          }
          text += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
        }
        return `"${text}" (${count} bytes${nulTerminated ? ", NUL-terminated" : ", NOT NUL-terminated"})`;
      }
      case 5:
      case 10: {
        const parts: string[] = [];
        for (let i = 0; i < shown; i += 1) {
          const n = type === 5 ? view.getUint32(at + i * 8, little) : view.getInt32(at + i * 8, little);
          const d = type === 5 ? view.getUint32(at + i * 8 + 4, little) : view.getInt32(at + i * 8 + 4, little);
          parts.push(`${n}/${d}`);
        }
        return parts.join(" ") + suffix;
      }
      case 1:
      case 6: {
        const parts: string[] = [];
        for (let i = 0; i < shown; i += 1) parts.push(String(type === 1 ? bytes[at + i] : view.getInt8(at + i)));
        return parts.join(" ") + suffix;
      }
      case 7: {
        const parts: string[] = [];
        for (let i = 0; i < Math.min(count, 32); i += 1) parts.push(bytes[at + i].toString(16).padStart(2, "0"));
        return `0x${parts.join(" ")}${count > 32 ? ` … (+${count - 32} more)` : ""}`;
      }
      case 3:
      case 8: {
        const parts: string[] = [];
        for (let i = 0; i < shown; i += 1) parts.push(String(type === 3 ? view.getUint16(at + i * 2, little) : view.getInt16(at + i * 2, little)));
        return parts.join(" ") + suffix;
      }
      case 4:
      case 9:
      case 13: {
        const parts: string[] = [];
        for (let i = 0; i < shown; i += 1) parts.push(String(type === 9 ? view.getInt32(at + i * 4, little) : view.getUint32(at + i * 4, little)));
        return parts.join(" ") + suffix;
      }
      case 11: {
        const parts: string[] = [];
        for (let i = 0; i < shown; i += 1) parts.push(String(view.getFloat32(at + i * 4, little)));
        return parts.join(" ") + suffix;
      }
      case 12: {
        const parts: string[] = [];
        for (let i = 0; i < shown; i += 1) parts.push(String(view.getFloat64(at + i * 8, little)));
        return parts.join(" ") + suffix;
      }
      default:
        return `(type ${type} is not a TIFF type this walker knows; ${count} components left unread)`;
    }
  } catch {
    return "(value ran past the end of the file)";
  }
}

/** Locates the TIFF header: JPEG APP1/Exif, a bare TIFF, or a PNG eXIf chunk. */
function findTiff(bytes: Uint8Array): { offset: number; note: string } | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    let guard = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (at + 4 <= bytes.length && guard < 4096) {
      guard += 1;
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = view.getUint16(at + 2, false);
      if (marker === 0xe1 && at + 10 <= bytes.length) {
        const sig = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
        if (sig === "Exif") return { offset: at + 10, note: "APP1/Exif inside a JPEG" };
      }
      at += length + 2;
    }
    return null;
  }
  const head = String.fromCharCode(bytes[0], bytes[1]);
  if (head === "II" || head === "MM") return { offset: 0, note: "a bare TIFF file" };
  if (bytes.length > 8 && bytes[0] === 0x89) {
    for (let at = 8; at + 8 < bytes.length && at < 4 * 1024 * 1024; ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const length = view.getUint32(at, false);
      const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
      if (type === "eXIf") return { offset: at + 8, note: "an eXIf chunk inside a PNG" };
      if (type === "IEND") break;
      at += length + 12;
    }
  }
  return null;
}

/** Walks every directory in the EXIF block and reports entries as stored. */
export function readExifIfds(bytes: Uint8Array): ExifIfdReport {
  const report: ExifIfdReport = {
    found: false,
    tiffOffset: -1,
    byteOrder: "unknown",
    magic: null,
    blocks: [],
    ifdOrder: [],
    hasIfd1: false,
    makerNote: null,
    colorSpace: null,
    interopIndex: null,
    gps: [],
    warnings: [],
  };

  const located = findTiff(bytes);
  if (!located) {
    report.warnings.push("No EXIF block is present in this file. On an app-encoded canvas frame that is the only possible outcome and means nothing about the device.");
    return report;
  }

  const tiff = located.offset;
  if (tiff + 8 > bytes.length) {
    report.warnings.push("An EXIF marker was found but the TIFF header runs past the end of the file.");
    return report;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = String.fromCharCode(bytes[tiff], bytes[tiff + 1]);
  const little = order === "II";
  if (order !== "II" && order !== "MM") {
    report.warnings.push(`The TIFF header byte order reads "${order}", which is neither II nor MM. The walk stopped.`);
    return report;
  }

  report.found = true;
  report.tiffOffset = tiff;
  report.byteOrder = little ? "II (little-endian)" : "MM (big-endian)";
  report.magic = view.getUint16(tiff + 2, little);
  if (report.magic !== 42) {
    report.warnings.push(`The TIFF magic number is ${report.magic}, not 42. The rest of the walk may be unreliable and is reported as read.`);
  }

  const seen = new Set<number>();
  const queue: { name: string; relative: number }[] = [{ name: "IFD0", relative: view.getUint32(tiff + 4, little) }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const at = tiff + item.relative;
    if (item.relative === 0 || at + 2 > bytes.length || seen.has(at)) continue;
    seen.add(at);

    const entryCount = view.getUint16(at, little);
    if (entryCount > 512) {
      report.warnings.push(`${item.name} at byte ${at} claims ${entryCount} entries, which is implausible. It was skipped rather than guessed at.`);
      continue;
    }
    const entries: IfdEntry[] = [];
    const children: { name: string; relative: number }[] = [];

    for (let i = 0; i < entryCount; i += 1) {
      const entryAt = at + 2 + i * 12;
      if (entryAt + 12 > bytes.length) {
        report.warnings.push(`${item.name} entry ${i} runs past the end of the file.`);
        break;
      }
      const tag = view.getUint16(entryAt, little);
      const typeCode = view.getUint16(entryAt + 2, little);
      const count = view.getUint32(entryAt + 4, little);
      const unitSize = TYPE_SIZES[typeCode] ?? 0;
      const valueBytes = unitSize * count;
      const inline = valueBytes <= 4 && unitSize > 0;
      const valueOffset = inline ? entryAt + 8 : tiff + view.getUint32(entryAt + 8, little);
      const name = nameFor(tag, item.name);

      let raw: string;
      if (unitSize === 0) {
        raw = `(unknown TIFF type ${typeCode}, so the value length cannot be computed)`;
      } else if (valueOffset + valueBytes > bytes.length) {
        raw = `(value at ${valueOffset} for ${valueBytes} bytes runs past the end of the file)`;
      } else if (tag === 0x927c && item.name === "ExifIFD") {
        let sig = "";
        for (let j = 0; j < Math.min(16, valueBytes); j += 1) {
          const b = bytes[valueOffset + j];
          sig += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
        }
        raw = `${valueBytes} bytes, leading signature "${sig}" — carved whole to raw/segments/`;
        report.makerNote = { bytes: valueBytes, offset: valueOffset, signature: sig };
      } else {
        raw = readValue(view, bytes, valueOffset, typeCode, count, little);
      }

      entries.push({
        tagHex: `0x${tag.toString(16).padStart(4, "0")}`,
        tag,
        name,
        typeCode,
        typeName: TYPE_NAMES[typeCode] ?? `type ${typeCode}`,
        count,
        valueBytes,
        inline,
        valueOffset,
        raw,
      });

      if (tag === 0x8769 && item.name === "IFD0") children.push({ name: "ExifIFD", relative: view.getUint32(entryAt + 8, little) });
      if (tag === 0x8825 && item.name === "IFD0") children.push({ name: "GPS", relative: view.getUint32(entryAt + 8, little) });
      if (tag === 0xa005 && item.name === "ExifIFD") children.push({ name: "Interop", relative: view.getUint32(entryAt + 8, little) });
      if (tag === 0xa001 && item.name === "ExifIFD") report.colorSpace = view.getUint16(valueOffset, little);
      if (tag === 0x0001 && item.name === "Interop") report.interopIndex = raw;
      if (item.name === "GPS") report.gps.push({ tag: name ?? `0x${tag.toString(16).padStart(4, "0")}`, value: raw });
    }

    const nextAt = at + 2 + entryCount * 12;
    const nextOffset = nextAt + 4 <= bytes.length ? view.getUint32(nextAt, little) : 0;
    report.blocks.push({ name: item.name, offset: at, entryCount, entries, nextOffset });
    report.ifdOrder.push(item.name);
    queue.push(...children);
    if (item.name === "IFD0" && nextOffset !== 0) {
      report.hasIfd1 = true;
      queue.push({ name: "IFD1", relative: nextOffset });
    }
  }

  return report;
}

/** The readable IFD report that goes into the archive. */
export function ifdText(report: ExifIfdReport, label: string): string {
  const lines: string[] = [`RAW EXIF DIRECTORIES — ${label}`, "=".repeat(78), ""];
  if (!report.found) {
    lines.push("No EXIF block in this file.", "", ...report.warnings.map((w) => `  ${w}`));
    return lines.join("\n");
  }

  lines.push(
    "Every entry below is reported AS STORED: tag number, TIFF type, component count and the undecoded",
    "value. Rationals are printed as numerator/denominator, not as decimals, because 1/60 and 0.016667",
    "are the same reading and different bytes — and only one of them tells you what to write.",
    "",
    `TIFF header at byte  ${report.tiffOffset} (${report.byteOrder}, magic ${report.magic ?? "unreadable"})`,
    `Directory order      ${report.ifdOrder.join(" → ")}`,
    `IFD1 (thumbnail)     ${report.hasIfd1 ? "present" : "absent"}`,
    `ColorSpace tag       ${
      report.colorSpace == null
        ? "not present"
        : report.colorSpace === 1
          ? "1 (sRGB)"
          : report.colorSpace === 0xffff
            ? "65535 (uncalibrated) — how Apple marks a wide-gamut file; the ICC profile carries the real space"
            : String(report.colorSpace)
    }`,
    `InteroperabilityIndex ${report.interopIndex ?? "not present"}`,
    `MakerNote            ${report.makerNote ? `${report.makerNote.bytes.toLocaleString("en-US")} bytes at ${report.makerNote.offset}, signature "${report.makerNote.signature}"` : "absent — note that browsers strip this on most upload paths"}`,
    ""
  );

  for (const block of report.blocks) {
    lines.push(
      "=".repeat(78),
      `${block.name} — ${block.entryCount} entries at byte ${block.offset}${block.nextOffset !== 0 ? ` · next directory at ${block.offset > 0 ? report.tiffOffset + block.nextOffset : block.nextOffset}` : ""}`,
      "=".repeat(78),
      "  tag     type          count  bytes  at         name / value",
      "  " + "-".repeat(74)
    );
    for (const entry of block.entries) {
      lines.push(
        `  ${entry.tagHex}  ${entry.typeName.padEnd(12)} ${String(entry.count).padStart(6)} ${String(entry.valueBytes).padStart(6)}  ${String(entry.valueOffset).padStart(9)}  ${
          entry.name ?? "(no dictionary name — still a real fact about the writer)"
        }`,
        `${" ".repeat(12)}${entry.inline ? "inline" : "offset"}  =  ${entry.raw}`
      );
    }
    lines.push("");
  }

  if (report.gps.length > 0) {
    lines.push("GPS BLOCK, WITH REFERENCE TAGS", "-".repeat(78), "");
    for (const row of report.gps) lines.push(`  ${row.tag.padEnd(24)} ${row.value}`);
    lines.push("", "A coordinate without its Ref tag is ambiguous by 180 degrees, so both are listed.", "");
  } else {
    lines.push(
      "GPS BLOCK",
      "-".repeat(78),
      "  No GPS directory.",
      "",
      "  Three different situations produce this identical result: Location was off for the camera, location",
      "  was on but the OS withheld it, or something stripped the block afterwards. They are not",
      "  distinguishable from the file alone and no guess is made here.",
      ""
    );
  }

  if (report.warnings.length > 0) {
    lines.push("WHERE THE WALK STOPPED", "-".repeat(78), ...report.warnings.map((w) => `  ! ${w}`));
  }
  return lines.join("\n");
}
