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
(prompt count, minutes, photo count, archive size) and a three-position scope toggle
(`standard` / `extended` / `everything`, the last one explicitly flagged as reaching data
belonging to other apps).

1. **Permission sweep** — one card per request, stating what the site can reach and how long
   the grant lasts *before* it fires. Auto-advances on a 4 s countdown that pauses while the
   page is hidden, and falls back to a tap target wherever the browser demands transient
   activation (the card says which browser rule and why). Outcomes are `granted` / `denied` /
   `dismissed` / `unavailable` / `skipped` / `error`; **`unavailable` is detected by feature
   probe before firing**, so a missing API can never be recorded as a refusal. Nothing is
   retried.
2. **Sensor recordings** — for each granted sensor, a real timed sample with the *measured*
   rate reported next to the requested one.
3. **Camera sweep** — `lib/deep-probe/camera-matrix.ts`, with live photo / byte / elapsed
   counters and a stop button. Watches `PressureObserver` where available and surfaces a
   load warning explicitly labelled as load, not temperature.
4. **Manual shots** — every named camera in the pinned viewfinder plus three zoom steps each,
   then both facings through all three camera-app handoffs.
5. **Archive** — `lib/deep-probe/raw-pack.ts`, then every capture is carved back out of the
   finished blob and compared byte-for-byte, with the result shown on screen.

Stopping at any point keeps everything gathered; the remaining stages are pushed onto the
omission list with a reason and the archive is named `…-PARTIAL.zip`.

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
| `deep-probe/sensors.ts` | Timed recorders for motion, orientation/compass, geolocation (watched until the accuracy figure settles), microphone loudness (level only — no audio is retained), and the generic sensors. Every series reports the **measured** rate beside the requested one and exports as commented CSV |
| `deep-probe/camera-matrix.ts` | The exhaustive sweep: per camera, native max + the full resolution ladder in both orientations, six aspect ratios, five frame rates, then every advertised focus / exposure / white-balance / resize mode, zoom extremes and torch applied to a live track. Records asked vs granted for every row; a rejection is a result, not an error. Stills are taken at a declared subset of steps and `stillPolicy` states exactly which, so an empty capture list is never mistaken for a failure. Leaves the torch off on exit |
| `deep-probe/manual-capture.ts` | The three camera-app handoffs (`native-camera`, `capture-boolean`, `capacitor`) driven imperatively, capturing the change event's trust at event time. Picker-only engines are excluded — they cannot promise a fresh photo, so asking for one here would mislead |
| `deep-probe/hashes.ts` | MD5 (streaming, pure TS — Web Crypto dropped it), SHA-1 and SHA-256 via `crypto.subtle`, CRC-32 via the ZIP writer. MD5 is labelled an integrity check, never a security claim; digests that cannot be computed say so instead of being omitted. Verified against the RFC 1321 vectors in `deep-probe.test.ts` |
| `deep-probe/raw-bytes.ts` | The raw dump: `hexDumpBlob` renders `xxd`-layout hex + ASCII in slices assembled as Blob parts (a windowed dump is labelled `WINDOWED` with the exact skipped-byte count, never silently truncated); `walkStructure` really parses JPEG / PNG / ISO-BMFF / RIFF and reports every section's true offset and length; carved regions cover the EXIF block, maker note, ICC profile, embedded thumbnail, XMP, JUMBF/C2PA and Photoshop IRB. Unknown containers are admitted as unknown rather than guessed |
| `deep-probe/raw-pack.ts` | The raw dump archive: captures stored verbatim (`captures/` vs `rendered-frames/` by declared origin), per-capture hex dump + structure map + full tag listing **including undocumented entries** (`includeUnknown`), carved segments, four checksums plus `md5sum`/`sha256sum`-format digest files, the permission ledger, passive dump, sensor CSVs, camera matrix, session log, byte-identity data and an HTML overview. Post-build it re-carves every capture from the finished blob and compares. Names the file `…-PARTIAL.zip` and lists every omission when a stage did not run |
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
| `overview.html` | Readable summary: outcome counts, the full request table, a passive-dump extract, sweep totals, sensor rates, the photo table with SHA-256, and the re-verification instructions |
| `permissions/ledger.txt` / `.json` | Every request: API name, the moment it fired, your response time, what it reaches, how long the grant lasts, what came back, and the browser's own permission state before and after |
| `environment/passive-dump.txt` / `.json` | Everything readable with **no prompt at all**, plus `permissions.query` for every name any browser answers to |
| `sensors/*.csv` | One commented CSV per granted sensor, each stating the measured rate beside the requested one |
| `camera/matrix.txt` / `.json` | Every asked-versus-granted pair across every camera, resolution, ratio, frame rate and control mode, plus the `stillPolicy` statement of which steps were expected to produce a photo |
| `captures/` | Photos whose bytes the app did **not** author (camera files, platform stills), stored uncompressed |
| `rendered-frames/` | Frames the app encoded itself — kept out of `captures/` for the same reason `rendered-frames/` exists in the evidence pack |
| `raw/<slug>.hex.txt` | Complete `xxd`-layout hex + ASCII of every byte, or an explicitly-labelled `WINDOWED` dump naming the exact skipped-byte count |
| `raw/<slug>.structure.txt` | Real container parse: every section's identifier, meaning, offset and length |
| `raw/<slug>.tags.txt` | Full tag listing **including undocumented entries** — the ones ordinary viewers hide |
| `raw/segments/<slug>/*.bin` | Metadata regions carved out whole at their exact positions: EXIF block, maker note, ICC profile, embedded thumbnail, XMP, JUMBF/C2PA, Photoshop IRB |
| `checksums/` | MD5, SHA-1, SHA-256 and CRC-32 per capture, plus `checksums.md5` / `.sha1` / `.sha256` in the exact format `md5sum -c` and `sha256sum -c` read |
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

Size control: captures are always stored (method 0) so they stay carvable, while the bulky
derived text opts into DEFLATE. Hex dumps compress heavily, which is what keeps a run with
100+ photos inside the ZIP format's 4 GiB ceiling. Beyond a source-byte budget the dumps
switch to head+tail windows and say so, both in the file and in the on-screen warnings.

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
  reason wherever it demands a tap.
- `bun run build` — production build to `dist/`.
- Type checking is strict; lint via `bun run lint`.
