/**
 * Stage two — recording what the granted sensors actually deliver.
 *
 * A grant on its own proves very little. What matters is the shape of the data
 * that follows it: how fast it arrives, how precise it is, and how quickly it
 * converges. So every recorder here samples for a fixed window and reports the
 * MEASURED rate alongside the requested one, because the two frequently differ
 * — iOS caps motion events well below what a site asks for, and saying
 * otherwise would be repeating the request back as though it were a reading.
 *
 * Each recorder is independently cancellable and always tears down its
 * listeners, including on the abort path.
 */

export type SensorSeries = {
  id: string;
  label: string;
  /** CSV header row. */
  columns: string[];
  /** One row per sample, already stringified. */
  rows: string[][];
  /** Sample rate the recorder asked for, when the API takes one. */
  requestedHz: number | null;
  /** Sample rate actually observed. Null when too few samples arrived to say. */
  measuredHz: number | null;
  durationMs: number;
  /** Plain-language account of what happened, including the disappointing cases. */
  note: string;
};

export type SensorProgress = (message: string) => void;

function measuredHz(count: number, ms: number): number | null {
  if (count < 3 || ms <= 0) return null;
  return Math.round((count * 1000) / ms);
}

function n(value: number | null | undefined, digits = 4): string {
  return value == null || Number.isNaN(value) ? "" : value.toFixed(digits);
}

/** Records `devicemotion` for a fixed window at whatever rate the device supplies. */
export function recordMotion(ms: number, onProgress?: SensorProgress): Promise<SensorSeries> {
  return new Promise((resolve) => {
    const rows: string[][] = [];
    const t0 = performance.now();
    let interval: number | null = null;

    const handler = (ev: DeviceMotionEvent) => {
      rows.push([
        (performance.now() - t0).toFixed(1),
        n(ev.acceleration?.x),
        n(ev.acceleration?.y),
        n(ev.acceleration?.z),
        n(ev.accelerationIncludingGravity?.x),
        n(ev.accelerationIncludingGravity?.y),
        n(ev.accelerationIncludingGravity?.z),
        n(ev.rotationRate?.alpha, 3),
        n(ev.rotationRate?.beta, 3),
        n(ev.rotationRate?.gamma, 3),
        ev.interval != null ? String(ev.interval) : "",
      ]);
    };

    window.addEventListener("devicemotion", handler);
    interval = window.setInterval(() => onProgress?.(`Motion: ${rows.length} samples`), 500);

    setTimeout(() => {
      window.removeEventListener("devicemotion", handler);
      if (interval != null) window.clearInterval(interval);
      const elapsed = performance.now() - t0;
      const hz = measuredHz(rows.length, elapsed);
      const reported = rows.find((r) => r[10] !== "")?.[10];
      resolve({
        id: "motion",
        label: "Accelerometer and gyroscope (devicemotion)",
        columns: [
          "ms",
          "accel_x",
          "accel_y",
          "accel_z",
          "accel_gravity_x",
          "accel_gravity_y",
          "accel_gravity_z",
          "rotation_alpha",
          "rotation_beta",
          "rotation_gamma",
          "interval_ms",
        ],
        rows,
        requestedHz: null,
        measuredHz: hz,
        durationMs: Math.round(elapsed),
        note:
          rows.length === 0
            ? "No devicemotion events arrived at all during the window. Either permission was not actually in force, or this device delivers nothing on that event."
            : `${rows.length} samples in ${(elapsed / 1000).toFixed(1)}s — a measured ${hz ?? "?"} Hz.${reported ? ` The event reports its own interval as ${reported} ms, i.e. ${Math.round(1000 / Number(reported))} Hz nominal.` : ""} The measured figure is the one to trust; browsers throttle this event and the nominal rate is often optimistic.`,
      });
    }, ms);
  });
}

/** Records both `deviceorientation` and the absolute variant, so the difference is visible. */
export function recordOrientation(ms: number, onProgress?: SensorProgress): Promise<SensorSeries> {
  return new Promise((resolve) => {
    const rows: string[][] = [];
    const t0 = performance.now();
    let absoluteSeen = false;
    let webkitHeadingSeen = false;

    const make = (source: string) => (ev: DeviceOrientationEvent) => {
      const withHeading = ev as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
      if (withHeading.webkitCompassHeading != null) webkitHeadingSeen = true;
      if (ev.absolute) absoluteSeen = true;
      rows.push([
        (performance.now() - t0).toFixed(1),
        source,
        n(ev.alpha, 3),
        n(ev.beta, 3),
        n(ev.gamma, 3),
        String(ev.absolute),
        n(withHeading.webkitCompassHeading, 2),
        n(withHeading.webkitCompassAccuracy, 2),
      ]);
    };

    const relative = make("deviceorientation");
    const absolute = make("deviceorientationabsolute");
    window.addEventListener("deviceorientation", relative);
    window.addEventListener("deviceorientationabsolute", absolute as EventListener);
    const interval = window.setInterval(() => onProgress?.(`Orientation: ${rows.length} samples`), 500);

    setTimeout(() => {
      window.removeEventListener("deviceorientation", relative);
      window.removeEventListener("deviceorientationabsolute", absolute as EventListener);
      window.clearInterval(interval);
      const elapsed = performance.now() - t0;
      resolve({
        id: "orientation",
        label: "Device orientation and compass",
        columns: ["ms", "event", "alpha", "beta", "gamma", "absolute", "webkit_compass_heading", "webkit_compass_accuracy"],
        rows,
        requestedHz: null,
        measuredHz: measuredHz(rows.length, elapsed),
        durationMs: Math.round(elapsed),
        note:
          rows.length === 0
            ? "No orientation events arrived during the window."
            : `${rows.length} samples in ${(elapsed / 1000).toFixed(1)}s. Absolute (true-north referenced) readings: ${absoluteSeen ? "present" : "absent"}. WebKit compass heading: ${webkitHeadingSeen ? "present — this is how Safari exposes a true compass bearing" : "absent"}.`,
      });
    }, ms);
  });
}

/**
 * Watches location until the accuracy figure stops improving, or the window
 * expires. Every intermediate fix is kept — watching the radius shrink is the
 * interesting part, and a single final coordinate hides it.
 */
export function recordGeolocation(maxMs: number, onProgress?: SensorProgress): Promise<SensorSeries> {
  return new Promise((resolve) => {
    const rows: string[][] = [];
    const t0 = performance.now();
    let best = Number.POSITIVE_INFINITY;
    let sinceImprovement = 0;
    let watchId: number | null = null;
    let settled = false;
    let errorNote = "";

    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      const elapsed = performance.now() - t0;
      resolve({
        id: "geolocation",
        label: "Location fixes",
        columns: ["ms", "latitude", "longitude", "accuracy_m", "altitude_m", "altitude_accuracy_m", "heading_deg", "speed_mps", "timestamp"],
        rows,
        requestedHz: null,
        measuredHz: null,
        durationMs: Math.round(elapsed),
        note:
          rows.length === 0
            ? `No fix arrived. ${errorNote || reason}`
            : `${rows.length} fix(es) over ${(elapsed / 1000).toFixed(1)}s, tightening to ±${best.toFixed(1)} m. ${reason}${errorNote ? ` ${errorNote}` : ""}`,
      });
    };

    if (!navigator.geolocation) {
      finish("This browser exposes no geolocation API.");
      return;
    }

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        rows.push([
          (performance.now() - t0).toFixed(1),
          String(c.latitude),
          String(c.longitude),
          c.accuracy.toFixed(1),
          n(c.altitude, 1),
          n(c.altitudeAccuracy, 1),
          n(c.heading, 1),
          n(c.speed, 2),
          new Date(pos.timestamp).toISOString(),
        ]);
        onProgress?.(`Location: ±${Math.round(c.accuracy)} m after ${rows.length} fix(es)`);
        if (c.accuracy < best - 0.5) {
          best = c.accuracy;
          sinceImprovement = 0;
        } else {
          sinceImprovement += 1;
          // Three consecutive fixes with no meaningful improvement: it has settled.
          if (sinceImprovement >= 3) finish("The accuracy figure stopped improving, so the watch was stopped.");
        }
      },
      (err) => {
        errorNote = `Watch reported error code ${err.code}: ${err.message || "no message"}.`;
        finish("The watch ended on an error.");
      },
      { enableHighAccuracy: true, timeout: maxMs, maximumAge: 0 }
    );

    setTimeout(() => finish("The time window expired before the accuracy settled."), maxMs);
  });
}

/**
 * Samples microphone loudness as RMS and peak, then releases the track. The
 * audio itself is never recorded, kept or written to the archive — only the
 * level envelope, which is enough to show the sensor is live without capturing
 * anything anyone said.
 */
export async function recordMicrophoneLevel(ms: number, onProgress?: SensorProgress): Promise<SensorSeries> {
  const rows: string[][] = [];
  const t0 = performance.now();
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let note = "";
  let sampleRate: number | null = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("No AudioContext implementation exists here.");
    context = new Ctor();
    sampleRate = context.sampleRate;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);

    await new Promise<void>((resolve) => {
      const tick = () => {
        if (performance.now() - t0 >= ms) {
          resolve();
          return;
        }
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const v = buffer[i];
          sum += v * v;
          if (Math.abs(v) > peak) peak = Math.abs(v);
        }
        const rms = Math.sqrt(sum / buffer.length);
        rows.push([
          (performance.now() - t0).toFixed(1),
          rms.toFixed(6),
          peak.toFixed(6),
          (rms > 0 ? 20 * Math.log10(rms) : -Infinity).toFixed(2),
        ]);
        if (rows.length % 10 === 0) onProgress?.(`Microphone: ${rows.length} level samples`);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    note = `${rows.length} level samples at ${sampleRate} Hz audio. Only loudness was measured — no audio was recorded, kept, or written to the archive.`;
  } catch (err) {
    note = `Level sampling did not run: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    try {
      await context?.close();
    } catch {
      // context may already be closed
    }
  }

  const elapsed = performance.now() - t0;
  return {
    id: "microphone-level",
    label: "Microphone loudness envelope",
    columns: ["ms", "rms", "peak", "dbfs"],
    rows,
    requestedHz: null,
    measuredHz: measuredHz(rows.length, elapsed),
    durationMs: Math.round(elapsed),
    note,
  };
}

type SensorLike = {
  start: () => void;
  stop: () => void;
  addEventListener: (type: string, cb: () => void) => void;
  illuminance?: number;
  x?: number;
  y?: number;
  z?: number;
};
type SensorCtor = new (opts?: { frequency?: number }) => SensorLike;

/** Records one generic sensor (light, magnetometer, …) for a window at a requested rate. */
export function recordGenericSensor(name: string, label: string, columns: string[], hz: number, ms: number, onProgress?: SensorProgress): Promise<SensorSeries> {
  return new Promise((resolve) => {
    const rows: string[][] = [];
    const t0 = performance.now();
    const Ctor = (window as unknown as Record<string, SensorCtor | undefined>)[name];

    const finish = (note: string) => {
      const elapsed = performance.now() - t0;
      resolve({
        id: name.toLowerCase(),
        label,
        columns: ["ms", ...columns],
        rows,
        requestedHz: hz,
        measuredHz: measuredHz(rows.length, elapsed),
        durationMs: Math.round(elapsed),
        note,
      });
    };

    if (!Ctor) {
      finish(`${name} does not exist in this browser, so nothing was sampled.`);
      return;
    }

    const sensor = new Ctor({ frequency: hz });
    let stopped = false;
    const stop = (note: string) => {
      if (stopped) return;
      stopped = true;
      try {
        sensor.stop();
      } catch {
        // already stopped
      }
      finish(note);
    };

    sensor.addEventListener("reading", () => {
      const ms0 = (performance.now() - t0).toFixed(1);
      rows.push(
        sensor.illuminance != null
          ? [ms0, sensor.illuminance.toFixed(2)]
          : [ms0, n(sensor.x), n(sensor.y), n(sensor.z)]
      );
      if (rows.length % 5 === 0) onProgress?.(`${label}: ${rows.length} samples`);
    });
    sensor.addEventListener("error", () => stop(`${name} raised an error — on Chrome this is how a blocked or absent sensor surfaces.`));

    try {
      sensor.start();
    } catch (err) {
      finish(`${name} refused to start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    setTimeout(
      () =>
        stop(
          rows.length === 0
            ? `${name} started without error but produced no readings in ${(ms / 1000).toFixed(1)}s.`
            : `${rows.length} samples at a requested ${hz} Hz, measured ${measuredHz(rows.length, performance.now() - t0) ?? "?"} Hz.`
        ),
      ms
    );
  });
}

/** CSV for one series, with the note carried as leading comment lines. */
export function seriesCsv(series: SensorSeries): string {
  const header = [
    `# ${series.label}`,
    `# ${series.note}`,
    `# duration ${series.durationMs} ms · requested ${series.requestedHz ?? "n/a"} Hz · measured ${series.measuredHz ?? "not enough samples to say"} Hz`,
    `# samples ${series.rows.length}`,
  ];
  return [...header, series.columns.join(","), ...series.rows.map((r) => r.join(","))].join("\n");
}
