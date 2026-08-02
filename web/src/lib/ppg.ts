/**
 * Remote photoplethysmography (rPPG): estimates the pulse from micro color
 * changes in facial skin sampled from the camera feed. Real skin shows a
 * coherent periodic cardiac signal; screens, printed photos, and most
 * deepfake pipelines do not.
 *
 * Pipeline (upgraded from single green channel):
 * 1. RGB means of the forehead ROI are sampled every frame.
 * 2. Channels are resampled onto a uniform 30 Hz grid.
 * 3. POS (plane-orthogonal-to-skin, Wang et al. 2017) projects the RGB traces
 *    onto the pulse direction with a sliding 1.6 s window and overlap-add —
 *    far more robust to motion and lighting drift than raw green.
 * 4. Moving-average detrend (high-pass ~0.67 Hz) + short smoothing (low-pass).
 * 5. BPM is estimated TWO independent ways — normalized autocorrelation with
 *    parabolic refinement, and a Goertzel spectral scan over 42–180 BPM — and
 *    "good" quality additionally requires the two estimates to agree and the
 *    spectral peak to stand clear of the noise floor (SNR).
 * 6. Harmonic disambiguation: if autocorrelation locks onto the double period
 *    (half BPM) of a clear spectral peak, the half-lag peak is adopted.
 */

export type PpgSample = { t: number; r: number; g: number; b: number };

export type PulseEstimate = {
  bpm: number | null;
  /** Independent spectral (Goertzel) BPM estimate for cross-validation. */
  bpmSpectral: number | null;
  /** 0..1 normalized autocorrelation peak — how coherent/periodic the signal is. */
  coherence: number;
  /** Spectral peak power over the noise floor (≥2 means a clear cardiac peak). */
  snr: number;
  seconds: number;
  samples: number;
  /** Detrended, normalized recent waveform for display. */
  trace: number[];
  quality: "good" | "weak" | "insufficient";
};

const TARGET_HZ = 30;
const MIN_BPM = 42;
const MAX_BPM = 180;
/** Max disagreement (BPM) between autocorrelation and spectral estimates for "good". */
const AGREE_BPM = 15;
/** Minimum raw signal duration (s) before an estimate is attempted — tuned for the quick 7–9s liveness session. */
const MIN_SECONDS = 5;

/** Resamples one irregular rAF-sampled channel onto a uniform 30 Hz grid. */
function resampleChannel(samples: PpgSample[], pick: (s: PpgSample) => number): number[] {
  if (samples.length < 2) return [];
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const n = Math.floor(((t1 - t0) / 1000) * TARGET_HZ);
  if (n < 8) return [];
  const out = new Array<number>(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i * 1000) / TARGET_HZ;
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const a = samples[j];
    const b = samples[j + 1];
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    const clamped = Math.max(0, Math.min(1, f));
    out[i] = pick(a) + (pick(b) - pick(a)) * clamped;
  }
  return out;
}

/**
 * POS projection (Wang et al. 2017): per sliding window, channels are
 * normalized by their window mean, projected as S1 = Gn − Bn and
 * S2 = Gn + Bn − 2Rn, combined as h = S1 + (σ1/σ2)·S2, mean-centered and
 * overlap-added. Cancels specular/illumination changes that swamp raw green.
 */
function posSignal(r: number[], g: number[], b: number[]): number[] {
  const n = Math.min(r.length, g.length, b.length);
  const win = Math.round(TARGET_HZ * 1.6);
  const h = new Array<number>(n).fill(0);
  if (n < win) return h;
  const s1 = new Array<number>(win);
  const s2 = new Array<number>(win);
  const hw = new Array<number>(win);
  for (let start = 0; start + win <= n; start++) {
    let mr = 0;
    let mg = 0;
    let mb = 0;
    for (let i = start; i < start + win; i++) {
      mr += r[i];
      mg += g[i];
      mb += b[i];
    }
    mr /= win;
    mg /= win;
    mb /= win;
    if (mr < 1e-6 || mg < 1e-6 || mb < 1e-6) continue;
    let m1 = 0;
    let m2 = 0;
    for (let i = 0; i < win; i++) {
      const cr = r[start + i] / mr;
      const cg = g[start + i] / mg;
      const cb = b[start + i] / mb;
      s1[i] = cg - cb;
      s2[i] = cg + cb - 2 * cr;
      m1 += s1[i];
      m2 += s2[i];
    }
    m1 /= win;
    m2 /= win;
    let v1 = 0;
    let v2 = 0;
    for (let i = 0; i < win; i++) {
      v1 += (s1[i] - m1) * (s1[i] - m1);
      v2 += (s2[i] - m2) * (s2[i] - m2);
    }
    const alpha = Math.sqrt(v1 / win) / (Math.sqrt(v2 / win) + 1e-9);
    let hm = 0;
    for (let i = 0; i < win; i++) {
      hw[i] = s1[i] + alpha * s2[i];
      hm += hw[i];
    }
    hm /= win;
    for (let i = 0; i < win; i++) h[start + i] += hw[i] - hm;
  }
  return h;
}

/** Removes slow drift with a moving-average high-pass (~1.5 s window). */
function detrend(signal: number[]): number[] {
  const win = Math.round(TARGET_HZ * 1.5);
  const out = new Array<number>(signal.length);
  let acc = 0;
  const queue: number[] = [];
  for (let i = 0; i < signal.length; i++) {
    queue.push(signal[i]);
    acc += signal[i];
    if (queue.length > win) acc -= queue.shift() as number;
    out[i] = signal[i] - acc / queue.length;
  }
  return out.slice(win);
}

/** 5-tap moving-average low-pass (~6 Hz cutoff) to knock out sensor noise. */
function smooth(signal: number[]): number[] {
  const taps = 5;
  const half = Math.floor(taps / 2);
  const out = new Array<number>(signal.length);
  for (let i = 0; i < signal.length; i++) {
    let acc = 0;
    let cnt = 0;
    for (let k = -half; k <= half; k++) {
      const idx = i + k;
      if (idx >= 0 && idx < signal.length) {
        acc += signal[idx];
        cnt++;
      }
    }
    out[i] = acc / cnt;
  }
  return out;
}

/**
 * Goertzel power scan over the physiological band. Returns the peak BPM and
 * its SNR (peak power vs. the median power of bins ≥6 BPM away).
 */
function spectralPeak(s: number[]): { bpm: number | null; snr: number } {
  const n = s.length;
  if (n < TARGET_HZ * 3.5) return { bpm: null, snr: 0 };
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) w[i] = s[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  const powers: { bpm: number; p: number }[] = [];
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm++) {
    const omega = (2 * Math.PI * (bpm / 60)) / TARGET_HZ;
    const coeff = 2 * Math.cos(omega);
    let q1 = 0;
    let q2 = 0;
    for (let i = 0; i < n; i++) {
      const q0 = w[i] + coeff * q1 - q2;
      q2 = q1;
      q1 = q0;
    }
    powers.push({ bpm, p: q1 * q1 + q2 * q2 - coeff * q1 * q2 });
  }
  let peak = powers[0];
  for (const c of powers) if (c.p > peak.p) peak = c;
  const noise = powers.filter((c) => Math.abs(c.bpm - peak.bpm) >= 6).map((c) => c.p).sort((a, b) => a - b);
  const median = noise.length > 0 ? noise[Math.floor(noise.length / 2)] : 0;
  const snr = median > 1e-12 ? peak.p / median : 0;
  return { bpm: peak.bpm, snr: Math.round(snr * 10) / 10 };
}

/** Estimates BPM + coherence + spectral cross-check from RGB ROI samples. Needs ≥5 s (collected across the whole session). */
export function estimatePulse(samples: PpgSample[]): PulseEstimate {
  const seconds = samples.length >= 2 ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 0;
  const r = resampleChannel(samples, (s) => s.r);
  const g = resampleChannel(samples, (s) => s.g);
  const b = resampleChannel(samples, (s) => s.b);
  const pos = posSignal(r, g, b);
  const clean = smooth(detrend(pos));
  const base: Omit<PulseEstimate, "bpm" | "bpmSpectral" | "coherence" | "snr" | "quality"> = {
    seconds: Math.round(seconds * 10) / 10,
    samples: samples.length,
    trace: clean.slice(-Math.min(clean.length, TARGET_HZ * 8)),
  };
  if (seconds < MIN_SECONDS || clean.length < TARGET_HZ * 3.5) {
    return { ...base, bpm: null, bpmSpectral: null, coherence: 0, snr: 0, quality: "insufficient" };
  }

  const mean = clean.reduce((a, v) => a + v, 0) / clean.length;
  const s = clean.map((v) => v - mean);
  let denom = 0;
  for (const v of s) denom += v * v;
  denom += 1e-9;

  const ac = (lag: number): number => {
    let acc = 0;
    for (let i = 0; i + lag < s.length; i++) acc += s[i] * s[i + lag];
    return acc / denom;
  };

  const minLag = Math.floor((60 / MAX_BPM) * TARGET_HZ);
  const maxLag = Math.ceil((60 / MIN_BPM) * TARGET_HZ);
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= Math.min(maxLag, s.length - 4); lag++) {
    const norm = ac(lag);
    if (norm > best) {
      best = norm;
      bestLag = lag;
    }
  }
  const spectral = spectralPeak(s);
  if (bestLag === 0) {
    return { ...base, bpm: null, bpmSpectral: spectral.bpm, coherence: 0, snr: spectral.snr, quality: "weak" };
  }

  // Harmonic disambiguation: autocorrelation sometimes locks onto the double
  // period (half BPM). If a clear spectral peak sits near the half-lag BPM and
  // the half-lag autocorrelation is nearly as strong, adopt it.
  if (spectral.bpm != null) {
    const bpmAtBest = (60 * TARGET_HZ) / bestLag;
    const halfLag = Math.round(bestLag / 2);
    if (halfLag >= minLag && Math.abs(bpmAtBest * 2 - spectral.bpm) <= AGREE_BPM && Math.abs(bpmAtBest - spectral.bpm) > AGREE_BPM) {
      const halfVal = ac(halfLag);
      if (halfVal >= best * 0.6) {
        bestLag = halfLag;
        best = halfVal;
      }
    }
  }

  // Parabolic refinement around the peak lag for sub-sample BPM precision.
  const y0 = ac(Math.max(minLag, bestLag - 1));
  const y1 = ac(bestLag);
  const y2 = ac(bestLag + 1);
  const curvature = y0 - 2 * y1 + y2;
  const offset = curvature !== 0 ? (0.5 * (y0 - y2)) / curvature : 0;
  const refinedLag = bestLag + Math.max(-0.5, Math.min(0.5, offset));
  const bpm = Math.round((60 * TARGET_HZ) / refinedLag);
  const coherence = Math.round(Math.max(0, Math.min(1, y1)) * 100) / 100;

  const agree = spectral.bpm != null && Math.abs(bpm - spectral.bpm) <= AGREE_BPM;
  // Recalibrated for short windows: the two-estimator agreement requirement is
  // what actually rejects screens/prints — coherence and SNR floors are set so
  // a genuine ~6s well-lit signal can reach "good" instead of stalling at
  // "weak" forever (the old 8s+ gates made real pulses read as missing).
  const quality: PulseEstimate["quality"] =
    coherence >= 0.25 && spectral.snr >= 1.8 && agree && bpm >= MIN_BPM && bpm <= MAX_BPM ? "good" : "weak";
  return { ...base, bpm, bpmSpectral: spectral.bpm, coherence, snr: spectral.snr, quality };
}

/** Compact pulse fingerprint stored across silent clips and the liveness leg. */
export type PulseFingerprint = {
  source: string;
  bpm: number | null;
  bpmSpectral: number | null;
  coherence: number;
  snr: number;
  quality: PulseEstimate["quality"];
  seconds: number;
  samples: number;
};

export function pulseFingerprint(source: string, est: PulseEstimate): PulseFingerprint {
  return {
    source,
    bpm: est.bpm,
    bpmSpectral: est.bpmSpectral,
    coherence: est.coherence,
    snr: est.snr,
    quality: est.quality,
    seconds: est.seconds,
    samples: est.samples,
  };
}

export type PulseContinuityResult = {
  /** REVIEW-grade mismatch between independent live legs. */
  mismatch: boolean;
  /** Both sides had a usable estimate to compare. */
  comparable: boolean;
  deltaBpm: number | null;
  detail: string;
  silent: PulseFingerprint | null;
  live: PulseFingerprint | null;
};

/**
 * Cross-feed pulse continuity: when a silent front-camera leg AND the liveness
 * leg both produce a usable BPM, they must agree within a physiological band.
 * Independently pre-staged deepfake clips (or a different person mid-flow)
 * rarely share the same cardiac rate. Short silent windows often cannot
 * estimate BPM — that is inconclusive, never an accusation.
 */
export function comparePulseContinuity(
  silent: PulseFingerprint | null | undefined,
  live: PulseFingerprint | null | undefined
): PulseContinuityResult {
  if (!silent || !live) {
    return {
      mismatch: false,
      comparable: false,
      deltaBpm: null,
      detail: "Pulse continuity not comparable — one or both legs lack a pulse fingerprint (faceless silent clips are normal).",
      silent: silent ?? null,
      live: live ?? null,
    };
  }
  const silentUsable =
    silent.bpm != null && silent.bpm >= MIN_BPM && silent.bpm <= MAX_BPM && (silent.quality === "good" || silent.quality === "weak") && silent.coherence >= 0.18;
  const liveUsable =
    live.bpm != null && live.bpm >= MIN_BPM && live.bpm <= MAX_BPM && (live.quality === "good" || (live.quality === "weak" && live.coherence >= 0.22));
  if (!silentUsable || !liveUsable || silent.bpm == null || live.bpm == null) {
    return {
      mismatch: false,
      comparable: false,
      deltaBpm: null,
      detail: `Pulse continuity inconclusive — silent ${silent.bpm ?? "—"} BPM (${silent.quality}, coh ${silent.coherence}) · live ${live.bpm ?? "—"} BPM (${live.quality}, coh ${live.coherence}). Short silent windows often cannot lock a rate.`,
      silent,
      live,
    };
  }
  const delta = Math.abs(silent.bpm - live.bpm);
  // Same person across a few minutes: allow generous drift (posture, stress).
  // >25 BPM between two good locks on the same session is REVIEW-worthy.
  const mismatch = delta > 25 && silent.quality === "good" && live.quality === "good";
  return {
    mismatch,
    comparable: true,
    deltaBpm: Math.round(delta * 10) / 10,
    detail: mismatch
      ? `Cross-feed pulse mismatch: silent leg ${silent.bpm} BPM vs liveness ${live.bpm} BPM (Δ ${Math.round(delta)}). Two good independent locks this far apart suggest different source media or a different person mid-flow — REVIEW corroboration only, never a standalone fail.`
      : `Cross-feed pulse continuous: silent ${silent.bpm} BPM ≈ liveness ${live.bpm} BPM (Δ ${Math.round(delta)}). Consistent with one live person across the session.`,
    silent,
    live,
  };
}

/** Averages R, G, B of a face ROI (forehead band) from a video frame. */
export function sampleForeheadRgb(
  video: HTMLVideoElement,
  faceBox: { x: number; y: number; width: number; height: number } | null,
  scratch: HTMLCanvasElement
): { r: number; g: number; b: number } | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const box = faceBox ?? {
    x: video.videoWidth * 0.3,
    y: video.videoHeight * 0.2,
    width: video.videoWidth * 0.4,
    height: video.videoHeight * 0.5,
  };
  const roiX = box.x + box.width * 0.28;
  const roiW = box.width * 0.44;
  const roiY = box.y + box.height * 0.06;
  const roiH = box.height * 0.18;
  const size = 24;
  scratch.width = size;
  scratch.height = size;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, size, size);
  } catch {
    return null;
  }
  const data = ctx.getImageData(0, 0, size, size).data;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  const px = size * size;
  return { r: r / px, g: g / px, b: b / px };
}
