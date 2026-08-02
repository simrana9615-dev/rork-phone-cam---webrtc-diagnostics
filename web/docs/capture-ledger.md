# Capture Feed Ledger — Field Reference

The Capture Feed Ledger (`src/lib/capture-ledger.ts`, rendered by
`src/components/verify/CaptureLedgerSection.tsx`) is a millisecond-exact,
session-scoped record of **every camera interaction** in a verification
session: every live stream request, every recorded clip, every still artifact,
and every native camera round-trip — with a full sent-vs-received comparison
and a complete raw metadata dump per photo. It appears as its own section in
the session report of both EyeDeeKit flows and all guided template flows, is
included in full in the text and JSON exports, and has a dedicated one-tap
"Ledger JSON" download.

## Architecture

- Module-level singleton store (one verification flow is active at a time);
  flows call `ledgerReset(sessionLabel)` on start/restart. UI subscribes via
  `useSyncExternalStore` (`subscribeLedger` + `getLedgerVersion`).
- Every recorded moment is a `LedgerClock`: wall-clock epoch ms + ISO-8601
  with milliseconds **and** a monotonic `performance.now()` stamp (immune to
  clock changes). The timeline shows both plus the offset from session start.
- Instrumented call sites: EyeDeeKit silent captures + native handoffs +
  fallback selfie (`IdKitFlow.tsx`), guided native captures
  (`NativeCaptureStep.tsx`), the live document viewfinder
  (`LiveDocCapture.tsx`), and the liveness session (`LivenessCheck.tsx`).

## Entry types and their fields

### Live feed (`feed-N`) — one per getUserMedia request

| Field | How it is measured |
|---|---|
| `requestSentJson` | The **verbatim** `MediaStreamConstraints` object serialized at call time — byte-for-byte what the site asked the browser for, shown as code |
| `requestedAt` / `grantedAt` / `grantLatencyMs` | Clocks read immediately before the `getUserMedia` call and in its resolution; the latency envelope **includes the user's permission decision** on a first ask (≈0 ms on a remembered grant) |
| `firstFrameAt` / `firstFrameLatencyMs` | Clock read when the first real video frame is confirmed (`readyState ≥ 2 && videoWidth > 0` after `play()`) |
| `error` | The rejection name/message when the request was denied/overconstrained (a liveness overconstrained retry records **two** feeds: the rejected original and the relaxed retry) |
| `received.trackLabel` / `deviceId` / `groupId` | From the granted track's `getSettings()` |
| `received.settings` | **Complete** `getSettings()` dump — every exposed key, nothing summarized |
| `received.capabilities` | **Complete** `getCapabilities()` dump: min/max resolution, fps range, zoom range, torch, every mode the track reports |
| `received.constraintsInEffect` | `track.getConstraints()` — the constraints as the browser stored them |
| `received.computedAspectRatio` | Delivered width ÷ height to 4 decimals |
| `received.enumeratedCameras` | Every `videoinput` from `enumerateDevices()` at grant time (labels are readable post-grant) |
| `diffs` | Field-by-field requested-vs-received table (see below) |
| `telemetry` | **Measured** facts across the feed's lifetime: total frames observed (real frame callbacks, not claims), measured fps, and mid-feed resolution changes with exact timestamps |
| `stoppedAt` / `lifetimeMs` | Clock at track teardown; lifetime = stop − request |
| `notExposed` | Explicit honesty rows (see below) |

### Recorded clip (`clip-N`) — one per MediaRecorder run

Silent-clip recordings honor the **max-duration setting** (EyeDeeKit
intro-screen control, 1.5/2.5/4/6 s presets, default 2.5 s, persisted
locally): the configured cap is recorded in the clip's `purpose`, a hard-stop
timer guarantees it when the background checks overrun it, and
early-finishing checks keep the recorder running to the cap. The
`durationMs`, `bytes`, and `avgKbps` fields below are always the measured
values at stop — never the configured target.

| Field | How it is measured |
|---|---|
| `container` / `codecs` / `mime` | The mime the recorder **actually** accepted (`MP4/avc1` on iOS Safari, `WebM/vp9` elsewhere); codec "browser default" when the mime string declares none |
| `startedAt` / `stoppedAt` / `durationMs` | Clocks at `recorder.start()` and blob resolution |
| `bytes` | Final blob size |
| `avgKbps` | Computed average bitrate: `bytes × 8 ÷ durationMs` — the only honest bitrate a browser can produce (live wire bitrate is not exposed) |
| `feedId` | Link to the feed the clip was recorded from |

### Still frame (`frame-N`) — one per canvas sample / captured still

| Field | How it is measured |
|---|---|
| `capturedAt` / `width` / `height` | Clock + intrinsic dimensions at `drawImage` time |
| `encode` | Present when the frame was exported: format, encode quality, byte size, and **effective bits-per-pixel** (`bytes × 8 ÷ (w × h)`); silent-clip motion frames that stay in-memory say so explicitly |
| `feedId` | Source feed link |

### Native round-trip (`native-N`) — one per camera-app capture

| Field | How it is measured |
|---|---|
| `timeline` | Millisecond timeline, each step wall-clock + monotonic + delta from the previous step: shutter press (or auto-launch), hidden input `.click()` dispatch, page-hidden moment (OS camera taking over), page-visible-again, file arrival, securing-hold completion (with the exact bell-curve ms actually drawn), lens rejection (when it happens), forensic analysis start |
| `trust` | `pressIsTrusted` / `changeIsTrusted` (UA `isTrusted` read synchronously at each event) and `filesApiNative` (input-accessor integrity audit) |
| `holdMs` | The securing hold actually drawn from the 1–2 s Gaussian — recorded so the round-trip math is auditable |
| `file` | Name, declared MIME type, byte size, the file's **own** `lastModified` as ISO, and its delta vs the press moment |
| `exif` | **Complete raw metadata dump** — every readable EXIF/TIFF/GPS/maker tag in the file (not a summary); oversized binary payloads are length-annotated, parse failures recorded honestly as 0 readable tags |
| `crossChecks` | Sent-vs-received rows (see below) |

## Requested-vs-received diff engine

Every field the site constrained gets a row — **agreement is shown too,
never silently skipped**:

- `exact` mismatch → `DIFFERS` (the browser should have thrown
  OverconstrainedError; substitution is evidence).
- `min`/`max` violation → `DIFFERS` with the violated bound.
- `ideal` mismatch → `DIFFERS` with the honest note that ideal is a
  preference and the browser delivered the closest supported mode.
- Delivered-but-not-requested fields → `INFO` rows (browser/sensor default).
- Settings the browser omits → `NOT EXPOSED` with the reason.

## Native-photo cross-checks

- **Claimed camera identity**: EXIF `Make`/`Model` vs every camera label the
  browser enumerated this session — recorded verbatim on both sides with the
  honest note that browser labels never carry marketing model names, so this
  is reviewable evidence, not an automatic verdict.
- **Photo resolution vs live-probed sensor maximum**: photo pixels vs the
  largest `capabilities.width.max × height.max` observed on session feeds;
  flagged `DIFFERS` only when the same facing claims >115% of its probed
  maximum, otherwise an informational row (native still pipelines legitimately
  exceed video-mode maximums).
- **File clock vs session clock**: `lastModified` minus press moment;
  `DIFFERS` when the file predates the press beyond the 90 s tolerance.
- **EXIF capture time vs session time**: recorded with the honest caveat that
  EXIF has whole-second resolution and no timezone — exact-ms equality is
  physically impossible and is not pretended.

## Honesty rows (always present per feed)

- **Live-feed wire bitrate** — not exposed: `MediaStreamTrack` has no bitrate
  API; a live feed is decoded frames. Only a recorded clip's average bitrate
  can be computed.
- **Raw sensor pixel format** — not exposed: getUserMedia delivers decoded
  RGB; the Bayer/YUV wire format never reaches JavaScript.
- **Exact permission-prompt display moment** — not exposed: no event fires
  when the prompt appears; the request→grant envelope is the closest
  measurable fact.

## Capture engines (settings toggle)

Native captures can be launched through six pipelines, selected in the
"Capture engine" settings toggle (persisted locally, honored by every
native-camera launch point: guided flows, EyeDeeKit doc pages + fallback
selfie, the diagnostic hub, Document Check and Face Match):

- **Native camera app** (default) — direct `<input capture>`. The OS camera
  app opens; the original file returns; every provenance fact (trusted change
  event, files-API integrity, visibility takeover) is observed first-hand.
- **System picker** — the same input with NO capture attribute; iOS shows the
  UIImagePickerController-style sheet (Photo Library / Take Photo / Choose
  File). Library picks are allowed and judged by the file-age + EXIF checks.
- **Capacitor Camera** — `Camera.getPhoto()` with `webUseInput: true`.
  Capacitor drives its own hidden input (`#_capacitor-camera-input`); the app
  intercepts the change event there in the capture phase, recovering the
  ORIGINAL `File` (EXIF bytes, real name, real `lastModified`) plus the
  event's `isTrusted` and the files-API audit — so provenance stays
  first-hand while the Capacitor API does the launching. If the interception
  ever misses, the trust facts are reported as unobservable (and the guided
  step asks for a retake) — never guessed.
- **Bare capture attr** — the original HTML Media Capture boolean form
  (`<input capture>` with no facing value). The browser chooses which camera
  UI opens; the lens is verified after capture via EXIF, exactly like the
  other input paths.
- **Legacy accept hint** — the pre-standard
  `accept="image/*;capture=camera"` MIME-parameter syntax (old
  Android/BlackBerry spec drafts), with no capture attribute. Modern browsers
  are expected to ignore the parameter and show the picker — the observed
  behavior on the current device is itself the finding.
- **FS Access picker** — File System Access API `showOpenFilePicker()`
  (Chromium-only). The native OS picker returns a real file handle, so bytes,
  name, and `lastModified` are first-hand. No camera hint is possible and no
  change event exists on this path, so event-trust facts are recorded as not
  observable — never invented. Unsupported browsers get an explicit error.

Each ledger round-trip records which engine launched it (trip label) and the
engine-specific steps (`Camera.getPhoto() invoked`, `Change event intercepted
on Capacitor's hidden input`, `system picker opening`,
`showOpenFilePicker() invoked`, …).

## Where it surfaces

- **Report section** ("Capture Feed Ledger") in the EyeDeeKit summary and the
  guided-flow summary: chronological event timeline (offset + ISO per event)
  and expandable cards per feed/clip/frame-group/round-trip.
- **Text export**: full ledger appended before `=== END OF REPORT ===`.
- **JSON export**: `captureFeedLedger` key with the entire structure.
- **Standalone download**: "Ledger JSON" button on the section header.
