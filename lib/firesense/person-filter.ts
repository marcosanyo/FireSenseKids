/**
 * FireSense Kids — Rejecting pose "people" that are not people.
 *
 * In a cluttered living room the pose model sometimes fits a skeleton to a chair, a toy or a pile
 * of clothes. Such a false person near the phone must not become "the nearest viewer". Two
 * deterministic checks, both on the camera phone:
 *
 *   1. Plausibility (one frame): a real torso is visible (at least three of the two shoulders and
 *      two hips with high visibility), it is not tiny, and the shoulders are not absurdly wide for
 *      the torso. Thighs, when visible, are in proportion to the torso.
 *   2. Persistence (over frames): a person counts only after being seen in `minHits` consecutive
 *      inference frames at about the same place. One-frame ghosts are dropped; the cost is one
 *      inference interval of latency for someone who just walked in.
 */

import type { LandmarkPoint } from "./floor-calibration";

const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_HIP = 23;
const R_HIP = 24;
const L_KNEE = 25;
const R_KNEE = 26;

export interface PersonFilterConfig {
  /** Landmark visibility that counts as "seen". Default 0.6. */
  minVisibility?: number;
  /** Minimum torso length (mid-shoulder to mid-hip) as a fraction of the frame height. Default 0.04. */
  minTorsoFraction?: number;
  /** Consecutive frames a person must be seen before it counts. Default 2. */
  minHits?: number;
  /** A track not seen for this long is dropped (ms). Default 1500. */
  maxGapMs?: number;
  /** Largest torso-center movement between frames to stay the same track (fraction of the frame). Default 0.2. */
  maxMove?: number;
}

export type RejectReason = "no_torso" | "too_small" | "proportions" | "not_yet_confirmed";

export interface PersonVerdict {
  accepted: boolean;
  reason?: RejectReason;
  /** Stable id of the track this person belongs to (set when accepted). */
  trackId?: number;
}

const visible = (lm: LandmarkPoint | undefined, min: number) => Boolean(lm) && (lm!.visibility ?? 1) >= min;
const mid = (a: LandmarkPoint, b: LandmarkPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Single-frame plausibility. `aspect` = frame width / height (landmarks are normalized per axis). */
export function plausiblePerson(lms: LandmarkPoint[], aspect: number, config: PersonFilterConfig = {}): PersonVerdict {
  const minVis = config.minVisibility ?? 0.6;
  const minTorso = config.minTorsoFraction ?? DEFAULT_MIN_TORSO_FRACTION;
  if (!lms || lms.length < 33) return { accepted: false, reason: "no_torso" };
  const seen = [L_SHOULDER, R_SHOULDER, L_HIP, R_HIP].filter((i) => visible(lms[i], minVis)).length;
  if (seen < 3) return { accepted: false, reason: "no_torso" };

  const px = (p: { x: number; y: number }) => ({ x: p.x * aspect, y: p.y }); // equal units (frame heights)
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(px(a).x - px(b).x, a.y - b.y);
  const shoulders = mid(lms[L_SHOULDER], lms[R_SHOULDER]);
  const hips = mid(lms[L_HIP], lms[R_HIP]);
  const torso = dist(shoulders, hips);
  if (torso < minTorso) return { accepted: false, reason: "too_small" };
  // Facing the camera the shoulders are ~0.8× the torso length; side-on they shrink toward 0.
  if (dist(lms[L_SHOULDER], lms[R_SHOULDER]) > 1.8 * torso) return { accepted: false, reason: "proportions" };
  for (const [hip, knee] of [
    [L_HIP, L_KNEE],
    [R_HIP, R_KNEE],
  ]) {
    if (visible(lms[hip], minVis) && visible(lms[knee], minVis)) {
      const thigh = dist(lms[hip], lms[knee]);
      // Foreshortening can shorten a thigh a lot (sitting, facing the camera), never lengthen it.
      if (thigh > 2 * torso) return { accepted: false, reason: "proportions" };
    }
  }
  return { accepted: true };
}

interface Track {
  id: number;
  x: number;
  y: number;
  hits: number;
  lastMs: number;
}

/** Plausibility + persistence over frames. Call `update` once per inference frame with all people. */
/** MediaPipe's default, and what RTMO may go below (see RTMO_MIN_TORSO_FRACTION). */
export const DEFAULT_MIN_TORSO_FRACTION = 0.04;

export class PersonFilter {
  private config: PersonFilterConfig;
  private readonly minHits: number;
  private readonly maxGapMs: number;
  private readonly maxMove: number;
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(config: PersonFilterConfig = {}) {
    this.config = config;
    this.minHits = config.minHits ?? 2;
    this.maxGapMs = config.maxGapMs ?? 1500;
    this.maxMove = config.maxMove ?? 0.2;
  }

  public reset(): void {
    this.tracks = [];
  }

  /** The smallest torso (share of the frame height) that still counts as a person; applies from the next frame. */
  public setMinTorsoFraction(fraction: number): void {
    this.config = { ...this.config, minTorsoFraction: fraction };
  }

  public update(people: LandmarkPoint[][], aspect: number, nowMs: number): PersonVerdict[] {
    this.tracks = this.tracks.filter((t) => nowMs - t.lastMs <= this.maxGapMs);
    const verdicts: PersonVerdict[] = people.map((lms) => plausiblePerson(lms, aspect, this.config));
    const centers = people.map((lms, i) => {
      if (!verdicts[i].accepted) return null;
      const pts = [L_SHOULDER, R_SHOULDER, L_HIP, R_HIP].map((k) => lms[k]);
      return { x: pts.reduce((s, p) => s + p.x, 0) / 4, y: pts.reduce((s, p) => s + p.y, 0) / 4 };
    });
    // Greedy nearest matching (few people per frame).
    const used = new Set<Track>();
    const next: Track[] = [];
    centers.forEach((c, i) => {
      if (!c) return;
      let best: Track | null = null;
      let bestD = this.maxMove;
      for (const t of this.tracks) {
        if (used.has(t)) continue;
        const d = Math.hypot((t.x - c.x) * aspect, t.y - c.y);
        if (d <= bestD) {
          bestD = d;
          best = t;
        }
      }
      const track: Track = best
        ? { id: best.id, x: c.x, y: c.y, hits: best.hits + 1, lastMs: nowMs }
        : { id: this.nextId++, x: c.x, y: c.y, hits: 1, lastMs: nowMs };
      if (best) used.add(best);
      next.push(track);
      verdicts[i] = track.hits < this.minHits ? { accepted: false, reason: "not_yet_confirmed" } : { accepted: true, trackId: track.id };
    });
    // Keep unmatched tracks for a short gap (a missed detection does not reset a confirmed person).
    this.tracks = [...next, ...this.tracks.filter((t) => !used.has(t))];
    return verdicts;
  }
}
