import { describe, expect, test } from "vitest";
import { evaluatePosture, type Landmark3D } from "../lib/firesense";

/** Metric world landmarks (MediaPipe: meters, y down, z toward the camera negative). */
function body(opts: { headForward?: number; torsoLean?: number; ears?: boolean } = {}): Landmark3D[] {
  const lm: Landmark3D[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }));
  const lean = opts.torsoLean ?? 0;
  lm[23] = { x: -0.1, y: 0, z: 0, visibility: 0.95 };
  lm[24] = { x: 0.1, y: 0, z: 0, visibility: 0.95 };
  lm[11] = { x: -0.18, y: -0.5, z: -lean, visibility: 0.95 };
  lm[12] = { x: 0.18, y: -0.5, z: -lean, visibility: 0.95 };
  const f = opts.headForward ?? 0;
  // Upright: nose 10 cm in front of the shoulder line, ears right above the shoulders.
  lm[0] = { x: 0, y: -0.72, z: -lean - 0.1 - f, visibility: 0.95 };
  const earVis = opts.ears === false ? 0.1 : 0.9;
  lm[7] = { x: -0.08, y: -0.7, z: -lean - f, visibility: earVis };
  lm[8] = { x: 0.08, y: -0.7, z: -lean - f, visibility: earVis };
  return lm;
}

describe("evaluatePosture", () => {
  test("an upright adult is GOOD even though the nose is in front of the shoulders", () => {
    expect(evaluatePosture(body()).posture).toBe("GOOD");
  });
  test("head pushed 12 cm forward (text neck) is SLOUCH", () => {
    expect(evaluatePosture(body({ headForward: 0.12 })).posture).toBe("SLOUCH");
  });
  test("torso leaning forward is SLOUCH", () => {
    expect(evaluatePosture(body({ torsoLean: 0.25 })).posture).toBe("SLOUCH");
  });
  test("ears hidden: the nose is used with a higher threshold, upright stays GOOD", () => {
    expect(evaluatePosture(body({ ears: false })).posture).toBe("GOOD");
  });
});
