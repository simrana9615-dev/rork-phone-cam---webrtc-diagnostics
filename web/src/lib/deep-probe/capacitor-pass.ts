/**
 * The Capacitor pass — several photos, and every byte of them.
 *
 * Capacitor's camera was one of three routes into the phone's camera app, and
 * it was the THIRD one tried. The first route works on every device seen so
 * far, so in practice this one never ran at all. That is a waste of the one
 * route in the run that can do things the other two cannot:
 *
 *   • It can hand back SEVERAL photos from a single trip to the picker. Every
 *     other path in this app returns exactly one file per trip.
 *   • It can hand back the SAME photo in three different forms — a link, a
 *     text-encoded string and a data URL — which is the only way to see what
 *     each form adds, loses, re-labels or inflates on this device.
 *   • It has an opinion about your permissions that is separate from the
 *     browser's, and the two can disagree.
 *   • It can be asked to open a camera WITHOUT naming which one, which is how
 *     this run finally measures whether a page's camera request is honoured at
 *     all or is simply decoration.
 *
 * Two disciplines carried in from the rest of the module, and neither bends:
 *
 *   • A library pick is never offered as a photo taken just now. The multi-pick
 *     brings back rich metadata precisely because those files came from a real
 *     camera at some point — but "at some point" is not "now", and the two
 *     camera shots remain the only files in the run offered as originals.
 *
 *   • Unavailable is not denied. Most of Capacitor's abilities do not exist in
 *     a phone browser; each one is recorded as absent, which is a different
 *     word from refused and is never written as refused.
 */

import { Camera, CameraDirection, CameraResultType, CameraSource } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";

import { CaptureCancelledError } from "../capture-engine";
import { readExifIfds } from "./exif-ifd";

/* ------------------------------------------------------------------ *
 * What Capacitor says about itself
 * ------------------------------------------------------------------ */

/** One thing Capacitor can do, and whether it can do it here. */
export type CapacitorAbility = {
  name: string;
  /** True only when the method exists on the plugin object in this environment. */
  present: boolean;
  /** What it would do, and what it does here instead. */
  note: string;
};

/** Capacitor's own answer about a permission, and the browser's, side by side. */
export type PermissionPair = {
  what: "camera" | "photos";
  /** Capacitor's word for it, verbatim. Null when the call threw or is unimplemented. */
  capacitor: string | null;
  /** The Permissions API's word for it. Null when this browser has no entry for it. */
  browser: string | null;
  /** Set when the two do not agree — the disagreement is the finding. */
  disagreement: string | null;
};

export type CapacitorSelfReport = {
  /** What Capacitor believes it is running on. */
  platform: string;
  isNativePlatform: boolean;
  /** True when the plugin object exists at all. */
  pluginPresent: boolean;
  abilities: CapacitorAbility[];
  permissions: PermissionPair[];
  /** Recorded rather than swallowed — a thrown permission check is itself a reading. */
  errors: string[];
  notes: string[];
};

/**
 * Every ability the plugin declares, checked for existence rather than assumed.
 *
 * Presence is tested on the object because the web implementation of this
 * plugin throws "not implemented" only when called, and calling five methods to
 * find out would open five pickers.
 */
const ABILITY_NOTES: { name: string; note: string }[] = [
  { name: "getPhoto", note: "Opens the camera or the picker and returns one photo. This is the only one this run actually uses for a camera shot." },
  { name: "pickImages", note: "Opens the picker once and returns SEVERAL photos. Nothing else in this run can do that." },
  { name: "checkPermissions", note: "Capacitor's own view of the camera and photos permissions, which is not always the browser's." },
  { name: "requestPermissions", note: "Asks for them. Not used here — this run does not re-prompt for something the permission stage already asked." },
  { name: "pickLimitedLibraryPhotos", note: "iOS limited-library management. A native-only screen; in a browser there is no limited library to manage." },
  { name: "takePhoto", note: "The newer camera entry point. Native only in this plugin version." },
  { name: "recordVideo", note: "Video capture. Native only — this run takes no video." },
  { name: "chooseFromGallery", note: "The newer multi-pick entry point. Native only in this plugin version." },
  { name: "editPhoto", note: "An in-app editing screen. Never used here: an edited file is not the file the camera wrote." },
];

function permissionPair(what: "camera" | "photos", capacitor: string | null, browser: string | null): PermissionPair {
  let disagreement: string | null = null;
  if (capacitor != null && browser != null && capacitor !== browser) {
    disagreement =
      `Capacitor says "${capacitor}" and the browser's own Permissions API says "${browser}" about the same thing. ` +
      `Both are recorded and neither is treated as the correct one: the disagreement IS the finding. A plugin that reports a permission the browser has not granted, ` +
      `or the reverse, tells you the two are reading different state — which matters to anything relying on either.`;
  }
  return { what, capacitor, browser, disagreement };
}

/**
 * Reads everything Capacitor will say about itself, without opening anything.
 *
 * `browserStates` are the Permissions API answers the permission stage already
 * collected, passed in rather than re-queried so this costs nothing and cannot
 * disturb the state it is describing.
 */
export async function readCapacitorSelfReport(browserStates: { name: string; state: string | null }[]): Promise<CapacitorSelfReport> {
  const errors: string[] = [];
  const notes: string[] = [];
  const pluginPresent = typeof Camera === "object" && Camera != null;

  let platform = "unknown";
  let isNativePlatform = false;
  try {
    platform = Capacitor.getPlatform();
    isNativePlatform = Capacitor.isNativePlatform();
  } catch (err) {
    errors.push(`Capacitor.getPlatform() threw: ${describe(err)}`);
  }

  const holder = Camera as unknown as Record<string, unknown>;
  const abilities: CapacitorAbility[] = ABILITY_NOTES.map((ability) => ({
    name: ability.name,
    present: pluginPresent && typeof holder[ability.name] === "function",
    note: ability.note,
  }));

  let capacitorPermissions: { camera?: string; photos?: string } | null = null;
  try {
    capacitorPermissions = (await Camera.checkPermissions()) as unknown as { camera?: string; photos?: string };
  } catch (err) {
    errors.push(
      `Camera.checkPermissions() threw: ${describe(err)}. That is a reading in its own right, not a gap — on the web this plugin routinely reports its permission methods as unimplemented, which is UNAVAILABLE and is not the same word as denied.`
    );
  }

  const browserFor = (name: string): string | null => browserStates.find((entry) => entry.name === name)?.state ?? null;
  const permissions: PermissionPair[] = [
    permissionPair("camera", capacitorPermissions?.camera ?? null, browserFor("camera")),
    permissionPair("photos", capacitorPermissions?.photos ?? null, browserFor("photos") ?? browserFor("camera")),
  ];

  notes.push(
    isNativePlatform
      ? `Capacitor reports the platform as "${platform}" and believes it is running natively. Every ability below that is marked native-only should therefore work.`
      : `Capacitor reports the platform as "${platform}" and knows it is running as a website. Most of its abilities are native-only and simply do not exist here — each is marked absent, which is NOT the same as refused and is never written as refused.`
  );

  const absent = abilities.filter((ability) => !ability.present);
  if (absent.length > 0) {
    notes.push(
      `${absent.length} of Capacitor's ${abilities.length} declared abilities are not present in this environment: ${absent.map((a) => a.name).join(", ")}. ` +
        `Absent means the method is not on the object here. Nothing was asked of them and nothing is claimed about what they would have done.`
    );
  }

  return { platform, isNativePlatform, pluginPresent, abilities, permissions, errors, notes };
}

/* ------------------------------------------------------------------ *
 * Which camera actually fired
 * ------------------------------------------------------------------ */

/** What a photo's own metadata says about which side of the phone took it. */
export type FacingReading = {
  side: "environment" | "user" | "unknown";
  /** The tag and value it was read from, or why nothing could be read. */
  evidence: string;
};

const FRONT_WORDS = /\bfront\b|selfie|truedepth|facetime/i;
const BACK_WORDS = /\bback\b|\brear\b|\bwide\b|telephoto|ultra\s*wide|dual|triple/i;

/**
 * Reads the firing camera out of the file's own EXIF.
 *
 * Never guessed and never inferred from the request: the whole point of the
 * unnamed shot is that the request may have been ignored, so reading the answer
 * back from the request would make the measurement circular. Only what the
 * CAMERA wrote counts — the lens name and the maker's camera field.
 *
 * Front is tested before back because iPhone front lens strings contain the
 * word "front" while back strings contain lens words like "wide"; a string
 * naming both is decided by the explicit side word.
 */
export function readFacingFromExif(bytes: Uint8Array): FacingReading {
  let report: ReturnType<typeof readExifIfds>;
  try {
    report = readExifIfds(bytes);
  } catch (err) {
    return { side: "unknown", evidence: `The EXIF could not be parsed (${describe(err)}), so this file does not say which camera took it.` };
  }
  if (!report.found) {
    return {
      side: "unknown",
      evidence: "This file carries no EXIF at all, so it does not say which camera took it. That is common for a re-encoded or converted file and is a fact about the path, not about the camera.",
    };
  }

  const named: { tag: string; value: string }[] = [];
  for (const block of report.blocks) {
    for (const entry of block.entries) {
      if (entry.name !== "LensModel" && entry.name !== "Model" && entry.name !== "LensMake") continue;
      const value = entry.raw.replace(/^"|"$/g, "").trim();
      if (value.length > 0) named.push({ tag: entry.name, value });
    }
  }
  if (named.length === 0) {
    return {
      side: "unknown",
      evidence: "The EXIF is present but names no lens and no camera model, so it does not say which side of the phone fired. Stated rather than guessed.",
    };
  }

  for (const entry of named) {
    if (FRONT_WORDS.test(entry.value)) return { side: "user", evidence: `${entry.tag} = "${entry.value}" — the camera itself named the front lens.` };
  }
  for (const entry of named) {
    if (BACK_WORDS.test(entry.value)) return { side: "environment", evidence: `${entry.tag} = "${entry.value}" — the camera itself named a rear lens.` };
  }
  return {
    side: "unknown",
    evidence: `The camera wrote ${named.map((entry) => `${entry.tag} = "${entry.value}"`).join(", ")}, none of which names a side. Recorded as unknown rather than assigned to one.`,
  };
}

/** The two shots, read together: was the camera request honoured, or is it decoration? */
export type CameraRequestFinding = {
  /** What the phone chose when nothing was asked of it. */
  unnamedChose: FacingReading;
  /** What was asked for on the second shot, chosen from the first shot's answer. */
  thenAsked: "environment" | "user";
  /** What the second shot actually delivered. */
  thenGot: FacingReading;
  honoured: "yes" | "no" | "cannot-tell";
  verdict: string;
};

/**
 * The second shot asks for the OPPOSITE of whatever the first one turned out to
 * be, so the pair covers both sides of the phone AND tests the request at the
 * same time. When the first file names no side, the front is asked for: it is
 * the request most likely to reveal an ignored preference, because a phone that
 * ignores it opens the back.
 */
export function oppositeOf(reading: FacingReading): "environment" | "user" {
  if (reading.side === "user") return "environment";
  return "user";
}

/** Reads the pair, and says what it can and cannot conclude from them. */
export function readCameraRequestFinding(unnamedChose: FacingReading, thenAsked: "environment" | "user", thenGot: FacingReading): CameraRequestFinding {
  const sideWord = (side: "environment" | "user"): string => (side === "environment" ? "back" : "front");
  if (thenGot.side === "unknown" || unnamedChose.side === "unknown") {
    return {
      unnamedChose,
      thenAsked,
      thenGot,
      honoured: "cannot-tell",
      verdict:
        `This cannot be answered from these two files. ${unnamedChose.side === "unknown" ? `The unnamed shot does not say which camera took it — ${unnamedChose.evidence} ` : ""}` +
        `${thenGot.side === "unknown" ? `The shot that asked for the ${sideWord(thenAsked)} camera does not say either — ${thenGot.evidence} ` : ""}` +
        `Without the camera's own word on both, any answer here would be an inference dressed up as a measurement. The files are in the archive; nothing is concluded from them.`,
    };
  }
  if (thenGot.side === thenAsked) {
    return {
      unnamedChose,
      thenAsked,
      thenGot,
      honoured: "yes",
      verdict:
        `Asked for the ${sideWord(thenAsked)} camera and got the ${sideWord(thenAsked)} camera — ${thenGot.evidence} With nothing asked of it, this phone opened the ${sideWord(unnamedChose.side)} camera on its own (${unnamedChose.evidence}). ` +
        `So the request is honoured here: a page that names a camera gets that camera, and a page that names none gets this device's own default. Both halves of that are facts about this phone that nothing else in the run measures.`,
    };
  }
  return {
    unnamedChose,
    thenAsked,
    thenGot,
    honoured: "no",
    verdict:
      `Asked for the ${sideWord(thenAsked)} camera and got the ${sideWord(thenGot.side)} one instead — ${thenGot.evidence} The unnamed shot opened the ${sideWord(unnamedChose.side)} camera (${unnamedChose.evidence}). ` +
      `On this phone the camera request is DECORATION: the page states a preference and the device does what it was going to do anyway. Nothing failed and no error was raised — the request was accepted and ignored, which is exactly the case a site would never notice.`,
  };
}

/* ------------------------------------------------------------------ *
 * The alternate forms
 * ------------------------------------------------------------------ */

/** One of the three shapes Capacitor will hand a photo back in. */
export type PhotoForm = "uri" | "base64" | "data-url";

export const PHOTO_FORM_LABEL: Record<PhotoForm, string> = {
  uri: "a link (resultType: Uri)",
  base64: "text-encoded bytes (resultType: Base64)",
  "data-url": "a data URL (resultType: DataUrl)",
};

/** What one form actually delivered, measured against the untouched original. */
export type FormReading = {
  form: PhotoForm;
  /** Bytes as delivered by this form. */
  bytes: number;
  /** The MIME type the form declared, or empty when it declared none. */
  declaredMime: string;
  /** Bytes of the original file taken from Capacitor's own input before it could rewrite anything. */
  originalBytes: number | null;
  /** True when this form's bytes are identical to that original. */
  identical: boolean | null;
  /** True when EXIF survived this form. Null when the original had none to lose. */
  keptExif: boolean | null;
  /** How much bigger or smaller than the original, as a plain sentence. */
  reading: string;
};

/** Compares one delivered form with the untouched original, in words. */
export function readForm(form: PhotoForm, delivered: { bytes: number; mime: string; hasExif: boolean }, original: { bytes: number; mime: string; hasExif: boolean } | null): FormReading {
  if (!original) {
    return {
      form,
      bytes: delivered.bytes,
      declaredMime: delivered.mime,
      originalBytes: null,
      identical: null,
      keptExif: null,
      reading: `${delivered.bytes.toLocaleString("en-US")} bytes, declared ${delivered.mime || "(no type)"}. There is no untouched original to compare this against — the interception that captures one did not fire on this trip — so nothing is said about what this form added or lost. An absent comparison is stated, never estimated.`,
    };
  }
  const identical = delivered.bytes === original.bytes && delivered.mime === original.mime;
  const ratio = original.bytes > 0 ? delivered.bytes / original.bytes : 1;
  const sizeWord =
    identical
      ? "byte-for-byte the same size and type as the original"
      : ratio > 1.02
        ? `${Math.round((ratio - 1) * 100)}% LARGER than the original`
        : ratio < 0.98
          ? `${Math.round((1 - ratio) * 100)}% SMALLER than the original`
          : "the same size as the original to within 2%";
  const exifWord = !original.hasExif
    ? "The original carried no EXIF, so there was none for this form to lose."
    : delivered.hasExif
      ? "The camera's EXIF survived this form."
      : "The camera's EXIF did NOT survive this form — the metadata is gone.";
  return {
    form,
    bytes: delivered.bytes,
    declaredMime: delivered.mime,
    originalBytes: original.bytes,
    identical,
    keptExif: original.hasExif ? delivered.hasExif : null,
    reading: `${delivered.bytes.toLocaleString("en-US")} bytes, declared ${delivered.mime || "(no type)"} — ${sizeWord}. ${exifWord}`,
  };
}

/* ------------------------------------------------------------------ *
 * Doing the work
 * ------------------------------------------------------------------ */

/** Every setting chosen so the file arrives as close to the camera's own output as this path allows. */
export const MAX_DATA_OPTIONS = {
  quality: 100,
  allowEditing: false,
  correctOrientation: false,
  saveToGallery: false,
} as const;

export const MAX_DATA_POLICY = [
  "EVERY CAPACITOR REQUEST WAS MADE AT MAXIMUM FIDELITY",
  "-".repeat(78),
  "quality 100          — no re-compression beyond whatever the camera itself applied.",
  "allowEditing false   — no editing screen. An edited file is not the file the camera wrote.",
  "correctOrientation false — no automatic rotation. Rotating re-encodes the pixels AND rewrites the",
  "                       orientation tag, and that tag is one of the more revealing things in the file.",
  "saveToGallery false  — nothing from this run is written into your photo library.",
  "",
  "In a phone browser several of these have no effect at all: quality, orientation correction and gallery",
  "saving are implemented natively and there is nothing behind them on the web. They are still sent, and",
  "this is recorded as \"asked for, no effect here\" rather than implying they did something.",
  "",
  "The original File is taken from Capacitor's own hidden input at event time, BEFORE Capacitor has a",
  "chance to rewrite it. When that interception misses, the run says so and labels the rebuilt copy as a",
  "rebuilt copy — its bytes are Capacitor's blob of the original, but its name and timestamp are made up,",
  "and passing that off as the original would be a lie about provenance.",
].join("\n");

/** One photo out of the multi-pick. */
export type PickedPhoto = {
  index: number;
  blob: Blob;
  /** What Capacitor called it. Web picks carry no real name, which is stated rather than invented. */
  fileName: string | null;
  format: string | null;
  /** Capacitor's own claim about the file's metadata, verbatim. Null when it claimed nothing. */
  claimedExif: unknown;
};

/** How many photos one picker trip asks for. */
export const MULTI_PICK_LIMIT = 5;

export const MULTI_PICK_PURPOSE =
  `Pick up to ${MULTI_PICK_LIMIT} photos from your library in one go — and make them DIFFERENT from each other if you can: one from each camera, one with HDR, an older one, an edited one, a screenshot, something you were sent rather than took. ` +
  `Five rather than one because metadata varies photo to photo on the same phone, and one photo shows a point where five show the shape. This is the only request in the whole run that returns several files from a single trip. ` +
  `Every one of them is filed as a library pick and never as a photo taken just now — that line does not move for anything.`;

function describe(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message || "no message"}`;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** True when a rejection is the user closing the picker rather than anything going wrong. */
function isCancellation(err: unknown): boolean {
  return err instanceof CaptureCancelledError || (err instanceof Error && /cancell?ed|no image picked/i.test(err.message));
}

/**
 * Opens the picker once and brings back up to five photos.
 *
 * Throws `CaptureCancelledError` when the picker is closed with nothing chosen,
 * so the caller can record a decline as a decline rather than as a failure.
 */
export async function pickSeveralPhotos(limit: number = MULTI_PICK_LIMIT): Promise<PickedPhoto[]> {
  if (typeof (Camera as unknown as Record<string, unknown>).pickImages !== "function") {
    throw new Error("Camera.pickImages is not present in this environment, so no multi-pick was possible. That is an absence, not a refusal.");
  }
  let result: { photos: { webPath?: string; path?: string; format?: string; exif?: unknown }[] };
  try {
    result = await Camera.pickImages({ quality: MAX_DATA_OPTIONS.quality, limit, correctOrientation: MAX_DATA_OPTIONS.correctOrientation });
  } catch (err) {
    if (isCancellation(err)) throw new CaptureCancelledError();
    throw err instanceof Error ? err : new Error(String(err));
  }
  const photos: PickedPhoto[] = [];
  for (const [index, photo] of (result.photos ?? []).entries()) {
    const href = photo.webPath ?? photo.path ?? null;
    if (!href) continue;
    const blob = await fetch(href).then((response) => response.blob());
    photos.push({
      index,
      blob,
      fileName: null,
      format: photo.format ?? null,
      claimedExif: photo.exif ?? null,
    });
  }
  if (photos.length === 0) throw new CaptureCancelledError();
  return photos;
}

/** Asks for the same photo in one of the three forms Capacitor offers. */
export async function capturePhotoForm(form: PhotoForm, source: "camera" | "library"): Promise<{ blob: Blob; declaredMime: string; format: string | null; claimedExif: unknown }> {
  const resultType = form === "base64" ? CameraResultType.Base64 : form === "data-url" ? CameraResultType.DataUrl : CameraResultType.Uri;
  try {
    const photo = await Camera.getPhoto({
      ...MAX_DATA_OPTIONS,
      resultType,
      source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
      webUseInput: true,
    });
    if (form === "base64" && photo.base64String) {
      const bytes = base64ToBytes(photo.base64String);
      const mime = photo.format ? `image/${photo.format}` : "";
      return { blob: new Blob([bytes.buffer as ArrayBuffer], { type: mime }), declaredMime: mime, format: photo.format ?? null, claimedExif: photo.exif ?? null };
    }
    if (form === "data-url" && photo.dataUrl) {
      const comma = photo.dataUrl.indexOf(",");
      const header = photo.dataUrl.slice(0, comma);
      const mime = /data:([^;,]+)/.exec(header)?.[1] ?? "";
      const bytes = base64ToBytes(photo.dataUrl.slice(comma + 1));
      return { blob: new Blob([bytes.buffer as ArrayBuffer], { type: mime }), declaredMime: mime, format: photo.format ?? null, claimedExif: photo.exif ?? null };
    }
    const href = photo.webPath ?? photo.path;
    if (!href) throw new Error(`Capacitor returned nothing usable for ${PHOTO_FORM_LABEL[form]}.`);
    const blob = await fetch(href).then((response) => response.blob());
    return { blob, declaredMime: blob.type, format: photo.format ?? null, claimedExif: photo.exif ?? null };
  } catch (err) {
    if (isCancellation(err)) throw new CaptureCancelledError();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** What Capacitor claimed about a file's metadata, next to the fact that the bytes are read separately. */
export function claimedExifText(claimed: unknown): string {
  if (claimed == null) return "Capacitor claimed nothing about this file's metadata. Stated as nothing claimed rather than shown as an empty box — the bytes are read independently either way, and what they say is in the sheets.";
  if (typeof claimed === "object" && Object.keys(claimed as object).length === 0) {
    return "Capacitor returned an EMPTY metadata object for this file. That is a claim — that it found none — and it is not the same as claiming nothing at all. The bytes were read independently regardless.";
  }
  try {
    return `Capacitor's own claim about this file's metadata, verbatim: ${JSON.stringify(claimed)}. This run does not treat it as authoritative: the bytes are parsed separately and what the FILE says is in the sheets.`;
  } catch {
    return "Capacitor returned a metadata object that could not be serialised. Recorded as unreadable rather than dropped.";
  }
}

/** The paragraph the archive uses to explain what this whole pass is. */
export const CAPACITOR_PASS_POLICY = [
  "THE CAPACITOR PASS",
  "=".repeat(78),
  "",
  "Capacitor's camera plugin was the third of three routes into this phone's camera app, and the first",
  "route works on every device seen so far — so in practice it never ran. It is the only route in the run",
  "that can do three things nothing else here can, so it is used for those three things rather than kept",
  "as a spare nobody reaches.",
  "",
  "1. THE CAMERA REQUEST, MEASURED. The first camera shot names NO camera at all, so whatever opens is",
  "   this phone's own choice. The second asks for the OPPOSITE of whatever the first turned out to be —",
  "   read from the photo's own EXIF, never from the request, because reading the answer back out of the",
  "   request would make the measurement circular. Together they say whether a page's camera preference is",
  "   honoured on this device or is decoration. You still end up with one back photo and one front photo.",
  "",
  `2. UP TO ${MULTI_PICK_LIMIT} PHOTOS FROM ONE PICKER TRIP. Nothing else in this run returns more than one file per trip.`,
  "   Metadata varies photo to photo on the same phone — a different lens, HDR on or off, an older software",
  "   version, an edited copy, a screenshot, something downloaded rather than shot — so one photo shows a",
  "   point and five show the shape. Every one is filed as a LIBRARY PICK and never as a photo taken just",
  "   now. The two camera shots remain the only files offered as camera originals.",
  "",
  "3. THE SAME PHOTO, THREE WAYS. Capacitor will hand one photo back as a link, as text-encoded bytes and",
  "   as a data URL. All three are asked for and each is compared against the untouched original taken",
  "   before Capacitor could rewrite anything, so the archive states exactly what each form adds, loses,",
  "   re-labels or inflates — including whether the camera's metadata survives the trip.",
  "",
  "COST: no extra trips to the camera unless this phone ignores the camera request. Three extra picker",
  "taps. Everything the shortened run gave up, it gave up because it repeated an answer already in hand;",
  "every file added here is one nothing else in the run can produce.",
].join("\n");
