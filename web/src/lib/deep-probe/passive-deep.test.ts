/**
 * Tests for the deep passive probes.
 *
 * These cover the pure helpers only — the collectors themselves need a real
 * browser (canvas, WebGL, Web Audio, RTCPeerConnection), and a stubbed version
 * of those would test the stub rather than the probe. What *is* testable here
 * is the part that would silently corrupt the dump if it were wrong: the
 * hashing, the SDP parse, and the clock-resolution maths.
 */

import { describe, expect, it } from "vitest";

import { FONT_PROBES, clockResolutionFrom, fnv1aHex, hashFloats, summariseSdp } from "./passive-deep";

describe("fnv1aHex", () => {
  it("is deterministic and fixed width", () => {
    const a = fnv1aHex([1, 2, 3, 4, 5]);
    const b = fnv1aHex([1, 2, 3, 4, 5]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when a single byte changes", () => {
    // A signature that survives a one-byte edit would describe a different
    // rendering pipeline as the same one.
    expect(fnv1aHex([1, 2, 3, 4, 5])).not.toBe(fnv1aHex([1, 2, 3, 4, 6]));
  });

  it("distinguishes order", () => {
    expect(fnv1aHex([1, 2])).not.toBe(fnv1aHex([2, 1]));
  });

  it("distinguishes length, so trailing zeroes are not free", () => {
    expect(fnv1aHex([1, 2, 3])).not.toBe(fnv1aHex([1, 2, 3, 0]));
  });

  it("only reads the low byte, so pixel data cannot alias by overflow", () => {
    expect(fnv1aHex([0x101, 0x102])).toBe(fnv1aHex([0x01, 0x02]));
  });

  it("handles an empty input without throwing", () => {
    expect(fnv1aHex([])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("hashFloats", () => {
  it("ignores noise below the quantisation step", () => {
    // Audio output differs in the last bits between runs on the same device.
    // A signature that moved with that noise would be useless.
    const base = [0.1234567, 0.7654321, -0.5];
    const jittered = [0.12345671, 0.76543211, -0.500000001];
    expect(hashFloats(base)).toBe(hashFloats(jittered));
  });

  it("still reacts to a real difference", () => {
    expect(hashFloats([0.1234567])).not.toBe(hashFloats([0.1234599]));
  });

  it("separates positive and negative values of the same magnitude", () => {
    expect(hashFloats([0.5])).not.toBe(hashFloats([-0.5]));
  });
});

describe("summariseSdp", () => {
  const sdp = [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 103",
    "a=mid:0",
    "a=rtpmap:111 opus/48000/2",
    "a=rtpmap:103 ISAC/16000",
    "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 98",
    "a=mid:1",
    "a=rtpmap:96 VP8/90000",
    "a=rtpmap:98 VP9/90000",
    "a=extmap:2/sendonly urn:ietf:params:rtp-hdrext:toffset",
  ].join("\r\n");

  it("pulls out the codec list in order", () => {
    expect(summariseSdp(sdp).codecs).toEqual(["opus/48000/2", "ISAC/16000", "VP8/90000", "VP9/90000"]);
  });

  it("pulls out header extensions, including directional ones", () => {
    expect(summariseSdp(sdp).extensions).toEqual([
      "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
      "urn:ietf:params:rtp-hdrext:toffset",
    ]);
  });

  it("records every media section", () => {
    expect(summariseSdp(sdp).mids).toEqual(["0", "1"]);
  });

  it("de-duplicates a codec offered on both media sections", () => {
    const repeated = ["a=rtpmap:96 VP8/90000", "a=rtpmap:97 VP8/90000"].join("\r\n");
    expect(summariseSdp(repeated).codecs).toEqual(["VP8/90000"]);
  });

  it("handles bare newlines as well as CRLF", () => {
    expect(summariseSdp("a=rtpmap:96 VP8/90000\na=rtpmap:98 VP9/90000").codecs).toEqual(["VP8/90000", "VP9/90000"]);
  });

  it("returns empty lists rather than throwing on an SDP with no media", () => {
    expect(summariseSdp("v=0\r\no=- 1 2 IN IP4 127.0.0.1")).toEqual({ codecs: [], extensions: [], mids: [] });
  });
});

describe("clockResolutionFrom", () => {
  it("finds the smallest positive step", () => {
    expect(clockResolutionFrom([0, 0, 0.1, 0.1, 0.35])).toBeCloseTo(0.1, 10);
  });

  it("ignores repeated reads, which are the common case on a coarsened clock", () => {
    expect(clockResolutionFrom([5, 5, 5, 5])).toBeNull();
  });

  it("ignores a clock that goes backwards rather than reporting a negative step", () => {
    // Deltas are -5 then +7; the negative is discarded, leaving 7.
    expect(clockResolutionFrom([10, 5, 12])).toBe(7);
  });

  it("returns null for too few samples", () => {
    expect(clockResolutionFrom([1])).toBeNull();
    expect(clockResolutionFrom([])).toBeNull();
  });
});

describe("FONT_PROBES", () => {
  it("has no duplicates, which would inflate the present/absent counts", () => {
    expect(new Set(FONT_PROBES).size).toBe(FONT_PROBES.length);
  });

  it("spans platforms so a hit is informative about the OS", () => {
    // A list of only web-safe fonts would come back identical everywhere.
    for (const font of ["Helvetica Neue", "Roboto", "Segoe UI", "PingFang SC"]) {
      expect(FONT_PROBES).toContain(font);
    }
  });
});
