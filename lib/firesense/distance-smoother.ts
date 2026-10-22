/**
 * FireSense Kids — Distance smoothing (camera phone).
 *
 * Pose landmarks jitter from frame to frame; one bad frame used to flip TOO_CLOSE ↔ APPROACHING (the
 * "move back" card and the "nice step" line came and went). Field logs (2026-09-26) showed per-frame
 * distances swinging by ±0.5 m, the source switching between feet and the hip estimate, and single
 * frames without any distance. So:
 *
 *   - The distance is the median of the same person's measurements in the last `windowMs` (at most
 *     `maxSamples`), feet and hip estimates together: a person's history is not thrown away because
 *     one frame came from the other method.
 *   - The history starts over only when the person changes (another track) or after a gap.
 *   - A frame without a distance may reuse the last smoothed distance of the same person for up to
 *     `holdMs` (`hold`), so one lost frame does not drop the state to LOW_CONFIDENCE and back.
 */

export type DistanceSource = "feet" | "hips" | "seated";

export interface DistanceSmootherConfig {
  /** Default 1500 ms. 0 = no smoothing and no hold. */
  windowMs?: number;
  /** Default 9. */
  maxSamples?: number;
  /** How long a frame without a distance may reuse the last one. Default 1000 ms. */
  holdMs?: number;
}

export interface SmoothedDistance {
  distanceM: number;
  source: DistanceSource;
  confidence: number;
}

export class DistanceSmoother {
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly holdMs: number;
  private samples: { d: number; atMs: number }[] = [];
  private key: string | null = null;
  private last: (SmoothedDistance & { atMs: number }) | null = null;

  constructor(config: DistanceSmootherConfig = {}) {
    this.windowMs = config.windowMs ?? 1500;
    this.maxSamples = config.maxSamples ?? 9;
    this.holdMs = config.holdMs ?? 1000;
  }

  public reset(): void {
    this.samples = [];
    this.key = null;
    this.last = null;
  }

  /** @param key the person (track) the distance belongs to. */
  public update(distanceM: number, source: DistanceSource, confidence: number, key: string, nowMs: number): SmoothedDistance {
    if (this.windowMs <= 0) {
      this.last = { distanceM, source, confidence, atMs: nowMs };
      return { distanceM, source, confidence };
    }
    if (key !== this.key) {
      this.samples = [];
      this.key = key;
    }
    this.samples = this.samples.filter((s) => nowMs - s.atMs <= this.windowMs);
    this.samples.push({ d: distanceM, atMs: nowMs });
    if (this.samples.length > this.maxSamples) this.samples.shift();
    const sorted = this.samples.map((s) => s.d).sort((a, b) => a - b);
    const m = sorted.length;
    const median = Number((m % 2 ? sorted[(m - 1) / 2] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2).toFixed(2));
    this.last = { distanceM: median, source, confidence, atMs: nowMs };
    return { distanceM: median, source, confidence };
  }

  /** The last smoothed distance of `key`, if it is recent enough to stand in for a lost frame. */
  public hold(key: string | null, nowMs: number): SmoothedDistance | null {
    if (this.windowMs <= 0 || !this.last || key === null || key !== this.key || nowMs - this.last.atMs > this.holdMs) return null;
    return { distanceM: this.last.distanceM, source: this.last.source, confidence: this.last.confidence };
  }
}
