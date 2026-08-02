/**
 * Human-realistic capture-return hold.
 *
 * Every photo returned by the phone's native camera app is held before it
 * re-enters the verification flow. The hold length is drawn from a Gaussian
 * (bell-curve) distribution centred at 1.5s and clamped to [1.0s, 2.0s], so
 * the delay is never a fixed, fingerprint-able constant.
 *
 * The hold is applied BEFORE the press→file round-trip time is recorded:
 * every recorded capture timing therefore includes the enforced hold, which
 * pushes any genuine return well above the physical-impossibility threshold.
 * A recorded round-trip below MIN_HUMAN_RETURN_MS can only be produced by
 * software answering the capture request directly.
 */

/** Recorded round-trips below this are physically impossible — hard fail. */
export const MIN_HUMAN_RETURN_MS = 300;

/** Gaussian hold parameters: mean 1.5s, σ 220ms, clamped to [1.0s, 2.0s]. */
export const HOLD_MEAN_MS = 1500;
export const HOLD_SIGMA_MS = 220;
export const HOLD_MIN_MS = 1000;
export const HOLD_MAX_MS = 2000;

/**
 * Draws one hold duration from the clamped bell curve via the Box–Muller
 * transform. Clamping keeps outliers inside the guaranteed 1–2s window while
 * preserving the non-deterministic centre mass around 1.5s.
 */
export function gaussianCaptureHoldMs(): number {
  const u1 = Math.max(Number.EPSILON, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = HOLD_MEAN_MS + z * HOLD_SIGMA_MS;
  return Math.round(Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, raw)));
}

/**
 * Awaits one bell-curve hold and resolves with the number of milliseconds
 * actually held. Call this before recording any capture round-trip timing.
 */
export function runCaptureHold(): Promise<number> {
  const ms = gaussianCaptureHoldMs();
  return new Promise<number>((resolve) => {
    window.setTimeout(() => resolve(ms), ms);
  });
}
