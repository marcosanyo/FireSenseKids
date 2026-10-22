/**
 * FireSense Kids — TV-side daily counters (pure; no storage, no clock, no env).
 *
 * The TV counts one DailySummary per local day. Since T2 (field pilot) it also keeps the
 * per-mode metrics (`modes.intervene` / `modes.shadow`) that compare "record only" with
 * "FireSense on". Test-mode telemetry is never counted, in either mode.
 */

import {
  FLOOR_GRID,
  FLOOR_GRID_CELLS,
  MAX_RECOVERY_SAMPLES,
  type DailySummary,
  type FireSenseMode,
  type ModeStats,
  type TelemetryEvent,
  type ViewingState,
} from "./protocol";

export const WARN_STATES: ReadonlySet<ViewingState> = new Set(["TOO_CLOSE", "BELOW_FRAME"]);

export function emptyModeStats(): ModeStats {
  return { viewingSeconds: 0, warnSeconds: 0, approachCount: 0, recoverySeconds: [], recoveryTruncated: false, floorSeconds: new Array(FLOOR_GRID_CELLS).fill(0) };
}

export function emptyDailySummary(date: string): DailySummary {
  return {
    date,
    approachCount: 0,
    selfRecoveryCount: 0,
    starCount: 0,
    disconnectCount: 0,
    disconnectSeconds: 0,
    viewingSeconds: 0,
    modes: { intervene: emptyModeStats(), shadow: emptyModeStats() },
  };
}

function withMode(day: DailySummary, mode: FireSenseMode, fn: (m: ModeStats) => ModeStats): DailySummary {
  return { ...day, modes: { ...day.modes, [mode]: fn(day.modes[mode]) } };
}

/**
 * A (non-test) telemetry event. Totals count both modes, except stars: shadow mode shows
 * nothing to the child, so no star was actually awarded.
 */
export function countEvent(day: DailySummary, event: TelemetryEvent | undefined, mode: FireSenseMode): DailySummary {
  switch (event) {
    case "WARN":
      return withMode({ ...day, approachCount: day.approachCount + 1 }, mode, (m) => ({ ...m, approachCount: m.approachCount + 1 }));
    case "PHASE1_RECOVERY":
      return { ...day, selfRecoveryCount: day.selfRecoveryCount + 1 };
    case "STAR_AWARDED":
      return mode === "intervene" ? { ...day, starCount: day.starCount + 1 } : day;
    default:
      return day;
  }
}

export interface SecondSample {
  /** Mode last reported by the phone; null if none yet (then nothing per-mode is counted). */
  mode: FireSenseMode | null;
  connected: boolean;
  state: ViewingState | null;
  /** The phone is in test mode: count viewing in the total only. */
  test: boolean;
  /** Where the viewer stood (telemetry `floor`), when known. */
  floor?: { lateralM: number; frontM: number } | null;
  /** The phone's confidence in this frame. */
  confidence?: number | null;
}

/** Only positions the phone was fairly sure of go into the heatmap (clutter can look like a person). */
export const HEATMAP_MIN_CONFIDENCE = 0.6;
const HEATMAP_STATES: ReadonlySet<ViewingState> = new Set(["SAFE", "APPROACHING", "TOO_CLOSE"]);

/** FLOOR_GRID cell of a floor position; null outside the grid. */
export function floorCell(p: { lateralM: number; frontM: number }): number | null {
  const col = Math.floor((p.lateralM - FLOOR_GRID.lateralMinM) / FLOOR_GRID.cellM);
  const row = Math.floor(p.frontM / FLOOR_GRID.cellM);
  if (col < 0 || col >= FLOOR_GRID.cols || row < 0 || row >= FLOOR_GRID.rows) return null;
  return row * FLOOR_GRID.cols + col;
}

/** One second of playback (called by the TV's 1 Hz loop only while the video plays). */
export function countPlayingSecond(day: DailySummary, s: SecondSample): DailySummary {
  const next = { ...day, viewingSeconds: day.viewingSeconds + 1 };
  if (!s.mode || s.test) return next;
  const warn = s.connected && s.state !== null && WARN_STATES.has(s.state);
  const cell =
    s.connected && s.state !== null && HEATMAP_STATES.has(s.state) && s.floor && (s.confidence ?? 0) >= HEATMAP_MIN_CONFIDENCE ? floorCell(s.floor) : null;
  return withMode(next, s.mode, (m) => {
    // A day started before the heatmap existed (restored from storage) gets its grid now.
    const floorSeconds = m.floorSeconds ? [...m.floorSeconds] : new Array(FLOOR_GRID_CELLS).fill(0);
    if (cell !== null) floorSeconds[cell] += 1;
    return { ...m, viewingSeconds: m.viewingSeconds + 1, warnSeconds: m.warnSeconds + (warn ? 1 : 0), floorSeconds };
  });
}

/** Appends one WARN → SAFE duration; stops at MAX_RECOVERY_SAMPLES and says so. */
export function addRecovery(day: DailySummary, mode: FireSenseMode, seconds: number): DailySummary {
  return withMode(day, mode, (m) =>
    m.recoverySeconds.length >= MAX_RECOVERY_SAMPLES
      ? { ...m, recoveryTruncated: true }
      : { ...m, recoverySeconds: [...m.recoverySeconds, Math.round(seconds * 10) / 10] }
  );
}

/**
 * Measures "WARN → the next SAFE". The mode is the one in effect when the WARN happened.
 * A WARN while one is pending restarts nothing (the first WARN of the episode counts).
 */
export class RecoveryTimer {
  private pending: { atMs: number; mode: FireSenseMode } | null = null;

  onWarn(nowMs: number, mode: FireSenseMode): void {
    if (!this.pending) this.pending = { atMs: nowMs, mode };
  }

  /** Feed every connected, non-test state. Returns a finished measurement on SAFE. */
  onState(nowMs: number, state: ViewingState): { mode: FireSenseMode; seconds: number } | null {
    if (state !== "SAFE" || !this.pending) return null;
    const done = { mode: this.pending.mode, seconds: (nowMs - this.pending.atMs) / 1000 };
    this.pending = null;
    return done;
  }

  /** A new day starts clean. */
  reset(): void {
    this.pending = null;
  }
}
