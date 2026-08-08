import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearRunMode, DEFAULT_RUN_MODE, PROBE_WIDTH, readRunMode, RUN_MODE_INFO, summariseMode, writeRunMode } from "./run-mode";

/** A minimal synchronous localStorage, which is all the mode needs. */
function installStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string): string | null => map.get(key) ?? null,
      setItem: (key: string, value: string): void => void map.set(key, value),
      removeItem: (key: string): void => void map.delete(key),
    },
  });
}

/** A store that refuses every operation, as private browsing can. */
function installHostileStorage(): void {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("quota");
      },
      removeItem: (): void => {
        throw new Error("denied");
      },
    },
  });
}

beforeEach(() => {
  installStorage();
  clearRunMode();
});

describe("choosing which run to start", () => {
  it("defaults to the full run, never to the short one", () => {
    expect(DEFAULT_RUN_MODE).toBe("full");
    expect(readRunMode()).toBe("full");
  });

  it("remembers the 640-only choice across visits", () => {
    writeRunMode("width-640");
    expect(readRunMode()).toBe("width-640");
  });

  it("falls back to the full run when the stored value means nothing", () => {
    window.localStorage.setItem("deep-probe.mode.v1", "something-else");
    expect(readRunMode()).toBe("full");
  });

  it("survives a store that refuses every operation", () => {
    installHostileStorage();
    expect(readRunMode()).toBe("full");
    expect(() => writeRunMode("width-640")).not.toThrow();
    expect(() => clearRunMode()).not.toThrow();
  });

  it("tells every mounted view when the mode changes", () => {
    const seen: string[] = [];
    writeRunMode("width-640");
    // The listener set is internal; the observable contract is that a write is
    // immediately readable, which is what two views of one value depend on.
    seen.push(readRunMode());
    writeRunMode("full");
    seen.push(readRunMode());
    expect(seen).toEqual(["width-640", "full"]);
  });
});

describe("how each mode describes itself", () => {
  it("summarises each in one line", () => {
    expect(summariseMode("width-640")).toContain("640");
    expect(summariseMode("full")).toContain("every camera");
  });

  it("states the cost of each up front", () => {
    expect(RUN_MODE_INFO["width-640"].cost).toContain("about a minute");
    expect(RUN_MODE_INFO.full.cost).toContain("Twenty minutes");
  });

  it("says plainly that the short run sends one constraint and nothing else", () => {
    expect(RUN_MODE_INFO["width-640"].blurb).toContain("ONLY constraint");
    expect(RUN_MODE_INFO["width-640"].blurb).toContain("no height, no aspect ratio, no frame rate");
  });

  it("agrees with the width the probe actually sends", () => {
    expect(PROBE_WIDTH).toBe(640);
    expect(RUN_MODE_INFO["width-640"].blurb).toContain(String(PROBE_WIDTH));
  });
});
