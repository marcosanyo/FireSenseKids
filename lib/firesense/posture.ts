/**
 * FireSense Kids — Posture Ergonomics Analysis
 *
 * Computer Vision Proof:
 * Beyond simple proximity sensors (ToF/ultrasonic), CV provides 3D posture awareness:
 * - GOOD: Upright posture (spine aligned)
 * - SLOUCH: Forward head tilt / hunchback
 * - LYING_DOWN: Torso horizontal
 * - UNKNOWN: Occluded or insufficient landmarks
 *
 * Interventions:
 * - Distance issue -> Blur & warning overlay
 * - Posture issue -> Ambient non-blocking nudge only (NEVER blurs video)
 */

import { L } from "./i18n";
import type { LandmarkPoint } from "./floor-calibration";
import type { PostureType } from "./protocol";

export interface Landmark3D extends LandmarkPoint {
  z?: number;
}

export interface PostureEvaluation {
  posture: PostureType;
  torsoAngleDeg: number;
  neckAngleDeg: number;
  postureConfidence: number;
  postureScore: number;
  ambientNudgeText: string | null;
  description: string;
}

// MediaPipe Pose Keypoints
export const POSE_INDEX = {
  NOSE: 0,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

function midpoint(a: Landmark3D, b: Landmark3D): { x: number; y: number; z: number } {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z || 0) + (b.z || 0)) / 2,
  };
}

/**
 * Evaluates posture from 3D or 2D MediaPipe landmarks.
 * Posture alone does NOT trigger video blurring.
 */
export function evaluatePosture(landmarks: Landmark3D[]): PostureEvaluation {
  if (!landmarks || landmarks.length < 25) {
    return {
      posture: "UNKNOWN",
      torsoAngleDeg: 0,
      neckAngleDeg: 0,
      postureConfidence: 0,
      postureScore: 50,
      ambientNudgeText: null,
      description: L("No skeleton detected", "骨格を検出できません"),
    };
  }

  const nose = landmarks[POSE_INDEX.NOSE];
  const leftShoulder = landmarks[POSE_INDEX.LEFT_SHOULDER];
  const rightShoulder = landmarks[POSE_INDEX.RIGHT_SHOULDER];
  const leftHip = landmarks[POSE_INDEX.LEFT_HIP];
  const rightHip = landmarks[POSE_INDEX.RIGHT_HIP];

  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip || !nose) {
    return {
      posture: "UNKNOWN",
      torsoAngleDeg: 0,
      neckAngleDeg: 0,
      postureConfidence: 0,
      postureScore: 50,
      ambientNudgeText: null,
      description: L("Key landmarks are missing", "主要骨格ランドマークが不足しています"),
    };
  }

  const shoulderCenter = midpoint(leftShoulder, rightShoulder);
  const hipCenter = midpoint(leftHip, rightHip);

  // 1. Torso tilt angle relative to vertical axis
  const dx = shoulderCenter.x - hipCenter.x;
  const dy = Math.abs(shoulderCenter.y - hipCenter.y);
  const dz = (shoulderCenter.z || 0) - (hipCenter.z || 0);
  const horizontalDist = Math.sqrt(dx * dx + dz * dz);
  const torsoAngleRad = Math.atan2(horizontalDist, Math.max(0.001, dy));
  const torsoAngleDeg = Math.round((torsoAngleRad * 180) / Math.PI);

  // 2. Head forward tilt: ear midpoint over the shoulders (craniovertebral-angle proxy).
  // The nose sits ~10 cm in front of the shoulders even when upright, so it over-reports
  // "text neck" (a standing adult measured 22–27°). The nose is only used when the ears are not
  // visible, with a correspondingly higher threshold.
  const lEar = landmarks[POSE_INDEX.LEFT_EAR];
  const rEar = landmarks[POSE_INDEX.RIGHT_EAR];
  const earsVisible = Boolean(lEar && rEar && (lEar.visibility ?? 1) >= 0.5 && (rEar.visibility ?? 1) >= 0.5);
  const head = earsVisible ? midpoint(lEar, rEar) : { x: nose.x, y: nose.y, z: nose.z || 0 };
  const neckThresholdDeg = earsVisible ? 26 : 38;
  const neckDx = head.x - shoulderCenter.x;
  const neckDy = Math.abs(head.y - shoulderCenter.y);
  const neckDz = (head.z || 0) - (shoulderCenter.z || 0);
  const neckHorizontal = Math.sqrt(neckDx * neckDx + neckDz * neckDz);
  const neckAngleRad = Math.atan2(neckHorizontal, Math.max(0.001, neckDy));
  const neckAngleDeg = Math.round((neckAngleRad * 180) / Math.PI);

  // 3. Confidence from landmark visibilities
  const visibilities = [
    nose.visibility ?? 0.9,
    leftShoulder.visibility ?? 0.9,
    rightShoulder.visibility ?? 0.9,
    leftHip.visibility ?? 0.9,
    rightHip.visibility ?? 0.9,
  ];
  const postureConfidence = Number(
    (visibilities.reduce((a, b) => a + b, 0) / visibilities.length).toFixed(2)
  );

  // 4. Classification
  let posture: PostureType = "GOOD";
  let postureScore = 95;
  let ambientNudgeText: string | null = null;
  let description = L("Sitting up nicely 🌟", "背筋ピン！とても良い姿勢です 🌟");

  if (torsoAngleDeg >= 55 || dy < 0.18) {
    posture = "LYING_DOWN";
    postureScore = 30;
    ambientNudgeText = L("🛋️ Let's sit up to watch!", "🛋️ からだを起こして見よう！");
    description = L("Lying down 🛌 (sit up to watch)", "寝そべり中 🛌（座って見よう！）");
  } else if (torsoAngleDeg >= 22 || neckAngleDeg >= neckThresholdDeg) {
    posture = "SLOUCH";
    const penalty = Math.min(45, (torsoAngleDeg - 20) * 1.5 + (neckAngleDeg - 25) * 1.0);
    postureScore = Math.max(40, Math.round(85 - penalty));
    ambientNudgeText = L("🧘‍♂️ Sit up tall!", "🧘‍♂️ 背筋をぴんと伸ばそう！");
    description = L("Slouching or craning the neck ⚠️ (sit up tall)", "猫背・テレビ首の傾向 ⚠️（背筋を伸ばそう）");
  }

  return {
    posture,
    torsoAngleDeg,
    neckAngleDeg,
    postureConfidence,
    postureScore,
    ambientNudgeText,
    description,
  };
}
