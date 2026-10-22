"use client";

/**
 * Parent phone, Records: which days to show (last 7 / last 30 / any range), a second period to compare the
 * floor heatmaps with, and "reset the records".
 *
 * Records are daily (one per local day, both modes) and kept 30 days (SUMMARY_TTL_DAYS), so a range covers
 * whole days within the last 30. The reset goes through the TV (tv_records_reset): it clears its running
 * counters before deleting the stored days, so its next upload cannot bring them back.
 */

import { useState } from "react";
import { L } from "@/lib/firesense/i18n";
import type { DayRecord } from "@/lib/firesense";
import { HeatmapCompare, sumDays } from "@/components/floor-heatmap";
import { localDate } from "@/lib/client/config";

export type Range = { from: string; to: string };

/** Records older than this are deleted by the database (SUMMARY_TTL_DAYS). */
export const KEPT_DAYS = 30;

export function daysAgo(n: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return localDate(d);
}

export function lastDays(n: number): Range {
  return { from: daysAgo(n - 1), to: localDate() };
}

export function rangeLabel(r: Range): string {
  return r.from === r.to ? r.from.slice(5) : `${r.from.slice(5)} – ${r.to.slice(5)}`;
}

/** Presets plus two date inputs, limited to the days that are kept. */
export function RangePicker({ value, onChange, accent }: { value: Range; onChange: (r: Range) => void; accent: string }) {
  const min = daysAgo(KEPT_DAYS - 1);
  const max = localDate();
  const preset = (n: number) => {
    const r = lastDays(n);
    return r.from === value.from && r.to === value.to;
  };
  const btn = (on: boolean) => `px-2.5 py-1 rounded-lg border font-bold ${on ? "bg-white text-slate-900 border-white" : "bg-slate-800 text-slate-200 border-slate-600"}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button onClick={() => onChange(lastDays(7))} className={btn(preset(7))}>
        {L("Last 7 days", "直近7日")}
      </button>
      <button onClick={() => onChange(lastDays(KEPT_DAYS))} className={btn(preset(KEPT_DAYS))}>
        {L("Last 30 days", "直近30日")}
      </button>
      <button onClick={() => onChange({ from: max, to: max })} className={btn(value.from === max && value.to === max)}>
        {L("Today", "きょう")}
      </button>
      <span className="flex items-center gap-1" style={{ color: accent }}>
        <input
          type="date"
          value={value.from}
          min={min}
          max={value.to}
          onChange={(e) => e.target.value && onChange({ from: e.target.value, to: value.to })}
          className="bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-white"
        />
        –
        <input
          type="date"
          value={value.to}
          min={value.from}
          max={max}
          onChange={(e) => e.target.value && onChange({ from: value.from, to: e.target.value })}
          className="bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-white"
        />
      </span>
    </div>
  );
}

/** The floor heatmaps of two periods side by side (both modes counted). */
export function PeriodCompare({ a, b, daysA, daysB }: { a: Range; b: Range; daysA: DayRecord[]; daysB: DayRecord[] }) {
  const out = (
    <HeatmapCompare
      title={L("Where the viewer watched: two periods", "どこで見ていたか: 2つの期間の比較")}
      openMap
      groups={[
        { key: "a", label: L(`A: ${rangeLabel(a)}`, `A: ${rangeLabel(a)}`), color: "#f97316", rgb: "249,115,22", sum: sumDays(daysA, "all") },
        { key: "b", label: L(`B: ${rangeLabel(b)}`, `B: ${rangeLabel(b)}`), color: "#22d3ee", rgb: "34,211,238", sum: sumDays(daysB, "all") },
      ]}
    />
  );
  return out ?? <p className="text-xs text-slate-400">{L("Neither period has a floor heatmap yet.", "どちらの期間にも床のヒートマップの記録がまだありません。")}</p>;
}

/** "Reset the records": two steps, only while the TV is connected (the TV does the reset). */
export function ResetRecords({ tvOnline, busy, onReset }: { tvOnline: boolean; busy: boolean; onReset: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-2 text-xs">
      {!confirming ? (
        <button disabled={!tvOnline || busy} onClick={() => setConfirming(true)} className="px-3 py-1.5 rounded-lg bg-rose-900 text-white font-bold disabled:opacity-40">
          {busy ? L("Resetting…", "リセット中…") : L("Reset all records", "記録をすべてリセット")}
        </button>
      ) : (
        <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800 space-y-2">
          <p className="text-rose-100">
            {L(
              "Delete every day's record (viewing, approaches, heatmaps, reminders) for this TV? This cannot be undone. The weekly reflection is then written from new records only.",
              "このテレビの毎日の記録（視聴・近づき・ヒートマップ・声かけ）をすべて消しますか？元に戻せません。週のふりかえりも、これからの記録だけで作られます。"
            )}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setConfirming(false);
                onReset();
              }}
              className="px-3 py-1.5 rounded-lg bg-rose-700 text-white font-bold"
            >
              {L("Delete all records", "すべて消す")}
            </button>
            <button autoFocus onClick={() => setConfirming(false)} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white font-bold">
              {L("Cancel", "やめる")}
            </button>
          </div>
        </div>
      )}
      {!tvOnline && <p className="text-slate-500">{L("Turn the TV on to reset (the TV clears its own counters too).", "リセットはテレビがつながっているときだけできます（テレビ側の数え途中の記録も消すため）。")}</p>}
    </div>
  );
}
