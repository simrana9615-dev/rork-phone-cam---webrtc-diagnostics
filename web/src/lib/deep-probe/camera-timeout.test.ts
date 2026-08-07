/**
 * Tests for the camera deadline.
 *
 * The property that matters most is not the rejection — it is the adoption. A
 * `getUserMedia` promise that resolves after the deadline hands over a LIVE
 * camera, and a deadline that simply drops the reference leaves the sensor
 * running and the indicator lit for the rest of the session. Every test here
 * that involves a late answer checks the tracks were stopped.
 *
 * The other property is that a timeout never impersonates a device answer. An
 * `OverconstrainedError` is the camera stating a limit and must arrive at the
 * caller exactly as thrown; a timeout is the request being abandoned and must be
 * distinguishable from it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_DEADLINE_POLICY,
  CAMERA_OPEN_TIMEOUT_MS,
  CameraTimeoutError,
  isCameraTimeout,
  openMediaWithDeadline,
  PROMPT_ANSWER_TIMEOUT_MS,
  withCameraDeadline,
  type LateArrival,
} from "./camera-timeout";

function later<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function failLater(err: Error, ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(err), ms));
}

type FakeTrack = { stopped: boolean; stop: () => void };

function fakeStream(): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [
    { stopped: false, stop: (): void => undefined },
    { stopped: false, stop: (): void => undefined },
  ];
  for (const track of tracks) track.stop = (): void => void (track.stopped = true);
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks };
}

const original = navigator.mediaDevices;

function stubGetUserMedia(impl: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: impl },
  });
}

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: original });
  vi.restoreAllMocks();
});

describe("the deadline itself", () => {
  it("gives a camera ten seconds once the answer is already in", () => {
    expect(CAMERA_OPEN_TIMEOUT_MS).toBe(10_000);
  });

  it("gives a prompt far longer, because that clock is a person reading", () => {
    expect(PROMPT_ANSWER_TIMEOUT_MS).toBeGreaterThan(CAMERA_OPEN_TIMEOUT_MS * 3);
  });

  it("states in the archive that a timeout is not a refusal", () => {
    expect(CAMERA_DEADLINE_POLICY).toMatch(/NOT a refusal/);
    expect(CAMERA_DEADLINE_POLICY).toMatch(/OverconstrainedError/);
  });

  it("passes a fast answer straight through", async () => {
    await expect(withCameraDeadline(later("ok", 5), { timeoutMs: 200 })).resolves.toBe("ok");
  });

  it("abandons a request that misses its deadline", async () => {
    const err = await withCameraDeadline(later("late", 200), { timeoutMs: 20, what: "the back camera" }).catch((e: unknown) => e);
    expect(isCameraTimeout(err)).toBe(true);
    expect((err as CameraTimeoutError).waitedMs).toBe(20);
    expect((err as CameraTimeoutError).message).toMatch(/the back camera did not answer within 0\.0 s/);
  });

  it("says in the error that this was not the camera stating a limit", async () => {
    const err = await withCameraDeadline(later("late", 200), { timeoutMs: 10 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/not a refusal and not a limit the camera stated/);
  });
});

describe("a real device answer", () => {
  it("arrives unchanged, never rewritten as a timeout", async () => {
    const overconstrained = new Error("OverconstrainedError: width");
    overconstrained.name = "OverconstrainedError";
    const err = await withCameraDeadline(failLater(overconstrained, 5), { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).toBe(overconstrained);
    expect(isCameraTimeout(err)).toBe(false);
  });

  it("is distinguishable from a timeout by type, not by reading the message", async () => {
    const timedOut = await withCameraDeadline(later(1, 100), { timeoutMs: 10 }).catch((e: unknown) => e);
    const refused = await withCameraDeadline(Promise.reject(new Error("NotAllowedError")), { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(isCameraTimeout(timedOut)).toBe(true);
    expect(isCameraTimeout(refused)).toBe(false);
  });
});

describe("adopting the abandoned request", () => {
  it("stops a stream that turns up after the deadline, so no camera stays lit", async () => {
    const { stream, tracks } = fakeStream();
    stubGetUserMedia(() => later(stream, 40));
    const late: LateArrival[] = [];

    await expect(openMediaWithDeadline({ video: true }, { timeoutMs: 10, what: "the front camera", onLate: (l) => late.push(l) })).rejects.toBeInstanceOf(
      CameraTimeoutError
    );
    expect(tracks.every((t) => t.stopped)).toBe(false);

    await later(null, 60);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(late).toHaveLength(1);
    expect(late[0].what).toBe("the front camera");
    expect(late[0].streamClosed).toBe(true);
    expect(late[0].arrivedAtMs).toBeGreaterThanOrEqual(10);
  });

  it("says nothing about a late arrival when the camera answered in time", async () => {
    const { stream, tracks } = fakeStream();
    stubGetUserMedia(() => later(stream, 5));
    const late: LateArrival[] = [];

    await expect(openMediaWithDeadline({ video: true }, { timeoutMs: 200, onLate: (l) => late.push(l) })).resolves.toBe(stream);
    await later(null, 30);
    expect(late).toHaveLength(0);
    // The caller owns a stream it asked for and got: closing it here would be
    // the deadline stealing a working camera.
    expect(tracks.some((t) => t.stopped)).toBe(false);
  });

  it("swallows a rejection that arrives after the deadline rather than raising it twice", async () => {
    stubGetUserMedia(() => failLater(new Error("NotReadableError"), 40));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    await expect(openMediaWithDeadline({ video: true }, { timeoutMs: 10 })).rejects.toBeInstanceOf(CameraTimeoutError);
    await later(null, 60);

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("refuses plainly when the browser has no getUserMedia at all", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    await expect(openMediaWithDeadline({ video: true })).rejects.toThrow(/no navigator\.mediaDevices/);
  });
});
