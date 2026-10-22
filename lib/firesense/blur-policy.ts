/**
 * FireSense Kids — Distance-proportional blur (single source of truth).
 *
 * Two clearly different levels, so the red line can be seen on the TV:
 * - farther than SAFE (green line): 0px
 * - between the lines (APPROACHING): a light hint, 0 → APPROACH_MAX_PX
 * - closer than TOO_CLOSE (red line, TOO_CLOSE state): a strong blur, TOO_CLOSE_MIN_PX → MAX_BLUR_PX
 *   (MAX at 0.3m inside the red line)
 *
 * The phone computes blurPx and sends it; the TV renders it as-is.
 */

import { MAX_BLUR_PX } from "./protocol";

/** Strongest blur between the lines (CSS ≈ 8px: noticeable, the picture still watchable). */
export const APPROACH_MAX_PX = 4;
/** Blur at the red line: a visible jump from APPROACH_MAX_PX. */
export const TOO_CLOSE_MIN_PX = 16;
/** Full blur this far inside the red line. */
export const FULL_BLUR_INSIDE_M = 0.3;

export const BLUR_CONFIG = {
  CLEAR_DISTANCE_METERS: 1.65,
  TOO_CLOSE_DISTANCE_METERS: 0.8,
  MAX_BLUR_PX,
} as const;

export interface BlurRamp {
  /** 0px at or beyond this distance (the SAFE threshold, green line). */
  clearAtM: number;
  /** The TOO_CLOSE threshold (red line): the strong blur starts here. */
  warnAtM: number;
  /** MAX_BLUR_PX at or within this distance. */
  fullAtM: number;
}

/** Ramp from the user thresholds. */
export function blurRampForThresholds(tooCloseM: number, safeM: number): BlurRamp {
  return { clearAtM: safeM, warnAtM: tooCloseM, fullAtM: Math.max(0.2, tooCloseM - FULL_BLUR_INSIDE_M) };
}

export const DEFAULT_BLUR_RAMP: BlurRamp = blurRampForThresholds(BLUR_CONFIG.TOO_CLOSE_DISTANCE_METERS, BLUR_CONFIG.CLEAR_DISTANCE_METERS);

/** Between the lines (APPROACHING): 0 at the green line, APPROACH_MAX_PX at the red line and closer. */
export function approachBlurPx(distanceMeters: number, ramp: BlurRamp = DEFAULT_BLUR_RAMP): number {
  if (distanceMeters >= ramp.clearAtM) return 0;
  const progress = Math.min(1, (ramp.clearAtM - distanceMeters) / (ramp.clearAtM - ramp.warnAtM));
  return Math.max(1, Math.round(progress * APPROACH_MAX_PX));
}

/** Past the red line (TOO_CLOSE): at least TOO_CLOSE_MIN_PX, MAX_BLUR_PX from `fullAtM` in. */
export function tooCloseBlurPx(distanceMeters: number, ramp: BlurRamp = DEFAULT_BLUR_RAMP): number {
  if (distanceMeters <= ramp.fullAtM) return MAX_BLUR_PX;
  const progress = Math.max(0, (ramp.warnAtM - distanceMeters) / (ramp.warnAtM - ramp.fullAtM));
  return Math.round(TOO_CLOSE_MIN_PX + progress * (MAX_BLUR_PX - TOO_CLOSE_MIN_PX));
}

/** Blur by distance alone (the state machine uses the two functions above by state, with its dwell times). */
export function blurPxForDistance(distanceMeters: number, ramp: BlurRamp = DEFAULT_BLUR_RAMP): number {
  return distanceMeters < ramp.warnAtM ? tooCloseBlurPx(distanceMeters, ramp) : approachBlurPx(distanceMeters, ramp);
}
