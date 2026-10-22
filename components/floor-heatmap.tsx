"use client";

/**
 * Parent phone: where the child stood in front of the TV, "record only" vs "FireSense on" (field pilot).
 *
 * The TV counts one second of playback into a 0.25 m floor cell (FLOOR_GRID) when the camera phone was
 * fairly sure of the position (confidence ≥ HEATMAP_MIN_CONFIDENCE, TV-marker calibration). Each map
 * shows the share of its own counted time, on the same color scale, so a map with more viewing is not
 * darker just for that. Pose misdetections (a cushion taken for a person) can still land here; the note
 * under the maps says so.
 */

import { L } from "@/lib/firesense/i18n";
import { FLOOR_GRID, FLOOR_GRID_CELLS, HEATMAP_MIN_CONFIDENCE, type DayRecord, type FireSenseMode } from "@/lib/firesense";

export type Sum = { cells: number[]; total: number; days: number };

/** Floor seconds per cell over `days`, for one mode or both ("all"). `days` counts days that have a heatmap. */
export function sumDays(days: DayRecord[], mode: FireSenseMode | "all"): Sum {
  const cells = new Array(FLOOR_GRID_CELLS).fill(0);
  let n = 0;
  for (const d of days) {
    const modes = d.summary?.modes;
    const parts = mode === "all" ? [modes?.intervene?.floorSeconds, modes?.shadow?.floorSeconds] : [modes?.[mode]?.floorSeconds];
    const present = parts.filter((f): f is number[] => Boolean(f));
    if (present.length === 0) continue;
    n++;
    for (const f of present) f.forEach((v, i) => (cells[i] += v));
  }
  return { cells, total: cells.reduce((a, b) => a + b, 0), days: n };
}

/** Distance bands (m from the screen) for the bar chart; the last one is open-ended. */
const BANDS = [0.5, 1, 1.5, 2, Infinity];
const BAND_LABEL = ["〜0.5m", "0.5〜1m", "1〜1.5m", "1.5〜2m", "2m〜"];
/** The grid does not know the TV's width; a ~1 m screen is assumed for "distance from the screen". */
const NOMINAL_HALF_WIDTH_M = 0.5;

/** Share of counted time per distance band (null when nothing was counted). */
function bandShares(s: Sum): number[] | null {
  if (s.total === 0) return null;
  const out = BANDS.map(() => 0);
  s.cells.forEach((v, i) => {
    if (!v) return;
    const lateral = FLOOR_GRID.lateralMinM + ((i % FLOOR_GRID.cols) + 0.5) * FLOOR_GRID.cellM;
    const front = (Math.floor(i / FLOOR_GRID.cols) + 0.5) * FLOOR_GRID.cellM;
    const d = Math.hypot(Math.max(0, Math.abs(lateral) - NOMINAL_HALF_WIDTH_M), front);
    out[BANDS.findIndex((b) => d < b)] += v;
  });
  return out.map((v) => v / s.total);
}

/** "Record only" vs "FireSense on" days of one period. */
export function FloorHeatmap({ days }: { days: DayRecord[] }) {
  return (
    <HeatmapCompare
      title={L("How far from the TV the viewer watched", "テレビからどのくらい離れて見ていたか")}
      groups={[
        { key: "shadow", label: L("Record-only days", "記録のみの日"), color: "#64748b", rgb: "100,116,139", sum: sumDays(days, "shadow") },
        { key: "intervene", label: L("Respond days", "見守りありの日"), color: "#f97316", rgb: "249,115,22", sum: sumDays(days, "intervene") },
      ]}
    />
  );
}

export interface HeatmapGroup {
  key: string;
  label: string;
  /** Bar and title color, and the same as "r,g,b" for the floor map's cells. */
  color: string;
  rgb: string;
  sum: Sum;
}

/** Two heatmaps side by side, each as the share of its own counted time, on one color scale. */
export function HeatmapCompare({ title, groups, openMap = false }: { title: string; groups: HeatmapGroup[]; openMap?: boolean }) {
  const maps = groups.map((g) => ({ mode: g.key, sum: g.sum }));
  if (maps.every((m) => m.sum.days === 0)) return null; // no day with the heatmap yet: nothing to show
  const maxShare = Math.max(1e-9, ...maps.flatMap((m) => (m.sum.total ? m.sum.cells.map((v) => v / m.sum.total) : [])));

  const shares = maps.map((m) => bandShares(m.sum));
  const near = shares.map((b) => (b ? b[0] + b[1] : null)); // under 1 m
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  const COLORS: Record<string, string> = Object.fromEntries(groups.map((g) => [g.key, g.color]));
  const LABEL: Record<string, string> = Object.fromEntries(groups.map((g) => [g.key, g.label]));
  const RGB: Record<string, string> = Object.fromEntries(groups.map((g) => [g.key, g.rgb]));

  return (
    <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3 text-xs">
      <h2 className="text-sm font-bold text-white">{title}</h2>

      <div className="grid grid-cols-2 gap-2 text-center">
        {maps.map(({ mode, sum }, k) => (
          <div key={mode} className="p-2 rounded-lg bg-slate-950 border border-slate-800">
            <div className="text-slate-400">{LABEL[mode]}</div>
            <div className="text-2xl font-black" style={{ color: COLORS[mode] }}>
              {pct(near[k])}
            </div>
            <div className="text-slate-400">{L("of the time within 1 m of the TV", "の時間、テレビから1m以内")}</div>
            <div className="text-[10px] text-slate-500">{sum.days === 0 ? L("No records in this period", "この期間の記録なし") : L(`${Math.round(sum.total / 60)} min, ${sum.days} days`, `${Math.round(sum.total / 60)}分・${sum.days}日`)}</div>
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <div className="text-slate-400">{L("Share of time by distance", "距離ごとの時間の割合")}</div>
        {BAND_LABEL.map((label, b) => (
          <div key={label} className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
            <span className="text-slate-400 text-right">{label}</span>
            <div className="space-y-0.5">
              {maps.map(({ mode }, k) => (
                <div key={mode} className="flex items-center gap-1">
                  <div className="h-2.5 rounded-sm" style={{ width: `${Math.max(0.5, (shares[k]?.[b] ?? 0) * 100)}%`, background: COLORS[mode], opacity: shares[k] ? 1 : 0.2 }} />
                  <span className="text-[10px] text-slate-500">{shares[k] ? pct(shares[k]![b]) : ""}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="flex gap-3 justify-end text-[10px] text-slate-400">
          {maps.map(({ mode }) => (
            <span key={mode} className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: COLORS[mode] }} />
              {LABEL[mode]}
            </span>
          ))}
        </div>
      </div>

      <details className="rounded-lg bg-slate-950 border border-slate-800 p-2" open={openMap}>
        <summary className="cursor-pointer text-slate-300">{L("Show the floor map (seen from above)", "床の地図で見る（上から見た図）")}</summary>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {maps.map(({ mode, sum }) => (
            <div key={mode} className="space-y-1">
              <div className="font-bold" style={{ color: COLORS[mode] }}>
                {LABEL[mode]}
              </div>
              <Grid sum={sum} maxShare={maxShare} rgb={RGB[mode]} />
            </div>
          ))}
        </div>
        <p className="text-[10px] text-slate-500 mt-1">{L("The TV is at the top. The darker a 25 cm square, the longer someone was there.", "上がテレビ。色が濃いマス（25cm 四方）ほど、そこにいた時間が長い。")}</p>
      </details>

      <p className="text-[10px] text-slate-500">
        {L(
          `Positions the watch camera measured from the feet (from the hips when the feet are hidden), counted once per second of playback, only at confidence ${HEATMAP_MIN_CONFIDENCE} or more. A cushion mistaken for a person can still show up.`,
          `見守りカメラが足元（隠れていれば腰）から測った位置を、再生中の1秒ごとに数えています（確からしさ${HEATMAP_MIN_CONFIDENCE}以上のときだけ）。クッションなどを人と取り違えた位置が混ざることがあります。`
        )}
      </p>
    </section>
  );
}

function Grid({ sum, maxShare, rgb }: { sum: Sum; maxShare: number; rgb: string }) {
  const { cols, rows, cellM } = FLOOR_GRID;
  const cell = 10;
  const top = 8;
  const w = cols * cell;
  const h = rows * cell + top;
  const tvHalf = (0.5 / cellM) * cell; // a ~1 m wide screen, as a guide only
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto rounded-md bg-slate-950 border border-slate-800">
      <rect x={w / 2 - tvHalf} y={1} width={tvHalf * 2} height={4} rx={1} fill="#94a3b8" />
      <text x={w / 2} y={top + 7} textAnchor="middle" fontSize={5} fill="#cbd5e1">
        {L("TV", "テレビ")}
      </text>
      {sum.cells.map((v, i) => {
        if (!v || !sum.total) return null;
        const a = Math.min(1, v / sum.total / maxShare);
        return <rect key={i} x={(i % cols) * cell} y={top + Math.floor(i / cols) * cell} width={cell} height={cell} fill={`rgba(${rgb},${(0.12 + 0.88 * a).toFixed(3)})`} />;
      })}
      {[1, 2].map((m) => (
        <g key={m}>
          <line x1={0} x2={w} y1={top + (m / cellM) * cell} y2={top + (m / cellM) * cell} stroke="#64748b" strokeDasharray="3 3" strokeWidth={0.6} />
          <text x={2} y={top + (m / cellM) * cell - 1.5} fontSize={5} fill="#94a3b8">
            {m}m
          </text>
        </g>
      ))}
    </svg>
  );
}
