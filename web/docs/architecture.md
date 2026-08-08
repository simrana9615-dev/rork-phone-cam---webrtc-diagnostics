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
| `/deep-probe` | `DeepProbe` | Maximum-demand run: tiered permission sweep, sensor recordings, exhaustive camera matrix, manual shot set, raw dump ZIP |
| `/archive` | `ArchiveViewer` | Opens a downloaded Deep Probe archive back up on the phone: file tree, image preview, windowed hex, per-entry CRC re-check |
| `/calibrate` | `Calibrate` | Threshold calibration: labelled genuine/screen/print captures, separation analysis, apply/export |
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
pickers producing `/verify/custom?...`), and the Advanced Tools, Device Spec, Deep Probe and
Threshold Calibration entries.

### `Calibrate.tsx`
Threshold calibration screen. Captures labelled samples in three classes (genuine document,
shown on a screen, printed photocopy), measures each via `calibration-metrics.ts`, and shows
per-metric separation between genuine and fraudulent captures with the derived thresholds.
Metrics whose classes overlap are reported as unusable and stay unscored. Thresholds only
take effect after **Apply thresholds**; the store plus full analysis exports as JSON.

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

### `DeepProbe.tsx` (`/deep-probe`)
The maximum-demand run. Five stages behind a setup screen that states the cost up front
(prompt count, minutes, photo count, archive size), a two-position **run mode** toggle (the full
run, or the 640-only investigation of §6b.13 — chosen on the way in because it decides what the
run *is*), and a three-position scope toggle (`standard` / `extended` / `everything`, the last
one explicitly flagged as reaching data belonging to other apps; unused by the 640-only mode,
which asks for the camera and nothing else).

1. **Permission sweep** — one card per request, stating what the site can reach and how long
   the grant lasts *before* it fires. Auto-advances on a 4 s countdown that pauses while the
   page is hidden, and falls back to a tap target wherever the browser demands transient
   activation (the card says which browser rule and why). Outcomes are `granted` / `denied` /
   `dismissed` / `unavailable` / `skipped` / `error`; **`unavailable` is detected by feature
   probe before firing**, so a missing API can never be recorded as a refusal. Nothing is
   retried.
2. **Sensor recordings** — for each granted sensor, a real timed sample with the *measured*
   rate reported next to the requested one, and the rows themselves measured for what they say
   about the hardware: quantisation step, repeated deliveries, arrival regularity and the
   gravity constant (§6b.12). Not run in the 640-only mode, and named as deliberately absent.
3. **Camera sweep** — `lib/deep-probe/camera-matrix.ts`, with live photo / byte / elapsed
   counters and a stop button. Watches `PressureObserver` where available and surfaces a
   load warning explicitly labelled as load, not temperature. The byte counter is the
   *smaller* of this stage's two memory costs — see §6b.2 — so the sweep enforces its own
   ceiling rather than trusting what is on screen. Every camera request runs under the
   ten-second deadline of §6b.6, and every still it takes is kept only if its shape is new
   (§6b.8). Each camera is photographed **twice and only twice** — its ceiling down the platform
   photo path, its smallest rung down the canvas path — and every other row states on itself that
   no photograph was taken there and why. The time that buys goes on the impossible round of
   `impossible-asks.ts`, which runs right after each camera states its limits. In the 640-only
   mode this stage runs `width-probe.ts` instead — two opens, a bare width each, then a short
   impossible round down each side (§6b.13); in the impossible-only mode it runs
   `runImpossibleProbe` and photographs nothing at all.
4. **Manual shots** — one library pick first, then a single pinned-viewfinder shot for the whole
   run plus **one** zoom shot per camera, asked for only where the sweep already watched that
   camera's zoom move (§6b.14), then **one** camera-app shot per side and one request that
   contradicts itself. The pick leads because it needs no camera, no permission and no good
   light, and it is the only evidence in the run for what an upload form receives from the photo
   library (§6b.5). It is filed as `picker-file` and never as camera output. Each camera-app shot
   carries all three routes as spares tried in turn until that side has its file (§6b.9); the
   list shortens as evidence arrives, but nothing taken by hand is ever discarded.
5. **Exports** — the four tick boxes of `lib/deep-probe/export-choice.ts`, the archive **off**
   by default (§6b.3), arriving pre-filled from the dashboard card and the setup screen. Kept
   here as the last checkpoint rather than the first sighting, because with the archive
   unticked the photo bytes are released as they are read and a choice offered afterwards
   could no longer be acted on. Every stage that did not run is listed on this screen with its
   reason before the choice is confirmed.
6. **Sheets** — `lib/deep-probe/capture-facts.ts` then `lib/deep-probe/sheets.ts`. One walk
   over each capture — checksums, parses, structure and now a bounded pixel sample (§6b.10) —
   then every sheet written from the result. Nothing large is held except the two camera-app
   originals of §6b.7, which are named before the pass starts and offered as plain downloads
   afterwards.
7. **Archive** *(only if ticked)* — `lib/deep-probe/raw-pack.ts`, then every capture is carved
   back out of the finished blob and compared byte-for-byte, with the result shown on screen.
   The stepper omits this stage entirely when it was not asked for.

Every exit from stages 1–4 funnels through one idempotent `toExports()`. Three routes used to
bypass it and jump straight to stage 7 — a refused camera, a stop during the sensors, a stop
during the sweep — where the builder found no sheets to copy in and dead-ended on its own
"this is a bug" card, taking the export choice with it. That was the whole reason the tick
boxes were unreachable. See §6b.4.

The stepper reads recorded per-stage marks (`done` / `skipped` / `stopped` / `failed`), not
position. At the end of a run every stage sits behind the pointer, so position alone painted a
refused camera the same green as one that ran.

On arrival the page reads whatever the last run left in `localStorage` and, if that run never
closed its trail, shows a `CrashBanner` naming the step it died in, what it was holding and
which of the two deaths it was — with the whole trail copyable as text. Reported exactly once.

Stopping at any point keeps everything gathered; the remaining stages are pushed onto the
omission list with a reason and every sheet is labelled `PARTIAL`. The permission queue and the
manual shots leave immediately because they sit idle waiting for input; the sensor loop and the
camera sweep act on the abort flag between steps instead, so a recording or a constraint under
test is never cut in half and reported as a complete reading.

### `SharedReport.tsx`
Decodes the share-link fragment (deflate-raw + base64url), enforces the 72 h TTL, and
renders the read-only session summary.

## 4. Shared components

| Component | Role |
|---|---|
| `verify/LiveDocCapture.tsx` | WebRTC document viewfinder with the live alignment overlay (corner locks, skew/tilt hints, sharpness/brightness/steadiness gates) driven by `lib/doc-align.ts`. Reports the true provenance of each still to the caller — `platform-photo` for an `ImageCapture.takePhoto()` result, `app-encoded-frame` for the canvas fallback |
| `verify/NativeCaptureStep.tsx` | Native file-input capture step: provenance recording, lens/zoom enforcement with red reject-and-retake panel. On the device-level engine it skips the EXIF lens check (no camera EXIF exists there) and reports the pinned camera's identity instead, which is known rather than inferred |
| `verify/CaptureEngineToggle.tsx` | Capture-engine selector plus the permission/information breakdown for the active engine (what the user is prompted with, what the site ends up holding, camera inventory, file metadata, whether an existing photo can be substituted, nearest native equivalent) and an expandable side-by-side comparison of all seven. Renders entirely from `ENGINE_FACTS`, so a claim is corrected in one place |
| `verify/DeviceCameraSheet.tsx` | Full-screen viewfinder for the device-level (AVFoundation-class) engine: lists every camera the platform named, switches between them by `deviceId`, shows the live granted resolution / fps / facingMode / reported max / zoom range / still-pipeline size, and names the AVFoundation device type the selected camera maps to. Declares the still's true origin (`platform-photo` vs `app-encoded-frame`) at capture time. Mounted imperatively via `deviceCameraCapturePhoto()` so every launch point keeps its existing `await …CapturePhoto()` shape |
| `LivenessCheck.tsx` | Full liveness session: smile challenge–response, live face bounding boxes, rPPG pulse, screen-replay + injection checks, multi-face detection |
| `FaceMatch.tsx` | Standalone Fraud Lab face-match tool (same ensemble engine as the flows) |
| `DocumentCheck.tsx` / `DocDataPanel.tsx` / `DocConfidenceBadge.tsx` | Deep data check UI: MRZ ledger, per-check-digit rows, expandable confidence ledger badge |
| `FraudLab.tsx` | Fraud Lab hub section (media screening entry points) |
| `EvidencePackButton.tsx` | The one-tap **Download Evidence Pack (.zip)** action: builds the pack lazily on tap, streams progress inline, pushes every step and every completeness warning into the session log, and reports the post-build byte-identity result per file (a failure is shown in red, never hidden) |
| `LastPhotoExif.tsx` | Diagnostic-hub EXIF inspector for the newest captured photo: device / timestamp / GPS headline tiles with explicit not-in-file states, capture-parameter chips, and the complete raw tag dump (parsed locally); exports the reusable `ExifInspector` panel, also embedded in every session-gallery item, with a one-tap JSON download of the raw tags + the photo's observed capture timeline + screening verdict (heat-map image payloads excluded with an explicit note) |
| `ReportView.tsx` | Forensic report renderer: verdict chip, category bars, finding rows (observed/expected/impact), heat-map visuals, technical appendix; exports `FindingRow` |
| `CameraErrorHelp.tsx` | getUserMedia error classifier with actionable fixes |
| `Dashboard.tsx` → `DeepProbeCard` | The Deep Probe entry, first in the list: card body opens the run, four sibling toggles set what it hands over. The toggles are siblings rather than children because a button nested in a link still follows the link, and a tick would start a twenty-minute run |
| `deep-probe/CrashBanner.tsx` | What the last run was doing when it died: the step, the step number and time into the run, how long the page kept answering its timer afterwards, the heap either side, the capture bytes held, the verdict and how it was reached. One tap copies the whole trail. Shown only for a run that never closed its trail, and only once |
| `deep-probe/SheetViewer.tsx` | The stat sheet on screen — section list, then the section — rendered from the same block registry as the downloadable sheet and the HTML page, so the three cannot disagree. No download, no archive, no unzipping |
| `deep-probe/ProbeViewfinder.tsx` | Deep Probe's manual-shot viewfinder, pinned to one `deviceId` and holding one end of that camera's own reported zoom range (`min`/`mid`/`max` resolved against the range rather than a hardcoded factor). HUD states the granted size, which still path will run and that no camera EXIF exists on this path, all *before* the shutter. A camera with no zoom control produces a clearly-recorded unzoomed shot instead of a fake one. Mounted imperatively via `probeManualShot()`, rejecting with `CaptureCancelledError` on skip |
| `PhoneGate.tsx` | Phones-only gate (see §2) |
| `ui/*` | shadcn/ui primitives |

## 5. Library modules (`src/lib`)

| Module | Responsibility |
|---|---|
| `verification-templates.ts` | Template definitions, custom resolver, session result types, `computeOverall` fusion, coverage matrix, text + JSON exports — see `templates.md` |
| `fraud-detection.ts` | Core forensic engine (`verification-hub-forensics/2.5`): findings, scoring, confidence, verdict rules, capture-path-aware metadata (native/live = info-only quirks), telemetry incl. the check ledger, retake advice — see `detection-engine.md` |
| `thresholds.ts` | Threshold registry with provenance (`browser-invariant` / `spec-defined` / `physical-limit` / `calibrated` / `uncalibrated`). Only defensible thresholds may score; `uncalibrated` ones are measured at weight 0 |
| `calibration.ts` | Labelled sample store + per-metric separation analysis (percentile edges, gap, overlap detection) → threshold overrides, readiness, JSON export |
| `calibration-metrics.ts` | Raw measurement extraction for the calibratable metrics (no grading, no verdict) |
| `metadata-provenance.ts` | Structure-scoped provenance scan: JPEG segments, PNG chunks, RIFF, ISO-BMFF boxes, EBML. Returns only writer/content fields; records structural container names (APP13 `Photoshop 3.0`, ICC profiles, XMP namespaces) as benign so they can never accuse |
| `screen-lattice.ts` | Display-lattice + refresh-banding forensics: native-resolution tiles, Hann-windowed DFT, JPEG grid exclusion, peak prominence, axis agreement |
| `document-locate.ts` | Geometric document localization: border-statistics segmentation, morphology, connected components, convex hull, rotating-caliper min-area rect, ISO 7810 / ICAO TD3 aspect matching, deskewed crop |
| `device-plausibility.ts` | Session device-norm: iOS/Android/desktop contradictions (GPU, recorder codecs, File System Access) — REVIEW-only |
| `injection-guard.ts` | Capture-channel integrity: injection audit (definitive/strong/info tiers), native provenance, privacy-browser detection, virtual-camera markers |
| `lens-enforcement.ts` | Post-capture EXIF lens/zoom policy for native captures |
| `ai-verdict.ts` | AI vision verdicts + document OCR via the Rork Toolkit proxy (resize ladder, 2.5 MB budget, strict JSON parsing, `aiVerdictAvailable`) |
| `face-vision.ts` | Face detection, ArcFace alignment orchestration, quality gates, live boxes, ensemble match. Publishes `cropUrl` — the aligned crop the embedding was actually extracted from — so a match can be audited visually, not just numerically |
| `face-embedder.ts` | MobileFaceNet ONNX embedder (256-d), 5-point warp, cosine distance bands |
| `ppg.ts` | rPPG pulse estimation (POS projection, dual BPM estimators, quality grading) + cross-feed continuity across silent and liveness legs |
| `pixel-forensics.ts` | Screen-replay fusion (two-signal corroboration, unscored when uncalibrated/unassessable), noise/texture statistics, document pixel analysis inside the located crop (which it also exports as `cropUrl` visual evidence), video frame extraction & temporal comparison |
| `visual-forensics.ts` | Heat-map/chart renderers for the report visuals |
| `mrz.ts` | ICAO 9303 MRZ parsing, check digits, date logic, zone cross-validation, confidence ledger |
| `pdf417.ts` | PDF417 decode (BarcodeDetector → ZXing, rotation-tolerant) + AAMVA parsing + licence cross-checks |
| `doc-align.ts` | Live viewfinder alignment analysis (edges, corners, skew, sharpness, brightness, steadiness) |
| `capture-quality.ts` | Instant post-capture quality gate (sharpness/glare/shadow) |
| `camera-diagnostics.ts` | Camera/EXIF helpers, constraint builders, suite test patterns, capture utilities, log types |
| `capture-engine.ts` | The seven capture engines, the persisted selection store, the input `accept`/`capture` attributes each implies, and `ENGINE_FACTS` — a per-engine record of the permission asked, what the site receives, camera-inventory reach, lens control, file metadata, byte origin and nearest native equivalent. Single source for the toggle UI, the session log and the pack |
| `device-camera.ts` | Device-level (AVFoundation-class) capture: enumerates video inputs before **and** after the permission grant so the pack can show exactly what the browser withholds until the user says yes; classifies each platform label into a lens class and the matching `AVCaptureDevice.DeviceType` (unrecognised labels stay `unknown` with `classified: false`, never forced into a bucket); opens one camera by `deviceId: { exact }`, pushes it to its own reported maximum and reads the granted settings back; prefers `ImageCapture.takePhoto()` and falls back to a canvas encode that is labelled as such. `inventoryReport()` writes the full account, including a plain list of what this path cannot give (camera EXIF, sensor-native stills, per-format detail, RAW, depth) |
| `device-spec.ts` | Device Camera Spec Report engine: environment collection, per-camera max-capability probes, measured fps, constraint suite runs, codec matrix, text + JSON report builders |
| `deep-probe/permissions.ts` | The tiered permission registry (`standard` ⊂ `extended` ⊂ `everything`) — every request a site can make, each carrying its API name, what it reaches, how long the grant lasts, its `permissions.query` name, whether the browser demands a fresh gesture (and why), a feature probe and a runner that releases whatever it was granted in the same tick. `runRequest()` queries permission state either side of the ask and converts every throw into a recorded outcome; `unavailable` is decided by probe *before* firing so it can never be confused with a refusal |
| `deep-probe/passive.ts` | Everything readable with no prompt at all: identity strings, hardware, GPU, network, power, locale/storage, display preferences, codec support, API surface, plus `permissions.query` for every name any browser answers to. Deliberately computes **no** uniqueness/fingerprint score — that would need a population this app cannot see |
| `deep-probe/sensors.ts` | Timed recorders for motion, orientation/compass, geolocation (watched until the accuracy figure settles), microphone loudness (level only — no audio is retained), and the generic sensors. Every series reports the **measured** rate beside the requested one, ends through one `withStats()` call so its rows are always analysed, and exports as commented CSV |
| `deep-probe/sensor-stats.ts` | What the recorded rows say about the hardware that produced them: the quantisation step, how many events repeated the one before, how evenly they arrived, and the gravity constant the firmware uses (§6b.12) |
| `deep-probe/capture-memory.ts` | The two memory costs of a camera sweep that no byte counter sees. One `<canvas>` is reused for the whole run with its backing store released immediately after each encode (a 4K canvas is 31.6 MiB, and the sweep now takes a handful of canvas stills per camera rather than one at every step — §6b.14); dimensions are parsed from the file header (`jpeg-sof`, `png-ihdr`, `iso-bmff-ispe`, WebP, GIF) instead of decoding the whole image for two numbers. Also holds the held-bytes ceiling and the policy text the archive prints. The encoded bytes are untouched by any of it — same context, same draw, same quality |
| `deep-probe/camera-matrix.ts` | The sweep: per camera, native max first (which reads the ceiling), then the impossible round, then the plan **built from that ceiling** — four resolution rungs filtered to what the camera advertises plus one over-ask, one portrait ask, three aspect ratios, four frame rates likewise filtered, then every advertised focus / exposure / white-balance / resize mode, zoom extremes and torch applied to a live track. Records asked vs granted for every row; a rejection is a result, not an error. **Two** stills per camera and no more — the ceiling down the platform path, the smallest rung down the canvas path — with `stillPolicy` stating the rule and every other row carrying its own `stillNote`, so an empty capture list is never mistaken for a failure. The torch fires once per run and is left off on exit (§6b.14) |
| `deep-probe/capture-signature.ts` | Reduces a file to its device-describing shape, and the ledger that keeps the first of each and records the repeats (§6b.8) |
| `deep-probe/adaptive-manual.ts` | Says why the spare routes into the camera app were never opened, what happened when a side had to fall back, why a camera the sweep saw refuse to zoom is not asked for a zoom shot, and why the full-frame viewfinder shot is taken once for the whole run rather than once per camera (§6b.9, §6b.14) |
| `deep-probe/pixel-probe.ts` | The bounded pixel sample, decoded with EXIF rotation and colour conversion suppressed (and stating whether the browser understood being told): 8×8 block grid phase, the 2×2 colour-filter rhythm, the sensor pipeline numbers with per-channel clipping and a flat-region noise floor, the post-capture tone stretch, and the centre-to-corner falloff (§6b.10) |
| `deep-probe/constancy.ts` | Classifies each trait by what it moves with — path, camera, size, or nothing (§6b.11) |
| `deep-probe/camera-timeout.ts` | The ten-second deadline on every camera request, the sixty-second one on a prompt, and the adoption that stops a stream arriving after its deadline instead of leaving a camera lit behind the run (§6b.6) |
| `deep-probe/originals.ts` | Chooses the back and front camera-app files, names the downloads and states why a missing one is missing. Only a real camera-app file qualifies (§6b.7) |
| `deep-probe/manual-capture.ts` | **One** camera-app shot per side, each carrying all three routes (`native-camera`, `capture-boolean`, `capacitor`) as spares tried in turn until that side has its file, capturing the change event's trust at event time — plus **one** library pick, the one that names HEIC explicitly so the device has no reason to convert. A pick still cannot promise a fresh photo, so it is never offered as one; it is asked for explicitly as a library file and filed as `picker-file`. The plain `image/*` half is covered by the multi-pick trip and no longer costs a tap of its own (§6b.5, §6b.9) |
| `deep-probe/impossible-asks.ts` | The catalogue of requests designed to be unanswerable, the runner that sends them, and the observations where the answers disagree with each other. Sizes and rates that cannot exist, self-contradicting constraint sets, malformed values, invented setting names, controls pushed past their published limits, one camera opened twice at once, a device id belonging to nothing, the same ask sent twice for drift, two spellings of one request, an impossible demand made of a running track and then of a stopped one, and an ordinary request last so a wedged pipeline is caught. Refusing correctly — the right error, naming the right constraint, in the right time, identically — is the part of a camera hardest to imitate. Takes no photograph anywhere |
| `deep-probe/run-mode.ts` | Which of the three runs is about to start — the full sweep, the 640-only investigation or the impossible asks alone — chosen on the setup screen and persisted, with an unreadable stored value falling back to the **full** run rather than to a short one (§6b.13) |
| `deep-probe/width-probe.ts` | The 640-only investigation: one open per facing with a bare width as the only constraint, everything the phone chose in its place, two stills per open down the platform and canvas paths, and a short impossible round down each side once its open is already paid for (§6b.13) |
| `deep-probe/hashes.ts` | MD5 (streaming, pure TS — Web Crypto dropped it), SHA-1 and SHA-256 via `crypto.subtle`, CRC-32 via the ZIP writer. MD5 is labelled an integrity check, never a security claim; digests that cannot be computed say so instead of being omitted. Verified against the RFC 1321 vectors in `deep-probe.test.ts` |
| `deep-probe/raw-bytes.ts` | The raw dump: `hexDumpBlob` renders `xxd`-layout hex + ASCII in slices assembled as Blob parts (a windowed dump is labelled `WINDOWED` with the exact skipped-byte count, never silently truncated); `walkStructure` really parses JPEG / PNG / ISO-BMFF / RIFF and reports every section's true offset and length; carved regions cover the EXIF block, maker note, ICC profile, embedded thumbnail, XMP, JUMBF/C2PA and Photoshop IRB. Unknown containers are admitted as unknown rather than guessed |
| `deep-probe/hex-budget.ts` | How much of a run may be rendered as hex and why. Holds the 4.94-characters-per-byte constant measured against `hexLines` itself, the device-derived total allowance, the equal per-capture share with its floor and ceiling, the heap-pressure threshold, and the policy statement written into the archive. Pure and fully unit-tested, because getting this number wrong does not degrade the archive — it destroys the run |
| `deep-probe/breathe.ts` | The yield that keeps a long pass alive. `scheduler.yield()` where it exists, a `MessageChannel` macrotask otherwise (a nested `setTimeout(0)` is clamped to 4 ms after five levels — over a thousand iterations that alone is four seconds), `setTimeout` as the floor. `breatheEvery` yields on a time cadence rather than per item, so the cost of breathing does not scale with the number of bytes walked |
| `deep-probe/export-choice.ts` | The four outputs of a run, shared and persisted. One value behind the dashboard card, the setup screen and the pre-read checkpoint, with a listener set so two mounted views cannot drift. Reads at mount rather than module load so a test or a server render with no `localStorage` cannot throw, coerces a malformed stored value field by field (a corrupt key must not silently re-enable the archive), and treats a store that refuses every operation as a session-only choice rather than an error |
| `deep-probe/crash-trail.ts` | Breadcrumbs that outlive the tab. Every step is written to `localStorage` before it runs, so a kill leaves the step name behind; a heartbeat on a 250 ms timer separates the two deaths, because a blocked main thread cannot service a timer while a page that runs out of memory answers one right up to the end. Returns a `CrashReport` naming the step, the silence gap, the heap either side and a verdict — and refuses to guess when the browser reports no heap at all. Hot path writes one ~200-byte key; the full trail is flushed on a throttle with the opening steps always forced through |
| `deep-probe/capture-facts.ts` | The facts pass: **one** walk over each capture producing its four checksums, encoder report, IFD walk, structure map and full tag dump, in both the shapes the spec and the brief consume. Breathes between captures. When no archive was asked for it drains the caller's array as it goes, so each blob becomes collectable at the moment its facts are read rather than at the end of the loop. Does not count `exifreader`'s synthetic `file.FileType` group as metadata — counting it meant a canvas frame with genuinely no metadata never registered as one |
| `deep-probe/sheets.ts` | Every sheet a run can produce without an archive: the full stat sheet (plain text **and** a readable HTML page), the forensic item list, the correlation brief and the device spec. One section registry, three renderings — plain text, HTML and the on-screen viewer are all rendered from the same blocks, so what is read cannot drift from what is saved. Also the home of `StageOmission`, `RunFacts` and the text builders the archive shares |
| `deep-probe/raw-pack.ts` | The raw dump archive, now built **from** the facts pass and the sheets rather than owning them: captures stored verbatim (`captures/` vs `rendered-frames/` by declared origin), per-capture hex dump + structure map + full tag listing, carved segments as lazy `Blob.slice` views, four checksums plus `md5sum`/`sha256sum`-format digest files, the permission ledger, passive dump, sensor CSVs, camera matrix, session log, byte-identity data, the sheets copied in byte-identically and a build trail. Breathes between every stage. Post-build it re-carves every capture from the finished blob and compares. Refuses with `CapturesReleasedError` rather than writing empty files when the bytes were released. Names the file `…-PARTIAL.zip` and lists every omission when a stage did not run |
| `deep-probe/jpeg-encoder.ts` | The encoder signature: all 64 DQT coefficients per table (printed in both natural and file zig-zag order), DHT code-length counts compared against all four ITU T.81 Annex K tables to separate *standard* from *optimised*, frame mode (baseline vs progressive), chroma subsampling derived from the per-component sampling factors, SOS scan count, DRI restart interval, APP segments in file order with lengths and signatures, the embedded thumbnail parsed as the complete second JPEG it is (its own dimensions and table sums), a full ICC header parse (desc name, class, spaces, creator, intent, the profile's own embedded ID), and any bytes after EOI. The libjpeg quality estimate is **withheld** where the tables are not a scaled Annex K table — Apple's encoder is that case, and the refusal is itself the finding |
| `deep-probe/exif-ifd.ts` | A raw TIFF/IFD walk reporting every entry **as stored**: tag ID, TIFF type, component count, byte length, inline-vs-offset, and the undecoded value — rationals as `num/den` rather than decimals, ASCII with its length and NUL-termination stated, UNDEFINED as hex. Also the structure a tag list cannot express: byte order, magic, directory order, IFD1 presence, MakerNote length and signature, `ColorSpace 65535` and `InteroperabilityIndex` as first-class fields, and the GPS block with every Ref resolved. Undocumented tags are reported with a null name, never dropped |
| `deep-probe/correlation-brief.ts` | Answers a specific forensic request item by item from a **single registry**, rendered two ways — the full `correlation-brief.md` and the compact answer key at the top of `device-spec.md` — so the summary cannot drift from the document it summarises. Four statuses, not two: `captured`, `partial`, `not-run` (a gap in this observation) and `not-obtainable` (a limit of what a web page can read). Merging the last two would be the most useful lie such a document could tell, so they are never merged |
| `deep-probe/mimic-spec.ts` | Reduces a whole run to `device-spec.md`: only readings that differ between devices, each tagged `HW` / `OS` / `SET` / `VAR` so a reader knows which to hold constant and which must vary. Filtering is by a published `COMMON_DEFAULTS` table — a match is dropped and listed in the appendix, a *deviation* is kept and flagged. Derives the camera capability envelope (granted mode list, constraint-solver snapping, refusal edges), the per-origin capture/encoder signature, and sensor quantisation steps. Ends with a canonical JSON block generated from the same objects as the prose, so the two cannot disagree. Never claims uniqueness or entropy |
| `deep-probe/zip-reader.ts` | Dependency-free ZIP reader: central-directory parse (index only — opening a 400 MB archive reads a few KB), `payloadStart` resolved from the *local* header, direct `Blob.slice` windows for stored entries, early-stopping `inflatePrefix` for deflated ones that reports whether it reached the end, and `verifyEntry` recomputing CRC-32 against the archive's own record. ZIP64, encryption and multi-disk are reported, never half-parsed |
| `zip-writer.ts` | Dependency-free ZIP writer, **store-only by default (method 0)** so archived media is byte-identical to the capture. Derived text may opt into DEFLATE via `compress: true` (platform `CompressionStream`, silently falling back to store when absent) — the CRC-32 in the header is always that of the *uncompressed* bytes, and `ZipEntryInfo.stored` records which entries can be carved directly. Blob parts are never concatenated (large clips stay on disk); CRC-32 streams 4 MB slices. Returns an offset/size/CRC table for every entry, and a `finalize` hook lets a report cite the real offsets of the entries above it. Also exports `verifyBytes` (one-pass compare + CRC) and `crc32OfBlob`. UTF-8 name flag on every entry; per-entry **and** whole-archive 4 GiB overflow are refused rather than silently truncated. Covered by `zip-writer.test.ts` |
| `evidence-pack.ts` | Evidence pack assembler: unaltered captures verbatim in `originals/`, app-encoded frames separated into `rendered-frames/`, derived renders with captions, per-file metadata **re-read from the archived bytes** (ExifReader + structural provenance walk), session log + capture ledger, deep report, threshold reference + engine docs, the byte-identity verification data, and the printable HTML/text overview that reconciles every score to its deductions. Declares each file's origin tier, verifies every archived payload against its source after the build, and records rather than hides anything it could not pack |
| `session-store.ts` | IndexedDB session persistence (6 h TTL, survives native-camera tab eviction) |
| `share-link.ts` | Compressed, self-expiring (72 h), fragment-only share links — no server storage |
| `utils.ts` | `cn` class-name helper |

## 6. Evidence pack export

Every flow and every standalone tool ends with one **Download Evidence Pack (.zip)** button
(`EvidencePackButton` → `lib/evidence-pack.ts` → `lib/zip-writer.ts`). Built entirely
on-device; nothing is uploaded.

Archive layout:

| Path | Contents |
|---|---|
| `READ-ME-FIRST.txt` | What each folder is, and how a score is read |
| `overview.html` / `overview.txt` | Verdict, per-file score reconciliation (every deduction with its exact points, summing to the score), coverage matrix, capture thumbnails, metadata summary, timeline, file list, and an explicit "not included — and why" section |
| `report/deep-report.txt` / `.json` | The surface's full forensic report (findings with observed vs expected, check ledger with threshold provenance, doc-data check digits, barcode, face distances, liveness/pulse, AI verdicts) |
| `originals/` | Media whose bytes the app did **not** author — camera files, platform stills (`ImageCapture.takePhoto`), MediaRecorder output — copied in byte-for-byte and stored uncompressed, so extracted bytes, EXIF and hash match the capture exactly. `originals/SOURCES.txt` states per file which capture path produced it |
| `rendered-frames/` | Frames the app itself drew from the live video track and JPEG-encoded (canvas grabs, silent stills, the liveness identity frame). **Never** placed in `originals/`, because they are not camera files and cannot carry camera EXIF. `rendered-frames/READ-ME.txt` spells out what that does and does not prove |
| `processed/<slug>/` | Derived renders (noise/edge/glare/ELA/frequency maps, video frame strips, the deskewed document crop, aligned face crops) plus `captions.txt` explaining how to read each one and stating plainly that these are renders, not captures |
| `metadata/<slug>.txt` / `.json` | Full readable tag dump plus the container-structure walk (containers parsed, structural containers explicitly marked benign, writer- vs content-tier provenance fields) |
| `log/session-log.txt` / `.json` | Complete end-to-end log, every entry, in order |
| `log/capture-ledger.txt` / `.json` | Capture feed ledger — feeds opened, requested vs granted, frames, clips, native round-trips (omitted for supplied-file tools, which have no monitored feed) |
| `reference/thresholds.txt` / `.json` | Every threshold, its value and its provenance class, including the `uncalibrated` ones that deduct nothing |
| `reference/engine/*.md` | The engine documentation, lazily imported so it never inflates the app bundle |
| `verification/byte-identity.txt` / `.json` | Every entry's exact size, CRC-32 and **absolute payload offset** inside the ZIP, with three independent ways to re-check them (`unzip -p` + `cmp`, `unzip -t` + `crc32`, or a raw `dd` carve that bypasses ZIP tooling entirely) |
| `MANIFEST.txt` | Every archived path with its exact byte size |

### Byte-identity: declared, routed, and verified

The pack's central claim is that a capture comes out identical to what went in. Three
mechanisms back it rather than one assurance:

1. **Origin is declared at the capture site, never guessed at export.** `PackMediaItem.origin`
   is a required field (`camera-file`, `supplied-file`, `platform-photo`, `recorder-stream`,
   `app-encoded-frame`). `LiveDocCapture` reports `platform-photo` when
   `ImageCapture.takePhoto()` wins and `app-encoded-frame` when it falls back to a canvas
   grab — a runtime difference the pack could not otherwise know. `originForCaptureEngine()`
   maps camera engines to `camera-file` and picker engines to `supplied-file`, so a photo
   chosen from the library is never described as fresh camera output.
2. **The folder follows the origin.** Only bytes the app did not author reach `originals/`;
   anything the app encoded goes to `rendered-frames/`. A mislabelled render therefore
   cannot occur by construction rather than by careful wording.
3. **The claim is tested, not asserted.** After the archive is built, every media payload is
   carved back out of the finished blob at its recorded offset and compared to the source
   blob byte-for-byte (one streaming pass, 4 MB at a time, CRC recomputed alongside).
   `PackResult.verification` carries the per-file outcome; `EvidencePackButton` shows it and
   logs every line, and a mismatch is reported loudly instead of being smoothed over.
   `src/lib/zip-writer.test.ts` locks the invariants: CRC-32 against the published check
   value, store-method headers with matching sizes, carve-at-offset equality over a payload
   containing all 256 byte values, multi-chunk payloads, and single-flipped-byte detection.

Other design rules: originals are never re-encoded (only extra thumbnails and derived
renders are generated); metadata is re-read from the archived bytes so the pack is
self-proving; the log states whether its 300-entry buffer actually truncated rather than
implying it always does; and a single missing artefact never fails the export — it is named
in the overview's completeness section and pushed to the log as a warning.

## 6b. Deep Probe raw dump export

`/deep-probe` produces a second, much larger archive from `lib/deep-probe/raw-pack.ts`. It
reuses the same ZIP writer and the same byte-identity discipline, but answers a different
question: not *is this capture authentic* but *what did this device actually hand over*.

| Path | Contents |
|---|---|
| `READ-ME.txt` | What each folder is, what the archive does and does not prove, and — when a stage did not run — exactly which one and why |
| `stat-sheet.html` / `.txt` | The full stat and spec sheet, copied in byte-identically from what was handed over on screen: the forensic item list, run summary, every request, everything taken without asking, sensor rates, the asked-versus-granted camera table with the silent substitutions called out, every photo in full, every omission and the re-verification instructions |
| `forensic-items.txt` | The forensic item list on its own — first in the sheet and standalone here, as asked |
| `log/build-trail.txt` | Wall-clock time at each stage of building this archive, so a build that dies next time can be compared against one that did not |
| `permissions/ledger.txt` / `.json` | Every request: API name, the moment it fired, your response time, what it reaches, how long the grant lasts, what came back, and the browser's own permission state before and after |
| `environment/passive-dump.txt` / `.json` | Everything readable with **no prompt at all**, plus `permissions.query` for every name any browser answers to |
| `sensors/*.csv` | One commented CSV per granted sensor, each stating the measured rate beside the requested one |
| `camera/matrix.txt` / `.json` | Every asked-versus-granted pair across every camera, size, ratio, frame rate and control mode that was sent, with a note beside each camera wherever its own advertised ceiling shortened its plan (§6b.14), plus the `stillPolicy` statement of which steps were expected to produce a photo and which rows deliberately produced none |
| `camera/memory-policy.txt` | The run's real memory figures — bytes held, the device's ceiling, the largest canvas used — and whether stills stopped early. Keeps the three causes of an empty capture list apart: never expected, attempted and failed, or stopped for memory |
| `camera/surface.json` | `track.getSettings()`, `getCapabilities()` and `getConstraints()` **verbatim** per camera — key order preserved, nested `{min,max}` ranges intact — plus `track.id` / `label` / `readyState`, `stream.id`, the `<video>` element's `videoWidth`/`videoHeight`, the measured `getUserMedia` open time, and `ImageCapture.getPhotoCapabilities()` / `getPhotoSettings()`. Read on the track the sweep already had open, so it costs no extra prompt and no extra camera cycle |
| `camera/devices.json` | Three `enumerateDevices()` snapshots with full untruncated IDs and every kind included: before any permission was requested, before the sweep opened anything, and after it finished. Two snapshots would be ambiguous about which moment they captured |
| `camera/files.json` | The `File` object as a site receives it — name, size, type, `lastModified` as the raw epoch value, `webkitRelativePath` — in arrival order, so the step between consecutive shots stays visible instead of hiding behind a formatted date |
| `correlation-brief.md` | Item-by-item answers to the forensic request, each pointing at the file that holds the evidence, headed by the capture-path table |
| `captures/` | Photos whose bytes the app did **not** author (camera files, platform stills), stored uncompressed |
| `rendered-frames/` | Frames the app encoded itself — kept out of `captures/` for the same reason `rendered-frames/` exists in the evidence pack |
| `raw/<slug>.hex.txt` | `xxd`-layout hex + ASCII — complete when the capture fits its share of the budget, otherwise an explicitly-labelled `WINDOWED` dump naming the exact skipped-byte count |
| `raw/hex-budget.txt` | The budget itself: total allowance, equal per-capture share, complete-vs-windowed counts, whether heap pressure throttled the build, what a window omits and the `xxd` command to recover any skipped range |
| `raw/<slug>.structure.txt` | Real container parse: every section's identifier, meaning, offset and length |
| `raw/<slug>.tags.txt` | Full tag listing **including undocumented entries** — the ones ordinary viewers hide |
| `raw/<slug>.encoder.txt` | The JPEG encoder signature: all 64 quantisation coefficients per table, Huffman tables marked standard or optimised, subsampling, frame mode, scan count, restart interval, APP order, thumbnail tables, ICC header, bytes after EOI |
| `raw/<slug>.ifd.txt` | The raw directory walk: every entry's tag ID, type, count and **stored** value, with rationals kept as `num/den` |
| `raw/segments/<slug>/*.bin` | Metadata regions carved out whole at their exact positions: EXIF block, maker note, ICC profile, embedded thumbnail, XMP, JUMBF/C2PA, Photoshop IRB |
| `checksums/` | MD5, SHA-1, SHA-256 and CRC-32 per capture, plus `checksums.md5` / `.sha1` / `.sha256` in the exact format `md5sum -c` and `sha256sum -c` read |
| `device-spec.md` | The distinctive-facts summary described below, also downloadable on its own |
| `verification/byte-identity.txt` | Size, CRC-32, storage method and absolute payload offset for every entry, with four independent ways to re-check them |
| `log/session-log.txt`, `MANIFEST.txt` | Full timeline; every path with its logical size, archived size and method |

Three things this archive is careful **not** to do:

1. **It never merges "you refused" with "your browser has no such API."** Availability is
   decided by feature probe before a request fires, so an absent API is recorded as never
   asked. Both the ledger and the overview keep the two visually distinct.
2. **It never claims exhaustive coverage.** The permission surface differs per browser and
   grows every release, so `permissions/ledger.txt` states plainly that it is a floor rather
   than a ceiling.
3. **It never implies a photo exists where none was expected.** The sweep takes stills at a
   declared subset of steps and says which, so an empty capture list on a frame-rate row
   reads as designed rather than as a failure.
4. **It never lets a production path be inferred after the fact.** Each capture's path is
   declared by the code that made it, at the moment it was made. That matters more than it
   sounds: a `getUserMedia` → canvas → `toBlob` photo has **no EXIF at all** — canvas
   destroys it — while an `<input type=file>` pick from the camera roll carries the **full**
   tag set. The two paths are opposites, so an absent tag block is the only possible outcome
   on one and a stripping event on the other. `correlation-brief.md` leads with that table,
   because applying the wrong target to the wrong exit is the easiest serious mistake to make
   with this archive.

Size control: captures are always stored (method 0) so they stay carvable, while the bulky
derived text opts into DEFLATE. Hex dumps compress heavily, which is what keeps a run with
100+ photos inside the ZIP format's 4 GiB ceiling.

The hex budget is not a size preference — it is what stops the tab being killed, and
`deep-probe/hex-budget.ts` holds the whole of it. One source byte becomes **4.94 characters**
of text, so a 150-photo run at 3 MB a photo (450 MB of source) is 2.2 GB of hex. Those dumps
are alive as blobs at the same time as the captures they describe, the DEFLATE output and the
assembled archive, and iOS Safari terminates a tab somewhere around 1–1.5 GB resident. An
earlier 192 MB budget therefore crashed the build outright rather than producing a large
archive. Three rules follow:

- **The allowance is device-derived, and "unmeasurable" means "assume little."** `deviceMemory`
  and `performance.memory.jsHeapSizeLimit` set it where present; WebKit reports neither and is
  also the strictest about killing tabs, so the unknown case is deliberately *not* the most
  generous. Hex text may claim at most 6% of a known heap ceiling.
- **The budget is shared equally per capture, never first-come.** Spending it in arrival order
  gave the earliest photos complete dumps and windowed the rest, which made the completeness
  of a dump a fact about *when a photo was taken* instead of about the photo. A floor keeps
  every capture's whole header region rendered however many there are; a ceiling stops one
  large file consuming a share it cannot justify.
- **Backing off is reported, not silent.** Where the browser exposes heap use, crossing 70%
  mid-build drops the remaining dumps to the minimum window and writes both a warning and a
  named omission — which reaches the on-screen list too, not just the archive.

What a window omits is worth stating precisely: the middle of a JPEG is entropy-coded scan
data, incompressible noise with nothing structural in it. Every region a forensic reader wants
— SOI, the APP segments, EXIF in full, the quantisation and Huffman tables, the ICC profile,
the thumbnail, SOF, the first SOS and any bytes after EOI — sits in the head or the tail and is
always rendered. The complete file is present and byte-identical in `captures/` either way, so
a window costs a convenience rather than evidence.

### 6b.8 Shape, not scene — `lib/deep-probe/capture-signature.ts`

A sweep of four cameras through eight resolution rungs and six aspect ratios down two paths is
well over a hundred files, and most of them were the same file twice. Same container, same
quantisation tables, same Huffman tables, same marker order, same metadata layout, same
dimensions — differing only in what the lens happened to be pointed at, which is the one thing
this app is not measuring.

So every still is reduced to a **shape** before it is kept, and a still whose shape is already
on file for that camera and that path is not stored. What the shape contains is the whole
argument, so the module states it in as many words:

- **In** — container, pixel dimensions, chroma subsampling, all 64 coefficients of every
  quantisation table, every Huffman code-length table, the marker sequence in file order, the
  APP segment identifiers, TIFF byte order, the directory sequence, the **tag IDs** each
  directory holds, the maker-note signature, and the colour profile's identity.
- **Out** — timestamps, GPS, exposure, ISO, aperture, orientation, the file's byte length and
  the compressed image data itself.

The tag IDs are the subtle case and the one that took the most care: the IDs are *layout* and
belong in the shape, while the values behind them are the *moment* and must not be. A camera
that writes its directories in a fixed order is telling you about its firmware; the exposure
time it wrote there is telling you about the light. Two photographs of two different scenes
from one camera at one setting are **meant** to collapse to a single shape — that collapse is
the measurement, not a loss.

The ID is sixteen hex characters from a doubled FNV-1a, chosen for being trivially
reimplementable rather than for strength: it is a comparison handle, and every component that
fed it is kept alongside so a match can be argued with instead of taken on trust. Reading it
costs a bounded 512 KB header slice, not a decode.

Scoping is per camera and per path, deliberately. The same tables coming out of two different
lenses is a real finding, so each scope keeps its own first copy and shapes appearing under
several scopes are reported separately as exactly that. Three further rules keep the collapse
honest: a dropped still is never counted as one that was taken, the slug counter only advances
on a kept file so the numbering carries no gaps, and the identity is written onto the row — a
repeat is evidence that two asks share one pipeline, which is worth more than a second copy of
a file already held.

### 6b.9 One file per side — `lib/deep-probe/manual-capture.ts`, `adaptive-manual.ts`

The manual stage is the only part of a run that spends the user's attention rather than the
device's time, and it used to spend six trips to the camera app on it: three routes, both
facings. On every device seen so far the three routes end at the same camera app and return the
same kind of file, so five of those six were another copy of an answer already in hand.

What the run actually needs from this stage is **one environment original and one user
original**, because those two files are the only ones in a whole run the camera itself wrote —
its own quantisation tables, its own maker note, its own colour profile, its own EXIF. So the
three routes are no longer three shots. They are one shot with two spares: `runManualShot()`
tries the first route, and if it fails outright or comes back empty it offers the next for the
*same side*, until that side has its file or the routes run out. Every attempt is recorded with
what came of it and travels with the file, so "the front camera answered on the second route
after the first came back empty" is a fact the archive holds rather than something a reader has
to infer from a gap. A side that exhausts every route throws `RoutesExhaustedError` carrying the
attempts, and the run reports them one by one — "the camera app failed" and "you closed it three
times" are different facts about a device, and `cancelledEverywhere` keeps them apart.

Closing the camera without taking a picture counts as a route that did not answer, so the next
is offered; the way to leave the stage is **skip**, which drops the whole shot. The shot wording
says exactly that, because a second camera opening with no explanation reads as a bug rather
than as a fallback — and the page announces each fallback route before it opens, for the same
reason. A library pick has one route and no spare: walking on would open a second picker for a
shot that was just declined, which is nagging rather than thorough.

When the first route answers, the spares were **never needed**, which is a different thing from
being skipped and is recorded as exactly that — the side is not missing anything, and the note
makes no claim about what the untried routes would have returned. `handoffDecision()` is gone
with the six-shot list it served; `routesNotNeededReason()` and `fallbackReason()` replace it.
The zoom rule is unchanged: three of the four viewfinder shots per camera exist to walk a zoom
range, and a camera that applied no zoom when asked has no range to walk.

The important asymmetry still holds: the sweep drops files it already took, but the manual stage
stops **asking** instead. A file someone stood still to produce is never discarded — same
saving, without the discourtesy — and every skip is listed on screen with the observation that
caused it, so a shorter list is never a quieter one.

### 6b.10 What the pixels say — `lib/deep-probe/pixel-probe.ts`

Everything else in a run reads headers, which is what the writer *chose* to record. The decoded
picture is the other kind of evidence, and consolidation is what made it affordable: once the
capture list is a dozen genuinely different files rather than two hundred near-identical ones,
a bounded 512×512 centre sample per capture costs little.

**The decode itself was the first bug, and it was silent.** A browser will happily rotate a photo
to its EXIF orientation and convert its colours to the display profile *before* handing over any
pixels, and this pass asked for neither to be suppressed. A quarter turn swaps the block grid's
two axes, which is the difference between an ordinary photograph and an accusation of
recompression; a colour conversion rewrites every channel mean as partly the browser's
arithmetic. Both are now switched off through `createImageBitmap`, and whether the browser
*understood* being told is established rather than assumed: an options-bag member a browser knows
throws `TypeError` on an illegal value, and one it has never heard of is ignored in silence, so a
one-pixel probe distinguishes the two. Where support cannot be established the report says
`not established` and never either answer; where it is absent, the reading warns that the grid's
axes may be the browser's rather than the file's.

Six measurements. The **8×8 block grid**: a grid on the boundary is just this file's own
compression and is reported as the non-finding it is, while a grid *off* the boundary means the
picture was compressed, then cropped or shifted, then compressed again — which a frame straight
from a camera cannot be. The **2×2 colour-filter rhythm**: three quarters of the red and blue in
a finished photograph were interpolated from neighbours, and that interpolation leaves a
four-phase structure a render or a rescale does not — the closest this app comes to asking *was
this ever a photograph*. The **sensor pipeline**: channel balance, tone histogram, clipping **per
channel** as well as across all three, and a noise floor measured only in the flattest tiles and
reported per colour. The **tone range**, where regularly spaced empty levels are what a
post-capture brightness or contrast stretch leaves behind. And the frame **from the middle out**:
centre and four corners, the luma falloff between them, and whether the noise floor is even
across the frame.

Three of those exist because the old figures were measuring the subject rather than the device.
The noise floor was taken across the whole patch, so it rose on a bookshelf and fell on a wall
and neither movement had anything to do with the sensor; restricting it to the quietest tiles
removes most of the scene, and splitting it by channel exposes the thing that genuinely is a
device trait — red and blue are interpolated far more heavily than green in every Bayer
pipeline. Clipping was counted only where all three channels were pinned at once, so a sky blown
out in blue alone registered as nothing. And only the dead centre was sampled, which threw away
corner falloff entirely — a real per-model trait, and the one check on whether corner
amplification has left the noise floor uneven.

Five rules, because a pixel statistic is the easiest thing in forensics to over-read. Scene‑
dependent numbers are labelled scene-dependent and are comparable only between photographs of
the same scene. A frame this app encoded from a video track *will* show recompression, because
that is literally what it is, and the report says so itself rather than leaving a reader to
discover it — and its colour-filter reading is stamped as proving nothing either way, because a
video track is chroma-subsampled and re-encoded twice before this app sees it. **Absence is never
proof**: no 2×2 rhythm can mean a synthetic picture or simply one compressed hard enough to
erase it, and the reading says both, every time. The sample origin is forced onto an 8-pixel
boundary — which is even, so the colour-filter phase survives the crop as well — so the sampling
cannot create the misalignment it is looking for. And an axis with no measurable periodicity has
**no phase**: taking the winner of eight near-identical numbers would manufacture an offset out
of noise, and an offset is this pass's one serious claim. Nothing here produces a verdict, a
score or a probability.

### 6b.11 What holds, and what moves — `lib/deep-probe/constancy.ts`

A spec listing one photograph's tables is a description of one photograph. What someone
reproducing this device needs is the level up: which traits are true of it whatever you ask,
which change with the production path, which belong to one lens, and which follow the frame
size. Hold the wrong one constant and the result is wrong in a way no single-file comparison
would catch.

Each trait is classified against scopes tested in order of how fundamental they are — path,
then camera, then size — so a trait fitting several is filed under the one that explains it. The
conservatism is the point: a trait is only **universal** when it held across more than one
scope, so one value seen ten times down a single path on a single camera reads as
`unestablished` rather than as a law. A trait no capture could observe is dropped rather than
reported empty, and the coverage the classification rests on is printed above it.

### 6b.12 What the sensor rows say — `lib/deep-probe/sensor-stats.ts`

The recorders were careful to keep every reading at full precision — the comment in `sensors.ts`
says so explicitly, because rounding first would replace the device's real step with our
formatting choice — and then nothing ever looked at them again. Each series reported how many
samples arrived and how fast, and four of the strongest traits in a motion trace sat in the rows
unmeasured.

The **quantisation step** is the smallest non-zero gap between distinct readings, which on real
hardware is the analogue-to-digital converter's own resolution. Synthetic data is almost always
continuous where real data is not, which makes this both a device fingerprint and the cheapest
sanity check on a trace there is. The **repeats** matter because several platforms deliver an
event on a timer and re-send the last reading when the sensor has not moved on: a rate counted
from events is then the *timer's* rate, and quoting it alone overstates the hardware by whatever
the ratio is — so the delivery rate and the distinct-reading rate are now reported side by side.
The **regularity** of arrival separates a hardware interrupt from a JavaScript queue far more
clearly than the mean rate does; a metronome and a jittery queue can share a rate and share
nothing else. And the **gravity constant** is `accelerationIncludingGravity` minus
`acceleration`, whose magnitude is the constant that firmware was built with — 9.81, 9.80665 and
a plain 9.8 are three different vendors' choices, and a device states which it uses without
being asked. A wide spread there means the phone was moving while the window ran, so the figure
is reported with its spread rather than as a clean constant.

Every recorder ends through one `withStats()` call, so no path can produce a series whose rows
were never analysed — which is how the analysis went missing in the first place. Columns whose
name marks them as a clock are excluded, but `interval_ms` deliberately is not: the interval a
motion event reports about *itself* is a device fact, not a timestamp.

### 6b.13 The 640-only investigation — `lib/deep-probe/width-probe.ts`, `run-mode.ts`

One question, asked twice: what does this phone do when a site sends
`{ video: { width: 640, facingMode } }` and nothing else? That is the request real sites actually
make — video-chat pages, scanners and document uploaders overwhelmingly send a bare width and
let the platform fill in the rest — and what the platform fills in is undocumented. Which
physical camera opens? What height comes back? What aspect ratio and frame rate does it settle
on? Is 640 even honoured, or quietly rounded to whatever the sensor scaler prefers?

The sweep cannot answer it, and not by accident: `camera-matrix.ts` pins the device by
`deviceId` and states both dimensions exactly, because it is measuring the **range** a camera
supports. This measures the **default** a camera falls back to, which is the opposite kind of
request — so it is a separate mode rather than another row, and it is filed separately in the
archive (`camera/width-640.txt` / `.json`) for the same reason. Folding the two together would
make each one read as the other.

The mode is chosen on the way in, from the setup screen, because it decides what the run *is*.
It is persisted for the same reason the export choice is, and an unreadable stored value falls
back to the **full** run: someone who does not remember choosing should get the run this page is
for, not a one-minute subset of it. In this mode only the camera permission is requested, the
sensor stage and the manual stage do not run, and all three are named in the omissions list as
deliberately absent — not refused, not failed. Stop and pause are checked between facings and
between stills, so both controls behave exactly as they do in the full sweep.

Two opens, and two stills per open down the two paths that exist — the browser's own photo
pipeline and a frame this app encodes from the track — because those paths are opposites, and
having both is what makes the files readable against each other. The width verdict is `exact`,
`near` (within 32 px), `different`, or `unknown` when the track reported no width at all;
`different` is the interesting one, because it means a bare width is a *wish* on this device
rather than an instruction. A `facingMode` the track disagrees with is reported as a finding
rather than an error, and a track with no label leaves the camera unnamed rather than guessed at
from the device list.

### 6b.14 Asking less — `camera-matrix.ts`, `DeepProbe.tsx`

The run was long in three places, and all three were length without evidence.

**The plan is built from the camera's own answer.** Every camera used to get the same 28-step
plan: seven rungs in both orientations, six ratios, five frame rates. That meant asking a 720p
front camera for 8K, 4K and 1440p and asking a 30 fps sensor for 60 and 120 — questions the
camera had already answered in `getCapabilities()` before the first one was sent, at the cost of
one camera open each. The native-maximum step now runs first and reads the ceiling, and
`planFor(deviceId, ceiling)` builds the rest from it: rungs above `width.max`/`height.max`, rates
above `frameRate.max` and ratios outside the advertised `aspectRatio` range are not asked for, and
the camera's own figures are quoted in a note beside the camera wherever that shortened its plan.

**One over-ask survives in each direction, deliberately.** Whether a camera CLAMPS to its ceiling
or REFUSES outright is a real difference between platforms and is not in the capability object, so
exactly one rung and one frame rate above the ceiling are still sent. The rungs beyond would each
answer the same way.

**A shorter ladder.** 8K went (no phone camera has ever granted it, and the native-max row already
asks for the ceiling with `ideal`), 1440p went (it resolved to a neighbouring rung on every device
seen), QVGA went (VGA already probes the bottom). 3:2, 9:16 and 21:9 went — 9:16 is 16:9 turned
round, which the **one** portrait ask now covers, where portrait used to be asked once per rung.
24 fps went, sitting between 15 and 30.

**A photograph is not taken twice of the same size.** The shape ledger (§6b.8) compares bytes
*after* a still exists; `photographedSizes` stops the still being taken at all when this camera has
already been photographed at the size this row was granted, on that path. Those rows carry a
`taken: false` entry naming the file that already holds that size, so the row still says what
happened. At the native maximum only the platform photo path runs: a canvas frame at 4K is several
megabytes this app encoded from the video track — the least evidential and most expensive file the
sweep could hold — and the canvas path is exercised at every smaller rung anyway.

**The flash fires once per run.** Every rear camera on a phone drives the same LED, so the second
camera to advertise a torch is advertising the first camera's torch. Cameras after the first record
that the torch was not fired again, name the camera it fired on, and claim nothing about whether
their own constraint would have been granted.

**An identical control surface is not walked twice.** A second camera advertising the same focus,
exposure, white-balance and resize lists, the same zoom range and the same torch flag skips the
mode-by-mode block. The note says exactly what that is: a decision about where the run spends its
time, *not* a claim that the camera would have answered the same way — nothing about its control
behaviour beyond the advertised surface was recorded, and the absence is stated rather than filled
in.

**Four hand-held shots per camera became two.** Full frame, then one zoom shot at the maximum —
the middle of a range is the least informative point on it, and the full-frame shot is already the
other end. The zoom shot is only asked for where the **sweep** watched that camera's zoom actually
move: two distinct `zoom` values across its own zoom rows. A camera that reported the same value at
both ends is not asked to demonstrate that by hand, and the shot it was not asked for is listed as
a skip carrying the sweep observation that caused it.

### 6b.6 The camera deadline — `lib/deep-probe/camera-timeout.ts`

`getUserMedia` has no timeout of its own. A camera that is busy, mid-rotation or simply
confused by the two hundredth constraint change in a row does not reject — it never settles,
and every stage queued behind it waits for ever. That is the shape of a run that appears to
freeze on one camera with no error and no way forward.

Every camera request in Deep Probe now runs under a deadline. `CAMERA_OPEN_TIMEOUT_MS` is ten
seconds and applies wherever the permission answer is already in: each sweep step, the
control-mode reopen, `openDeviceSession` behind the viewfinder, `ImageCapture.takePhoto()`
(which hangs on the same devices and for the same reasons as the open does) and the
microphone open in the sensor stage.

Two rules keep the deadline honest.

**A timeout is a result, not a refusal.** It is written into the row as what it is and never
rewritten as something the device said. `OverconstrainedError` is a camera stating a limit and
is the point of the sweep; a timeout is the request being abandoned so the sweep could
continue, and `matrixText` prints `CAMERA_DEADLINE_POLICY` above the rows to say so in as many
words. The timeouts are counted and summarised in the notes, so a run that mapped little
because the hardware kept stalling cannot read as a run that mapped little because the hardware
refused.

**The abandoned request is adopted, not orphaned.** A `getUserMedia` promise that resolves
after the deadline hands over a *live* camera, and dropping the reference leaves the sensor
running and the privacy indicator lit for the rest of the session. Every late stream is stopped
the moment it arrives, the late answer is recorded with the time it actually took, and a
rejection that lands after the deadline is swallowed rather than raised a second time.

The permission prompt is deliberately excluded from the ten seconds and given
`PROMPT_ANSWER_TIMEOUT_MS` (sixty) instead. That clock is mostly a person reading a dialog, and
a ten-second cap there would file "still reading" as "said no" — then skip both camera stages
on the strength of it, which is precisely the dead end §6b.4 exists to prevent. The long
allowance exists only so a genuinely hung prompt cannot strand the run for ever; when it
expires the outcome is `dismissed` with a detail that states plainly this was not a refusal.

### 6b.7 The two originals that survive the release — `lib/deep-probe/originals.ts`

A run without the archive ticked drops each photo's bytes the moment its facts are read. That
is what keeps a two-hundred-photo sweep inside a phone browser's memory, and it is the right
default — but it also threw away the two most valuable files in the run.

The camera-app handoffs are the only path that yields a file the *camera* wrote: its own
quantisation tables, its own maker note, its own colour profile, its own EXIF. Everything else
is a canvas encode (no metadata at all, by construction) or a platform still (almost none). So
the back-camera and front-camera files are held back from the release and offered as plain
downloads — the `File` object the OS handed over, saved with not one byte altered: not
re-encoded, not re-compressed, not stripped, not stamped, not wrapped in a container. The
checksums already in the sheets therefore describe the file on disk exactly.

`readCaptureFacts` takes a `keepSlugs` set and returns the captures it held, and their bytes are
deliberately *not* subtracted from the held-bytes counter — they really are still held, and a
counter that said otherwise would be reporting the memory it wished it had used.

The selection rule carries the weight. Only `path === "camera-file"` **and**
`origin === "camera-file"` qualifies, both checked rather than either: the two are declared
independently at the moment of capture, and a disagreement means something is wrong upstream.
A library pick has metadata every bit as rich — that is exactly why §6b.5 takes two of them —
and is still never eligible, because a button reading "camera original" over a file chosen from
the library is the precise lie this module exists to prevent. A facing that produced nothing
says so, with a reason, and refuses to guess whether the shot was skipped or failed.

### 6b.5 The library pick — the missing half of the central comparison

The correlation brief opens with one claim above all others: a photo reaching a server through
`getUserMedia` → canvas → `toBlob` has **no EXIF at all**, while one arriving through
`<input type=file>` carries the full tag set. The run had rich evidence for the first half — every
sweep frame is a canvas encode — and, for the library half, nothing. Item 0.2 was the run's only
`NOT RUN`, and it was the one the headline rested on.

It was excluded on principle rather than by oversight: `manual-capture.ts` refused picker engines
because a pick cannot promise a fresh photo. That reasoning holds for a shot *presented* as a
camera handoff, and not at all for a shot asked for as what it is. The picks are now taken
explicitly as library files, resolve with `origin: "supplied-file"` and `path: "picker-file"`, and
the page no longer hardcodes `camera-file` for everything in the manual stage — the spec decides
the path, so a picker can never inherit a camera's label by being routed through the same branch.
A library spec also carries `facing: null`, because a facing on a picked file would be a fiction.

There are two picks, and they differ only in the `accept` attribute — which is the measurement,
not a detail. iOS transcodes HEIC to JPEG for an input asking for `image/*`, and hands over the
stored bytes to one that names HEIC explicitly. Asking twice for the same photo separates two
situations that are indistinguishable from a single upload: a library that really holds JPEG, and
a library holding HEIC with the browser converting on the way in. Where the two come back in
different formats the archive reports a browser-side conversion *observed*, not inferred.

What this deliberately does not do is promote the conclusion. Item 0.9 ("Most Compatible" vs
"High Efficiency") stays `partial` even when the transcode is caught in the act, because the
setting is never exposed to a web page and one photo's format is not a device-wide setting. Item
0.1 stays `not-obtainable` even when an untranscoded HEIC is in hand: it is the nearest lawful
approximation and is described as one, since it proves nothing about what happened between the
shutter and the library. Only 0.10 moves — a GPS directory in a picked photo answers the location
question as well as a camera file does, so its gate widened from camera files to all file-path
captures.

### 6b.4 One door out, and a stepper that does not flatter the run

"I can't see the deep probe various final options" turned out to be literal, and the cause was
not the export screen at all — it was three routes that never reached it.

Stages 1–4 each decided their own next phase. Two of them chose correctly; three jumped straight
to `building`:

- camera permission refused, so both camera stages are skipped;
- Stop pressed during the sensor recordings;
- Stop pressed during the camera sweep.

Stage 7 opens by reading `sheetsRef.current`, which stage 6 fills. Arriving there without passing
through stage 6 finds it `null`, and the builder does the honest thing: it refuses, sets
`archiveFatal` and jumps to `done`. The result is a red "this is a bug" card and nothing else —
no sheets, no spec, no viewer, and no tick boxes, because the tick boxes live in stage 5. The two
routes that did work were the two that wait idly for input, so anyone stopping mid-work hit a dead
end and anyone refusing the camera prompt hit it without touching anything.

The fix is structural rather than three patches. `toExports(...omissions)` is the single door out
of the gathering stages: it records the omissions, stamps `finishedAt` and moves to stage 5. It is
idempotent through the existing `ranRef` set, which matters because the sweep notices an abort
*after* its current step finishes — without the guard a late notification could drag a run
backwards out of `reading`.

The stepper was flattering the result in the same way. `state` was derived from position alone
(`phase === "done" || mine < order`), so at the end of a run every stage was behind the pointer
and every stage wore a green tick — including a camera sweep that never ran because the prompt was
refused. Stages now carry a recorded mark (`done` / `skipped` / `stopped` / `failed`) written at
the moment they end, and a recorded mark always beats position. A run that skipped half of itself
now looks like one.

### 6b.3 The archive is opt-in, and the crash has to testify

Repeated reports had the browser dying "every single time" the archive step began. Two things
followed from that, and only one of them is a fix.

**The sheets stopped being hostages.** The stat sheet, the correlation brief and the device spec
were all built *inside* `raw-pack.ts` and returned only if the ZIP survived — so the cheapest,
most useful products of a twenty-minute run died with the most expensive and most fragile one.
The pass is now split three ways: `capture-facts.ts` walks each capture once, `sheets.ts` writes
everything from the result, and `raw-pack.ts` consumes both. A crash at archive time now costs the
dump and nothing else. The archive itself is a tick box, **off by default**, and unticking it
releases each photo's bytes the instant its facts are read — which is why the choice is offered
*before* the read rather than after, and why the consequence (no archive from this run) is stated
on the box rather than buried.

**The crash was made to testify.** A tab killed by the OS runs no handler and logs nothing, so
`crash-trail.ts` writes each step to `localStorage` *before* it runs. The decisive measurement is
a heartbeat on a 250 ms timer: a blocked main thread cannot service a timer, so if the last tick
lands as a step begins, that step froze the thread and the page was killed for not responding; if
ticks carried on for seconds into the step and then stopped dead, the thread was healthy and
something else ended the tab — which on a phone means memory. Heap figures corroborate where the
browser reports them, and WebKit reports neither, which is exactly why the heartbeat rather than
the heap is the primary signal. Where the evidence does not decide, the report says
`undetermined` rather than picking one.

Both candidate fixes were applied, because both were cheap and only one needed to be right:

- **Breathing.** `breathe.ts` returns control to the browser on a time cadence through every long
  pass — the facts walk, the hex renderings, the segment carving, the assembly and the
  re-verification. `scheduler.yield()` where it exists, a `MessageChannel` macrotask otherwise,
  because a nested `setTimeout(0)` is clamped to 4 ms after five levels and over a thousand
  iterations that clamp alone is four seconds.
- **Fewer walks, no duplicated buffers.** The encoder parse, the IFD walk and the tag dump used to
  read the bytes separately; they now share one read. Segments are carried as lazy `Blob.slice`
  views the ZIP writer reads once each, and the re-carve verification streams rather than
  materialising the archive twice.

### 6b.2 Sweep memory — the costs a byte counter cannot see

A run died mid-sweep at 106 photos with 129.75 MB of captures held. That figure is the proof
rather than the cause: 130 MB of blobs is survivable, and the on-screen counter was reporting
the only cost that was not dangerous. Two larger ones were never counted.

**Canvas backing store.** A canvas sized to a 4K video frame holds 3840 × 2160 × 4 = **31.6
MiB** of pixels; an 8K frame holds **126.6 MiB**. The sweep takes a canvas still at the native
maximum, at every landscape rung and at every aspect ratio — roughly 14 per camera, so ~56 on
a four-camera phone. Allocating a fresh canvas per still, as the sweep did, asks for **1.77
GiB** in about two minutes. A detached canvas is reclaimed whenever the collector chooses, and
WebKit caps *total* canvas memory per tab separately from the JS heap, so nothing about the
run gave it a chance to keep up. One canvas is now reused for the entire run and its pixels
are released the instant each encode resolves — peak cost is one frame instead of one per
photo, and `releaseCanvas` sets the dimensions to zero because dropping the reference alone
leaves tens of megabytes resident for an unpredictable stretch.

**Image decoding for two numbers.** Width and height were read by loading each platform still
into an `Image` — a complete 4K decode, another ~31.6 MiB, held in the engine's cache well past
the read. Both numbers are written in the file's header, so they are now parsed from it. That
is not only cheaper but *more accurate*: the header reports what the file declares, where a
decode reports what the decoder produced after applying orientation. Unrecognised containers
still fall back to a decode, and the reading records which method produced it.

**The ceiling, and what it gives up first.** Held bytes now have a declared ceiling. When it is
reached the sweep keeps making every request and recording every asked-versus-granted row —
those cost nothing to hold and are the actual product of this stage — and stops only taking
stills. Spending the last of the memory on more near-identical frames while abandoning the
cheap complete record would be precisely the wrong trade. The ceilings sit well above what a
full sweep produces, because a bound set near the observed 130 MB would cut off healthy runs
that were never the problem. It is reported as a warning, a named omission and a line in
`camera/memory-policy.txt` — and the video dimensions are still read for skipped rows, since
that reading costs nothing and its absence would make a row look less complete than it is.

### 6b.1 `device-spec.md` — the distinctive-facts summary

The archive answers *what did this device hand over*. The spec answers the narrower
question **what about this device is not true of every other phone**, in a few pages instead
of a few hundred megabytes. Offered as its own download on the results screen and written
into the archive.

The entire value is in what it leaves out, which is also exactly where a tool like this
would start lying — so three rules govern the filter:

1. **"Distinctive" is a declared classification, not a measurement.** The app sees one
   device and cannot observe a population, so it never reports entropy, rarity or a
   fingerprint score. It says only that a value differs from a documented common default,
   and it publishes that default list (`COMMON_DEFAULTS`) inside the file so the judgement
   can be checked and overridden.
2. **When in doubt the row is kept.** A dropped fact is invisible; a redundant one costs a
   line. Only confidently near-universal readings are dropped, and every dropped one is
   named in the appendix.
3. **A deviation outranks an unusual-looking value.** A reading that differs from a common
   default is flagged `!` and repeated in a "start here" block, because that is the strongest
   evidence in the file.

Every fact carries a stability tag, which is what makes the spec usable rather than merely
accurate: `HW` fixed to the hardware, `OS` moves with the browser version, `SET` a user
setting, `VAR` changes between runs. **Pinning a `VAR` value is as wrong as getting an `HW`
value wrong** — a battery level that never moves describes a recording, not a phone.

Two further exclusions worth naming. Permission *answers* are omitted entirely (a decision
about the run, not a property of the device); only which permission names the browser
implements is recorded. Per-shot metadata — exposure, ISO, timestamps — is excluded from the
capture signature in favour of the device-constant tags and the tag *schema*, since copying
per-shot values across every frame is itself a tell.

### 6b.2 `/archive` — reading it back

`ArchiveViewer` opens a downloaded archive on the phone through `zip-reader.ts`. It renders
bytes with the same `hexLines` formatter the archive's own dumps use — two different hex
layouts for one file would invite a reader to think they were looking at two files.

The asymmetry between stored and deflated entries is surfaced rather than smoothed over,
because it is the practical consequence of the archive's central design choice: a stored
capture supports instant random access at any offset, while a deflated report must be
inflated from the start every time. The viewer says which it is doing and why.

It is deliberately **not** presented as the authority. The archive is built to outlive this
app, every report inside it explains how to verify it with standard tools, and the viewer
states that when it and `unzip` disagree, `unzip` wins.

## 7. Environment & configuration

- `EXPO_PUBLIC_TOOLKIT_URL` + `EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY` — Rork Toolkit proxy
  credentials for AI verdicts and vision OCR. When absent, `aiVerdictAvailable()` is
  false and the coverage matrix honestly reports those checks as **unavailable** with the
  reason; everything else runs fully on-device.
- HTTPS (or localhost) is required for `getUserMedia`; the app detects and explains a
  non-secure context.
- PWA basics: `public/manifest.webmanifest` (standalone, portrait, dark theme),
  icons, and meta tags in `index.html`.

## 8. Testing & builds

- `bun run test` — vitest unit tests plus a Playwright-driven browser config
  (`vitest.browser.config.ts`). `src/lib/zip-writer.test.ts` guards the evidence pack's
  byte-identity guarantee (see §6); `src/lib/deep-probe/deep-probe.test.ts` holds the raw
  dump to account — MD5 against the published RFC 1321 vectors (plus multi-block and
  all-256-byte-values cases), structural offsets checked by seeking to them and asserting
  what is there, segments proven never to run past end-of-file, hex dumps checked for exact
  `xxd` layout and for honest `WINDOWED` labelling, and the permission registry checked for
  unique ids, properly nested tiers, a stated reach/duration on every request, and a written
  reason wherever it demands a tap. `src/lib/deep-probe/archive-tools.test.ts` covers the
  reader and the spec: the reader is checked *against the writer* (resolved payload offsets
  must equal the offsets the writer recorded), a stored payload must return byte-for-byte
  from an arbitrary window, and a single flipped byte inside a built archive must be caught
  — a verifier that only ever says "fine" is worse than none. The spec is checked for
  dropping boilerplate, keeping and flagging deviations, tagging volatile readings, keeping
  camera originals separate from app-encoded frames, and never claiming uniqueness.
- `bun run build` — production build to `dist/`.
- Type checking is strict; lint via `bun run lint`.
