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
- **Deep Probe** (`/deep-probe`) — the maximum-demand run: a tiered permission sweep,
  real sensor recordings, an exhaustive per-camera constraint matrix and a manual shot
  set, ending in a raw dump archive (see §4b). Diagnostic only — it produces **no
  verdict, no score and no finding**, and nothing it records feeds the forensic engine.

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

## 4b. Deep Probe (`/deep-probe`)

Where the Spec Report answers *what can this camera do*, Deep Probe answers *what did
this device hand over*. It scores nothing and accuses nobody; every output is a record.

**Scope toggle** (`standard` ⊂ `extended` ⊂ `everything`), stated with its cost — prompt
count, minutes, photo count, archive size — before anything runs.

1. **Permission sweep.** Every request the registry knows how to make at the chosen
   scope, one card at a time, each stating what it reaches and how long the grant lasts
   *before* firing. Auto-advances on a 4 s countdown that pauses while the page is
   hidden; falls back to a tap wherever the browser demands transient activation, naming
   the rule. Outcomes: allowed / denied / dismissed / **not implemented here** /
   skipped / errored.
   - Availability is decided by feature probe **before** the request fires, so a missing
     API is recorded as never asked — it can never be confused with a refusal.
   - Nothing is retried. A refusal is final.
   - Coverage is explicitly a floor, not a ceiling: the permission surface differs per
     browser and grows every release, and the ledger says so rather than implying it
     asked for everything that exists.
2. **Passive dump.** Everything readable with no prompt at all, in two layers. The
   one-line reads: identity strings, hardware, GPU, network, power, locale, storage,
   display preferences, codec support, API surface, plus `permissions.query` for every
   name any browser answers to. Then the reads that take real work, which is where most
   of the prompt-free surface actually lives:
   - **High-entropy client hints** — on Android these name the exact handset, the OS
     version and the CPU architecture with no prompt of any kind. This is the single most
     identifying prompt-free read on the platform.
   - **Graphics detail** — the full driver parameter set, shader precision formats and the
     **named** extension list (a count collapses a genuinely discriminating list into one
     weak number), plus WebGPU adapter vendor/architecture/device, features and limits.
   - **Rendering signatures** — canvas 2D, WebGL and audio-DSP hashes.
   - **Audio stack** — output sample rate, base and output latency, channel count. No
     permission is involved; this is not microphone access.
   - **Fonts** — detected by measuring text width, which needs no permission at all. The
     `local-fonts` prompt in tier 3 governs *enumerating* the whole list, not probing for
     known names.
   - **Hardware codec support** — `decodingInfo` reports which formats decode *in hardware*
     rather than merely decoding, which tracks the chipset rather than the browser, plus
     the `MediaRecorder` encoder set.
   - **Installed speech voices**, a local **WebRTC offer's** codec and header-extension
     list (never sent anywhere), and **engine behaviour**: clock resolution, `Math`
     last-bit results, `Intl` formatting and collation, a `CSS.supports` battery, JS heap
     limit, safe-area insets and a wider media-query set.

   Two limits are stated in the file itself. **This is a floor, not a ceiling** — a reading
   absent here may be absent from the platform, absent from this browser, or simply not yet
   known to this app, and those three are not the same thing. And the rendering signatures
   are hashes of *this app's own* test patterns: stable per device + browser + driver, which
   is what makes them trackable, but comparable only to another Deep Probe run, never to a
   third-party fingerprint database. Still **no uniqueness score**: that would need a
   population this app cannot see, so it would be a guess dressed as a measurement.
3. **Sensor recordings.** For each granted sensor, a real timed sample rather than a
   note that a grant exists: motion, orientation/compass, geolocation watched until the
   accuracy figure settles, microphone loudness (level only — no audio is retained), and
   the generic sensors. Each series reports the **measured** rate beside the requested
   one, because browsers throttle these events and quoting the request back would be
   repeating an intention as a reading.
4. **Camera matrix.** Per camera: native max, the full resolution ladder in landscape
   **and** portrait, six aspect ratios, five frame rates, then every advertised focus /
   exposure / white-balance / resize mode, zoom extremes and torch applied to a live
   track. Asked vs granted recorded for every row — a request that succeeds while quietly
   delivering a different size is the more revealing case, so the two are never merged.
   **Rejections are results**, exactly as in §4. Stills are taken at a declared subset of
   steps and `stillPolicy` states which, so an empty capture list reads as designed. The
   torch is always left off.
5. **Manual shots.** Two library picks, then every named camera in a pinned viewfinder plus
   three zoom steps each (resolved against that camera's own reported range, not a hardcoded
   factor), then both facings through all three camera-app handoffs — the paths that yield
   real camera EXIF. A camera with no zoom control produces a clearly-recorded unzoomed shot
   rather than a fake one. Skips are recorded as skips.

**Export:** one raw dump ZIP (layout in `architecture.md` §6b) with the untouched
captures stored uncompressed, a complete hex + ASCII dump of every byte, a real
structural parse of each container, carved metadata regions, the full tag listing
including undocumented entries, four checksums per file plus `md5sum`/`sha256sum`-format
digest files, the permission ledger, passive dump, sensor CSVs, camera matrix, session
log and byte-identity data. Stopping early keeps everything gathered; the archive is
named `…-PARTIAL.zip` and lists every omitted stage with its reason.

**Two deeper parses per capture.** Beyond the friendly tag listing, each file gets:

- **The encoder signature** (`raw/<slug>.encoder.txt`). All 64 quantisation coefficients
  per table, printed both in reading order and in the file's own zig-zag order — these are
  the compressor's own state rather than a metadata field, which makes them the strongest
  fingerprint in the file and nearly the only part nobody thinks to edit. Plus Huffman
  tables marked *standard Annex K* or *optimised*, chroma subsampling from the sampling
  factors, baseline versus progressive, scan count, restart interval, APP segments in file
  order (including whether an APP0/JFIF header exists at all), the embedded thumbnail
  parsed as the complete second JPEG it is, a full ICC header parse, and any bytes after
  EOI. The approximate libjpeg quality is **withheld** where the tables are not a scaled
  Annex K table — Apple's camera encoder is exactly that case, and refusing to state a
  number there is more informative than inventing one.
- **The raw directory walk** (`raw/<slug>.ifd.txt`). Every EXIF entry as physically stored:
  tag ID, TIFF type, component count, byte length, inline-or-offset, and the undecoded
  value. Rationals stay as `num/den`, because `1/60` and `0.016667` are the same reading
  and different bytes — a library that helpfully normalises them has destroyed the detail.
  Also byte order, directory order, IFD1 presence, MakerNote length and signature,
  `ColorSpace 65535` and `InteroperabilityIndex` as first-class fields, and the GPS block
  with every Ref resolved. Undocumented tags appear with a null name rather than being
  dropped.

**The verbatim JS surface.** `camera/surface.json` holds `getSettings()`,
`getCapabilities()` and `getConstraints()` exactly as the browser returned them — key order
preserved, since the order itself is an engine trait — with track and stream IDs, the
`<video>` element's dimensions, the measured open time and the `ImageCapture` photo
interrogation. `camera/devices.json` carries three `enumerateDevices()` snapshots rather
than two, because "before permission" and "before the sweep" are different moments.
`camera/files.json` records each `File` object with `lastModified` as a raw epoch value, so
the step between consecutive shots stays visible.

**Third export — `correlation-brief.md`.** Item-by-item answers to a specific forensic
request, each pointing at the file holding the evidence, with the reproduction commands
written against this archive's own paths. It leads with the fact that changes how
everything else should be read: **the target is different per capture path, and two of them
are opposites.** A photo reaching a server through `getUserMedia` → canvas → `toBlob` has
*no* EXIF — canvas destroys all of it — while one arriving through `<input type=file>` from
the camera roll carries the full set. So rich camera EXIF on a canvas-path file makes it
*more* detectable, not less: it is metadata no browser can produce. Statuses are four, not
two — `captured`, `partial`, `not-run` (a gap in this observation) and `not-obtainable` (a
limit of what a page can read) — because collapsing the last two would be the most useful
lie such a document could tell. The same registry renders the compact answer key at the top
of `device-spec.md`, so the summary cannot drift from the document.

**Second export — `device-spec.md`.** A few pages instead of a few hundred megabytes,
offered on its own and also written into the archive. It answers the narrower question
*what about this device is not true of every other phone*: readings matching a published
common-default table are dropped and named in an appendix, readings that **differ** from
one are kept and flagged as the strongest rows in the file. Each fact is tagged `HW`
(hardware), `OS` (browser version), `SET` (a setting you chose) or `VAR` (changes every
run) — pinning a `VAR` value is as wrong as getting an `HW` value wrong. It covers the
camera capability envelope including where the platform silently substituted a different
mode, the per-origin capture and encoder signature, and measured sensor quantisation steps.
Uniqueness is never claimed: the app sees one device and cannot observe a population, so it
reports no entropy figure, no rarity and no fingerprint score, and it says as much in the
file. Permission answers are excluded — they are decisions about the run, not properties of
the device — as are per-shot values like exposure and timestamps.

**Reading it back — `/archive`.** A downloaded archive opens again on the phone: file tree,
image preview, windowed hex in the same layout the archive's own dumps use, the carved
metadata regions, and a CRC-32 re-check of any file (or all of them) against the checksum
stored inside. The viewer is explicitly not the authority — when it and `unzip` disagree,
`unzip` wins.

**The hex budget, and why it is a correctness matter rather than a size preference.**
One source byte becomes 4.94 characters of text, so the dumps are the largest thing in the
archive — larger than the photos they describe. A 150-photo run at 3 MB a photo is 450 MB of
source and therefore 2.2 GB of hex, alive as blobs at the same time as the captures, the
DEFLATE output and the assembled archive, against an iOS Safari tab that is terminated around
1–1.5 GB. An earlier 192 MB allowance did not produce a large archive; it killed the build.
So the allowance is derived from `deviceMemory` and the heap ceiling where those exist, and
the unmeasurable case — WebKit, which reports neither and is also strictest about killing
tabs — is deliberately treated as the *small* case rather than the generous one. The allowance
is then shared **equally per capture** rather than first-come, because spending it in arrival
order made the completeness of a dump a fact about when a photo was taken instead of about the
photo. A floor keeps every capture's header region rendered however many there are; crossing
70% of a reported heap limit mid-build shortens the remaining dumps and writes both a warning
and a named omission, which reaches the on-screen list too. `raw/hex-budget.txt` states the
whole policy, the complete-versus-windowed counts, and the `xxd` command that recovers any
skipped range from the original — which is present and byte-identical regardless. What a
window omits is entropy-coded scan data: incompressible noise with nothing structural in it.

**Sweep memory — why the byte counter was the wrong thing to watch.** A run died mid-sweep at
106 photos with 129.75 MB held. That number exonerates the captures rather than explaining the
crash: 130 MB of blobs is survivable, and the counter on screen was tracking the one cost that
was not dangerous. Two larger ones went uncounted. A canvas sized to a 4K frame holds 31.6 MiB
of pixels (8K: 126.6 MiB), and the sweep allocated a fresh one per still — ~14 per camera, ~56
across four cameras, **1.77 GiB** requested in two minutes, against a WebKit tab that caps total
canvas memory separately from the JS heap and reclaims detached canvases whenever it likes. And
reading each still's width and height by loading it into an `Image` decoded the entire photo —
another 31.6 MiB — for two numbers written in its header. So: one canvas reused for the whole
run with its pixels freed the instant each encode resolves, and dimensions parsed from the
header (`jpeg-sof`, `png-ihdr`, `iso-bmff-ispe`, WebP, GIF), which is also the more accurate of
the two since it reports what the file declares rather than what a decoder produced after
applying orientation. Held bytes now have a ceiling, and when it is hit the sweep keeps making
every request and recording every asked-versus-granted row while stopping only the stills —
those rows are the product of the stage and cost nothing to hold. Encoded bytes are unaffected
throughout: same context, same draw, same encode quality. `camera/memory-policy.txt` carries the
run's real figures and keeps the three causes of an empty capture list apart — never expected,
attempted and failed, or stopped for memory.

**Crash surface.** A single throw in any screen used to unmount the tree and leave a blank
page. For a diagnostic tool that is the worst available failure mode, because a blank page is
indistinguishable from a genuine "this device refused everything" result. An error boundary now
reports the error name, message and component stack, states that an unfinished run was held in
memory only and did not survive, and recognises an out-of-memory signature well enough to
suggest a narrower scope or an earlier stop.

**A tab that is killed cannot report anything — so it reports beforehand.** An error boundary
only helps when JavaScript is still running. Repeated reports had the browser dying outright at
the moment the archive step began, every time, which runs no handler, fires no event and leaves
no console line. `crash-trail.ts` therefore writes each step to `localStorage` *before* it runs,
and the next visit reads back whatever the last run left. The measurement that actually decides
the question is a heartbeat on a 250 ms timer, because running out of memory and being killed for
not responding are indistinguishable from the outside and need opposite fixes: a blocked main
thread cannot service a timer, so a last tick landing as a step begins means that step froze the
thread, while ticks continuing for seconds into the step and then stopping dead mean the thread
was healthy right to the end. Heap figures corroborate where they exist — WebKit exposes neither
`deviceMemory` nor `jsHeapSizeLimit`, which is precisely why the heartbeat and not the heap is the
primary signal. Where the evidence does not decide, the report says `undetermined` and says why,
rather than picking the more satisfying answer.

**The sheets are no longer hostages to the archive.** The stat sheet, the correlation brief and
the device spec were built *inside* the ZIP builder and returned only if it survived, so a crash
at the last step of a twenty-minute run destroyed the cheap products along with the expensive one.
They are now produced by a separate pass — `capture-facts.ts` walks each capture once,
`sheets.ts` writes everything from the result — and handed over before the archive is attempted.
The archive is a tick box, off by default, and leaving it unticked releases each photo's bytes the
moment its facts are read. That is why the choice is presented *before* the read: a choice offered
afterwards could no longer be acted on, and pretending otherwise would be the polite lie here.
The consequence — no archive can be built from that run — is printed on the box, not in a footnote.

**Both plausible fixes were applied, because only one needed to be right.** Every long pass now
yields to the browser on a time cadence (`breathe.ts`; `scheduler.yield()` where it exists, a
`MessageChannel` macrotask otherwise, since a nested `setTimeout(0)` is clamped to 4 ms after five
levels and a thousand iterations of that clamp is four seconds on its own). And the duplicated
work is gone: the encoder parse, the IFD walk and the tag dump share one read of the bytes instead
of three, carved segments are lazy `Blob.slice` views the writer reads once each, and the
byte-identity re-check streams rather than materialising the archive a second time.

**The one gap that mattered.** The brief opens by stating that a canvas-path photo carries no
EXIF while a file-input photo carries the full tag set — and the run had abundant evidence for the
first half and none for the second. A library pick was the single `NOT RUN` item, excluded on the
principle that a pick cannot promise a fresh photo. True of a pick dressed up as a camera handoff;
irrelevant to one asked for as what it is. The manual stage now leads with two library picks,
filed as library files and never as camera output, and the page no longer stamps every manual shot
as a camera file — the shot itself decides, so a picker cannot inherit a camera's label by sharing
a code path.

The two picks differ only in what they say they accept, and that difference is the measurement:
iOS converts HEIC to JPEG for an input asking for `image/*` and hands over the stored bytes to one
that names HEIC. Asking twice for the same photo tells apart a library that genuinely holds JPEG
from one holding HEIC that ordinary upload forms never see. What the run refuses to do is cash
that in: the Photos storage setting is still reported as an inference, because it is never exposed
to a web page and one photo's format is not a device-wide setting; the untouched-original item
stays not-obtainable, because an unconverted HEIC is the nearest approximation and proves nothing
about what happened before the library. Only the location question moved — a GPS directory in a
picked photo answers it exactly as well as a camera file does.

**The options nobody could see.** A report of "I can't see the deep probe various final options"
turned out to be exactly literal, and the export screen was not the problem — three routes never
reached it. Each gathering stage chose its own next phase, and three of them jumped straight to
the archive builder: camera permission refused, Stop pressed during the sensor recordings, Stop
pressed during the camera sweep. The builder opens by reading the sheets it is meant to copy in,
finds nothing there because the stage that writes them was skipped, and correctly refuses — so all
three ended on a red "this is a bug" card with no sheets, no spec, no viewer and no tick boxes.
The two routes that did work were the two that sit idle waiting for input, which is why the fault
fell precisely on the people who ended a run early or declined the camera. Every exit now funnels
through one idempotent door to the export choice. Idempotent matters: the sweep notices an abort
only after its current step finishes, and a late notification must not drag a run backwards out of
a later phase.

**A stepper that flattered the run.** Stage state was derived from position — anything behind the
pointer was done — and at the end of a run everything is behind the pointer. A camera sweep that
never ran because the prompt was refused therefore finished wearing the same green tick as one
that swept every rung of every lens. On a diagnostic whose entire value is not overclaiming, that
is the wrong failure. Stages now record a mark at the moment they end — done, skipped, stopped or
failed — and a recorded mark always beats position. A run that skipped half of itself looks like
one.

**The choice is made on the way in.** It was previously offered only after the last photo, roughly
twenty minutes into a run — and never at all if the run ended early. It now lives on the dashboard
card, on the setup screen and at the pre-read checkpoint as one shared, persisted value. The
checkpoint stays where it is, because whether the bytes are kept or dropped genuinely cannot be
asked after the read; it just arrives pre-filled as a confirmation rather than a first sighting.
Persistence is not a convenience here: the run being configured is the one most likely to kill the
tab, and losing the setting with it would make the second attempt repeat the first. A stored value
that cannot be parsed falls back field by field rather than wholesale, so one corrupt key cannot
silently switch the heavy path back on.

**A run with no photos still reports.** Refusing the camera used to end in that same error card.
It now produces the full sheets from what was actually gathered — every permission answer,
everything the device volunteered with no prompt at all, every sensor recording — with both camera
stages named as skipped and the reason given. The omission list is shown on screen before the
choice is confirmed, not only inside the files afterwards.

**Interruption:** Pause and Stop are available throughout. A pause always lands *between*
steps — the recording or constraint in flight completes first, because a half-recorded
sensor window or a half-applied constraint would describe a paused device rather than the
setting under test. Stop is immediate: the recorders poll for it, so a 25-second location
watch ends on request rather than running out its window, and any window cut short says so
in its own note instead of scaling its rate up to the window that was planned.
Backgrounding the page — unavoidable during the camera-app handoff — is timed and logged,
so the gaps in the archive's timeline are explained rather than left looking like missing
evidence.

---

## 5. Verdict fusion recap

FAIL requires any one of: hard channel invariant, corroborated `manipulated`/
`ai-generated`, ≥2 broken check digits / zone mismatches, barcode fail or multiple
cross-check mismatches, quality-gated face mismatch, multi-signal `not-live`, or
(EyeDeeKit) a quality-gated passive-chain mismatch. Everything thinner is REVIEW with
concrete retake advice; PASS states exactly what was proven. The coverage matrix in
every summary/export lists each check as ran / not-run (how to run) / unavailable
(why), so "n/a" is never ambiguous.
