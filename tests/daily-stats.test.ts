import { describe, expect, test } from "vitest";
import {
  addRecovery,
  countEvent,
  countPlayingSecond,
  emptyDailySummary,
  floorCell,
  DailySummarySchema,
  FLOOR_GRID,
  MAX_RECOVERY_SAMPLES,
  RecoveryTimer,
  type DailySummary,
  type SecondSample,
} from "../lib/firesense";

const DATE = "2026-10-05";
const live = (over: Partial<SecondSample> = {}): SecondSample => ({ mode: "intervene", connected: true, state: "SAFE", test: false, ...over });

function seconds(day: DailySummary, samples: SecondSample[]): DailySummary {
  return samples.reduce(countPlayingSecond, day);
}

describe("per-mode viewing and warn seconds", () => {
  test("warnSeconds counts only playing + connected + TOO_CLOSE / BELOW_FRAME, in the current mode", () => {
    const d = seconds(emptyDailySummary(DATE), [
      live({ state: "SAFE" }),
      live({ state: "APPROACHING" }),
      live({ state: "TOO_CLOSE" }),
      live({ state: "BELOW_FRAME" }),
      live({ state: "TOO_CLOSE", connected: false }), // link down: not a warn second
      live({ mode: "shadow", state: "TOO_CLOSE" }),
      live({ mode: "shadow", state: "LOW_CONFIDENCE" }),
    ]);
    expect(d.viewingSeconds).toBe(7);
    expect(d.modes.intervene).toMatchObject({ viewingSeconds: 5, warnSeconds: 2 });
    expect(d.modes.shadow).toMatchObject({ viewingSeconds: 2, warnSeconds: 1 });
  });

  test("test-mode input and an unknown mode count only toward the old total", () => {
    const d = seconds(emptyDailySummary(DATE), [live({ test: true, state: "TOO_CLOSE" }), live({ mode: null, state: "TOO_CLOSE" })]);
    expect(d.viewingSeconds).toBe(2);
    expect(d.modes.intervene.viewingSeconds).toBe(0);
    expect(d.modes.shadow.viewingSeconds).toBe(0);
  });
});

describe("events", () => {
  test("WARN counts per mode; stars only in intervene (shadow awards nothing)", () => {
    let d = emptyDailySummary(DATE);
    d = countEvent(d, "WARN", "intervene");
    d = countEvent(d, "WARN", "shadow");
    d = countEvent(d, "WARN", "shadow");
    d = countEvent(d, "STAR_AWARDED", "shadow");
    d = countEvent(d, "STAR_AWARDED", "intervene");
    expect(d.approachCount).toBe(3);
    expect(d.modes.intervene.approachCount).toBe(1);
    expect(d.modes.shadow.approachCount).toBe(2);
    expect(d.starCount).toBe(1);
  });
});

describe("recoverySeconds (WARN → next SAFE)", () => {
  test("measured from the first WARN to the next SAFE, attributed to the WARN's mode", () => {
    const t = new RecoveryTimer();
    t.onWarn(1_000, "shadow");
    t.onWarn(2_000, "shadow"); // same episode
    expect(t.onState(3_000, "TOO_CLOSE")).toBeNull();
    expect(t.onState(5_000, "APPROACHING")).toBeNull();
    expect(t.onState(8_500, "SAFE")).toEqual({ mode: "shadow", seconds: 7.5 });
    expect(t.onState(9_000, "SAFE")).toBeNull(); // nothing pending
  });

  test("a new day drops a pending measurement", () => {
    const t = new RecoveryTimer();
    t.onWarn(0, "intervene");
    t.reset();
    expect(t.onState(1_000, "SAFE")).toBeNull();
  });

  test("durations are stored per mode, rounded to 0.1 s", () => {
    let d = addRecovery(emptyDailySummary(DATE), "intervene", 4.26);
    d = addRecovery(d, "shadow", 12);
    expect(d.modes.intervene.recoverySeconds).toEqual([4.3]);
    expect(d.modes.shadow.recoverySeconds).toEqual([12]);
  });

  test(`truncated at ${MAX_RECOVERY_SAMPLES} per day, and says so`, () => {
    let d = emptyDailySummary(DATE);
    for (let i = 0; i < MAX_RECOVERY_SAMPLES; i++) d = addRecovery(d, "shadow", 1);
    expect(d.modes.shadow.recoveryTruncated).toBe(false);
    d = addRecovery(d, "shadow", 99);
    expect(d.modes.shadow.recoverySeconds).toHaveLength(MAX_RECOVERY_SAMPLES);
    expect(d.modes.shadow.recoverySeconds).not.toContain(99);
    expect(d.modes.shadow.recoveryTruncated).toBe(true);
    expect(d.modes.intervene.recoveryTruncated).toBe(false);
  });
});

describe("floor heatmap", () => {
  const base = { mode: "intervene" as const, connected: true, test: false };
  test("counts a confident position into its 0.25 m cell, per mode", () => {
    let d = emptyDailySummary("2026-09-27");
    d = countPlayingSecond(d, { ...base, state: "TOO_CLOSE", floor: { lateralM: 0.1, frontM: 0.3 }, confidence: 0.9 });
    d = countPlayingSecond(d, { ...base, mode: "shadow", state: "SAFE", floor: { lateralM: -1.9, frontM: 2.9 }, confidence: 0.8 });
    expect(d.modes.intervene.floorSeconds![floorCell({ lateralM: 0.1, frontM: 0.3 })!]).toBe(1);
    expect(floorCell({ lateralM: 0.1, frontM: 0.3 })).toBe(1 * FLOOR_GRID.cols + 8);
    expect(d.modes.shadow.floorSeconds!.reduce((a, b) => a + b, 0)).toBe(1);
  });
  test("not counted: low confidence, LOW_CONFIDENCE / BELOW_FRAME, disconnected, test, outside the grid", () => {
    let d = emptyDailySummary("2026-09-27");
    const p = { lateralM: 0, frontM: 1 };
    d = countPlayingSecond(d, { ...base, state: "SAFE", floor: p, confidence: 0.5 });
    d = countPlayingSecond(d, { ...base, state: "LOW_CONFIDENCE", floor: p, confidence: 0.9 });
    d = countPlayingSecond(d, { ...base, state: "BELOW_FRAME", floor: p, confidence: 0.9 });
    d = countPlayingSecond(d, { ...base, connected: false, state: "SAFE", floor: p, confidence: 0.9 });
    d = countPlayingSecond(d, { ...base, test: true, state: "SAFE", floor: p, confidence: 0.9 });
    d = countPlayingSecond(d, { ...base, state: "SAFE", floor: { lateralM: 2.5, frontM: 1 }, confidence: 0.9 });
    d = countPlayingSecond(d, { ...base, state: "SAFE", floor: { lateralM: 0, frontM: 3.2 }, confidence: 0.9 });
    expect(d.modes.intervene.floorSeconds!.reduce((a, b) => a + b, 0)).toBe(0);
    expect(d.modes.intervene.viewingSeconds).toBe(6); // the test second counts in the total only
  });
  test("a day restored from before the heatmap gets its grid on the next second", () => {
    const old = emptyDailySummary("2026-09-27");
    delete old.modes.intervene.floorSeconds;
    const d = countPlayingSecond(old, { ...base, state: "SAFE", floor: { lateralM: 0, frontM: 1 }, confidence: 0.9 });
    expect(d.modes.intervene.floorSeconds).toHaveLength(FLOOR_GRID.cols * FLOOR_GRID.rows);
    expect(DailySummarySchema.safeParse(d).success).toBe(true);
  });
});
