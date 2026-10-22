import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DistanceSmoother, PIPELINE_STATE_DEBOUNCE, ViewingStateMachine } from "../lib/firesense";

// A real living-room session (relay log, 48 min, numbers only), recorded by the build before
// smoothing: per-frame distances of the chosen person, as the phone sent them. Replayed through the
// current smoothing + debounce with the thresholds the family used (0.60 m / 1.00 m).
type Frame = [ms: number, state: string, distanceM: number | null, event: string | null];
const fixture = JSON.parse(readFileSync("tests/fixtures/field-telemetry-2026-09-26.json", "utf8")) as { frames: Frame[] };

function summarize(states: string[], events: (string | null | undefined)[], minutes: number) {
  let changes = 0;
  for (let i = 1; i < states.length; i++) if (states[i] !== states[i - 1]) changes++;
  const count = (e: string) => events.filter((x) => x === e).length;
  return { changesPerMin: Number((changes / minutes).toFixed(1)), warn: count("WARN"), phase1: count("PHASE1_RECOVERY"), lowConfidenceShare: Number((states.filter((s) => s === "LOW_CONFIDENCE").length / states.length).toFixed(2)) };
}

describe("field replay (2026-09-26, real living room)", () => {
  test("smoothing + debounce: far fewer state changes and warnings than the logged session", () => {
    const frames = fixture.frames;
    const minutes = frames[frames.length - 1][0] / 60000;
    const logged = summarize(frames.map((f) => f[1]), frames.map((f) => f[3]), minutes);

    const sm = new ViewingStateMachine({ ...PIPELINE_STATE_DEBOUNCE, tooCloseThresholdMeters: 0.6, safeRecoveryThresholdMeters: 1.0 });
    const smoother = new DistanceSmoother();
    const states: string[] = [];
    const events: (string | undefined)[] = [];
    for (const [ms, state, d] of frames) {
      let input: Parameters<ViewingStateMachine["update"]>[0];
      if (state === "BELOW_FRAME") input = { footStatus: "BELOW_FRAME", distanceM: null, confidence: 0.9, posture: "GOOD" };
      else if (d !== null) input = { footStatus: "VISIBLE", distanceM: smoother.update(d, "feet", 0.9, "1", ms).distanceM, confidence: 0.9, posture: "GOOD" };
      else {
        const held = smoother.hold("1", ms);
        input = held ? { footStatus: "ESTIMATED", distanceM: held.distanceM, confidence: held.confidence, posture: "GOOD" } : { footStatus: "OCCLUDED", distanceM: null, confidence: 0, posture: "GOOD" };
      }
      const out = sm.update(input, ms);
      states.push(out.state);
      events.push(out.event === "POSTURE_NUDGE" ? undefined : out.event);
    }
    const replay = summarize(states, events, minutes);
    console.log(JSON.stringify({ minutes: Number(minutes.toFixed(1)), logged, replay }));
    expect(replay.changesPerMin).toBeLessThan(logged.changesPerMin / 4);
    expect(replay.warn).toBeLessThanOrEqual(Math.ceil(logged.warn / 2));
    expect(replay.phase1).toBeLessThanOrEqual(Math.ceil(logged.phase1 / 2));
  });
});
