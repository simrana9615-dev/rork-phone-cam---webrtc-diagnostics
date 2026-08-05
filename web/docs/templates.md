# Verification Templates — Full Technical Reference

Every guided verification flow in the app is driven by a `VerificationTemplate` (defined in
`src/lib/verification-templates.ts`). This document is the authoritative breakdown of all
**6 preset templates**, the **Custom Flow** resolver, and the **2 EyeDeeKit one-tap flows**,
including every check each one runs, its thresholds, and how results fuse into the final
PASS / REVIEW / FAIL verdict.

---

## 1. Template anatomy

```ts
type VerificationTemplate = {
  id: string;              // route key: /verify/:templateId
  name: string;
  tagline: string;
  doc: "passport" | "licence";
  docCapture: "webrtc" | "native";
  faceMode: "liveness" | "native-selfie" | "none";
  pages: PageDef[];        // document pages to capture, in order
};
```

### Page definitions

| Page id | Label | Portrait carrier | Framing guide aspect | Hint focus |
|---|---|---|---|---|
| `photo-page` | Passport photo page | yes | 125 : 88 (ICAO TD3 booklet page) | MRZ lines fully visible, no laminate glare |
| `front` | Licence front | yes | 85.6 : 54 (ISO/IEC 7810 ID-1) | All four corners, no fingers over text/portrait |
| `back` | Licence back | no | 85.6 : 54 (ISO/IEC 7810 ID-1) | Barcodes and category table sharp |

The `portrait: true` page is the one the face-match portrait is extracted from.
`guideAspect` drives the live framing overlay (WebRTC) and the capture hints (native).

### Capture methods

**`webrtc` — live in-browser capture** (`components/verify/LiveDocCapture.tsx` + `lib/doc-align.ts`)

- Rear camera opened at maximum resolution/fps the device grants.
- A live alignment analyzer runs every ~200 ms on a 160 px-wide canvas (<1 ms per tick):
  - **Edge coverage** — strong luminance gradients must sit near all four guide borders.
  - **Corner locks** — a corner "locks" when both adjacent document edges are detected near it.
  - **Perspective skew** — each edge is least-squares line-fitted (≥6 hits, ≥0.4 spread);
    opposite-edge convergence above **7%** = tilted phone, with a directional coaching hint.
  - **Sharpness** — Laplacian variance inside the guide, minimum **30**.
  - **Brightness** — interior mean luminance within **55–235**.
  - **Steadiness** — mean abs frame difference vs previous tick, maximum **6**.
- Frames carry **no EXIF by design** — metadata-absence findings are expected and are
  excluded from REVIEW forcing for this mode (see fusion rules §6).

**`native` — phone camera app capture** (`components/verify/NativeCaptureStep.tsx`)

- `<input type="file" accept="image/*" capture="environment|user">` launches the OS camera.
- Full-sensor image with **original EXIF preserved** — enables the entire metadata
  forensic battery.
- **Securing hold:** every returned photo is held for a Gaussian 1–2 s delay
  (centred 1.5 s, clamped [1.0 s, 2.0 s] — `lib/capture-hold.ts`) behind a
  full-screen "Securing capture…" overlay BEFORE any timing is recorded, so the
  recorded round-trip always includes the hold; a recorded return < 0.3 s is a
  physically-impossible hard FAIL.
- **Native provenance** is recorded after the hold
  (`lib/injection-guard.ts` → `NativeProvenance`): press timestamp, round-trip
  elapsed ms (post-hold), `change` event `isTrusted`, press-event `isTrusted`, whether the page lost
  visibility during the round-trip (the camera UI covers the page on phones), whether
  `HTMLInputElement.files` was still the native accessor, and page-session start time.
- **Lens & zoom enforcement** (`lib/lens-enforcement.ts`) runs post-capture, because the
  HTML Media Capture spec offers no control beyond requesting a facing:
  - EXIF `LensModel`/`Lens` string → actual facing (`front`/`back`/`unknown`).
  - `DigitalZoomRatio` > **1.03×** → rejected (retake at 1×).
  - Telephoto or ultra-wide lens string → rejected (retake on the main lens).
  - Wrong facing → rejected with retake panel; **stripped EXIF → indeterminate, allowed**
    (privacy browsers strip metadata legitimately — never a hard fail on its own).

### Face modes

**`liveness` — full in-browser liveness session** (`components/LivenessCheck.tsx`)

- Phases: `loading → baseline → challenge → hold → done`; target duration **7–9 s**.
- **Challenge–response:** two escalating smile prompts ("smile" → "smile a bit more"),
  each sustained ≥ **400 ms**. Gates are absolute **or** baseline-relative (whichever
  clears first) so naturally smiley resting faces are not penalized:
  - smile: score ≥ **0.5** or ≥ baseline + **0.35**
  - smile-more: score ≥ **0.78** or ≥ baseline + **0.6**
- **Pulse (rPPG)** runs in parallel across the whole session (`lib/ppg.ts`):
  forehead-ROI RGB means → uniform 30 Hz resample → **POS projection**
  (Wang et al. 2017, 1.6 s sliding window, overlap-add) → detrend + smooth →
  two independent BPM estimators (normalized autocorrelation with parabolic
  refinement + Goertzel spectral scan over **42–180 BPM**). Quality "good" requires
  the two estimates to agree within **15 BPM** plus clear spectral SNR; minimum
  **5 s** of signal before any estimate.
- **Screen-replay screening** (native-resolution display lattice + refresh banding, both
  required to agree before it can score) and the full **injection audit**
  (§ detection-engine.md) run on the same feed.
- **Multi-face detection** with live bounding boxes drawn over every detected face.
- The best identity frame is captured for the face match.
- Verdicts: `live` / `not-live` / `inconclusive`. `not-live` requires multiple
  corroborating signals — a weak pulse alone is inconclusive, never a fail.

**`native-selfie` — still selfie via the OS camera app**

- Same native provenance + lens enforcement as native document capture (front camera).
- The selfie runs the **full EXIF + pixel forensic report** including screen-replay
  screening. A still photo cannot prove liveness — the summary screen offers an
  optional in-browser **Liveness + Pulse add-on** whose result feeds the final verdict.

**`none`** — document-only flow (Custom Flow option); face match and liveness are skipped.

---

## 2. Per-page check battery

Every captured document page runs this pipeline (order as executed):

1. **Instant quality gate** (`lib/capture-quality.ts`) — fully local, runs at capture:
   downscale to ≤640 px, Laplacian sharpness ≥ **35**, near-saturation glare fraction
   ≤ **10%** (luma ≥250 with chroma <22), deep-shadow fraction ≤ **55%** (luma ≤32).
   Failing frames get an immediate "retake now" prompt.
2. **Forensic screening** (`lib/fraud-detection.ts`, engine `verification-hub-forensics/2.2`) —
   metadata, editor/AI-generator fingerprints, C2PA, ELA, pixel forensics, screen-replay,
   device consistency, capture-channel provenance. Produces score 0–100, confidence,
   one of 5 verdicts, category bars, heat-map visuals, and a full telemetry ledger.
   See `detection-engine.md`.
3. **Portrait detection** (`lib/face-vision.ts`) — on portrait-carrying pages; extracts the
   document portrait descriptor for the face match (quality-gated).
4. **Deep data check** (`lib/mrz.ts` + `lib/ai-verdict.ts`) — vision-model OCR
   (`extractDocumentData`) reads the zones, then **pure local math** validates them:
   ICAO 9303 TD1/TD2/TD3 check digits (7-3-1 weights mod 10), date plausibility &
   expiry, MRZ ↔ visual-zone cross-validation. A per-document **confidence ledger**
   (`computeDocConfidence`) itemizes earned/available points; documents with no MRZ
   (e.g. Australian state licences) report **N/A**, never a misleading low percentage.
5. **Licence-back barcode** (`lib/pdf417.ts`) — licence `back` page only: PDF417 decode via
   the native `BarcodeDetector` first, then ZXing across 4 rotations at ≤1800 px;
   AAMVA payload parse into typed fields. Fully local and deterministic.
6. **Licence cross-check** (`crossCheckLicenceData`) — when both barcode fields and
   front-side OCR exist: field-by-field comparison (name, DOB, expiry, number, state).
   A single disagreement = REVIEW (possible OCR misread); only multiple corroborated
   mismatches reach FAIL — same policy as MRZ↔VIZ.
7. **AI vision verdict** (`lib/ai-verdict.ts`) — `google/gemini-3.5-flash` via the Rork
   Toolkit proxy, image resized down a quality ladder (1280→512 px) to stay under the
   2.5 MB budget. A model opinion is **corroborating evidence only** — a
   non-authentic verdict at ≥60% confidence forces REVIEW, never a standalone FAIL.

Checks 4, 5, 7 can be deferred and run later from the summary via **"Run All Remaining
Checks"**; the coverage matrix (§7) tracks exactly what ran.

---

## 3. The six preset templates

### 3.1 `passport-webrtc-all` — Passport, WebRTC All

| | |
|---|---|
| Route | `/verify/passport-webrtc-all` |
| Document | Passport — 1 page (`photo-page`) |
| Doc capture | WebRTC live capture with alignment overlay |
| Face step | Full liveness session (smile challenge + rPPG + replay/injection checks) |
| Face match | Passport portrait vs liveness identity frame |

Pipeline: live photo-page capture (max res) → quality gate → forensic screening
(metadata findings de-weighted: WebRTC frames have no EXIF) → portrait extraction →
MRZ deep data check → AI verdict → liveness session → face match → fusion.

Distinctive behaviour: `needs-more-info` verdicts caused purely by absent metadata do
**not** force REVIEW in this mode; only pixel-level retake outcomes keep their weight.

### 3.2 `licence-webrtc-all` — Driver's Licence, WebRTC All

| | |
|---|---|
| Route | `/verify/licence-webrtc-all` |
| Document | Licence — 2 pages (`front`, `back`) |
| Doc capture | WebRTC live capture with alignment overlay |
| Face step | Full liveness session |
| Face match | Licence-front portrait vs liveness identity frame |

Adds on top of 3.1: PDF417/AAMVA decode on the back page, front-side OCR deep data
check, and the **barcode ↔ front cross-check** once both sides have results.

### 3.3 `passport-native-doc` — Passport, Native Doc / WebRTC Face

| | |
|---|---|
| Route | `/verify/passport-native-doc` |
| Document | Passport — 1 page via the **native camera app** |
| Doc capture | Native (full EXIF preserved, provenance + lens enforcement) |
| Face step | Full liveness session |
| Face match | Passport portrait vs liveness identity frame |

The document capture gains the complete metadata battery: EXIF presence/identity,
optical capture parameters, editor & AI-generator fingerprints, timestamp agreement,
device consistency, native provenance (trusted events, round-trip timing, page-visibility
watch, files-API integrity), and lens/zoom enforcement with reject-and-retake.

### 3.4 `licence-native-doc` — Driver's Licence, Native Doc / WebRTC Face

| | |
|---|---|
| Route | `/verify/licence-native-doc` |
| Document | Licence — 2 pages via the native camera app |
| Doc capture | Native (full EXIF + provenance + lens enforcement) |
| Face step | Full liveness session |
| Face match | Licence-front portrait vs liveness identity frame |

Union of 3.2's data checks (barcode + cross-check) and 3.3's native forensics.

### 3.5 `passport-native-all` — Passport, Native All

| | |
|---|---|
| Route | `/verify/passport-native-all` |
| Document | Passport — 1 page via the native camera app |
| Doc capture | Native (full EXIF + provenance + lens enforcement) |
| Face step | **Native selfie** (front camera, OS app) with full EXIF/pixel forensics |
| Face match | Passport portrait vs selfie face |

The selfie gets its own forensic report (including screen-replay screening), lens
enforcement (front camera required, no zoom), multi-face count, and an optional
in-browser Liveness + Pulse add-on from the summary. Liveness cannot be proven by a
still photo — the coverage matrix says so explicitly rather than pretending.

### 3.6 `licence-native-all` — Driver's Licence, Native All

| | |
|---|---|
| Route | `/verify/licence-native-all` |
| Document | Licence — 2 pages via the native camera app |
| Doc capture | Native (full EXIF + provenance + lens enforcement) |
| Face step | Native selfie with full forensics |
| Face match | Licence-front portrait vs selfie face |

The maximal native flow: every capture in the session is an original-EXIF file from the
OS camera, so all three media items get the complete metadata + provenance battery,
plus barcode, cross-check, and MRZ-style front data validation.

---

## 4. Custom Flow (`/verify/custom?...`)

`getTemplate("custom", searchParams)` builds a template from URL parameters:

| Param | Values | Default | Effect |
|---|---|---|---|
| `doc` | `passport`, `licence` | `passport` | Document type; passport always uses the single photo page |
| `capture` | `webrtc`, `native` | `webrtc` | Document capture method |
| `face` | `liveness`, `native-selfie`, `none` | `liveness` | Face step mode |
| `pages` | `front`, `back`, `front,back` | `front,back` | Licence pages only; invalid/empty → `front` |

Example: `/verify/custom?doc=licence&capture=native&face=none&pages=front`
runs a document-only native licence-front check.

The Custom Flow uses exactly the same engine as the presets — the resolver only picks
the axes; nothing else is special-cased.

---

## 5. EyeDeeKit one-tap flows

Both flows share one engine (`src/pages/IdKitFlow.tsx`, `EyeDeeKitVariant` config) and
differ only in the document template. They are pinned as hero cards at the top of the
dashboard.

### 5.1 EyeDeeKit Drivers Licence Flow

| | |
|---|---|
| Routes | `/eyedeekit/licence` (alias `/idkit`) |
| Captures | Silent clip → licence front (native) → silent clip → licence back (native) → liveness |
| File names | `eyedeekit-licence-*` |
| Data checks | PDF417/AAMVA barcode + front OCR + cross-check |

### 5.2 EyeDeeKit Passport Flow

| | |
|---|---|
| Route | `/eyedeekit/passport` |
| Captures | Silent clip → passport photo page (native, single capture) → liveness |
| File names | `eyedeekit-passport-*` |
| Data checks | MRZ + ICAO 9303 deep data (no barcode) |

### Shared one-tap engine (Revision 4 — passive verification chain)

1. **One tap** on the hero card → full-screen "Verification starting…" overlay →
   `getUserMedia` permission prompt for the front camera at maximum resolution.
2. **Silent passive clip (before EVERY document page):** the instant permission is
   granted (later pages reuse the grant — no second prompt), the front camera streams
   secretly to a hidden `<video>`. Over ~600 ms, 5 frames are sampled to canvases and a
   MediaRecorder clip is captured (mp4 on iOS Safari, webm elsewhere; skipped gracefully
   when unsupported). No viewfinder is ever shown — the user sees only the loading
   screen.
3. **Trust-window native handoff:** after the first 3 frames (~450 ms), still inside
   the activation window, the page's `<input capture="environment">` is clicked so the
   OS camera auto-opens without another tap — licence **front**, then (after the second
   silent clip fired from the front capture's trusted `change` event) licence **back**;
   passport: the photo page. If iOS blocks an auto-launch (gesture token expired), a
   "Scan Back of Licence" / "Take <page>" button appears — the flow never dead-ends.
4. **Background tail (while the user is in the OS camera):** 2 more frames are sampled,
   the live stream gets the full injection audit, the recorder is stopped, and the
   stream is torn down. Then:
   - **Micro-motion analysis:** downscaled grayscale inter-frame deltas. A hand-held
     live scene always shows measurable motion; near-zero deltas look like a digitally
     injected still (`silent-motion` finding, warn at most — a phone resting on a table
     is also static, so this is corroboration only).
   - **Best face frame:** face description is attempted on the middle, last, then first
     frame; the winning frame is encoded and run through the full forensic battery
     (screen-replay heuristics, AI-generation forensics, channel findings, motion
     finding).
5. **Liveness finale:** a quick smile challenge (`LivenessCheck`, auto-start) requesting
   only `height: { ideal: 640 }` + `aspectRatio: { ideal: 1.7777777778 }` (width omitted
   — iOS Safari then configures the pipeline in 16:9 landscape even in portrait grip);
   the UI shows just the portrait centre slice via object-fit cover. **Two-strike
   fallback:** the first camera decline shows a retry; a second decline hands off to the
   native front camera (`capture="user"`) for a full-EXIF selfie at maximum portrait
   resolution (lens-enforced), and the session honestly records that liveness could not
   run on a still.
6. **Passive identity chain:** every silent capture's face is matched against BOTH the
   document portrait and the liveness (or fallback selfie) face via the quality-gated
   `compareFaces`. A **surviving (non-gated) mismatch on either edge fails the session**
   — both sides passed quality gates, so a different person was holding the phone. A
   clip with **no face is ignored silently** (normal while photographing a document —
   evidence-trail note only); a gated/uncertain result never punishes.
7. **Stream HUD:** a floating pill shows live resolution + measured fps
   (`requestVideoFrameCallback` with rAF fallback, 500 ms refresh) + track-reported fps
   + camera hardware label; the last-measured values persist in the capture checklist.
8. **Provenance & enforcement:** every native capture is held for the 1–2 s bell-curve
   "Securing capture…" delay before its round-trip is recorded, then records full
   provenance (press trust, visibility watch via `awaitingRef`, post-hold round-trip
   timing, files-API integrity) and runs lens/zoom enforcement — a rejected photo shows a red retake panel and is
   never analyzed. A document retake gets its own fresh silent clip; a silent-only redo
   never re-opens an already-captured document page.
9. **Analysis & fusion:** identical machinery to the templates — per-page check battery
   (§2), the **liveness (or fallback selfie) face is the governing live match**; on top
   of that the passive chain can FAIL via hard channel invariants, a manipulated /
   AI-generated silent frame, or a quality-gated chain mismatch; suspicious verdicts,
   multi-face frames, and static micro-motion (face present) are REVIEW-grade. The
   summary shows a dedicated **Passive Verification Chain** section (per-clip motion
   chip, chain match chips, forensic report), every frame AND clip is downloadable, and
   both exports carry a per-clip passive-chain section.

---

## 6. Verdict fusion — PASS / REVIEW / FAIL

`computeOverall()` implements conservative fusion: **FAIL requires a hard, corroborated
signal; thin or ambiguous evidence becomes REVIEW with retake guidance — never an
accusation.**

### FAIL triggers (any one)

- **Capture channel compromised** — a `fail`-status finding among the hard channel
  invariants: `native-event-trust` (script-dispatched events), `native-file-age`
  (file predates the session), `native-return-speed` (impossible round-trip),
  `injection-*` definitive signals, or `native-files-api` *(which only reaches fail
  status when corroborated — a wrapped accessor alone is a warn, because privacy
  browsers wrap it legitimately)*.
- Document or selfie forensic verdict **`manipulated`** or **`ai-generated`**
  (which themselves require corroborated non-metadata evidence — see detection-engine.md).
- **Deep data check fail** — ≥2 broken check digits or zone mismatches
  (single failures are REVIEW: likely OCR misread).
- **Barcode fail** or **multiple corroborated cross-check mismatches**.
- **Face match `mismatch`** — only when *both* captures passed quality gates
  (a suppressed mismatch is REVIEW).
- **Liveness `not-live`** — requires multiple corroborating signals.

### REVIEW triggers (no FAIL present)

- Forensic verdict `suspicious`, or `needs-more-info` (native captures; for WebRTC only
  when the outcome is an explicit quality retake).
- Screen-recapture outcome (photo-of-a-screen) — original document required.
- Single check-digit / cross-check / barcode warnings.
- AI vision verdict `ai-generated`/`manipulated` at ≥60% confidence (corroboration only).
- Liveness `inconclusive`; missing pages or face step; no usable face or portrait.
- Face match `uncertain` (ambiguous band, or mismatch suppressed by quality gates).
- Multiple faces in the selfie frame or repeatedly during liveness.

### PASS

No fail and no review reasons: "All document pages passed forensic screening" (+ "Face
evidence is consistent" when a face step ran). Corrective actions are de-duplicated and
attached to every non-pass outcome.

---

## 7. Coverage matrix & exports

**Coverage matrix** (`buildChecksCoverage`) lists every check the flow *could* involve with
an honest status — `ran` (with the result line), `not-run` (with how to run it), or
`unavailable` (with the technical reason, e.g. missing AI toolkit credentials) — rendered
on the summary screen and embedded in both exports so "n/a" is never ambiguous.

**Exports** (both include overall verdict, reasons, corrective actions, and the coverage matrix):

- **Readable text report** (`buildSessionReportText`) — per-page capture meta, quality
  gate numbers, portrait status, full MRZ ledger with per-digit printed/computed values,
  barcode fields + findings, complete forensic report with Technical Appendix, liveness
  findings with observed/expected, face-match ensemble statistics.
- **Structured JSON** (`buildSessionJson`) — full machine-readable session including the
  engine telemetry (score ledger, confidence math, verdict rule trace, raw signal
  metrics); descriptors and image data URLs are stripped, heat maps kept as
  captions/stats only.
- **Share link** (`lib/share-link.ts`) — compact image-free summary compressed
  (deflate-raw) and base64url-encoded into the URL **fragment**: nothing is uploaded,
  fragments are never sent in HTTP requests, and links self-expire after **72 h**.
  Viewable on any device at `/shared` (bypasses the phone gate, read-only).
- **Evidence pack** (`lib/evidence-pack.ts` → `lib/zip-writer.ts`) — one ZIP holding
  every capture **byte-for-byte** (store-only, so extracted bytes/EXIF/hash match the
  camera output exactly), the derived renders beside them with their captions, per-file
  metadata re-read from the archived bytes, the full session log + capture ledger, the
  deep text/JSON report, the threshold reference and engine docs, and a printable
  `overview.html` that reconciles each score to its individual deductions. Anything that
  could not be packed is named in the overview and logged as a warning — the export never
  omits silently. Layout table in `architecture.md` §6.

**Persistence** (`lib/session-store.ts`) — the whole session (blobs, reports, face step,
AI verdicts) is snapshotted to IndexedDB (`verify-sessions`), surviving the tab eviction
phones perform while the native camera app is open; sessions expire after **6 h** and are
cleared on Start Over.
