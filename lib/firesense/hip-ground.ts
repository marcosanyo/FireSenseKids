/**
 * FireSense Kids — Where a person stands when the feet are hidden (TV-marker models only).
 *
 * Feet are often hidden (a table, a sofa, toys, crossed legs). With the TV-marker calibration the
 * camera pose is fully known, so the floor point under the hips can be computed instead:
 *
 *   1. Hip height above the floor: from MediaPipe's metric world landmarks (origin = hip center,
 *      camera-aligned axes), the drop from the hips to the lowest foot landmark along the room's
 *      "up" direction (known from the calibration). The model predicts all landmarks even when the
 *      feet are occluded. Standing ≈ leg length, on a chair or sofa ≈ shin length, on the floor ≈ 0.1 m.
 *   2. The hip center's image ray meets the horizontal plane at that height → floor position → the
 *      same screen distance as for feet.
 *
 * This is an estimate, labeled as such (lower confidence, "ESTIMATED" foot status): the world
 * landmarks' scale is the model's guess (it may read a small child as larger), and a wrong hip
 * height moves the point along the camera ray. Feet, when visible, always win.
 */

import { applyAdjust, imageToFloor, imageToFloorRaw, screenDistance, type FloorHomographyModel, type FloorModel, type FloorPosition, type LandmarkPoint } from "./floor-calibration";

const L_HIP = 23;
const R_HIP = 24;
const FOOT = [27, 28, 29, 30, 31, 32];
const HIP_VISIBILITY = 0.5;
export const MIN_HIP_HEIGHT_M = 0.08;
export const MAX_HIP_HEIGHT_M = 1.1;
/** Confidence of an estimate relative to the torso visibility. */
export const HIP_ESTIMATE_CONFIDENCE_FACTOR = 0.85;

export interface HipGroundEstimate {
  /** Image point of the hip center (normalized). */
  hip: { x: number; y: number };
  hipHeightM: number;
  floor: FloorPosition;
  distanceM: number;
}

/** Hip height above the floor from world landmarks; `up` = the room's up direction in camera coordinates. */
export function hipHeightFromWorld(world: LandmarkPoint[], up: number[]): number | null {
  if (!world || world.length < 33) return null;
  let drop = -Infinity;
  for (const k of FOOT) {
    const p = world[k];
    if (!p || typeof p.z !== "number") continue;
    // World landmarks: x right, y down, z away from the camera; hip center at the origin.
    drop = Math.max(drop, -(up[0] * p.x + up[1] * p.y + up[2] * p.z));
  }
  if (!Number.isFinite(drop)) return null;
  return Math.max(MIN_HIP_HEIGHT_M, Math.min(MAX_HIP_HEIGHT_M, drop));
}

export function estimateGroundFromHips(model: FloorModel, image: LandmarkPoint[], world: LandmarkPoint[] | undefined): HipGroundEstimate | null {
  if (!("tvPose" in model) || !model.tvPose || !world) return null;
  const l = image?.[L_HIP];
  const r = image?.[R_HIP];
  if (!l || !r || (l.visibility ?? 1) < HIP_VISIBILITY || (r.visibility ?? 1) < HIP_VISIBILITY) return null;
  const pose = model.tvPose;
  const hipHeightM = hipHeightFromWorld(world, pose.r[1]);
  if (hipHeightM === null || hipHeightM >= pose.cameraHeightM - 0.05) return null; // hips at lens height: no intersection
  const hip = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  const floor = imageToFloor(pose, hip.x, hip.y, hipHeightM);
  if (!floor) return null;
  const distanceM = Math.max(0.2, Math.min(6, Number(screenDistance(pose.screenWidthM, floor).toFixed(2))));
  return { hip, hipHeightM: Number(hipHeightM.toFixed(2)), floor, distanceM };
}

// ---------------------------------------------------------------------------
// Seated: the floor point under the head, not under the feet
// ---------------------------------------------------------------------------
/*
 * On a sofa or the floor the feet are well ahead of the eyes (legs stretched out, on a footrest): the feet
 * read 0.5–1 m closer to the TV than where the person watches from. Seated = both thighs more than ~55°
 * from vertical in the room (world landmarks + the calibrated up direction). Then the distance is taken
 * under the head: the floor point under the hips (as above, hip height from the world landmarks), moved by
 * the head's horizontal offset from the hips (world landmarks, turned into the floor plan). The hip height is
 * the drop to the feet when the shins are vertical (feet on the floor), else from the upper body's size.
 * Only with world landmarks (MediaPipe) and the TV-marker calibration; otherwise the feet as before.
 */
const L_KNEE = 25;
const R_KNEE = 26;
const NOSE = 0;
/** cos of the thigh angle from vertical below which a person counts as seated (≈ 55°). */
export const SEATED_THIGH_COS = 0.57;

/** Both thighs closer to horizontal than SEATED_THIGH_COS (`up` = the room's up direction in camera coordinates). */
export function isSeated(image: LandmarkPoint[], world: LandmarkPoint[] | undefined, up: number[]): boolean {
  if (!world || world.length < 33) return false;
  for (const [hipI, kneeI] of [[L_HIP, L_KNEE], [R_HIP, R_KNEE]]) {
    const hip = world[hipI];
    const knee = world[kneeI];
    if (!hip || !knee || (image[kneeI]?.visibility ?? 1) < HIP_VISIBILITY || (image[hipI]?.visibility ?? 1) < HIP_VISIBILITY) return false;
    const v = [knee.x - hip.x, knee.y - hip.y, (knee.z ?? 0) - (hip.z ?? 0)];
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-6) return false;
    const drop = -(up[0] * v[0] + up[1] * v[1] + up[2] * v[2]);
    if (drop / len >= SEATED_THIGH_COS) return false;
  }
  return true;
}

const L_ANKLE = 27;
const R_ANKLE = 28;
/** Shins at least this close to vertical (cos): the feet are under the knees, i.e. on the floor. */
export const FEET_DOWN_SHIN_COS = 0.7;
const UPPER_BODY = [0, 7, 8, 11, 12];

/** Room point (raw floor lateral, height, front) → normalized image point, or null behind the camera. */
function projectRoom(pose: TvPose, lateralM: number, heightM: number, frontM: number): { x: number; y: number } | null {
  const { focal: f, r, camera: C, screenWidthM: W, imageAspect, cameraHeightM: h } = pose;
  const v = [lateralM - (C.a - W / 2), heightM - h, frontM - C.n];
  const c = [0, 1, 2].map((j) => r[0][j] * v[0] + r[1][j] * v[1] + r[2][j] * v[2]); // camera axes (Rᵀ v)
  if (!(c[2] > 1e-6)) return null;
  return { x: 0.5 + (f * c[0]) / c[2] / imageAspect, y: 0.5 + (f * c[1]) / c[2] };
}

/** Both shins near vertical: the feet are below the knees (on the floor), not stretched out on a footrest. */
function feetDown(world: LandmarkPoint[], up: number[]): boolean {
  for (const [k, a] of [[L_KNEE, L_ANKLE], [R_KNEE, R_ANKLE]]) {
    const v = [world[a].x - world[k].x, world[a].y - world[k].y, (world[a].z ?? 0) - (world[k].z ?? 0)];
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-6 || -(up[0] * v[0] + up[1] * v[1] + up[2] * v[2]) / len < FEET_DOWN_SHIN_COS) return false;
  }
  return true;
}

/**
 * Hip height from the upper body's size: the world landmarks (meters) placed with the hips at height H on the
 * hip's image ray, projected back, best match the image (shoulders, nose, ears). Used when the feet are not on
 * the floor (legs on a footrest), where the drop to the feet says nothing about the seat. It relies on the
 * pose model's metric scale (about right for adults; a small child may read as larger, i.e. closer).
 */
export function hipHeightFromUpperBody(pose: TvPose, image: LandmarkPoint[], world: LandmarkPoint[]): number | null {
  const hip = mid(image, L_HIP, R_HIP);
  if (!hip) return null;
  const pts = UPPER_BODY.filter((k) => (image[k]?.visibility ?? 1) >= HIP_VISIBILITY && typeof world[k]?.z === "number");
  if (pts.length < 3) return null;
  const wh = [(world[L_HIP].x + world[R_HIP].x) / 2, (world[L_HIP].y + world[R_HIP].y) / 2, ((world[L_HIP].z ?? 0) + (world[R_HIP].z ?? 0)) / 2];
  const r = pose.r;
  const offsets = pts.map((k) => {
    const v = [world[k].x - wh[0], world[k].y - wh[1], (world[k].z as number) - wh[2]];
    return { k, room: [0, 1, 2].map((i) => r[i][0] * v[0] + r[i][1] * v[1] + r[i][2] * v[2]) };
  });
  let best: { h: number; err: number } | null = null;
  for (let H = MIN_HIP_HEIGHT_M; H <= Math.min(MAX_HIP_HEIGHT_M, pose.cameraHeightM - 0.05); H += 0.01) {
    const base = imageToFloorRaw(pose, hip.x, hip.y, H);
    if (!base) continue;
    let err = 0;
    for (const o of offsets) {
      const p = projectRoom(pose, base.lateralM + o.room[0], H + o.room[1], base.frontM + o.room[2]);
      if (!p) {
        err = Infinity;
        break;
      }
      err += ((p.x - image[o.k].x) * pose.imageAspect) ** 2 + (p.y - image[o.k].y) ** 2;
    }
    if (!best || err < best.err) best = { h: H, err };
  }
  return best && Number.isFinite(best.err) ? best.h : null;
}

/** Seated person: the floor point under the head. Null when the hips or the head are not usable. */
export function estimateSeatedViewpoint(model: FloorModel, image: LandmarkPoint[], world: LandmarkPoint[] | undefined): HipGroundEstimate | null {
  if (!("tvPose" in model) || !model.tvPose || !world || world.length < 33) return null;
  const pose = model.tvPose;
  const hip = mid(image, L_HIP, R_HIP);
  const nose = world[NOSE];
  if (!hip || !nose || typeof nose.z !== "number" || (image[NOSE]?.visibility ?? 1) < HIP_VISIBILITY) return null;
  // Feet on the floor: the drop to the feet is the seat height. Legs stretched out: from the upper body's size.
  const hipHeightM = feetDown(world, pose.r[1]) ? hipHeightFromWorld(world, pose.r[1]) : hipHeightFromUpperBody(pose, image, world);
  if (hipHeightM === null || hipHeightM >= pose.cameraHeightM - 0.05) return null;
  const raw = imageToFloorRaw(pose, hip.x, hip.y, hipHeightM);
  if (!raw) return null;
  // World origin = hip center: the nose's world position is the head's offset from the hips.
  const r = pose.r;
  const n = [nose.x, nose.y, nose.z];
  const head = { lateralM: raw.lateralM + r[0][0] * n[0] + r[0][1] * n[1] + r[0][2] * n[2], frontM: raw.frontM + r[2][0] * n[0] + r[2][1] * n[1] + r[2][2] * n[2] };
  const floor = applyAdjust(pose.adjust, head);
  const distanceM = Math.max(0.2, Math.min(6, Number(screenDistance(pose.screenWidthM, floor).toFixed(2))));
  return { hip: { x: image[NOSE].x, y: image[NOSE].y }, hipHeightM: Number(hipHeightM.toFixed(2)), floor, distanceM };
}

// ---------------------------------------------------------------------------
// Without world landmarks (RTMO): the hip height learned while the feet were visible
// ---------------------------------------------------------------------------
/*
 * RTMO gives image points only. While a person's feet are visible, the floor point under the feet and the
 * hip (and shoulder) image points give that person's hip height and torso length in meters. When the feet
 * disappear, the hip ray meets the plane at the learned hip height → a floor point, labeled as estimated.
 *
 * The learned height is only right while the person stands as before. Sitting down lowers the hips: the
 * estimate then lies too close to the camera, and the torso measured there comes out shorter by the same
 * factor ((lens − learned) / (lens − actual), ≈ 0.83 on a sofa, ≈ 0.6 on the floor for a lens at 1.2 m),
 * however slowly the person sat. So the estimate is used only while
 *   - the torso measured at the estimate stays within ±12 % of the learned one (not sitting / standing up),
 *   - at most 4 s have passed since the feet were last seen,
 *   - it is within 0.3 m + 1.2 m/s × elapsed time of where the feet were last seen.
 * Otherwise there is no distance (the person counts as not seen, and the blur clears): a wrong distance
 * would blur for a child sitting on the sofa.
 */
export const HIP_MEMORY_MAX_MS = 4000;
export const HIP_MEMORY_TORSO_TOLERANCE = 0.12;
export const HIP_MEMORY_SPEED_MPS = 1.2;
export const HIP_MEMORY_SLACK_M = 0.3;
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const MIN_LEARNED_HIP_M = 0.1;
const MAX_LEARNED_HIP_M = 1.2;
const HEIGHT_SAMPLES = 8;

type TvPose = NonNullable<FloorHomographyModel["tvPose"]>;

function mid(lms: LandmarkPoint[], a: number, b: number): { x: number; y: number } | null {
  const p = lms[a];
  const q = lms[b];
  if (!p || !q || (p.visibility ?? 1) < HIP_VISIBILITY || (q.visibility ?? 1) < HIP_VISIBILITY) return null;
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

/** Height above the floor at which the ray through image point `pt` passes over floor point `over` (raw floor coordinates). */
export function heightOverFloorPoint(pose: TvPose, pt: { x: number; y: number }, over: FloorPosition): number | null {
  const { focal: f, r, camera: C, screenWidthM: W, imageAspect, cameraHeightM: h } = pose;
  const d = [((pt.x - 0.5) * imageAspect) / f, (pt.y - 0.5) / f, 1];
  const along = (k: number) => r[k][0] * d[0] + r[k][1] * d[1] + r[k][2] * d[2];
  const dl = along(0);
  const du = along(1);
  const df = along(2);
  const horiz = dl * dl + df * df;
  if (horiz < 1e-12) return null;
  const s = ((over.lateralM - (C.a - W / 2)) * dl + (over.frontM - C.n) * df) / horiz;
  if (!(s > 0)) return null;
  return h + s * du;
}

/** What is learned about a person while their feet are visible. */
export interface LearnedHip {
  hipHeightM: number;
  torsoM: number;
  /** Floor point under the heels (raw floor coordinates). */
  foot: FloorPosition;
}

/**
 * Hip height and torso length from one frame with the feet visible: over the point between the heels (or the
 * ankles), which is under the hips when standing (the lowest foot point, used for the distance, is often the
 * toes, ahead of the hips). Null when a needed point is missing or the numbers are implausible.
 */
export function learnHip(pose: TvPose, lms: LandmarkPoint[]): LearnedHip | null {
  const under = mid(lms, 29, 30) ?? mid(lms, 27, 28);
  const hip = mid(lms, L_HIP, R_HIP);
  const sh = mid(lms, L_SHOULDER, R_SHOULDER);
  if (!under || !hip || !sh) return null;
  const foot = imageToFloorRaw(pose, under.x, under.y);
  if (!foot) return null;
  const hipH = heightOverFloorPoint(pose, hip, foot);
  const shH = heightOverFloorPoint(pose, sh, foot);
  if (hipH === null || shH === null || hipH < MIN_LEARNED_HIP_M || hipH > MAX_LEARNED_HIP_M || shH <= hipH) return null;
  return { hipHeightM: hipH, torsoM: shH - hipH, foot };
}

/**
 * How long the torso comes out, relative to the learned one, when the hips are assumed at the learned height:
 * ≈ 1 while the person stands as before; smaller when they have sat down (the hips are lower than assumed).
 * Null when the hips or shoulders are not visible or the ray does not reach that height.
 */
export function torsoRatio(pose: TvPose, lms: LandmarkPoint[], hipHeightM: number, torsoM: number): number | null {
  const hip = mid(lms, L_HIP, R_HIP);
  const sh = mid(lms, L_SHOULDER, R_SHOULDER);
  if (!hip || !sh) return null;
  const raw = imageToFloorRaw(pose, hip.x, hip.y, hipHeightM);
  if (!raw) return null;
  const shH = heightOverFloorPoint(pose, sh, raw);
  return shH === null ? null : (shH - hipHeightM) / torsoM;
}

export class HipMemory {
  private readonly people = new Map<string, { heights: number[]; torsoM: number; foot: FloorPosition; at: number }>();

  /** Feet visible: learn this person's hip height and torso length (`learnHip`). */
  observe(key: string, pose: TvPose, lms: LandmarkPoint[], nowMs: number): void {
    const learned = learnHip(pose, lms);
    if (!learned) return;
    const prev = this.people.get(key);
    const heights = [...(prev?.heights ?? []), learned.hipHeightM].slice(-HEIGHT_SAMPLES);
    this.people.set(key, { heights, torsoM: learned.torsoM, foot: learned.foot, at: nowMs });
    for (const [k, v] of this.people) if (nowMs - v.at > 60_000) this.people.delete(k);
  }

  /** Feet hidden: the floor point under the hips at the learned height, or null when it cannot be trusted. */
  estimate(key: string, pose: TvPose, lms: LandmarkPoint[], nowMs: number): HipGroundEstimate | null {
    const m = this.people.get(key);
    if (!m || nowMs - m.at > HIP_MEMORY_MAX_MS) return null;
    const hip = mid(lms, L_HIP, R_HIP);
    const sh = mid(lms, L_SHOULDER, R_SHOULDER);
    if (!hip || !sh) return null;
    const sorted = [...m.heights].sort((a, b) => a - b);
    const hipHeightM = sorted[Math.floor(sorted.length / 2)];
    if (hipHeightM >= pose.cameraHeightM - 0.05) return null;
    const raw = imageToFloorRaw(pose, hip.x, hip.y, hipHeightM);
    if (!raw) return null;
    const ratio = torsoRatio(pose, lms, hipHeightM, m.torsoM);
    if (ratio === null || Math.abs(ratio - 1) > HIP_MEMORY_TORSO_TOLERANCE) return null; // sat down or stood up
    const dt = (nowMs - m.at) / 1000;
    if (Math.hypot(raw.lateralM - m.foot.lateralM, raw.frontM - m.foot.frontM) > HIP_MEMORY_SLACK_M + HIP_MEMORY_SPEED_MPS * dt) return null;
    const floor = imageToFloor(pose, hip.x, hip.y, hipHeightM);
    if (!floor) return null;
    const distanceM = Math.max(0.2, Math.min(6, Number(screenDistance(pose.screenWidthM, floor).toFixed(2))));
    return { hip, hipHeightM: Number(hipHeightM.toFixed(2)), floor, distanceM };
  }
}

