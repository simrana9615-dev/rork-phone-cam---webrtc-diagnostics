/**
 * Tests for the two things added around the Deep Probe archive: reading one back
 * in, and reducing a run to a device spec.
 *
 * The reader is checked against the writer rather than against itself — the
 * offsets it resolves must equal the offsets the writer recorded, and a stored
 * payload must come back byte-for-byte from an arbitrary window. The negative
 * case matters most: a single flipped byte inside the archive has to be caught,
 * because a verifier that only ever says "fine" is worse than none.
 *
 * The spec is checked for the property that makes it useful and the property
 * that keeps it honest: boilerplate is dropped, and deviations from the declared
 * defaults are kept and flagged rather than quietly folded in with everything
 * else.
 */

import { describe, expect, it } from "vitest";

import { buildZip, crcHex, isDeflateSupported } from "../zip-writer";
import { buildMimicSpec, quantisationStep, type MimicCaptureFact, type MimicSpecInput } from "./mimic-spec";
import { payloadStart, readEntry, readEntryText, readZip, verifyEntry } from "./zip-reader";
import type { CameraMatrixReport } from "./camera-matrix";
import type { PassiveGroup } from "./passive";
import type { SensorSeries } from "./sensors";

/** Every byte value plus a JPEG-looking header — anything that decodes or re-encodes will corrupt this. */
function hostileBytes(): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x16, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const all256 = Array.from({ length: 256 }, (_, i) => i);
  return new Uint8Array([...head, ...all256, ...all256.slice().reverse(), 0x00, 0xff, 0xd9]);
}

function blobOf(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer]);
}

const LONG_TEXT = Array.from({ length: 4000 }, (_, i) => `line ${i} — some repeated text that deflates well`).join("\n");

async function sampleArchive(): Promise<{ blob: Blob; capture: Uint8Array; entries: { path: string; dataOffset: number; crc32: number }[] }> {
  const capture = hostileBytes();
  const built = await buildZip([
    { path: "captures/shot-1.jpg", data: blobOf(capture) },
    { path: "raw/shot-1.hex.txt", data: LONG_TEXT, compress: true },
    { path: "READ-ME.txt", data: "plain" },
  ]);
  return { blob: built.blob, capture, entries: built.entries.map((e) => ({ path: e.path, dataOffset: e.dataOffset, crc32: e.crc32 })) };
}

describe("readZip", () => {
  it("lists every entry the writer put in, with matching sizes", async () => {
    const { blob } = await sampleArchive();
    const archive = await readZip(blob);
    expect(archive.entries.map((e) => e.path).sort()).toEqual(["READ-ME.txt", "captures/shot-1.jpg", "raw/shot-1.hex.txt"]);
    expect(archive.entries.find((e) => e.path === "captures/shot-1.jpg")?.size).toBe(hostileBytes().length);
    expect(archive.warnings).toEqual([]);
  });

  it("resolves the same payload offset the writer recorded", async () => {
    const { blob, entries } = await sampleArchive();
    const archive = await readZip(blob);
    for (const entry of archive.entries) {
      const expected = entries.find((e) => e.path === entry.path)?.dataOffset;
      expect(await payloadStart(archive, entry)).toBe(expected);
    }
  });

  it("refuses a file that is not a ZIP, instead of parsing nonsense out of it", async () => {
    await expect(readZip(blobOf(new Uint8Array(400)))).rejects.toThrow(/end-of-central-directory/i);
  });

  it("refuses a file too small to be an archive", async () => {
    await expect(readZip(new Blob(["no"]))).rejects.toThrow(/too small/i);
  });
});

describe("reading entries back", () => {
  it("returns a stored capture byte-for-byte", async () => {
    const { blob, capture } = await sampleArchive();
    const archive = await readZip(blob);
    const entry = archive.entries.find((e) => e.path === "captures/shot-1.jpg");
    expect(entry?.stored).toBe(true);
    const read = await readEntry(archive, entry!, 0, capture.length);
    expect(Array.from(read.bytes)).toEqual(Array.from(capture));
    expect(read.complete).toBe(true);
  });

  it("reads an arbitrary window of a stored entry without touching the rest", async () => {
    const { blob, capture } = await sampleArchive();
    const archive = await readZip(blob);
    const entry = archive.entries.find((e) => e.path === "captures/shot-1.jpg")!;
    const read = await readEntry(archive, entry, 100, 32);
    expect(Array.from(read.bytes)).toEqual(Array.from(capture.slice(100, 132)));
    expect(read.start).toBe(100);
    expect(read.complete).toBe(false);
    expect(read.totalSize).toBe(capture.length);
  });

  it("says so when a byte cap cut the read short, and says so when it did not", async () => {
    const { blob } = await sampleArchive();
    const archive = await readZip(blob);
    const entry = archive.entries.find((e) => e.path === "raw/shot-1.hex.txt")!;
    const short = await readEntryText(archive, entry, 0, 200);
    expect(short.complete).toBe(false);
    expect(short.text.length).toBeGreaterThan(0);

    const whole = await readEntryText(archive, entry, 0, entry.size + 1024);
    expect(whole.complete).toBe(true);
    expect(whole.text).toBe(LONG_TEXT);
  });

  it("round-trips a deflated entry through the platform inflater", async () => {
    const { blob } = await sampleArchive();
    const archive = await readZip(blob);
    const entry = archive.entries.find((e) => e.path === "raw/shot-1.hex.txt")!;
    // Whether it was actually deflated depends on the platform, and the reader
    // must handle both without the test pretending either way.
    expect(entry.stored).toBe(!isDeflateSupported());
    const text = await readEntryText(archive, entry, 0, entry.size + 1024);
    expect(text.text).toBe(LONG_TEXT);
  });
});

describe("verifyEntry", () => {
  it("confirms an untouched entry against the checksum in the archive", async () => {
    const { blob } = await sampleArchive();
    const archive = await readZip(blob);
    for (const entry of archive.entries) {
      const result = await verifyEntry(archive, entry);
      expect(result.ok).toBe(true);
      expect(result.actual).toBe(result.expected);
    }
  });

  it("catches a single flipped byte inside a stored capture", async () => {
    const { blob, entries } = await sampleArchive();
    const target = entries.find((e) => e.path === "captures/shot-1.jpg")!;
    const original = new Uint8Array(await blob.slice(target.dataOffset, target.dataOffset + 1).arrayBuffer())[0];
    const flipped = new Uint8Array([original ^ 0xff]);
    const tampered = new Blob([blob.slice(0, target.dataOffset), blobOf(flipped), blob.slice(target.dataOffset + 1)]);

    const archive = await readZip(tampered);
    const entry = archive.entries.find((e) => e.path === "captures/shot-1.jpg")!;
    const result = await verifyEntry(archive, entry);
    expect(result.ok).toBe(false);
    expect(result.actual).not.toBe(result.expected);
    expect(result.expected).toBe(crcHex(target.crc32));
    expect(result.detail).toMatch(/MISMATCH/);
  });
});

/* ------------------------------------------------------------------ *
 * Device spec
 * ------------------------------------------------------------------ */

describe("quantisationStep", () => {
  it("finds the step of a quantised series", () => {
    const values = Array.from({ length: 40 }, (_, i) => Number((i * 0.25).toFixed(6)));
    expect(quantisationStep(values)).toBe(0.25);
  });

  it("ignores repeated readings when working out the step", () => {
    expect(quantisationStep([1, 1, 1, 2, 2, 3, 5, 8])).toBe(1);
  });

  it("withholds an answer rather than guessing from too few samples", () => {
    expect(quantisationStep([1, 2])).toBeNull();
    expect(quantisationStep([7, 7, 7, 7, 7])).toBeNull();
  });
});

function passive(rows: { label: string; value: string }[], title = "Identity strings"): PassiveGroup[] {
  return [{ title, note: "", rows }];
}

function specInput(overrides: Partial<MimicSpecInput> = {}): MimicSpecInput {
  return {
    generatedAt: "2026-08-07T10:00:00.000Z",
    tier: "standard",
    passive: [],
    permissionStates: [],
    permissions: [],
    sensors: [],
    matrix: null,
    captures: [],
    omissions: [],
    ...overrides,
  };
}

describe("buildMimicSpec", () => {
  it("drops a reading that matches the common default, and lists it as dropped", () => {
    const spec = buildMimicSpec(specInput({ passive: passive([{ label: "Cookies enabled", value: "true" }]) }));
    expect(spec).not.toMatch(/^OS.*cookieEnabled/m);
    expect(spec).toMatch(/cookieEnabled = true/);
    const canonical = canonicalOf(spec);
    expect(canonical.droppedAsCommonDefault).toContain("cookieEnabled = true");
    expect(canonical.sections.flatMap((s) => s.facts).find((f) => f.key === "cookieEnabled")).toBeUndefined();
  });

  it("keeps a reading that differs from the common default, and flags it", () => {
    const spec = buildMimicSpec(specInput({ passive: passive([{ label: "Automation flag (navigator.webdriver)", value: "true" }]) }));
    const canonical = canonicalOf(spec);
    const fact = canonical.sections.flatMap((s) => s.facts).find((f) => f.key === "webdriver");
    expect(fact?.value).toBe("true");
    expect(fact?.differsFromCommonDefault).toBe(true);
    expect(canonical.droppedAsCommonDefault).not.toContain("webdriver = true");
    expect(spec).toMatch(/## Start here/);
  });

  it("keeps a reading that has no declared default at all", () => {
    const spec = buildMimicSpec(specInput({ passive: passive([{ label: "WebGL renderer", value: "Apple A17 Pro GPU" }], "Graphics") }));
    const fact = canonicalOf(spec)
      .sections.flatMap((s) => s.facts)
      .find((f) => f.key === "gpu.renderer");
    expect(fact?.value).toBe("Apple A17 Pro GPU");
    expect(fact?.differsFromCommonDefault).toBe(false);
    expect(fact?.stability).toBe("HW");
  });

  it("never claims uniqueness", () => {
    const spec = buildMimicSpec(specInput({ passive: passive([{ label: "WebGL renderer", value: "Mali-G715" }], "Graphics") }));
    expect(canonicalOf(spec).uniquenessClaimed).toBe(false);
    expect(spec).toMatch(/Uniqueness is not claimed/);
    expect(spec).not.toMatch(/entropy bits|bits of entropy|1 in [\d,]+ devices/i);
  });

  it("tags volatile readings so they are not mimicked as constants", () => {
    const spec = buildMimicSpec(
      specInput({
        passive: [
          { title: "Power", note: "", rows: [{ label: "Charge level", value: "62%" }] },
          { title: "Hardware", note: "", rows: [{ label: "Device pixel ratio", value: "3" }] },
        ],
      })
    );
    const facts = canonicalOf(spec).sections.flatMap((s) => s.facts);
    expect(facts.find((f) => f.key === "battery.level")?.stability).toBe("VAR");
    expect(facts.find((f) => f.key === "screen.dpr")?.stability).toBe("HW");
  });

  it("keeps camera-original and app-encoded captures apart", () => {
    const base: Omit<MimicCaptureFact, "slug" | "origin" | "path" | "tagCount" | "tagKeys" | "stableTags"> = {
      deviceLabel: "Back Camera",
      width: 4032,
      height: 3024,
      bytes: 2_400_000,
      mime: "image/jpeg",
      container: "JPEG",
      markers: ["SOI", "APP1"],
      segments: ["exif"],
      unknownTagCount: 12,
    };
    const spec = buildMimicSpec(
      specInput({
        captures: [
          { ...base, slug: "a", origin: "camera-file", path: "camera-file", tagCount: 78, tagKeys: ["Make", "Model"], stableTags: { Make: "Apple" } },
          { ...base, slug: "b", origin: "app-encoded-frame", path: "canvas", tagCount: 0, tagKeys: [], stableTags: {}, unknownTagCount: 0 },
        ],
      })
    );
    const facts = canonicalOf(spec).sections.flatMap((s) => s.facts);
    expect(facts.filter((f) => f.key.endsWith(".source"))).toHaveLength(2);
    expect(facts.find((f) => f.key === "capture[0].tag.Make")?.value).toBe("Apple");
    expect(facts.find((f) => f.value.includes("no metadata at all"))).toBeDefined();
  });

  it("records the sensor rate and step it measured, and says when it could not", () => {
    const series: SensorSeries = {
      id: "motion",
      label: "Motion",
      columns: ["t_ms", "accel_x"],
      rows: Array.from({ length: 30 }, (_, i) => [String(i * 20), (i * 0.5).toFixed(3)]),
      requestedHz: 60,
      measuredHz: 50,
      durationMs: 600,
      note: "",
    };
    const spec = buildMimicSpec(specInput({ sensors: [series] }));
    const facts = canonicalOf(spec).sections.flatMap((s) => s.facts);
    expect(facts.find((f) => f.key === "sensor.motion.rate")?.value).toMatch(/50 Hz measured.*asked for 60 Hz/);
    expect(facts.find((f) => f.key === "sensor.motion.accel_x")?.value).toMatch(/step 0\.5/);
    // The time column is not a reading, so it is not described as one.
    expect(facts.find((f) => f.key === "sensor.motion.t_ms")).toBeUndefined();
  });

  it("names stages that did not run instead of leaving a silent gap", () => {
    const spec = buildMimicSpec(specInput({ omissions: [{ stage: "Camera sweep", reason: "You stopped the run." }] }));
    expect(spec).toMatch(/Not observed/);
    expect(canonicalOf(spec).notObserved).toEqual([{ stage: "Camera sweep", reason: "You stopped the run." }]);
  });

  it("records what the camera granted, and where it silently substituted a different mode", () => {
    const matrix: CameraMatrixReport = {
      startedAt: "2026-08-07T10:00:00.000Z",
      finishedAt: "2026-08-07T10:05:00.000Z",
      durationMs: 300_000,
      inventory: [],
      stillPolicy: "",
      notes: [],
      aborted: false,
      rows: [
        {
          deviceId: "abcdef1234",
          deviceLabel: "Back Camera",
          group: "g",
          kind: "resolution",
          asked: "4K UHD 3840x2160",
          askedConstraints: {},
          ok: true,
          granted: "1920x1080",
          grantedSettings: { width: 1920, height: 1080 },
          error: null,
          durationMs: 10,
          captureSlugs: [],
        },
        {
          deviceId: "abcdef1234",
          deviceLabel: "Back Camera",
          group: "g",
          kind: "resolution",
          asked: "8K UHD 7680x4320",
          askedConstraints: {},
          ok: false,
          granted: null,
          grantedSettings: null,
          error: "OverconstrainedError",
          durationMs: 8,
          captureSlugs: [],
        },
      ],
    };
    const facts = canonicalOf(buildMimicSpec(specInput({ matrix }))).sections.flatMap((s) => s.facts);
    expect(facts.find((f) => f.key === "camera[abcdef12].maxGranted")?.value).toBe("1920x1080");
    expect(facts.find((f) => f.key === "camera[abcdef12].snapping")?.value).toContain("4K UHD 3840x2160->1920x1080");
    expect(facts.find((f) => f.key === "camera[abcdef12].refused")?.value).toContain("OverconstrainedError");
  });

  it("emits a canonical JSON block holding exactly the facts in the body", () => {
    const spec = buildMimicSpec(
      specInput({
        passive: passive([
          { label: "WebGL renderer", value: "Adreno (TM) 740" },
          { label: "Max texture size", value: "16384" },
        ], "Graphics"),
      })
    );
    const canonical = canonicalOf(spec);
    expect(canonical.kind).toBe("deep-probe-device-spec");
    const bodyLines = spec.split("\n").filter((line) => /^(HW|OS|SET|VAR)\s/.test(line));
    expect(bodyLines).toHaveLength(canonical.sections.flatMap((s) => s.facts).length);
  });
});

type Canonical = {
  kind: string;
  uniquenessClaimed: boolean;
  sections: { title: string; facts: { key: string; value: string; stability: string; differsFromCommonDefault: boolean }[] }[];
  droppedAsCommonDefault: string[];
  notObserved: { stage: string; reason: string }[];
};

/** Pulls the machine-readable block back out, which also proves it is valid JSON. */
function canonicalOf(spec: string): Canonical {
  const match = spec.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error("the spec contained no canonical JSON block");
  return JSON.parse(match[1]) as Canonical;
}
