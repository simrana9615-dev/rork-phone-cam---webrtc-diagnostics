# Verification Hub — ID Document & Liveness Checks

A phones-only, mobile-first web app for ID document verification, face matching,
liveness detection, and deep camera/WebRTC diagnostics — with an IDVerse/IDKit-grade
on-device forensic engine and a strict **no-false-accusations** calibration policy.

Everything runs in the browser on the phone: EXIF/pixel forensics, MRZ + ICAO 9303
validation, PDF417/AAMVA decoding, face matching, rPPG pulse, screen-replay and
capture-channel injection detection. The only network calls are optional AI vision
verdicts and vision-OCR through the Rork Toolkit proxy.

## Documentation

| Document | Contents |
|---|---|
| [`docs/templates.md`](./docs/templates.md) | **Full technical breakdown of every verification template** — the 6 presets, the Custom Flow resolver, both EyeDeeKit one-tap flows, the per-page check battery with all thresholds, PASS/REVIEW/FAIL fusion rules, coverage matrix, and exports |
| [`docs/eyedeekit-deep-dive.md`](./docs/eyedeekit-deep-dive.md) | **Maximum-detail EyeDeeKit deep-dive** — every stage, constraint, threshold, ref, timer, and fusion rule of both one-tap flows in execution order: silent capture engine, native handoff + securing hold, provenance invariants, liveness, passive identity chain, failure-mode matrix |
| [`docs/capture-ledger.md`](./docs/capture-ledger.md) | **Capture Feed Ledger field reference** — the millisecond-exact record of every camera interaction: verbatim stream requests with request/grant/first-frame timing, full delivered settings + capability dumps, requested-vs-received diffs, clip bitrate math, complete raw EXIF dumps, native round-trip timelines, and the honesty rules for values a browser cannot expose |
| [`docs/detection-engine.md`](./docs/detection-engine.md) | The forensic core — scoring model, verdict rules, metadata & pixel forensics, injection-guard signal tiers, lens enforcement, face pipeline, liveness & rPPG, document data validation, calibration policy |
| [`docs/architecture.md`](./docs/architecture.md) | Codebase map — routing, pages, shared components, every `src/lib` module, environment configuration, testing |
| [`docs/coverage-report.md`](./docs/coverage-report.md) | **Max-context coverage report** — every claim the app can prove and the evidence behind it, the complete check inventory by family, step-by-step walkthroughs of how each of the 8 flows executes, and the Device Camera Spec Report battery |

## What's inside

- **EyeDeeKit one-tap flows** (pinned on the dashboard):
  - *Drivers Licence Flow* — one tap → silent max-resolution selfie on permission grant →
    the native camera auto-opens for licence front, then back → full pipeline → combined verdict.
  - *Passport Flow* — same engine with a single passport photo-page capture (MRZ deep data
    instead of a barcode).
- **6 verification templates** — passport/licence × WebRTC-live/native-camera capture ×
  liveness/native-selfie face steps, all ending in a combined PASS/REVIEW/FAIL summary.
- **Custom Flow builder** — pick document, capture method, face mode, and pages via URL params.
- **Advanced Tools** (`/advanced`) — camera & WebRTC diagnostics hub: environment and
  permissions, live viewfinder, constraint lab, crop simulator, last-photo EXIF
  inspector (device model, capture timestamp, GPS when present — plus the full raw
  tag dump), automated suite runner, session gallery with fraud-screening badges and a
  per-item EXIF inspector on every capture card (one-tap JSON export of the raw
  metadata + that photo's recorded capture timeline + screening verdict), and the
  Fraud Lab.
- **Device Camera Spec Report** (`/device-spec`) — one tap tests everything spec-wise the
  phone's cameras support: every lens probed at maximum capability (granted resolution,
  zoom/torch/focus modes), measured real fps, ImageCapture still-photo maximums, the full
  19-pattern constraint suite on both facings, MediaRecorder codec matrix, and native
  barcode formats — exported as readable text + structured JSON.
- **Capture engine toggle** — every native-camera launch point (guided flows, EyeDeeKit
  doc pages + fallback selfie, diagnostic hub, Document Check, Face Match) can run through
  the direct native camera app (`<input capture>`, default), the system picker
  (UIImagePickerController-style sheet, no capture attribute), Capacitor's
  `Camera.getPhoto()` (`webUseInput`) with the original file + event-trust provenance
  intercepted at Capacitor's own hidden input, the bare boolean `capture` attribute
  (original HTML Media Capture form — browser picks the camera UI), the legacy
  `accept="image/*;capture=camera"` MIME-parameter hint (pre-standard syntax; observed
  behavior is the finding), or the File System Access `showOpenFilePicker()` (Chromium-only
  native OS picker; no change event exists, so trust facts are recorded as not observable).
  Persisted locally; recorded per ledger trip.
- **Share links** — compressed, self-expiring (72 h) summaries embedded in the URL fragment;
  nothing is uploaded. `/shared` renders on any device (the only route that bypasses the
  phone gate).
- **Session persistence** — flows survive the tab eviction phones perform while the native
  camera app is open (IndexedDB, 6 h TTL).

## Key guarantees

- **Phones only** — desktops, laptops, and tablets are gated out (except `/shared`).
- **Original evidence preserved** — native captures keep the full sensor frame and original
  EXIF; lens facing and zoom are enforced *post-capture* from the photo's own metadata.
- **No false positives by design** — hard verdicts require corroborated, invariant-backed
  evidence; privacy browsers (DuckDuckGo, Brave, Firefox Focus), Safari's EXIF stripping,
  and in-app WebViews are recognized as legitimate and can at worst produce REVIEW with
  retake advice — never FAIL.
- **Overkill-detail reports** — per-finding observed/expected/impact, category bars,
  on-device heat maps (ELA, noise, edges, glare, frequency), full scoring telemetry, and
  corrective retake instructions in both readable-text and structured-JSON exports.
- **Capture Feed Ledger** — every camera interaction recorded millisecond-exact: the
  verbatim constraints each stream request sent, request→grant→first-frame timing, the
  full delivered settings/capability dumps with requested-vs-received DIFFERS rows,
  measured fps + frame counts, clip container/codec/bitrate math, complete raw EXIF
  dumps per photo, and native round-trip timelines — in the report, both exports, and a
  standalone ledger download. Values a browser cannot expose are listed as
  "not exposed" with the reason, never guessed.

## Development

```sh
bun install        # install dependencies
bun run dev        # start the dev server (camera APIs need HTTPS or localhost)
bun run build      # production build → dist/
bun run lint       # eslint
bun run test       # vitest unit tests + Playwright browser tests
```

### Environment

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_TOOLKIT_URL` | Rork Toolkit proxy base URL (AI verdicts + vision OCR) |
| `EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY` | Toolkit key |

When these are absent the AI-dependent checks are reported as **unavailable** in the
coverage matrix (with the reason) and everything else still runs fully on-device.

### Stack

Vite · React 19 · TypeScript (strict) · Tailwind CSS · shadcn/ui · TanStack Query ·
`exifreader` · `@vladmandic/face-api` · `@zxing/browser`/`@zxing/library`
