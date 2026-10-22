/**
 * FireSense Kids — RTMO (OpenMMLab mmpose, Apache-2.0) pre- and post-processing, pure functions.
 *
 * Why RTMO: on the family's own frames, MediaPipe Pose found the child in 0 of 4, RTMO-s/m in 3 of 4
 * (scripts/pose-bench/eval_rtm.py). It is a one-stage multi-person model
 * with COCO-17 keypoints (face, arms, hips, knees, ankles).
 *
 * Model contract (the official ONNX SDK "end2end.onnx", same as rtmlib):
 *  - input "input": float32 [1, 3, 640, 640], BGR, raw 0..255, the frame letterboxed at the top-left
 *    (scaled by `ratio`, the rest filled with 114).
 *  - output "dets": [1, N, 5] boxes x1, y1, x2, y2, score (input pixels); "keypoints": [1, N, 17, 3]
 *    x, y, score (input pixels). Duplicates are removed here with NMS, as rtmlib does.
 *
 * The rest of the pipeline speaks MediaPipe's 33-landmark layout (normalized 0..1, `visibility`), so
 * COCO points are placed at their MediaPipe indices; landmarks RTMO does not have get visibility 0.
 * RTMO has no metric 3D ("world") landmarks: posture and the hip-based distance estimate need them,
 * and are unavailable with this estimator (the camera page says so).
 */

import type { LandmarkPoint } from "./floor-calibration";

export const RTMO_INPUT = 640;
export const RTMO_PAD = 114;
/** Person score and NMS IoU, as rtmlib's defaults. */
export const RTMO_SCORE_THRESHOLD = 0.5;
export const RTMO_NMS_IOU = 0.45;

/** COCO-17 index → MediaPipe-33 index. */
export const COCO_TO_MEDIAPIPE = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const;
/**
 * The heel is below the ankle: RTMO has no heel, and the distance comes from the lowest foot point, so the
 * ankle alone would put everyone slightly farther than MediaPipe does. The heel is estimated by extending
 * the knee → ankle line by this fraction of the shin (≈ 6–8 cm for a child, a little more for an adult).
 */
export const HEEL_FROM_SHIN = 0.15;

/**
 * Smallest torso (share of the frame height) accepted as a person with RTMO. MediaPipe keeps 0.04 (person-filter.ts):
 * its small false detections (a coat at 0.054, a dress form at 0.035) are what that limit was set against.
 * RTMO's few false detections on nine people-free rooms were all large (a dress form at 0.12–0.13), while a child
 * 10 % of the frame high has a torso of 0.036–0.05 — right at the 0.04 line. The limit 0.03 keeps such a child.
 */
export const RTMO_MIN_TORSO_FRACTION = 0.03;

export interface Letterbox {
  ratio: number;
  /** Size of the scaled frame inside the 640×640 input. */
  w: number;
  h: number;
}

export function letterbox(frameW: number, frameH: number, size = RTMO_INPUT): Letterbox {
  const ratio = Math.min(size / frameW, size / frameH);
  return { ratio, w: Math.round(frameW * ratio), h: Math.round(frameH * ratio) };
}

/**
 * RGBA pixels of the 640×640 input canvas (frame drawn at the top-left at lb.w × lb.h, the rest anything)
 * → planar BGR float32 with the padding set to 114.
 */
export function toInputTensor(rgba: Uint8ClampedArray, lb: Letterbox, size = RTMO_INPUT): Float32Array {
  const plane = size * size;
  const out = new Float32Array(3 * plane).fill(RTMO_PAD);
  for (let y = 0; y < lb.h; y++) {
    for (let x = 0; x < lb.w; x++) {
      const p = y * size + x;
      const i = p * 4;
      out[p] = rgba[i + 2]; // B
      out[plane + p] = rgba[i + 1]; // G
      out[2 * plane + p] = rgba[i]; // R
    }
  }
  return out;
}

function iou(a: number[], b: number[]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = (r: number[]) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Indices kept by greedy NMS over boxes with score > threshold, best first. */
export function nms(boxes: number[][], scores: number[], iouThreshold = RTMO_NMS_IOU, scoreThreshold = RTMO_SCORE_THRESHOLD): number[] {
  const order = scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > scoreThreshold)
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i);
  const keep: number[] = [];
  for (const i of order) {
    if (keep.every((k) => iou(boxes[i], boxes[k]) <= iouThreshold)) keep.push(i);
  }
  return keep;
}

/**
 * COCO-17 points (normalized to the frame, with a score each) → MediaPipe's 33-landmark layout, with the
 * heels estimated from the shin. Shared by the decoder and by tests that replay stored keypoints.
 */
export function cocoToLandmarks(coco: { x: number; y: number; score: number }[]): LandmarkPoint[] {
  const landmarks: LandmarkPoint[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (let k = 0; k < 17; k++) {
    landmarks[COCO_TO_MEDIAPIPE[k]] = { x: coco[k].x, y: coco[k].y, z: 0, visibility: coco[k].score };
  }
  // Estimated heels (29 left, 30 right) from knee (25/26) → ankle (27/28).
  for (const [knee, ankle, heel] of [
    [25, 27, 29],
    [26, 28, 30],
  ] as const) {
    const a = landmarks[ankle];
    const k = landmarks[knee];
    landmarks[heel] = {
      x: a.x + (a.x - k.x) * HEEL_FROM_SHIN,
      y: a.y + (a.y - k.y) * HEEL_FROM_SHIN,
      z: 0,
      visibility: Math.min(a.visibility ?? 0, k.visibility ?? 0),
    };
  }
  return landmarks;
}

export interface RtmoPerson {
  /** MediaPipe-33 layout, normalized to the frame. */
  landmarks: LandmarkPoint[];
  score: number;
}

/**
 * Model outputs → people. `dets` is [N*5], `kpts` is [N*17*3] (flattened, batch 1), both in input pixels.
 */
export function decodeRtmo(
  dets: ArrayLike<number>,
  kpts: ArrayLike<number>,
  n: number,
  lb: Letterbox,
  frameW: number,
  frameH: number,
  scoreThreshold = RTMO_SCORE_THRESHOLD
): RtmoPerson[] {
  const boxes: number[][] = [];
  const scores: number[] = [];
  for (let i = 0; i < n; i++) {
    boxes.push([dets[i * 5], dets[i * 5 + 1], dets[i * 5 + 2], dets[i * 5 + 3]]);
    scores.push(dets[i * 5 + 4]);
  }
  return nms(boxes, scores, RTMO_NMS_IOU, scoreThreshold).map((i) => {
    const landmarks = cocoToLandmarks(
      Array.from({ length: 17 }, (_, k) => {
        const o = (i * 17 + k) * 3;
        return { x: kpts[o] / lb.ratio / frameW, y: kpts[o + 1] / lb.ratio / frameH, score: kpts[o + 2] };
      })
    );
    return { landmarks, score: scores[i] };
  });
}
