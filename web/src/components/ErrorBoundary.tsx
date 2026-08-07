import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null; info: string | null };

/**
 * Catches a render or lifecycle throw anywhere below it.
 *
 * Without this, one thrown error unmounts the entire tree and the app becomes a
 * blank white page — no message, no route, nothing to act on. For a diagnostic
 * tool that is the worst possible failure mode: an empty screen is exactly what
 * a genuine "this device blocked everything" result would also look like, so the
 * user cannot tell a crash from a finding.
 *
 * It deliberately does not try to recover in place. State that produced a throw
 * is not state worth resuming from, and a long Deep Probe run cannot be silently
 * half-restored — so it says plainly that the run is gone and offers a reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept short: the component stack is the useful part, the rest is noise.
    console.error("[error-boundary]", error.name, error.message, info.componentStack?.slice(0, 400) ?? "");
    this.setState({ info: info.componentStack?.split("\n").slice(0, 6).join("\n").trim() ?? null });
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const outOfMemory = /allocation|out of memory|heap|maximum call stack/i.test(`${error.name} ${error.message}`);

    return (
      <div className="min-h-dvh bg-background px-4 py-10 text-foreground">
        <div className="mx-auto w-full max-w-md space-y-3">
          <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-300" />
              <h1 className="text-[15px] font-semibold text-rose-100">This screen crashed</h1>
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-rose-100/80">
              Something threw an error and the screen could not keep rendering. This message exists so you get a reason instead of a blank page — a
              blank page would look identical to a device that refused everything, and those are very different results.
            </p>
          </div>

          <div className="rounded-2xl border border-border/70 bg-card p-4">
            <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">What went wrong</h2>
            <p className="mono mt-1.5 break-words text-[11px] leading-relaxed text-foreground">
              {error.name}: {error.message}
            </p>
            {info ? <pre className="mono mt-2 overflow-x-auto whitespace-pre-wrap text-[10px] leading-relaxed text-muted-foreground">{info}</pre> : null}
          </div>

          {outOfMemory ? (
            <div className="rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4 text-[11px] leading-relaxed text-amber-100/90">
              This reads like the browser running out of memory. If it happened during a Deep Probe run, the archive was probably being assembled from
              more photos than this device can hold at once. Run it again at a narrower scope, or stop the camera sweep earlier — a partial archive
              builds fine and says which stages it is missing.
            </div>
          ) : null}

          <div className="rounded-2xl border border-border/70 bg-card p-4 text-[11px] leading-relaxed text-muted-foreground">
            Anything an unfinished run had gathered is held in memory only, so it did not survive this. Nothing was uploaded and nothing on your device
            was changed.
          </div>

          <button
            type="button"
            onClick={this.reload}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-secondary px-4 py-3 text-[13px] font-semibold text-foreground transition-colors active:bg-secondary/70"
          >
            <RotateCcw className="h-4 w-4" />
            Reload the app
          </button>
        </div>
      </div>
    );
  }
}
