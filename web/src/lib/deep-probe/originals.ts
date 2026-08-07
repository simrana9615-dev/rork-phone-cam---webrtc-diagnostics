/**
 * The two originals that survive a released run.
 *
 * A run without the archive ticked drops each photo's bytes the moment its facts
 * are read. That is what keeps a two-hundred-photo sweep inside a phone
 * browser's memory, and it is the right default — but it also throws away the
 * two most valuable files in the whole run.
 *
 * The camera-app handoffs are the only path that yields a file the CAMERA wrote:
 * its own quantisation tables, its own maker note, its own colour profile, its
 * own EXIF. Every other capture in the run is either a canvas encode (no
 * metadata at all, by construction) or a platform still (almost none). So the
 * back-camera file and the front-camera file are kept back from the release,
 * whatever else happens, and offered as plain downloads.
 *
 * What "raw" means here, precisely: the File object the operating system handed
 * over, saved with not one byte altered. Not re-encoded, not re-compressed, not
 * stripped, not stamped, and not wrapped in a container. Downloading it is a
 * copy, so the checksums in the sheets describe the file on disk exactly.
 *
 * Two disciplines, both inherited from the rest of this module:
 *
 *   • Only a real camera-app file qualifies. A library pick carries the same
 *     rich metadata and is filed next to it in the sheets, but it is not a photo
 *     taken just now and is never offered as one.
 *
 *   • A facing that produced nothing says so. An absent original is reported
 *     with its reason rather than quietly leaving one button on screen.
 */

import type { ProbeCapture } from "./camera-matrix";

/** The two sides a camera-app shot can come from. */
export type OriginalFacing = "environment" | "user";

export const ORIGINAL_FACINGS: OriginalFacing[] = ["environment", "user"];

export const FACING_LABEL: Record<OriginalFacing, string> = {
  environment: "Back camera",
  user: "Front camera",
};

/** Short form used in file names. */
const FACING_SLUG: Record<OriginalFacing, string> = {
  environment: "back",
  user: "front",
};

/** One capture offered up for consideration, described by the code that made it. */
export type OriginalCandidate = {
  slug: string;
  facing: OriginalFacing;
  /** How the bytes were produced. Only `camera-file` can be an original. */
  path: ProbeCapture["path"];
  /** Where the bytes came from. Must agree with the path. */
  origin: ProbeCapture["origin"];
};

/**
 * True only for a file the operating system's camera app produced.
 *
 * Both fields are checked rather than either: they are declared independently at
 * the moment of capture, and a disagreement between them means something has
 * gone wrong upstream. In that case the file is not offered, because the one
 * thing this module must never do is hand someone a library pick labelled as a
 * photo they just took.
 */
export function isCameraOriginal(candidate: Pick<OriginalCandidate, "path" | "origin">): boolean {
  return candidate.path === "camera-file" && candidate.origin === "camera-file";
}

/**
 * Picks the first genuine camera-app file for each facing.
 *
 * First rather than best: all three handoffs open the same camera app and the
 * differences between them live in the file name and timestamp, not the image.
 * Choosing the earliest one keeps the choice predictable and means a skipped
 * first engine simply promotes the next.
 */
export function chooseOriginals(candidates: OriginalCandidate[]): Record<OriginalFacing, string | null> {
  const chosen: Record<OriginalFacing, string | null> = { environment: null, user: null };
  for (const candidate of candidates) {
    if (!isCameraOriginal(candidate)) continue;
    if (chosen[candidate.facing] == null) chosen[candidate.facing] = candidate.slug;
  }
  return chosen;
}

/** The slugs the facts pass must hold on to even when everything else is released. */
export function originalKeepSlugs(candidates: OriginalCandidate[]): Set<string> {
  const chosen = chooseOriginals(candidates);
  const slugs = new Set<string>();
  for (const facing of ORIGINAL_FACINGS) {
    const slug = chosen[facing];
    if (slug != null) slugs.add(slug);
  }
  return slugs;
}

/** A kept original, with everything the download button needs. */
export type KeptOriginal = {
  facing: OriginalFacing;
  slug: string;
  blob: Blob;
  /** What the saved file is called. */
  fileName: string;
  /** The name the camera gave it, when it gave one. */
  sourceName: string | null;
  bytes: number;
  /** The type the platform declared. Empty when it declared none. */
  mime: string;
};

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
};

/**
 * Strips anything a file system would object to, without renaming the file.
 *
 * Separators and dot-dot runs go first: a platform-supplied name is untrusted
 * input, and one that walks out of the downloads folder is not a naming
 * curiosity, it is a path traversal.
 */
function safeName(name: string): string {
  return name
    .replace(/[\\/]/g, "-")
    .replace(/\.{2,}/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
}

/**
 * Names the download.
 *
 * The camera's own file name is carried through when there is one — it is a fact
 * about the device (`IMG_` versus `PXL_` versus a plain timestamp), and losing it
 * to a tidier name would throw away evidence for no gain.
 */
export function originalFileName(facing: OriginalFacing, sourceName: string | null, mime: string, at: Date): string {
  const base = `deep-probe-${FACING_SLUG[facing]}-camera-original`;
  const trimmed = sourceName?.trim() ?? "";
  if (trimmed.length > 0 && /\.[A-Za-z0-9]{2,5}$/.test(trimmed)) return `${base}-${safeName(trimmed)}`;
  const ext = MIME_EXT[mime.split(";")[0].trim().toLowerCase()] ?? "bin";
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${base}-${stamp}.${ext}`;
}

/**
 * Builds the download list from whatever the facts pass held back.
 *
 * Ordered back camera first, because that is the one with the interesting
 * metadata on nearly every phone — the front sensor is usually the plainer file.
 */
export function collectOriginals(kept: ProbeCapture[], candidates: OriginalCandidate[], at: Date = new Date()): KeptOriginal[] {
  const chosen = chooseOriginals(candidates);
  const bySlug = new Map(kept.map((capture) => [capture.slug, capture]));
  const originals: KeptOriginal[] = [];
  for (const facing of ORIGINAL_FACINGS) {
    const slug = chosen[facing];
    if (slug == null) continue;
    const capture = bySlug.get(slug);
    if (!capture) continue;
    const mime = capture.blob.type;
    originals.push({
      facing,
      slug,
      blob: capture.blob,
      fileName: originalFileName(facing, capture.fileName, mime, at),
      sourceName: capture.fileName,
      bytes: capture.blob.size,
      mime,
    });
  }
  return originals;
}

/**
 * Why a facing has no original, said plainly.
 *
 * There is no way to tell a skip from a failure at this point — both leave the
 * same absence — so this says what is true of either rather than guessing
 * between them.
 */
export function missingOriginalReason(facing: OriginalFacing): string {
  return `${FACING_LABEL[facing]}: no camera-app file arrived, so there is no original to offer. That shot was either skipped or did not come back. Nothing has been substituted for it — a sweep frame is a canvas encode and a library pick is not a photo taken just now, and calling either one a camera original would be a lie.`;
}

/** What the run log and the archive say about the two files that were held back. */
export function originalsPolicyText(originals: KeptOriginal[], released: boolean): string {
  if (originals.length === 0) {
    return "No camera-app original was kept, because no camera-app file arrived. Every capture in this run is either a frame this app encoded, a platform still or a library pick — none of which is a photo the camera wrote, and none of which is offered as one.";
  }
  const list = originals.map((o) => `${FACING_LABEL[o.facing]} (${o.fileName}, ${o.bytes.toLocaleString("en-US")} bytes${o.mime ? `, ${o.mime}` : ""})`).join(" and ");
  return [
    `Kept back from the release: ${list}.`,
    released
      ? "Every other photo's bytes were dropped the moment its facts were read, which is what keeps this run inside the browser's memory. These are the exception because they are the only files in the run the CAMERA wrote — its own quantisation tables, its own maker note, its own colour profile, its own EXIF."
      : "The archive was requested, so nothing was released — these two are singled out only because they are the files worth having on their own, without unzipping anything.",
    "They are saved exactly as the operating system handed them over: not re-encoded, not re-compressed, not stripped, not stamped, not wrapped in a container. The checksums in the sheets describe these bytes precisely.",
  ].join(" ");
}
