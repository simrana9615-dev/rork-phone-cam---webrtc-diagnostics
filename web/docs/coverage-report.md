# Full Coverage Report — Everything This App Tests & Proves

The single authoritative inventory of every test, proof, measurement, and verdict this
app produces — across all 8 verification flows, the diagnostics hub, and the Device
Camera Spec Report. Cross-references: [`templates.md`](./templates.md) (flow reference),
[`detection-engine.md`](./detection-engine.md) (signal internals),
[`architecture.md`](./architecture.md) (code map).

---

## 1. The claims the app can prove (and how)

| # | Claim | Evidence family | Where it runs |
|---|---|---|---|
| 1 | *This image came through a genuine capture channel* | Native provenance invariants (`isTrusted` events, round-trip timing, file age vs session start, files-API integrity, page-visibility watch) + WebRTC injection audit (function integrity, orphaned devices, dual-path readback) | Every native capture & every live stream |
| 2 | *This is a photo of a physical document, not a screen* | Moiré grid periodicity, refresh banding, specular signature, ELA block statistics | Every document page + selfie |
| 3 | *This image was not edited or AI-generated* | 20+ editor fingerprints, 40+ AI-generator signatures, C2PA/Content Credentials, IPTC synthetic source, ELA, noise/texture statistics — corroboration required for a hard verdict | Every image |
| 4 | *The EXIF story is self-consistent* | Camera identity, optical capture params, timestamp agreement, device consistency (resolution/orientation/lens vs claimed model) | Native captures (WebRTC frames carry no EXIF by design and are never penalized for it) |
| 5 | *The right lens took this photo, at 1× zoom* | Post-capture EXIF lens/zoom enforcement (`LensModel`, `DigitalZoomRatio`) with reject-and-retake | Every native capture |
| 6 | *The document's data is internally valid* | ICAO 9303 TD1/TD2/TD3 check digits (7-3-1 mod 10), date plausibility, MRZ↔VIZ cross-validation, per-document confidence ledger | Passports + MRZ documents |
| 7 | *The licence's two sides agree* | PDF417/AAMVA decode (BarcodeDetector → ZXing) cross-checked field-by-field against front OCR | Licence flows |
| 8 | *The same person appears on the document and in front of the camera* | Face ensemble matching (SSD MobileNet + TinyFace, aligned multi-crop descriptors, match ≤0.55 / mismatch ≥0.68) with quality gates that suppress accusations from bad photos | Every flow with a face step |
| 9 | *A live human was present — not a photo, screen, or deepfake feed* | Smile challenge–response (sustained, baseline-relative), rPPG pulse (POS + dual BPM estimators), screen-replay screening, injection audit, multi-face detection | Liveness sessions |
| 10 | *The same person held the phone throughout* | Passive verification chain: secret pre-capture clips face-matched against both document portrait and live face; micro-motion analysis proving a live scene | EyeDeeKit flows |
| 11 | *This device's camera stack behaves as claimed* | Device Camera Spec Report: per-camera max-capability probes, 19-pattern constraint suite × 2 facings, measured fps, codec matrix | `/device-spec` |

Everything above obeys the calibration policy: **hard verdicts require corroborated,
invariant-backed evidence; browser behaviour (Safari EXIF stripping, privacy-browser
API wrapping) is never fraud; thin evidence → REVIEW/needs-more-info with retake
advice, never an accusation.**

---

## 2. Complete check inventory by family

### 2.1 Capture-channel integrity (every capture)

- **Native provenance** (file-picker captures): press-event `isTrusted`, change-event
  `isTrusted` (script-dispatched = instant FAIL — UA invariant), round-trip elapsed ms
  recorded AFTER an enforced 1–2 s bell-curve "Securing capture…" hold
  (`lib/capture-hold.ts`) so honest timings always include the hold — a recorded
  return < 0.3 s is physically impossible = FAIL, file `lastModified` vs page-session
  start (pre-session file = FAIL), `HTMLInputElement.files` accessor integrity
  (wrapped = warn only; privacy browsers do this legitimately), page-visibility watch
  (OS camera covers the page).
- **WebRTC injection audit** (live streams): cross-realm `Function.prototype.toString`
  integrity on `getUserMedia`/canvas readback, orphaned-device check (track deviceId
  not in the same-session enumeration), dual-path GPU/CPU readback agreement,
  virtual-camera label markers (OBS, ManyCam, v4l2loopback, DeepFaceLive… —
  word-boundary matched), automation-controller detection.
- **Tiering:** `definitive` (hard invariants only) / `strong` (needs corroboration) /
  `info` (context, zero score impact). Privacy-browser observations collapse into one
  evidence family so a privacy suite can't corroborate itself.

### 2.2 Image forensics (every image)

Metadata: container check (JPEG segment-table walk), EXIF presence, camera identity,
optical capture parameters, editor fingerprints, AI-generator signatures, C2PA, IPTC
synthetic source, timestamp agreement, device consistency, GPS presence noted.
Pixels: ELA with per-block heat map + text-region outlines, sensor-noise residual,
edge distribution, colorfulness (photocopy detection), screen-replay screening.
Output: score 0–100, confidence, verdict (`authentic|suspicious|manipulated|`
`ai-generated|needs-more-info`), category bars, on-device heat maps (noise/edge/glare/
ELA/frequency), full telemetry ledger (score trace, confidence math, verdict rule
trace, raw metrics), retake advice.

### 2.3 Document data validation

MRZ parse + check digits + date logic + zone cross-validation + confidence ledger
(N/A for no-MRZ documents like Australian state licences — never a misleading 0%).
PDF417/AAMVA decode with 4-rotation ZXing fallback; licence front-OCR cross-check.
AI vision verdict + vision OCR (Gemini via toolkit proxy) — corroboration only.

### 2.4 Face, liveness & passive chain

Face ensemble match with quality gates; smile challenge (7–9 s target, sustained
400 ms, absolute-or-baseline-relative gates); rPPG pulse (42–180 BPM, dual estimators,
SNR-gated quality); multi-face detection with live bounding boxes; screen-replay on
the live feed; two-strike native-selfie fallback; passive chain (EyeDeeKit): per-clip
micro-motion, best-face extraction, chain matching vs portrait + live face.

### 2.5 Capture quality gates

Instant post-capture gate: Laplacian sharpness ≥35, glare fraction ≤10%, shadow
fraction ≤55% → immediate retake prompt before any forensic verdict can be blamed on
a bad photo. Live alignment (WebRTC docs): edge coverage, corner locks, ≤7% skew,
sharpness ≥30, brightness 55–235, steadiness ≤6.

### 2.6 Device & camera spec testing

- **Advanced Tools** (`/advanced`): environment/permissions panel, live viewfinder with
  settings/capabilities dump, constraint lab (free-form min/max/ideal drafting), crop
  simulator, automated suite runner, native capture with provenance, session gallery
  with auto-screening, Fraud Lab, debug console.
- **Device Camera Spec Report** (`/device-spec`) — one tap runs the complete spec
  battery and exports it (see §4).

---

## 3. How each template flows — step-by-step

Common notation: **QG** = instant quality gate, **FS** = forensic screening,
**AI** = AI vision verdict (corroboration only), **DD** = deep data check (vision OCR
→ local math), **BC** = PDF417/AAMVA barcode, **XC** = licence cross-check,
**FM** = face match, **LV** = liveness session, **PROV** = native provenance,
**LENS** = lens/zoom enforcement.

### 3.1 `passport-webrtc-all`

1. Tap card → rear camera opens at max res with the live alignment overlay
   (corner locks, skew coaching, sharpness/brightness/steadiness gates).
2. Auto/manual capture of the **photo page** → QG → FS (metadata findings de-weighted:
   WebRTC frames have no EXIF) → portrait extraction → DD (MRZ ledger with per-digit
   printed/computed values) → AI.
3. **LV**: smile challenge + rPPG + replay/injection audit + multi-face boxes; best
   identity frame kept.
4. **FM**: passport portrait vs liveness frame (ensemble distances, quality-gated).
5. Fusion → summary with coverage matrix, downloads, text/JSON exports, share link.

### 3.2 `licence-webrtc-all`

1–2. Same live capture engine for **front** (portrait carrier) then **back**.
3. Back page → **BC** (BarcodeDetector → ZXing ×4 rotations → AAMVA fields).
4. Front page → DD (front OCR) → **XC** field-by-field vs barcode (single mismatch =
   REVIEW, multiple corroborated = FAIL).
5. **LV** → **FM** (front portrait vs live frame) → fusion → summary.

### 3.3 `passport-native-doc`

1. Tap → native camera app for the photo page (`capture="environment"`).
2. On return: **PROV** recorded → **LENS** enforced (reject-and-retake on zoom >1.03×,
   wrong lens/facing) → QG → **full FS including the entire metadata battery** →
   portrait → DD → AI.
3. **LV** → **FM** → fusion. (Native doc + WebRTC face = both EXIF forensics *and*
   challenge-response liveness.)

### 3.4 `licence-native-doc`

Union of 3.2 + 3.3: native front (PROV+LENS+full FS+portrait+DD) → native back
(PROV+LENS+full FS+BC) → XC → LV → FM → fusion.

### 3.5 `passport-native-all`

1. Native photo page (as 3.3 step 2).
2. **Native selfie** (`capture="user"`): PROV + LENS (front lens required, no zoom) +
   full FS **including screen-replay screening** + multi-face count.
3. FM: portrait vs selfie. A still can't prove liveness — the coverage matrix says so
   and the summary offers the optional in-browser **Liveness + Pulse add-on** whose
   result feeds the final verdict.

### 3.6 `licence-native-all`

The maximal native flow: native front + native back (each PROV+LENS+QG+full FS) →
BC + DD + XC → native selfie with full forensics → FM → optional liveness add-on →
fusion. Every media item in the session is an original-EXIF full-sensor file.

### 3.7 Custom Flow (`/verify/custom?...`)

Same engine; URL params pick the axes: `doc` (passport/licence), `capture`
(webrtc/native), `face` (liveness/native-selfie/none), `pages` (front/back/front,back).
`face=none` runs a document-only check (FM/LV skipped, coverage matrix reports why).

### 3.8 EyeDeeKit Drivers Licence Flow (`/eyedeekit/licence`)

1. One tap → permission prompt → **silent clip #1** (~1 s hidden front-camera video:
   5 sampled frames + MediaRecorder clip + injection audit + micro-motion).
2. Trust-window auto-launch of the native camera → **licence FRONT** → PROV + LENS +
   QG + full FS + portrait + DD.
3. On the front capture's trusted return → **silent clip #2** (no re-prompt) → native
   camera auto-opens for the **licence BACK** (manual "Scan Back" button if iOS blocks
   it) → PROV + LENS + QG + full FS + BC → XC.
4. **LV** finale (16:9-requested / portrait-cropped; two-strike native-selfie
   fallback).
5. **Passive chain fusion**: each clip's best face vs portrait AND vs live face —
   quality-gated mismatch = FAIL (different person held the phone); faceless clip =
   ignored (noted in evidence trail); static-with-face = REVIEW-grade. Governing FM is
   still liveness-vs-portrait.
6. Summary adds the **Passive Verification Chain** section: per-clip motion chip,
   chain-match chips, forensic report, frame + video downloads; exports carry a
   per-clip passive-chain section.

### 3.9 EyeDeeKit Passport Flow (`/eyedeekit/passport`)

Same engine, single document page: tap → silent clip → native camera for the photo
page → PROV + LENS + QG + full FS + portrait + DD (MRZ, no barcode) → LV → passive
chain fusion → summary.

---

## 4. Device Camera Spec Report (`/device-spec`)

One tap runs the complete spec-wise battery against the phone's cameras
(`src/lib/device-spec.ts` + `src/pages/DeviceSpec.tsx`) and exports it:

1. **Environment & API surface** — user agent (+UA-CH), secure context, getUserMedia /
   enumerateDevices / ImageCapture / MediaRecorder / BarcodeDetector /
   requestVideoFrameCallback availability, camera permission state, screen + DPR,
   viewport, CPU threads, device memory, GPU (WebGL renderer), touch points,
   display mode (installed PWA vs tab).
2. **Per-camera maximum-capability probe** — every enumerated video input opened with
   `deviceId: { exact }` + an 8K ideal request; records: granted resolution/fps
   (= the effective video maximum), full capabilities (min/max resolution, fps range,
   zoom range, torch, focus/exposure/white-balance/resize modes, facing), open
   latency, and **measured** fps from a 1.2 s `requestVideoFrameCallback` sample
   (rAF fallback) — reported vs real fps often differ.
3. **ImageCapture photo capabilities** — still-photo max resolution (can exceed video
   resolution: full-sensor photos), fill-light and red-eye support.
4. **Constraint suite** — the same 19 getUserMedia patterns as the Advanced Tools
   suite, run on **both facings** with `facingMode: { exact }`: facing exact/ideal,
   720p/1080p/4K/8K ideals, min-only width/height/both, max-only 640×480, extreme min
   4K, 60/240 fps ideals, hard min 120 fps, portrait 9:16 + landscape 16:9 combos,
   aspect-only, exact square, and the extreme 4K+120fps mix. **Rejections are valid
   results** — they map the hard limits of the camera stack.
5. **MediaRecorder codec matrix** — 16 mime/codec candidates (mp4/avc1/hevc, webm/
   vp8/vp9/av1/h264, opus/aac audio) via `isTypeSupported` — this is what determines
   the silent-clip container in EyeDeeKit flows.
6. **BarcodeDetector formats** — native format list; pdf417 presence decides whether
   licence barcodes decode natively or via ZXing.

**Exports:** readable text (`device-spec-report-<timestamp>.txt`, with an
interpretation guide) and structured JSON (`device-spec-report-<timestamp>.json`,
`kind: "device-camera-spec-report"`), both built entirely on-device.

---

## 5. Verdict fusion recap

FAIL requires any one of: hard channel invariant, corroborated `manipulated`/
`ai-generated`, ≥2 broken check digits / zone mismatches, barcode fail or multiple
cross-check mismatches, quality-gated face mismatch, multi-signal `not-live`, or
(EyeDeeKit) a quality-gated passive-chain mismatch. Everything thinner is REVIEW with
concrete retake advice; PASS states exactly what was proven. The coverage matrix in
every summary/export lists each check as ran / not-run (how to run) / unavailable
(why), so "n/a" is never ambiguous.
