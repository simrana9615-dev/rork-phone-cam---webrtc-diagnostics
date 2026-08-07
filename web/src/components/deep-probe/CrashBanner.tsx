import { useCallback, useState } from "react";
import { AlertTriangle, ClipboardCopy, ChevronDown, ChevronUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { crashTrailText, type CrashCause, type CrashReport } from "@/lib/deep-probe/crash-trail";
import { cn } from "@/lib/utils";

const CAUSE_LABEL: Record<CrashCause, string> = {
  "out-of-memory": "It ran out of memory",
  unresponsive: "The browser killed a frozen page",
  "left-deliberately": "You closed or reloaded the page",
  threw: "The run reported an error",
  undetermined: "The cause could not be pinned down",
};

function mb(bytes: number | null): string {
  return bytes == null ? "not reported here" : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * What the last run was doing when it died.
 *
 * A tab killed by the operating system runs no handler and logs nothing, so the
 * only way to know anything is to have written it down beforehand. This reads
 * that trail back, once, and clears it — so the banner appears for a genuine
 * crash and never for a run that ended properly.
 */
export function CrashBanner({ report, onDismiss }: { report: CrashReport; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const copy = useCallback(async (): Promise<void> => {
    const text = crashTrailText(report);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard access can be refused. The trail is on screen either way.
      setExpanded(true);
    }
  }, [report]);

  const isCrash = report.cause !== "left-deliberately";

  return (
    <div className={cn("diag-card overflow-hidden", isCrash ? "border-rose-500/45" : "border-border/70")}>
      <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2.5">
        <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", isCrash ? "text-rose-300" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[12.5px] font-semibold leading-tight">{isCrash ? "Your last run did not survive" : "Your last run was interrupted"}</h2>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">{CAUSE_LABEL[report.cause]}</p>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded-lg border border-border/70 p-1.5 text-muted-foreground active:scale-95">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-2.5 p-3">
        <div className="overflow-hidden rounded-xl border border-border/60">
          <div className="grid grid-cols-[minmax(96px,40%)_1fr] gap-2 border-b border-border/40 px-2.5 py-1.5 text-[10.5px]">
            <span className="text-muted-foreground">Died in</span>
            <span className="mono break-words text-foreground">{report.diedIn}</span>
          </div>
          <div className="grid grid-cols-[minmax(96px,40%)_1fr] gap-2 border-b border-border/40 bg-background/40 px-2.5 py-1.5 text-[10.5px]">
            <span className="text-muted-foreground">Step number</span>
            <span className="mono text-foreground">
              {report.diedAtIndex} · {(report.diedAtMs / 1000).toFixed(1)}s into the run
            </span>
          </div>
          <div className="grid grid-cols-[minmax(96px,40%)_1fr] gap-2 border-b border-border/40 px-2.5 py-1.5 text-[10.5px]">
            <span className="text-muted-foreground">Still answering</span>
            <span className="mono text-foreground">
              {report.silenceAfterMs == null ? "no heartbeat recorded" : `${(report.silenceAfterMs / 1000).toFixed(2)}s after that step began`}
            </span>
          </div>
          <div className="grid grid-cols-[minmax(96px,40%)_1fr] gap-2 border-b border-border/40 bg-background/40 px-2.5 py-1.5 text-[10.5px]">
            <span className="text-muted-foreground">Memory then</span>
            <span className="mono text-foreground">
              {mb(report.heapBytes)}
              {report.heapAtStartBytes != null ? ` · ${mb(report.heapAtStartBytes)} at the start` : ""}
            </span>
          </div>
          <div className="grid grid-cols-[minmax(96px,40%)_1fr] gap-2 px-2.5 py-1.5 text-[10.5px]">
            <span className="text-muted-foreground">Photo bytes held</span>
            <span className="mono text-foreground">{mb(report.heldBytes)}</span>
          </div>
        </div>

        <p className="rounded-xl border border-border/60 bg-background/40 p-2.5 text-[10.5px] leading-relaxed text-muted-foreground">{report.verdict}</p>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Button variant="outline" className="h-10 text-[11.5px]" onClick={() => void copy()}>
            <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy the whole trail"}
          </Button>
          <Button variant="outline" className="h-10 px-3" onClick={() => setExpanded((v) => !v)} aria-label={expanded ? "Hide the steps" : "Show every step"}>
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {expanded ? (
          <pre className="mono max-h-72 overflow-auto rounded-xl border border-border/60 bg-background/60 p-2.5 text-[9px] leading-[1.5] whitespace-pre-wrap break-words">
            {crashTrailText(report)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
