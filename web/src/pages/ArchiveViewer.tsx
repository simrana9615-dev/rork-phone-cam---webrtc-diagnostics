import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Hash,
  Image as ImageIcon,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/camera-diagnostics";
import { hexLines } from "@/lib/deep-probe/raw-bytes";
import {
  isInflateSupported,
  payloadStart,
  readEntry,
  readEntryBlob,
  readEntryText,
  readZip,
  verifyEntry,
  type EntryVerification,
  type ZipArchive,
  type ZipReadEntry,
} from "@/lib/deep-probe/zip-reader";
import { crcHex } from "@/lib/zip-writer";
import { cn } from "@/lib/utils";

/** How much text is pulled in per press. Deflated entries pay for every byte before the window. */
const TEXT_CHUNK = 128 * 1024;
/** 16 bytes per line, so this is 256 lines — about one comfortable scroll on a phone. */
const HEX_WINDOW = 4 * 1024;

type Mode = "auto" | "text" | "hex";

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic|heif|bmp)$/i;
const TEXT_EXT = /\.(txt|md|json|csv|html?|log|xml|svg)$/i;

function extensionOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

function mimeForImage(path: string): string {
  const ext = extensionOf(path);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "heic" || ext === "heif") return `image/${ext}`;
  return `image/${ext}`;
}

function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "(root)" : path.slice(0, cut);
}

function nameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

export default function ArchiveViewer() {
  const [archive, setArchive] = useState<ZipArchive | null>(null);
  const [archiveName, setArchiveName] = useState<string>("");
  const [opening, setOpening] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sweep, setSweep] = useState<{ done: number; total: number; failed: string[] } | null>(null);
  const [sweepRunning, setSweepRunning] = useState<boolean>(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const open = useCallback(async (file: File): Promise<void> => {
    setOpening(true);
    setError(null);
    setSelected(null);
    setSweep(null);
    try {
      const parsed = await readZip(file);
      setArchive(parsed);
      setArchiveName(file.name);
    } catch (err) {
      setArchive(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, []);

  const verifyAll = useCallback(async (): Promise<void> => {
    if (!archive) return;
    setSweepRunning(true);
    const failed: string[] = [];
    for (let i = 0; i < archive.entries.length; i += 1) {
      const entry = archive.entries[i];
      try {
        const result = await verifyEntry(archive, entry);
        if (!result.ok) failed.push(entry.path);
      } catch {
        failed.push(entry.path);
      }
      setSweep({ done: i + 1, total: archive.entries.length, failed: [...failed] });
      // Let the frame breathe so the progress figure actually moves on screen.
      if (i % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    setSweepRunning(false);
  }, [archive]);

  const groups = useMemo(() => {
    if (!archive) return [];
    const map = new Map<string, ZipReadEntry[]>();
    for (const entry of archive.entries) {
      const folder = folderOf(entry.path);
      const list = map.get(folder);
      if (list) list.push(entry);
      else map.set(folder, [entry]);
    }
    return Array.from(map.entries());
  }, [archive]);

  const looksLikeProbe = useMemo(() => {
    if (!archive) return false;
    const paths = new Set(archive.entries.map((e) => e.path));
    return paths.has("MANIFEST.txt") && (paths.has("READ-ME.txt") || paths.has("device-spec.md"));
  }, [archive]);

  const selectedEntry = useMemo(() => archive?.entries.find((e) => e.path === selected) ?? null, [archive, selected]);

  if (archive && selectedEntry) {
    return <EntryDetail archive={archive} entry={selectedEntry} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-3 px-3 pb-16 pt-3">
      <div className="flex items-center gap-2">
        <Link to="/" className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-card active:scale-95">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold leading-tight">Archive viewer</h1>
          <p className="truncate text-[10.5px] text-muted-foreground">Open a Deep Probe dump without unzipping it</p>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(ev) => {
          const file = ev.target.files?.[0];
          if (file) void open(file);
          ev.target.value = "";
        }}
      />

      {!archive ? (
        <div className="diag-card p-3.5">
          <div className="flex items-start gap-2">
            <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-fuchsia-400" />
            <div>
              <h2 className="text-[14px] font-semibold leading-tight">Open an archive</h2>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                Reads the ZIP where it sits. Nothing is uploaded, nothing is copied anywhere, and the file on your phone is never modified — the
                viewer only ever reads from it.
              </p>
            </div>
          </div>
          <Button className="mt-3 h-12 w-full bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" disabled={opening} onClick={() => fileRef.current?.click()}>
            {opening ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FolderOpen className="mr-1.5 h-4 w-4" />}
            {opening ? "Opening" : "Choose a .zip"}
          </Button>
          {!isInflateSupported() ? (
            <p className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[10.5px] leading-relaxed text-amber-200">
              This browser cannot decompress deflated entries, so the text reports will not open here. The captures themselves are stored
              uncompressed and will read normally.
            </p>
          ) : null}
          <div className="mt-3 space-y-1.5 rounded-xl border border-border/60 bg-background/40 p-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
            <p>
              <strong className="text-foreground">Why it is here.</strong> The archive is meant to outlive this app — every report inside it explains
              how to check it with standard tools. This viewer is a convenience, not the authority: when it and <span className="mono">unzip</span>{" "}
              disagree, believe <span className="mono">unzip</span>.
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="diag-card border-rose-500/45 p-3.5">
          <div className="flex items-start gap-2 text-rose-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <h2 className="text-[13px] font-semibold">That file would not open</h2>
              <p className="mt-1 text-[11.5px] leading-relaxed text-rose-200/90">{error}</p>
            </div>
          </div>
        </div>
      ) : null}

      {archive ? (
        <>
          <div className="diag-card p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-[13.5px] font-semibold">{archiveName}</h2>
                <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {archive.entries.length} files · {formatBytes(archive.totalUncompressed)} extracted · {archive.entries.filter((e) => e.stored).length}{" "}
                  stored, {archive.entries.filter((e) => !e.stored).length} deflated
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setArchive(null);
                  setArchiveName("");
                  setSweep(null);
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 active:scale-95"
                aria-label="Close this archive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <p className={cn("mt-2 text-[10.5px] leading-relaxed", looksLikeProbe ? "text-muted-foreground" : "text-amber-200")}>
              {looksLikeProbe
                ? "This is a Deep Probe archive. Captures sit in captures/, frames this app encoded sit in rendered-frames/, and the byte-level dumps are under raw/."
                : "This does not look like a Deep Probe archive — no manifest was found. It will still open; the viewer makes no assumptions about what is inside."}
            </p>

            {archive.warnings.map((warning) => (
              <p key={warning} className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[10.5px] leading-relaxed text-amber-200">
                {warning}
              </p>
            ))}

            <Button variant="outline" className="mt-3 h-11 w-full" disabled={sweepRunning} onClick={() => void verifyAll()}>
              {sweepRunning ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1.5 h-4 w-4" />}
              {sweepRunning ? `Checking ${sweep?.done ?? 0} of ${sweep?.total ?? 0}` : "Check every file against its checksum"}
            </Button>

            {sweep && !sweepRunning ? (
              <div
                className={cn(
                  "mt-2 rounded-xl border p-2.5 text-[10.5px] leading-relaxed",
                  sweep.failed.length === 0 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-rose-500/45 bg-rose-500/10 text-rose-200"
                )}
              >
                {sweep.failed.length === 0 ? (
                  <>
                    All {sweep.total} files were extracted and their CRC-32 recomputed here. Every one matches the checksum recorded when the archive
                    was written, so nothing has changed since.
                  </>
                ) : (
                  <>
                    {sweep.failed.length} of {sweep.total} files did not match the checksum recorded in the archive: {sweep.failed.slice(0, 6).join(", ")}
                    {sweep.failed.length > 6 ? ` and ${sweep.failed.length - 6} more` : ""}. Reported rather than hidden.
                  </>
                )}
              </div>
            ) : null}
          </div>

          {groups.map(([folder, entries]) => (
            <div key={folder} className="diag-card overflow-hidden">
              <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                <span className="mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{folder}</span>
                <span className="text-[10px] text-muted-foreground">{entries.length}</span>
              </div>
              <div className="divide-y divide-border/40">
                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => setSelected(entry.path)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left active:bg-muted/40"
                  >
                    {IMAGE_EXT.test(entry.path) ? (
                      <ImageIcon className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                    ) : TEXT_EXT.test(entry.path) ? (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Hash className="h-3.5 w-3.5 shrink-0 text-fuchsia-400" />
                    )}
                    <span className="mono min-w-0 flex-1 truncate text-[11px]">{nameOf(entry.path)}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(entry.size)}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function EntryDetail({ archive, entry, onBack }: { archive: ZipArchive; entry: ZipReadEntry; onBack: () => void }) {
  const [mode, setMode] = useState<Mode>("auto");
  const [text, setText] = useState<{ body: string; complete: boolean; bytesRead: number } | null>(null);
  const [hexOffset, setHexOffset] = useState<number>(0);
  const [hex, setHex] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [dataOffset, setDataOffset] = useState<number | null>(null);
  const [check, setCheck] = useState<EntryVerification | null>(null);
  const [checking, setChecking] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [failure, setFailure] = useState<string | null>(null);

  const isImage = IMAGE_EXT.test(entry.path);
  const isText = TEXT_EXT.test(entry.path);
  const effective: Mode = mode === "auto" ? (isImage ? "auto" : isText ? "text" : "hex") : mode;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const offset = await payloadStart(archive, entry);
        if (!cancelled) setDataOffset(offset);
      } catch {
        if (!cancelled) setDataOffset(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [archive, entry]);

  // The preview URL is owned by this effect, so it is revoked the moment the
  // selection changes rather than leaking a blob per file opened.
  useEffect(() => {
    if (!isImage) return;
    let url: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const blob = await readEntryBlob(archive, entry, mimeForImage(entry.path));
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      } catch (err) {
        if (!cancelled) setFailure(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setImageUrl(null);
    };
  }, [archive, entry, isImage]);

  const loadText = useCallback(
    async (bytes: number): Promise<void> => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await readEntryText(archive, entry, 0, bytes);
        setText({ body: result.text, complete: result.complete, bytesRead: result.bytesRead });
      } catch (err) {
        setFailure(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [archive, entry]
  );

  const loadHex = useCallback(
    async (offset: number): Promise<void> => {
      setBusy(true);
      setFailure(null);
      try {
        const chunk = await readEntry(archive, entry, offset, HEX_WINDOW);
        setHex(chunk.bytes.length === 0 ? "(no bytes at this offset)" : hexLines(chunk.bytes, offset));
        setHexOffset(offset);
      } catch (err) {
        setFailure(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [archive, entry]
  );

  useEffect(() => {
    setText(null);
    setHex(null);
    setCheck(null);
    setFailure(null);
    setHexOffset(0);
    setMode("auto");
  }, [entry]);

  useEffect(() => {
    if (effective === "text" && text == null && !busy) void loadText(TEXT_CHUNK);
    if (effective === "hex" && hex == null && !busy) void loadHex(0);
  }, [effective, text, hex, busy, loadText, loadHex]);

  const runCheck = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      setCheck(await verifyEntry(archive, entry));
    } catch (err) {
      setCheck({ ok: false, expected: crcHex(entry.crc32), actual: "—", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  }, [archive, entry]);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const blob = await readEntryBlob(archive, entry);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = nameOf(entry.path);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [archive, entry]);

  const related = useMemo(() => {
    const slug = nameOf(entry.path).replace(/\.[a-z0-9]+$/i, "");
    if (!slug) return [];
    return archive.entries.filter((e) => e.path !== entry.path && (e.path.includes(`/${slug}.`) || e.path.includes(`/${slug}/`)));
  }, [archive, entry]);

  const pages = Math.max(1, Math.ceil(entry.size / HEX_WINDOW));
  const page = Math.floor(hexOffset / HEX_WINDOW) + 1;

  return (
    <div className="mx-auto w-full max-w-md space-y-3 px-3 pb-16 pt-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-card active:scale-95">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="mono truncate text-[13px] font-semibold leading-tight">{nameOf(entry.path)}</h1>
          <p className="mono truncate text-[10px] text-muted-foreground">{entry.path}</p>
        </div>
      </div>

      <div className="diag-card p-3">
        <div className="mono grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px]">
          <span className="text-muted-foreground">size</span>
          <span>{entry.size.toLocaleString("en-US")} bytes</span>
          <span className="text-muted-foreground">in archive</span>
          <span>
            {entry.compressedSize.toLocaleString("en-US")} bytes · {entry.stored ? "stored" : "deflated"}
          </span>
          <span className="text-muted-foreground">crc-32</span>
          <span>{crcHex(entry.crc32)}</span>
          <span className="text-muted-foreground">data offset</span>
          <span>{dataOffset != null ? dataOffset.toLocaleString("en-US") : "reading…"}</span>
        </div>
        <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
          {entry.stored
            ? "Stored, so the bytes sit verbatim at that offset — carving them out of the ZIP with dd gives you this file exactly."
            : "Deflated, so carving at that offset gives compressed bytes rather than the file. Use unzip for this one."}
        </p>

        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <Button variant="outline" className="h-10" disabled={checking} onClick={() => void runCheck()}>
            {checking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />}
            Check
          </Button>
          <Button variant="outline" className="h-10" disabled={busy} onClick={() => void save()}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Save
          </Button>
        </div>

        {check ? (
          <div
            className={cn(
              "mono mt-2 rounded-xl border p-2.5 text-[10px] leading-relaxed",
              check.ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-rose-500/45 bg-rose-500/10 text-rose-200"
            )}
          >
            {check.ok ? <Check className="mr-1 inline h-3 w-3" /> : <AlertTriangle className="mr-1 inline h-3 w-3" />}
            {check.detail}
          </div>
        ) : null}
      </div>

      <div className="flex gap-1.5">
        {(["auto", "text", "hex"] as const).map((option) => {
          const label = option === "auto" ? (isImage ? "Image" : "Auto") : option === "text" ? "Text" : "Hex";
          if (option === "auto" && !isImage) return null;
          return (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              className={cn(
                "flex-1 rounded-xl border px-2 py-2 text-[11px] font-semibold active:scale-95",
                effective === option || (option === "auto" && effective === "auto") ? "border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-200" : "border-border/70 bg-card text-muted-foreground"
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {failure ? (
        <div className="diag-card border-rose-500/45 p-3 text-[11px] leading-relaxed text-rose-200">{failure}</div>
      ) : null}

      {effective === "auto" && isImage ? (
        <div className="diag-card overflow-hidden">
          {imageUrl ? (
            <img src={imageUrl} alt={entry.path} className="w-full" />
          ) : (
            <div className="flex h-40 items-center justify-center text-[11px] text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> decoding
            </div>
          )}
          <p className="border-t border-border/60 p-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
            Decoded here for viewing only. The bytes in the archive are untouched — switch to Hex to see them as they are stored.
          </p>
        </div>
      ) : null}

      {effective === "text" ? (
        <div className="diag-card overflow-hidden">
          <pre className="mono max-h-[65vh] overflow-auto whitespace-pre-wrap break-words p-2.5 text-[10px] leading-relaxed">
            {text?.body ?? (busy ? "reading…" : "")}
          </pre>
          {text ? (
            <div className="border-t border-border/60 p-2.5">
              <p className="text-[10.5px] text-muted-foreground">
                Showing {formatBytes(text.bytesRead)} of {formatBytes(entry.size)}
                {text.complete ? " — this is the whole file." : " — there is more."}
              </p>
              {!text.complete ? (
                <Button variant="outline" className="mt-2 h-9 w-full text-[11px]" disabled={busy} onClick={() => void loadText(text.bytesRead + TEXT_CHUNK * 4)}>
                  {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Load more
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {effective === "hex" ? (
        <div className="diag-card overflow-hidden">
          <pre className="mono max-h-[60vh] overflow-auto whitespace-pre p-2.5 text-[9.5px] leading-[1.5]">{hex ?? (busy ? "reading…" : "")}</pre>
          <div className="space-y-2 border-t border-border/60 p-2.5">
            <p className="mono text-[10px] text-muted-foreground">
              bytes {hexOffset.toLocaleString("en-US")}–{Math.min(entry.size, hexOffset + HEX_WINDOW).toLocaleString("en-US")} of{" "}
              {entry.size.toLocaleString("en-US")} · window {page} of {pages}
            </p>
            {!entry.stored ? (
              <p className="text-[10px] leading-relaxed text-amber-200/90">
                This entry is deflated, so every window has to be inflated from the start of the file. Jumping far into a large one is slow — that
                cost is exactly why the captures are stored uncompressed.
              </p>
            ) : null}
            <div className="grid grid-cols-3 gap-1.5">
              <Button variant="outline" className="h-9 text-[11px]" disabled={busy || hexOffset === 0} onClick={() => void loadHex(Math.max(0, hexOffset - HEX_WINDOW))}>
                Back
              </Button>
              <Button variant="outline" className="h-9 text-[11px]" disabled={busy || hexOffset === 0} onClick={() => void loadHex(0)}>
                Start
              </Button>
              <Button
                variant="outline"
                className="h-9 text-[11px]"
                disabled={busy || hexOffset + HEX_WINDOW >= entry.size}
                onClick={() => void loadHex(hexOffset + HEX_WINDOW)}
              >
                Next
              </Button>
            </div>
            <JumpToOffset max={entry.size} disabled={busy} onJump={(offset) => void loadHex(offset)} />
          </div>
        </div>
      ) : null}

      {related.length > 0 ? (
        <div className="diag-card overflow-hidden">
          <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Everything else about this file ({related.length})
          </div>
          <div className="divide-y divide-border/40">
            {related.map((item) => (
              <div key={item.path} className="mono flex items-center gap-2 px-3 py-2 text-[10.5px]">
                <span className="min-w-0 flex-1 truncate">{item.path}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(item.size)}</span>
              </div>
            ))}
          </div>
          <p className="border-t border-border/60 p-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
            Go back and open any of these from the list to read them.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function JumpToOffset({ max, disabled, onJump }: { max: number; disabled: boolean; onJump: (offset: number) => void }) {
  const [raw, setRaw] = useState<string>("");
  const parsed = useMemo(() => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const value = /^0x/i.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
    if (!Number.isFinite(value) || value < 0 || value >= max) return null;
    // Snap to the line grid so the offsets down the left edge stay aligned.
    return Math.floor(value / 16) * 16;
  }, [raw, max]);

  return (
    <div className="flex gap-1.5">
      <input
        value={raw}
        onChange={(ev) => setRaw(ev.target.value)}
        inputMode="text"
        placeholder="offset — 4096 or 0x1000"
        className="mono min-w-0 flex-1 rounded-xl border border-border/70 bg-background/60 px-2.5 py-2 text-[11px] outline-none focus:border-fuchsia-500/60"
      />
      <Button variant="outline" className="h-9 shrink-0 px-3 text-[11px]" disabled={disabled || parsed == null} onClick={() => parsed != null && onJump(parsed)}>
        Go
      </Button>
    </div>
  );
}
