import { describe, expect, test } from "vitest";
import {
  applyAdjust,
  fitAdjustToMeasurements,
  invertAdjust,
  modelFromTvScreen,
  NO_ADJUST,
  projectFloorPoint,
  distanceForFoot,
  screenSizeFromInches,
  type Pt2,
} from "../lib/firesense";
import { project3, type Cam } from "./helpers/camera";

const CAM: Cam = { x: 0.8, z: 3.5, h: 1.7, yawDeg: 190, pitchDownDeg: 20, vfovDeg: 55, aspect: 4 / 3 };
const SCREEN_BOTTOM = 0.5;

function corners(inches: number): [Pt2, Pt2, Pt2, Pt2] {
  const { widthM: W, heightM: H } = screenSizeFromInches(inches);
  return [
    project3(CAM, W / 2, SCREEN_BOTTOM + H, 0)!,
    project3(CAM, -W / 2, SCREEN_BOTTOM + H, 0)!,
    project3(CAM, -W / 2, SCREEN_BOTTOM, 0)!,
    project3(CAM, W / 2, SCREEN_BOTTOM, 0)!,
  ];
}

describe("TV marker: the screen-bottom height checks the TV size", () => {
  test("a 43-inch TV entered as 50: distances are off; with the screen bottom they are right again", () => {
    const c = corners(43);
    const foot = project3(CAM, 0, 0, 1.0)!; // someone 1 m in front of the screen
    const wrong = modelFromTvScreen(c, screenSizeFromInches(50), 4 / 3, CAM.h);
    expect(Math.abs(distanceForFoot(wrong.model, foot.x, foot.y)! - 1.0)).toBeGreaterThan(0.2);
    const fixed = modelFromTvScreen(c, screenSizeFromInches(50), 4 / 3, CAM.h, SCREEN_BOTTOM);
    expect(fixed.sizeScale).toBeCloseTo(43 / 50, 2);
    expect(distanceForFoot(fixed.model, foot.x, foot.y)!).toBeCloseTo(1.0, 1);
  });
  test("inputs that contradict each other are refused with the numbers", () => {
    expect(() => modelFromTvScreen(corners(43), screenSizeFromInches(43), 4 / 3, CAM.h, 1.6)).toThrow(/15 cm or more/);
    expect(() => modelFromTvScreen(corners(43), screenSizeFromInches(43), 4 / 3, CAM.h, -0.5)).toThrow(/out of range/);
  });
});

describe("zone adjustment", () => {
  test("apply and invert are inverse; the drawn zone follows the adjustment", () => {
    const a = { dxM: 0.3, dzM: -0.4, angleDeg: 12, scale: 1.2 };
    const p = { lateralM: -0.7, frontM: 1.3 };
    const back = invertAdjust(a, applyAdjust(a, p));
    expect(back.lateralM).toBeCloseTo(p.lateralM, 9);
    expect(back.frontM).toBeCloseTo(p.frontM, 9);
    const m = modelFromTvScreen(corners(43), screenSizeFromInches(43), 4 / 3, CAM.h).model;
    const adjusted = { ...m, tvPose: { ...m.tvPose!, adjust: a } };
    // The image point drawn for "1 m in front" is measured as 1 m in front.
    const img = projectFloorPoint(adjusted, 0, 1.0)!;
    expect(distanceForFoot(adjusted, img.x, img.y)).toBeCloseTo(1.0, 1);
  });

  test("one measured point shifts the distance; two also fix the scale", () => {
    const W = 0.95;
    // Measured positions read 0.75 m too far and 20% stretched: raw = 1.2·true + 0.75.
    const raw = (t: number) => ({ lateralM: 0, frontM: 1.2 * t + 0.75 });
    const one = fitAdjustToMeasurements(NO_ADJUST, W, [{ raw: raw(1.0), trueM: 1.0 }]);
    expect(applyAdjust(one, raw(1.0)).frontM).toBeCloseTo(1.0, 2);
    const two = fitAdjustToMeasurements(NO_ADJUST, W, [
      { raw: raw(0.5), trueM: 0.5 },
      { raw: raw(1.5), trueM: 1.5 },
    ]);
    expect(two.scale).toBeCloseTo(1 / 1.2, 2);
    for (const t of [0.3, 1.0, 2.0]) expect(applyAdjust(two, raw(t)).frontM).toBeCloseTo(t, 1);
  });

  test("points too close together, or an absurd stretch, are refused", () => {
    expect(() =>
      fitAdjustToMeasurements(NO_ADJUST, 1, [
        { raw: { lateralM: 0, frontM: 1 }, trueM: 1 },
        { raw: { lateralM: 0, frontM: 1.1 }, trueM: 1.5 },
      ])
    ).toThrow(/too close/);
    expect(() =>
      fitAdjustToMeasurements(NO_ADJUST, 1, [
        { raw: { lateralM: 0, frontM: 1 }, trueM: 0.5 },
        { raw: { lateralM: 0, frontM: 2 }, trueM: 3.5 },
      ])
    ).toThrow(/scale from the two points/);
  });
});

describe("TV marker with gravity", () => {
  // Camera-coordinate "up" of the test camera (x right, y down, z forward).
  function upOf(cam: Cam): [number, number, number] {
    const yaw = (cam.yawDeg * Math.PI) / 180;
    const pitch = (cam.pitchDownDeg * Math.PI) / 180;
    const f = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const r = [Math.cos(yaw), 0, Math.sin(yaw)];
    let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    if (u[1] < 0) u = u.map((c) => -c);
    return [r[1], -u[1], f[1]];
  }

  test("with the screen bottom measured too, a wrong TV size is found", () => {
    const r = modelFromTvScreen(corners(43), screenSizeFromInches(50), 4 / 3, CAM.h, SCREEN_BOTTOM, upOf(CAM));
    expect(r.sizeScale).toBeCloseTo(43 / 50, 2);
    const foot = project3(CAM, 0, 0, 1.0)!;
    expect(distanceForFoot(r.model, foot.x, foot.y)!).toBeCloseTo(1.0, 1);
  });

  test("gravity recovers the field of view; distances stay right even when the corners alone are off", () => {
    const up = upOf(CAM);
    const c = corners(43);
    const r = modelFromTvScreen(c, screenSizeFromInches(43), 4 / 3, CAM.h, undefined, up);
    expect(r.gravity!.rmsPx1000).toBeLessThan(0.5);
    expect(r.pose.vfovDeg).toBeCloseTo(CAM.vfovDeg, 0);
    // Corners detected with ±2 px error (of 1000), 40 random draws: corners alone put 1 m ~0.6 m off on
    // average; with gravity the error stays around 0.1 m.
    const foot = project3(CAM, 0, 0, 1.0)!;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.004;
    let withUp = 0;
    let cornersOnly = 0;
    for (let k = 0; k < 40; k++) {
      const noisy = c.map((p) => ({ x: p.x + rnd(), y: p.y + rnd() })) as typeof c;
      const err = (up?: [number, number, number]) => {
        try {
          return Math.abs(distanceForFoot(modelFromTvScreen(noisy, screenSizeFromInches(43), 4 / 3, CAM.h, undefined, up).model, foot.x, foot.y)! - 1.0);
        } catch {
          return 3; // refused: as bad as a large error for this comparison
        }
      };
      withUp += err(up) / 40;
      cornersOnly += err() / 40;
    }
    expect(withUp).toBeLessThan(0.15);
    expect(withUp).toBeLessThan(cornersOnly / 3);
  });

  test("a sensor that disagrees with the TV's edges is refused with the angle", () => {
    const up = upOf({ ...CAM, pitchDownDeg: CAM.pitchDownDeg + 25 });
    expect(() => modelFromTvScreen(corners(43), screenSizeFromInches(43), 4 / 3, CAM.h, undefined, up)).toThrow(/do not agree/);
  });
});
