import { describe, expect, test } from "vitest";
import {
  distanceForFoot,
  edgeDistanceFor,
  fitFloorCalibration,
  fitFloorHomography,
  SensorPipeline,
  type FloorLineSample,
} from "../lib/firesense";
import { FRONT_CAM, project, SIDE_CAM, type Cam } from "./helpers/camera";
import { person } from "./helpers/landmarks";

// These tests are about distance / BELOW_FRAME logic: a person counts from the first frame, and
// every frame counts on its own (no smoothing, no dwell; those have their own tests).
const NO_PERSISTENCE = {
  personFilter: { minHits: 1 },
  smoothing: { windowMs: 0 },
  stateMachine: { enterDwellMs: 0, exitDwellMs: 0, tooCloseExitHysteresisMeters: 0.05, safeHysteresisMeters: 0 },
};

/** Taps along floor lines parallel to the TV, like a parent tapping tape in the frozen frame. */
function taps(cam: Cam, distances: number[]): FloorLineSample[] {
  return distances.map((d) => ({
    distanceM: d,
    points: [-1.2, -0.6, 0, 0.6].map((X) => project(cam, X, d)).filter((p): p is { x: number; y: number } => p !== null),
  }));
}

describe("floor homography (any placement)", () => {
  test("side placement: exact distance to the TV plane anywhere on the visible floor", () => {
    const fit = fitFloorHomography(taps(SIDE_CAM, [0.8, 1.2, 1.8]));
    expect(fit.success).toBe(true);
    if (!fit.success) return;
    expect(fit.model.maxResidualM).toBeLessThan(0.005);
    let checked = 0;
    for (const Z of [0.9, 1.3, 1.65, 2.2]) {
      for (const X of [-1.0, -0.4, 0.2]) {
        const p = project(SIDE_CAM, X, Z);
        if (!p) continue;
        checked++;
        expect(Math.abs((distanceForFoot(fit.model, p.x, p.y) as number) - Z)).toBeLessThan(0.01);
      }
    }
    expect(checked).toBeGreaterThan(6);
  });

  test("why it is needed: on a side camera the y-only model depends on where the child stands", () => {
    // Same distance to the TV (1.3m), two lateral positions → different image y.
    const left = project(SIDE_CAM, -0.8, 1.3)!;
    const right = project(SIDE_CAM, 0.3, 1.3)!;
    expect(Math.abs(left.y - right.y)).toBeGreaterThan(0.05);
    const mk = (d: number, X: number) => Array.from({ length: 20 }, () => ({ groundY: project(SIDE_CAM, X, d)!.y, confidence: 0.9, timestamp: 0 }));
    const linear = fitFloorCalibration(mk(1.2, -0.2), mk(1.8, -0.2)).model!;
    const yOnly = (p: { x: number; y: number }) => distanceForFoot(linear, p.x, p.y) as number;
    expect(Math.abs(yOnly(left) - yOnly(right))).toBeGreaterThan(0.15);
    const h = fitFloorHomography(taps(SIDE_CAM, [0.8, 1.2, 1.8]));
    if (!h.success) throw new Error(h.errorMessage);
    expect(Math.abs((distanceForFoot(h.model, left.x, left.y) as number) - (distanceForFoot(h.model, right.x, right.y) as number))).toBeLessThan(0.01);
  });

  test("front placement: also exact (no tilt approximation, unlike 1/d = a·y + b)", () => {
    const fit = fitFloorHomography(taps(FRONT_CAM, [0.9, 1.2, 1.8]));
    if (!fit.success) throw new Error(fit.errorMessage);
    const p = project(FRONT_CAM, 0, 2.1)!;
    expect(Math.abs((distanceForFoot(fit.model, p.x, p.y) as number) - 2.1)).toBeLessThan(0.01);
  });

  test("needs 3 distinct lines with ≥2 points each; inconsistent taps fail fast", () => {
    expect(fitFloorHomography(taps(SIDE_CAM, [1.2, 1.8]))).toMatchObject({ success: false });
    const oneEach = taps(SIDE_CAM, [0.8, 1.2, 1.8]).map((l) => ({ ...l, points: l.points.slice(0, 1) }));
    expect(fitFloorHomography(oneEach)).toMatchObject({ success: false });
    const wrong = taps(SIDE_CAM, [0.8, 1.2, 1.8]);
    wrong[1] = { ...wrong[1], distanceM: 2.5 }; // taps on the 1.2m tape labeled as 2.5m
    const r = fitFloorHomography(wrong);
    expect(r.success).toBe(false);
  });

  test("d_edge is the nearest measurable distance on the visible floor bottom", () => {
    const fit = fitFloorHomography(taps(SIDE_CAM, [0.8, 1.2, 1.8]));
    if (!fit.success) throw new Error(fit.errorMessage);
    const edge = edgeDistanceFor(fit.model);
    expect(edge).toBeGreaterThan(0.2);
    expect(edge).toBeLessThan(1.2);
  });

  test("pipeline uses the foot's x and y with a homography model", () => {
    const fit = fitFloorHomography(taps(SIDE_CAM, [0.8, 1.2, 1.8]));
    if (!fit.success) throw new Error(fit.errorMessage);
    const pl = new SensorPipeline(NO_PERSISTENCE);
    pl.setCalibration(fit.model);
    const foot = project(SIDE_CAM, -0.6, 1.1)!;
    const lms = person({ footY: foot.y, x: foot.x });
    const out = pl.process([lms], 0);
    expect(out.state).toBe("TOO_CLOSE");
    expect(Math.abs((out.distanceM as number) - 1.1)).toBeLessThan(0.02);
  });
});

import { isoDistanceY } from "../lib/firesense";

describe("iso-distance lines for the camera overlay", () => {
  test("points on the drawn 1.3m line map back to 1.3m (side placement)", () => {
    const fit = fitFloorHomography(taps(SIDE_CAM, [0.8, 1.2, 1.8]));
    if (!fit.success) throw new Error(fit.errorMessage);
    for (const x of [0.2, 0.5, 0.8]) {
      const y = isoDistanceY(fit.model, 1.3, x);
      if (y === null) continue;
      expect(distanceForFoot(fit.model, x, y)).toBeCloseTo(1.3, 2);
    }
  });
});
