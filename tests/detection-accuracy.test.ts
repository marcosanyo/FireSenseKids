import { describe, expect, test } from "vitest";
import {
  estimateGroundFromHips,
  estimateSeatedViewpoint,
  isSeated,
  modelFromTvScreen,
  PersonFilter,
  plausiblePerson,
  screenSizeFromInches,
  SensorPipeline,
  type LandmarkPoint,
  type Pt2,
} from "../lib/firesense";
import { project3, toCameraAxes, type Cam } from "./helpers/camera";
import { person } from "./helpers/landmarks";

// Persistence stays on (2 frames); smoothing and dwell are tested in smoothing.test.ts.
const NO_DEBOUNCE = {
  smoothing: { windowMs: 0 },
  stateMachine: { enterDwellMs: 0, exitDwellMs: 0, tooCloseExitHysteresisMeters: 0.05, safeHysteresisMeters: 0 },
};

// ---------------------------------------------------------------------------
// Scene: 43-inch TV, phone on a shelf at the side of the room, 1.2 m high, looking diagonally.
// World: X lateral (+ = right when facing the room from the TV), Y up, Z in front of the screen.
// ---------------------------------------------------------------------------
const TV = screenSizeFromInches(43);
const SCREEN_BOTTOM = 0.5;
const CAM: Cam = { x: 1.9, z: 2.2, h: 1.2, yawDeg: 135, pitchDownDeg: 22, vfovDeg: 60, aspect: 4 / 3 };

function tvModel() {
  const W = TV.widthM;
  const H = TV.heightM;
  const c = [
    project3(CAM, W / 2, SCREEN_BOTTOM + H, 0),
    project3(CAM, -W / 2, SCREEN_BOTTOM + H, 0),
    project3(CAM, -W / 2, SCREEN_BOTTOM, 0),
    project3(CAM, W / 2, SCREEN_BOTTOM, 0),
  ];
  if (c.some((p) => !p)) throw new Error("screen not in view of the test camera");
  return modelFromTvScreen(c as [Pt2, Pt2, Pt2, Pt2], TV, CAM.aspect, CAM.h).model;
}

/**
 * A child at floor position (X, Z) with hips `hipH` above the floor, feet on the floor (hidden or not).
 * Returns image landmarks and camera-aligned metric world landmarks (origin = hip center).
 */
function child3d(X: number, Z: number, hipH: number, feetVisible: boolean): { image: LandmarkPoint[]; world: LandmarkPoint[] } {
  const pts: Record<number, [number, number, number]> = {
    0: [X, hipH + 0.55, Z], // nose
    11: [X - 0.13, hipH + 0.4, Z],
    12: [X + 0.13, hipH + 0.4, Z],
    23: [X - 0.08, hipH, Z],
    24: [X + 0.08, hipH, Z],
    25: [X - 0.08, hipH / 2, Z + 0.05],
    26: [X + 0.08, hipH / 2, Z + 0.05],
  };
  for (const k of [27, 29, 31]) pts[k] = [X - 0.08, 0, Z + (k === 31 ? 0.1 : 0)];
  for (const k of [28, 30, 32]) pts[k] = [X + 0.08, 0, Z + (k === 32 ? 0.1 : 0)];
  const image: LandmarkPoint[] = [];
  const world: LandmarkPoint[] = [];
  for (let k = 0; k < 33; k++) {
    const p = pts[k] ?? pts[k < 11 ? 0 : k < 23 ? 11 : 23];
    const im = project3(CAM, p[0], p[1], p[2]);
    if (!im) throw new Error(`landmark ${k} not in view`);
    const foot = k >= 27;
    image.push({ x: im.x, y: im.y, visibility: foot && !feetVisible ? 0.05 : 0.95 });
    const w = toCameraAxes(CAM, [p[0] - X, p[1] - hipH, p[2] - Z]);
    world.push({ x: w.x, y: w.y, z: w.z, visibility: 0.9 });
  }
  return { image, world };
}

/** Distance from the screen segment (what the pipeline reports for TV-marker models). */
const screenDist = (X: number, Z: number) => Math.hypot(Math.max(0, Math.abs(X) - TV.widthM / 2), Z);

describe("PersonFilter", () => {
  test("rejects landmarks without a visible torso, and tiny torsos", () => {
    expect(plausiblePerson(person({ footY: 0.8, torsoVisible: false }), 4 / 3)).toEqual({ accepted: false, reason: "no_torso" });
    const tiny = person({ footY: 0.8 }).map((p) => ({ ...p, y: 0.5 + (p.y - 0.5) * 0.05 }));
    expect(plausiblePerson(tiny, 4 / 3).reason).toBe("too_small");
    expect(plausiblePerson(person({ footY: 0.8 }), 4 / 3).accepted).toBe(true);
  });

  test("rejects shoulders far too wide for the torso (a skeleton fitted to furniture)", () => {
    const wide = person({ footY: 0.8 });
    wide[11] = { ...wide[11], x: 0.2 };
    wide[12] = { ...wide[12], x: 0.8 };
    expect(plausiblePerson(wide, 4 / 3).reason).toBe("proportions");
  });

  test("a person counts from the second consecutive frame; a one-frame ghost never does", () => {
    const f = new PersonFilter();
    expect(f.update([person({ footY: 0.8 })], 4 / 3, 0)[0]).toEqual({ accepted: false, reason: "not_yet_confirmed" });
    expect(f.update([person({ footY: 0.8 })], 4 / 3, 125)[0].accepted).toBe(true);
    // A ghost elsewhere in one frame only.
    const v = f.update([person({ footY: 0.8 }), person({ footY: 0.9, x: 0.1 })], 4 / 3, 250);
    expect(v.map((x) => x.accepted)).toEqual([true, false]);
    // One missed detection does not reset a confirmed person.
    f.update([], 4 / 3, 375);
    expect(f.update([person({ footY: 0.8 })], 4 / 3, 500)[0].accepted).toBe(true);
  });

  test("a track that moved too far is a new person", () => {
    const f = new PersonFilter();
    f.update([person({ footY: 0.8, x: 0.2 })], 4 / 3, 0);
    expect(f.update([person({ footY: 0.8, x: 0.8 })], 4 / 3, 125)[0].accepted).toBe(false);
  });
});

describe("hip-based ground estimate (feet hidden, TV-marker model)", () => {
  const model = tvModel();
  for (const [label, hipH] of [
    ["standing", 0.55],
    ["on a sofa", 0.42],
    ["on the floor", 0.12],
  ] as const) {
    test(`${label}: distance within 5 cm when the pose model's world landmarks are right`, () => {
      for (const [X, Z] of [
        [0, 0.8],
        [-0.4, 1.2],
        [0.9, 0.6],
      ]) {
        const c = child3d(X, Z, hipH, false);
        const est = estimateGroundFromHips(model, c.image, c.world);
        expect(est).not.toBeNull();
        expect(est!.hipHeightM).toBeCloseTo(hipH, 2);
        expect(Math.abs(est!.distanceM - screenDist(X, Z))).toBeLessThan(0.05);
      }
    });
  }

  test("no estimate without the TV-marker pose or without world landmarks", () => {
    const c = child3d(0, 1, 0.5, false);
    expect(estimateGroundFromHips({ ...model, tvPose: undefined }, c.image, c.world)).toBeNull();
    expect(estimateGroundFromHips(model, c.image, undefined)).toBeNull();
  });

  test("pipeline: feet hidden → ESTIMATED distance drives the state (labelled as hips)", () => {
    const p = new SensorPipeline(NO_DEBOUNCE);
    p.setCalibration(model);
    p.setThresholds(0.6, 1.05);
    const c = child3d(0.1, 0.45, 0.12, false); // sitting on the floor right in front of the TV
    p.process([c.image], 0, [c.world as never]);
    const out = p.process([c.image], 125, [c.world as never]);
    expect(out.foot.status).toBe("ESTIMATED");
    expect(out.distanceSource).toBe("hips");
    expect(out.state).toBe("TOO_CLOSE");
    expect(Math.abs((out.distanceM as number) - 0.45)).toBeLessThan(0.05);
  });
});

describe("feet hidden without world landmarks (RTMO): learned hip height", () => {
  const model = tvModel();
  /** Image landmarks only, as RTMO gives them. */
  const img = (X: number, Z: number, hipH: number, feet: boolean) => child3d(X, Z, hipH, feet).image;
  function pipeline() {
    const p = new SensorPipeline(NO_DEBOUNCE);
    p.setCalibration(model);
    p.setThresholds(0.6, 1.05);
    return p;
  }

  test("standing child whose feet get hidden: estimated from the hips, labeled, within 5 cm", () => {
    const p = pipeline();
    for (let t = 0; t <= 500; t += 125) p.process([img(0.2, 0.8, 0.55, true)], t); // feet visible: learn
    const out = p.process([img(0.2, 0.8, 0.55, false)], 625);
    expect(out.foot.status).toBe("ESTIMATED");
    expect(out.distanceSource).toBe("hips");
    expect(Math.abs((out.distanceM as number) - screenDist(0.2, 0.8))).toBeLessThan(0.05);
  });

  test("walking a little with the feet hidden is followed", () => {
    const p = pipeline();
    for (let t = 0; t <= 500; t += 125) p.process([img(0, 1.2, 0.55, true)], t);
    let out = p.process([img(0, 1.1, 0.55, false)], 625);
    for (let t = 750, z = 1.05; t <= 1500; t += 125, z -= 0.05) out = p.process([img(0, z, 0.55, false)], t);
    expect(out.distanceSource).toBe("hips");
    expect(Math.abs((out.distanceM as number) - 0.75)).toBeLessThan(0.05); // last step: z = 0.75
  });

  for (const [label, seatH] of [
    ["on a sofa", 0.42],
    ["on the floor", 0.12],
  ] as const) {
    test(`sitting down ${label} with the feet hidden, even slowly: no hip distance (never a false "too close")`, () => {
      const p = pipeline();
      for (let t = 0; t <= 500; t += 125) p.process([img(0.3, 1.5, 0.55, true)], t);
      let sawHips = false;
      for (let k = 1; k <= 16; k++) {
        const h = 0.55 - ((0.55 - seatH) * Math.min(1, k / 12)); // 1.5 s to sit
        const out = p.process([img(0.3, 1.5, h, false)], 500 + k * 125);
        if (out.distanceSource === "hips" && k > 4) sawHips ||= Math.abs((out.distanceM as number) - screenDist(0.3, 1.5)) > 0.15;
        expect(out.state).not.toBe("TOO_CLOSE");
      }
      expect(sawHips).toBe(false);
    });
  }

  test("more than 4 s after the feet were last seen: no estimate", () => {
    const p = pipeline();
    for (let t = 0; t <= 500; t += 125) p.process([img(0.2, 0.8, 0.55, true)], t);
    p.process([img(0.2, 0.8, 0.55, false)], 625);
    const out = p.process([img(0.2, 0.8, 0.55, false)], 5000);
    expect(out.distanceSource).not.toBe("hips");
  });

  test("with MediaPipe's world landmarks the old estimate is used, unchanged", () => {
    const p = pipeline();
    const c = child3d(0.1, 0.45, 0.12, false);
    p.process([c.image], 0, [c.world as never]);
    const out = p.process([c.image], 125, [c.world as never]);
    expect(out.distanceSource).toBe("hips");
    expect(Math.abs((out.distanceM as number) - 0.45)).toBeLessThan(0.05);
  });
});

describe("nearest person with the phone at the side of the room", () => {
  test("the child near the TV wins over someone lower in the image near the phone", () => {
    const model = tvModel();
    const nearTv = child3d(-0.2, 0.4, 0.55, true);
    const nearPhone = child3d(0.4, 1.7, 0.55, true); // close to the camera: lowest in the image
    expect(Math.max(...nearPhone.image.map((l) => l.y))).toBeGreaterThan(Math.max(...nearTv.image.map((l) => l.y)));
    const p = new SensorPipeline(NO_DEBOUNCE);
    p.setCalibration(model);
    p.setThresholds(0.6, 1.05);
    p.process([nearPhone.image, nearTv.image], 0, [nearPhone.world, nearTv.world] as never);
    const out = p.process([nearPhone.image, nearTv.image], 125, [nearPhone.world, nearTv.world] as never);
    expect(out.nearest).toBe(1);
    expect(out.state).toBe("TOO_CLOSE");
    expect(out.distanceSource).toBe("feet");
  });

  test("a sofa beside the TV is judged by its real distance from the screen", () => {
    const model = tvModel();
    // Sitting 0.4 m in front of the wall but 1.5 m beside the screen edge.
    const X = -(TV.widthM / 2 + 1.5);
    const onSofa = child3d(X, 0.4, 0.42, true);
    const p = new SensorPipeline(NO_DEBOUNCE);
    p.setCalibration(model);
    p.setThresholds(0.6, 1.05);
    p.process([onSofa.image], 0, [onSofa.world] as never);
    const out = p.process([onSofa.image], 125, [onSofa.world] as never);
    expect(out.state).toBe("SAFE");
    expect(Math.abs((out.distanceM as number) - screenDist(X, 0.4))).toBeLessThan(0.05);
  });
});

describe("seated: the distance is taken under the head, not at the feet", () => {
  /** Seated at floor (X, Z): hips 0.45 m up, thighs toward the TV, feet `legM` ahead on a footrest, head leaning back. */
  function seated3d(X: number, Z: number, legM: number, feetVisible = true) {
    const hipH = 0.45;
    const pts: Record<number, [number, number, number]> = {
      0: [X, hipH + 0.6, Z + 0.15], // nose: leaning back
      11: [X - 0.15, hipH + 0.45, Z + 0.1],
      12: [X + 0.15, hipH + 0.45, Z + 0.1],
      23: [X - 0.09, hipH, Z],
      24: [X + 0.09, hipH, Z],
      25: [X - 0.09, hipH + 0.05, Z - 0.45], // knees: thighs about horizontal
      26: [X + 0.09, hipH + 0.05, Z - 0.45],
    };
    for (const k of [27, 29, 31]) pts[k] = [X - 0.09, 0.3, Z - legM - (k === 31 ? 0.1 : 0)];
    for (const k of [28, 30, 32]) pts[k] = [X + 0.09, 0.3, Z - legM - (k === 32 ? 0.1 : 0)];
    const image: LandmarkPoint[] = [];
    const world: LandmarkPoint[] = [];
    for (let k = 0; k < 33; k++) {
      const p = pts[k] ?? pts[k < 11 ? 0 : k < 23 ? 11 : 23];
      const im = project3(CAM, p[0], p[1], p[2]);
      if (!im) throw new Error(`landmark ${k} not in view`);
      image.push({ x: im.x, y: im.y, visibility: k >= 27 && !feetVisible ? 0.05 : 0.95 });
      const w = toCameraAxes(CAM, [p[0] - X, p[1] - hipH, p[2] - Z]);
      world.push({ x: w.x, y: w.y, z: w.z, visibility: 0.9 });
    }
    return { image, world };
  }

  const model = tvModel();

  test("isSeated: thighs near horizontal yes, standing no", () => {
    const up = model.tvPose!.r[1];
    const s = seated3d(0, 1.6, 0.9);
    expect(isSeated(s.image, s.world, up)).toBe(true);
    const st = child3d(0, 1.2, 0.75, true);
    expect(isSeated(st.image, st.world, up)).toBe(false);
  });

  test("feet on a footrest 0.9 m ahead: the distance is under the head (within 10 cm), not 0.75 m closer", () => {
    for (const [X, Z] of [
      [0, 1.6],
      [-0.4, 1.3],
    ]) {
      const s = seated3d(X, Z, 0.9);
      const est = estimateSeatedViewpoint(model, s.image, s.world)!;
      expect(est).not.toBeNull();
      expect(Math.abs(est.distanceM - screenDist(X, Z + 0.15))).toBeLessThan(0.1);
    }
  });

  test("pipeline: a seated viewer with visible feet is SAFE by the head, labelled seated; feet hidden also works", () => {
    const run = (feetVisible: boolean) => {
      const p = new SensorPipeline(NO_DEBOUNCE);
      p.setCalibration(model);
      p.setThresholds(0.8, 1.2);
      const s = seated3d(0, 1.6, 0.9, feetVisible);
      p.process([s.image], 0, [s.world as never]);
      return p.process([s.image], 125, [s.world as never]);
    };
    const visible = run(true);
    expect(visible.distanceSource).toBe("seated");
    expect(visible.state).toBe("SAFE"); // the feet alone would read ~0.6 m (TOO_CLOSE)
    expect(Math.abs((visible.distanceM as number) - 1.75)).toBeLessThan(0.1);
    const hidden = run(false);
    expect(hidden.foot.status).toBe("ESTIMATED");
    expect(hidden.distanceSource).toBe("seated");
  });
});

describe("seated with the feet on the floor", () => {
  test("shins vertical: the seat height comes from the drop to the feet", () => {
    const model = tvModel();
    const X = 0.2;
    const Z = 1.5;
    const hipH = 0.45;
    const c = child3d(X, Z, hipH, true);
    // Turn the child's legs into a seated pose: knees forward at hip height, ankles under the knees.
    const pts: Record<number, [number, number, number]> = { 25: [X - 0.08, hipH, Z - 0.45], 26: [X + 0.08, hipH, Z - 0.45] };
    for (const k of [27, 29, 31]) pts[k] = [X - 0.08, 0, Z - 0.45 - (k === 31 ? 0.1 : 0)];
    for (const k of [28, 30, 32]) pts[k] = [X + 0.08, 0, Z - 0.45 - (k === 32 ? 0.1 : 0)];
    for (const [k, p] of Object.entries(pts)) {
      const im = project3(CAM, p[0], p[1], p[2])!;
      c.image[Number(k)] = { x: im.x, y: im.y, visibility: 0.95 };
      const w = toCameraAxes(CAM, [p[0] - X, p[1] - hipH, p[2] - Z]);
      c.world[Number(k)] = { x: w.x, y: w.y, z: w.z, visibility: 0.9 };
    }
    expect(isSeated(c.image, c.world, model.tvPose!.r[1])).toBe(true);
    const est = estimateSeatedViewpoint(model, c.image, c.world)!;
    expect(est.hipHeightM).toBeCloseTo(hipH, 2);
    expect(Math.abs(est.distanceM - screenDist(X, Z))).toBeLessThan(0.05); // child3d's nose is above the hips
  });
});
