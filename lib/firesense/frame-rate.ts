/**
 * FireSense Kids — Adaptive inference frame rate.
 *
 * Idle 2fps keeps the phone cool; 8fps while something is happening so a running
 * child (≈2 m/s) is tracked through the bottom edge and BELOW_FRAME can fire.
 *
 * Fast when any of:
 *   - distance < 2.0m
 *   - |Δd| between consecutive measurements > 0.15m
 *   - state is not SAFE
 * Back to idle after 3s of stable SAFE with none of the above.
 * Paused (0fps) while the TV reports viewing_state { playing: false }.
 */

import type { ViewingState } from "./protocol";

export interface FrameRateConfig {
  idleFps?: number;
  activeFps?: number;
  nearDistanceM?: number;
  deltaDistanceM?: number;
  settleMs?: number;
}

export class AdaptiveFrameRate {
  readonly idleFps: number;
  readonly activeFps: number;
  private nearDistanceM: number;
  private readonly deltaDistanceM: number;
  private readonly settleMs: number;

  private fps: number;
  private paused = false;
  private lastDistance: number | null = null;
  private calmSinceMs: number | null = null;

  constructor(config: FrameRateConfig = {}) {
    this.idleFps = config.idleFps ?? 2;
    this.activeFps = config.activeFps ?? 8;
    this.nearDistanceM = config.nearDistanceM ?? 2.0;
    this.deltaDistanceM = config.deltaDistanceM ?? 0.15;
    this.settleMs = config.settleMs ?? 3000;
    this.fps = this.idleFps;
  }

  /** Distance below which inference runs at the active rate (follows the SAFE threshold). */
  public setNearDistance(m: number): void {
    this.nearDistanceM = m;
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.lastDistance = null;
      this.calmSinceMs = null;
      this.fps = this.idleFps;
    }
  }

  public isPaused(): boolean {
    return this.paused;
  }

  /** Current target fps (0 when paused). */
  public current(): number {
    return this.paused ? 0 : this.fps;
  }

  public intervalMs(): number {
    const fps = this.current();
    return fps > 0 ? Math.round(1000 / fps) : Infinity;
  }

  public update(state: ViewingState, distanceM: number | null, nowMs: number): number {
    if (this.paused) return 0;

    const jumped =
      distanceM !== null && this.lastDistance !== null && Math.abs(distanceM - this.lastDistance) > this.deltaDistanceM;
    const near = distanceM !== null && distanceM < this.nearDistanceM;
    if (distanceM !== null) this.lastDistance = distanceM;

    if (state !== "SAFE" || near || jumped) {
      this.fps = this.activeFps;
      this.calmSinceMs = null;
    } else if (this.fps !== this.idleFps) {
      if (this.calmSinceMs === null) this.calmSinceMs = nowMs;
      if (nowMs - this.calmSinceMs >= this.settleMs) {
        this.fps = this.idleFps;
        this.calmSinceMs = null;
      }
    }
    return this.fps;
  }
}
