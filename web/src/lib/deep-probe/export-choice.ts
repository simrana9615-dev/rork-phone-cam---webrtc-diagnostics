/**
 * What a Deep Probe run should hand over, chosen once and agreed everywhere.
 *
 * The choice used to live inside the run page and only appeared after the last
 * photo — twenty-odd minutes in, and unreachable entirely if the run ended
 * early. It lives here instead so the dashboard card, the setup screen and the
 * pre-read confirmation are three views of one value rather than three
 * independent ones that can disagree.
 *
 * It is persisted because the run it configures is the one most likely to kill
 * the tab. Losing the setting along with the run would make the second attempt
 * repeat the first mistake.
 */

import { useCallback, useEffect, useState } from "react";

/** The four products of a run. Only the archive is off by default. */
export type ExportChoice = {
  /** The full stat and spec sheet, as a page and as plain text. */
  sheet: boolean;
  /** The concise markdown holding only what is distinctive about this device. */
  spec: boolean;
  /** The same content read on screen, section by section. */
  viewer: boolean;
  /** The byte-for-byte raw dump. The expensive one. */
  archive: boolean;
};

/**
 * The archive is opted into, not out of. It is the single product that has been
 * killing the tab, and leaving it off is what allows each photo's bytes to be
 * released the moment its facts are read.
 */
export const DEFAULT_EXPORT_CHOICE: ExportChoice = { sheet: true, spec: true, viewer: true, archive: false };

const KEY = "deep-probe.exports.v1";

/** Every mounted hook, so two views of the choice can never drift apart. */
const listeners = new Set<(next: ExportChoice) => void>();

function coerce(raw: unknown): ExportChoice {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_EXPORT_CHOICE };
  const record = raw as Record<string, unknown>;
  const pick = (key: keyof ExportChoice): boolean =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : DEFAULT_EXPORT_CHOICE[key];
  return { sheet: pick("sheet"), spec: pick("spec"), viewer: pick("viewer"), archive: pick("archive") };
}

/**
 * The stored choice, or the default. A malformed or partial value falls back
 * field by field rather than being thrown away wholesale — a single unreadable
 * key should not silently re-enable the archive.
 */
export function readExportChoice(): ExportChoice {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return { ...DEFAULT_EXPORT_CHOICE };
    return coerce(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_EXPORT_CHOICE };
  }
}

/** Persists the choice and tells every mounted view about it. */
export function writeExportChoice(next: ExportChoice): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private browsing, a full quota, or storage denied outright. The choice
    // still applies to this session; only its memory across visits is lost.
  }
  for (const listener of listeners) listener(next);
}

/** Wipes the stored choice. Used by tests and by nothing else. */
export function clearExportChoice(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — an unreadable store is also an unwritable one.
  }
}

/** A short summary of what is ticked, for a card that has no room for four labels. */
export function summariseChoice(choice: ExportChoice): string {
  const on: string[] = [];
  if (choice.sheet) on.push("stat sheet");
  if (choice.spec) on.push("AI spec");
  if (choice.viewer) on.push("on-screen");
  if (choice.archive) on.push("raw archive");
  if (on.length === 0) return "Nothing ticked — the run will report itself but offer you none of it.";
  return `${on.join(" · ")}${choice.archive ? "" : " · photo bytes released as they are read"}`;
}

/**
 * The choice, shared. Reads the stored value on mount rather than at module
 * load so a server render or a test with no `localStorage` cannot throw, and
 * subscribes so the dashboard card and the run page stay in step while both
 * are alive.
 */
export function useExportChoice(): [ExportChoice, (next: ExportChoice) => void] {
  const [choice, setChoice] = useState<ExportChoice>(DEFAULT_EXPORT_CHOICE);

  useEffect(() => {
    setChoice(readExportChoice());
    const listener = (next: ExportChoice): void => setChoice(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const update = useCallback((next: ExportChoice): void => {
    setChoice(next);
    writeExportChoice(next);
  }, []);

  return [choice, update];
}
