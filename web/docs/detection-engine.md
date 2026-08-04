# Detection Engine — Technical Reference

The forensic core of the app (`src/lib/fraud-detection.ts`, engine stamp
`verification-hub-forensics/2.5`) plus its supporting analyzers. This document covers the
scoring model, verdict rules, every signal family, and the calibration policy that keeps
false positives out.

---

## 0. Threshold provenance rule (engine 2.5)

**A number may only change a score if its origin is defensible.** Every scoring threshold
lives in `src/lib/thresholds.ts` with an explicit `provenance`:

| Provenance | Meaning | Scores? |
|---|---|---|
| `browser-invariant` | Guaranteed by the web platform; impossible in a genuine capture | yes |
| `spec-defined` | Fixed by ISO 7810 / ICAO 9303 / ITU-T T.81 / EXIF / IPTC | yes |
| `physical-limit` | Hard limit of real optics or sensors | yes |
| `calibrated` | Derived from measured captures on this device | yes |
| `uncalibrated` | Measurable, but no proven separation yet | **no — weight 0** |

`uncalibrated` checks are still measured and printed in the report with their raw values;
they deduct nothing. `resolveThreshold()` promotes them to `calibrated` only when
`src/lib/calibration.ts` has demonstrated separation between genuine and fraudulent
captures. This is why a report can say “measured 7.4×, not scored” — that is the honest
state, not an omission.

### Audit buckets (2.4 → 2.5 review of every criterion)

**Rebuilt** — right idea, wrong maths:

| Criterion | What was wrong | Now |
|---|---|---|
| `editor-fingerprint` | Whole-file ASCII grep hit the APP13 `Photoshop 3.0` IPTC container that phones write → accused nearly every genuine photo (−14) | Field-scoped provenance scan (`metadata-provenance.ts`); only writer-tier fields can accuse |
| `ai-signature`, `ai-source-type`, `ai-parameters`, `ai-c2pa` | Same raw-byte grep | Same field scoping; `DigitalSourceType` and PNG parameter chunks read structurally |
| `screen-replay` | Autocorrelation on a 900px downscale, fired at 0.24; lattice is sub-Nyquist there and text/JPEG grid inflate it | `screen-lattice.ts`: spectral peak prominence on native-resolution tiles, JPEG 8/16px periods excluded, axis agreement, two-signal corroboration |
| `doc-structure` | “≥35% pixels brighter than luma 195” | `document-locate.ts`: border-statistics segmentation → largest component → rotating-caliper min-area rect → rectangularity, frame fill, aspect vs ISO/ICAO standards |
| `doc-text-tamper`, `doc-background`, `doc-halftone` | Averaged over the whole frame incl. the table | Computed inside the located, deskewed document crop only |
| `synthetic-track`, `track-label-empty` | Missing `deviceId`/`groupId` treated as strong injection evidence | Info-only + explicit `channel-unassessable` notice |
| `camera-identity` and peers | `browserMediated` required optional telemetry, so native captures without it were scored under upload scrutiny | Mediation granted to any `native-file` path unless actively contradicted |
| Score arithmetic | Score summed unrounded weights while the UI showed rounded ones — deductions did not add up | Single canonical `findingImpact()`; ledger reconciles exactly |

**Demoted to unscored** — measurable but no honest threshold:
`ela` (tracks scene content), `pixel-noise` / `video-noise` (night mode and HDR stacking
flatten genuine captures), `doc-background`, `doc-halftone`, `doc-text-tamper`,
`adobe-app14` (non-Adobe encoders emit APP14 too), `native-resolution` (still and WebRTC
pipelines have unrelated ceilings), `pixel-too-small` (less evidence is not fraud — it
belongs in confidence).

**Deleted** — unprovable in a browser:
`glare` and `cool-cast` as screen-replay signals (laminated cards glare under room light;
ambient white balance moves the blue–red delta as much as a panel does). Glare survives
only as `doc-glare`, a capture-quality instruction, never as fraud evidence. The
periodicity chart in `visual-forensics.ts` is now labelled a visual reference with no
thresholds, because it is drawn on a downscale where a lattice cannot resolve.

**Kept** — real measurement, defensible threshold: hard channel invariants
(`native-event-trust`, `native-file-age`, `native-return-speed`), `capture-physical`
(ISO/aperture/focal physical limits), `device-origin` on a claimed fresh native capture,
container-format expectations, MRZ/PDF417 check digits, and the definitive injection
signals (canvas-track class, orphaned `deviceId`, prototype identity, dual-path readback).

## 1. Design policy: no false accusations

Three principles govern every check:

1. **Conservative fusion.** A hard verdict (`manipulated`, `ai-generated`, FAIL) always
   requires corroboration — at least two independent evidence families, or a signal
   backed by a browser/technical invariant that cannot occur accidentally. Thin evidence
   yields `needs-more-info` with concrete retake instructions, never an accusation.
2. **Browser behaviour is not fraud.** Safari strips EXIF make/model/capture params from
   native captures; privacy browsers (DuckDuckGo, Brave, Firefox Focus) and in-app
   WebViews legitimately wrap DOM APIs and strip metadata. On **trusted native** and
   **live-frame** paths, expected mediation (thin EXIF, missing Make/Model/MakerNote/
   optical params/thumbnail, HEIC→JPEG dimension quirks, firmware Software tags) is
   **info-only, weight 0** — never amber risk and never a score hit. On uploads the same
   signals stay soft-warn. Privacy wrappers collapse into one evidence family and can at
   worst produce REVIEW — never FAIL.
3. **An unprovable check scores nothing.** See §0. Where a measurement cannot separate
   genuine from fraudulent captures, the report says so in plain language and deducts
   zero — it never fills the gap with a guessed threshold.

## 2. Report model

`analyzeImageFraud` / video analysis produce a `MediaFraudReport`:

- **`findings`** — every check as a `Finding`: `id`, `label`, `status`
  (`pass|warn|fail|info`), `weight`, `category`, `observed`, `expected`, `detail`.
- **`score`** — 0–100 authenticity score (100 = clean); weighted deductions per finding.
- **`confidence`** — how much evidence was actually available (thin evidence lowers it).
- **`verdict`** — `authentic | suspicious | manipulated | ai-generated | needs-more-info`.
- **`docOutcome`** — document-mode outcome (`retake`, `screen-recapture`, …).
- **`categories`** — per-category score bars (metadata, pixels, channel, device, …).
- **`visuals`** — on-device heat maps (see §7).
- **`telemetry`** — `ReportTelemetry`: engine stamp, score ledger (`buildScoreTrace`),
  confidence math (`computeConfidence`), verdict rule trace (`deriveVerdict` steps),
  every raw signal measurement (`MetricEntry` list), and the **check ledger**
  (`CheckLedgerEntry[]`): per criterion the measured value, the threshold, its provenance
  sentence, whether it was allowed to score, and its exact point impact. Fully embedded in
  the JSON export.

### Score arithmetic (reconciles exactly)

`findingImpact(f)` is the single definition of a finding's cost: `fail` → `weight`,
`warn` → `round(weight × 0.4, 1dp)`, `pass`/`info` → 0. `scoreFindings`,
`buildScoreTrace`, the category bars and the check ledger all sum **these same values**,
so the deductions a reader can see always add up to the score shown. (Before 2.5 the
score used unrounded weights while the UI displayed rounded ones.)
- **`retakeAdvice`** — actionable corrective instructions.

### Verdict rules (`deriveVerdict`, traced step-by-step in telemetry)

- **Rule 2** — instant channel condemnation fires **only** on `native-event-trust`
  (a script-dispatched change/press event; `isTrusted` is a user-agent invariant).
- **Rule 4** — score < 50 but **all** fails are metadata-level → `needs-more-info`
  (metadata can be stripped by privacy browsers/messengers without any tampering);
  `manipulated` requires ≥1 non-metadata fail. Without corroboration:
  confidence < 55 → `needs-more-info`, otherwise `suspicious`.
- Score 50–74 band: confidence < 45 with no hard fails → `needs-more-info`,
  otherwise `suspicious`.

## 3. Metadata forensics (images)

Capture-path aware (`captureSource`: `live-frame` | `native-file` | `upload`):

- **Live-frame (WebRTC/canvas stills)** — zero EXIF is expected and scores as pass.
  Authenticity rests on the capture-channel audit + pixel forensics, never on metadata.
- **Native-file (trusted `<input capture>` / Capacitor)** — mobile browsers (especially
  Safari) routinely strip MakerNote, thumbnail, optical params, and sometimes Make/Model.
  All of that is **info weight 0** (engine 2.4). The report UI groups these under
  "Expected browser mediation". Score and metadata category bars stay green.
- **Upload** — full metadata expectations; thin EXIF can fail (weight 14) but metadata-only
  fails still cannot reach `manipulated` (Rule 4).

Other checks:

- **Container check** — JPEG/HEIC camera-pipeline formats expected; JPEG segment table
  is walked directly (`jpegHasApp14`, marker scan) rather than naive byte search.
- **Camera identity / optical params** — softened on trusted native path; full weight on uploads.
- **EXIF dates** — `OffsetTimeOriginal` / `OffsetTime` applied when present so freshness
  is not false-failed by timezone skew. DateTimeOriginal vs Digitized allows multi-minute
  gaps (iOS computational photography / Live Photo).
- **Dimensions** — prefers `PixelX/YDimension`; orientation swap and trusted-native
  HEIC→JPEG aspect-preserving resize are not scored as forgery.
- **C2PA** — info only (iOS Camera/Photos can embed Content Credentials on genuine shots).
- **Category bars** — use the same penalty scale as the overall score (no double penalty).
- **Rule 4b** — mid-band scores with only soft metadata cautions and zero hard fails →
  `authentic` (≥65) or `needs-more-info`, never branded "suspicious".
- **Editor / AI fingerprints** — unchanged; explicit generator markers still hard-fail.

## 4. Pixel forensics

`src/lib/pixel-forensics.ts` + `src/lib/visual-forensics.ts`:

- **ELA (error level analysis)** — per-block re-compression energy with block
  inconsistency statistic and a rendered heat map with text-region outlines.
  **Unscored** (`ela.blockInconsistency` is `uncalibrated`): busy texture raises it on
  genuine photos. The heat map remains for visual inspection.
- **Noise/texture statistics** — sensor-noise residual (|Laplacian|), edge distribution,
  colorfulness (Hasler–Süsstrunk). Noise floor is **unscored** — night mode and HDR
  stacking remove shot noise from genuine captures.
- **Screen-replay detection** (`src/lib/screen-lattice.ts`) — rebuilt in 2.5:
  - Up to nine **native-resolution** 256×256 tiles (never a downscale — a display lattice
    has a 2–8px period at native resolution and is destroyed below Nyquist by downscaling).
  - 3×3 high-pass residual, Hann window, direct DFT over periods 2.4–18px.
  - **JPEG grid excluded**: periods 16, 8, 4 and 8/3 px (ITU-T T.81 DCT blocks + 4:2:0 MCU)
    are removed before peak selection, so compression can never be read as a screen.
  - **Prominence** = peak power ÷ median power of the surrounding band. A ratio, so it is
    invariant to exposure, contrast and overall texture level.
  - **Axis agreement**: horizontal and vertical peak periods must agree within 1.35×
    (panels are near-square; incidental texture is not).
  - Flat, blown-out or black tiles are rejected and counted in the report.
  - **Refresh banding** — spectral prominence of the detrended row-mean profile
    (periods 4–80 rows), so lighting gradients contribute nothing.
  - **Fusion**: `likely` (scored) requires **both** independent signals to fire with at
    least one strong. One signal alone → `single-signal`, reported at weight 0. Too small
    or too flat to measure → `unassessable`, also weight 0 — never silently “clean”.
- **Document localization** (`src/lib/document-locate.ts`) — replaces the bright-pixel
  guess: background model from the outer 7% frame border, colour-distance + local-texture
  foreground mask, integral-image morphological close/open, largest 4-connected component,
  convex hull, rotating-caliper minimum-area rectangle. Yields size, rotation,
  rectangularity, frame fill and aspect, matched against ISO/IEC 7810 ID-1 (1.586:1),
  ICAO TD3 (1.42:1), A4 and US Letter within 9%. `cropDocument()` deskews the rectangle so
  all text/tamper/halftone statistics describe the document, not the surface behind it.
- **Video temporal analysis** — sampled frame strip with inter-frame difference values;
  static-feed and loop detection.

### Calibration (`src/lib/calibration.ts`, `/calibrate`)

Labelled samples (`genuine` / `screen` / `print`) are measured by
`calibration-metrics.ts`, stored in `localStorage`, and analysed per metric:
90th/10th-percentile edges per class, gap, and normalised separation. Outcomes:

- **`separates`** — thresholds are placed inside the gap (30% and 70% of it) and the check
  becomes `calibrated` and scoring.
- **`overlaps`** — the classes cannot be told apart; the check stays unscored permanently.
- **`insufficient`** — fewer than 3 samples per class.

Overrides apply only after the user presses **Apply thresholds**; the store and full
separation analysis are exportable as JSON so every threshold is traceable to the captures
that justified it.

## 5. Capture-channel integrity (`src/lib/injection-guard.ts`)

Detects JavaScript-level media injection (monkey-patched `getUserMedia`,
`canvas.captureStream()` posing as a camera, hooked readback APIs, scripted file-input
injection, automation controllers). Signals are tiered:

- **`definitive`** — backed by hard browser invariants only: cross-realm
  `Function.prototype.toString` integrity, camera tracks whose `deviceId` matches no
  enumerable device in the same session ("orphaned device"), `isTrusted` event
  provenance, and dual-path GPU/CPU readback agreement of the same frame.
- **`strong`** — real evidence with at least one innocent explanation (privacy
  extensions hook canvas readback, test browsers expose fake devices). Never condemns
  alone — requires corroboration from an independent family; otherwise the outcome is
  "recapture on a clean browser".
- **`info`** — context only, zero score impact.

**Native provenance** (`NativeProvenance`) recorded for every file-picker capture:

| Field | Invariant checked | Finding id |
|---|---|---|
| `changeIsTrusted` / `pressIsTrusted` | user agent only sets `isTrusted` on its own events | `native-event-trust` (fail w35) |
| `elapsedMs` | camera round-trips can't complete near-instantly — < 300 ms = FAIL (w25), < 1200 ms = warn (w6); recorded AFTER the enforced 1–2 s Gaussian securing hold (`lib/capture-hold.ts`), so honest timings always include the hold | `native-return-speed` |
| file `lastModified` vs `pageLoadedAt` | a live capture can't predate the session | `native-file-age` |
| `filesApiNative` | wrapped files accessor — warn (w6) unless corroborated | `native-files-api` |
| `pageHiddenDuring` | the OS camera covers the page on phones | `native-page-hidden` (warn w8) |

**Privacy-browser recalibration:** `detectPrivacyBrowser()` (DuckDuckGo UA, `navigator.brave`,
Firefox Focus/Klar, in-app WebViews) adds an info-level `privacy-browser-context` finding
and downgrades wrapped-API observations to corroboration-only cautions. Virtual-camera
label markers (OBS, ManyCam, v4l2loopback, DeepFaceLive, …) use word-boundary matching
for short markers so real hardware ("OBSBOT", "Sandisk") is never flagged.

## 5b. Device-norm plausibility (`src/lib/device-plausibility.ts`)

Session-level checks that a claimed phone browser is self-consistent:

iOS UA + File System Access, webm-only recorder, or desktop GPU renderer → REVIEW
warn (never standalone FAIL). Privacy browsers are noted as expected context.
Desktop sessions are info-flagged as diagnostic-only.

## 5c. Cross-feed pulse continuity (`src/lib/ppg.ts`)

Silent front-camera legs sample forehead RGB whenever a face is present. When both
a silent fingerprint and the liveness pulse lock a usable BPM, disagreement >25 BPM
with two "good" locks is a REVIEW corroboration (different source media / person
mid-flow). Short silent windows that cannot lock a rate are inconclusive — never
an accusation.

## 6. Lens & zoom enforcement (`src/lib/lens-enforcement.ts`)

Post-capture EXIF policy check for native captures (HTML `capture` can only *request* a
facing): `LensModel`/`Lens` string → actual facing; `DigitalZoomRatio` > 1.03× → reject;
telephoto/ultra-wide lens strings → reject; wrong facing → reject with retake panel.
Stripped EXIF → indeterminate (allowed, logged as caution). Handles ExifReader rational
values.

## 7. Visual evidence

`buildImageVisuals` / `buildVideoVisuals` render on-device heat maps attached to every
report: `noise-map` (sensor-noise texture), `edge-map` (detail distribution), `glare-map`
(specular hotspots), `ela-blocks` (per-block ELA energy with text outlines),
`frequency-profile` (column high-pass + detrended row-mean profiles — a **visual reference
with no thresholds**, since it is drawn on a downscale where a display lattice cannot
resolve; the scored decision comes from `screen-lattice.ts`), `frame-strip` (video frames
with difference values). Each carries a caption with measured stats inline. Exports keep
captions/stats; image data stays in-app.

## 8. AI verdicts (`src/lib/ai-verdict.ts`)

- Model `google/gemini-3.5-flash` through the Rork Toolkit proxy
  (`/v2/vercel/v1/chat/completions`); availability gated on
  `EXPO_PUBLIC_TOOLKIT_URL` + `EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY`.
- Images resized down a quality ladder (1280→1024→832→640→512 px) to keep total raw
  bytes under 2.5 MB (Vercel edge 4.5 MB body limit); videos contribute extracted frames.
- Strict JSON verdict parsing; `mergeAssessment` folds the AI opinion into the report as
  **corroboration only** — it can lift a `needs-more-info` (authentic ≥75%) or force
  REVIEW (non-authentic ≥60%), never a standalone FAIL.
- `extractDocumentData` is the vision-OCR used by the deep data check; the prompt is
  hardened for Australian documents. All validation math on the extracted text is local
  and deterministic (see `templates.md` §2.4).

## 9. Face pipeline (`src/lib/face-vision.ts` + `src/lib/face-embedder.ts`)

Agency-grade on-device stack (nothing leaves the device):

- **Detectors:** SSD MobileNet V1 primary with TinyFaceDetector fallbacks
  (`@vladmandic/face-api`, models loaded once). Used for location, 68-pt landmarks,
  expressions (liveness), and live boxes.
- **Alignment:** ArcFace 5-point similarity warp (eyes / nose / mouth) to a canonical
  **112×112** template (`warpAligned112`), with optional roll pre-align and tight-box
  crop fallback.
- **Embedder:** **MobileFaceNet** (ArcFace-trained) via **ONNX Runtime Web**
  (`/models/mobilefacenet.onnx`, ~800 KB) → **256-d L2-normalized** embedding.
  FaceNet 128-d remains a silent fallback if ONNX fails to load.
- **Ensemble:** embeddings for aligned / mirror / contrast-normalized (/ unsharp) variants
  fused with L2 re-normalization; `compareFaceDescriptions` reports best/median/mean.
- **Metric & thresholds (cosine distance):** match ≤ **0.42**, mismatch ≥ **0.58**,
  between = `uncertain` (retake rather than guess). Similarity % uses a logistic curve.
- **Quality gates:** minimum face width 72 px, brightness/sharpness/contrast/unique-levels;
  a mismatch from a quality-failing capture is suppressed to `uncertain`. Ghost-portrait
  guard picks the dominant face (`pickMainFace`); `detectFaceBoxes` powers the live overlay.
- **Engine id:** `mobilefacenet-arcface/1.0` stamped on robust descriptions.

## 10. Liveness & pulse

See `templates.md` §1 (face modes) for the session structure. Detection specifics:

- **Expression gating** is sustained (400 ms) and baseline-relative — per-frame
  expression scores flicker between faces/lighting, so the gate is a rise above the
  user's own neutral baseline OR an absolute bar, whichever clears first.
- **rPPG** (`src/lib/ppg.ts`): POS projection (Wang et al. 2017) over a 1.6 s sliding
  window on 30 Hz-resampled forehead RGB; moving-average detrend + smoothing; BPM from
  normalized autocorrelation (parabolic refinement) cross-validated against a Goertzel
  spectral scan (42–180 BPM); harmonic disambiguation adopts the half-lag peak when
  autocorrelation locks the double period. Quality `good` requires estimator agreement
  (≤15 BPM) + spectral SNR ≥ 2; minimum 5 s of signal.
- **Verdict fusion:** `not-live` requires multiple corroborating signals (failed
  challenge + replay signature + channel evidence…); a weak pulse alone is
  `inconclusive`.

## 11. Document data validation

- **MRZ engine** (`src/lib/mrz.ts`): ICAO Doc 9303 TD1/TD2/TD3 parsing; per-field check
  digits with 7-3-1 weights mod 10 (`computeCheckDigit`); `<` ↔ `0` equivalence;
  century resolution favours the past for birth dates and always 20xx for expiry (no
  circulating document expires in the 1900s); alternate-century candidates prevent
  ambiguous two-digit years from flagging long-validity documents.
- **Confidence ledger** (`computeDocConfidence`): itemized parts (check digits, date
  validity, zone agreement) with earned/max points and a formula note; **null score
  ("N/A")** for documents that carry no MRZ (e.g. Australian state licences).
- **PDF417/AAMVA** (`src/lib/pdf417.ts`): native `BarcodeDetector` first (when pdf417 is
  supported), then ZXing across 0/90/180/270° rotations at ≤1800 px; AAMVA payload parsed
  into typed fields (name, DOB, expiry, number, address, issuer IIN, version).
- **Cross-checks:** barcode ↔ front-OCR (licence) and MRZ ↔ VIZ (passport) share the
  same policy — the deterministic side (barcode/checksums) is trusted; the model-read
  side may misread, so single disagreements are REVIEW and only multiple corroborated
  mismatches FAIL.
