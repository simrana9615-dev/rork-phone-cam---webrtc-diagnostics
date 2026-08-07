/**
 * Tests for the two files that survive a released run.
 *
 * The selection rule carries the weight here. A library pick has metadata every
 * bit as rich as a camera original — that is precisely why it is useful — and
 * offering one under a button that says "camera original" would be the exact
 * lie this whole module is built to avoid. So the tests care less about which
 * file is chosen than about which files can never be chosen.
 */

import { describe, expect, it } from "vitest";

import type { ProbeCapture } from "./camera-matrix";
import {
  chooseOriginals,
  collectOriginals,
  FACING_LABEL,
  isCameraOriginal,
  missingOriginalReason,
  ORIGINAL_FACINGS,
  originalFileName,
  originalKeepSlugs,
  originalsPolicyText,
  type OriginalCandidate,
} from "./originals";

function candidate(overrides: Partial<OriginalCandidate> = {}): OriginalCandidate {
  return { slug: "manual-03-native-camera-environment", facing: "environment", path: "camera-file", origin: "camera-file", ...overrides };
}

function capture(slug: string, overrides: Partial<ProbeCapture> = {}): ProbeCapture {
  return {
    slug,
    label: "Back camera via the direct capture attribute",
    blob: new Blob([new Uint8Array(2048)], { type: "image/jpeg" }),
    origin: "camera-file",
    stage: "manual",
    deviceLabel: null,
    path: "camera-file",
    width: 4032,
    height: 3024,
    fileName: "IMG_0042.JPG",
    fileLastModified: 1_700_000_000_000,
    fileRelativePath: "",
    asked: "native-camera, facing environment",
    granted: "file IMG_0042.JPG",
    takenAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

describe("what can be an original", () => {
  it("accepts only a file the camera app produced", () => {
    expect(isCameraOriginal({ path: "camera-file", origin: "camera-file" })).toBe(true);
  });

  it("refuses a library pick, however rich its metadata", () => {
    expect(isCameraOriginal({ path: "picker-file", origin: "supplied-file" })).toBe(false);
  });

  it("refuses a frame this app encoded and a still the platform made", () => {
    expect(isCameraOriginal({ path: "canvas", origin: "app-encoded-frame" })).toBe(false);
    expect(isCameraOriginal({ path: "image-capture", origin: "platform-photo" })).toBe(false);
  });

  it("refuses a capture whose two declarations disagree, rather than trusting either", () => {
    expect(isCameraOriginal({ path: "camera-file", origin: "supplied-file" })).toBe(false);
    expect(isCameraOriginal({ path: "picker-file", origin: "camera-file" })).toBe(false);
  });
});

describe("choosing one per facing", () => {
  it("takes the first camera file on each side and ignores the rest", () => {
    const chosen = chooseOriginals([
      candidate({ slug: "a", facing: "environment" }),
      candidate({ slug: "b", facing: "user" }),
      candidate({ slug: "c", facing: "environment" }),
      candidate({ slug: "d", facing: "user" }),
    ]);
    expect(chosen).toEqual({ environment: "a", user: "b" });
  });

  it("promotes the next engine when the first shot was skipped", () => {
    const chosen = chooseOriginals([candidate({ slug: "capacitor-env", facing: "environment" })]);
    expect(chosen.environment).toBe("capacitor-env");
    expect(chosen.user).toBeNull();
  });

  it("never lets a library pick fill an empty side", () => {
    const chosen = chooseOriginals([
      candidate({ slug: "pick-1", facing: "user", path: "picker-file", origin: "supplied-file" }),
      candidate({ slug: "pick-2", facing: "environment", path: "picker-file", origin: "supplied-file" }),
    ]);
    expect(chosen).toEqual({ environment: null, user: null });
  });

  it("holds back at most two slugs, whatever the run produced", () => {
    const many = ORIGINAL_FACINGS.flatMap((facing) => [1, 2, 3].map((n) => candidate({ slug: `${facing}-${n}`, facing })));
    expect(originalKeepSlugs(many).size).toBe(2);
    expect(originalKeepSlugs([]).size).toBe(0);
  });
});

describe("what is offered for download", () => {
  it("puts the back camera first, because that is the file with the interesting metadata", () => {
    const kept = [capture("front", { fileName: "IMG_0043.JPG" }), capture("back")];
    const originals = collectOriginals(kept, [candidate({ slug: "back", facing: "environment" }), candidate({ slug: "front", facing: "user" })]);
    expect(originals.map((o) => o.facing)).toEqual(["environment", "user"]);
  });

  it("offers nothing for a side whose capture was released or never taken", () => {
    const originals = collectOriginals([capture("back")], [candidate({ slug: "back" }), candidate({ slug: "front", facing: "user" })]);
    expect(originals).toHaveLength(1);
    expect(originals[0].facing).toBe("environment");
  });

  it("carries the camera's own file name through, because the naming is itself a device trait", () => {
    const originals = collectOriginals([capture("back")], [candidate({ slug: "back" })]);
    expect(originals[0].fileName).toBe("deep-probe-back-camera-original-IMG_0042.JPG");
    expect(originals[0].sourceName).toBe("IMG_0042.JPG");
  });

  it("reports the real type and size rather than assuming JPEG", () => {
    const heic = capture("back", { fileName: "IMG_0044.HEIC", blob: new Blob([new Uint8Array(64)], { type: "image/heic" }) });
    const originals = collectOriginals([heic], [candidate({ slug: "back" })]);
    expect(originals[0].mime).toBe("image/heic");
    expect(originals[0].bytes).toBe(64);
    expect(originals[0].fileName).toMatch(/\.HEIC$/);
  });
});

describe("naming the saved file", () => {
  const at = new Date("2026-08-07T10:11:12.345Z");

  it("falls back to a timestamp and the declared type when the platform supplied no name", () => {
    expect(originalFileName("user", null, "image/jpeg", at)).toBe("deep-probe-front-camera-original-2026-08-07T10-11-12.jpg");
  });

  it("does not treat a name without an extension as a file name", () => {
    expect(originalFileName("environment", "photo", "image/heic", at)).toMatch(/^deep-probe-back-camera-original-2026.*\.heic$/);
  });

  it("strips path separators rather than letting a name climb out of the folder", () => {
    expect(originalFileName("environment", "../../etc/passwd.jpg", "image/jpeg", at)).not.toMatch(/\.\.|\//);
  });

  it("says bin when the platform declared no type at all, instead of guessing jpg", () => {
    expect(originalFileName("user", null, "", at)).toMatch(/\.bin$/);
  });
});

describe("what the record says", () => {
  it("names both files and states they were not re-encoded", () => {
    const originals = collectOriginals(
      [capture("back"), capture("front", { fileName: "IMG_0043.JPG" })],
      [candidate({ slug: "back" }), candidate({ slug: "front", facing: "user" })]
    );
    const text = originalsPolicyText(originals, true);
    expect(text).toContain("IMG_0042.JPG");
    expect(text).toContain("IMG_0043.JPG");
    expect(text).toMatch(/not re-encoded, not re-compressed, not stripped, not stamped/);
  });

  it("explains the exception differently when nothing was released", () => {
    const originals = collectOriginals([capture("back")], [candidate({ slug: "back" })]);
    expect(originalsPolicyText(originals, false)).toMatch(/nothing was released/);
    expect(originalsPolicyText(originals, true)).toMatch(/dropped the moment its facts were read/);
  });

  it("states plainly that no camera file arrived, rather than reporting nothing", () => {
    expect(originalsPolicyText([], true)).toMatch(/No camera-app original was kept/);
  });

  it("refuses to guess whether a missing shot was skipped or failed", () => {
    for (const facing of ORIGINAL_FACINGS) {
      const reason = missingOriginalReason(facing);
      expect(reason).toContain(FACING_LABEL[facing]);
      expect(reason).toMatch(/either skipped or did not come back/);
      expect(reason).toMatch(/Nothing has been substituted/);
    }
  });
});
