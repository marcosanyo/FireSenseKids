import { describe, expect, test } from "vitest";
import { computeCoverage, distanceForFoot, modelFromTvScreen, projectFloorPoint, screenSizeFromInches, type Pt2 } from "../lib/firesense";
import { project, project3, type Cam } from "./helpers/camera";
import { testFloorModel } from "./helpers/landmarks";

const TV = screenSizeFromInches(55);
const BOTTOM = 0.55;
function modelFor(cam: Cam) {
  const W = TV.widthM;
  const H = TV.heightM;
  const c = [project3(cam, W / 2, BOTTOM + H, 0), project3(cam, -W / 2, BOTTOM + H, 0), project3(cam, -W / 2, BOTTOM, 0), project3(cam, W / 2, BOTTOM, 0)];
  if (c.some((p) => !p)) throw new Error("screen not in view");
  return modelFromTvScreen(c as [Pt2, Pt2, Pt2, Pt2], TV, cam.aspect, cam.h).model;
}
const SHELF: Cam = { x: 1.8, z: 1.4, h: 0.75, yawDeg: 125, pitchDownDeg: 8, vfovDeg: 55, aspect: 4 / 3 };

describe("projectFloorPoint (TV-marker pose)", () => {
  test("matches the true camera, and round-trips through the floor model", () => {
    const model = modelFor(SHELF);
    for (const [lat, d] of [
      [0, 1.2],
      [-0.4, 0.9],
      [0.5, 2.0],
    ]) {
      // lateral + = viewer's right = world −X in the test helper
      const truth = project(SHELF, -lat, d);
      const p = projectFloorPoint(model, lat, d);
      if (!truth) {
        expect(p === null || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1).toBe(true);
        continue;
      }
      expect(p!.x).toBeCloseTo(truth.x, 3);
      expect(p!.y).toBeCloseTo(truth.y, 3);
      expect(distanceForFoot(model, p!.x, p!.y)).toBeCloseTo(d, 1);
    }
  });
});

describe("computeCoverage", () => {
  test("shelf camera: reports coverage fractions, resolution, and a turn hint only when something is missing", () => {
    const r = computeCoverage(modelFor(SHELF), { tooCloseM: 1.3, safeM: 1.65 });
    expect(r.zoneVisible).toBeGreaterThan(0);
    expect(r.zoneVisible).toBeLessThanOrEqual(1);
    expect(r.cmPerPixel).toBeGreaterThan(0);
    if (r.tooCloseVisible < 1) expect(r.turn).not.toBeNull();
    else expect(r.turn).toBeNull();
  });

  test("camera turned further toward the TV → less of the TOO_CLOSE band, missing part on the right", () => {
    const turned: Cam = { ...SHELF, yawDeg: 137 };
    const base = computeCoverage(modelFor(SHELF), { tooCloseM: 1.3, safeM: 1.65 });
    const r = computeCoverage(modelFor(turned), { tooCloseM: 1.3, safeM: 1.65 });
    // (The TOO_CLOSE band now includes the rounded ends beside the screen: 0.80 → 0.65 here.)
    expect(r.tooCloseVisible).toBeLessThan(base.tooCloseVisible - 0.1);
    expect(r.turn).toBe("right");
  });

  test("distance-only (front) model: TOO_CLOSE line in view and cm/px", () => {
    const r = computeCoverage(testFloorModel(), { tooCloseM: 1.3, safeM: 1.65 });
    expect(r.zoneVisible).toBeNull();
    expect(r.tooCloseVisible).toBe(1);
    expect(r.cmPerPixel).toBeGreaterThan(0);
  });
});
