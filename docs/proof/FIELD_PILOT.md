# FireSense Kids — Field Pilot (shadow vs. intervene)

> **Status: not run for this submission (decided 2026-10-11).** Small-child detection is not reliable yet when the
> child fills only a small part of the camera frame, and over 3 + 3 days it is uncertain whether a child would watch
> close to the TV at all; the numbers would not be meaningful. This protocol is kept as designed, to run once
> detection is reliable. The submission's evidence is the system measurements in
> [MEASUREMENT_EVIDENCE.md](./MEASUREMENT_EVIDENCE.md), taken with an adult viewer.
>
> Every value below is intentionally empty. Numbers come only from the exported
> CSV of real households (`scripts/export-pilot.mjs`), committed next to this file. No number here may be
> estimated, simulated, or copied from design targets. Interpretation is written separately, after the data.

**Question.** In a real living room, does a household see less "too close" viewing, fewer approaches, faster
step-backs, and fewer parental "step back!" reminders with FireSense **on** than with FireSense only
**recording**?

**Design.** Each household runs **3 days of shadow mode, then 3 days of intervene mode** on the same TV,
phone placement, and thresholds.

- **Shadow** (`mode: "shadow"`, chosen on the phone): the TV plays normally. No blur, no mascot card, no voice,
  no stars, no toasts. A small fixed "Record only" label sits in a TV corner and never changes with distance.
  The phone still measures and the TV records every number.
- **Intervene** (`mode: "intervene"`): the core response only, with the default TV settings ("How the TV responds"):

  | Setting | Pilot value |
  |---|---|
  | Progressive blur and dimming | on (always, not a setting) |
  | Small marker | on |
  | Child-friendly cues (card, voice, stars) | off |
  | Pause after sustained too-close viewing | off |

  The pilot asks one question: does the proportional blur itself change where children watch from? Changing
  several cues at once would leave no way to tell which one mattered. The pause is also left off because, while
  the video is paused by FireSense, the TV counts neither viewing time nor too-close time, so it would shrink the
  main metric by construction. A household that wants the pause is recorded as a deviation (§1 and §3), not mixed
  into the core results.
- Test-mode input (`test: true`) is never recorded in either mode.

---

## 1. Conditions

| Item | Value |
|---|---|
| Households | |
| Children's ages (range) | |
| Period (dates, per household) | |
| Order | shadow → intervene (if a household runs the reverse order, say so in §3) |
| Phone placement (position, height, angle) | |
| Calibration method (TV marker / lines / geometry) and `d_edge` | |
| Thresholds (TOO_CLOSE / SAFE) | defaults 1.30m / 1.65m unless changed — record the actual values |
| TV settings in intervene mode (marker / child cues / pause) | defaults on / off / off — record any change and the day it was made |
| Fire TV model / Fire OS, phone model / browser | |

## 2. Procedure

1. Pair the watch phone with the TV (QR), press "Start watching" on it once, and leave it in place. Then pair a
   parent phone: on the TV press OK → "Add a parent phone" and scan that QR with the parent's phone.
   Calibrate and set the thresholds from the parent phone (`/parent`). Check "How the TV responds": marker on,
   child cues off, pause off. Record the settings in §1.
2. On the parent phone, select **Record only**. Check that the TV shows "Record only" and no blur.
   Optionally black out the watch phone's screen from the parent phone (sensing continues).
3. Days 1–3: watch as usual. Whenever a parent says "step back" (or similar), press **Said "step back" +1**
   on the parent phone's `/parent`. Use **−1 undo** for a mistaken press.
4. Day 4 morning: switch to **Respond** from the parent phone (no need to touch the watch phone). Days 4–6: same as step 3.
5. Within 30 days (records expire), export:

   ```bash
   set -a; . ./.env; set +a
   SUMMARIES_TABLE=$(terraform -chdir=infra/terraform output -raw daily_summaries_table) \
     node scripts/export-pilot.mjs --household A=<sessionId> --household B=<sessionId> \
     --from 2026-10-05 --to 2026-10-12 --out docs/proof/pilot
   ```

   The sessionId is shown on the TV's debug overlay (Menu key / `?debug=1`).
6. Commit `docs/proof/pilot/pilot-days.csv` and `pilot-summary.csv`, then fill in §3 from them.

**Metrics** (per household × mode, from `pilot-summary.csv`):

| Metric | Definition |
|---|---|
| Viewing time | Seconds the video played with a known mode (`viewingSeconds`) |
| Too-close time per viewing hour | Seconds playing **and** sensor connected **and** state TOO_CLOSE / BELOW_FRAME, per hour of viewing |
| Approaches per viewing hour | `WARN` events (entering TOO_CLOSE / BELOW_FRAME) per hour of viewing |
| Time to step back (median) | Seconds from a `WARN` to the next `SAFE`, pooled over the household's days (max 200 per day; `recoveryTruncatedDays` says if the cap was hit) |
| Parent reminders | Presses of the reminder button (total, and per viewing hour over days with viewing data) |

Sensor disconnections are not "too close": seconds while the link is down are never counted as warn seconds.

## 3. Results

| Household | Mode | Days | Viewing (h) | Too-close s / h | Approaches / h | Step-back median (s) | Parent reminders (total / per h) |
|---|---|---|---|---|---|---|---|
| A | shadow | | | | | | |
| A | intervene | | | | | | |
| B | shadow | | | | | | |
| B | intervene | | | | | | |
| C | shadow | | | | | | |
| C | intervene | | | | | | |

Order deviations: 

## 4. Parent comments

Quoted verbatim, only with the parent's written consent.

> 

## 5. What did not work

Every case where FireSense behaved badly or the setup failed (lost tracking, wrong warnings, phone moved,
battery, two children, pets, lighting …), with the date and what was seen.

- 

## 6. Limitations

- **Very small n** (2–4 households) and **short periods** (3 + 3 days). This is a field check, not a study.
- **Order effect**: intervene always follows shadow, so novelty, habituation, or a change in the week's
  schedule cannot be separated from the effect of FireSense.
- Parents know which mode is on, and the reminder button relies on them remembering to press it.
- The phone measures distance with an on-device pose model; its own errors are part of the numbers
  (see [MEASUREMENT_EVIDENCE.md](./MEASUREMENT_EVIDENCE.md)).
- **Results are not generalized.** They describe these households in these days only. Nothing here is a
  claim about eyesight, myopia, or health.
