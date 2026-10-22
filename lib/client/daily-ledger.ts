import type { DailySummary } from "@/lib/firesense/protocol";
import { emptyDailySummary, emptyModeStats } from "@/lib/firesense/daily-stats";
import { localDate } from "./config";

/** TV-side cumulative counters for the current local day. Persisted; POSTed while viewing. */
export function emptyDay(date = localDate()): DailySummary {
  return emptyDailySummary(date);
}

/**
 * Today's record, or a fresh one. A record saved by a TV build from before per-mode metrics
 * gets empty `modes`: they count from the update on (the older part of that day stays in the totals).
 */
export function rollDay(current: DailySummary | null, today = localDate()): DailySummary {
  if (!current || current.date !== today) return emptyDay(today);
  return current.modes ? current : { ...current, modes: { intervene: emptyModeStats(), shadow: emptyModeStats() } };
}
