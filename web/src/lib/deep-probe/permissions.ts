/**
 * The permission sweep — every request a website can put in front of a mobile
 * user, in one ordered registry.
 *
 * Honesty rules baked into the shape of this file:
 *
 *  1. "Not implemented by this browser" and "you said no" are different
 *     outcomes and are never merged. `unavailable` is detected by feature
 *     probe BEFORE the request fires, so a missing API can never masquerade as
 *     a refusal (or vice versa).
 *  2. A refusal is terminal. Nothing here retries a denied request, and
 *     nothing re-asks behind a second tap.
 *  3. Coverage is never claimed to be total. The permission surface differs
 *     per browser and grows every release, so the report states what this
 *     registry knows to ask for and admits that the set is open-ended.
 *  4. Every request states, before it fires, what the site can reach if you
 *     agree and how long that lasts. Those strings live next to the code that
 *     performs the request so they cannot drift apart.
 *  5. Grants are released immediately. A camera track opened to prove the
 *     prompt works is stopped in the same tick; a wake lock is released; a
 *     scan is aborted. This module demonstrates access, it does not keep it.
 */

/** How far the sweep reaches. Each tier is a superset of the one before it. */
export type PermissionTier = "standard" | "extended" | "everything";

export const TIER_ORDER: PermissionTier[] = ["standard", "extended", "everything"];

export const TIER_INFO: Record<PermissionTier, { label: string; blurb: string; caution: string | null }> = {
  standard: {
    label: "Standard",
    blurb: "The everyday set almost every site asks for: camera, microphone, location, motion sensors, notifications, storage and keeping the screen awake.",
    caution: null,
  },
  extended: {
    label: "Extended",
    blurb: "Adds hardware and peripherals: Bluetooth, USB, serial, human-interface devices, tag reading, music devices, the raw sensor APIs, and away-detection.",
    caution: "These reach hardware attached to your device. Each one still needs your explicit approval on a chooser you control.",
  },
  everything: {
    label: "Everything",
    blurb: "Adds the requests that reach data belonging to other apps: clipboard contents, your contacts, recording your screen, your installed fonts, files, and multi-screen layout.",
    caution:
      "This tier is the point of the exercise, and also the sharp end of it. Granting clipboard read hands over whatever you last copied — possibly a password. Screen recording captures whatever you pick. Contacts hands over other people's details. Nothing is uploaded, but decline anything you are not comfortable demonstrating.",
  },
};

/** What came back from one request. */
export type PermissionOutcome =
  /** You allowed it and the API returned something. */
  | "granted"
  /** You refused, or a prior refusal was reused by the browser. */
  | "denied"
  /** You dismissed the prompt without choosing, or it timed out. */
  | "dismissed"
  /** The browser does not implement this at all — never a refusal. */
  | "unavailable"
  /** You skipped it before it fired. */
  | "skipped"
  /** The API exists and errored for a reason that is neither of the above. */
  | "error";

export const OUTCOME_LABEL: Record<PermissionOutcome, string> = {
  granted: "Allowed",
  denied: "Denied",
  dismissed: "Dismissed",
  unavailable: "Not in this browser",
  skipped: "Skipped",
  error: "Errored",
};

export type RequestResult = {
  outcome: PermissionOutcome;
  /** What actually came back, in concrete terms. Never a guess. */
  detail: string;
  /** Structured payload for the archive, when the API returned data worth keeping. */
  data?: Record<string, unknown>;
};

export type ProbeRequest = {
  id: string;
  label: string;
  tier: PermissionTier;
  /** The underlying Web API, named exactly. */
  api: string;
  /** What the site can reach once granted, in plain words. */
  reaches: string;
  /** How long the grant lasts. */
  duration: string;
  /** `navigator.permissions.query` name, where one is defined. */
  permissionName?: string;
  /** True when the browser will only show the prompt from a fresh user gesture. */
  needsGesture: boolean;
  /** Why the gesture is required — shown on the card instead of a countdown. */
  gestureReason?: string;
  /** Feature probe. Returning false records `unavailable` without firing anything. */
  available: () => boolean;
  /** Fires the request and releases whatever it was granted. */
  run: () => Promise<RequestResult>;
};

/** One recorded request, exactly as it happened. */
export type PermissionRecord = {
  id: string;
  label: string;
  tier: PermissionTier;
  api: string;
  reaches: string;
  duration: string;
  outcome: PermissionOutcome;
  detail: string;
  /** Permission state reported by `navigator.permissions.query` before the ask. */
  stateBefore: string | null;
  /** …and after. A change here is the browser confirming what your answer did. */
  stateAfter: string | null;
  /** ISO timestamp of the moment the request fired. */
  askedAt: string;
  /** Milliseconds between the request firing and it resolving — i.e. your thinking time. */
  responseMs: number;
  data?: Record<string, unknown>;
};

/* ------------------------------------------------------------------ *
 * Narrow shims for APIs the TypeScript DOM lib does not declare.
 * Each is feature-probed before use; none is assumed to exist.
 * ------------------------------------------------------------------ */

type PermissionGate = { requestPermission: () => Promise<string> };
type SensorLike = {
  start: () => void;
  stop: () => void;
  addEventListener: (type: string, cb: () => void) => void;
};
type SensorCtor = new (opts?: { frequency?: number }) => SensorLike;
type NdefReaderCtor = new () => { scan: (opts?: { signal?: AbortSignal }) => Promise<void> };
type ContactsManager = {
  select: (props: string[], opts?: { multiple?: boolean }) => Promise<unknown[]>;
  getProperties: () => Promise<string[]>;
};
type IdleDetectorCtor = { requestPermission: () => Promise<string> };
type FontData = { family: string; fullName: string; postscriptName: string; style: string };

function w<T>(key: string): T | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, T | undefined>)[key];
}

function nav<T>(key: string): T | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as unknown as Record<string, T | undefined>)[key];
}

/** WebKit gates several prompts behind a fresh user activation that a chained timer does not satisfy. */
function isWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

function describeError(err: unknown): { outcome: PermissionOutcome; detail: string } {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return { outcome: "denied", detail: `${err.name} — the request was refused. ${err.message || "No further reason was given."}` };
      case "AbortError":
        return { outcome: "dismissed", detail: `${err.name} — the chooser was closed without a selection.` };
      case "NotFoundError":
        return {
          outcome: "dismissed",
          detail: `${err.name} — the chooser opened and nothing was selected (or no matching device exists). This is not a refusal.`,
        };
      case "NotSupportedError":
      case "NotReadableError":
      case "InvalidStateError":
        return { outcome: "error", detail: `${err.name} — ${err.message || "the API exists but could not complete the request here."}` };
      default:
        return { outcome: "error", detail: `${err.name} — ${err.message}` };
    }
  }
  return { outcome: "error", detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
}

/** Rejects if a promise has not settled in time, so a swallowed prompt cannot stall the run. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new DOMException(`${what} did not resolve within ${ms / 1000}s`, "AbortError")), ms)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Permission state, queried around every request
 * ------------------------------------------------------------------ */

/** Every permission name any current browser answers `permissions.query` for. */
export const QUERYABLE_PERMISSIONS: string[] = [
  "accelerometer",
  "ambient-light-sensor",
  "background-fetch",
  "background-sync",
  "bluetooth",
  "camera",
  "clipboard-read",
  "clipboard-write",
  "compute-pressure",
  "device-info",
  "display-capture",
  "geolocation",
  "gyroscope",
  "idle-detection",
  "local-fonts",
  "magnetometer",
  "microphone",
  "midi",
  "nfc",
  "notifications",
  "payment-handler",
  "periodic-background-sync",
  "persistent-storage",
  "push",
  "screen-wake-lock",
  "speaker-selection",
  "storage-access",
  "system-wake-lock",
  "top-level-storage-access",
  "window-management",
  "xr-spatial-tracking",
];

/**
 * Queries one permission. Returns null when the browser refuses the name —
 * which is itself information, and is recorded as "this browser will not
 * answer for that name" rather than as a state.
 */
export async function queryPermission(name: string): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return null;
  try {
    const status = await navigator.permissions.query({ name: name as PermissionName });
    return status.state;
  } catch {
    return null;
  }
}

/** Queries every known permission name at once, for the before/after snapshots. */
export async function queryAllPermissions(): Promise<{ name: string; state: string | null }[]> {
  return Promise.all(QUERYABLE_PERMISSIONS.map(async (name) => ({ name, state: await queryPermission(name) })));
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      // already stopped
    }
  });
}

function summariseTracks(stream: MediaStream): Record<string, unknown> {
  return {
    tracks: stream.getTracks().map((t) => ({
      kind: t.kind,
      label: t.label,
      settings: t.getSettings?.() ?? null,
    })),
  };
}

/** Motion/orientation gate on iOS. Elsewhere the events simply fire, with no prompt at all. */
function motionGate(kind: "DeviceMotionEvent" | "DeviceOrientationEvent"): PermissionGate | null {
  const ctor = w<PermissionGate>(kind);
  return ctor && typeof ctor.requestPermission === "function" ? ctor : null;
}

/** Listens for one event to prove it actually fires, rather than trusting the grant. */
function awaitEvent(type: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (fired: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener(type, handler);
      resolve(fired);
    };
    const handler = () => done(true);
    window.addEventListener(type, handler);
    setTimeout(() => done(false), ms);
  });
}

async function requestMotion(kind: "DeviceMotionEvent" | "DeviceOrientationEvent", event: string): Promise<RequestResult> {
  const gate = motionGate(kind);
  if (!gate) {
    // No gate means no prompt exists — the events are ungated here.
    const fired = await awaitEvent(event, 1500);
    return {
      outcome: fired ? "granted" : "unavailable",
      detail: fired
        ? `No prompt exists in this browser: ${event} events fire without asking. One arrived within 1.5s, so the data really is flowing.`
        : `No prompt exists in this browser and no ${event} event arrived within 1.5s — either this device has no such sensor or the page is not receiving them.`,
      data: { gated: false, eventObserved: fired },
    };
  }
  const state = await gate.requestPermission();
  if (state !== "granted") {
    return { outcome: state === "denied" ? "denied" : "dismissed", detail: `${kind}.requestPermission() returned "${state}".`, data: { gated: true, state } };
  }
  const fired = await awaitEvent(event, 1500);
  return {
    outcome: "granted",
    detail: fired
      ? `Granted, and a ${event} event arrived within 1.5s — the sensor is live.`
      : `Granted, but no ${event} event arrived within 1.5s. The permission is held; the device may simply be perfectly still.`,
    data: { gated: true, state, eventObserved: fired },
  };
}

export function buildRegistry(): ProbeRequest[] {
  const webkit = isWebKit();
  const gestureNoteWebKit = "Safari only shows this prompt when a tap is still fresh, so a timed auto-advance would silently do nothing.";

  const requests: ProbeRequest[] = [
    /* ---------------- standard ---------------- */
    {
      id: "camera",
      label: "Camera",
      tier: "standard",
      api: "navigator.mediaDevices.getUserMedia({ video: true })",
      reaches:
        "A live video feed, for as long as the page keeps it open. Once granted, the site also learns the name of every camera on the device — not just the one in use.",
      duration: "Until you leave the site, or revoke it. Chrome and Safari remember the decision for this site.",
      permissionName: "camera",
      needsGesture: webkit,
      gestureReason: webkit ? gestureNoteWebKit : undefined,
      available: () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
      run: async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        const data = summariseTracks(stream);
        const label = stream.getVideoTracks()[0]?.label || "(unnamed)";
        stopStream(stream);
        return { outcome: "granted", detail: `A live video track opened on "${label}" and was stopped immediately.`, data };
      },
    },
    {
      id: "microphone",
      label: "Microphone",
      tier: "standard",
      api: "navigator.mediaDevices.getUserMedia({ audio: true })",
      reaches: "A live audio feed. The site can record it, analyse it, or stream it — the indicator tells you it is open, not what is done with it.",
      duration: "Until you leave the site, or revoke it.",
      permissionName: "microphone",
      needsGesture: webkit,
      gestureReason: webkit ? gestureNoteWebKit : undefined,
      available: () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
      run: async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const data = summariseTracks(stream);
        const label = stream.getAudioTracks()[0]?.label || "(unnamed)";
        stopStream(stream);
        return { outcome: "granted", detail: `A live audio track opened on "${label}" and was stopped immediately.`, data };
      },
    },
    {
      id: "geolocation",
      label: "Location",
      tier: "standard",
      api: "navigator.geolocation.getCurrentPosition()",
      reaches:
        "Your coordinates, with an accuracy figure, plus altitude, heading and speed where the device supplies them. A site can re-read this continuously while the tab is open.",
      duration: "Chrome remembers per site; Safari asks again after 24 hours of not visiting.",
      permissionName: "geolocation",
      needsGesture: false,
      available: () => typeof navigator !== "undefined" && !!navigator.geolocation,
      run: () =>
        new Promise<RequestResult>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              resolve({
                outcome: "granted",
                detail: `Fix returned: accurate to ±${Math.round(pos.coords.accuracy)} m${pos.coords.altitude != null ? `, altitude ${Math.round(pos.coords.altitude)} m` : ""}. The exact coordinates are in the archive.`,
                data: {
                  latitude: pos.coords.latitude,
                  longitude: pos.coords.longitude,
                  accuracy: pos.coords.accuracy,
                  altitude: pos.coords.altitude,
                  altitudeAccuracy: pos.coords.altitudeAccuracy,
                  heading: pos.coords.heading,
                  speed: pos.coords.speed,
                  timestamp: new Date(pos.timestamp).toISOString(),
                },
              });
            },
            (err) => {
              const outcome: PermissionOutcome = err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "dismissed" : "error";
              resolve({ outcome, detail: `Error code ${err.code}: ${err.message || "no message given"}.`, data: { code: err.code } });
            },
            { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
          );
        }),
    },
    {
      id: "motion",
      label: "Motion sensors",
      tier: "standard",
      api: "DeviceMotionEvent.requestPermission()",
      reaches:
        "Acceleration and rotation rate, up to about 60 readings a second. Enough to infer walking, typing rhythm, and how the phone is being held.",
      duration: "iOS grants this for the current page only — it is asked again on reload.",
      needsGesture: motionGate("DeviceMotionEvent") != null,
      gestureReason:
        "iOS requires the tap that triggers this to be the same gesture the user just made — a timed auto-advance is rejected outright. This is the clearest case of a browser insisting on a deliberate act.",
      available: () => typeof window !== "undefined" && "DeviceMotionEvent" in window,
      run: () => requestMotion("DeviceMotionEvent", "devicemotion"),
    },
    {
      id: "orientation",
      label: "Device orientation",
      tier: "standard",
      api: "DeviceOrientationEvent.requestPermission()",
      reaches: "Which way the device is tilted and pointed, including compass heading where the platform supplies it.",
      duration: "iOS grants this for the current page only.",
      needsGesture: motionGate("DeviceOrientationEvent") != null,
      gestureReason: "iOS requires a fresh, deliberate tap for this prompt.",
      available: () => typeof window !== "undefined" && "DeviceOrientationEvent" in window,
      run: () => requestMotion("DeviceOrientationEvent", "deviceorientation"),
    },
    {
      id: "notifications",
      label: "Notifications",
      tier: "standard",
      api: "Notification.requestPermission()",
      reaches: "The ability to put messages on your lock screen and in your notification centre, with a title, body and icon of the site's choosing.",
      duration: "Permanent for this site until you revoke it in settings.",
      permissionName: "notifications",
      needsGesture: webkit,
      gestureReason: webkit ? gestureNoteWebKit : undefined,
      available: () => typeof window !== "undefined" && "Notification" in window && typeof Notification.requestPermission === "function",
      run: async () => {
        const state = await Notification.requestPermission();
        return {
          outcome: state === "granted" ? "granted" : state === "denied" ? "denied" : "dismissed",
          detail: `Notification.requestPermission() returned "${state}". No notification was actually posted.`,
          data: { state },
        };
      },
    },
    {
      id: "persistent-storage",
      label: "Persistent storage",
      tier: "standard",
      api: "navigator.storage.persist()",
      reaches:
        "Exemption from automatic cleanup, so anything the site has stored on your device survives even when space runs low. In effect: data that does not expire on its own.",
      duration: "Until you clear site data manually.",
      permissionName: "persistent-storage",
      needsGesture: false,
      available: () => typeof navigator !== "undefined" && typeof navigator.storage?.persist === "function",
      run: async () => {
        const granted = await navigator.storage.persist();
        const estimate = (await navigator.storage.estimate?.()) ?? null;
        return {
          outcome: granted ? "granted" : "denied",
          detail: granted
            ? "Storage for this site is now exempt from automatic eviction."
            : "Refused — this browser did not consider the site engaged-with enough to grant it. Often decided silently, with no prompt shown.",
          data: { persisted: granted, estimate },
        };
      },
    },
    {
      id: "wake-lock",
      label: "Screen wake lock",
      tier: "standard",
      api: "navigator.wakeLock.request('screen')",
      reaches: "Keeping your screen on indefinitely while the tab is visible, overriding your auto-lock setting.",
      duration: "Until the tab is hidden or the lock is released. Usually granted with no prompt at all.",
      permissionName: "screen-wake-lock",
      needsGesture: false,
      available: () => typeof navigator !== "undefined" && !!(navigator as Navigator & { wakeLock?: unknown }).wakeLock,
      run: async () => {
        const wakeLock = (navigator as Navigator & { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        const lock = await wakeLock.request("screen");
        await lock.release();
        return {
          outcome: "granted",
          detail: "The screen lock was acquired and released immediately. Note that no prompt appeared — this one is granted silently.",
          data: { promptShown: false },
        };
      },
    },

    /* ---------------- extended ---------------- */
    {
      id: "bluetooth",
      label: "Bluetooth devices",
      tier: "extended",
      api: "navigator.bluetooth.requestDevice({ acceptAllDevices: true })",
      reaches: "The specific Bluetooth device you pick from the chooser, and the ability to read and write its services while connected.",
      duration: "Per device, until the tab closes.",
      permissionName: "bluetooth",
      needsGesture: true,
      gestureReason: "The device chooser will only open from a real tap — the spec requires transient activation.",
      available: () => typeof navigator !== "undefined" && !!(navigator as Navigator & { bluetooth?: unknown }).bluetooth,
      run: async () => {
        const bt = (navigator as Navigator & { bluetooth: { requestDevice: (o: unknown) => Promise<{ name?: string; id: string }> } }).bluetooth;
        const device = await bt.requestDevice({ acceptAllDevices: true });
        return {
          outcome: "granted",
          detail: `You picked "${device.name ?? "(unnamed device)"}". No connection was opened to it.`,
          data: { name: device.name ?? null, id: device.id },
        };
      },
    },
    {
      id: "usb",
      label: "USB devices",
      tier: "extended",
      api: "navigator.usb.requestDevice({ filters: [] })",
      reaches: "Raw read/write access to the USB device you pick — at the protocol level, not through a driver.",
      duration: "Per device, remembered for this site.",
      needsGesture: true,
      gestureReason: "The chooser requires transient activation.",
      available: () => typeof navigator !== "undefined" && !!(navigator as Navigator & { usb?: unknown }).usb,
      run: async () => {
        const usb = (navigator as Navigator & { usb: { requestDevice: (o: unknown) => Promise<{ productName?: string; vendorId: number; productId: number }> } })
          .usb;
        const device = await usb.requestDevice({ filters: [] });
        return {
          outcome: "granted",
          detail: `You picked "${device.productName ?? "(unnamed)"}" (vendor 0x${device.vendorId.toString(16)}, product 0x${device.productId.toString(16)}). It was not opened.`,
          data: { productName: device.productName ?? null, vendorId: device.vendorId, productId: device.productId },
        };
      },
    },
    {
      id: "serial",
      label: "Serial ports",
      tier: "extended",
      api: "navigator.serial.requestPort()",
      reaches: "A byte-level serial link to the port you pick.",
      duration: "Per port, remembered for this site.",
      needsGesture: true,
      gestureReason: "The chooser requires transient activation.",
      available: () => typeof navigator !== "undefined" && !!(navigator as Navigator & { serial?: unknown }).serial,
      run: async () => {
        const serial = (navigator as Navigator & { serial: { requestPort: () => Promise<{ getInfo: () => Record<string, unknown> }> } }).serial;
        const port = await serial.requestPort();
        return { outcome: "granted", detail: "A serial port was selected. It was not opened.", data: { info: port.getInfo() } };
      },
    },
    {
      id: "hid",
      label: "Human-interface devices",
      tier: "extended",
      api: "navigator.hid.requestDevice({ filters: [] })",
      reaches: "Raw input and output reports from the device you pick — for a keyboard, that means every keystroke it sends.",
      duration: "Per device, remembered for this site.",
      needsGesture: true,
      gestureReason: "The chooser requires transient activation.",
      available: () => typeof navigator !== "undefined" && !!(navigator as Navigator & { hid?: unknown }).hid,
      run: async () => {
        const hid = (navigator as Navigator & { hid: { requestDevice: (o: unknown) => Promise<{ productName?: string }[]> } }).hid;
        const devices = await hid.requestDevice({ filters: [] });
        if (devices.length === 0) return { outcome: "dismissed", detail: "The chooser closed with nothing selected." };
        return {
          outcome: "granted",
          detail: `You picked ${devices.length} device: ${devices.map((d) => d.productName ?? "(unnamed)").join(", ")}. None was opened.`,
          data: { devices: devices.map((d) => d.productName ?? null) },
        };
      },
    },
    {
      id: "nfc",
      label: "NFC tag reading",
      tier: "extended",
      api: "new NDEFReader().scan()",
      reaches: "The contents of any NFC tag brought near the device while the page is open.",
      duration: "Until the scan is stopped or the tab closes.",
      permissionName: "nfc",
      needsGesture: true,
      gestureReason: "Starting a scan requires transient activation.",
      available: () => w<NdefReaderCtor>("NDEFReader") != null,
      run: async () => {
        const Ctor = w<NdefReaderCtor>("NDEFReader");
        if (!Ctor) return { outcome: "unavailable", detail: "NDEFReader vanished between the probe and the call." };
        const controller = new AbortController();
        try {
          await withTimeout(new Ctor().scan({ signal: controller.signal }), 15000, "NFC scan");
          controller.abort();
          return { outcome: "granted", detail: "A tag scan started and was aborted immediately. No tag was read.", data: { scanStarted: true } };
        } finally {
          controller.abort();
        }
      },
    },
    {
      id: "midi",
      label: "MIDI devices (with system exclusive)",
      tier: "extended",
      api: "navigator.requestMIDIAccess({ sysex: true })",
      reaches:
        "Every MIDI input and output attached to the device, including system-exclusive messages — which on many instruments can read and rewrite firmware settings.",
      duration: "Remembered for this site.",
      permissionName: "midi",
      needsGesture: false,
      available: () => typeof navigator !== "undefined" && typeof (navigator as Navigator & { requestMIDIAccess?: unknown }).requestMIDIAccess === "function",
      run: async () => {
        const request = (navigator as Navigator & { requestMIDIAccess: (o: unknown) => Promise<{ inputs: { size: number }; outputs: { size: number } }> })
          .requestMIDIAccess;
        const access = await request({ sysex: true });
        return {
          outcome: "granted",
          detail: `Granted with system-exclusive access: ${access.inputs.size} input(s), ${access.outputs.size} output(s) are now reachable.`,
          data: { inputs: access.inputs.size, outputs: access.outputs.size, sysex: true },
        };
      },
    },
    {
      id: "accelerometer",
      label: "Accelerometer (raw sensor API)",
      tier: "extended",
      api: "new Accelerometer()",
      reaches: "Raw acceleration on three axes at a frequency the site chooses, separately from the older motion events.",
      duration: "While the sensor is running.",
      permissionName: "accelerometer",
      needsGesture: false,
      available: () => w<SensorCtor>("Accelerometer") != null,
      run: () => runGenericSensor("Accelerometer"),
    },
    {
      id: "gyroscope",
      label: "Gyroscope (raw sensor API)",
      tier: "extended",
      api: "new Gyroscope()",
      reaches: "Raw angular velocity on three axes.",
      duration: "While the sensor is running.",
      permissionName: "gyroscope",
      needsGesture: false,
      available: () => w<SensorCtor>("Gyroscope") != null,
      run: () => runGenericSensor("Gyroscope"),
    },
    {
      id: "magnetometer",
      label: "Magnetometer",
      tier: "extended",
      api: "new Magnetometer()",
      reaches: "The raw magnetic field around the device — a compass, and also a way to detect nearby magnets and metal.",
      duration: "While the sensor is running.",
      permissionName: "magnetometer",
      needsGesture: false,
      available: () => w<SensorCtor>("Magnetometer") != null,
      run: () => runGenericSensor("Magnetometer"),
    },
    {
      id: "ambient-light",
      label: "Ambient light sensor",
      tier: "extended",
      api: "new AmbientLightSensor()",
      reaches: "How bright the room is, in lux. Enough to tell whether you are indoors, outdoors, or in the dark.",
      duration: "While the sensor is running.",
      permissionName: "ambient-light-sensor",
      needsGesture: false,
      available: () => w<SensorCtor>("AmbientLightSensor") != null,
      run: () => runGenericSensor("AmbientLightSensor"),
    },
    {
      id: "idle-detection",
      label: "Away detection",
      tier: "extended",
      api: "IdleDetector.requestPermission()",
      reaches: "Whether you are actively using the device and whether the screen is locked — even while this tab sits in the background.",
      duration: "Remembered for this site.",
      permissionName: "idle-detection",
      needsGesture: true,
      gestureReason: "The prompt requires transient activation.",
      available: () => w<IdleDetectorCtor>("IdleDetector") != null,
      run: async () => {
        const Detector = w<IdleDetectorCtor>("IdleDetector");
        if (!Detector) return { outcome: "unavailable", detail: "IdleDetector vanished between the probe and the call." };
        const state = await Detector.requestPermission();
        return {
          outcome: state === "granted" ? "granted" : state === "denied" ? "denied" : "dismissed",
          detail: `IdleDetector.requestPermission() returned "${state}". No detector was started.`,
          data: { state },
        };
      },
    },
    {
      id: "push",
      label: "Push messages",
      tier: "extended",
      api: "ServiceWorkerRegistration.pushManager.subscribe()",
      reaches: "The ability to wake the site and message you when it is not open at all.",
      duration: "Until the subscription is revoked.",
      permissionName: "push",
      needsGesture: false,
      available: () => false,
      run: async () => ({
        outcome: "unavailable",
        detail:
          "Not attempted, and this is a limit of this app rather than of your browser: a push subscription requires a registered service worker, and this app deliberately does not register one. Recorded as not attempted so it is never mistaken for a refusal.",
      }),
    },

    /* ---------------- everything ---------------- */
    {
      id: "clipboard-read",
      label: "Read your clipboard",
      tier: "everything",
      api: "navigator.clipboard.read()",
      reaches:
        "Whatever you last copied, anywhere on the device — in any app. That is frequently a password, a verification code, or an address. This app reads only the type and length, never the content.",
      duration: "Chrome asks each time unless you allow it permanently; Safari requires a fresh gesture every single time.",
      permissionName: "clipboard-read",
      needsGesture: true,
      gestureReason: "Both Safari and Chrome require a fresh gesture to read the clipboard — deliberately, because of what it exposes.",
      available: () => typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function",
      run: async () => {
        const items = await navigator.clipboard.read();
        const described: { types: string[]; bytes: number | null }[] = [];
        for (const item of items) {
          let bytes: number | null = null;
          try {
            const blob = await item.getType(item.types[0]);
            bytes = blob.size;
          } catch {
            bytes = null;
          }
          described.push({ types: [...item.types], bytes });
        }
        return {
          outcome: "granted",
          detail: `Your clipboard was readable: ${described.length} item(s), types ${described.flatMap((d) => d.types).join(", ") || "none"}. Only the type and byte length were recorded — the contents were deliberately not read, stored or shown.`,
          data: { items: described, contentDeliberatelyNotRead: true },
        };
      },
    },
    {
      id: "contacts",
      label: "Your contacts",
      tier: "everything",
      api: "navigator.contacts.select(['name','email','tel'])",
      reaches: "The contacts you select — other people's names, numbers, emails and addresses.",
      duration: "One-shot: the site gets a copy of what you pick, with no ongoing access.",
      needsGesture: true,
      gestureReason: "The contact picker requires transient activation.",
      available: () => nav<ContactsManager>("contacts") != null,
      run: async () => {
        const contacts = nav<ContactsManager>("contacts");
        if (!contacts) return { outcome: "unavailable", detail: "navigator.contacts vanished between the probe and the call." };
        const props = await contacts.getProperties();
        const picked = await contacts.select(props.slice(0, 3), { multiple: true });
        if (picked.length === 0) return { outcome: "dismissed", detail: "The picker closed with nothing selected." };
        return {
          outcome: "granted",
          detail: `${picked.length} contact(s) were handed over. Only the count was recorded — no names, numbers or addresses were stored or shown, and nothing was written to the archive.`,
          data: { count: picked.length, availableProperties: props, contentDeliberatelyNotRead: true },
        };
      },
    },
    {
      id: "display-capture",
      label: "Record your screen",
      tier: "everything",
      api: "navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })",
      reaches: "A live video feed of whatever screen, window or tab you select — including anything that appears on it afterwards.",
      duration: "Until you stop sharing. The system shows an indicator throughout.",
      permissionName: "display-capture",
      needsGesture: true,
      gestureReason: "The picker requires transient activation.",
      available: () => typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function",
      run: async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const data = summariseTracks(stream);
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings?.() ?? {};
        stopStream(stream);
        return {
          outcome: "granted",
          detail: `Screen sharing started at ${settings.width ?? "?"}×${settings.height ?? "?"} and was stopped immediately. No frame was captured, kept or written to the archive.`,
          data,
        };
      },
    },
    {
      id: "local-fonts",
      label: "Your installed fonts",
      tier: "everything",
      api: "queryLocalFonts()",
      reaches:
        "The complete list of fonts installed on the device. That list is close to unique per machine and identifies which design, office and creative software you have installed.",
      duration: "Remembered for this site once allowed.",
      permissionName: "local-fonts",
      needsGesture: true,
      gestureReason: "The prompt requires transient activation.",
      available: () => typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === "function",
      run: async () => {
        const query = (globalThis as unknown as { queryLocalFonts: () => Promise<FontData[]> }).queryLocalFonts;
        const fonts = await query();
        const families = Array.from(new Set(fonts.map((f) => f.family)));
        return {
          outcome: "granted",
          detail: `${fonts.length} font faces across ${families.length} families were handed over. The full family list is in the archive — it is a strong fingerprint.`,
          data: { faceCount: fonts.length, familyCount: families.length, families },
        };
      },
    },
    {
      id: "file-access",
      label: "Read a file from storage",
      tier: "everything",
      api: "showOpenFilePicker()",
      reaches: "The file you choose, with its real name, real modification time and original bytes.",
      duration: "One-shot per pick, unless persisted handles are requested.",
      needsGesture: true,
      gestureReason: "The file picker requires transient activation.",
      available: () => typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function",
      run: async () => {
        const picker = (globalThis as unknown as { showOpenFilePicker: (o?: unknown) => Promise<{ getFile: () => Promise<File> }[]> }).showOpenFilePicker;
        const handles = await picker({ multiple: false });
        const handle = handles[0];
        if (!handle) return { outcome: "dismissed", detail: "The picker closed with nothing selected." };
        const file = await handle.getFile();
        return {
          outcome: "granted",
          detail: `"${file.name}" was readable — ${file.size.toLocaleString("en-US")} bytes, last modified ${new Date(file.lastModified).toISOString()}. Only those facts were recorded; the contents were not read into the archive.`,
          data: { name: file.name, size: file.size, type: file.type, lastModified: new Date(file.lastModified).toISOString() },
        };
      },
    },
    {
      id: "window-management",
      label: "Your screen layout",
      tier: "everything",
      api: "getScreenDetails()",
      reaches: "How many displays you have, their sizes, positions, colour depth and which is primary — and the ability to place windows on any of them.",
      duration: "Remembered for this site.",
      permissionName: "window-management",
      needsGesture: true,
      gestureReason: "The prompt requires transient activation.",
      available: () => typeof (globalThis as { getScreenDetails?: unknown }).getScreenDetails === "function",
      run: async () => {
        const get = (globalThis as unknown as { getScreenDetails: () => Promise<{ screens: Record<string, unknown>[] }> }).getScreenDetails;
        const details = await get();
        return {
          outcome: "granted",
          detail: `${details.screens.length} display(s) described in full.`,
          data: { screens: details.screens.map((s) => ({ ...s })) },
        };
      },
    },
    {
      id: "storage-access",
      label: "Cross-site storage access",
      tier: "everything",
      api: "document.requestStorageAccess()",
      reaches: "Access to this site's cookies and storage even when it is embedded inside another site — the mechanism behind cross-site recognition.",
      duration: "Typically 30 days.",
      permissionName: "storage-access",
      needsGesture: true,
      gestureReason: "The prompt requires transient activation.",
      available: () => typeof document !== "undefined" && typeof document.requestStorageAccess === "function",
      run: async () => {
        await document.requestStorageAccess();
        return {
          outcome: "granted",
          detail:
            "Storage access was granted. Note this page is not embedded in another site, so the browser had no reason to refuse — the same call from inside a third-party frame is the one that matters.",
          data: { topLevel: true },
        };
      },
    },
  ];

  return requests;
}

/** Starts a generic sensor briefly to prove it delivers readings, then stops it. */
async function runGenericSensor(name: string): Promise<RequestResult> {
  const Ctor = w<SensorCtor>(name);
  if (!Ctor) return { outcome: "unavailable", detail: `${name} vanished between the probe and the call.` };
  const sensor = new Ctor({ frequency: 10 });
  return new Promise<RequestResult>((resolve) => {
    let settled = false;
    const finish = (result: RequestResult) => {
      if (settled) return;
      settled = true;
      try {
        sensor.stop();
      } catch {
        // already stopped
      }
      resolve(result);
    };
    sensor.addEventListener("reading", () => finish({ outcome: "granted", detail: `${name} started and delivered a reading.`, data: { reading: true } }));
    sensor.addEventListener("error", () =>
      finish({
        outcome: "denied",
        detail: `${name} raised an error on start — on Chrome this is how a blocked sensor surfaces (the permissions policy or the user's choice).`,
      })
    );
    setTimeout(
      () =>
        finish({
          outcome: "error",
          detail: `${name} was started but produced no reading within 3s and raised no error. The API exists; the hardware did not answer.`,
        }),
      3000
    );
    try {
      sensor.start();
    } catch (err) {
      finish(describeError(err));
    }
  });
}

/** Everything in this registry at or below the chosen tier. */
export function requestsForTier(tier: PermissionTier): ProbeRequest[] {
  const limit = TIER_ORDER.indexOf(tier);
  return buildRegistry().filter((r) => TIER_ORDER.indexOf(r.tier) <= limit);
}

/**
 * Runs one request end to end: queries the permission state before and after,
 * fires it, times your response, and never lets an exception escape as
 * anything other than a recorded outcome.
 */
export async function runRequest(request: ProbeRequest): Promise<PermissionRecord> {
  const stateBefore = request.permissionName ? await queryPermission(request.permissionName) : null;
  const askedAt = new Date().toISOString();
  const t0 = performance.now();

  let result: RequestResult;
  if (!request.available()) {
    result = {
      outcome: "unavailable",
      detail: `${request.api} is not implemented in this browser. Nothing was asked, so this is emphatically not a refusal.`,
    };
  } else {
    try {
      result = await request.run();
    } catch (err) {
      result = describeError(err);
    }
  }

  const responseMs = Math.round(performance.now() - t0);
  const stateAfter = request.permissionName ? await queryPermission(request.permissionName) : null;

  return {
    id: request.id,
    label: request.label,
    tier: request.tier,
    api: request.api,
    reaches: request.reaches,
    duration: request.duration,
    outcome: result.outcome,
    detail: result.detail,
    stateBefore,
    stateAfter,
    askedAt,
    responseMs,
    data: result.data,
  };
}

/** A skipped request, recorded as such rather than left out. */
export function skippedRecord(request: ProbeRequest): PermissionRecord {
  return {
    id: request.id,
    label: request.label,
    tier: request.tier,
    api: request.api,
    reaches: request.reaches,
    duration: request.duration,
    outcome: "skipped",
    detail: "You skipped this before it fired. Nothing was asked and no prompt was shown.",
    stateBefore: null,
    stateAfter: null,
    askedAt: new Date().toISOString(),
    responseMs: 0,
    data: undefined,
  };
}
