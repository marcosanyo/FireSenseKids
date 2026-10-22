/**
 * FireSense Kids — Viewing state machine (the only one; runs on the camera phone).
 *
 * Deterministic. The LLM never takes part in safety decisions.
 *
 * States (protocol v1):
 *   SAFE            d >= 1.65m
 *   APPROACHING     1.30m(1.35m on exit) <= d < 1.65m — mild proportional blur, corner hint
 *   TOO_CLOSE       d < 1.30m — proportional blur + center card
 *   BELOW_FRAME     feet left the bottom edge — max blur, latched (see below-frame.ts)
 *   LOW_CONFIDENCE  person lost / occluded — hold last blur up to 5s, then clear
 *
 * Two-phase recovery:
 *   Phase 1  TOO_CLOSE/BELOW_FRAME → APPROACHING: card dismissed, PHASE1_RECOVERY event
 *   Phase 2  SAFE held for 2s after a warned episode: STAR_AWARDED (15s cooldown)
 *
 * Debounce (optional, set by the pipeline): TOO_CLOSE is entered only after the distance has stayed
 * under the threshold for `enterDwellMs`, and left only after it has stayed at or beyond the exit
 * distance for `exitDwellMs`; SAFE is left only below SAFE − `safeHysteresisMeters`. One jittery
 * frame no longer shows the card, and the "nice step" line is not said for a step that did not happen.
 *
 * Posture is ambient only: POSTURE_NUDGE after 4s of bad posture (30s cooldown),
 * never changes blur. Allowed in SAFE, and in LOW_CONFIDENCE when the last trusted state was SAFE
 * (feet hidden while sitting); never while too close.
 */

import { approachBlurPx, blurRampForThresholds, tooCloseBlurPx, type BlurRamp } from "./blur-policy";
import type { FootStatus } from "./below-frame";
import { MAX_BLUR_PX, type PostureType, type TelemetryEvent, type ViewingState } from "./protocol";

export interface StateMachineConfig {
  tooCloseThresholdMeters?: number;
  tooCloseExitHysteresisMeters?: number;
  safeRecoveryThresholdMeters?: number;
  minDwellMs?: number;
  starCooldownMs?: number;
  enterTrustedThreshold?: number;
  exitTrustedThreshold?: number;
  lowConfidenceHoldMs?: number;
  postureNudgeAfterMs?: number;
  postureNudgeCooldownMs?: number;
  /** Time the distance must stay below TOO_CLOSE before entering it (default 0). */
  enterDwellMs?: number;
  /** Time the distance must stay at/after the exit distance before leaving TOO_CLOSE (default 0). */
  exitDwellMs?: number;
  /** SAFE is left only below SAFE minus this (default 0). */
  safeHysteresisMeters?: number;
}

export interface FrameInput {
  footStatus: FootStatus;
  /** Floor-model distance; required when footStatus is VISIBLE or ESTIMATED, ignored otherwise. */
  distanceM: number | null;
  /** Detection confidence 0..1 (foot confidence when VISIBLE). */
  confidence: number;
  posture: PostureType;
}

export interface FrameOutput {
  state: ViewingState;
  distanceM: number | null;
  blurPx: number;
  confidence: number;
  posture: PostureType;
  event?: TelemetryEvent;
}

const WARN_STATES: ReadonlySet<ViewingState> = new Set(["TOO_CLOSE", "BELOW_FRAME"]);

export class ViewingStateMachine {
  tooCloseThreshold: number;
  tooCloseExit: number;
  safeRecoveryThreshold: number;
  private readonly hysteresisM: number;
  private ramp: BlurRamp;
  readonly minDwellMs: number;
  readonly starCooldownMs: number;
  readonly enterTrusted: number;
  readonly exitTrusted: number;
  readonly lowConfidenceHoldMs: number;
  readonly postureNudgeAfterMs: number;
  readonly postureNudgeCooldownMs: number;
  readonly enterDwellMs: number;
  readonly exitDwellMs: number;
  readonly safeHysteresisM: number;
  private enterSinceMs: number | null = null;
  private exitSinceMs: number | null = null;

  /** Last trusted (non-LOW_CONFIDENCE) state. */
  private phase: ViewingState = "SAFE";
  private trusted = true;
  private lastBlurPx = 0;
  private lowConfidenceSinceMs: number | null = null;
  /** An episode that reached TOO_CLOSE/BELOW_FRAME and has not yet been rewarded. */
  private warnedEpisode = false;
  private safeSinceMs: number | null = null;
  private lastStarMs = -Infinity;
  private badPostureSinceMs: number | null = null;
  private lastPostureNudgeMs = -Infinity;

  constructor(config: StateMachineConfig = {}) {
    this.tooCloseThreshold = config.tooCloseThresholdMeters ?? 1.3;
    this.hysteresisM = config.tooCloseExitHysteresisMeters ?? 0.05;
    this.tooCloseExit = this.tooCloseThreshold + this.hysteresisM;
    this.safeRecoveryThreshold = config.safeRecoveryThresholdMeters ?? 1.65;
    this.ramp = blurRampForThresholds(this.tooCloseThreshold, this.safeRecoveryThreshold);
    this.minDwellMs = config.minDwellMs ?? 2000;
    this.starCooldownMs = config.starCooldownMs ?? 15000;
    this.enterTrusted = config.enterTrustedThreshold ?? 0.6;
    this.exitTrusted = config.exitTrustedThreshold ?? 0.45;
    this.lowConfidenceHoldMs = config.lowConfidenceHoldMs ?? 5000;
    this.postureNudgeAfterMs = config.postureNudgeAfterMs ?? 4000;
    this.postureNudgeCooldownMs = config.postureNudgeCooldownMs ?? 30000;
    this.enterDwellMs = config.enterDwellMs ?? 0;
    this.exitDwellMs = config.exitDwellMs ?? 0;
    this.safeHysteresisM = config.safeHysteresisMeters ?? 0;
  }

  /**
   * Changes the distance thresholds at runtime (user sliders). The blur ramp follows:
   * light blur between the lines, strong past TOO_CLOSE (blur-policy.ts). SAFE must be ≥ TOO_CLOSE + 0.1m.
   */
  public setThresholds(tooCloseM: number, safeM: number): void {
    // 1e-6: slider values like 1.2 + 0.1 are not exact in floating point.
    if (!(tooCloseM > 0) || !(safeM >= tooCloseM + 0.1 - 1e-6)) {
      throw new Error(`Invalid thresholds: TOO_CLOSE ${tooCloseM}m, SAFE ${safeM}m (SAFE must be ≥ TOO_CLOSE + 0.1m)`);
    }
    this.tooCloseThreshold = tooCloseM;
    this.tooCloseExit = tooCloseM + this.hysteresisM;
    this.safeRecoveryThreshold = safeM;
    this.ramp = blurRampForThresholds(tooCloseM, safeM);
  }

  public getPhase(): ViewingState {
    return this.phase;
  }

  public reset(): void {
    this.phase = "SAFE";
    this.trusted = true;
    this.lastBlurPx = 0;
    this.lowConfidenceSinceMs = null;
    this.warnedEpisode = false;
    this.safeSinceMs = null;
    this.badPostureSinceMs = null;
    this.enterSinceMs = null;
    this.exitSinceMs = null;
  }

  public update(input: FrameInput, nowMs: number): FrameOutput {
    const out = this.updateDistance(input, nowMs);
    // Seated children often hide their feet (cross-legged, hunched): the distance is then unknown
    // (LOW_CONFIDENCE), but if the last trusted state was SAFE the posture nudge still applies.
    const safeEnough = out.state === "SAFE" || (out.state === "LOW_CONFIDENCE" && this.phase === "SAFE");
    if (!out.event && safeEnough) {
      const nudge = this.updatePosture(input.posture, nowMs);
      if (nudge) out.event = nudge;
    } else if (!safeEnough) {
      this.badPostureSinceMs = null;
    }
    return out;
  }

  private updateDistance(input: FrameInput, nowMs: number): FrameOutput {
    const base = { confidence: input.confidence, posture: input.posture };

    // BELOW_FRAME: deterministic max blur (latched upstream).
    if (input.footStatus === "BELOW_FRAME") {
      const event = WARN_STATES.has(this.phase) ? undefined : "WARN";
      this.enterWarnState("BELOW_FRAME", MAX_BLUR_PX);
      return { ...base, state: "BELOW_FRAME", distanceM: null, blurPx: MAX_BLUR_PX, event };
    }

    // Confidence hysteresis on measurable frames (feet seen, or the floor point estimated from the hips).
    const hasDistance = input.footStatus === "VISIBLE" || input.footStatus === "ESTIMATED";
    if (hasDistance) {
      if (this.trusted && input.confidence < this.exitTrusted) this.trusted = false;
      else if (!this.trusted && input.confidence >= this.enterTrusted) this.trusted = true;
    }

    const measurable = hasDistance && this.trusted && input.distanceM !== null;
    if (!measurable) {
      return { ...base, ...this.lowConfidence(nowMs) };
    }

    this.lowConfidenceSinceMs = null;
    const d = input.distanceM as number;
    const previous = this.phase;

    // TOO_CLOSE (hysteresis on exit, and dwell times on entry and exit).
    let tooClose: boolean;
    if (WARN_STATES.has(previous)) {
      this.enterSinceMs = null;
      if (d < this.tooCloseExit) this.exitSinceMs = null;
      else this.exitSinceMs ??= nowMs;
      tooClose = this.exitSinceMs === null || nowMs - this.exitSinceMs < this.exitDwellMs;
      if (!tooClose) this.exitSinceMs = null;
    } else {
      this.exitSinceMs = null;
      if (d < this.tooCloseThreshold) this.enterSinceMs ??= nowMs;
      else this.enterSinceMs = null;
      tooClose = this.enterSinceMs !== null && nowMs - this.enterSinceMs >= this.enterDwellMs;
      if (tooClose) this.enterSinceMs = null;
    }
    if (tooClose) {
      const event = WARN_STATES.has(previous) ? undefined : "WARN";
      const blurPx = tooCloseBlurPx(d, this.ramp);
      this.enterWarnState("TOO_CLOSE", blurPx);
      return { ...base, state: "TOO_CLOSE", distanceM: d, blurPx, event };
    }

    // Phase 1: partial recovery / approaching (SAFE is left only below SAFE − hysteresis).
    const safeLine = previous === "SAFE" ? this.safeRecoveryThreshold - this.safeHysteresisM : this.safeRecoveryThreshold;
    if (d < safeLine) {
      this.safeSinceMs = null;
      this.phase = "APPROACHING";
      const blurPx = approachBlurPx(d, this.ramp);
      this.lastBlurPx = blurPx;
      const event = WARN_STATES.has(previous) ? "PHASE1_RECOVERY" : undefined;
      return { ...base, state: "APPROACHING", distanceM: d, blurPx, event };
    }

    // Phase 2: safe. Stars need a warned episode + dwell + cooldown.
    const wasWarned = WARN_STATES.has(previous);
    this.phase = "SAFE";
    this.lastBlurPx = 0;
    let event: TelemetryEvent | undefined = wasWarned ? "PHASE1_RECOVERY" : undefined;
    if (this.warnedEpisode) {
      if (this.safeSinceMs === null) this.safeSinceMs = nowMs;
      if (nowMs - this.safeSinceMs >= this.minDwellMs) {
        this.warnedEpisode = false;
        this.safeSinceMs = null;
        if (nowMs - this.lastStarMs >= this.starCooldownMs) {
          this.lastStarMs = nowMs;
          event = "STAR_AWARDED";
        }
      }
    }
    return { ...base, state: "SAFE", distanceM: d, blurPx: 0, event };
  }

  private enterWarnState(state: "TOO_CLOSE" | "BELOW_FRAME", blurPx: number): void {
    this.phase = state;
    this.lastBlurPx = blurPx;
    this.warnedEpisode = true;
    this.safeSinceMs = null;
    this.lowConfidenceSinceMs = null;
  }

  /** Hold the last trusted blur for up to lowConfidenceHoldMs, then clear. Dwell timer does not advance. */
  private lowConfidence(nowMs: number): Pick<FrameOutput, "state" | "distanceM" | "blurPx"> {
    if (this.lowConfidenceSinceMs === null) this.lowConfidenceSinceMs = nowMs;
    this.safeSinceMs = null;
    this.enterSinceMs = null;
    this.exitSinceMs = null;
    const held = nowMs - this.lowConfidenceSinceMs < this.lowConfidenceHoldMs;
    if (!held) {
      // Lost for too long: clear, and do not reward an episode we did not see end.
      this.lastBlurPx = 0;
      this.phase = "SAFE";
      this.warnedEpisode = false;
    }
    return { state: "LOW_CONFIDENCE", distanceM: null, blurPx: held ? this.lastBlurPx : 0 };
  }

  private updatePosture(posture: PostureType, nowMs: number): TelemetryEvent | undefined {
    if (posture !== "SLOUCH" && posture !== "LYING_DOWN") {
      this.badPostureSinceMs = null;
      return undefined;
    }
    if (this.badPostureSinceMs === null) this.badPostureSinceMs = nowMs;
    if (
      nowMs - this.badPostureSinceMs >= this.postureNudgeAfterMs &&
      nowMs - this.lastPostureNudgeMs >= this.postureNudgeCooldownMs
    ) {
      this.lastPostureNudgeMs = nowMs;
      return "POSTURE_NUDGE";
    }
    return undefined;
  }
}
