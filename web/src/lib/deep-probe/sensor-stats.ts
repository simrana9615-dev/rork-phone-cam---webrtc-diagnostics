/**
 * What a recorded series says about the hardware that produced it.
 *
 * The recorders in `sensors.ts` were careful to keep every reading at full
 * precision and then never looked at them again: each series reported how many
 * samples arrived and how fast, and nothing else. Three of the four strongest
 * traits in a motion trace were sitting in the rows unmeasured.
 *
 *   • THE QUANTISATION STEP. An accelerometer is an analogue-to-digital
 *     converter with a fixed number of bits, so its output is not continuous —
 *     it moves in a smallest step, and that step is a property of the part
 *     rather than of the movement. Synthetic data is almost always continuous
 *     where real data is not, which makes this both a device fingerprint and
 *     the cheapest sanity check on a trace there is.
 *
 *   • THE REPEATS. Several platforms deliver an event on a timer and simply
 *     re-send the last reading when the sensor has not produced a new one. A
 *     rate counted from events is then the TIMER's rate, not the sensor's, and
 *     reporting it alone overstates the hardware by whatever the ratio is.
 *
 *   • THE REGULARITY. How evenly the samples arrive separates a hardware
 *     interrupt from a JavaScript timer far more clearly than how many arrive.
 *     A metronome and a jittery queue can share a mean rate and share nothing
 *     else.
 *
 *   • THE GRAVITY CONSTANT. `accelerationIncludingGravity` minus `acceleration`
 *     is the gravity vector the firmware subtracted, and its magnitude is the
 *     constant that firmware was built with. 9.81, 9.80665 and a plain 9.8 are
 *     three different vendors' choices, and the device states which it uses
 *     without being asked.
 *
 * Everything here is a pure function over the rows a recorder already produced,
 * so it is testable without a device, and every figure is withheld rather than
 * guessed when the sample cannot support it.
 */

/** How a column of readings behaves. */
export type ColumnStats = {
  column: string;
  /** How many rows carried a finite number in this column. */
  samples: number;
  /** Distinct values seen. */
  distinct: number;
  min: number | null;
  max: number | null;
  /**
   * Smallest non-zero difference between two distinct readings. On real
   * hardware this is the converter's step. Null when there are too few distinct
   * readings for the figure to mean anything.
   */
  step: number | null;
  /** Most decimal places any single reading was written with. A formatting trait of the platform. */
  decimals: number;
};

/** How the samples arrived, as opposed to what they contained. */
export type DeliveryStats = {
  samples: number;
  /** Events per second, counting every event. */
  deliveredHz: number | null;
  /**
   * Events per second whose payload actually differed from the one before.
   * Equal to `deliveredHz` on a device that never repeats; below it on one that
   * delivers on a timer.
   */
  distinctHz: number | null;
  /** Rows that repeated the previous row's payload exactly. */
  repeats: number;
  /** Median gap between consecutive events, in milliseconds. */
  medianGapMs: number | null;
  /**
   * Spread of those gaps as a fraction of the median. 0 is a metronome; a large
   * figure is a queue competing with everything else on the main thread.
   */
  jitter: number | null;
  reading: string;
};

/** The constant the firmware subtracts for gravity, when the trace exposes it. */
export type GravityStats = {
  /** Magnitude of (accelerationIncludingGravity − acceleration), averaged. */
  magnitude: number;
  /** How many rows carried both vectors, so the subtraction could be done. */
  samples: number;
  /** Spread of the per-row magnitudes. A still phone gives a very tight one. */
  spread: number;
  reading: string;
};

export type SeriesStats = {
  delivery: DeliveryStats;
  columns: ColumnStats[];
  /** Only motion traces can produce this. Null everywhere else. */
  gravity: GravityStats | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Decimal places in the string a platform actually wrote, not in our reformatting of it. */
function decimalsOf(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const exponent = /e-(\d+)$/i.exec(trimmed);
  const dot = trimmed.indexOf(".");
  const written = dot === -1 ? 0 : trimmed.length - dot - 1 - (exponent ? exponent[0].length : 0);
  return Math.max(0, written) + (exponent ? Number(exponent[1]) : 0);
}

/**
 * Smallest step observed between distinct readings of one column.
 *
 * On a real sensor this exposes the quantisation of the underlying converter,
 * which is a hardware trait and one of the harder things to fake convincingly —
 * synthetic data is usually continuous where a real accelerometer is not.
 *
 * Reported as an estimate from the samples in hand, and withheld entirely when
 * there are too few of them to mean anything. The result is rounded to six
 * significant figures because the subtraction that produced it is floating
 * point, and reporting its last few bits would be reporting IEEE 754 rather
 * than the device.
 */
export function quantisationStep(values: number[]): number | null {
  const distinct = Array.from(new Set(values.filter((v) => Number.isFinite(v)))).sort((a, b) => a - b);
  if (distinct.length < 4) return null;
  let smallest = Infinity;
  for (let i = 1; i < distinct.length; i += 1) {
    const delta = distinct[i] - distinct[i - 1];
    if (delta > 0 && delta < smallest) smallest = delta;
  }
  return Number.isFinite(smallest) ? Number(smallest.toPrecision(6)) : null;
}

/** Everything one column of a series has to say. */
export function columnStats(column: string, cells: string[]): ColumnStats {
  const values: number[] = [];
  let decimals = 0;
  for (const cell of cells) {
    const parsed = Number.parseFloat(cell);
    if (Number.isFinite(parsed)) {
      values.push(parsed);
      decimals = Math.max(decimals, decimalsOf(cell));
    }
  }
  return {
    column,
    samples: values.length,
    distinct: new Set(values).size,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    step: quantisationStep(values),
    decimals,
  };
}

function deliveryReading(stats: Omit<DeliveryStats, "reading">): string {
  if (stats.samples < 3) {
    return "Too few events arrived to say anything about how they were delivered. No rate has been estimated from them.";
  }
  const parts: string[] = [];
  if (stats.repeats > 0 && stats.distinctHz != null && stats.deliveredHz != null) {
    parts.push(
      `${stats.repeats} of ${stats.samples} events repeated the previous reading exactly. That means this device delivers on a timer and re-sends the ` +
        `last value when the sensor has not moved on, so the honest hardware update rate is ${stats.distinctHz} Hz and the ${stats.deliveredHz} Hz above is the ` +
        `delivery rate. Quoting the delivery rate alone would overstate the sensor by ${(stats.deliveredHz / Math.max(stats.distinctHz, 1)).toFixed(1)}×.`
    );
  } else {
    parts.push("No event repeated the one before it, so the delivery rate and the sensor's own update rate are the same figure here.");
  }
  if (stats.jitter != null && stats.medianGapMs != null) {
    parts.push(
      stats.jitter < 0.1
        ? `The gaps between events are very even (median ${stats.medianGapMs} ms, spread ${stats.jitter}), which is what a hardware-paced source looks like.`
        : stats.jitter < 0.5
          ? `The gaps between events are somewhat uneven (median ${stats.medianGapMs} ms, spread ${stats.jitter}) — a paced source competing with other work on the page.`
          : `The gaps between events are very uneven (median ${stats.medianGapMs} ms, spread ${stats.jitter}), which is a queue rather than a clock. The mean rate above hides that.`
    );
  }
  return parts.join(" ");
}

/**
 * How the events arrived and how many of them carried anything new.
 *
 * `timestamps` and `payloads` come from the same rows in the same order. A row
 * counts as a repeat only when every one of its non-time cells matches the row
 * before it — a partial match is a new reading, not a repeated one.
 */
export function deliveryStats(timestamps: number[], payloads: string[][], durationMs: number): DeliveryStats {
  const samples = timestamps.length;
  let repeats = 0;
  for (let i = 1; i < payloads.length; i += 1) {
    const previous = payloads[i - 1];
    const current = payloads[i];
    if (current.length === previous.length && current.every((cell, at) => cell === previous[at])) repeats += 1;
  }
  const distinctCount = samples - repeats;
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
  }
  const medianGap = median(gaps);
  let jitter: number | null = null;
  if (medianGap != null && medianGap > 0 && gaps.length >= 3) {
    const deviations = gaps.map((gap) => Math.abs(gap - medianGap));
    const spread = median(deviations);
    jitter = spread != null ? round(spread / medianGap, 3) : null;
  }
  const base: Omit<DeliveryStats, "reading"> = {
    samples,
    deliveredHz: samples >= 3 && durationMs > 0 ? Math.round((samples * 1000) / durationMs) : null,
    distinctHz: samples >= 3 && durationMs > 0 ? Math.round((distinctCount * 1000) / durationMs) : null,
    repeats,
    medianGapMs: medianGap != null ? round(medianGap, 2) : null,
    jitter,
  };
  return { ...base, reading: deliveryReading(base) };
}

/**
 * The gravity constant this firmware was built with.
 *
 * Subtracting the linear acceleration from the one that includes gravity leaves
 * the gravity vector the platform itself computed. Its magnitude does not
 * depend on how the phone is being held, which is what makes it readable at all
 * — but it does depend on the platform having produced both vectors, and iOS
 * and Android disagree about when they will.
 *
 * A wide spread means the phone was moving during the window and the two
 * vectors were sampled from different instants, so the figure is reported with
 * its spread rather than on its own.
 */
export function gravityStats(withGravity: [number, number, number][], linear: [number, number, number][]): GravityStats | null {
  const magnitudes: number[] = [];
  const count = Math.min(withGravity.length, linear.length);
  for (let i = 0; i < count; i += 1) {
    const [gx, gy, gz] = withGravity[i];
    const [lx, ly, lz] = linear[i];
    if (![gx, gy, gz, lx, ly, lz].every((v) => Number.isFinite(v))) continue;
    const dx = gx - lx;
    const dy = gy - ly;
    const dz = gz - lz;
    magnitudes.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  if (magnitudes.length < 4) return null;
  const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
  if (!Number.isFinite(mean) || mean <= 0) return null;
  const variance = magnitudes.reduce((a, b) => a + (b - mean) ** 2, 0) / magnitudes.length;
  const spread = Math.sqrt(variance);
  const magnitude = round(mean, 5);
  const tight = spread < 0.02;
  return {
    magnitude,
    samples: magnitudes.length,
    spread: round(spread, 5),
    reading:
      `Subtracting the linear acceleration from the one that includes gravity leaves the gravity vector this platform computed, and its magnitude is ${magnitude} m/s² ` +
      `across ${magnitudes.length} samples (spread ${round(spread, 5)}). ` +
      (tight
        ? "The spread is tight enough that this is the constant the firmware was built with rather than an artefact of movement — 9.81, 9.80665 and a plain 9.8 are three different vendors' choices and a device states which it uses without being asked."
        : "The spread is wide, which means the phone was moving while the window ran and the two vectors were not always sampled from the same instant. The figure is reported with its spread rather than as a clean constant."),
  };
}

/**
 * Whether a column holds a clock reading rather than a sensor reading.
 *
 * `interval_ms` deliberately does NOT match: the interval a motion event
 * reports about itself is a device fact worth keeping, not a timestamp.
 */
function isTimeColumn(name: string): boolean {
  return /^(ms|t)(_|$)/i.test(name) || /^time/i.test(name);
}

/**
 * Everything a recorded series has to say about its own hardware.
 *
 * The first column is assumed to be the elapsed time in milliseconds, which is
 * true of every recorder in this app. Columns whose name marks them as time are
 * excluded from the per-column statistics, because the step between two clock
 * readings is a fact about the clock and is already reported as jitter.
 */
export function analyseSeries(columns: string[], rows: string[][], durationMs: number): SeriesStats {
  const timeIndex = columns.findIndex((column) => isTimeColumn(column));
  const timestamps = rows.map((row) => Number.parseFloat(row[timeIndex >= 0 ? timeIndex : 0] ?? "")).filter((v) => Number.isFinite(v));
  const payloadIndices = columns.map((_, index) => index).filter((index) => index !== timeIndex);
  const payloads = rows.map((row) => payloadIndices.map((index) => row[index] ?? ""));

  const stats: ColumnStats[] = [];
  for (const index of payloadIndices) {
    const column = columns[index];
    if (/^(event|source|absolute)$/i.test(column) || isTimeColumn(column)) continue;
    const cells = rows.map((row) => row[index] ?? "");
    const analysed = columnStats(column, cells);
    if (analysed.samples === 0) continue;
    stats.push(analysed);
  }

  const at = (name: string): number => columns.indexOf(name);
  const gx = at("accel_gravity_x");
  const lx = at("accel_x");
  let gravity: GravityStats | null = null;
  if (gx >= 0 && lx >= 0) {
    const withGravity: [number, number, number][] = [];
    const linear: [number, number, number][] = [];
    for (const row of rows) {
      const g: [number, number, number] = [Number.parseFloat(row[gx]), Number.parseFloat(row[gx + 1]), Number.parseFloat(row[gx + 2])];
      const l: [number, number, number] = [Number.parseFloat(row[lx]), Number.parseFloat(row[lx + 1]), Number.parseFloat(row[lx + 2])];
      if ([...g, ...l].every((v) => Number.isFinite(v))) {
        withGravity.push(g);
        linear.push(l);
      }
    }
    gravity = gravityStats(withGravity, linear);
  }

  return { delivery: deliveryStats(timestamps, payloads, durationMs), columns: stats, gravity };
}

/** The readable block for one series, used by the sheets and by the CSV header. */
export function statsText(stats: SeriesStats): string[] {
  const lines: string[] = [];
  const d = stats.delivery;
  lines.push(
    `   delivered   ${d.deliveredHz != null ? `${d.deliveredHz} Hz` : "too few samples to state a rate"}`,
    `   distinct    ${d.distinctHz != null ? `${d.distinctHz} Hz (${d.repeats} of ${d.samples} events repeated the one before)` : "not measurable from this sample"}`,
    `   gap         ${d.medianGapMs != null ? `${d.medianGapMs} ms median` : "not measurable"}${d.jitter != null ? `, spread ${d.jitter}` : ""}`,
    `   ${d.reading}`
  );
  if (stats.columns.length > 0) {
    lines.push("   per column:");
    for (const column of stats.columns) {
      lines.push(
        `     ${column.column.padEnd(20)} ${column.distinct} distinct of ${column.samples} · ` +
          `step ${column.step != null ? column.step : "not determinable from this sample"} · ` +
          `written to ${column.decimals} decimal${column.decimals === 1 ? "" : "s"} · ` +
          `range ${column.min != null ? column.min.toPrecision(6) : "—"} to ${column.max != null ? column.max.toPrecision(6) : "—"}`
      );
    }
  }
  if (stats.gravity) {
    lines.push(`   gravity     ${stats.gravity.magnitude} m/s²`, `   ${stats.gravity.reading}`);
  }
  return lines;
}
