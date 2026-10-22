/**
 * FireSense Kids — Safety Pause Policy (U2 §5).
 *
 * When enabled, if the viewing state remains TOO_CLOSE or BELOW_FRAME continuously
 * for `afterSeconds`, the TV pauses playback to prevent the child from staying too close.
 *
 * Rules:
 * 1. Uncounted periods:
 *    - LOW_CONFIDENCE, disconnected (connected === false), state === null, or shadow mode:
 *      These do NOT count toward violation. The violation timer is reset.
 *    - If already paused, LOW_CONFIDENCE or disconnected does not count toward recovery, but it
 *      releases the pause after `PAUSE_LOST_RELEASE_MS` (5 s): nobody is seen any more (the child
 *      walked away, or the camera phone is gone), and a pause nobody can end by stepping back would be
 *      a stuck TV. The blur clears after the same 5 s of LOW_CONFIDENCE (state-machine.ts); if the
 *      child is still close, the blur and then the pause come back once they are seen again.
 * 2. Auto-resume:
 *    - When the state returns to SAFE or APPROACHING and remains continuously for 2000 ms (2 s),
 *      the video automatically resumes.
 *    - If the child approaches again during the 2 s recovery window (e.g. TOO_CLOSE),
 *      the recovery timer resets and it remains paused.
 * 3. Configuration changes:
 *    - If config.enabled is turned off, or mode changes to "shadow", any active pause immediately resumes.
 */

import type { FireSenseMode, ViewingState } from "./protocol";

export const PAUSE_RECOVERY_MS = 2000;
/** While paused: nobody seen (LOW_CONFIDENCE / no state) or the camera phone disconnected this long → resume. */
export const PAUSE_LOST_RELEASE_MS = 5000;

export interface PausePolicyConfig {
  enabled: boolean;
  afterSeconds: number; // 10..60
}

export interface PauseTrackerState {
  isPaused: boolean;
  violatingSince: number | null;
  recoveringSince: number | null;
  /** While paused: since when nobody has been seen (or the camera phone has been gone). */
  lostSince?: number | null;
}

export type PauseAction = "pause" | "resume" | "none";

export interface PauseStepInput {
  state: ViewingState | null;
  mode: FireSenseMode | null;
  connected: boolean;
  nowMs: number;
  config: PausePolicyConfig;
}

export interface PauseStepOutput {
  next: PauseTrackerState;
  action: PauseAction;
}

export const INITIAL_PAUSE_TRACKER_STATE: PauseTrackerState = Object.freeze({
  isPaused: false,
  violatingSince: null,
  recoveringSince: null,
});

export function isViolatingState(state: ViewingState | null): boolean {
  return state === "TOO_CLOSE" || state === "BELOW_FRAME";
}

export function isRecoveredState(state: ViewingState | null): boolean {
  return state === "SAFE" || state === "APPROACHING";
}

export function stepPauseTracker(prev: PauseTrackerState, input: PauseStepInput): PauseStepOutput {
  const { state, mode, connected, nowMs, config } = input;

  // Disabled or shadow mode: never pause. If currently paused, resume immediately.
  if (!config.enabled || mode === "shadow") {
    if (prev.isPaused) {
      return {
        next: { isPaused: false, violatingSince: null, recoveringSince: null },
        action: "resume",
      };
    }
    return {
      next: { isPaused: false, violatingSince: null, recoveringSince: null },
      action: "none",
    };
  }

  // When paused:
  if (prev.isPaused) {
    if (connected && isRecoveredState(state)) {
      const recStart = prev.recoveringSince ?? nowMs;
      if (nowMs - recStart >= PAUSE_RECOVERY_MS) {
        return {
          next: { isPaused: false, violatingSince: null, recoveringSince: null },
          action: "resume",
        };
      }
      return {
        next: { isPaused: true, violatingSince: null, recoveringSince: recStart },
        action: "none",
      };
    }
    // Nobody seen, or no camera: released after PAUSE_LOST_RELEASE_MS.
    if (!connected || state === "LOW_CONFIDENCE" || state === null) {
      const lostStart = prev.lostSince ?? nowMs;
      if (nowMs - lostStart >= PAUSE_LOST_RELEASE_MS) {
        return { next: { isPaused: false, violatingSince: null, recoveringSince: null, lostSince: null }, action: "resume" };
      }
      return { next: { isPaused: true, violatingSince: null, recoveringSince: null, lostSince: lostStart }, action: "none" };
    }
    // Still too close: stays paused, both timers restart.
    return {
      next: { isPaused: true, violatingSince: null, recoveringSince: null, lostSince: null },
      action: "none",
    };
  }

  // When NOT paused:
  // If disconnected, LOW_CONFIDENCE, or null: reset violation timer
  if (!connected || state === "LOW_CONFIDENCE" || state === null) {
    return {
      next: { isPaused: false, violatingSince: null, recoveringSince: null },
      action: "none",
    };
  }

  // If violating (TOO_CLOSE / BELOW_FRAME)
  if (isViolatingState(state)) {
    const start = prev.violatingSince ?? nowMs;
    const thresholdMs = config.afterSeconds * 1000;
    if (nowMs - start >= thresholdMs) {
      return {
        next: { isPaused: true, violatingSince: null, recoveringSince: null },
        action: "pause",
      };
    }
    return {
      next: { isPaused: false, violatingSince: start, recoveringSince: null },
      action: "none",
    };
  }

  // If SAFE / APPROACHING (not violating): reset violation timer
  return {
    next: { isPaused: false, violatingSince: null, recoveringSince: null },
    action: "none",
  };
}

export class PauseTracker {
  private state: PauseTrackerState = { ...INITIAL_PAUSE_TRACKER_STATE };

  constructor(private config: PausePolicyConfig) {}

  updateConfig(config: PausePolicyConfig) {
    this.config = config;
  }

  get currentState(): Readonly<PauseTrackerState> {
    return this.state;
  }

  get isPaused(): boolean {
    return this.state.isPaused;
  }

  step(input: Omit<PauseStepInput, "config">): PauseAction {
    const res = stepPauseTracker(this.state, { ...input, config: this.config });
    this.state = res.next;
    return res.action;
  }

  reset() {
    this.state = { ...INITIAL_PAUSE_TRACKER_STATE };
  }
}
