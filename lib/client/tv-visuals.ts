/**
 * FireSense Kids — TV Visual Filter Mapping (U2 §3).
 *
 * Converts protocol blurPx (0..24) into CSS filter & transform styles.
 *
 * Requirements:
 * - blur: blur(blurPx * 2) in full mode; in downscale mode (where canvas is scale(8)), blur is / 8.
 * - brightness: progressively dims from 1.0 down to 0.6 as blurPx increases to MAX_BLUR_PX.
 * - saturate: progressively desaturates from 1.0 down to 0.6 as blurPx increases to MAX_BLUR_PX.
 * - 0px: filter is "none", transform is "none" (or scale(8) in downscale).
 */

import { MAX_BLUR_PX } from "../firesense/protocol";
import type { BlurMode } from "./tv-bench";

export interface TvVisualStyles {
  filter: string;
  transform: string;
  brightness: number;
  saturate: number;
  effectiveBlurPx: number;
}

export function computeTvVisualStyles(blurPx: number, mode: BlurMode): TvVisualStyles {
  if (blurPx <= 0) {
    return {
      filter: "none",
      transform: mode === "downscale" ? "scale(8)" : "none",
      brightness: 1,
      saturate: 1,
      effectiveBlurPx: 0,
    };
  }

  const ratio = Math.min(1, Math.max(0, blurPx / MAX_BLUR_PX));
  const brightness = Math.round((1.0 - 0.4 * ratio) * 100) / 100;
  const saturate = Math.round((1.0 - 0.4 * ratio) * 100) / 100;

  if (mode === "downscale") {
    // In downscale mode: scale(8) expands the canvas 8x, so CSS blur is divided by 8
    const effectiveBlurPx = (blurPx * 2) / 8;
    return {
      filter: `blur(${effectiveBlurPx}px) brightness(${brightness}) saturate(${saturate})`,
      transform: "scale(8)",
      brightness,
      saturate,
      effectiveBlurPx,
    };
  }

  const effectiveBlurPx = blurPx * 2;
  return {
    filter: `blur(${effectiveBlurPx}px) brightness(${brightness}) saturate(${saturate})`,
    transform: "scale(1.05)",
    brightness,
    saturate,
    effectiveBlurPx,
  };
}
