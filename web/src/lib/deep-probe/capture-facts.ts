/**
 * The facts pass — one walk over each capture, producing everything the sheets
 * need and nothing they do not.
 *
 * This used to live inside the archive builder, which had the effect of holding
 * the cheapest and most useful products of a run hostage to the most expensive
 * and most fragile one. If the ZIP died, the stat sheet, the correlation brief
 * and the device spec died with it, even though not one of them needs the
 * archive to exist. Splitting the pass out fixes that: the facts are read
 * first, the sheets are written from the facts, and the archive is attempted
 * afterwards, only if asked for.
 *
 * Two disciplines this file keeps:
 *
 *   • It breathes. Every capture is a decode, a checksum and two parses, and a
 *     loop that never yields is the exact shape a phone browser kills for being
 *     unresponsive. Control goes back to the event loop on a cadence.
 *
 *   • It can let go. When the archive has not been asked for, the bytes are
 *     only needed long enough to read their facts, so the reference is dropped
 *     the moment the last parse finishes. That is stated to the caller, and the
 *     archive builder refuses to run against released captures rather than
 *     quietly writing empty files.
 */

import ExifReader from "exifreader";

import { safeZipPath } from "../zip-writer";
import { breatheEvery } from "./breathe";
import type { ProbeCapture } from "./camera-matrix";
import type { BriefCapture } from "./correlation-brief";
import { readExifIfds, type ExifIfdReport } from "./exif-ifd";
import { hashBlob, type FileHashes } from "./hashes";
import { readJpegEncoderBytes, type JpegEncoderReport } from "./jpeg-encoder";
import { STABLE_TAG_KEYS, type MimicCaptureFact } from "./mimic-spec";
import { walkStructure, type StructureReport } from "./raw-bytes";

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** The file extension a capture should carry, taken from its own name first. */
export function extensionFor(blob: Blob, fileName: string | null): string {
  const fromName = fileName?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const base = blob.type.split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] ?? "bin";
}

/** Captures whose bytes this app did not author go in `captures/`; the ones it did go in `rendered-frames/`. */
export function folderFor(capture: Pick<ProbeCapture, "origin">): "captures" | "rendered-frames" {
  return capture.origin === "app-encoded-frame" ? "rendered-frames" : "captures";
}

/** Where a capture's bytes came from, said plainly, once, in one place. */
export const ORIGIN_TEXT: Record<string, string> = {
  "camera-file": "A file the operating system's camera app produced and handed to the browser. These are the camera's own bytes, with whatever metadata it chose to write.",
  "supplied-file": "A file selected from storage. Copied in byte-for-byte; this app cannot know what happened to it before it arrived.",
  "platform-photo":
    "A still the browser's own photo pipeline produced from a live camera track. The bytes are the platform's; browsers write little or no camera metadata on this path, so sparse tags here are normal and mean nothing.",
  "recorder-stream": "The byte stream the browser's media recorder produced from a live track.",
  "app-encoded-frame":
    "A frame THIS APP drew from the video track onto a canvas and encoded as JPEG. It is not a camera file: the pixels came from the browser, the JPEG around them was written here. That is why it sits outside the captures folder.",
};

function tagValue(tag: unknown): string {
  if (tag == null) return "";
  const holder = tag as { description?: unknown; value?: unknown };
  const raw = holder.description ?? holder.value ?? tag;
  let text: string;
  if (Array.isArray(raw)) text = raw.length > 48 ? `[${raw.length} values] ${JSON.stringify(raw.slice(0, 24))}…` : JSON.stringify(raw);
  else if (typeof raw === "object") {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  } else text = String(raw);
  return text.length > 600 ? `${text.slice(0, 600)}… (${text.length} chars total)` : text;
}

export type TagDump = {
  text: string;
  count: number;
  unknown: number;
  /**
   * Tags excluding the parser's own `file` group. That group holds only the
   * detected container type, which every readable image has, so counting it
   * would mean a frame with genuinely no metadata never registered as one.
   */
  metadataCount: number;
  keys: string[];
  stableTags: Record<string, string>;
};

/** The parser's synthetic group. Present for any readable file, so never evidence. */
const SYNTHETIC_GROUP = "file";

/**
 * Full tag listing, including the entries no dictionary names. `includeUnknown`
 * is the point of this function: the undocumented tags are exactly the ones a
 * normal viewer hides, and they are frequently the most device-specific.
 */
export function tagDumpFromBytes(bytes: Uint8Array, label: string): TagDump {
  const lines: string[] = [`TAG DUMP — ${label}`, "=".repeat(78), ""];
  const namedKeys: string[] = [];
  const stableTags: Record<string, string> = {};
  let count = 0;
  let unknown = 0;
  let metadataCount = 0;
  try {
    const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const tags = ExifReader.load(view, { expanded: true, includeUnknown: true }) as unknown as Record<string, Record<string, unknown>>;
    lines.push(
      "Read directly from the archived bytes, with unknown and undocumented entries INCLUDED. Ordinary",
      "metadata viewers drop those, which is a shame: an unnamed tag is still a fact about the device that",
      "wrote the file, and on phone cameras there are usually plenty of them.",
      ""
    );
    for (const group of Object.keys(tags).sort()) {
      const groupTags = tags[group];
      if (!groupTags || typeof groupTags !== "object") continue;
      const groupKeys = Object.keys(groupTags);
      if (groupKeys.length === 0) continue;
      const synthetic = group === SYNTHETIC_GROUP;
      lines.push("", `── ${group} (${groupKeys.length})${synthetic ? " — the parser's own detection, not the file's metadata" : ""} ──`);
      for (const key of groupKeys.sort()) {
        if (key === "Thumbnail") {
          lines.push(`  ${key} = [embedded thumbnail — carved out as its own file, see the segments folder]`);
          count += 1;
          metadataCount += 1;
          continue;
        }
        const isUnknown = /^undefined-|^unknown/i.test(key) || /^\d+$/.test(key);
        if (isUnknown) unknown += 1;
        const value = tagValue(groupTags[key]);
        lines.push(`  ${isUnknown ? "[undocumented] " : ""}${key} = ${value}`);
        if (!isUnknown) namedKeys.push(key);
        if (STABLE_TAG_KEYS.includes(key) && value.length > 0 && stableTags[key] == null) stableTags[key] = value;
        count += 1;
        if (!synthetic) metadataCount += 1;
      }
    }
    if (metadataCount === 0) {
      lines.push(
        "",
        "No metadata at all.",
        "",
        count > 0
          ? "The only entry above is the parser naming the container it recognised. Every readable image has that,"
          : "Not even a container type could be read.",
        count > 0 ? "so it says nothing about the device and is not counted as metadata." : "",
        "",
        "For a frame this app encoded from a video track that is the expected and only possible result — a",
        "canvas encode cannot carry camera metadata. Absence here is not evidence of anything."
      );
    }
  } catch (err) {
    lines.push(`The metadata parser could not read this file: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { text: lines.join("\n"), count, unknown, metadataCount, keys: namedKeys, stableTags };
}

/** Everything one walk over a capture's bytes yields. */
export type CaptureFacts = {
  slug: string;
  label: string;
  /** Where it sits inside an archive, whether or not one is ever built. */
  archivePath: string;
  origin: string;
  path: ProbeCapture["path"];
  stage: ProbeCapture["stage"];
  deviceLabel: string | null;
  takenAt: string;
  asked: string;
  granted: string;
  fileName: string | null;
  fileLastModified: number | null;
  fileRelativePath: string | null;
  bytes: number;
  mime: string;
  width: number;
  height: number;
  hashes: FileHashes;
  encoder: JpegEncoderReport | null;
  ifd: ExifIfdReport | null;
  structure: StructureReport;
  tags: TagDump;
  /** MD5 of the exact colour-profile bytes, when a profile is embedded. */
  iccMd5: string | null;
  /** Facts about this capture in the shape the mimic spec consumes. */
  spec: MimicCaptureFact;
  /** The same in the shape the correlation brief consumes. */
  brief: BriefCapture;
  /** Anything that could not be read, named rather than dropped. */
  warnings: string[];
};

export type FactsProgress = (message: string, done: number, total: number) => void;

export type FactsOptions = {
  /**
   * Drop each capture's bytes the moment its facts are read. Chosen when no
   * archive was asked for: the bytes have no further use and holding a few
   * hundred megabytes to build sheets that do not need them is the whole
   * problem this pass exists to avoid.
   */
  release: boolean;
  onProgress?: FactsProgress;
  /** Called before each unit of work, so the crash trail can record it. */
  onStep?: (step: string) => void;
  /** Called after each release, with the bytes still held. */
  onHeldBytes?: (bytes: number) => void;
};

export type FactsResult = {
  facts: CaptureFacts[];
  warnings: string[];
  /** True when the bytes were dropped, so no archive can be built from this run. */
  released: boolean;
  /** Total capture bytes walked, whether or not they were kept. */
  bytesRead: number;
  /** How many times control went back to the browser during the pass. */
  yields: number;
};

/**
 * Reads every capture once.
 *
 * When `release` is set the caller's array is drained as the pass proceeds —
 * that is deliberate and is the only way each blob becomes collectable at the
 * moment its facts are read rather than at the end of the loop. When it is not
 * set the caller's array is left exactly as it was.
 */
export async function readCaptureFacts(captures: ProbeCapture[], options: FactsOptions): Promise<FactsResult> {
  const facts: CaptureFacts[] = [];
  const warnings: string[] = [];
  const queue = options.release ? captures : [...captures];
  const total = queue.length;
  const breather = breatheEvery();
  let done = 0;
  let bytesRead = 0;
  let heldBytes = queue.reduce((sum, capture) => sum + capture.blob.size, 0);

  while (queue.length > 0) {
    // shift() rather than an index walk: with `release` on, this is the moment
    // the caller stops referencing the blob, and it has to happen before the
    // parses rather than after the loop.
    const capture = queue.shift();
    if (!capture) break;
    const captureWarnings: string[] = [];
    const ext = extensionFor(capture.blob, capture.fileName);
    const archivePath = `${folderFor(capture)}/${safeZipPath(`${capture.slug}.${ext}`)}`;

    options.onStep?.(`Checksumming ${capture.slug} (${(capture.blob.size / 1024 / 1024).toFixed(1)} MB)`);
    const hashes = await hashBlob(capture.blob);
    await breather.tick();

    options.onStep?.(`Parsing ${capture.slug}`);
    let encoder: JpegEncoderReport | null = null;
    let ifd: ExifIfdReport | null = null;
    let tags: TagDump = { text: `TAG DUMP — ${capture.label}\n\nThe bytes could not be read.`, count: 0, unknown: 0, metadataCount: 0, keys: [], stableTags: {} };
    try {
      // One read of the bytes feeds all three parsers. Reading three times was
      // three full copies of the file alive at once for no benefit.
      const bytes = new Uint8Array(await capture.blob.arrayBuffer());
      encoder = readJpegEncoderBytes(bytes);
      ifd = readExifIfds(bytes);
      tags = tagDumpFromBytes(bytes, capture.label);
    } catch (err) {
      captureWarnings.push(
        `${capture.slug}: the encoder, directory and tag parses could not read the bytes (${err instanceof Error ? err.message : String(err)}). Reported rather than skipped silently.`
      );
    }
    await breather.tick();

    options.onStep?.(`Mapping the structure of ${capture.slug}`);
    const structure = await walkStructure(capture.blob);
    let iccMd5: string | null = null;
    const icc = structure.segments.find((segment) => segment.name === "icc-profile");
    if (icc && icc.offset >= 0 && icc.length > 0 && icc.offset + icc.length <= capture.blob.size) {
      try {
        iccMd5 = (await hashBlob(capture.blob.slice(icc.offset, icc.offset + icc.length))).md5;
      } catch {
        iccMd5 = null;
      }
    }
    await breather.tick();

    bytesRead += capture.blob.size;
    if (options.release) {
      heldBytes = Math.max(0, heldBytes - capture.blob.size);
      options.onHeldBytes?.(heldBytes);
    }

    facts.push({
      slug: capture.slug,
      label: capture.label,
      archivePath,
      origin: capture.origin,
      path: capture.path,
      stage: capture.stage,
      deviceLabel: capture.deviceLabel,
      takenAt: capture.takenAt,
      asked: capture.asked,
      granted: capture.granted,
      fileName: capture.fileName,
      fileLastModified: capture.fileLastModified,
      fileRelativePath: capture.fileRelativePath,
      bytes: capture.blob.size,
      mime: capture.blob.type,
      width: capture.width,
      height: capture.height,
      hashes,
      encoder,
      ifd,
      structure,
      tags,
      iccMd5,
      spec: {
        slug: capture.slug,
        origin: capture.origin,
        path: capture.path,
        deviceLabel: capture.deviceLabel,
        width: capture.width,
        height: capture.height,
        bytes: capture.blob.size,
        mime: capture.blob.type,
        container: structure.container,
        markers: structure.nodes.filter((node) => node.depth === 0).map((node) => node.id).slice(0, 48),
        segments: structure.segments.map((segment) => segment.name),
        tagCount: tags.count,
        unknownTagCount: tags.unknown,
        tagKeys: tags.keys,
        stableTags: tags.stableTags,
      },
      brief: {
        slug: capture.slug,
        archivePath,
        label: capture.label,
        path: capture.path,
        origin: capture.origin,
        deviceLabel: capture.deviceLabel,
        fileName: capture.fileName,
        fileLastModified: capture.fileLastModified,
        fileRelativePath: capture.fileRelativePath,
        bytes: capture.blob.size,
        mime: capture.blob.type,
        width: capture.width,
        height: capture.height,
        encoder,
        ifd,
        iccMd5,
      },
      warnings: captureWarnings,
    });
    warnings.push(...captureWarnings);

    done += 1;
    options.onProgress?.(`Read ${capture.slug}`, done, total);
    await breather.tick();
  }

  return { facts, warnings, released: options.release, bytesRead, yields: breather.yields() };
}
