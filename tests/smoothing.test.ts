import { describe, expect, test } from "vitest";
import { DistanceSmoother, SensorPipeline, ViewingStateMachine, PIPELINE_STATE_DEBOUNCE } from "../lib/firesense";
import { footYAt, person, testFloorModel } from "./helpers/landmarks";

describe("DistanceSmoother", () => {
  const up = (s: DistanceSmoother, d: number, t: number, key = "1", source: "feet" | "hips" = "feet") => s.update(d, source, 0.9, key, t).distanceM;

  test("median of the last 1.5 s rejects single outliers", () => {
    const s = new DistanceSmoother();
    const out = [1.2, 1.21, 0.5, 1.19, 1.2, 1.9, 1.2].map((d, i) => up(s, d, i * 150));
    expect(out[2]).toBeGreaterThan(1.0);
    expect(out[5]).toBeLessThan(1.3);
    expect(out[6]).toBeCloseTo(1.2, 2);
  });

  test("feet and hip estimates of the same person share one history", () => {
    const s = new DistanceSmoother();
    up(s, 1.2, 0);
    up(s, 1.25, 150, "1", "hips");
    up(s, 1.2, 300);
    expect(up(s, 0.6, 450, "1", "hips")).toBeGreaterThan(1.1);
  });

  test("starts over for another person and after the window", () => {
    const s = new DistanceSmoother();
    up(s, 2.0, 0);
    up(s, 2.0, 100);
    expect(up(s, 0.8, 200, "2")).toBe(0.8);
    expect(up(s, 1.5, 3000, "2")).toBe(1.5);
  });

  test("hold: a lost frame reuses the same person's last distance for up to 1 s", () => {
    const s = new DistanceSmoother();
    up(s, 1.4, 0, "7");
    expect(s.hold("7", 500)).toMatchObject({ distanceM: 1.4, source: "feet" });
    expect(s.hold("8", 500)).toBeNull();
    expect(s.hold("7", 1200)).toBeNull();
  });
});

describe("state debounce (pipeline settings)", () => {
  const sm = () => new ViewingStateMachine({ ...PIPELINE_STATE_DEBOUNCE, tooCloseThresholdMeters: 0.6, safeRecoveryThresholdMeters: 1.0 });
  const frame = (d: number) => ({ footStatus: "VISIBLE" as const, distanceM: d, confidence: 0.9, posture: "GOOD" as const });

  test("one close frame does not show the card; staying close for 400 ms does", () => {
    const m = sm();
    expect(m.update(frame(0.5), 0).state).not.toBe("TOO_CLOSE");
    expect(m.update(frame(0.8), 125).state).toBe("APPROACHING");
    expect(m.update(frame(0.5), 250).state).not.toBe("TOO_CLOSE");
    expect(m.update(frame(0.5), 500).state).not.toBe("TOO_CLOSE");
    const warned = m.update(frame(0.5), 650);
    expect(warned.state).toBe("TOO_CLOSE");
    expect(warned.event).toBe("WARN");
  });

  test("one far frame does not end the warning (no stray 'nice step'); 800 ms beyond the exit line does", () => {
    const m = sm();
    m.update(frame(0.5), 0);
    m.update(frame(0.5), 500);
    expect(m.update(frame(0.8), 600)).toMatchObject({ state: "TOO_CLOSE", event: undefined });
    expect(m.update(frame(0.5), 700).state).toBe("TOO_CLOSE");
    expect(m.update(frame(0.8), 800).state).toBe("TOO_CLOSE");
    expect(m.update(frame(0.8), 1200).state).toBe("TOO_CLOSE");
    const back = m.update(frame(0.8), 1650);
    expect(back.state).toBe("APPROACHING");
    expect(back.event).toBe("PHASE1_RECOVERY");
  });

  test("hovering just inside the exit hysteresis (0.65 m) stays TOO_CLOSE", () => {
    const m = sm();
    m.update(frame(0.5), 0);
    m.update(frame(0.5), 500);
    for (let t = 600; t < 3000; t += 125) expect(m.update(frame(0.65), t).state).toBe("TOO_CLOSE");
  });

  test("SAFE is not left for a reading just under the SAFE line", () => {
    const m = sm();
    expect(m.update(frame(1.2), 0).state).toBe("SAFE");
    expect(m.update(frame(0.97), 125).state).toBe("SAFE");
    expect(m.update(frame(0.9), 250).state).toBe("APPROACHING");
  });
});

describe("pipeline: jittery feet do not flip the state", () => {
  test("a child standing at 0.8 m with ±0.25 m single-frame jitter never gets the card", () => {
    const model = testFloorModel();
    const p = new SensorPipeline();
    p.setCalibration(model);
    p.setThresholds(0.6, 1.0);
    const jitter = [0, 0, -0.25, 0, 0.05, 0, -0.25, 0, 0, 0.2, 0, -0.25, 0];
    let t = 0;
    for (const j of jitter) {
      const out = p.process([person({ footY: footYAt(0.8 + j, model) })], (t += 125));
      expect(out.state).not.toBe("TOO_CLOSE");
      expect(out.event).toBeUndefined();
    }
  });
});

describe("pipeline: brief losses and two people", () => {
  test("feet lost for single frames keep the state instead of LOW_CONFIDENCE", () => {
    const model = testFloorModel();
    const p = new SensorPipeline({ personFilter: { minHits: 1 } });
    p.setCalibration(model);
    p.setThresholds(0.6, 1.0);
    let t = 0;
    const states: string[] = [];
    for (let i = 0; i < 16; i++) {
      const feet = i % 3 !== 2; // every third frame the feet are missed
      states.push(p.process([person({ footY: feet ? footYAt(1.4, model) : undefined })], (t += 125)).state);
    }
    expect(states).not.toContain("LOW_CONFIDENCE");
  });

  test("two people at about the same distance: the chosen one does not alternate", () => {
    const model = testFloorModel();
    const p = new SensorPipeline({ personFilter: { minHits: 1 } });
    p.setCalibration(model);
    p.setThresholds(0.6, 1.0);
    // Frame to frame, the two readings swap which one is nearer by 0.1 m (landmark jitter).
    const picks: number[] = [];
    for (let i = 0; i < 12; i++) {
      const a = footYAt(i % 2 ? 1.3 : 1.4, model);
      const b = footYAt(i % 2 ? 1.4 : 1.3, model);
      picks.push(p.process([person({ footY: a, x: 0.3 }), person({ footY: b, x: 0.7 })], i * 125).nearest);
    }
    expect(new Set(picks.slice(1)).size).toBe(1);
  });
});
