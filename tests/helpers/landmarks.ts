import type { FloorCalibrationModel, LandmarkPoint } from "../../lib/firesense";

/** Synthetic floor model: marker A 1.2m at y=0.85, marker B 1.8m at y=0.62. */
export function testFloorModel(): FloorCalibrationModel {
  const yA = 0.85;
  const yB = 0.62;
  const a = (1 / 1.2 - 1 / 1.8) / (yA - yB);
  const b = 1 / 1.2 - a * yA;
  return {
    markerADistance: 1.2,
    markerBDistance: 1.8,
    medianYA: yA,
    medianYB: yB,
    a,
    b,
    sampleCountA: 20,
    sampleCountB: 20,
    calibratedAt: 0,
  };
}

/** Image y where the feet of a person standing at distance d land, under the model. */
export function footYAt(d: number, model = testFloorModel()): number {
  return (1 / d - model.b) / model.a;
}

export interface PersonOpts {
  footY?: number; // undefined => feet invisible
  x?: number;
  torsoVisible?: boolean;
  footVisibility?: number;
  upright?: boolean;
}

/** 33 MediaPipe-like landmarks for a standing person. */
export function person(opts: PersonOpts = {}): LandmarkPoint[] {
  const x = opts.x ?? 0.5;
  const footY = opts.footY;
  const torsoVis = opts.torsoVisible === false ? 0.1 : 0.95;
  const top = footY !== undefined ? footY - 0.55 : 0.35;
  const lms: LandmarkPoint[] = Array.from({ length: 33 }, () => ({ x, y: top, visibility: 0.9 }));
  lms[0] = { x, y: top, visibility: 0.95 }; // nose
  lms[11] = { x: x - 0.05, y: top + 0.1, visibility: torsoVis };
  lms[12] = { x: x + 0.05, y: top + 0.1, visibility: torsoVis };
  lms[23] = { x: x - 0.04, y: top + 0.3, visibility: torsoVis };
  lms[24] = { x: x + 0.04, y: top + 0.3, visibility: torsoVis };
  lms[25] = { x: x - 0.04, y: top + 0.42, visibility: 0.9 };
  lms[26] = { x: x + 0.04, y: top + 0.42, visibility: 0.9 };
  const footVis = footY !== undefined ? opts.footVisibility ?? 0.9 : 0.05;
  const fy = footY ?? 1.05;
  for (const i of [27, 28, 29, 30, 31, 32]) lms[i] = { x, y: fy, visibility: footVis };
  // Non-body points (face/hands) sit near the torso and never below the knees.
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) lms[i] = { x, y: top, visibility: 0.9 };
  for (const i of [13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) lms[i] = { x, y: top + 0.25, visibility: 0.9 };
  if (footY === undefined) {
    // Knees near the bottom edge too when feet are cut off.
    lms[25].y = Math.min(0.98, lms[25].y);
    lms[26].y = Math.min(0.98, lms[26].y);
  }
  return lms;
}
