# EyeDeeKit Flows — Maximum-Detail Technical Deep-Dive

The definitive engineering reference for the two EyeDeeKit one-tap flows
(`src/pages/IdKitFlow.tsx`, ~1,700 LOC, both variants share one component). It
documents every stage, constraint, threshold, ref, timer, and fusion rule in
execution order. Companion documents: [`templates.md`](./templates.md) (per-page
check battery + template fusion), [`detection-engine.md`](./detection-engine.md)
(forensic core), [`coverage-report.md`](./coverage-report.md) (claim/evidence
inventory).

---

## 1. Variants

One component, two configurations (`VARIANTS: Record<EyeDeeKitVariant, VariantConfig>`):

| | Drivers Licence Flow | Passport Flow |
|---|---|---|
| Route template id | `eyedeekit-licence` | `eyedeekit-passport` |
| Native pages (in order) | `LICENCE_FRONT`, `LICENCE_BACK` | `PASSPORT_PHOTO_PAGE` |
| Choreography | silent → front → silent → back → liveness | silent → photo page → liveness |
| Deep data | PDF417/AAMVA barcode on the back; MRZ deep data on the front (when AI OCR available) | MRZ + ICAO 9303 deep data on the photo page |
| File prefix | `eyedeekit-licence-*` | `eyedeekit-passport-*` |

Both variants declare `docCapture: "native"` and `faceMode: "liveness"` so the
derived session state reuses the template machinery unchanged
(`computeOverall`, `buildChecksCoverage`, `buildSessionReportText`,
`buildSessionJson`, `licenceCrossFindings`).

## 2. Revision 4 choreography (passive verification chain)

```text
[Start tap]
   └─ SILENT CLIP #1 (front camera, hidden)  ── loader on screen
        └─ NATIVE HANDOFF: OS camera auto-opens for page 1 (trust window)
             └─ file returns → SECURING HOLD (1–2 s bell curve)
                  ├─ (licence only) SILENT CLIP #2 → NATIVE HANDOFF page 2 → HOLD
                  └─ forensics run concurrently per page
                       └─ LIVENESS (16:9 WebRTC session; 2 declines → native selfie + HOLD)
                            └─ PASSIVE IDENTITY CHAIN + FUSION → PASS / REVIEW / FAIL
```

Key invariant: the OS camera auto-launch (`input.click()`) must happen inside
the **user-activation trust window** opened by the previous trusted event
(the start tap, or the `change` event of the previous capture). Everything
heavy is deferred to a background tail so the handoff is never starved.

## 3. Start gate (`startFlow`)

- Refuses to start when `window.isSecureContext` is false (camera requires
  HTTPS) — logged as an error, nothing else happens.
- Sets `stage: "running"` and immediately calls
  `runSilentCapture(firstNativePage.id, /* openAfter */ true)`.

## 4. Silent passive capture engine (`runSilentCapture`)

One silent clip is recorded **before every document page**. The user only sees
the loading screen; the video element is `className="hidden"`, `muted`,
`playsInline`.

### 4.1 Stream acquisition

- `getUserMedia({ video: { facingMode: "user", width: { ideal: 4096 }, height: { ideal: 4096 } }, audio: false })`
  — "ideal 4096" asks for the sensor maximum without over-constraining; the
  browser grants the closest supported mode.
- Re-entrancy is guarded by `silentBusyRef` (duplicate requests are logged and
  skipped).
- **Denial fallback:** if the front camera is denied/unavailable the error is
  stored per page (`silentErrors`), the loader closes, and the native camera
  is **still opened** (`openNativeCamera(pageId, false)`) — the passive layer
  degrades, the document capture never dead-ends.

### 4.2 First-frame wait (trust-window budget)

Playback starts with `video.play()` (autoplay rejection tolerated); the code
then waits for `readyState ≥ 2 && videoWidth > 0` via `loadedmetadata`/
`loadeddata` listeners with a **1,200 ms hard timeout** — the handoff is never
blocked on a slow pipeline.

### 4.3 Stream HUD

`startHudMonitor` publishes a floating pill with live hardware truth:

- Resolution + OS camera label from `track.getSettings()`.
- **Measured fps** from real frame arrivals: `requestVideoFrameCallback` loop
  (rAF fallback), ring buffer of 120 timestamps, recomputed every 500 ms.
- Track-reported fps (`getSettings().frameRate`) shown alongside for
  comparison. Kept deliberately cheap so it cannot eat the trust window.

### 4.4 Clip recorder

`pickRecorderMime()` probes, in order: `video/mp4;codecs=avc1`, `video/mp4`,
`video/webm;codecs=vp9`, `video/webm` (mp4 lands on iOS Safari). When
supported, a `MediaRecorder` runs for the whole silent window; the blob is
collected with a **1,500 ms race timeout** at stop so a wedged recorder cannot
stall the flow. No recorder support = frames-only, harmless.

The clip length is governed by the **max-duration setting** on the intro
screen (1.5 s / 2.5 s / 4 s / 6 s presets, default 2.5 s, persisted locally in
`vh-silent-clip-max-ms-v1`, clamped 1–10 s). The cap is honored in both
directions: a hard-stop timer halts the recorder at the cap when the
background checks overrun it (bounding file size), and when the checks finish
early the recorder keeps running to the cap — one extra frame is sampled when
≥600 ms remain — so longer settings genuinely buy a longer micro-motion
window. The configured cap is recorded in the clip's ledger purpose; the
ledger's duration/bytes/avg-kbps stay measured values at stop, never the
configured target. The frame sampling and forensic checks are unaffected by
the cap — only the recording length changes.

### 4.5 Frame sampling & the handoff

- Frames are full-resolution canvas snapshots (`drawImage` at
  `videoWidth×videoHeight`).
- **3 frames** are sampled at `SNAP_INTERVAL_MS = 150` before the handoff
  (~450 ms of trust-window spend), then the loader closes and the native
  camera auto-launches.
- **2 more frames** are sampled in the background while the OS camera is
  opening (total 5 frames ≈ 600 ms span).
- On a silent **retake** of an already-captured page (`openAfter` with an
  existing page result) the camera is *not* reopened — clip-only redo.

### 4.6 Background tail (never blocks the handoff)

1. **Injection audit** on the live stream (`runInjectionAudit` with both
   `stream` and `video`): cross-realm API integrity, stream-identity
   anchoring (orphaned deviceId = definitive), dual-path Canvas2D-vs-WebGL
   readback, virtual-camera labels, automation flags → converted to findings
   via `injectionFindings`.
2. Recorder stop + blob collection (§4.4).
3. **Micro-motion analysis** (`computeSilentMotion`): each frame is
   downscaled to 96 px-wide grayscale; mean absolute inter-frame luminance
   delta is computed across consecutive pairs.
   - `static`: mean < **0.35** AND peak < **0.8**
   - `low-motion`: mean < **1.1**
   - `motion`: otherwise; `insufficient` under 3 usable frames.
   - Encoded as the `silent-motion` finding (weight 6, category `screen`):
     `motion` = pass, `static` = warn (corroboration only — a phone flat on a
     table is also static), others info.
4. **Best-face extraction**: tries the middle frame, then the last, then the
   first (`describeFaceRobust`); the chosen frame is JPEG-encoded at
   quality 0.95. `countFaces` runs on the chosen frame; **> 1 face** is logged
   as a coaching/coercion review signal.
5. **Full forensic battery** on the chosen frame (`analyzeImageFraud`) with
   the channel findings + motion finding merged via `extraFindings`. Frames
   are canvas-born (no EXIF) — metadata-absence findings are expected and
   handled by the calibration policy.
6. Everything is stored as a `SilentCapture` (frame blob/url, clip
   blob/url/mime, forensic report, face description, `facesDetected`, motion,
   dimensions) and shown in the Passive Verification Chain section with
   per-item downloads.

## 5. Native handoff & provenance (`openNativeCamera` → `handleDocFile`)

### 5.1 Launch

- Hidden inputs per page: `<input type="file" accept="image/*" capture="environment">`.
- `openNativeCamera(pageId, trusted)` records the press moment
  (`pressedAtRef`: epoch + `performance.now()` + trust flag), resets
  `hiddenSeenRef[pageId]`, marks the page as `awaiting`, and clicks the input.
- **Auto-launch watchdog:** a **2,500 ms** timer reveals a manual capture
  button if the page never went hidden and no file arrived (iOS consumed the
  activation token). The flow never dead-ends.

### 5.2 Page-visibility watcher

A document-level `visibilitychange`/`pagehide` listener reads `awaitingRef`
(a ref, not state — so a camera opening before React re-renders still counts)
and marks `hiddenSeenRef[pageId] = true`. On phones the OS camera UI covers
the browser, so a genuine round-trip goes hidden; a file arriving with the
page never hidden is the `native-page-hidden` warn (w8, corroboration only).

### 5.3 Securing hold — before any timing is recorded

The moment a file returns, `handleDocFile`:

1. Clears the awaiting state and the watchdog timer.
2. **Holds the capture for a Gaussian delay** (`lib/capture-hold.ts`):
   Box–Muller draw centred at **1.5 s** (σ 220 ms), clamped to
   **[1.0 s, 2.0 s]** — never a fixed, fingerprint-able constant. A
   full-screen **"Securing capture…"** overlay is shown for the duration.
3. Only **after** the hold does anything read the clock: the press→file
   round-trip recorded in provenance therefore **always includes the hold**.
   Combined with the forensic rule that a recorded round-trip **< 300 ms is a
   physically impossible hard FAIL** (`native-return-speed`, weight 25), any
   genuine capture sits comfortably above the line while scripted instant
   injection stays far below it.
4. Runs **lens/zoom enforcement** (EXIF `LensModel`/facing, digital zoom
   > 1.03×, telephoto/ultra-wide strings) — a rejected photo shows the red
   retake panel and is never analyzed.
5. **Chains the next page** (licence only): starts the next silent clip
   immediately, then runs this page's heavy forensics concurrently.

The same hold (same shared utility, same overlay) applies to the guided
template flows (`NativeCaptureStep`) and to the EyeDeeKit fallback selfie —
every native camera return behaves identically.

### 5.4 Recorded provenance (`NativeProvenance`)

Per capture: `pressedAt` (epoch), `elapsedSincePressMs` (post-hold),
`changeIsTrusted` (UA invariant — script-dispatched = definitive FAIL, w40),
`pressIsTrusted` (script-fired press = FAIL, w35), `pageLoadedAt`
(`performance.timeOrigin` — a file older than session-start − 90 s =
`native-file-age` FAIL, w22), `filesApiNative`
(`auditFileInputIntegrity` — wrapped accessor = warn w6 unless corroborated
by a hard invariant, then FAIL w28), `pageHiddenDuring` (§5.2).

### 5.5 Post-forensics tail (`finishDocAnalysis`)

- Verdict logging + **instant quality gate** (`assessCaptureQuality`:
  sharpness + glare fraction).
- **Portrait detection** on portrait-bearing pages (`describeFaceRobust`
  with quality gates: box width, detection score, issues list).
- Follow-up data checks: `back` page → **PDF417/AAMVA decode** (local);
  other pages → **MRZ/printed-field deep data** when the AI OCR proxy is
  configured (`aiVerdictAvailable()`).
- Haptic tick (`navigator.vibrate(15)`) on stored results.

## 6. Liveness finale

- Auto-starts once all document pages are captured (`faceStepDue`).
- Constraint set (`LIVENESS_CONSTRAINTS`): `facingMode: "user"`,
  `height: { ideal: 640 }`, `aspectRatio: { ideal: 1.7777777778 }` — width
  deliberately omitted. iOS Safari then configures the pipeline in 16:9
  landscape even in portrait grip; CSS `object-fit: cover` shows the user the
  portrait centre slice.
- Session internals (challenge gates, rPPG pulse, injection audit) are
  documented in `detection-engine.md`; the result feeds back as
  `handleLivenessResult` with verdict, findings, pulse BPM, and the identity
  face frame.
- **Two-strike fallback:** first camera decline → retry button; second
  decline → `openSelfieFallback` fires the native front camera
  (`capture="user"`). The fallback selfie runs the **same securing hold**,
  full provenance, lens enforcement, forensic battery, face detection and
  multi-face count as any native capture; the session honestly records that
  liveness could not run on a still.

## 7. Passive identity chain

For every silent capture, two quality-gated face comparisons
(`compareFaces`):

- `vsPortrait` — silent face vs the document portrait.
- `vsLive` — silent face vs the liveness (or fallback selfie) face.

Semantics:

- A **surviving (non-gated) `mismatch` on either edge is a session FAIL** —
  both sides passed quality gates, so a different person was holding the
  phone while the document was photographed.
- A **gated** result (either side low quality) never punishes.
- A **faceless silent clip is ignored silently** — normal while the phone
  points at a document on a table; evidence-trail note only.

## 8. Fusion — how the chain escalates the base verdict

`computeOverall(template, pages, face, compare, aiVerdicts)` produces the base
template verdict; the chain layer then adds, per silent capture:

**FAIL (any one):**

- A `fail`-status finding among `injection-*` or the hard channel invariants
  `HARD_CHANNEL_IDS = { native-event-trust, native-files-api, native-file-age, native-return-speed }`.
- Silent-frame forensic verdict `manipulated` or `ai-generated`.
- Non-gated chain mismatch vs portrait or vs live face (§7).

**REVIEW (no FAIL present):**

- Silent-frame verdict `suspicious` (+ corrective: repeat that page's step).
- Multiple faces in the silent frame (coaching/coercion signal).
- `static` micro-motion **with a face present** (a static injected feed can't
  be ruled out; faceless static = genuine table capture, ignored).
- AI vision verdict `ai-generated`/`manipulated` at ≥ **60 %** confidence on
  a silent frame.

Escalation: any chain FAIL forces `fail`; chain REVIEW keeps a base `fail`
as `fail`, otherwise yields `review`. When the chain escalates a base `pass`,
the base "all pages passed" reasons are dropped and only concrete evidence is
kept. Corrective actions are de-duplicated.

## 9. Round-trip timing model (with the securing hold)

| Recorded press→file time | Finding | Status |
|---|---|---|
| < 300 ms | `native-return-speed` | **FAIL** (w25) — physically impossible; genuine returns additionally carry the enforced 1–2 s hold |
| 300–1,199 ms | `native-return-speed` | warn (w6) — atypical, soft signal |
| ≥ 1,200 ms | `native-return-speed` | pass |

Because the hold (min 1.0 s) is added **before** the clock is read, every
honest capture records ≥ ~1 s + real camera time. The timing clocks themselves
(`performance.now`, `Date.now`) are integrity-audited by the injection guard
— a hooked clock is wrapped-API family evidence.

## 10. Post-session tooling

- **Run-all-remaining** executes outstanding barcode/MRZ/AI checks
  sequentially with a live counter (`remainingChecks`).
- **AI verdicts** per artifact key (`front`, `back`, `photo-page`,
  `silent-<pageId>`, `selfie`) via the Toolkit proxy — reported as
  *unavailable* (never silently skipped) when the proxy env is absent.
- **Downloads:** every document photo, silent frame, silent clip
  (mp4/webm), and identity face image.
- **Exports:** readable text + structured JSON reuse the template builders and
  append a per-clip *Passive Verification Chain* section (motion stats, chain
  match chips, forensic verdicts).
- **Retakes:** a document retake gets a fresh silent clip first; a
  silent-only redo never reopens an already-captured page (§4.5).

## 11. Failure-mode matrix (what the flow does when things go wrong)

| Failure | Behaviour |
|---|---|
| Not HTTPS | Start refused with a logged error |
| Front camera denied for a silent clip | Passive layer skipped for that page, error chip shown, native capture still opens |
| OS camera auto-launch blocked (activation consumed) | 2.5 s watchdog reveals a manual capture button |
| Wrong lens / zoomed document photo | Rejected pre-analysis with a retake panel (EXIF-enforced) |
| Liveness declined twice | Native front-camera selfie fallback with full forensics + hold |
| Recorder unsupported / wedged | Frames-only silent capture; 1.5 s stop race prevents stalls |
| Faceless silent clip | Ignored silently (evidence-trail note) |
| Component unmount mid-analysis | `mountedRef` guards every setState; blob URLs revoked |
