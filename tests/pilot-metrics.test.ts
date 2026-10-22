import { describe, expect, test } from "vitest";
import { DAY_COLUMNS, dayRows, median, SUMMARY_COLUMNS, summaryRows, toCsv } from "../scripts/pilot-metrics.mjs";
import { emptyModeStats } from "../lib/firesense";

const base = { approachCount: 2, selfRecoveryCount: 1, starCount: 1, disconnectCount: 0, disconnectSeconds: 0, viewingSeconds: 7200 };

const items = [
  // v2 record: intervene 1 h, shadow 1 h
  {
    sessionId: "s_a",
    date: "2026-10-06",
    ...base,
    modes: {
      intervene: { ...emptyModeStats(), viewingSeconds: 3600, warnSeconds: 60, approachCount: 2, recoverySeconds: [3, 5] },
      shadow: { ...emptyModeStats(), viewingSeconds: 3600, warnSeconds: 300, approachCount: 6, recoverySeconds: [10, 20, 30], recoveryTruncated: true },
    },
    reminderIntervene: 1,
    reminderShadow: 4,
  },
  // before T2: no modes, no reminders
  { sessionId: "s_a", date: "2026-10-05", ...base },
  // reminders only (TV never sent that day)
  { sessionId: "s_a", date: "2026-10-07", reminderShadow: 2 },
];

describe("pilot export", () => {
  const rows = dayRows("A", "s_a", items);

  test("rows per date × mode; missing values stay empty, never 0", () => {
    expect(rows.map((r: any) => `${r.date}/${r.mode}/${r.format}`)).toEqual([
      "2026-10-05/intervene/legacy",
      "2026-10-05/shadow/legacy",
      "2026-10-06/intervene/v2",
      "2026-10-06/shadow/v2",
      "2026-10-07/intervene/reminders-only",
      "2026-10-07/shadow/reminders-only",
    ]);
    expect(rows[0]).toMatchObject({ viewingSeconds: null, warnSeconds: null, parentReminderCount: null });
    expect(rows[3]).toMatchObject({ viewingSeconds: 3600, warnSeconds: 300, recoveryMedianSeconds: 20, recoveryTruncated: true, parentReminderCount: 4 });
    expect(rows[4]).toMatchObject({ viewingSeconds: null, parentReminderCount: 0 });
    expect(rows[5]).toMatchObject({ viewingSeconds: null, parentReminderCount: 2 });
    const csv = toCsv(rows, DAY_COLUMNS).split("\n");
    expect(csv[0]).toBe(DAY_COLUMNS.join(","));
    expect(csv[1]).toBe("A,2026-10-05,intervene,legacy,,,,,,,");
  });

  test("summary per household × mode: totals, per viewing hour, pooled median", () => {
    const [intervene, shadow] = summaryRows(rows);
    expect(intervene).toMatchObject({
      household: "A",
      mode: "intervene",
      daysMeasured: 1,
      daysWithoutModeData: 2,
      viewingHours: 1,
      warnSecondsPerHour: 60,
      approachPerHour: 2,
      recoveryMedianSeconds: 4,
      parentReminderCount: 1,
      parentRemindersPerHour: 1,
    });
    expect(shadow).toMatchObject({
      warnSecondsPerHour: 300,
      approachPerHour: 6,
      recoveryMedianSeconds: 20,
      recoveryTruncatedDays: 1,
      parentReminderCount: 6, // includes the reminders-only day in the total …
      parentRemindersPerHour: 4, // … but the rate uses only days with viewing time
    });
    expect(toCsv(summaryRows(rows), SUMMARY_COLUMNS).split("\n")[0]).toBe(SUMMARY_COLUMNS.join(","));
  });

  test("no viewing time → no rate (empty), not 0", () => {
    const [intervene] = summaryRows(dayRows("B", "s_b", [{ sessionId: "s_b", date: "2026-10-06", ...base, modes: { intervene: emptyModeStats(), shadow: emptyModeStats() } }]));
    expect(intervene.approachPerHour).toBeNull();
    expect(intervene.recoveryMedianSeconds).toBeNull();
  });

  test("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
