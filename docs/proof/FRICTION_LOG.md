# FireSense Kids — Fire OS Developer Friction Log

**Platform**: Amazon Fire OS 7 / 8 (Fire TV Stick 4K / 4K Max) & Web / Edge Devices  
**Hackathon**: Build, Ship, Shape: Amazon Developer Hackathon 2026 — Fire TV track  
**Author**: FireSense Kids (GitHub: marcosanyo)  
**Updated**: 2026-10-22 (entries 12–16 from a real Fire TV Stick 4K Max; the summary table covers all 16 entries)  

> **Fire TV already understands buttons and voice. FireSense lets it understand the viewer.**  
> **No gesture. No command. Just watch.**

This document provides a concrete Friction Log detailing the technical hurdles, developer ecosystem friction, and actionable improvements discovered while building a real-time body-aware reference implementation on Fire OS and local edge cameras.

> **How to read this log.** Entries are kept in the order we hit them. Some early workarounds were later replaced by a different design; those entries end with a **Current build** line saying what ships today, so nothing here describes code that no longer exists as if it did. The table at the end summarizes the current state.

> **Start here (Fire OS and Amazon WebView, found on a real Fire TV Stick 4K Max).** Entry 12 (every `<video>` goes
> into a hardware overlay: black picture, no CSS effects), entry 13 (hardware-decoded frames drawn into the page turn
> green), entry 16 (`play()` fails after standby), entry 8 (aapt drops `_next/` from the APK) and entry 10 (emulator
> clock after a snapshot). None of 12, 13 and 16 happens on the emulator. Each entry gives the task, what we expected,
> what happened with the steps we took to find the cause, the severity, the workaround that ships, and a suggestion.

---

## Friction Entry 1: Amazon Silk Browser Web Media & Fullscreen Autoplay Restrictions

- **Task**: Launch `/tv` full-screen video playback automatically on Fire TV Stick boot via Amazon Silk or a hosted PWA wrapper.
- **Expected**: HTML5 `<video autoPlay playsInline>` should start video and audio playback immediately upon navigation without requiring remote control interaction.
- **Actual**: Silk enforces strict Chromium-derived autoplay policies. Video with unmuted audio is blocked by default, pausing the stream until an explicit user click / remote `Select` keypress occurs.
- **Severity**: HIGH (breaks zero-touch, seamless TV experience)
- **Workaround Implemented**:
  1. Defaulted `<video autoPlay muted playsInline>` on initial mount.
  2. Registered remote `D-Pad` and `Play/Pause` key listeners (`keydown` code `179` / `MediaPlayPause`) to toggle mute status seamlessly upon first viewer interaction.
  3. Synthesized Web Audio API sound effects via an unlocked `AudioContext` triggered on first remote event.
- **Actionable Suggestion for Fire OS / Silk Team**: Provide an enterprise or kids-app manifest permission / policy toggle (e.g., `x-amazon-allow-autoplay: unrestricted`) for verified hosted web apps or kid-mode web applications on Fire TV.
- **Current build (2026-09-26)**: we no longer ship through Silk. `/tv` is bundled in a Fire OS WebView APK (entry 8) with `mediaPlaybackRequiresUserGesture = false` (`firetv-app/.../MainActivity.kt`), so the cartoon autoplays on launch without a key press. The remote's Play/Pause key (`MediaPlayPause` / 85 / 179) toggles playback. In the desktop browser trial, autoplay can still be blocked; the error stays on screen and the first click retries (`app/tv/page.tsx`). The muted-start and synthesized-sound workarounds above are not in the current code.

---

## Friction Entry 2: Secure Context (HTTPS) Restrictions for Local Companion Camera

- **Task**: Connect an existing home camera or smartphone on the local Wi-Fi subnet (`http://192.168.x.x:3000/camera`) as the sensing source for the Fire TV Stick.
- **Expected**: Mobile Web browser accesses `navigator.mediaDevices.getUserMedia()` to capture camera feed on the local private network.
- **Actual**: W3C Secure Context specifications enforce that `getUserMedia()` is permanently disabled on plain HTTP origins except `localhost` / `127.0.0.1`. Loading the companion camera from an iPhone/Android over local IP fails silently or throws `TypeError: Cannot read properties of undefined (reading 'getUserMedia')`.
- **Severity**: HIGH (onboarding friction for multi-device local demo)
- **Workaround Implemented**:
  1. Added an interactive visual banner detecting `!window.isSecureContext && hostname !== 'localhost'`.
  2. Provided zero-install local tunneling scripts (`scripts/dev-https.sh` / mkcert / local reverse proxy) and clear fallback UI guidance.
  3. Provided offline synthetic simulator presets (`GOOD`, `SLOUCH`, `LYING_DOWN`, distance slider) allowing hackathon judges to verify the complete Fire TV state machine without physical camera pairing.
- **Actionable Suggestion for Amazon / Alexa SDK Team**: Provide an Amazon Local Connect bridge or mDNS pairing utility within the Fire TV companion mobile app to establish mutual TLS (mTLS) automatically between Fire TV and home sensor devices.
- **Current build (2026-09-26)**: the phone page is served over HTTPS from CloudFront and talks to the TV through an AWS WebSocket relay (entry 9), so no local IP or certificate is needed at home. `/camera` still shows a banner when `window.isSecureContext` is false (local development; `scripts/dev-https.sh`). The "simulator presets" became **test mode** on `/camera`: a distance slider and buttons for BELOW_FRAME, lost tracking and slouching that send synthetic numbers through the real relay; the TV labels it "Test input" and does not record it. This is also the no-hardware path for judges (README, *Try it in 5 minutes*).

---

## Friction Entry 3: Server-Sent Events (SSE) Reconnection & Buffering over Home Wi-Fi

- **Task**: Stream continuous 10Hz - 15Hz `BodyTelemetry` events (`distanceMeters`, `posture`, `confidence`) from the edge camera to Fire TV Silk over `/api/events`.
- **Expected**: Native `EventSource` maintains low-latency continuous event delivery with transparent reconnects.
- **Actual**: When the Fire TV Stick experiences temporary Wi-Fi jitter or HDMI-CEC backgrounding, Silk's `EventSource` connection drops into an extended retry loop without immediately surfacing the disconnect event. Stale events buffered in memory can cause abrupt blur jumps when reconnecting.
- **Severity**: MEDIUM (temporal jitter in distance-proportional blur)
- **Workaround Implemented**:
  1. Built `SseTelemetryProvider` with a dual-threshold confidence hysteresis (`enterTrusted >= 0.60`, `exitTrusted < 0.45`).
  2. Implemented low-confidence freeze: on connection drop or frame loss, the TV UI freezes at `lastTrustedBlurPx` instead of resetting or jumping.
  3. Timestamped every telemetry payload (`timestamp: number`), discarding packets older than 400ms on arrival.
- **Actionable Suggestion for Fire OS Platform Team**: Document best practices and keep-alive intervals for WebSockets / SSE specifically on Fire OS Silk background tabs and memory-constrained streaming devices.
- **Current build (2026-09-26)**: SSE and the in-memory event bus were removed; telemetry now goes over API Gateway WebSocket (entry 9). What remains from this entry: the confidence hysteresis (`enterTrusted 0.60` / `exitTrusted 0.45`, `lib/firesense/state-machine.ts`) and ordering by a per-message `seq` (`SeqGate`, `lib/firesense/transport.ts`) instead of a 400 ms age cutoff. The "freeze at the last blur" behaviour was **reversed on purpose**: when the phone goes silent for 3 s the TV clears the blur and shows "Sensor not connected", because a broken sensor must never punish the child.

---

## Friction Entry 4: WebAssembly SIMD Performance & CPU Thermal Throttling on Edge Devices

- **Task**: Execute MediaPipe Pose 3D (BlazePose) on-device at 15 FPS without dropping frames or overheating portable sensing devices.
- **Expected**: WebGL / WebGPU acceleration smoothly processes 640x480 video frames within 30ms.
- **Actual**: Certain mobile browsers and older smart displays lack WebGPU support or experience WebGL context loss when backgrounded. Falling back to pure CPU WebAssembly incurred 80ms - 120ms frame latency, driving device temperatures up over prolonged sessions.
- **Severity**: MEDIUM (thermal throttling over extended child viewing)
- **Workaround Implemented**:
  1. Created dynamic GPU-to-CPU fallback in `PoseLandmarker.createFromOptions()`.
  2. Decoupled CV inference rate: throttled MediaPipe inference to 10 FPS while interpolating distance in the UI at 60 FPS using smooth linear exponential moving average (EMA $\alpha = 0.25$).
  3. Switched model asset path to `pose_landmarker_lite.task` (float16 quantization, 4.2 MB total footprint), cutting memory footprint by 62%.
- **Actionable Suggestion for MediaPipe & Edge AI Vendors**: Provide pre-compiled ONNX Runtime Web / WebNN targets optimized for ARM NEON instructions to achieve consistent 15ms latency across budget mobile and smart-home processors.
- **Current build (2026-09-26)**: GPU → CPU is **not** switched silently (it would break our no-fallback policy, `docs/NO_FALLBACK_POLICY.md`). The parent starts monitoring on GPU; if that fails, the error is shown and a separate "Retry on CPU" button retries on CPU (`lib/firesense/mediapipe.ts`). The model was `pose_landmarker_lite.task` until 2026-09-26; it is now `pose_landmarker_full.task` with detection/presence confidence 0.7 (lite fitted skeletons to furniture in a real living room), and the camera page lowers its own rate when inference is slow (it waits at least as long as inference took). Inference runs at an adaptive rate instead of a fixed 10 fps: 2 fps while calm, 8 fps when the child is near, moving or not SAFE, and 0 fps while the TV is paused (`lib/firesense/frame-rate.ts`). The latency, footprint and "62%" figures above were not measured by us and should not be quoted; measured phone-side numbers go in `MEASUREMENT_EVIDENCE.md`.

---

## Friction Entry 5: Body Height Variability vs. 2-Point Floor Position Calibration

- **Task**: Accurately estimate physical distance to TV across children of different ages (e.g., 3-year-old toddler vs. 8-year-old child vs. adult parent) using a single camera.
- **Expected**: Monocular bounding box height or torso length correlates reliably to metric distance across all viewers.
- **Actual**: A 95cm toddler standing at 1.2m presents the same apparent image height as a 130cm child standing at 1.6m. Relying on body height introduced catastrophic false `TOO_CLOSE` triggers for younger children and under-protection for older children.
- **Severity**: CRITICAL (fundamental algorithmic flaw if unaddressed)
- **Workaround Implemented**:
  1. Abandoned body height as the primary metric scaling source.
  2. Implemented **2-Point Floor Position Calibration** (`lib/firesense/floor-calibration.ts`):
     - Calibrated two known physical floor markers (Marker A: 1.2m, Marker B: 1.8m).
     - Extracted foot ground contact points ($y_{ankle}, y_{heel}, y_{foot\_index}$) from MediaPipe Pose.
     - Fitted flat projective ground plane model: $\frac{1}{d} = a \cdot y + b$.
  3. Applied Interquartile Range (IQR) outlier filtering and sample sufficiency checks ($\ge 15$ high-confidence samples per marker) before transitioning room profile to `ROOM READY 🌟`.
- **Actionable Suggestion for Smart Home & Vision Standards**: Establish standardized domestic floor calibration benchmarks for smart TV vision systems, separating floor plane geometry from biological anthropometry.
- **Current build (2026-09-26)**: the principle stands (distance comes from where the feet touch the floor, never from body size), but the default calibration is now **TV-marker calibration** (`lib/firesense/tv-marker.ts`): the TV paints its screen black, then magenta; the phone finds the screen's corners, solves its own focal length and pose from the known screen size, and maps the floor as a homography. No tape and no markers on the floor. The 2-point linear model and tap calibration remain in `lib/firesense/floor-calibration.ts` as a manual option and for the debug images.

---

## Friction Entry 6: Child Privacy & Cloud VLM Leakage Safeguard (Person-Presence Guard)

- **Task**: Allow a Vision-Language Model (Claude Sonnet 4.6 on Amazon Bedrock) to understand living room geometry (TV, sofa, camera placement) without exposing child imagery to the cloud.
- **Expected**: Parents can upload a living room setup photo, but child privacy must be 100% physically guaranteed.
- **Actual**: If a parent accidentally takes a photo while a child or family member is present, standard web apps transmit the full photograph directly to cloud VLM endpoints, violating the core zero-child-video privacy promise.
- **Severity**: CRITICAL (regulatory and ethical risk)
- **Workaround Implemented**:
  1. Built client-side **Person-Presence Guard** (`lib/firesense/person-guard.ts`).
  2. Before initiating ANY network transfer to `POST /spatial/analyze` (Lambda), self-hosted MediaPipe face detection **and** pose detection run on the selected image inside the phone browser. If the detectors cannot load, the guard throws — it never allows by default.
  3. If ANY person is detected, network transmission is **hard-blocked in JavaScript**. The raw image NEVER leaves the device.
  4. Added explicit user confirmation checkbox: "[x] I confirmed that nobody is in the room" (then shown in Japanese).
  5. Enforced Strict Fail-Fast Policy: raw error messages are surfaced to developers and judges without silent mock fallback.
- **Actionable Suggestion for Cloud AI Providers**: Provide privacy-attested edge pre-filtering SDKs (Edge Privacy Enclaves) that verify zero human presence locally before accepting image payloads in cloud vision APIs.
- **Update (2026-09-25)**: superseded by a stronger design. TV-marker calibration and the on-device watch zone replaced every image-based setup step, so **no image is uploaded at all**; the Person Guard, the setup-check endpoint and its Lambda were removed.

---

## Friction Entry 7: Ring as the sensor — a design decision, not tested

- **Task**: Decide whether a Ring indoor camera, instead of a spare phone, should be the sensor for the Fire TV.
- **Expected**: An Amazon camera already in the home would make the setup simpler and tell an Amazon-on-Amazon story.
- **Actual**: We did not build or test a Ring integration, so this entry contains no measurements. We decided against it
  on the design alone: FireSense's rule is that video never leaves the sensing device and only numbers reach the cloud,
  so pose estimation has to run where the frames are. A camera whose live view reaches an app through a cloud service
  would break that rule; a camera that runs the analysis itself and sends only results would fit it.
- **Severity**: Design decision (no code, no friction measured)
- **Workaround Implemented**: none needed. The sensor is a phone running pose estimation on-device, behind a small
  numeric protocol (`telemetry`, `heartbeat`), so any camera that can produce the same messages could replace it.
- **Actionable Suggestion for Ring**: an on-device analytics path (pose or person position computed on the camera,
  only numbers exposed to partner apps) would let privacy-first apps like this one use a camera families already own.

---

## Friction Entry 8: Android asset packaging silently drops Next.js `_next/` (Fire TV WebView APK)

- **Task**: Ship the statically exported `/tv` page inside the Fire TV APK and serve it with `WebViewAssetLoader` from `https://appassets.androidplatform.net/tv/`.
- **Expected**: Everything copied to `src/main/assets/web/` ends up in the APK.
- **Actual** (observed 2026-09-23 on the `FireTV_1080p` emulator): the page loaded but stayed on the idle video poster. Logcat showed every `web/_next/static/chunks/*.js` returning 404. aapt's default `ignoreAssetsPattern` contains `<dir>_*`, which excludes **any asset directory starting with an underscore**, and Next.js puts all JS/CSS under `_next/`. The build succeeds without a warning.
- **Severity**: HIGH (a blank app on the TV, with no build-time signal)
- **Workaround Implemented**: set `androidResources.ignoreAssetsPattern` to the default list minus `<dir>_*` (`firetv-app/app/build.gradle.kts`), and added a `verifyWebAssets` Gradle task that fails the build if `assets/web/tv/index.html` is missing.
- **Actionable Suggestion for Amazon Fire TV docs**: the "web app → Fire TV APK" guide should call out this default and show a `WebViewAssetLoader` template that works with modern static-site generators out of the box.

---

## Friction Entry 9: API Gateway WebSocket constraints for a living-room relay

- **Task**: Relay numeric telemetry between the watch phone and the Fire TV with no extra box in the home (API Gateway WebSocket + Lambda + DynamoDB).
- **Expected**: a WebSocket that can answer a client as it connects and stays open for a whole show, as a small server of our own would.
- **Actual**:
  1. A Lambda cannot `postToConnection` to a client **during `$connect`**, so session/pairing data cannot be returned on connect. We added explicit `tv_hello` / `camera_hello` messages sent right after the socket opens.
  2. Connections are closed after **10 minutes idle** and **2 hours** in total. A child's show easily crosses both.
  3. A phone browser tab in the background stops the camera without closing the socket, so the TV cannot rely on `close` alone.
- **Workaround Implemented**: a 1 Hz `heartbeat` from the phone keeps the socket alive, and the TV treats 3 s of silence as "sensor disconnected". It clears the blur and shows a calm badge instead of freezing a blurred picture. Exponential-backoff reconnect (1→30 s) to the same endpoint covers the 2-hour limit. Relay logs contain only numeric JSON (see CloudWatch).
- **Actionable Suggestion for AWS**: document a first-class "server → client on connect" pattern for WebSocket APIs and surface the idle/max-duration limits in the console's stage settings.

---

## Friction Entry 10: Emulator snapshot restores an old clock → HTTPS fails with no useful error

- **Task**: Save the TV's daily summary to `POST /session/summary` (API Gateway HTTP API) from the Fire TV emulator.
- **Expected**: the emulator keeps the host's time after a snapshot is restored, as a real device syncs its clock.
- **Actual** (2026-09-23): after the Mac slept and the emulator came back from its `default_boot` snapshot, every save failed with `TypeError: Failed to fetch`. The WebSocket relay kept working. Logcat showed `net_error -201` (`ERR_CERT_DATE_INVALID`). The guest clock was restored to the snapshot time (2026-09-13). The HTTP API's certificate was issued on 2026-09-22, so it was "not yet valid", while the WebSocket API's certificate (issued 2026-07-07) still passed. JavaScript only sees "Failed to fetch".
- **Severity**: MEDIUM (it looks like an app bug; records also carry the wrong date)
- **Workaround Implemented**: `make emu-start` always cold-boots (`-no-snapshot`), and `make emu-status` prints the Android time next to the host time. Network error messages in the app now include the device time.
- **Actionable Suggestion for Amazon Fire TV tooling**: sync the guest clock on snapshot restore (or warn when it is off by more than a few minutes), and document this for web-based Fire TV apps.

---

## Friction Entry 11: A VLM cannot give pixel-accurate floor lines → split the job (on-device geometry, Claude semantics)

- **Task**: Calibrate distance for a phone placed beside the TV (diagonal view) without asking a parent to tap points precisely.
- **Expected**: a multimodal model that can see the tapes can also give their pixel coordinates to within a few pixels.
- **Actual** (2026-09-23): Asking Claude Sonnet 4.6 on Bedrock for pixel coordinates of the three floor tapes in `public/debug/side-empty.jpg` returned plausible-looking lines that were off by more than 100 px, and in the wrong direction (requestId `90b49cbc-2121-4e38-9133-fa6136c97b0c`). A homography fitted on those points would silently produce wrong distances.
- **Severity**: HIGH (a wrong calibration looks fine and gives wrong blur for every frame after it)
- **Workaround Implemented**: set-of-marks. The phone finds straight strips of colored tape deterministically (`lib/firesense/floor-lines.ts`: vivid pixels whose hue differs from the floor, then sequential RANSAC + PCA). On the side debug image the three tapes come out within a few pixels. The candidates are drawn on the frame with numbers, and Claude only picks which numbers are tapes parallel to the TV screen, nearest first (`POST /spatial/floor-lines`). It picked `[1, 2, 3]`, rejected the false candidate (a yellow horizontal edge), and put the TV on the left (requestId `88c9c157-105b-4e99-9366-17593c364cfa`). Unknown or duplicate ids are a 502; a wrong count is shown to the parent. Person Guard runs before upload.
- **Actionable Suggestion**: document the pointing accuracy of multimodal models for measurement-style tasks, and recommend candidate-selection prompting when coordinates matter.

- **Update (2026-09-25)**: the AI tape selection was later removed as well. Tape on the floor is unlikely to be used at home, and the TV-marker calibration needs neither tape nor AI. The lesson stands: when coordinates matter, keep geometry deterministic and give a VLM only choices.
---

## Friction Entry 12: Real Fire TV plays `<video>` in a hardware overlay → black picture with sound in a WebView app

- **Task**: Play the cartoon inside the WebView APK and blur it with a CSS `filter`, as it worked on the Fire TV emulator.
- **Expected**: Same behavior as the emulator (Google WebView).
- **Actual** (2026-09-26, Fire TV Stick 4K Max `AFTKA`, Amazon WebView 138): QR code and audio worked, the picture was black. The decoder was fine (`MediaCodecLogger` rendered 640×360 frames). Amazon WebView puts every `<video>` into a hardware overlay: a `SurfaceView` behind the page (`cr_SurfaceViewOverlayCore`), so the opaque page hides it, and a CSS blur could not reach it anyway. There is exactly one overlay per page: logcat says `AWV Unable to create overlay; MAX_OVERLAYS limit hit.` and the next video is drawn into the page like in a normal browser. CSS (`filter`, `opacity`, `transform`, `border-radius`) and size did not change this. Releasing the first player later makes AWV hand the overlay to the playing video (black again), and after the app is paused and resumed the first player to restart takes it. A 128×72 clip is not given the overlay; 640×360 is.
- **Severity**: CRITICAL (the app shows nothing on real hardware; the emulator never shows it)
- **Workaround Implemented**: a hidden, muted 2 px "holder" video loops a 4 KB black 640×360 clip and takes the overlay before the real video gets its `src` (`lib/client/awv-overlay.ts`). While the TV plays, a watcher reads a frame back through a canvas once a second (an overlay video reads as exact zeros); after 6 black reads it restarts the holder and reloads the video at the same position, and shows the raw error only if three recoveries in a row fail. The WebView keeps an opaque background, which also hides the holder's plane.
- **Actionable Suggestion for Amazon Fire TV**: document the Amazon WebView overlay policy (which videos get the overlay, the limit of one, what happens on resume), and offer a WebView setting to keep `<video>` in the page for apps that need CSS effects on it. Test web-based apps on real hardware early: the emulator's WebView behaves differently.

---

## Friction Entry 13: Hardware-decoded frames drawn into the page show green stripes → encode for the software decoder (AV1)

- **Task**: Play the parent's videos (H.264 720p, Wikimedia Commons VP9) in the page so the blur applies.
- **Expected**: once the overlay problem of entry 12 is solved, hardware-decoded video drawn in the page looks as it does on the emulator.
- **Actual** (2026-09-26/27, same device): a vertical band (often the right ~20%, sometimes the whole picture) of the video turned green while playing; UI drawn above the video (star badge, cards) stayed correct, and nothing appeared while paused. Screenshots and a 20 s screen recording (273 frames) never showed it, so it happens only on the way to the display. The parent noticed that *Spring* never had it while *Big Buck Bunny* and *Llamigos* did. The CDP `Media` domain on the device gave the reason: *Spring* (VP9 854×358) used `VpxVideoDecoder` (software), the others `MediaCodecVideoDecoder` (hardware). Test clips: H.264, VP8 720p and VP9 ≥ 360 lines → MediaCodec; VP9 < 360 lines and **AV1 720p → `Dav1dVideoDecoder`**. AV1 720p ran at 60 fps rendering with 0 dropped video frames over 15 s, with and without a 17 px blur, and the parent saw no green on it.
- **Severity**: HIGH (visible artifacts on every hardware-decoded video; invisible to screenshots and QA tools)
- **Workaround Implemented**: every preset and sample video, and the clip bundled in the APK, is AV1 (≤ 720p, SVT-AV1), mirrored on our CloudFront with pinned SHA-256 sources and credits (`scripts/upload-media.sh`). Saved lists with the old URLs are upgraded to the AV1 files. The parent screen recommends AV1 for their own videos.
- **Actionable Suggestion for Amazon Fire TV**: fix or document the corruption of hardware-decoded frames composited as textures in Amazon WebView, and say which codecs/resolutions are decoded in software. A way to read the decoder in use from the app (without DevTools) would have saved a day.

---

## Friction Entry 14: WebView HTTP cache reuses a response without CORS headers → "Format error"

- **Task**: Stream the preset videos from CloudFront with `crossOrigin="anonymous"` (needed to read frames back for Entry 12's check).
- **Expected**: once CloudFront returns CORS headers, the TV's `crossOrigin` requests succeed.
- **Actual** (2026-09-26): after adding a CloudFront response-headers policy with CORS, the TV still failed with `MEDIA_ELEMENT_ERROR: Format error`, and `fetch` from the page was blocked ("No 'Access-Control-Allow-Origin' header"). CloudFront's managed CORS policy adds the header only to requests that carry `Origin`; a copy fetched once without `Origin` (no CORS header, `Cache-Control: immutable`) was reused by the WebView's HTTP cache for the CORS request. `Access-Control-Allow-Origin` cannot be set as a CloudFront custom header.
- **Severity**: MEDIUM (looks like a broken file; only clearing the WebView cache showed the cause)
- **Workaround Implemented**: a CloudFront response-headers policy with CORS for `media/*` plus a custom `Vary: Origin` header, and the media is only ever requested with `crossOrigin`.
- **Actionable Suggestion for AWS**: have the managed CORS policies send `Vary: Origin` (or document that they need it when objects are also fetched without `Origin`).


## Friction Entry 15: The pose model does not see a small child across the room — the camera choice mattered most

- **Task**: Detect a toddler watching TV with the phone on a shelf in the corner of a real living room (about 4.5 m from the TV, lens at 1.7 m).
- **Expected**: a pose model that finds adults across the room also finds a small child there.
- **Actual** (2026-09-27, field): adults were detected, the child only when the camera was moved much closer; a seated adult was also often missed. Offline measurements with the same model file (`scripts/pose-bench/`) showed why: MediaPipe Pose finds a person only when they are about 0.3–0.4 of the height of the image it gets, whatever the thresholds, and the heavy model does no better. In that room the child was ~0.1 of the frame. On the field still, a crop around the child did not help either (2–6×, any threshold, heavy model): the child had their back to the camera, and the detector starts from the face.
- **What fixed it in the field**: switching from an iPad's **front** camera (very wide, visibly distorted at the edges, low resolution) to a Galaxy S20's **rear** camera. The distortion and the low resolution made small people smaller and blurrier than the geometry alone suggests.
- **Severity**: HIGH (the product's main user is the one the model misses)
- **Workaround Implemented**: the rear camera is the default and the setup text says why; the camera asks for 1920×1440; a second pass scans the watch zone (known from the TV-marker pose) in 4× tiles and follows whoever it finds. Thresholds stay at 0.7: at 0.5 the zoomed tiles found "people" in sofa cushions.
- **Actionable Suggestion**: pose-model cards should state the smallest person size (in pixels of the model input) and the behavior for people seen from behind, and on-device SDKs could expose a region-of-interest parameter for the detector instead of making apps crop and re-map landmarks themselves.


## Friction Entry 16: After Fire TV standby, the WebView's `play()` rejects with AbortError until the app restarts

- **Task**: Keep the TV app usable when the family switches the TV off (HDMI-CEC puts the Fire TV in standby) and on again the next day.
- **Expected**: after the TV is switched off and on again, the app resumes and plays as before.
- **Actual** (2026-09-27, field): on relaunch the page showed "Cannot play (AbortError)" (then shown in Japanese) and the camera phone as not connected; only quitting the app from its own menu and starting it again helped. The activity survives standby, so the page is resumed rather than reloaded, but its media pipeline and WebSocket are gone. `adb shell input keyevent KEYCODE_SLEEP` did not reproduce it (playback continued), so the fix could not be verified on the bench.
- **Severity**: HIGH (looks broken every morning)
- **Workaround Implemented**: after more than 30 s in the background the page reloads itself on resume (at most once per 5 minutes), restoring the playlist and the playback position; `play()` retries an AbortError twice before reloading.
- **Actionable Suggestion for Amazon**: document what a WebView app should expect after standby (media, sockets, lifecycle events), and offer an adb command that enters the same standby as the TV's power button over CEC, so this can be tested without a TV.

---

## Evidence: real Amazon Bedrock calls (Claude Sonnet 4.6)

Call path: `infra/lambda/src/lib/insight-core.ts` → `invokeClaude()` → Bedrock `InvokeModel`, model `us.anthropic.claude-sonnet-4-6` (US cross-region inference profile, us-east-1). Produced by `tests/bedrock-live.test.ts` against three synthetic daily summaries (numbers only).

| Date (JST) | Endpoint logic | requestId | Latency | Input tokens | Output tokens | stop_reason |
|---|---|---|---|---|---|---|
| 2026-09-23 | weekly report | `363710c2-1023-4704-bb5e-686015bf8fe2` | 7,892 ms | 601 | 357 | end_turn |
| 2026-09-23 | weekly report | `9823dd33-f7a7-434a-8529-ffa3264aa397` | 7,172 ms | 601 | 373 | end_turn |
| 2026-09-23 | setup check (image, `empty-tilted-up` fixture) → `TILT_DOWN`, floor_near `ng` | `1eded4e6-a9cb-47d5-9606-88e2b3392c95` | 12,977 ms | 2,181 | 695 | end_turn |
| 2026-09-23 | setup check (image, `empty-obstacle-backlit` fixture) → approach_path / backlight `ng` | `d84e940c-fc12-4b83-bb83-477774cd6156` | 12,371 ms | 2,181 | 705 | end_turn |
| 2026-09-23 | floor-line selection (`side-empty` debug image, 4 candidates) → `[1, 2, 3]`, TV left, #4 rejected | `88c9c157-105b-4e99-9366-17593c364cfa` | 8,263 ms | 1,598 | 408 | end_turn |

The two *setup check* rows and the *floor-line selection* row come from endpoints that were removed on 2026-09-25 (entries 6 and 11); they are kept as evidence of what was tried. Bedrock is used today only for the weekly report.

Calls from the deployed Lambdas log the same fields as `{"evt":"bedrock_invoke", ...}` in CloudWatch (`/aws/lambda/firesense-kids-dev-report`, `-spatial`).

---

## Summary of Friction Log Impact

State of each entry in the current build (2026-10-22). "Replaced" means the problem was solved by a different design than the entry's first workaround; the entry's **Current build** / **Update** line has the details.

| # | Friction area | Severity | What ships today | Status |
| :-: | :--- | :---: | :--- | :--- |
| 1 | Web autoplay on Fire TV | HIGH | WebView APK with `mediaPlaybackRequiresUserGesture = false`; remote Play/Pause toggles; desktop trial retries on first click | Replaced (Silk → APK) |
| 2 | Secure context for the phone camera | HIGH | Phone page over HTTPS (CloudFront) + AWS relay; test mode sends synthetic numbers through the real relay | Replaced (local IP → cloud relay) |
| 3 | Telemetry transport and reconnects | MEDIUM | WebSocket relay, `seq` ordering, confidence hysteresis 0.60/0.45; 3 s silence → blur cleared + "Sensor not connected" | Replaced (SSE → WebSocket; freeze → clear) |
| 4 | On-device pose cost on the phone | MEDIUM | MediaPipe Pose Full (confidence 0.7); explicit GPU, explicit CPU retry; adaptive 2 / 8 / 0 fps, and the loop waits at least the inference time on a slow phone | Current (no silent fallback) |
| 5 | Body size is not distance | CRITICAL | Distance from foot–floor contact; TV-marker calibration only (self-calibrating, no tape); 2-point / tap kept for development only | Current |
| 6 | Child images reaching a cloud VLM | CRITICAL | No image is uploaded at all; Person Guard and setup check removed | Replaced (guard → nothing to guard) |
| 7 | Ring as the sensor | DECISION | Not integrated or tested; phone + on-device CV only | Decision, no code |
| 8 | aapt drops `_next/` from APK assets | HIGH | Custom `ignoreAssetsPattern` + `verifyWebAssets` Gradle task | Current |
| 9 | API Gateway WebSocket limits | — | `tv_hello` / `camera_hello`, 1 Hz heartbeat, 3 s disconnect, backoff reconnect 1→30 s | Current |
| 10 | Emulator snapshot restores an old clock | MEDIUM | `make emu-start` always cold-boots; `make emu-status` shows device time; errors include device time | Current |
| 11 | VLM pixel coordinates are inaccurate | HIGH | Geometry is deterministic on the phone; AI no longer used for setup | Replaced (lesson kept) |
| 12 | Amazon WebView plays `<video>` in a hardware overlay (black, no blur) | CRITICAL | Hidden holder video owns the overlay; once-a-second drawn check with automatic recovery | Current |
| 13 | Hardware-decoded frames in the page turn green | HIGH | All presets, samples and the bundled clip in AV1 (software decode); AV1 recommended for own videos | Current |
| 14 | WebView cache reuses a non-CORS response | MEDIUM | CloudFront CORS policy + `Vary: Origin` on `media/*` | Current |
| 15 | Small children across the room are not detected | HIGH | Rear camera by default, 1920×1440, 4× zoom tiles around the TV that follow the person found | Current |
| 16 | `play()` fails with AbortError after Fire TV standby | HIGH | After more than 30 s in the background the page reloads on resume (at most once per 5 min), restoring playlist and position; `play()` retries AbortError twice | Current (not reproducible on the bench) |
