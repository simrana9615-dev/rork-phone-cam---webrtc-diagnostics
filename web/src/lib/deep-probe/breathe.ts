/**
 * Letting the page breathe during a long pass.
 *
 * A phone browser kills a page that stops answering, and it does so without
 * warning, without an event and without a console line. A loop that walks a few
 * hundred megabytes of image data with no yield in it is exactly the shape that
 * gets killed — and from the outside the death is indistinguishable from
 * running out of memory, which is why the crash trail measures the difference
 * rather than assuming one.
 *
 * `breathe()` is the other half of that: a yield that actually returns control
 * to the browser, so the progress bar moves, the stop button responds and the
 * watchdog stays quiet.
 *
 * Three mechanisms, in order of preference:
 *
 *   1. `scheduler.yield()` — the purpose-built API. Returns to the event loop
 *      and comes back at the front of the queue, so yielding often is cheap.
 *   2. `MessageChannel` — a macrotask that is not clamped the way a zero
 *      timeout is. Chromium clamps nested `setTimeout(0)` to 4 ms after five
 *      levels; over a thousand iterations that alone would add four seconds.
 *   3. `setTimeout` — the floor, for anything with neither.
 *
 * A yield is only free if it is not taken too often, so callers use
 * `breatheEvery` to yield on a cadence rather than on every item.
 */

type SchedulerWindow = { scheduler?: { yield?: () => Promise<void> } };

/**
 * How often a chunked loop should yield. Long enough that the yield overhead
 * stays negligible, short enough that the main thread is never held past a
 * frame or two on a slow phone.
 */
export const BREATHE_INTERVAL_MS = 24;

let channel: MessageChannel | null = null;

function macrotask(): Promise<void> {
  if (typeof MessageChannel === "undefined") {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  channel ??= new MessageChannel();
  const port = channel.port2;
  return new Promise<void>((resolve) => {
    const onMessage = (): void => {
      port.removeEventListener("message", onMessage);
      resolve();
    };
    port.addEventListener("message", onMessage);
    port.start();
    channel!.port1.postMessage(null);
  });
}

/** Hands control back to the browser once. */
export async function breathe(): Promise<void> {
  const scheduler = (globalThis as unknown as SchedulerWindow).scheduler;
  if (typeof scheduler?.yield === "function") {
    try {
      await scheduler.yield();
      return;
    } catch {
      // Falls through — an aborted yield is not worth failing a run over.
    }
  }
  await macrotask();
}

/**
 * A cadence keeper. Call `tick()` inside a loop; it yields only when enough
 * time has passed, so the cost of breathing does not scale with the number of
 * items being walked.
 */
export function breatheEvery(intervalMs: number = BREATHE_INTERVAL_MS): { tick: () => Promise<void>; yields: () => number } {
  let last = typeof performance !== "undefined" ? performance.now() : Date.now();
  let count = 0;
  return {
    tick: async (): Promise<void> => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - last < intervalMs) return;
      last = now;
      count += 1;
      await breathe();
    },
    yields: () => count,
  };
}
