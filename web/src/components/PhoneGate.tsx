import { useCallback, useState, type ReactNode } from "react";
import { Check, Copy, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * True only for phone-class devices. Every check in this app depends on real
 * phone camera hardware (EXIF provenance, liveness, torch/zoom, native capture
 * intents), so desktops and laptops are blocked outright. Android tablets and
 * iPads are also excluded — "Mobile" is absent from Android tablet UAs, and
 * iPads report either "iPad" or a desktop-Mac UA.
 */
function isPhoneDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile === true) return true;
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return true;
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return true;
  return /Windows Phone|BlackBerry|Opera Mini|Mobi/i.test(ua);
}

/**
 * Shared summary links (`/shared#…`) are read-only, image-free, and carry
 * their own data — reviewers legitimately open them on desktops, so that
 * route bypasses the gate.
 */
function isSharedReportPath(): boolean {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/shared");
}

/** Blocks the whole app on non-phone devices with instructions to reopen it on a phone. */
export function PhoneGate({ children }: { children: ReactNode }) {
  // Device class cannot change during a session — evaluate once.
  const [allowed] = useState<boolean>(() => isPhoneDevice() || isSharedReportPath());
  const [copied, setCopied] = useState<boolean>(false);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the visible URL below remains the fallback.
    }
  }, []);

  if (allowed) return <>{children}</>;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="animate-rise w-full max-w-md rounded-2xl border border-border/70 bg-card p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10">
          <Smartphone className="h-8 w-8 text-primary" />
        </div>
        <h1 className="mt-5 text-xl font-bold tracking-tight">Open this on your phone</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Verification Hub runs document forensics, liveness detection, and camera diagnostics that require a real phone
          camera. It can&apos;t run on this device.
        </p>
        <div className="mono mt-5 select-all break-all rounded-lg border border-border/70 bg-background px-3 py-2.5 text-xs text-foreground/90">
          {typeof window !== "undefined" ? window.location.href : ""}
        </div>
        <Button onClick={() => void copyLink()} variant="secondary" className="mt-3 h-11 w-full">
          {copied ? <Check className="mr-2 h-4 w-4 text-emerald-400" /> : <Copy className="mr-2 h-4 w-4" />}
          {copied ? "Link copied" : "Copy link for your phone"}
        </Button>
        <p className="mt-4 text-xs text-muted-foreground/80">
          Type or paste the address into your phone&apos;s browser — HTTPS is required for camera access.
        </p>
      </div>
    </div>
  );
}
