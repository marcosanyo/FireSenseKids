/**
 * TV-side measurement log (MEASUREMENT_EVIDENCE §3, §5, §6).
 *
 * Every record is kept on the TV (SharedPreferences in the APK, localStorage in a browser; last
 * MAX_RECORDS) and printed once as one line of JSON with a fixed prefix, so it can be collected with
 *   adb logcat -s FireSenseKids | grep firesense-measure
 * (the APK forwards console messages to logcat). Nothing is sent to the cloud.
 */

import { storage } from "./storage";

export const MEASURE_LOG_KEY = "firesense.tv.measurements";
export const MEASURE_LOG_PREFIX = "[firesense-measure]";
const MAX_RECORDS = 200;

export type MeasureKind = "render_bench" | "disconnect_clear" | "relay_rtt";

export interface MeasureRecord<T = unknown> {
  kind: MeasureKind;
  /** ISO time on the TV (device clock; only durations measured on one device are compared). */
  at: string;
  data: T;
}

export function readMeasurements(): MeasureRecord[] {
  return storage.getJson<MeasureRecord[]>(MEASURE_LOG_KEY) ?? [];
}

export function recordMeasurement<T>(kind: MeasureKind, data: T, now = new Date()): MeasureRecord<T> {
  const rec: MeasureRecord<T> = { kind, at: now.toISOString(), data };
  const all = [...readMeasurements(), rec].slice(-MAX_RECORDS);
  storage.setJson(MEASURE_LOG_KEY, all);
  console.info(`${MEASURE_LOG_PREFIX} ${JSON.stringify(rec)}`);
  return rec;
}
