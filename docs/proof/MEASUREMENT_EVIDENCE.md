# FireSense Kids — Measurement Protocol & Evidence

> **Status (2026-10-21): §1 distance accuracy is measured** (one adult, in front of the TV, one 10 s trial per
> distance; raw CSV in `docs/proof/data/`). §2–§6 are not measured yet: their tables are intentionally empty.
> No number here may be estimated, simulated, or copied from design targets.

## Headline numbers (filled in after measurement)

These are the numbers the README and the Devpost text may quote. Each links to its table below. A number that
turned out badly is still reported here, together with the condition that caused it.

| Claim it supports | Number | Source |
|---|---|---|
| "The TV itself becomes the ruler" | TV-marker calibration alone: median distance error **10 cm** (p90 16 cm) at 0.8–1.4 m; after a two-point tape correction: **3 cm** (p90 5 cm, max 8 cm) at 0.8–1.4 m. Phone in the far corner of the room, adult viewer | §1 |
| The picture reacts when the viewer crosses the line | Threshold crossing → blur visible on the TV: not run for this submission (protocol ready) | §3 |
| Blur does not ruin playback on a Fire TV stick | Video fps at 24px blur on the device: not run for this submission (benchmark built in) | §5 |
| Walking under the camera's view is caught; walking away is not | BELOW_FRAME walk/run-ins: not run for this submission (protocol ready) | §2 |
| Sensor failure restores clear playback | Sensor lost → blur cleared: not run for this submission (the TV logs it) | §6 |

**System under test:** Fire TV APK (`firetv-app/`) · watch phone `/camera` (MediaPipe Pose full, on-device) ·
AWS API Gateway WebSocket relay (us-east-1) · protocol v1 (`lib/firesense/protocol.ts`).

Record for every run: date, Fire TV model + Fire OS version, phone model + browser version, MediaPipe
delegate (GPU/CPU, shown on `/camera`), room lighting, phone mounting height and angle, the **calibration
method** (TV marker / tapped lines / two marks / geometry), and `d_edge` shown after calibration. For the TV
marker also record the TV size entered, the estimated vertical FOV, focal mismatch, and the estimated height of
the screen bottom next to the measured one.

---

## 1. Distance accuracy

**Method.** Reference marks on the floor from 0.8m to 2.0m in 20cm steps, measured from the TV screen with a
laser distance meter (the reference; the marks are for measuring only, not for calibration). Calibrate with the
method under test (primary: TV marker, phone at the side of the room), then stand still for 10s on each mark,
at two lateral positions (in front of the TV center and 0.5m to the side).
This submission measures with an **adult viewer** (distance comes from the feet on the floor, not from body size). Say so next to every quoted number. Place the phone so the adult's shoulders and hips stay in view at the TOO_CLOSE line.

**Recording.** On the watch phone, `/camera` → "Measure distance accuracy (validation)": enter the laser-measured distance,
choose "In front of the TV" or "0.5 m to the side", and press "Record 10 s" while the subject stands on the mark. Every pipeline
frame is kept on the phone (distance, state, confidence, and the calibration method in use); a frame without a
distance (feet not found, BELOW_FRAME) is counted as missing, never as an error of 0. Measuring alone, start each trial
from the **parent phone** held on the mark (watch settings → "Measure distance accuracy (validation)": distance, position,
"Start in 3 s", "Record 10 s"): the watch phone records without being touched (touching it can tilt it and stop the
distances), and the parent phone shows each trial's summary line. A floor corrected by hand or with a tape measure is
recorded as a separate method (`tv_marker+adjusted`). "Save CSV" (on the watch phone) writes the raw
frames; commit them as `docs/proof/data/distance-<date>.csv` and generate the table below with

```bash
node scripts/distance-accuracy-report.mjs docs/proof/data/distance-*.csv
```

It prints one row per method × distance × position (mean, bias, MAE, median absolute error, std dev, missing
frames) and, per calibration method, the headline line "median distance error X cm (p90, max)".

**Run 2026-10-21** (`docs/proof/data/distance-20261021-1530-heel.csv`). One adult, standing still with the **heels** on
the mark (the phone sees the room from its far corner, so the lowest foot point in its view is the heel). Marks from a
tape measure laid out from the TV stand. In front of the TV only
(the +0.5 m positions were not measured). `tv_marker`: the TV-marker calibration as it came out; `tv_marker+adjusted`:
after the parent phone's "Match the distance with a tape measure" at 1.2 m and 0.7 m (1.2 m is therefore a fitting
point, not an independent check). Output of `node scripts/distance-accuracy-report.mjs`:

| Method | True distance | Lateral | Trials | Frames | Missing | Mean estimate | Bias | MAE | Median abs error | Std dev |
|---|---|---|---|---|---|---|---|---|---|---|
| tv_marker | 0.80m | center | 1 | 36 | 0 | 0.646m | -0.154m | 0.154m | 0.16m | 0.017m |
| tv_marker | 1.00m | center | 1 | 35 | 0 | 0.863m | -0.137m | 0.137m | 0.14m | 0.012m |
| tv_marker | 1.20m | center | 1 | 51 | 0 | 1.143m | -0.057m | 0.061m | 0.06m | 0.049m |
| tv_marker | 1.40m | center | 1 | 51 | 0 | 1.356m | -0.044m | 0.06m | 0.06m | 0.046m |
| tv_marker | 1.60m | center | 1 | 19 | 0 | 1.682m | 0.082m | 0.082m | 0.09m | 0.029m |
| tv_marker+adjusted | 0.80m | center | 1 | 53 | 0 | 0.823m | 0.023m | 0.023m | 0.02m | 0.008m |
| tv_marker+adjusted | 1.00m | center | 1 | 52 | 0 | 0.978m | -0.022m | 0.022m | 0.02m | 0.017m |
| tv_marker+adjusted | 1.20m | center | 1 | 52 | 0 | 1.172m | -0.028m | 0.028m | 0.03m | 0.013m |
| tv_marker+adjusted | 1.40m | center | 1 | 52 | 0 | 1.425m | 0.025m | 0.031m | 0.025m | 0.029m |
| tv_marker+adjusted | 1.60m | center | 1 | 43 | 33 | 1.711m | 0.111m | 0.111m | 0.115m | 0.018m |

- **tv_marker**: median distance error **10 cm** (p90 16 cm, max 19 cm) over 192 frames in 5 conditions; 0 frames without a distance.
- **tv_marker+adjusted**: median distance error **3 cm** (p90 6 cm, max 13 cm) over 219 frames in 5 conditions; 33 frames without a distance.

- **1.6 m: the feet were partly hidden by a table.** Kept as an occlusion case, not part of the headline: after the
  correction 33 of 43 frames had no distance (`LOW_CONFIDENCE`, nothing sent as a distance), and the frames that had
  one read 11 cm far. **Headline, without the 1.6 m rows (feet in view, 0.8–1.4 m):** calibration alone 10 cm
  (p90 16 cm, max 19 cm, 173 frames); after the correction 3 cm (p90 5 cm, max 8 cm, 209 frames); at the three distances not used for the fit (0.8, 1.0,
  1.4 m) 2 cm (max 8 cm, 157 frames).
- Without the correction the error changes with distance (−15 cm at 0.8 m, +8 cm at 1.6 m): a scale and offset error
  of the calibration in this room, which the two tape points remove. One trial per distance; repeatability across
  calibrations was not measured.

## 2. BELOW_FRAME

**Method.** From 1.5m, walk toward the TV 10 times and run toward it 10 times. Log the telemetry `state`
sequence and the last measured `distanceM` before `BELOW_FRAME`. Separately, walk out of frame sideways
10 times and hide the feet behind an object 10 times (both must NOT fire).

| Condition | Trials | Fired | Distance at firing (median) | False fires |
|---|---|---|---|---|
| Walk in | 10 | | | — |
| Run in | 10 | | | — |
| Exit sideways | 10 | — | — | |
| Feet occluded | 10 | — | — | |

## 3. End-to-end latency (relay included)

**Method.** One 240fps video that shows both the TV screen and the viewer's feet. Count frames from
"feet cross the threshold line on the floor" to "blur visible on the TV". Clocks on different
devices are never compared.

| Runs | Median | p90 | Min | Max |
|---|---|---|---|---|
| | | | | |

**Supporting number: relay round trip (recorded on the TV).** On the remote press **OK → "Measurement menu" → "Relay round trip"** (browser: `t`
with the debug overlay open). The TV sends 20 `rtt_ping` messages, one per second, and times each `rtt_pong` from
the phone on its own clock: TV → relay → phone → relay → TV. A probe without a reply within 5 s is counted as
lost, never as a time. Result in the debug overlay and in logcat
(`adb logcat -d -s FireSenseKids | grep firesense-measure | grep relay_rtt`).
This is **only the network part**. It does not include camera capture, pose detection (2 / 8 fps), or the TV's
500 ms blur transition, and one way is not exactly half of the round trip. Quote it only next to the video
method above.

| Date | Network (TV / phone) | Probes | Lost | Median (ms) | p90 (ms) | Min | Max |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 4. Adaptive frame rate and heat

**Method.** Run 30 minutes continuously with normal viewing plus periodic approaches. Record the
heartbeat `fps` over time (TV debug overlay, or the relay logs in CloudWatch), phone battery
temperature, and battery drain.

| Idle fps | Active fps | % time active | Temp at start | Temp at 30 min | Battery used |
|---|---|---|---|---|---|
| | | | | | |

## 5. TV rendering cost

**Method.** On the Fire TV device, while the cartoon is playing, open **OK → "Measurement menu" → "Render benchmark"** on the remote
(in a desktop browser: open the debug overlay with `d`, then press `f`). The TV steps through blur
0 / 12 / 24 px × `full` / `downscale` by itself: 2 s to settle, then 5 s of counting per step (about 45 s in all;
start it again from the menu to stop). The table appears in the debug overlay, and the run is saved on the TV and printed to
logcat as one JSON line with a CSV inside (`lib/client/tv-bench.ts`, `lib/client/measure-log.ts`):

```bash
adb logcat -d -s FireSenseKids | grep firesense-measure | grep render_bench
```

- *Render fps*: `requestAnimationFrame` callbacks per second. *Video fps*: `requestVideoFrameCallback` callbacks
  per second (frames actually presented); `n/a` if the WebView lacks it. *Dropped*: the change in
  `getVideoPlaybackQuality().droppedVideoFrames` during the 5 s.
- The player applies downscale only when blur > 0, so 0px `downscale` is a second baseline.
- The run stops with an error if the video is paused; it never records numbers for a still picture.

| Blur | Mode | Render fps | Video fps | Dropped (5 s) |
|---|---|---|---|---|
| 0px | full | | | |
| 12px | full | | | |
| 24px | full | | | |
| 0px | downscale | | | |
| 12px | downscale | | | |
| 24px | downscale | | | |

## 6. Disconnect behaviour

**Method.** While blurred, (a) close the phone tab, (b) turn on airplane mode, (c) lock the phone,
(d) switch the phone to another app. For each action the TV records one line by itself
(`disconnect_clear` in `adb logcat -d -s FireSenseKids | grep firesense-measure`, and the last one in the debug
overlay):

- `reason` / `peerLeft`: how the TV learned it (`PEER_LEFT` + `hidden` / `pagehide` when the phone said so,
  `PEER_OFFLINE` from the relay, `SILENT` after 3 s of nothing)
- `lastPeerMessageAgoMs`: last telemetry or heartbeat → drop detected (TV clock)
- `detectToClearMs`: drop detected → the video's computed filter is back to `none` (the blur is gone on screen)
- `lastPeerMessageToClearMs`: the sum. `null` if the blur was not gone within 5 s (reported, never filled in);
  `recoveredBeforeClear: true` if the phone came back first

The TV cannot see the moment of the action itself (before the phone's last message). For "action → clear", also
time it with a stopwatch or the 240 fps video from §3. Spec: ≤ 3 s + 0.5 s fade.

| Action | Trials | Reason seen on the TV | Last message → clear, median (s) | Action → clear, median (s, video) | Badge + reason shown |
|---|---|---|---|---|---|
| Close tab | | | | | |
| Airplane mode | | | | | |
| Screen lock | | | | | |
| Another app | | | | | |

## 7. Where it did not work

Every condition that made a number worse, or made FireSense misbehave, with the date and what was seen:
reflections on the TV screen during TV-marker calibration, a steep camera angle, low light, a sofa hiding the
feet, two children, a pet, the phone being moved after calibration. A short, honest list here is part of the
evidence, not a weakness to hide.

| Date | Condition | What happened | Affected numbers |
|---|---|---|---|
| | | | |
