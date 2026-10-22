/**
 * FireSense Kids — 2-Point Floor Position Calibration
 *
 * Implements physically grounded distance estimation by calibrating
 * ground contact points on a flat floor plane rather than relying on
 * child/adult body height or single-view apparent scale.
 *
 * Model: 1 / d = a * y + b
 * Grounded on projective camera geometry:
 * - Marker A (Near reference): 1.2 m
 * - Marker B (Far reference): 1.8 m
 */

import { L } from "./i18n";


export interface LandmarkPoint {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface FloorSample {
  groundY: number;
  confidence: number;
  timestamp: number;
}

export interface FloorCalibrationModel {
  kind?: "linear";
  /** How the model was obtained. "geometry" is an approximate model from phone height/tilt/FOV. */
  method?: "two_point" | "geometry";
  /**
   * Lowest image y where floor is still visible (0..1). Below it something else fills the frame,
   * typically the top of the TV stand. Defaults to 1 (the bottom edge of the frame).
   * BELOW_FRAME and d_edge are measured against this line, not against y = 1.
   */
  floorBottomY?: number;
  markerADistance: number; // e.g. 1.2
  markerBDistance: number; // e.g. 1.8
  medianYA: number;
  medianYB: number;
  a: number;
  b: number;
  sampleCountA: number;
  sampleCountB: number;
  calibratedAt: number;
}

export interface CalibrationResult {
  success: boolean;
  model?: FloorCalibrationModel;
  errorMessage?: string;
}

export const DEFAULT_MARKER_A_METERS = 1.2;
export const DEFAULT_MARKER_B_METERS = 1.8;
export const MIN_SAMPLES_REQUIRED = 15;
export const MIN_CONFIDENCE_THRESHOLD = 0.60;

/**
 * Extracts ground contact Y coordinate from MediaPipe Pose landmarks (normalized 0..1, where 1 is floor).
 * Checks ankles (27, 28), heels (29, 30), and foot index (31, 32).
 *
 * Returns null when no foot landmark is visible. Knees or body height are never
 * substituted: near the TV the feet leave the bottom edge of the frame, and a
 * knee-based estimate would read *farther* exactly when the child is closest.
 * That case is reported explicitly as BELOW_FRAME (see below-frame.ts).
 */
export function extractGroundContactPoint(
  landmarks: LandmarkPoint[]
): { groundX: number; groundY: number; confidence: number } | null {
  if (!landmarks || landmarks.length < 33) return null;

  const footIndices = [27, 28, 29, 30, 31, 32];
  const validPoints: { x: number; y: number; conf: number }[] = [];

  for (const idx of footIndices) {
    const lm = landmarks[idx];
    if (lm && typeof lm.y === "number") {
      const conf = typeof lm.visibility === "number" ? lm.visibility : 0.8;
      if (conf >= 0.4) {
        validPoints.push({ x: lm.x, y: lm.y, conf });
      }
    }
  }

  if (validPoints.length === 0) return null;

  // Ground contact point is the lowest visible point in the image (largest y value)
  let maxItem = validPoints[0];
  let confSum = 0;
  for (const item of validPoints) {
    if (item.y > maxItem.y) {
      maxItem = item;
    }
    confSum += item.conf;
  }

  const avgConf = confSum / validPoints.length;

  return {
    groundX: maxItem.x,
    groundY: maxItem.y,
    confidence: avgConf,
  };
}

/**
 * Helper to compute the median of an array of numbers.
 */
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Removes statistical outliers using Interquartile Range (IQR).
 */
export function filterGroundSamplesIQR(samples: FloorSample[]): FloorSample[] {
  if (samples.length < 4) return samples;

  const yValues = samples.map((s) => s.groundY).sort((a, b) => a - b);
  const q1 = computeMedian(yValues.slice(0, Math.floor(yValues.length / 2)));
  const q3 = computeMedian(yValues.slice(Math.ceil(yValues.length / 2)));
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  return samples.filter((s) => s.groundY >= lowerBound && s.groundY <= upperBound);
}

/**
 * Fits a projective ground plane model: 1 / distance = a * y + b
 * Given 2 calibrated points:
 * Point A (Near: 1.2m, foot lower in image => larger yA)
 * Point B (Far: 1.8m, foot higher in image => smaller yB)
 */
export function fitFloorCalibration(
  samplesA: FloorSample[],
  samplesB: FloorSample[],
  distanceA: number = DEFAULT_MARKER_A_METERS,
  distanceB: number = DEFAULT_MARKER_B_METERS
): CalibrationResult {
  // 1. Filter by confidence
  const validA = samplesA.filter((s) => s.confidence >= MIN_CONFIDENCE_THRESHOLD);
  const validB = samplesB.filter((s) => s.confidence >= MIN_CONFIDENCE_THRESHOLD);

  if (validA.length < MIN_SAMPLES_REQUIRED) {
    return {
      success: false,
      errorMessage: `Marker A needs at least ${MIN_SAMPLES_REQUIRED} valid samples (got ${validA.length})`,
    };
  }
  if (validB.length < MIN_SAMPLES_REQUIRED) {
    return {
      success: false,
      errorMessage: `Marker B needs at least ${MIN_SAMPLES_REQUIRED} valid samples (got ${validB.length})`,
    };
  }

  // 2. Remove outliers
  const cleanA = filterGroundSamplesIQR(validA);
  const cleanB = filterGroundSamplesIQR(validB);

  const medianYA = computeMedian(cleanA.map((s) => s.groundY));
  const medianYB = computeMedian(cleanB.map((s) => s.groundY));

  // In standard camera viewpoint looking at floor:
  // Closer marker (distanceA < distanceB) must have a larger Y coordinate in image (closer to bottom).
  if (medianYA <= medianYB + 0.01) {
    return {
      success: false,
      errorMessage: `Geometric inversion detected: Marker A y (${medianYA.toFixed(3)}) must be below Marker B y (${medianYB.toFixed(3)})`,
    };
  }

  // 3. Solve 1 / d = a * y + b
  const invDA = 1.0 / distanceA;
  const invDB = 1.0 / distanceB;

  const a = (invDA - invDB) / (medianYA - medianYB);
  const b = invDA - a * medianYA;

  if (a <= 0) {
    return {
      success: false,
      errorMessage: `Degenerate floor slope (a = ${a.toFixed(4)})`,
    };
  }

  return {
    success: true,
    model: {
      method: "two_point",
      markerADistance: distanceA,
      markerBDistance: distanceB,
      medianYA,
      medianYB,
      a,
      b,
      sampleCountA: cleanA.length,
      sampleCountB: cleanB.length,
      calibratedAt: Date.now(),
    },
  };
}

/**
 * Computes metric distance from ground contact Y using the calibrated model,
 * clamped to realistic domestic viewing bounds [0.4m, 5.0m].
 */
export function estimateDistanceFromFloorModel(
  groundY: number,
  model: FloorCalibrationModel
): number {
  const invD = model.a * groundY + model.b;
  if (invD <= 0.05) {
    return 5.0; // beyond the calibrated floor range
  }
  const dist = 1.0 / invD;
  // Clamp to realistic domestic viewing bounds
  return Math.max(0.4, Math.min(5.0, Number(dist.toFixed(2))));
}

/**
 * Distance at which the feet leave the visible floor (y = floorBottomY, default 1 = frame edge).
 * From 1/d = a*y + b  =>  d_edge = 1 / (a*floorBottomY + b).
 * Anything closer than d_edge cannot be measured from the floor and is BELOW_FRAME.
 */
export function computeEdgeDistance(model: Pick<FloorCalibrationModel, "a" | "b" | "floorBottomY">): number {
  const inv = model.a * (model.floorBottomY ?? 1) + model.b;
  if (inv <= 0) {
    throw new Error(`Degenerate floor model: a·y_bottom + b = ${inv.toFixed(4)} (cannot compute edge distance)`);
  }
  return Number((1 / inv).toFixed(2));
}

/** BELOW_FRAME fires when the feet were last seen within this margin above the visible floor bottom. */
export const BELOW_FRAME_MARGIN_Y = 0.1;

export function belowFrameEdgeY(model: Pick<FloorCalibrationModel, "floorBottomY">): number {
  return (model.floorBottomY ?? 1) - BELOW_FRAME_MARGIN_Y;
}

/** Setup guide threshold: the camera should see feet down to at least this distance. */
export const MAX_ACCEPTABLE_EDGE_DISTANCE_M = 0.9;

const SHOULDERS = [11, 12];
const HIPS = [23, 24];
const TORSO_VISIBILITY = 0.5;

export interface BodyObservation {
  personDetected: boolean;
  /** Feet visible: ground contact y (0..1, 1 = bottom edge). null when feet are not visible. */
  groundY: number | null;
  /** Horizontal image position of the ground contact point (needed for off-axis placement). */
  groundX: number | null;
  footConfidence: number;
  /** Both shoulders and both hips visible. */
  torsoVisible: boolean;
  /** Mean visibility of shoulders and hips (0..1). */
  torsoConfidence: number;
  /** Horizontal center of the torso, 0..1 (used to tell a sideways exit from a bottom exit). */
  centerX: number | null;
}

export function observeBody(landmarks: LandmarkPoint[] | null | undefined): BodyObservation {
  if (!landmarks || landmarks.length < 33) {
    return { personDetected: false, groundY: null, groundX: null, footConfidence: 0, torsoVisible: false, torsoConfidence: 0, centerX: null };
  }
  const visible = (idx: number) => (landmarks[idx]?.visibility ?? 1) >= TORSO_VISIBILITY;
  const torsoIdx = [...SHOULDERS, ...HIPS];
  const torsoVisible = torsoIdx.every(visible);
  const torsoConfidence = torsoIdx.reduce((acc, i) => acc + (landmarks[i]?.visibility ?? 1), 0) / torsoIdx.length;
  const centerX = torsoVisible ? torsoIdx.reduce((acc, i) => acc + landmarks[i].x, 0) / torsoIdx.length : null;
  const ground = extractGroundContactPoint(landmarks);
  return {
    personDetected: true,
    groundY: ground ? ground.groundY : null,
    groundX: ground ? ground.groundX : null,
    footConfidence: ground ? ground.confidence : 0,
    torsoVisible,
    torsoConfidence,
    centerX,
  };
}

// ---------------------------------------------------------------------------
// Approximate model from camera geometry (manual calibration)
// ---------------------------------------------------------------------------

export interface CameraGeometry {
  /** Lens height above the floor (m). */
  heightM: number;
  /** Downward tilt of the optical axis from horizontal (deg). */
  pitchDownDeg: number;
  /** Vertical field of view of the frame as delivered to MediaPipe (deg). */
  vfovDeg: number;
  /** Horizontal offset between the lens and the TV screen plane (m, + = lens in front of the screen). */
  lensAheadOfScreenM?: number;
}

/** Image y (0 = top, 1 = bottom) where a floor point at `distanceM` from the TV screen appears. */
export function floorYForDistance(distanceM: number, g: CameraGeometry): number {
  const x = distanceM - (g.lensAheadOfScreenM ?? 0);
  const depression = Math.atan2(g.heightM, x);
  const offAxis = depression - (g.pitchDownDeg * Math.PI) / 180;
  return 0.5 + Math.tan(offAxis) / (2 * Math.tan(((g.vfovDeg / 2) * Math.PI) / 180));
}

/** Distance at which the feet reach the bottom edge (y = 1) under pure geometry. */
export function geometricEdgeDistance(g: CameraGeometry): number {
  const angle = ((g.pitchDownDeg + g.vfovDeg / 2) * Math.PI) / 180;
  if (angle <= 0 || angle >= Math.PI / 2) {
    throw new Error(`Camera does not see the floor below it (tilt ${g.pitchDownDeg}° + half FOV ${g.vfovDeg / 2}°)`);
  }
  return g.heightM / Math.tan(angle) + (g.lensAheadOfScreenM ?? 0);
}

/**
 * Builds a FloorCalibrationModel from camera geometry by least-squares fitting
 * 1/d = a·y + b over the working range. Explicitly labeled method "geometry";
 * the 2-point floor calibration remains the accurate path.
 */
export function modelFromCameraGeometry(
  g: CameraGeometry,
  // The decision range (TOO_CLOSE 1.3m, SAFE 1.65m, fast-fps 2.0m). With the camera tilted, 1/d is
  // only approximately linear in y, so the fit is limited to where it matters.
  rangeM: [number, number] = [0.8, 2.2]
): { model: FloorCalibrationModel; maxErrorM: number } {
  if (!(g.heightM > 0) || !(g.vfovDeg > 0 && g.vfovDeg < 170)) {
    throw new Error(`Invalid camera geometry: ${JSON.stringify(g)}`);
  }
  const pts: { y: number; inv: number; d: number }[] = [];
  for (let d = rangeM[0]; d <= rangeM[1] + 1e-9; d += 0.05) {
    const y = floorYForDistance(d, g);
    if (y >= 0 && y <= 1) pts.push({ y, inv: 1 / d, d });
  }
  if (pts.length < 5) {
    throw new Error(`The floor between ${rangeM[0]}m and ${rangeM[1]}m is not in view with this height/tilt/FOV`);
  }
  const n = pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  const mi = pts.reduce((s, p) => s + p.inv, 0) / n;
  const cov = pts.reduce((s, p) => s + (p.y - my) * (p.inv - mi), 0);
  const vy = pts.reduce((s, p) => s + (p.y - my) ** 2, 0);
  const a = cov / vy;
  const b = mi - a * my;
  if (!(a > 0)) throw new Error(`Degenerate geometry model (a = ${a})`);
  const maxErrorM = Math.max(...pts.map((p) => Math.abs(1 / (a * p.y + b) - p.d)));
  const yA = floorYForDistance(DEFAULT_MARKER_A_METERS, g);
  const yB = floorYForDistance(DEFAULT_MARKER_B_METERS, g);
  return {
    model: {
      method: "geometry",
      markerADistance: DEFAULT_MARKER_A_METERS,
      markerBDistance: DEFAULT_MARKER_B_METERS,
      medianYA: yA,
      medianYB: yB,
      a,
      b,
      sampleCountA: 0,
      sampleCountB: 0,
      calibratedAt: Date.now(),
    },
    maxErrorM: Number(maxErrorM.toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Floor homography (any placement, e.g. phone beside the TV looking diagonally)
// ---------------------------------------------------------------------------
//
// For a planar floor and a pinhole camera, the perpendicular distance Z from the TV plane of a
// floor point seen at image (x, y) is exactly a ratio of linear functions:
//     Z = (p1·x + p2·y + p3) / (q1·x + q2·y + 1)
// Five unknowns. Level sets (Z = const) are straight image lines through one vanishing point, so
// points tapped on three floor lines parallel to the TV (known distances) determine the model.
// Unlike the y-only model, this is exact for tilted cameras and handles lateral placement.

export interface FloorLineSample {
  /** Perpendicular distance of this floor line from the TV screen plane (m). */
  distanceM: number;
  /** Normalized image points (0..1) on that line. */
  points: { x: number; y: number }[];
}

export interface FloorHomographyModel {
  kind: "homography";
  /** How the model was made: tapped / AI-picked floor lines (default) or the TV-marker pose. */
  method?: "lines" | "tv_marker";
  p: [number, number, number];
  q: [number, number];
  /** Constant term of the denominator (default 1). TV-marker models set it so that the denominator
   *  is positive exactly for image points whose ray reaches the floor (below the horizon). */
  q3?: number;
  /** TV-marker models keep the full camera pose so the floor in front of the TV can be projected
   *  into the image (watch-zone overlay / coverage). */
  tvPose?: {
    focal: number;
    r: [number[], number[], number[]];
    camera: { a: number; b: number; n: number };
    screenWidthM: number;
    imageAspect: number;
    cameraHeightM: number;
    /** The parent's correction after calibration (shift, turn, real-distance fit). Absent = none. */
    adjust?: ZoneAdjust;
    /** Gravity's "up" in camera coordinates at calibration (to notice the phone was moved). */
    gravityUp?: number[];
    /** screen.orientation.angle at calibration (to notice the phone was turned). */
    screenAngle?: number;
  };
  floorBottomY?: number;
  /** Largest fitted-vs-given distance error over the calibration points (m). */
  maxResidualM: number;
  lines: FloorLineSample[];
  calibratedAt: number;
}

export type FloorModel = FloorCalibrationModel | FloorHomographyModel;

export function isHomography(model: FloorModel): model is FloorHomographyModel {
  return (model as FloorHomographyModel).kind === "homography";
}

export function homographyDistance(
  m: Pick<FloorHomographyModel, "p" | "q" | "q3" | "method">,
  x: number,
  y: number
): number | null {
  const den = m.q[0] * x + m.q[1] * y + (m.q3 ?? 1);
  if (Math.abs(den) < 1e-9) return null;
  if (m.method === "tv_marker" && den < 0) return null; // above the horizon: not on the floor
  const z = (m.p[0] * x + m.p[1] * y + m.p[2]) / den;
  return Number.isFinite(z) ? z : null;
}

/** Solves A·v = b (small dense system) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export const MAX_HOMOGRAPHY_RESIDUAL_M = 0.1;

export function fitFloorHomography(
  lines: FloorLineSample[]
): { success: true; model: FloorHomographyModel } | { success: false; errorMessage: string } {
  const usable = lines.filter((l) => l.points.length > 0);
  const distinct = new Set(usable.map((l) => l.distanceM.toFixed(3)));
  if (distinct.size < 3) {
    return { success: false, errorMessage: L(`Three lines at different distances are needed (now ${distinct.size})`, `3本の線（それぞれ距離が違う）が必要です（今は${distinct.size}本）`) };
  }
  const short = usable.find((l) => l.points.length < 2);
  if (short) return { success: false, errorMessage: L(`Tap two or more points on the ${short.distanceM} m line`, `${short.distanceM}m の線に2点以上タップしてください`) };

  // Linear least squares: p1 x + p2 y + p3 − Z q1 x − Z q2 y = Z
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (const l of usable) {
    for (const pt of l.points) {
      rows.push([pt.x, pt.y, 1, -l.distanceM * pt.x, -l.distanceM * pt.y]);
      rhs.push(l.distanceM);
    }
  }
  const AtA = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const Atb = Array.from({ length: 5 }, (_, i) => rows.reduce((s, r, k) => s + r[i] * rhs[k], 0));
  const v = solve(AtA, Atb);
  if (!v) return { success: false, errorMessage: L("Cannot solve: the lines are not parallel or the points are too close. Tap both ends of each line", "線が平行でない、または点が近すぎて解けません。線の両端をタップしてください") };

  const model: FloorHomographyModel = {
    kind: "homography",
    p: [v[0], v[1], v[2]],
    q: [v[3], v[4]],
    maxResidualM: 0,
    lines: usable,
    calibratedAt: Date.now(),
  };
  let worst = 0;
  for (const l of usable) {
    for (const pt of l.points) {
      const z = homographyDistance(model, pt.x, pt.y);
      if (z === null) return { success: false, errorMessage: L("The model diverged. Tap again", "モデルが発散しました。タップし直してください") };
      worst = Math.max(worst, Math.abs(z - l.distanceM));
    }
  }
  model.maxResidualM = Number(worst.toFixed(3));
  // With exactly three lines any labeling fits perfectly, so residuals cannot catch a wrong distance.
  // A wrong order shows up as a pole between lines: the midpoint of two neighboring lines (sorted by
  // distance) must map to a distance between theirs.
  const sorted = [...usable].sort((a, b) => a.distanceM - b.distanceM);
  const centroid = (l: FloorLineSample) => ({
    x: l.points.reduce((s, p) => s + p.x, 0) / l.points.length,
    y: l.points.reduce((s, p) => s + p.y, 0) / l.points.length,
  });
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = centroid(sorted[i]);
    const b = centroid(sorted[i + 1]);
    const z = homographyDistance(model, (a.x + b.x) / 2, (a.y + b.y) / 2);
    if (z === null || z <= sorted[i].distanceM || z >= sorted[i + 1].distanceM) {
      return {
        success: false,
        errorMessage: L(`The line order does not match the distances (the ${sorted[i].distanceM} m and ${sorted[i + 1].distanceM} m lines). Check which line you tapped`, `線の並び順と距離が合いません（${sorted[i].distanceM}m と ${sorted[i + 1].distanceM}m の線）。どの線にタップしたかを確認してください`),
      };
    }
  }
  if (worst > MAX_HOMOGRAPHY_RESIDUAL_M) {
    return {
      success: false,
      errorMessage: L(`The tapped points do not match the distances (largest error ${Math.round(worst * 100)} cm). Check the selected lines and distances`, `タップした点と距離が一致しません（最大誤差 ${Math.round(worst * 100)}cm）。線の選択と距離の設定を確認してください`),
    };
  }
  return { success: true, model };
}

// ---------------------------------------------------------------------------
// TV-marker models: position on the floor and distance from the screen
// ---------------------------------------------------------------------------
// The TV-marker calibration knows the full camera pose, so an image point maps to a floor position
// (lateral, front) and not only to "how far in front of the screen plane". The distance used for
// the thresholds is then measured from the screen itself (the segment the screen spans), so the
// zone is a band with rounded ends: straight in front of the screen, semicircles beside it. With
// the plain perpendicular distance, someone 0.5 m in front of the wall but 2 m to the side of the
// TV (e.g. on a sofa) would count as too close.

type TvPose = NonNullable<FloorHomographyModel["tvPose"]>;

export interface FloorPosition {
  /** From the screen center along the screen, to the viewer's right (m). */
  lateralM: number;
  /** In front of the screen plane (m). */
  frontM: number;
}

/**
 * Correction of the TV-marker floor, applied to every floor position (and inverted to draw the zone):
 * turn by `angleDeg` about the screen center, stretch the distance in front of the screen by `scale`,
 * then shift by `dxM` (along the screen, viewer's right +) and `dzM` (toward the room).
 * The calibration is a camera model with a few inputs (TV size, heights); a lens that is not a perfect
 * pinhole or a slightly wrong input leaves errors that the parent can see and correct.
 */
export interface ZoneAdjust {
  dxM: number;
  dzM: number;
  angleDeg: number;
  scale: number;
}
export const NO_ADJUST: ZoneAdjust = { dxM: 0, dzM: 0, angleDeg: 0, scale: 1 };
export const ADJUST_LIMITS = { shiftM: 1.5, angleDeg: 30, scaleMin: 0.5, scaleMax: 2 } as const;

export function applyAdjust(a: ZoneAdjust | undefined, p: FloorPosition): FloorPosition {
  if (!a) return p;
  const t = (a.angleDeg * Math.PI) / 180;
  const l = p.lateralM * Math.cos(t) - p.frontM * Math.sin(t);
  const f = p.lateralM * Math.sin(t) + p.frontM * Math.cos(t);
  return { lateralM: l + a.dxM, frontM: f * a.scale + a.dzM };
}

export function invertAdjust(a: ZoneAdjust | undefined, p: FloorPosition): FloorPosition {
  if (!a) return p;
  const l = p.lateralM - a.dxM;
  const f = (p.frontM - a.dzM) / a.scale;
  const t = (-a.angleDeg * Math.PI) / 180;
  return { lateralM: l * Math.cos(t) - f * Math.sin(t), frontM: l * Math.sin(t) + f * Math.cos(t) };
}

/**
 * Fit `dzM` (one point) or `scale` and `dzM` (two points at least 0.3 m apart) so that the measured
 * points come out at the distances the parent measured with a tape; the turn and sideways shift are kept.
 * `raw` = floor positions before any adjustment. Throws with the reason when the points cannot be used.
 */
export function fitAdjustToMeasurements(current: ZoneAdjust, screenWidthM: number, points: { raw: FloorPosition; trueM: number }[]): ZoneAdjust {
  if (points.length < 1 || points.length > 2) throw new Error(L("Use one or two measured points", "実測の点は1つか2つです"));
  const turned = points.map(({ raw, trueM }) => {
    const q = applyAdjust({ ...current, dzM: 0, scale: 1 }, raw);
    const excess = Math.max(0, Math.abs(q.lateralM) - screenWidthM / 2);
    if (trueM <= excess) throw new Error(L(`You stood ${excess.toFixed(2)} m to the side of the screen, so the distance cannot be ${trueM} m. Stand in front of the screen`, `立った位置が画面の横に ${excess.toFixed(2)}m 外れていて、${trueM}m にはなりません。画面の前に立ってください`));
    return { f: q.frontM, target: Math.sqrt(trueM * trueM - excess * excess) };
  });
  if (turned.length === 1) return { ...current, dzM: round2(turned[0].target - current.scale * turned[0].f) };
  const [a, b] = turned;
  if (Math.abs(b.f - a.f) < 0.3) throw new Error(L(`The two measured spots are too close (${Math.abs(b.f - a.f).toFixed(2)} m apart). Measure at two spots at least 0.5 m apart`, `2点の測った位置が近すぎます（差 ${Math.abs(b.f - a.f).toFixed(2)}m）。0.5m 以上離れた2か所で測ってください`));
  const scale = (b.target - a.target) / (b.f - a.f);
  if (!(scale >= ADJUST_LIMITS.scaleMin && scale <= ADJUST_LIMITS.scaleMax)) {
    throw new Error(L(`The scale from the two points (${scale.toFixed(2)}×) is too large. Calibrate again or check the distances you entered`, `2点から求めた伸び縮み ${scale.toFixed(2)} 倍は大きすぎます。キャリブレーションをやり直すか、入力した距離を確認してください`));
  }
  return { ...current, scale: round2(scale), dzM: round2(a.target - scale * a.f) };
}
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Floor position under image point (x, y) (normalized), on the horizontal plane `heightM` above the
 * floor (0 = the floor itself), with the parent's correction applied. Null when the ray does not reach
 * that plane in front of the camera.
 */
export function imageToFloor(pose: TvPose, x: number, y: number, heightM = 0): FloorPosition | null {
  const p = imageToFloorRaw(pose, x, y, heightM);
  return p ? applyAdjust(pose.adjust, p) : null;
}

/** Same as imageToFloor, before the parent's correction. */
export function imageToFloorRaw(pose: TvPose, x: number, y: number, heightM = 0): FloorPosition | null {
  const { focal: f, r, camera: C, screenWidthM: W, imageAspect, cameraHeightM: h } = pose;
  const d = [((x - 0.5) * imageAspect) / f, (y - 0.5) / f, 1];
  const along = (k: number) => r[k][0] * d[0] + r[k][1] * d[1] + r[k][2] * d[2];
  const up = along(1);
  const s = (heightM - h) / up;
  if (!(up < -1e-9) || !(s > 0) || !Number.isFinite(s)) return null; // ray does not go down to that plane
  return { lateralM: C.a + s * along(0) - W / 2, frontM: C.n + s * along(2) };
}

/** Distance from the screen (the segment it spans on the floor plan) to a floor position. */
export function screenDistance(screenWidthM: number, p: FloorPosition): number {
  return Math.hypot(Math.max(0, Math.abs(p.lateralM) - screenWidthM / 2), Math.max(0, p.frontM));
}

/** Floor position at `distanceM` from the screen, for t in [-1, 1] from the viewer's left end to the right end of the band. */
export function screenDistanceContour(screenWidthM: number, distanceM: number, t: number): FloorPosition {
  // Parameterized by arc length: left semicircle quarter, straight part, right quarter.
  const half = screenWidthM / 2;
  const arc = (Math.PI / 2) * distanceM;
  const total = 2 * arc + screenWidthM;
  let u = ((t + 1) / 2) * total;
  if (u < arc) {
    const th = Math.PI / 2 - u / distanceM; // 90° (beside the screen) → 0° (in front)
    return { lateralM: -half - distanceM * Math.sin(th), frontM: distanceM * Math.cos(th) };
  }
  u -= arc;
  if (u <= screenWidthM) return { lateralM: -half + u, frontM: distanceM };
  u -= screenWidthM;
  const th = u / distanceM;
  return { lateralM: half + distanceM * Math.sin(th), frontM: distanceM * Math.cos(th) };
}

const clampDistance = (z: number) => Math.max(0.2, Math.min(6, Number(z.toFixed(2))));

/** Distance of a foot contact point under either model. */
export function distanceForFoot(model: FloorModel, x: number, y: number): number | null {
  if (isHomography(model) && model.tvPose) {
    const p = imageToFloor(model.tvPose, x, y);
    return p ? clampDistance(screenDistance(model.tvPose.screenWidthM, p)) : null;
  }
  if (isHomography(model)) {
    const z = homographyDistance(model, x, y);
    return z === null || z <= 0 ? null : clampDistance(z);
  }
  return estimateDistanceFromFloorModel(y, model);
}

/**
 * d_edge for either model: the nearest distance still measurable on the visible floor bottom line.
 * For the homography this varies along the line; the smallest positive value is returned.
 */
export function edgeDistanceFor(model: FloorModel): number {
  if (!isHomography(model)) return computeEdgeDistance(model);
  const yb = model.floorBottomY ?? 1;
  let best = Infinity;
  for (let x = 0; x <= 1.0001; x += 0.05) {
    const z = distanceForFoot(model, x, yb);
    if (z !== null && z < best) best = z;
  }
  if (!Number.isFinite(best)) throw new Error("The visible floor bottom does not map to a distance in front of the TV");
  return Number(best.toFixed(2));
}

/**
 * Image y of the floor line at distance `distanceM` for a given image x (for drawing threshold
 * lines on the camera view). Null when that distance is not on the visible floor at this x.
 */
export function isoDistanceY(model: FloorModel, distanceM: number, x: number): number | null {
  if (isHomography(model)) {
    const [p1, p2, p3] = model.p;
    const [q1, q2] = model.q;
    const q3 = model.q3 ?? 1;
    const den = p2 - distanceM * q2;
    if (Math.abs(den) < 1e-9) return null;
    const y = (distanceM * (q1 * x + q3) - p1 * x - p3) / den;
    if (model.method === "tv_marker" && q1 * x + q2 * y + q3 <= 0) return null;
    return y >= 0 && y <= 1 ? y : null;
  }
  const y = (1 / distanceM - model.b) / model.a;
  return y >= 0 && y <= 1 ? y : null;
}
