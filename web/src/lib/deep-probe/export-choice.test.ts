import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearExportChoice, DEFAULT_EXPORT_CHOICE, readExportChoice, summariseChoice, writeExportChoice } from "./export-choice";

/** A minimal synchronous localStorage, which is all the choice needs. */
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
  clearExportChoice();
});

describe("the default", () => {
  it("leaves the archive off", () => {
    expect(readExportChoice()).toEqual({ sheet: true, spec: true, viewer: true, archive: false });
  });

  it("hands back a copy, so a caller cannot edit the default itself", () => {
    const first = readExportChoice();
    first.archive = true;
    expect(DEFAULT_EXPORT_CHOICE.archive).toBe(false);
    expect(readExportChoice().archive).toBe(false);
  });
});

describe("remembering across visits", () => {
  it("returns what was written", () => {
    writeExportChoice({ sheet: false, spec: true, viewer: false, archive: true });
    expect(readExportChoice()).toEqual({ sheet: false, spec: true, viewer: false, archive: true });
  });

  it("survives a run that killed the tab, which is the run most likely to need it again", () => {
    writeExportChoice({ sheet: true, spec: false, viewer: true, archive: false });
    // A reload keeps the store and discards everything else, so the read must
    // reach storage every time rather than answering from module state. The
    // stored JSON is checked directly: that is what a fresh page would find.
    expect(JSON.parse(window.localStorage.getItem("deep-probe.exports.v1") ?? "null")).toEqual({
      sheet: true,
      spec: false,
      viewer: true,
      archive: false,
    });
    expect(readExportChoice().spec).toBe(false);
  });

  it("forgets the choice when it is cleared", () => {
    writeExportChoice({ sheet: false, spec: false, viewer: false, archive: true });
    clearExportChoice();
    expect(readExportChoice()).toEqual(DEFAULT_EXPORT_CHOICE);
  });
});

describe("a stored value that cannot be trusted", () => {
  it("falls back field by field rather than wholesale", () => {
    window.localStorage.setItem("deep-probe.exports.v1", JSON.stringify({ sheet: false, archive: "yes" }));
    // `archive` is not a boolean, so it must not be believed — a corrupt key
    // silently re-enabling the heavy path is the one failure that matters here.
    expect(readExportChoice()).toEqual({ sheet: false, spec: true, viewer: true, archive: false });
  });

  it("ignores unparseable JSON", () => {
    window.localStorage.setItem("deep-probe.exports.v1", "{not json");
    expect(readExportChoice()).toEqual(DEFAULT_EXPORT_CHOICE);
  });

  it("ignores a value that is not an object", () => {
    window.localStorage.setItem("deep-probe.exports.v1", "42");
    expect(readExportChoice()).toEqual(DEFAULT_EXPORT_CHOICE);
  });
});

describe("a store that refuses", () => {
  it("reads the default instead of throwing", () => {
    installHostileStorage();
    expect(readExportChoice()).toEqual(DEFAULT_EXPORT_CHOICE);
  });

  it("writes without throwing, so the session still honours the choice", () => {
    installHostileStorage();
    expect(() => writeExportChoice({ sheet: false, spec: false, viewer: false, archive: true })).not.toThrow();
  });
});

describe("the one-line summary", () => {
  it("names what is ticked and says the bytes are dropped when the archive is not", () => {
    const text = summariseChoice({ sheet: true, spec: true, viewer: false, archive: false });
    expect(text).toContain("stat sheet");
    expect(text).toContain("AI spec");
    expect(text).not.toContain("on-screen");
    expect(text).toContain("photo bytes released");
  });

  it("does not promise released bytes when the archive is ticked", () => {
    const text = summariseChoice({ sheet: true, spec: true, viewer: true, archive: true });
    expect(text).toContain("raw archive");
    expect(text).not.toContain("photo bytes released");
  });

  it("says plainly when nothing is ticked", () => {
    expect(summariseChoice({ sheet: false, spec: false, viewer: false, archive: false })).toContain("Nothing ticked");
  });
});
