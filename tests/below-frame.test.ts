import { describe, expect, test } from "vitest";
import {
  BelowFrameTracker,
  computeEdgeDistance,
  extractGroundContactPoint,
  observeBody,
  SensorPipeline,
  type FloorHomographyModel,
} from "../lib/firesense";
import { footYAt, person, testFloorModel } from "./helpers/landmarks";

// These tests are about distance / BELOW_FRAME logic: a person counts from the first frame, and
// every frame counts on its own (no smoothing, no dwell; those have their own tests).
const NO_PERSISTENCE = {
  personFilter: { minHits: 1 },
  smoothing: { windowMs: 0 },
  stateMachine: { enterDwellMs: 0, exitDwellMs: 0, tooCloseExitHysteresisMeters: 0.05, safeHysteresisMeters: 0 },
};

describe("floor model edge distance (d_edge = 1 / (a + b))", () => {
  test("is the distance at which the feet reach y = 1", () => {
    const model = testFloorModel();
    const dEdge = computeEdgeDistance(model);
    expect(footYAt(dEdge)).toBeCloseTo(1, 1);
    expect(dEdge).toBeGreaterThan(0.8);
    expect(dEdge).toBeLessThan(1.2);
  });

  test("throws on a degenerate model instead of inventing a number", () => {
    expect(() => computeEdgeDistance({ a: -1, b: 0.5 })).toThrow(/Degenerate/);
  });
});

describe("no knee / height substitution (review A2)", () => {
  test("extractGroundContactPoint returns null when only knees are visible", () => {
    const lms = person({ footY: undefined });
    expect(extractGroundContactPoint(lms)).toBeNull();
    expect(observeBody(lms).groundY).toBeNull();
  });
});

describe("BelowFrameTracker — the three cases", () => {
  test("① feet leave the bottom edge with torso visible → BELOW_FRAME (latched)", () => {
    const t = new BelowFrameTracker();
    expect(t.update(observeBody(person({ footY: 0.93 })), 0).status).toBe("VISIBLE");
    const r = t.update(observeBody(person({ footY: undefined })), 125);
    expect(r.status).toBe("BELOW_FRAME");
    expect(r.latched).toBe(true);
  });

  test("② walking out sideways → NO_PERSON, not BELOW_FRAME", () => {
    const t = new BelowFrameTracker();
    t.update(observeBody(person({ footY: 0.7, x: 0.95 })), 0);
    expect(t.update(observeBody(null), 125).status).toBe("NO_PERSON");
  });

  test("③ feet hidden mid-frame (table, toy box) → OCCLUDED, not BELOW_FRAME", () => {
    const t = new BelowFrameTracker();
    t.update(observeBody(person({ footY: 0.7 })), 0);
    expect(t.update(observeBody(person({ footY: undefined })), 125).status).toBe("OCCLUDED");
  });

  test("feet at the edge but torso not visible → OCCLUDED", () => {
    const t = new BelowFrameTracker();
    t.update(observeBody(person({ footY: 0.95 })), 0);
    expect(t.update(observeBody(person({ footY: undefined, torsoVisible: false })), 125).status).toBe("OCCLUDED");
  });

  test("stale foot sighting (> 1s ago) does not trigger", () => {
    const t = new BelowFrameTracker();
    t.update(observeBody(person({ footY: 0.95 })), 0);
    expect(t.update(observeBody(person({ footY: undefined })), 1500).status).toBe("OCCLUDED");
  });
});

describe("BelowFrameTracker — distance gate (phone at the side of the room)", () => {
  test("feet leave the bottom edge while far from the TV (walking toward the phone) → OCCLUDED", () => {
    const t = new BelowFrameTracker({ maxExitDistanceM: 1.3 });
    t.update(observeBody(person({ footY: 0.95 })), 0, 1.6);
    expect(t.update(observeBody(person({ footY: undefined })), 125).status).toBe("OCCLUDED");
  });

  test("the same exit while inside TOO_CLOSE → BELOW_FRAME", () => {
    const t = new BelowFrameTracker({ maxExitDistanceM: 1.3 });
    t.update(observeBody(person({ footY: 0.95 })), 0, 1.1);
    expect(t.update(observeBody(person({ footY: undefined })), 125).status).toBe("BELOW_FRAME");
  });

  test("pipeline: any-placement (homography) models are gated by the TOO_CLOSE slider", () => {
    // Z = 3 − 2y: feet at y = 0.95 read 1.10m.
    const side: FloorHomographyModel = { kind: "homography", p: [0, -2, 3], q: [0, 0], maxResidualM: 0, lines: [], calibratedAt: 0 };
    const p = new SensorPipeline(NO_PERSISTENCE);
    p.setCalibration(side);
    p.setThresholds(0.8, 1.2); // 1.10m is outside TOO_CLOSE → walking toward the phone, not the TV
    p.process([person({ footY: 0.95 })], 0);
    expect(p.process([person({ footY: undefined })], 125).foot.status).toBe("OCCLUDED");
    p.setThresholds(1.3, 1.65);
    p.process([person({ footY: 0.95 })], 250);
    expect(p.process([person({ footY: undefined })], 375).foot.status).toBe("BELOW_FRAME");
  });

  test("pipeline: front placement (y-only model) is not gated", () => {
    const p = new SensorPipeline(NO_PERSISTENCE);
    p.setCalibration(testFloorModel());
    p.setThresholds(0.8, 1.2);
    p.process([person({ footY: 0.95 })], 0);
    expect(p.process([person({ footY: undefined })], 125).foot.status).toBe("BELOW_FRAME");
  });
});

describe("BelowFrameTracker — latch release (plan §3)", () => {
  const latched = () => {
    const t = new BelowFrameTracker();
    t.update(observeBody(person({ footY: 0.95 })), 0);
    t.update(observeBody(person({ footY: undefined })), 100);
    return t;
  };

  test("stays latched while the person is present without feet, even after 30s", () => {
    const t = latched();
    expect(t.update(observeBody(person({ footY: undefined })), 60_000).status).toBe("BELOW_FRAME");
  });

  test("stays latched when detection drops briefly (child too close for the model)", () => {
    const t = latched();
    expect(t.update(observeBody(null), 5_000).status).toBe("BELOW_FRAME");
    expect(t.update(observeBody(null), 29_000).status).toBe("BELOW_FRAME");
  });

  test("releases when the feet are seen again", () => {
    const t = latched();
    expect(t.update(observeBody(person({ footY: 0.8 })), 2_000).status).toBe("VISIBLE");
    expect(t.isLatched()).toBe(false);
  });

  test("releases after 30s with no person detected", () => {
    const t = latched();
    t.update(observeBody(null), 1_000);
    expect(t.update(observeBody(null), 30_999).status).toBe("BELOW_FRAME");
    expect(t.update(observeBody(null), 31_000).status).toBe("NO_PERSON");
  });
});

describe("SensorPipeline — running child at 8fps reaches BELOW_FRAME with max blur", () => {
  test("approach → edge → cut off", () => {
    const p = new SensorPipeline(NO_PERSISTENCE);
    p.setCalibration(testFloorModel());
    const frames = [2.0, 1.6, 1.25, 1.05, 0.99].map((d) => [person({ footY: footYAt(d) })]);
    let t = 0;
    const outs = frames.map((f) => p.process(f, (t += 125)));
    expect(outs[0].state).toBe("SAFE");
    expect(outs[1].state).toBe("APPROACHING");
    expect(outs[2].state).toBe("TOO_CLOSE");
    expect(outs[2].event).toBe("WARN");

    const cut = p.process([person({ footY: undefined })], (t += 125));
    expect(cut.state).toBe("BELOW_FRAME");
    expect(cut.blurPx).toBe(24);
    expect(cut.distanceM).toBeNull();
    expect(cut.event).toBeUndefined(); // already warned in TOO_CLOSE
    expect(cut.fps).toBe(8);
  });

  test("nearest person is chosen when siblings are in frame", () => {
    const p = new SensorPipeline(NO_PERSISTENCE);
    p.setCalibration(testFloorModel());
    const out = p.process([person({ footY: footYAt(2.5), x: 0.3 }), person({ footY: footYAt(1.1), x: 0.7 })], 0);
    expect(out.state).toBe("TOO_CLOSE");
    expect(out.peopleCount).toBe(2);
  });

  test("TV stand occluding the bottom: BELOW_FRAME is measured against the visible floor bottom", () => {
    // Feet vanish behind the stand top at y ≈ 0.77. With the default (frame edge) this never fires.
    const occluded = (floorBottomY?: number) => {
      const p = new SensorPipeline(NO_PERSISTENCE);
      p.setCalibration({ ...testFloorModel(), floorBottomY });
      p.process([person({ footY: 0.74 })], 0);
      return p.process([person({ footY: undefined })], 125).state;
    };
    expect(occluded(undefined)).toBe("LOW_CONFIDENCE");
    expect(occluded(0.77)).toBe("BELOW_FRAME");
  });

  test("d_edge follows the visible floor bottom", () => {
    const m = testFloorModel();
    expect(computeEdgeDistance({ ...m, floorBottomY: 0.77 })).toBeGreaterThan(computeEdgeDistance(m));
    expect(footYAt(computeEdgeDistance({ ...m, floorBottomY: 0.77 }))).toBeCloseTo(0.77, 1);
  });

  test("processing before calibration throws (no uncalibrated estimate)", () => {
    const p = new SensorPipeline(NO_PERSISTENCE);
    expect(() => p.process([person({ footY: 0.8 })], 0)).toThrow(/calibration/);
  });
});
