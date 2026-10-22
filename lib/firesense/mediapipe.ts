/**
 * FireSense Kids — Self-hosted MediaPipe loader (browser only).
 *
 * WASM and models are served from our own origin (/mediapipe/*), never from a CDN.
 * GPU → CPU is NOT switched silently: the caller chooses a delegate, and a failure
 * is thrown so the UI can show it and let the user retry explicitly on CPU.
 */

import type { PoseLandmarker } from "@mediapipe/tasks-vision";

export const MEDIAPIPE_BASE = "/mediapipe";
/** "full" (not "lite"): fewer skeletons fitted to furniture in a cluttered living room. It is slower;
 *  the camera page lowers its inference rate by itself when the phone cannot keep up. */
export const POSE_MODEL_PATH = `${MEDIAPIPE_BASE}/models/pose_landmarker_full.task`;
/** Detection / presence / tracking confidence (MediaPipe default 0.5 lets clutter through: in 4× zoom
 *  tiles, 0.5 found "people" in sofa cushions and stuffed toys that 0.7 did not). */
export const POSE_MIN_CONFIDENCE = { detection: 0.7, presence: 0.7, tracking: 0.6 };

export type Delegate = "GPU" | "CPU";

async function vision() {
  const { FilesetResolver } = await import("@mediapipe/tasks-vision");
  return FilesetResolver.forVisionTasks(`${MEDIAPIPE_BASE}/wasm`);
}

/** `runningMode` "IMAGE" for the zoom pass: its crop moves between frames, so VIDEO-mode tracking would follow stale positions. */
export async function createPoseLandmarker(delegate: Delegate, numPoses = 3, runningMode: "VIDEO" | "IMAGE" = "VIDEO"): Promise<PoseLandmarker> {
  const { PoseLandmarker } = await import("@mediapipe/tasks-vision");
  return PoseLandmarker.createFromOptions(await vision(), {
    baseOptions: { modelAssetPath: POSE_MODEL_PATH, delegate },
    runningMode,
    numPoses,
    minPoseDetectionConfidence: POSE_MIN_CONFIDENCE.detection,
    minPosePresenceConfidence: POSE_MIN_CONFIDENCE.presence,
    minTrackingConfidence: POSE_MIN_CONFIDENCE.tracking,
  });
}
