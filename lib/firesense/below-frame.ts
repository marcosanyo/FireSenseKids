/**
 * FireSense Kids — BELOW_FRAME detection (feet left the bottom edge of the frame).
 *
 * A phone on the TV stand cannot see the feet of a child closer than d_edge.
 * Instead of guessing a distance, this tracker classifies each frame
 * deterministically:
 *
 *   VISIBLE      feet visible → floor-model distance is valid
 *   BELOW_FRAME  feet were last seen near the bottom edge (y > edgeY), are now
 *                invisible, and the torso is still visible → child is too close
 *   OCCLUDED     person present but feet hidden for another reason (behind a
 *                table, feet were mid-frame when lost) → LOW_CONFIDENCE
 *   NO_PERSON    nobody detected (e.g. walked out sideways)
 *
 * BELOW_FRAME latches: it stays set until the feet are seen again, or until no
 * person has been detected for `clearAfterNoPersonMs` (default 30s).
 *
 * Distance gate (`maxExitDistanceM`): the exit must also happen near the TV. The pipeline sets it
 * to TOO_CLOSE for any-placement (homography) models only: with the phone at the side of the room
 * looking diagonally, the bottom edge is the floor in front of the phone, and a child walking
 * toward the phone must not be treated as "at the TV". With the phone in front of the TV (y-only
 * model) the bottom edge is always toward the TV, so there is no gate.
 */

import type { BodyObservation } from "./floor-calibration";

/** ESTIMATED is never produced by the tracker: the pipeline sets it when feet are OCCLUDED but the
 *  floor point under the hips could be estimated (hip-ground.ts, TV-marker models only). */
export type FootStatus = "VISIBLE" | "ESTIMATED" | "BELOW_FRAME" | "OCCLUDED" | "NO_PERSON";

export interface BelowFrameConfig {
  /** Feet lower than this (normalized y) count as "at the bottom edge". Default 0.9. */
  edgeY?: number;
  /** How recent the last foot sighting must be to trigger BELOW_FRAME. Default 1000ms. */
  lastSeenWindowMs?: number;
  /** Latch release when no person is detected for this long. Default 30000ms. */
  clearAfterNoPersonMs?: number;
  /** BELOW_FRAME also requires the last measured distance to be below this (m). Unset = no gate. */
  maxExitDistanceM?: number;
}

export interface FootClassification {
  status: FootStatus;
  groundY: number | null;
  latched: boolean;
}

export class BelowFrameTracker {
  private readonly edgeY: number;
  private readonly lastSeenWindowMs: number;
  private readonly clearAfterNoPersonMs: number;
  private maxExitDistanceM: number | undefined;

  private lastFoot: { y: number; atMs: number; distanceM: number | null } | null = null;
  private latched = false;
  private noPersonSinceMs: number | null = null;

  constructor(config: BelowFrameConfig = {}) {
    this.edgeY = config.edgeY ?? 0.9;
    this.lastSeenWindowMs = config.lastSeenWindowMs ?? 1000;
    this.clearAfterNoPersonMs = config.clearAfterNoPersonMs ?? 30000;
    this.maxExitDistanceM = config.maxExitDistanceM;
  }

  public setMaxExitDistance(m: number | undefined): void {
    this.maxExitDistanceM = m;
  }

  public isLatched(): boolean {
    return this.latched;
  }

  public reset(): void {
    this.lastFoot = null;
    this.latched = false;
    this.noPersonSinceMs = null;
  }

  /** @param distanceM floor-model distance of the visible feet (for the distance gate), if known */
  public update(obs: BodyObservation, nowMs: number, distanceM: number | null = null): FootClassification {
    // 1. Feet visible: always authoritative, releases the latch.
    if (obs.personDetected && obs.groundY !== null) {
      this.lastFoot = { y: obs.groundY, atMs: nowMs, distanceM };
      this.latched = false;
      this.noPersonSinceMs = null;
      return { status: "VISIBLE", groundY: obs.groundY, latched: false };
    }

    // 2. Nobody detected.
    if (!obs.personDetected) {
      if (this.noPersonSinceMs === null) this.noPersonSinceMs = nowMs;
      if (this.latched && nowMs - this.noPersonSinceMs >= this.clearAfterNoPersonMs) {
        this.latched = false;
        this.lastFoot = null;
      }
      return this.latched
        ? { status: "BELOW_FRAME", groundY: null, latched: true }
        : { status: "NO_PERSON", groundY: null, latched: false };
    }

    // 3. Person present, feet not visible.
    this.noPersonSinceMs = null;
    if (this.latched) {
      return { status: "BELOW_FRAME", groundY: null, latched: true };
    }

    const feetWereAtBottomEdge =
      this.lastFoot !== null &&
      nowMs - this.lastFoot.atMs <= this.lastSeenWindowMs &&
      this.lastFoot.y > this.edgeY;
    const nearTheTv =
      this.maxExitDistanceM === undefined ||
      (this.lastFoot?.distanceM !== null && this.lastFoot?.distanceM !== undefined && this.lastFoot.distanceM < this.maxExitDistanceM);

    if (feetWereAtBottomEdge && nearTheTv && obs.torsoVisible) {
      this.latched = true;
      return { status: "BELOW_FRAME", groundY: null, latched: true };
    }

    return { status: "OCCLUDED", groundY: null, latched: false };
  }
}
