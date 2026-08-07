import { describe, expect, it } from "vitest";

import type { CaptureFacts } from "./capture-facts";
import { buildSheets, type RunFacts } from "./sheets";
import type { CameraMatrixReport } from "./camera-matrix";
import type { PermissionRecord } from "./permissions";

function permission(overrides: Partial<PermissionRecord> = {}): PermissionRecord {
  return {
    id: "camera",
    tier: "standard",
    label: "Camera",
    api: "navigator.mediaDevices.getUserMedia({ video: true })",
    reaches: "every camera on this device",
    duration: "until you close the tab",
    outcome: "granted",
    detail: "A video track opened.",
    askedAt: "2026-08-07T10:00:00.000Z",
    responseMs: 820,
    stateBefore: "prompt",
    stateAfter: "granted",
    data: null,
    ...overrides,
  } as PermissionRecord;
}

function matrix(overrides: Partial<CameraMatrixReport> = {}): CameraMatrixReport {
  return {
    startedAt: "2026-08-07T10:00:00.000Z",
    finishedAt: "2026-08-07T10:04:00.000Z",
    durationMs: 240_000,
    inventory: [{ deviceId: "cam-a", groupId: "g", label: "Back Triple Camera", kind: "videoinput" } as never],
    rows: [
      {
        deviceId: "cam-a",
        deviceLabel: "Back Triple Camera",
        group: "g",
        kind: "resolution",
        asked: "3840×2160",
        askedConstraints: { width: { ideal: 3840 }, height: { ideal: 2160 } },
        ok: true,
        granted: "1920×1080",
        grantedSettings: { width: 1920, height: 1080 },
        error: null,
        durationMs: 410,
        captureSlugs: ["sweep-01"],
      },
      {
        deviceId: "cam-a",
        deviceLabel: "Back Triple Camera",
        group: "g",
        kind: "frame-rate",
        asked: "240 fps",
        askedConstraints: { frameRate: { exact: 240 } },
        ok: false,
        granted: null,
        grantedSettings: null,
        error: "OverconstrainedError",
        durationMs: 120,
        captureSlugs: [],
      },
    ],
    stillPolicy: "one still per granted row",
    notes: [],
    aborted: false,
    stillsStoppedForMemory: null,
    memory: { heldBytes: 12_000_000, ceilingBytes: 320 * 1024 * 1024, peakCanvasBytes: 33_177_600 },
    surface: [],
    devicesBefore: [],
    devicesAfter: [],
    ...overrides,
  };
}

function facts(overrides: Partial<CaptureFacts> = {}): CaptureFacts {
  return {
    slug: "sweep-01",
    label: "Back camera at 1920×1080",
    archivePath: "captures/sweep-01.jpg",
    origin: "platform-photo",
    path: "image-capture",
    stage: "camera-sweep",
    deviceLabel: "Back Triple Camera",
    takenAt: "2026-08-07T10:01:00.000Z",
    asked: "3840×2160",
    granted: "1920×1080",
    fileName: null,
    fileLastModified: null,
    fileRelativePath: null,
    bytes: 2_400_000,
    mime: "image/jpeg",
    width: 1920,
    height: 1080,
    hashes: { bytes: 2_400_000, md5: "a".repeat(32), sha1: "b".repeat(40), sha256: "c".repeat(64), crc32: "0xdeadbeef" },
    encoder: {
      isJpeg: true,
      quantTables: [
        { id: 0, precisionBits: 8, zigzag: [], natural: [], sum: 1024, isAnnexKBase: false, libjpegQualityEstimate: null, offset: 20 },
      ],
      huffmanTables: [],
      appSegments: [{ marker: "APP1", declaredLength: 40, signature: "Exif", offset: 2 }],
    } as never,
    ifd: {
      found: true,
      tiffOffset: 12,
      byteOrder: "II (little-endian)",
      magic: 42,
      blocks: [{ name: "IFD0", offset: 8, entryCount: 2, entries: [], nextOffset: 0 }],
      ifdOrder: ["IFD0"],
      hasIfd1: false,
      makerNote: null,
      colorSpace: 1,
      interopIndex: null,
      gps: [],
      warnings: [],
    } as never,
    structure: { container: "JPEG", nodes: [{ id: "SOI", depth: 0 } as never], segments: [{ name: "exif", offset: 4, length: 30 } as never] } as never,
    tags: { text: "TAG DUMP", count: 49, unknown: 6, metadataCount: 48, keys: ["Make", "Model"], stableTags: { Make: "Apple" } },
    iccMd5: "d".repeat(32),
    spec: {
      slug: "sweep-01",
      origin: "platform-photo",
      path: "image-capture",
      deviceLabel: "Back Triple Camera",
      width: 1920,
      height: 1080,
      bytes: 2_400_000,
      mime: "image/jpeg",
      container: "JPEG",
      markers: ["SOI"],
      segments: ["exif"],
      tagCount: 48,
      unknownTagCount: 6,
      tagKeys: ["Make", "Model"],
      stableTags: { Make: "Apple" },
    } as never,
    brief: {
      slug: "sweep-01",
      archivePath: "captures/sweep-01.jpg",
      label: "Back camera at 1920×1080",
      path: "image-capture",
      origin: "platform-photo",
      deviceLabel: "Back Triple Camera",
      fileName: null,
      fileLastModified: null,
      fileRelativePath: null,
      bytes: 2_400_000,
      mime: "image/jpeg",
      width: 1920,
      height: 1080,
      encoder: null,
      ifd: null,
      iccMd5: "d".repeat(32),
    } as never,
    warnings: [],
    ...overrides,
  };
}

function run(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    startedAt: "2026-08-07T10:00:00.000Z",
    finishedAt: "2026-08-07T10:06:00.000Z",
    tier: "extended",
    permissions: [permission(), permission({ id: "nfc", label: "NFC", outcome: "unavailable", responseMs: 0 })],
    passive: [{ title: "Screen", rows: [{ label: "Resolution", value: "1290×2796" }] } as never],
    permissionStatesBefore: [{ name: "camera", state: "prompt" }],
    permissionStatesAfter: [{ name: "camera", state: "granted" }],
    sensors: [
      {
        id: "motion",
        label: "Motion",
        columns: ["t_ms", "ax", "ay", "az"],
        rows: [
          ["0", "0.011", "9.802", "0.004"],
          ["24", "0.013", "9.799", "0.006"],
        ],
        durationMs: 5000,
        requestedHz: 60,
        measuredHz: 41,
        note: "Throttled by the browser.",
      },
    ],
    matrix: matrix(),
    logs: [],
    omissions: [],
    devicesBeforePermission: [],
    ...overrides,
  };
}

describe("buildSheets", () => {
  it("puts the forensic item list first, where it was asked to be", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.sections[0].id).toBe("forensic");
    expect(set.forensicChecklist.length).toBeGreaterThan(200);
  });

  it("renders the same registry into text, HTML and the on-screen sections", () => {
    const set = buildSheets(run(), [facts()]);
    for (const section of set.sections) {
      expect(set.statSheetText).toContain(section.title.toUpperCase());
      expect(set.statSheetHtml).toContain(section.title);
    }
  });

  it("never merges a refusal with an API that does not exist here", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.statSheetText).toContain("Not in this browser");
    expect(set.statSheetText).toContain("Denied");
  });

  it("names the camera rows where the hardware substituted a different size", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.statSheetText).toContain("substituted a different size without refusing");
  });

  it("says so plainly when nothing was substituted", () => {
    const clean = matrix({
      rows: [
        {
          deviceId: "cam-a",
          deviceLabel: "Back",
          group: "g",
          kind: "resolution",
          asked: "1920×1080",
          askedConstraints: { width: { ideal: 1920 } },
          ok: true,
          granted: "1920×1080",
          grantedSettings: { width: 1920, height: 1080 },
          error: null,
          durationMs: 200,
          captureSlugs: [],
        },
      ],
    });
    const set = buildSheets(run({ matrix: clean }), [facts()]);
    expect(set.statSheetText).toContain("No granted request came back with a different size");
  });

  it("reports the measured rate next to the requested one", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.statSheetText).toContain("41 Hz");
    expect(set.statSheetText).toContain("60 Hz");
  });

  it("carries every checksum of every photo", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.statSheetText).toContain("a".repeat(32));
    expect(set.statSheetText).toContain("c".repeat(64));
    expect(set.statSheetText).toContain("0xdeadbeef");
  });

  it("withholds a libjpeg quality it cannot honestly state", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.statSheetText).toContain("quality withheld");
  });

  it("states the colour profile checksum rather than only that one exists", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.statSheetText).toContain("d".repeat(32));
  });

  it("keeps the two capture paths apart instead of describing one as the other", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.statSheetText).toContain("carries no camera metadata at all");
    expect(set.statSheetText).toContain("picked from the photo library");
  });

  it("labels a run with omissions partial and names each one", () => {
    const set = buildSheets(run({ omissions: [{ stage: "Sensor recordings", reason: "Nothing that produces a series was granted." }] }), [facts()]);
    expect(set.partial).toBe(true);
    expect(set.statSheetText).toContain("PARTIAL RUN");
    expect(set.statSheetText).toContain("Nothing that produces a series was granted.");
    expect(set.fileNames.statText).toContain("-PARTIAL");
  });

  it("says every stage ran when none was omitted", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.partial).toBe(false);
    expect(set.statSheetText).toContain("Every stage ran to completion.");
    expect(set.fileNames.statText).not.toContain("PARTIAL");
  });

  it("reaches no verdict, awards no score and says so", () => {
    const set = buildSheets(run(), [facts()]);
    expect(set.statSheetText).toContain("reaches no verdict");
    expect(set.statSheetText).not.toMatch(/\bVERDICT:/i);
    expect(set.statSheetText).not.toMatch(/\bscore\s*[:=]\s*\d/i);
  });

  it("distinguishes no photos taken from photos that failed", () => {
    const set = buildSheets(run(), []);
    expect(set.statSheetText).toContain("the omissions list distinguishes the two");
  });

  it("escapes markup rather than letting a device label inject it", () => {
    const set = buildSheets(run(), [facts({ label: '<img src=x onerror="alert(1)">' })]);
    expect(set.statSheetHtml).not.toContain("<img src=x");
    expect(set.statSheetHtml).toContain("&lt;img src=x");
  });

  it("produces a spec that is far smaller than the sheet it comes from", () => {
    const set = buildSheets(run(), [facts(), facts({ slug: "sweep-02", archivePath: "captures/sweep-02.jpg" })]);
    expect(set.specMarkdown.length).toBeGreaterThan(200);
    expect(set.specMarkdown.length).toBeLessThan(set.statSheetText.length);
  });

  it("names every file it offers without colliding", () => {
    const set = buildSheets(run(), [facts()]);
    const names = Object.values(set.fileNames);
    expect(new Set(names).size).toBe(names.length);
    expect(set.fileNames.spec.endsWith(".md")).toBe(true);
    expect(set.fileNames.statHtml.endsWith(".html")).toBe(true);
  });
});
