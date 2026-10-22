import { describe, expect, test } from "vitest";
import { COCO_TO_MEDIAPIPE, decodeRtmo, HEEL_FROM_SHIN, letterbox, nms, RTMO_INPUT, RTMO_MIN_TORSO_FRACTION, RTMO_PAD, toInputTensor } from "../lib/firesense/rtmo";
import { CameraCommandSchema, CameraStatusSchema } from "../lib/firesense/protocol";
import { DEFAULT_MIN_TORSO_FRACTION, PersonFilter, plausiblePerson } from "../lib/firesense/person-filter";
import { extractGroundContactPoint } from "../lib/firesense/floor-calibration";

describe("RTMO pre-processing", () => {
  test("letterbox: the long side fills 640, top-left", () => {
    expect(letterbox(1920, 1440)).toEqual({ ratio: 640 / 1920, w: 640, h: 480 });
    expect(letterbox(1440, 1920)).toEqual({ ratio: 640 / 1920, w: 480, h: 640 });
  });

  test("input tensor: planar BGR, raw 0..255, padding 114 outside the frame", () => {
    const lb = { ratio: 1, w: 2, h: 1 };
    const rgba = new Uint8ClampedArray(RTMO_INPUT * RTMO_INPUT * 4);
    rgba.set([10, 20, 30, 255, 40, 50, 60, 255], 0); // two pixels in the first row
    const t = toInputTensor(rgba, lb);
    const plane = RTMO_INPUT * RTMO_INPUT;
    expect([t[0], t[plane], t[2 * plane]]).toEqual([30, 20, 10]); // B G R of pixel 0
    expect([t[1], t[plane + 1], t[2 * plane + 1]]).toEqual([60, 50, 40]);
    expect(t[2]).toBe(RTMO_PAD); // outside the scaled frame
    expect(t[RTMO_INPUT]).toBe(RTMO_PAD); // second row
  });
});

describe("RTMO post-processing", () => {
  test("NMS keeps the best of overlapping boxes and drops low scores", () => {
    const boxes = [
      [0, 0, 100, 200],
      [5, 5, 105, 205],
      [300, 0, 400, 200],
      [500, 0, 600, 200],
    ];
    expect(nms(boxes, [0.9, 0.8, 0.7, 0.2])).toEqual([0, 2]);
  });

  /** One person in input pixels: a standing figure, with all 17 COCO points. */
  function person(score = 0.9) {
    const dets = [100, 40, 200, 600, score];
    const coco: [number, number][] = [
      [150, 60], [145, 55], [155, 55], [140, 58], [160, 58], // nose, eyes, ears
      [130, 120], [170, 120], [120, 200], [180, 200], [115, 270], [185, 270], // shoulders, elbows, wrists
      [138, 300], [162, 300], [136, 430], [164, 430], [135, 560], [165, 560], // hips, knees, ankles
    ];
    const kpts = coco.flatMap(([x, y]) => [x, y, 0.95]);
    return { dets, kpts };
  }

  test("COCO points land at their MediaPipe indices, normalized to the frame; missing ones are invisible", () => {
    const lb = letterbox(1920, 1440); // ratio 1/3
    const p = person();
    const [out] = decodeRtmo(p.dets, p.kpts, 1, lb, 1920, 1440);
    expect(out.score).toBeCloseTo(0.9);
    const lms = out.landmarks;
    expect(lms).toHaveLength(33);
    expect(lms[0].x).toBeCloseTo((150 * 3) / 1920); // nose
    expect(lms[27].y).toBeCloseTo((560 * 3) / 1440); // left ankle
    expect(lms[23].visibility).toBeCloseTo(0.95); // left hip
    expect(lms[1].visibility).toBe(0); // eye inner: not in COCO
    expect(lms[31].visibility).toBe(0); // foot index: not in COCO
    expect(COCO_TO_MEDIAPIPE).toHaveLength(17);
  });

  test("estimated heels sit below the ankles along the shin, and become the ground point", () => {
    const lb = { ratio: 1, w: 640, h: 640 };
    const p = person();
    const [out] = decodeRtmo(p.dets, p.kpts, 1, lb, 640, 640);
    const lms = out.landmarks;
    expect(lms[29].y).toBeCloseTo((560 + (560 - 430) * HEEL_FROM_SHIN) / 640);
    const g = extractGroundContactPoint(lms)!;
    expect(g.groundY).toBeCloseTo(lms[29].y);
  });

  test("a decoded person passes the same plausibility filter as MediaPipe's", () => {
    const p = person();
    const [out] = decodeRtmo(p.dets, p.kpts, 1, { ratio: 1, w: 640, h: 640 }, 640, 640);
    expect(plausiblePerson(out.landmarks, 1).accepted).toBe(true);
  });

  test("people under the score threshold are dropped", () => {
    const p = person(0.3);
    expect(decodeRtmo(p.dets, p.kpts, 1, { ratio: 1, w: 640, h: 640 }, 640, 640)).toEqual([]);
  });
});

describe("protocol: pose model", () => {
  test("the parent can switch the model; the camera reports it", () => {
    expect(CameraCommandSchema.safeParse({ kind: "set_pose_model", model: "rtmo-s", accel: "GPU" }).success).toBe(true);
    expect(CameraCommandSchema.safeParse({ kind: "set_pose_model", model: "yolo", accel: "GPU" }).success).toBe(false);
    const pose = CameraStatusSchema.shape.pose;
    expect(pose.safeParse({ model: "rtmo-m", accel: "CPU", inferenceMs: 230 }).success).toBe(true);
    expect(pose.safeParse(undefined).success).toBe(true); // older cameras
  });
});

describe("person size limit per model", () => {
  /** A small child: shoulders at y 0.50, hips at 0.50 + torso, in a 4:3 frame. */
  const child = (torso: number) => {
    const l = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
    const set = (i: number, x: number, y: number) => (l[i] = { x, y, z: 0, visibility: 0.95 });
    set(0, 0.5, 0.5 - 0.02);
    set(11, 0.49, 0.5);
    set(12, 0.51, 0.5);
    set(23, 0.492, 0.5 + torso);
    set(24, 0.508, 0.5 + torso);
    set(27, 0.49, 0.5 + torso * 3);
    set(28, 0.51, 0.5 + torso * 3);
    return l;
  };

  test("a torso of 0.035 of the frame height is too small for MediaPipe's limit, but counts with RTMO's", () => {
    expect(plausiblePerson(child(0.035), 4 / 3, { minTorsoFraction: DEFAULT_MIN_TORSO_FRACTION }).accepted).toBe(false);
    expect(plausiblePerson(child(0.035), 4 / 3, { minTorsoFraction: RTMO_MIN_TORSO_FRACTION }).accepted).toBe(true);
    expect(plausiblePerson(child(0.02), 4 / 3, { minTorsoFraction: RTMO_MIN_TORSO_FRACTION }).accepted).toBe(false);
  });

  test("the limit can be changed on a running filter", () => {
    const f = new PersonFilter();
    f.update([child(0.035)], 4 / 3, 0);
    expect(f.update([child(0.035)], 4 / 3, 125)[0].accepted).toBe(false);
    f.setMinTorsoFraction(RTMO_MIN_TORSO_FRACTION);
    f.update([child(0.035)], 4 / 3, 250);
    expect(f.update([child(0.035)], 4 / 3, 375)[0].accepted).toBe(true);
  });
});
