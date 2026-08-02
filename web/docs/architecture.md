# App Architecture — Pages, Components & Libraries

High-level map of the codebase: routing, screens, shared components, and every library
module with its responsibility. For the verification flows themselves see
[`templates.md`](./templates.md); for detection internals see
[`detection-engine.md`](./detection-engine.md); for the full inventory of everything the
app tests and proves see [`coverage-report.md`](./coverage-report.md).

---

## 1. Stack

- **Vite + React 19 + TypeScript (strict)**, Tailwind CSS, shadcn/ui (Radix primitives),
  `lucide-react` icons, `react-router-dom` v6, TanStack Query.
- **Forensics/vision dependencies:** `exifreader` (EXIF/XMP/IPTC parsing),
  `@vladmandic/face-api` (detection, landmarks, expressions),
  `onnxruntime-web` + bundled MobileFaceNet ONNX (ArcFace identity embeddings),
  `@zxing/browser` + `@zxing/library` (PDF417 fallback decoder).
- Everything runs **on-device in the browser** except the optional AI verdicts and the
  vision-OCR read, which go through the Rork Toolkit proxy (`google/gemini-3.5-flash`).
- Package manager: **bun**. Scripts: `dev`, `build`, `lint`, `test` (vitest, incl. a
  Playwright browser config), `preview`.

## 2. Routing (`src/App.tsx`)

| Route | Screen | Notes |
|---|---|---|
| `/` | `Dashboard` | EyeDeeKit hero cards, 6 templates, custom builder, advanced tools |
| `/eyedeekit/licence` | `IdKitFlow` (licence variant) | One-tap flow; `/idkit` is a legacy alias |
| `/eyedeekit/passport` | `IdKitFlow` (passport variant) | One-tap flow, single doc capture |
| `/verify/:templateId` | `Verify` | Guided template flow (presets + `custom` with query params) |
| `/advanced` | `Index` | Advanced camera & WebRTC diagnostics hub |
| `/device-spec` | `DeviceSpec` | One-tap device camera spec battery with text + JSON export |
| `/shared` | `SharedReport` | Read-only share-link viewer — **bypasses the phone gate** |
| `*` | `NotFound` | Catch-all |

Provider order: `QueryClientProvider` → `TooltipProvider` → `Toaster` → `PhoneGate` →
`BrowserRouter`.

**PhoneGate** (`components/PhoneGate.tsx`): the app is phones-only — desktops, laptops,
and tablets (including iPads) see a blocking explainer instead of the app. The only
exception is `/shared`, which renders anywhere so a reviewer can open a report link on
desktop.

## 3. Pages

### `Dashboard.tsx`
Entry screen: two pinned EyeDeeKit hero cards (amber licence / indigo passport), the six
verification template cards, the Custom Flow builder (doc / capture / face / pages
pickers producing `/verify/custom?...`), and the Advanced Tools entry to `/advanced`.

### `IdKitFlow.tsx`
The shared one-tap EyeDeeKit engine (variant-configured for licence or passport),
Revision 4 — passive verification chain: a secret ~1 s front-camera clip (sampled
frames + MediaRecorder video + micro-motion analysis + injection audit) runs before
EVERY document page, then the native camera auto-opens inside the trust window
(licence front → second silent clip → licence back; passport photo page), finishing
with a 16:9-requested / portrait-cropped liveness and a two-strike native-selfie
fallback. Each silent clip's best face frame is matched against both the document
portrait and the live face — a quality-gated mismatch fails the session; a faceless
clip is ignored (normal while photographing a document). Stream HUD (live resolution +
measured fps via `requestVideoFrameCallback`), per-capture provenance + lens
enforcement with reject-and-retake, manual fallback buttons, full analysis pipeline,
combined summary with a Passive Verification Chain section, per-clip downloads
(frame + video), and both exports. Detailed walkthrough in `templates.md` §5.

### `Verify.tsx`
The guided template flow: resolves the template (`getTemplate`), walks document pages →
face step → summary. Per-page capture uses `LiveDocCapture` (WebRTC) or
`NativeCaptureStep` (native); runs the per-page check battery, face match, verdict
fusion, coverage matrix, exports, share links, and session persistence/restore
(IndexedDB — critical because phones evict the tab while the native camera is open).

### `Index.tsx` (Advanced Tools, `/advanced`)
The full diagnostics hub: environment & permissions panel, live viewfinder, native
capture (front + back) with provenance watch, last-photo EXIF inspector (device,
timestamp, and GPS headline facts plus the complete raw tag dump of the newest
captured photo), constraint lab, crop simulator, debug console, session gallery with
fraud-screening badges and per-item EXIF inspection (every capture card expands into
the same inspector panel), automated suite runner (18 constraint patterns), and the
Fraud Lab section (document check, face match, liveness, media screening).

### `DeviceSpec.tsx` (`/device-spec`)
One-tap Device Camera Spec Report: runs `lib/device-spec.ts` (environment & API
surface, per-camera maximum-capability probes with measured fps and ImageCapture photo
capabilities, the 19-pattern constraint suite on both facings, MediaRecorder codec
matrix, BarcodeDetector formats) with a live progress bar, renders every section as
cards, and exports the report as readable text and structured JSON. Full battery
description in `coverage-report.md` §4.

### `SharedReport.tsx`
Decodes the share-link fragment (deflate-raw + base64url), enforces the 72 h TTL, and
renders the read-only session summary.

## 4. Shared components

| Component | Role |
|---|---|
| `verify/LiveDocCapture.tsx` | WebRTC document viewfinder with the live alignment overlay (corner locks, skew/tilt hints, sharpness/brightness/steadiness gates) driven by `lib/doc-align.ts` |
| `verify/NativeCaptureStep.tsx` | Native file-input capture step: provenance recording, lens/zoom enforcement with red reject-and-retake panel |
| `LivenessCheck.tsx` | Full liveness session: smile challenge–response, live face bounding boxes, rPPG pulse, screen-replay + injection checks, multi-face detection |
| `FaceMatch.tsx` | Standalone Fraud Lab face-match tool (same ensemble engine as the flows) |
| `DocumentCheck.tsx` / `DocDataPanel.tsx` / `DocConfidenceBadge.tsx` | Deep data check UI: MRZ ledger, per-check-digit rows, expandable confidence ledger badge |
| `FraudLab.tsx` | Fraud Lab hub section (media screening entry points) |
| `LastPhotoExif.tsx` | Diagnostic-hub EXIF inspector for the newest captured photo: device / timestamp / GPS headline tiles with explicit not-in-file states, capture-parameter chips, and the complete raw tag dump (parsed locally); exports the reusable `ExifInspector` panel, also embedded in every session-gallery item, with a one-tap JSON download of the raw tags + the photo's observed capture timeline + screening verdict (heat-map image payloads excluded with an explicit note) |
| `ReportView.tsx` | Forensic report renderer: verdict chip, category bars, finding rows (observed/expected/impact), heat-map visuals, technical appendix; exports `FindingRow` |
| `CameraErrorHelp.tsx` | getUserMedia error classifier with actionable fixes |
| `PhoneGate.tsx` | Phones-only gate (see §2) |
| `ui/*` | shadcn/ui primitives |

## 5. Library modules (`src/lib`)

| Module | Responsibility |
|---|---|
| `verification-templates.ts` | Template definitions, custom resolver, session result types, `computeOverall` fusion, coverage matrix, text + JSON exports — see `templates.md` |
| `fraud-detection.ts` | Core forensic engine (`verification-hub-forensics/2.4`): findings, scoring, confidence, verdict rules, capture-path-aware metadata (trusted native/live = info-only quirks), telemetry, retake advice — see `detection-engine.md` |
| `device-plausibility.ts` | Session device-norm: iOS/Android/desktop contradictions (GPU, recorder codecs, File System Access) — REVIEW-only |
| `injection-guard.ts` | Capture-channel integrity: injection audit (definitive/strong/info tiers), native provenance, privacy-browser detection, virtual-camera markers |
| `lens-enforcement.ts` | Post-capture EXIF lens/zoom policy for native captures |
| `ai-verdict.ts` | AI vision verdicts + document OCR via the Rork Toolkit proxy (resize ladder, 2.5 MB budget, strict JSON parsing, `aiVerdictAvailable`) |
| `face-vision.ts` | Face detection, ArcFace alignment orchestration, quality gates, live boxes, ensemble match |
| `face-embedder.ts` | MobileFaceNet ONNX embedder (256-d), 5-point warp, cosine distance bands |
| `ppg.ts` | rPPG pulse estimation (POS projection, dual BPM estimators, quality grading) + cross-feed continuity across silent and liveness legs |
| `pixel-forensics.ts` | Screen-replay detection, noise/texture statistics, document pixel analysis, video frame extraction & temporal comparison |
| `visual-forensics.ts` | Heat-map/chart renderers for the report visuals |
| `mrz.ts` | ICAO 9303 MRZ parsing, check digits, date logic, zone cross-validation, confidence ledger |
| `pdf417.ts` | PDF417 decode (BarcodeDetector → ZXing, rotation-tolerant) + AAMVA parsing + licence cross-checks |
| `doc-align.ts` | Live viewfinder alignment analysis (edges, corners, skew, sharpness, brightness, steadiness) |
| `capture-quality.ts` | Instant post-capture quality gate (sharpness/glare/shadow) |
| `camera-diagnostics.ts` | Camera/EXIF helpers, constraint builders, suite test patterns, capture utilities, log types |
| `device-spec.ts` | Device Camera Spec Report engine: environment collection, per-camera max-capability probes, measured fps, constraint suite runs, codec matrix, text + JSON report builders |
| `session-store.ts` | IndexedDB session persistence (6 h TTL, survives native-camera tab eviction) |
| `share-link.ts` | Compressed, self-expiring (72 h), fragment-only share links — no server storage |
| `utils.ts` | `cn` class-name helper |

## 6. Environment & configuration

- `EXPO_PUBLIC_TOOLKIT_URL` + `EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY` — Rork Toolkit proxy
  credentials for AI verdicts and vision OCR. When absent, `aiVerdictAvailable()` is
  false and the coverage matrix honestly reports those checks as **unavailable** with the
  reason; everything else runs fully on-device.
- HTTPS (or localhost) is required for `getUserMedia`; the app detects and explains a
  non-secure context.
- PWA basics: `public/manifest.webmanifest` (standalone, portrait, dark theme),
  icons, and meta tags in `index.html`.

## 7. Testing & builds

- `bun run test` — vitest unit tests plus a Playwright-driven browser config
  (`vitest.browser.config.ts`).
- `bun run build` — production build to `dist/`.
- Type checking is strict; lint via `bun run lint`.
