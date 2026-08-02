import type { Finding } from "./fraud-detection";
import { detectPrivacyBrowser } from "./injection-guard";

/**
 * Session-level device / browser plausibility.
 *
 * Models what a genuine latest phone + privacy browser can expose, and flags
 * self-contradictions that no honest device produces. All findings are
 * REVIEW-grade (warn/info) — never standalone FAIL — per the no-false-accusation
 * policy. A hostile host can still spoof UA strings; these checks raise the
 * floor against sloppy injection and inconsistent controlled runtimes.
 *
 * Key honest norms encoded here:
 * - Every iOS browser (Safari, Chrome, DDG, Brave, Firefox) is WebKit under the
 *   hood — Chromium-only surfaces (non-WebKit WebGL renderer strings that only
 *   appear on desktop Chrome, File System Access on iOS, webm/vp9 as the only
 *   recorder) are contradictions when the UA claims iPhone/iPad.
 * - Privacy browsers wrap APIs by design — that alone is never a contradiction.
 * - Android Chrome is real Chromium; webm + File System Access can be normal.
 */

export type DevicePlausibilityReport = {
  platform: "ios" | "android" | "desktop" | "unknown";
  privacyBrowser: string | null;
  findings: Finding[];
  /** True when at least one strong contradiction fired (still REVIEW-only). */
  hasContradiction: boolean;
  summary: string;
};

function detectPlatform(): DevicePlausibilityReport["platform"] {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  // iPadOS 13+ desktop UA — still WebKit iOS.
  if (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows|Macintosh|Linux/i.test(ua) && !/Mobile/i.test(ua)) return "desktop";
  return "unknown";
}

function webglRenderer(): string | null {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl") || c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return gl.getParameter(gl.RENDERER) as string;
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
  } catch {
    return null;
  }
}

function hasFileSystemAccess(): boolean {
  return typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";
}

function recorderMimeSupport(): { webm: boolean; mp4: boolean } {
  const MR = typeof MediaRecorder !== "undefined" ? MediaRecorder : null;
  if (!MR || typeof MR.isTypeSupported !== "function") return { webm: false, mp4: false };
  return {
    webm: MR.isTypeSupported("video/webm;codecs=vp8") || MR.isTypeSupported("video/webm;codecs=vp9") || MR.isTypeSupported("video/webm"),
    mp4: MR.isTypeSupported("video/mp4") || MR.isTypeSupported("video/mp4;codecs=avc1") || MR.isTypeSupported("video/mp4;codecs=avc1.42E01E"),
  };
}

/**
 * Runs a one-shot session environment plausibility audit. Safe to call anytime;
 * pure observation of navigator/WebGL/MediaRecorder surfaces.
 */
export function assessDevicePlausibility(): DevicePlausibilityReport {
  const findings: Finding[] = [];
  const platform = detectPlatform();
  const pb = detectPrivacyBrowser();
  const ua = (navigator.userAgent || "").slice(0, 180);
  const renderer = webglRenderer();
  const fsa = hasFileSystemAccess();
  const rec = recorderMimeSupport();
  const brands =
    typeof (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData
      ?.brands !== "undefined"
      ? (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData?.brands ?? []
      : [];

  findings.push({
    id: "device-norm-profile",
    label: "Session device profile",
    status: "info",
    weight: 0,
    category: "device",
    observed: `${platform}${pb.detected ? ` · ${pb.name}` : ""} · ${ua}`,
    expected: "Consistent OS / browser / capability surface",
    detail: `Analysis environment classified as ${platform}${pb.detected ? ` running ${pb.name}` : ""}. Privacy-browser API wrapping is expected when detected and is not a contradiction.`,
  });

  if (renderer) {
    findings.push({
      id: "device-norm-gpu",
      label: "GPU renderer string",
      status: "info",
      weight: 0,
      category: "device",
      observed: renderer,
      expected: "Matches the claimed OS GPU family",
      detail: "WebGL unmasked renderer — recorded for cross-check against the claimed platform.",
    });
  }

  // ── iOS contradictions ──────────────────────────────────────────────
  if (platform === "ios") {
    // Real iOS WebKit never exposes the File System Access picker.
    if (fsa) {
      findings.push({
        id: "device-norm-fsa-ios",
        label: "File System Access on claimed iOS",
        status: "warn",
        weight: 10,
        category: "device",
        observed: "showOpenFilePicker is present",
        expected: "Absent on every real iOS browser (all are WebKit)",
        detail:
          "The session claims an iPhone/iPad user agent but exposes the Chromium File System Access API. No shipping iOS browser provides this — the runtime is not a genuine iOS WebKit session (desktop spoof, remote browser, or modified host). REVIEW-only corroboration.",
      });
    }

    // iOS records mp4/h264; pure-webm-only with zero mp4 is a desktop Chromium tell.
    if (rec.webm && !rec.mp4) {
      findings.push({
        id: "device-norm-recorder-ios",
        label: "Recorder codecs vs claimed iOS",
        status: "warn",
        weight: 8,
        category: "device",
        observed: "video/webm supported, video/mp4 not supported",
        expected: "iOS Safari/WebKit exposes mp4/h264 recording, not webm-only",
        detail:
          "A genuine iOS browser records MP4 (H.264). WebM-only MediaRecorder support while claiming iPhone/iPad is a desktop-Chromium fingerprint wearing an iOS UA — REVIEW corroboration, not a standalone fail.",
      });
    }

    // ANGLE (Google Inc.) / SwiftShader on an "iPhone" is almost always a spoofed desktop session.
    if (renderer) {
      const r = renderer.toLowerCase();
      const desktopGpu =
        r.includes("swiftshader") ||
        r.includes("llvmpipe") ||
        r.includes("angle (google") ||
        r.includes("angle (nvidia") ||
        r.includes("angle (amd") ||
        r.includes("angle (intel") ||
        (r.includes("nvidia") && !r.includes("apple")) ||
        (r.includes("geforce") && !r.includes("apple"));
      // Honest iOS: "Apple GPU", "Apple Axx", "Apple M1" via ANGLE metal, etc.
      const appleLike = /apple\s*(gpu|a\d|m\d)|metal/i.test(renderer);
      if (desktopGpu && !appleLike) {
        findings.push({
          id: "device-norm-gpu-ios",
          label: "GPU family vs claimed iOS",
          status: "warn",
          weight: 12,
          category: "device",
          observed: renderer,
          expected: "Apple GPU / Apple Ax / Metal-backed renderer on real iPhones",
          detail:
            "The WebGL renderer is a desktop GPU/software stack while the user agent claims iPhone/iPad. Real iOS WebKit exposes Apple GPU strings — this combination is a controlled or spoofed runtime. REVIEW corroboration only.",
        });
      }
    }

    // userAgentData brands advertising "Google Chrome" / "Chromium" on iOS is fine
    // for Chrome-on-iOS (still WebKit) — do not flag brands alone.
  }

  // ── Android mild checks ─────────────────────────────────────────────
  if (platform === "android") {
    if (renderer && /apple\s*gpu|metal/i.test(renderer) && !/android|adreno|mali|powervr|xclipse/i.test(renderer)) {
      findings.push({
        id: "device-norm-gpu-android",
        label: "GPU family vs claimed Android",
        status: "warn",
        weight: 10,
        category: "device",
        observed: renderer,
        expected: "Adreno / Mali / PowerVR / Xclipse-class GPU on Android",
        detail:
          "An Apple/Metal GPU renderer with an Android user agent is a platform contradiction — REVIEW corroboration.",
      });
    }
  }

  // ── Desktop posing as mobile via coarse signals ─────────────────────
  if (platform === "desktop") {
    findings.push({
      id: "device-norm-desktop-session",
      label: "Desktop analysis session",
      status: "info",
      weight: 0,
      category: "device",
      observed: ua,
      expected: "Phone session for high-assurance identity capture",
      detail:
        "This session is running on a desktop-class user agent. Identity verification is designed for a real phone camera — desktop runs are diagnostic only and cannot produce phone-native capture provenance.",
    });
  }

  // Touch points vs mobile claim
  const maxTouch = navigator.maxTouchPoints ?? 0;
  if ((platform === "ios" || platform === "android") && maxTouch === 0) {
    findings.push({
      id: "device-norm-touch",
      label: "Touch points vs mobile claim",
      status: "warn",
      weight: 6,
      category: "device",
      observed: "maxTouchPoints = 0",
      expected: "≥1 on real phones",
      detail:
        "The user agent claims a phone but the environment reports zero touch points — common in desktop emulation / remote browsers. REVIEW corroboration.",
    });
  }

  // Brands list recorded for telemetry (no score).
  if (brands.length > 0) {
    findings.push({
      id: "device-norm-brands",
      label: "User-Agent Client Hints brands",
      status: "info",
      weight: 0,
      category: "device",
      observed: brands.map((b) => `${b.brand}/${b.version}`).join(", "),
      expected: "Informational",
      detail: "navigator.userAgentData.brands snapshot — context only.",
    });
  }

  const contradictions = findings.filter((f) => f.status === "warn" || f.status === "fail");
  const hasContradiction = contradictions.length > 0;
  const summary = hasContradiction
    ? `Device-norm review: ${contradictions.length} platform contradiction(s) — ${contradictions.map((f) => f.label).join("; ")}. REVIEW-only; never a standalone fail.`
    : `Device-norm clean: session surface is consistent with a genuine ${platform} browser${pb.detected ? ` (${pb.name})` : ""}.`;

  return {
    platform,
    privacyBrowser: pb.name,
    findings,
    hasContradiction,
    summary,
  };
}

/** Maps a plausibility report into findings safe to merge into a fraud report or session overall. */
export function devicePlausibilityFindings(report: DevicePlausibilityReport = assessDevicePlausibility()): Finding[] {
  return report.findings;
}
