/**
 * FireSense Kids — Watch zone: which part of the floor in front of the TV the camera covers.
 *
 * Deterministic, from the calibration only (no AI, no image upload). For TV-marker models the
 * full camera pose is known, so the zone (0.3 m to SAFE + 0.8 m from the screen: straight in front
 * of it, rounded beside it) is projected into the image: coverage, the TOO_CLOSE band in particular, which
 * way to turn the phone if part of it is missing, and the distance resolution at the TOO_CLOSE
 * line. Other models only know distance (not the lateral position), so they report whether the
 * TOO_CLOSE line is in view and the resolution.
 */

import { distanceForFoot, invertAdjust, isHomography, isoDistanceY, screenDistance, type FloorModel } from "./floor-calibration";
import type { Pt2 } from "./tv-marker";

export const ZONE_NEAR_M = 0.3;

/** Image point (normalized) of a floor point: `lateralM` from the screen center (viewer's right +), `distanceM` in front of the screen plane. */
export function projectFloorPoint(model: FloorModel, lateralM: number, distanceM: number): Pt2 | null {
  if (!isHomography(model) || !model.tvPose) return null;
  const { focal: f, r, camera: C, screenWidthM: W, imageAspect, cameraHeightM: h } = model.tvPose;
  ({ lateralM, frontM: distanceM } = invertAdjust(model.tvPose.adjust, { lateralM, frontM: distanceM }));
  // Offset from the lens in screen coordinates (a: along the screen, b: up, n: out of the screen).
  const d = [W / 2 + lateralM - C.a, -h, distanceM - C.n];
  const cam = [0, 1, 2].map((k) => r[0][k] * d[0] + r[1][k] * d[1] + r[2][k] * d[2]);
  if (cam[2] <= 1e-6) return null; // behind the camera
  return { x: (f * cam[0]) / cam[2] / imageAspect + 0.5, y: (f * cam[1]) / cam[2] + 0.5 };
}

export type TurnHint = "left" | "right" | "down" | "up" | "back";

export interface CoverageReport {
  /** Fraction (0..1) of the whole watch zone in view; null when the model has no lateral information. */
  zoneVisible: number | null;
  /** Fraction of the TOO_CLOSE band (0.3 m … TOO_CLOSE) in view. */
  tooCloseVisible: number;
  /** Distance change per pixel of foot position at the TOO_CLOSE line (cm/px, for `frameHeightPx`). */
  cmPerPixel: number | null;
  /** Where most of the missing TOO_CLOSE band lies, relative to the raw camera frame. */
  turn: TurnHint | null;
}

export interface CoverageOptions {
  tooCloseM: number;
  safeM: number;
  /** Visible floor bottom (normalized y). */
  floorBottomY?: number;
  /** Height of the analyzed frame in pixels, for the resolution figure. */
  frameHeightPx?: number;
}

const inView = (p: Pt2 | null, bottom: number) => p !== null && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= bottom;

export function computeCoverage(model: FloorModel, opts: CoverageOptions): CoverageReport {
  const bottom = opts.floorBottomY ?? 1;
  const fh = opts.frameHeightPx ?? 480;
  const far = opts.safeM + 0.8;

  if (isHomography(model) && model.tvPose) {
    const W = model.tvPose.screenWidthM;
    const half = W / 2 + far;
    let all = 0;
    let seen = 0;
    let near = 0;
    let nearSeen = 0;
    const votes: Record<TurnHint, number> = { left: 0, right: 0, down: 0, up: 0, back: 0 };
    const N = 32;
    for (let i = 0; i <= N; i++)
      for (let j = 0; j <= N; j++) {
        const lat = -half + (2 * half * i) / N;
        const front = (far * j) / N;
        const dist = screenDistance(W, { lateralM: lat, frontM: front });
        if (dist < ZONE_NEAR_M || dist > far) continue;
        const p = projectFloorPoint(model, lat, front);
        const ok = inView(p, bottom);
        all++;
        if (ok) seen++;
        if (dist <= opts.tooCloseM) {
          near++;
          if (ok) nearSeen++;
          else if (!p) votes.back++;
          else if (p.x < 0) votes.left++;
          else if (p.x > 1) votes.right++;
          else if (p.y > bottom) votes.down++;
          else votes.up++;
        }
      }
    const missing = near - nearSeen;
    const turn = missing > 0 ? (Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0] as TurnHint) : null;
    const a = projectFloorPoint(model, 0, opts.tooCloseM);
    const b = projectFloorPoint(model, 0, opts.tooCloseM + 0.05);
    const px = a && b ? Math.hypot((a.x - b.x) * model.tvPose.imageAspect, a.y - b.y) * fh : 0;
    return {
      zoneVisible: seen / all,
      tooCloseVisible: near ? nearSeen / near : 0,
      cmPerPixel: px > 0 ? Number((5 / px).toFixed(2)) : null,
      turn,
    };
  }

  // Distance-only models: is the TOO_CLOSE line on the visible floor, and how sharp is it?
  let cols = 0;
  let hit = 0;
  let yMid: number | null = null;
  for (let x = 0; x <= 1.0001; x += 0.05) {
    cols++;
    const y = isoDistanceY(model, opts.tooCloseM, x);
    if (y !== null && y <= bottom) {
      hit++;
      if (Math.abs(x - 0.5) < 0.03) yMid = y;
    }
  }
  let cmPerPixel: number | null = null;
  if (yMid !== null) {
    // 10 px step (distanceForFoot rounds to cm).
    const d1 = distanceForFoot(model, 0.5, yMid);
    const d2 = distanceForFoot(model, 0.5, Math.min(bottom, yMid + 10 / fh));
    if (d1 !== null && d2 !== null && d1 !== d2) cmPerPixel = Number(((Math.abs(d1 - d2) * 100) / 10).toFixed(2));
  }
  return { zoneVisible: null, tooCloseVisible: hit / cols, cmPerPixel, turn: hit < cols ? "down" : null };
}
