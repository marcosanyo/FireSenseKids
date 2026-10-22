/**
 * Field pilot (T2) — turns raw daily_summaries items into CSV rows. Pure; used by
 * scripts/export-pilot.mjs and tested in tests/pilot-metrics.test.ts.
 *
 * Nothing missing becomes 0: a value the record does not have is an empty cell.
 *   - a record from before T2 has no `modes` → the per-mode cells are empty ("legacy")
 *   - a day with only reminder presses has no TV numbers ("reminders-only")
 *   - a record from before the reminder button has no reminder counters → empty
 * A per-hour rate needs viewing time; with 0 viewing seconds it is empty, not 0 or infinity.
 */

export const MODES = ["intervene", "shadow"];

const REMINDER_ATTR = { intervene: "reminderIntervene", shadow: "reminderShadow" };

export function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
}

function recordFormat(item) {
  if (item.approachCount === undefined) return "reminders-only";
  return item.modes ? "v2" : "legacy";
}

function reminderCount(item, mode) {
  const has = item.reminderIntervene !== undefined || item.reminderShadow !== undefined;
  return has ? item[REMINDER_ATTR[mode]] ?? 0 : null;
}

/** One row per household × date × mode. */
export function dayRows(household, sessionId, items) {
  const rows = [];
  for (const item of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    const format = recordFormat(item);
    for (const mode of MODES) {
      const m = item.modes?.[mode] ?? null;
      rows.push({
        household,
        sessionId,
        date: item.date,
        mode,
        format,
        viewingSeconds: m ? m.viewingSeconds : null,
        warnSeconds: m ? m.warnSeconds : null,
        approachCount: m ? m.approachCount : null,
        recoveryCount: m ? m.recoverySeconds.length : null,
        recoveryMedianSeconds: m ? median(m.recoverySeconds) : null,
        recoveryTruncated: m ? m.recoveryTruncated : null,
        parentReminderCount: reminderCount(item, mode),
        recoverySeconds: m ? m.recoverySeconds : null, // for pooling; not a CSV column
      });
    }
  }
  return rows;
}

const perHour = (count, seconds) => (seconds > 0 ? Math.round((count / (seconds / 3600)) * 100) / 100 : null);
const sumOf = (rows, key) => rows.reduce((a, r) => a + r[key], 0);

/** One row per household × mode: totals, per viewing hour, and the pooled recovery median. */
export function summaryRows(rows) {
  const out = [];
  const households = [...new Set(rows.map((r) => r.household))];
  for (const household of households) {
    for (const mode of MODES) {
      const all = rows.filter((r) => r.household === household && r.mode === mode);
      const measured = all.filter((r) => r.viewingSeconds !== null);
      const withReminders = all.filter((r) => r.parentReminderCount !== null);
      const viewingSeconds = sumOf(measured, "viewingSeconds");
      const warnSeconds = sumOf(measured, "warnSeconds");
      const approachCount = sumOf(measured, "approachCount");
      const reminders = withReminders.length ? sumOf(withReminders, "parentReminderCount") : null;
      // Reminders per hour only over days that also have viewing numbers (same denominator).
      const remindersOnMeasured = measured.filter((r) => r.parentReminderCount !== null);
      out.push({
        household,
        mode,
        daysMeasured: measured.length,
        daysWithoutModeData: all.length - measured.length,
        viewingHours: Math.round((viewingSeconds / 3600) * 100) / 100,
        warnSeconds,
        warnSecondsPerHour: perHour(warnSeconds, viewingSeconds),
        approachCount,
        approachPerHour: perHour(approachCount, viewingSeconds),
        recoveryCount: sumOf(measured, "recoveryCount"),
        recoveryMedianSeconds: median(measured.flatMap((r) => r.recoverySeconds)),
        recoveryTruncatedDays: measured.filter((r) => r.recoveryTruncated).length,
        parentReminderCount: reminders,
        parentRemindersPerHour: remindersOnMeasured.length
          ? perHour(sumOf(remindersOnMeasured, "parentReminderCount"), sumOf(remindersOnMeasured, "viewingSeconds"))
          : null,
      });
    }
  }
  return out;
}

// No sessionId column: the CSV is committed, and households are only labels (A, B, …).
export const DAY_COLUMNS = [
  "household",
  "date",
  "mode",
  "format",
  "viewingSeconds",
  "warnSeconds",
  "approachCount",
  "recoveryCount",
  "recoveryMedianSeconds",
  "recoveryTruncated",
  "parentReminderCount",
];

export const SUMMARY_COLUMNS = [
  "household",
  "mode",
  "daysMeasured",
  "daysWithoutModeData",
  "viewingHours",
  "warnSeconds",
  "warnSecondsPerHour",
  "approachCount",
  "approachPerHour",
  "recoveryCount",
  "recoveryMedianSeconds",
  "recoveryTruncatedDays",
  "parentReminderCount",
  "parentRemindersPerHour",
];

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}
