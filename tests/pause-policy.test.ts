import { describe, expect, test } from "vitest";
import {
  PauseTracker,
  stepPauseTracker,
  INITIAL_PAUSE_TRACKER_STATE,
  PAUSE_RECOVERY_MS,
  type PausePolicyConfig,
} from "../lib/firesense/pause-policy";
import { DEFAULT_TV_SETTINGS } from "../lib/firesense/protocol";

describe("Pause Policy (U2 §5)", () => {
  const baseConfig: PausePolicyConfig = { enabled: true, afterSeconds: 20 };

  test("defaults: the pause is an opt-in stronger rule (off, 20s once enabled)", () => {
    expect(DEFAULT_TV_SETTINGS.pause).toEqual({ enabled: false, afterSeconds: 20 });
    const tracker = new PauseTracker(DEFAULT_TV_SETTINGS.pause);
    for (let t = 0; t <= 120_000; t += 1_000) {
      expect(tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: 100_000 + t })).toBe("none");
    }
    expect(tracker.isPaused).toBe(false);
  });

  test("pauses when TOO_CLOSE stays continuously for afterSeconds (20s boundary)", () => {
    let state = { ...INITIAL_PAUSE_TRACKER_STATE };
    const t0 = 100_000;

    // t0: SAFE
    let res = stepPauseTracker(state, { state: "SAFE", mode: "intervene", connected: true, nowMs: t0, config: baseConfig });
    expect(res.action).toBe("none");
    expect(res.next.isPaused).toBe(false);
    state = res.next;

    // t0 + 1s: enters TOO_CLOSE
    res = stepPauseTracker(state, { state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 1_000, config: baseConfig });
    expect(res.action).toBe("none");
    expect(res.next.isPaused).toBe(false);
    expect(res.next.violatingSince).toBe(t0 + 1_000);
    state = res.next;

    // t0 + 20.999s: 19.999s in TOO_CLOSE -> still not paused
    res = stepPauseTracker(state, { state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 20_999, config: baseConfig });
    expect(res.action).toBe("none");
    expect(res.next.isPaused).toBe(false);
    state = res.next;

    // t0 + 21s: exactly 20.000s in TOO_CLOSE -> action: pause!
    res = stepPauseTracker(state, { state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 21_000, config: baseConfig });
    expect(res.action).toBe("pause");
    expect(res.next.isPaused).toBe(true);
    state = res.next;

    // t0 + 22s: continues in TOO_CLOSE while paused -> no new action, stays paused
    res = stepPauseTracker(state, { state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 22_000, config: baseConfig });
    expect(res.action).toBe("none");
    expect(res.next.isPaused).toBe(true);
  });

  test("BELOW_FRAME also triggers pause after afterSeconds", () => {
    const tracker = new PauseTracker({ enabled: true, afterSeconds: 10 });
    const t0 = 50_000;

    expect(tracker.step({ state: "BELOW_FRAME", mode: "intervene", connected: true, nowMs: t0 })).toBe("none");
    expect(tracker.isPaused).toBe(false);

    expect(tracker.step({ state: "BELOW_FRAME", mode: "intervene", connected: true, nowMs: t0 + 9_999 })).toBe("none");
    expect(tracker.isPaused).toBe(false);

    expect(tracker.step({ state: "BELOW_FRAME", mode: "intervene", connected: true, nowMs: t0 + 10_000 })).toBe("pause");
    expect(tracker.isPaused).toBe(true);
  });

  test("supports configurable boundary seconds (10s to 60s)", () => {
    const tracker60 = new PauseTracker({ enabled: true, afterSeconds: 60 });
    const t0 = 10_000;

    tracker60.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 });
    expect(tracker60.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 59_999 })).toBe("none");
    expect(tracker60.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 60_000 })).toBe("pause");
    expect(tracker60.isPaused).toBe(true);
  });

  test("LOW_CONFIDENCE, disconnected, or SAFE resets violation timer (uncounted)", () => {
    const tracker = new PauseTracker(baseConfig);
    const t0 = 100_000;

    // TOO_CLOSE for 15s
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 });
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 15_000 });
    expect(tracker.isPaused).toBe(false);

    // Camera has LOW_CONFIDENCE -> resets timer
    tracker.step({ state: "LOW_CONFIDENCE", mode: "intervene", connected: true, nowMs: t0 + 16_000 });
    expect(tracker.currentState.violatingSince).toBeNull();

    // Returns to TOO_CLOSE at t0 + 17s: needs full 20s from here
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 17_000 });
    expect(tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 36_000 })).toBe("none");
    expect(tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 37_000 })).toBe("pause");
    expect(tracker.isPaused).toBe(true);
  });

  test("disconnected link resets violation timer", () => {
    const tracker = new PauseTracker(baseConfig);
    const t0 = 100_000;

    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 });
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 10_000 });

    // Link disconnects
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: false, nowMs: t0 + 11_000 });
    expect(tracker.currentState.violatingSince).toBeNull();
  });

  test("auto-resumes when state returns to SAFE or APPROACHING for 2 continuous seconds", () => {
    const tracker = new PauseTracker(baseConfig);
    const t0 = 100_000;

    // Trigger pause
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 });
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 20_000 });
    expect(tracker.isPaused).toBe(true);

    const pauseTime = t0 + 20_000;

    // Step back to APPROACHING at pauseTime + 5s
    expect(tracker.step({ state: "APPROACHING", mode: "intervene", connected: true, nowMs: pauseTime + 5_000 })).toBe("none");
    expect(tracker.isPaused).toBe(true);

    // After 1.9s of recovery -> still paused
    expect(
      tracker.step({ state: "SAFE", mode: "intervene", connected: true, nowMs: pauseTime + 5_000 + PAUSE_RECOVERY_MS - 1 })
    ).toBe("none");
    expect(tracker.isPaused).toBe(true);

    // After 2.0s of continuous recovery -> auto-resume!
    expect(
      tracker.step({ state: "SAFE", mode: "intervene", connected: true, nowMs: pauseTime + 5_000 + PAUSE_RECOVERY_MS })
    ).toBe("resume");
    expect(tracker.isPaused).toBe(false);
  });

  test("stepping back in during 2s recovery window resets the recovery timer", () => {
    const tracker = new PauseTracker(baseConfig);
    const t0 = 100_000;

    // Trigger pause
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 });
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 20_000 });
    expect(tracker.isPaused).toBe(true);

    const pauseTime = t0 + 20_000;

    // SAFE for 1.5s
    tracker.step({ state: "SAFE", mode: "intervene", connected: true, nowMs: pauseTime + 1_000 });
    tracker.step({ state: "SAFE", mode: "intervene", connected: true, nowMs: pauseTime + 2_500 });
    expect(tracker.isPaused).toBe(true);

    // Moves back to TOO_CLOSE at 2.6s
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: pauseTime + 2_600 });
    expect(tracker.currentState.recoveringSince).toBeNull();
    expect(tracker.isPaused).toBe(true);

    // Moves to SAFE again at 4.0s: needs fresh 2s (until 6.0s)
    tracker.step({ state: "SAFE", mode: "intervene", connected: true, nowMs: pauseTime + 4_000 });
    expect(tracker.step({ state: "SAFE", mode: "intervene", connected: true, nowMs: pauseTime + 5_999 })).toBe("none");
    expect(tracker.step({ state: "SAFE", mode: "intervene", connected: true, nowMs: pauseTime + 6_000 })).toBe("resume");
    expect(tracker.isPaused).toBe(false);
  });

  test("shadow mode never pauses, and immediately resumes if paused", () => {
    const tracker = new PauseTracker(baseConfig);
    const t0 = 100_000;

    // In shadow mode: stays TOO_CLOSE for 100s, never pauses
    for (let sec = 0; sec <= 100; sec += 10) {
      const act = tracker.step({ state: "TOO_CLOSE", mode: "shadow", connected: true, nowMs: t0 + sec * 1000 });
      expect(act).toBe("none");
      expect(tracker.isPaused).toBe(false);
    }

    // Trigger pause in intervene mode
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 });
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 20_000 });
    expect(tracker.isPaused).toBe(true);

    // Mode switched to shadow -> immediately resumes
    expect(tracker.step({ state: "TOO_CLOSE", mode: "shadow", connected: true, nowMs: t0 + 21_000 })).toBe("resume");
    expect(tracker.isPaused).toBe(false);
  });

  test("disabling pause in config immediately resumes if paused", () => {
    const tracker = new PauseTracker(baseConfig);
    const t0 = 100_000;

    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 });
    tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 20_000 });
    expect(tracker.isPaused).toBe(true);

    tracker.updateConfig({ enabled: false, afterSeconds: 20 });
    expect(tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 21_000 })).toBe("resume");
    expect(tracker.isPaused).toBe(false);
  });

  test("while paused, nobody seen (or no camera) for 5 s releases the pause; a short loss does not", () => {
    for (const lost of [
      { state: "LOW_CONFIDENCE" as const, connected: true },
      { state: null, connected: true },
      { state: "TOO_CLOSE" as const, connected: false },
    ]) {
      const tracker = new PauseTracker(baseConfig);
      const t0 = 100_000;
      tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 });
      expect(tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 20_000 })).toBe("pause");
      // Lost for 3 s, then seen still too close: stays paused, the lost timer restarts.
      tracker.step({ ...lost, mode: "intervene", nowMs: t0 + 21_000 });
      expect(tracker.step({ ...lost, mode: "intervene", nowMs: t0 + 24_000 })).toBe("none");
      tracker.step({ state: "TOO_CLOSE", mode: "intervene", connected: true, nowMs: t0 + 24_500 });
      tracker.step({ ...lost, mode: "intervene", nowMs: t0 + 25_000 });
      expect(tracker.step({ ...lost, mode: "intervene", nowMs: t0 + 29_000 })).toBe("none");
      expect(tracker.step({ ...lost, mode: "intervene", nowMs: t0 + 30_000 })).toBe("resume");
      expect(tracker.isPaused).toBe(false);
    }
  });
});
