import { describe, expect, it } from "vitest";

import {
  CAPACITOR_PASS_POLICY,
  claimedExifText,
  MAX_DATA_POLICY,
  MULTI_PICK_LIMIT,
  MULTI_PICK_PURPOSE,
  oppositeOf,
  PHOTO_FORM_LABEL,
  readCameraRequestFinding,
  readFacingFromExif,
  readForm,
  type FacingReading,
} from "./capacitor-pass";

const BACK: FacingReading = { side: "environment", evidence: 'LensModel = "iPhone 15 Pro back triple camera 6.765mm f/1.78"' };
const FRONT: FacingReading = { side: "user", evidence: 'LensModel = "iPhone 15 Pro front TrueDepth camera 2.69mm f/1.9"' };
const UNKNOWN: FacingReading = { side: "unknown", evidence: "This file carries no EXIF at all, so it does not say which camera took it." };

describe("reading which camera fired, from the file rather than the request", () => {
  it("says nothing at all when there is no metadata to read", () => {
    const reading = readFacingFromExif(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]));
    expect(reading.side).toBe("unknown");
    expect(reading.evidence).toMatch(/no EXIF|could not be parsed/);
  });

  it("never returns a side it did not read", () => {
    const reading = readFacingFromExif(new Uint8Array(0));
    expect(reading.side).toBe("unknown");
  });
});

describe("choosing what the second shot asks for", () => {
  it("asks for the opposite of whatever the first turned out to be", () => {
    expect(oppositeOf(BACK)).toBe("user");
    expect(oppositeOf(FRONT)).toBe("environment");
  });

  it("asks for the front when the first file named no side, because that is the ask that reveals an ignored request", () => {
    expect(oppositeOf(UNKNOWN)).toBe("user");
  });
});

describe("does this phone honour a camera request?", () => {
  it("says yes when the named side is the side that came back", () => {
    const finding = readCameraRequestFinding(BACK, "user", FRONT);
    expect(finding.honoured).toBe("yes");
    expect(finding.verdict).toContain("the request is honoured here");
    expect(finding.verdict).toContain("opened the back camera on its own");
  });

  it("calls an accepted-and-ignored request what it is", () => {
    const finding = readCameraRequestFinding(BACK, "user", BACK);
    expect(finding.honoured).toBe("no");
    expect(finding.verdict).toContain("DECORATION");
    expect(finding.verdict).toContain("accepted and ignored");
    expect(finding.verdict).toContain("Nothing failed and no error was raised");
  });

  it("refuses to answer at all when either file stays silent", () => {
    const finding = readCameraRequestFinding(UNKNOWN, "user", FRONT);
    expect(finding.honoured).toBe("cannot-tell");
    expect(finding.verdict).toContain("cannot be answered from these two files");
    expect(finding.verdict).toContain("an inference dressed up as a measurement");
  });

  it("never concludes from the request itself, only from what the camera wrote", () => {
    const finding = readCameraRequestFinding(BACK, "environment", UNKNOWN);
    expect(finding.honoured).toBe("cannot-tell");
    expect(finding.verdict).toContain("nothing is concluded from them");
  });
});

describe("the same photo, three ways", () => {
  const original = { bytes: 3_100_000, mime: "image/jpeg", hasExif: true };

  it("says a form is identical when it really is", () => {
    const reading = readForm("uri", { bytes: 3_100_000, mime: "image/jpeg", hasExif: true }, original);
    expect(reading.identical).toBe(true);
    expect(reading.reading).toContain("byte-for-byte the same size and type");
  });

  it("names the inflation a text-encoded form adds", () => {
    const reading = readForm("base64", { bytes: 4_133_333, mime: "image/jpeg", hasExif: true }, original);
    expect(reading.identical).toBe(false);
    expect(reading.reading).toContain("LARGER than the original");
  });

  it("says outright when the camera's metadata did not survive", () => {
    const reading = readForm("data-url", { bytes: 2_400_000, mime: "image/png", hasExif: false }, original);
    expect(reading.keptExif).toBe(false);
    expect(reading.reading).toContain("did NOT survive this form");
  });

  it("does not blame a form for metadata the original never had", () => {
    const reading = readForm("data-url", { bytes: 900, mime: "image/png", hasExif: false }, { bytes: 900, mime: "image/png", hasExif: false });
    expect(reading.keptExif).toBeNull();
    expect(reading.reading).toContain("carried no EXIF, so there was none for this form to lose");
  });

  it("states an absent comparison rather than estimating around it", () => {
    const reading = readForm("base64", { bytes: 4_000_000, mime: "image/jpeg", hasExif: true }, null);
    expect(reading.identical).toBeNull();
    expect(reading.reading).toContain("no untouched original to compare this against");
    expect(reading.reading).toContain("An absent comparison is stated, never estimated");
  });
});

describe("what Capacitor claimed about a file", () => {
  it("says it claimed nothing rather than showing an empty box", () => {
    expect(claimedExifText(null)).toContain("claimed nothing about this file's metadata");
  });

  it("treats an empty object as a claim, because it is one", () => {
    expect(claimedExifText({})).toContain("returned an EMPTY metadata object");
    expect(claimedExifText({})).toContain("not the same as claiming nothing at all");
  });

  it("never treats the claim as authoritative over the bytes", () => {
    expect(claimedExifText({ Make: "Apple" })).toContain("does not treat it as authoritative");
  });
});

describe("the words the pass uses about itself", () => {
  it("holds the library-pick line without exception", () => {
    expect(CAPACITOR_PASS_POLICY).toContain("filed as a LIBRARY PICK and never as a photo taken just");
    expect(MULTI_PICK_PURPOSE).toContain("never as a photo taken just now");
  });

  it("explains why the first shot names no camera and the second names the opposite", () => {
    expect(CAPACITOR_PASS_POLICY).toContain("names NO camera at all");
    expect(CAPACITOR_PASS_POLICY).toContain("read from the photo's own EXIF, never from the request");
    expect(CAPACITOR_PASS_POLICY).toContain("circular");
  });

  it("asks for more than one photo, and says why more than one is worth asking for", () => {
    expect(MULTI_PICK_LIMIT).toBeGreaterThan(1);
    expect(CAPACITOR_PASS_POLICY).toContain(`UP TO ${MULTI_PICK_LIMIT} PHOTOS FROM ONE PICKER TRIP`);
    expect(CAPACITOR_PASS_POLICY).toContain("one photo shows a");
  });

  it("names all three shapes a photo can come back in", () => {
    expect(Object.keys(PHOTO_FORM_LABEL)).toEqual(["uri", "base64", "data-url"]);
    expect(PHOTO_FORM_LABEL.base64).toContain("Base64");
  });

  it("states every fidelity setting and admits where a setting does nothing here", () => {
    expect(MAX_DATA_POLICY).toContain("quality 100");
    expect(MAX_DATA_POLICY).toContain("allowEditing false");
    expect(MAX_DATA_POLICY).toContain("correctOrientation false");
    expect(MAX_DATA_POLICY).toContain("saveToGallery false");
    expect(MAX_DATA_POLICY).toContain('"asked for, no effect here"');
  });

  it("promises to label a rebuilt copy as a rebuilt copy", () => {
    expect(MAX_DATA_POLICY.replace(/\s+/g, " ")).toContain("labels the rebuilt copy as a rebuilt copy");
    expect(MAX_DATA_POLICY).toContain("would be a lie about provenance");
  });
});
