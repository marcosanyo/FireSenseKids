import { describe, expect, test } from "vitest";
import { AdaptiveFrameRate, blurPxForDistance, ViewingStateMachine, type FrameInput } from "../lib/firesense";
import { APPROACH_MAX_PX, TOO_CLOSE_MIN_PX } from "../lib/firesense/blur-policy";

const at = (d: number, confidence = 0.9): FrameInput => ({ footStatus: "VISIBLE", distanceM: d, confidence, posture: "GOOD" });
const lost: FrameInput = { footStatus: "OCCLUDED", distanceM: null, confidence: 0, posture: "UNKNOWN" };
const below: FrameInput = { footStatus: "BELOW_FRAME", distanceM: null, confidence: 0.9, posture: "UNKNOWN" };

describe("blur ramp", () => {
  test("a light hint between the lines, a clear jump at the red line (0.8m), full 0.3m inside it", () => {
    expect(blurPxForDistance(1.65)).toBe(0);
    expect(blurPxForDistance(2.5)).toBe(0);
    expect(blurPxForDistance(1.6)).toBe(1); // just inside the green line: visible, but slight
    expect(blurPxForDistance(1.225)).toBe(2);
    expect(blurPxForDistance(0.8)).toBe(APPROACH_MAX_PX); // on the red line, not yet past it
    expect(blurPxForDistance(0.79)).toBeGreaterThanOrEqual(TOO_CLOSE_MIN_PX);
    expect(blurPxForDistance(0.5)).toBe(24);
    expect(blurPxForDistance(0.3)).toBe(24);
    expect(TOO_CLOSE_MIN_PX - APPROACH_MAX_PX).toBeGreaterThanOrEqual(10);
  });

  test("the level follows the state: TOO_CLOSE keeps the strong blur in its exit hysteresis, APPROACHING stays light during the entry dwell", () => {
    const sm = new ViewingStateMachine({ tooCloseThresholdMeters: 1.0, safeRecoveryThresholdMeters: 1.6, tooCloseExitHysteresisMeters: 0.1, enterDwellMs: 400 });
    expect(sm.update(at(0.9), 0)).toMatchObject({ state: "APPROACHING", blurPx: APPROACH_MAX_PX });
    expect(sm.update(at(0.9), 400)).toMatchObject({ state: "TOO_CLOSE" });
    expect(sm.update(at(1.05), 500)).toMatchObject({ state: "TOO_CLOSE", blurPx: TOO_CLOSE_MIN_PX });
    expect(sm.update(at(1.3), 600).blurPx).toBeLessThanOrEqual(APPROACH_MAX_PX);
  });
});

describe("adjustable thresholds", () => {
  test("user thresholds move TOO_CLOSE / SAFE and the blur ramp together", () => {
    const sm = new ViewingStateMachine();
    sm.setThresholds(1.0, 1.4);
    expect(sm.update(at(1.2), 0).state).toBe("APPROACHING"); // was TOO_CLOSE with defaults
    expect(sm.update(at(1.45), 100)).toMatchObject({ state: "SAFE", blurPx: 0 });
    expect(sm.update(at(0.9), 200)).toMatchObject({ state: "TOO_CLOSE" });
    expect(sm.update(at(0.5), 300).blurPx).toBe(24);
  });

  test("the minimum gap is accepted despite floating-point error (1.2 + 0.1)", () => {
    expect(() => new ViewingStateMachine().setThresholds(1.2, 1.3)).not.toThrow();
    expect(() => new ViewingStateMachine().setThresholds(2.5, 2.6)).not.toThrow();
  });

  test("invalid thresholds fail fast", () => {
    expect(() => new ViewingStateMachine().setThresholds(1.5, 1.55)).toThrow(/SAFE must be/);
  });
});

describe("ViewingStateMachine — two-phase recovery", () => {
  test("SAFE → APPROACHING → TOO_CLOSE (WARN) → Phase 1 → Phase 2 star after 2s dwell", () => {
    const sm = new ViewingStateMachine();
    expect(sm.update(at(2.0), 0).state).toBe("SAFE");
    expect(sm.update(at(1.5), 100).state).toBe("APPROACHING");

    const warn = sm.update(at(1.1), 200);
    expect(warn).toMatchObject({ state: "TOO_CLOSE", event: "WARN" });
    expect(warn.blurPx).toBeGreaterThan(0);
    expect(sm.update(at(1.0), 300).event).toBeUndefined(); // warn only once

    // hysteresis: 1.32m is still TOO_CLOSE on the way out
    expect(sm.update(at(1.32), 400).state).toBe("TOO_CLOSE");

    const p1 = sm.update(at(1.5), 500);
    expect(p1).toMatchObject({ state: "APPROACHING", event: "PHASE1_RECOVERY" });
    expect(p1.blurPx).toBeGreaterThan(0);

    expect(sm.update(at(1.8), 600)).toMatchObject({ state: "SAFE", blurPx: 0 });
    expect(sm.update(at(1.8), 2_000).event).toBeUndefined();
    expect(sm.update(at(1.8), 2_600).event).toBe("STAR_AWARDED");
    expect(sm.update(at(1.8), 3_000).event).toBeUndefined();
  });

  test("no star without a warned episode (brushing APPROACHING is not a recovery)", () => {
    const sm = new ViewingStateMachine();
    sm.update(at(1.5), 0);
    sm.update(at(1.8), 100);
    expect(sm.update(at(1.8), 5_000).event).toBeUndefined();
  });

  test("star cooldown 15s", () => {
    const sm = new ViewingStateMachine();
    const episode = (t: number) => {
      sm.update(at(1.0), t);
      sm.update(at(1.8), t + 100);
      return sm.update(at(1.8), t + 2_200).event;
    };
    expect(episode(0)).toBe("STAR_AWARDED");
    expect(episode(5_000)).toBeUndefined();
    expect(episode(20_000)).toBe("STAR_AWARDED");
  });
});

describe("ViewingStateMachine — BELOW_FRAME", () => {
  test("max blur, WARN on entry from SAFE, then Phase 1 when feet reappear", () => {
    const sm = new ViewingStateMachine();
    sm.update(at(2.0), 0);
    expect(sm.update(below, 100)).toMatchObject({ state: "BELOW_FRAME", blurPx: 24, distanceM: null, event: "WARN" });
    expect(sm.update(below, 200).event).toBeUndefined();
    expect(sm.update(at(1.5), 300)).toMatchObject({ state: "APPROACHING", event: "PHASE1_RECOVERY" });
  });
});

describe("ViewingStateMachine — LOW_CONFIDENCE", () => {
  test("holds the last blur up to 5s, then clears, and the dwell timer does not advance", () => {
    const sm = new ViewingStateMachine();
    const tc = sm.update(at(1.0), 0);
    expect(sm.update(lost, 100)).toMatchObject({ state: "LOW_CONFIDENCE", blurPx: tc.blurPx, distanceM: null });
    expect(sm.update(lost, 5_000).blurPx).toBe(tc.blurPx);
    expect(sm.update(lost, 5_100).blurPx).toBe(0);
  });

  test("confidence hysteresis: exit < 0.45, re-enter >= 0.60", () => {
    const sm = new ViewingStateMachine();
    sm.update(at(2.0, 0.9), 0);
    expect(sm.update(at(2.0, 0.4), 100).state).toBe("LOW_CONFIDENCE");
    expect(sm.update(at(2.0, 0.55), 200).state).toBe("LOW_CONFIDENCE");
    expect(sm.update(at(2.0, 0.65), 300).state).toBe("SAFE");
  });

  test("losing the child for > 5s cancels the pending star", () => {
    const sm = new ViewingStateMachine();
    sm.update(at(1.0), 0);
    sm.update(lost, 100);
    sm.update(lost, 6_000);
    sm.update(at(1.8), 6_100);
    expect(sm.update(at(1.8), 9_000).event).toBeUndefined();
  });
});

describe("ViewingStateMachine — posture is ambient only", () => {
  test("POSTURE_NUDGE after 4s of slouching in SAFE; blur stays 0; 30s cooldown", () => {
    const sm = new ViewingStateMachine();
    const slouch = (t: number) => sm.update({ ...at(2.0), posture: "SLOUCH" }, t);
    expect(slouch(0).event).toBeUndefined();
    const n = slouch(4_000);
    expect(n).toMatchObject({ event: "POSTURE_NUDGE", blurPx: 0, state: "SAFE" });
    expect(slouch(10_000).event).toBeUndefined();
    expect(slouch(34_000).event).toBe("POSTURE_NUDGE");
  });
});

describe("ViewingStateMachine — posture while the feet are hidden (sitting)", () => {
  const hidden = (posture: "SLOUCH" | "GOOD"): FrameInput => ({ footStatus: "OCCLUDED", distanceM: null, confidence: 0, posture });
  test("last trusted state SAFE → the nudge still fires after 4s", () => {
    const sm = new ViewingStateMachine();
    sm.update(at(2.0), 0);
    expect(sm.update(hidden("SLOUCH"), 100).state).toBe("LOW_CONFIDENCE");
    expect(sm.update(hidden("SLOUCH"), 4_100)).toMatchObject({ state: "LOW_CONFIDENCE", event: "POSTURE_NUDGE" });
  });
  test("last trusted state TOO_CLOSE → no nudge while the blur is held", () => {
    const sm = new ViewingStateMachine();
    sm.update(at(1.0), 0);
    sm.update(hidden("SLOUCH"), 100);
    expect(sm.update(hidden("SLOUCH"), 4_200).event).toBeUndefined();
  });
});

describe("AdaptiveFrameRate", () => {
  test("idle 2fps; 8fps when near, jumping, or not SAFE; back to 2fps after 3s calm", () => {
    const fr = new AdaptiveFrameRate();
    expect(fr.update("SAFE", 3.0, 0)).toBe(2);
    expect(fr.update("SAFE", 1.9, 500)).toBe(8); // near
    expect(fr.update("SAFE", 2.5, 1_000)).toBe(8); // jump 0.6m
    expect(fr.update("SAFE", 2.5, 2_000)).toBe(8);
    expect(fr.update("SAFE", 2.5, 4_900)).toBe(8);
    expect(fr.update("SAFE", 2.5, 5_000)).toBe(2);
    expect(fr.update("LOW_CONFIDENCE", null, 5_500)).toBe(8);
  });

  test("|Δd| alone triggers fast mode even far away", () => {
    const fr = new AdaptiveFrameRate();
    fr.update("SAFE", 3.5, 0);
    expect(fr.update("SAFE", 3.2, 500)).toBe(8);
  });

  test("paused → 0fps and infinite interval", () => {
    const fr = new AdaptiveFrameRate();
    fr.setPaused(true);
    expect(fr.update("TOO_CLOSE", 1.0, 0)).toBe(0);
    expect(fr.intervalMs()).toBe(Infinity);
    fr.setPaused(false);
    expect(fr.current()).toBe(2);
  });
});
