"use client";

/**
 * Distance accuracy trials (docs/proof/MEASUREMENT_EVIDENCE.md §1) started from the parent phone, so the person
 * measuring holds the parent phone on the floor mark and never touches the installed watch camera (touching it can
 * tilt it, which stops the distances until it is calibrated again).
 *
 * The camera records and keeps the frames; each trial answers with its one-line summary. The CSV is saved on the
 * watch camera at the end ("Save CSV" there).
 */
import { L } from "@/lib/firesense/i18n";
import { useState } from "react";
import { Ruler } from "lucide-react";
import { beep } from "@/components/distance-trial";
import { TRIAL_LATERALS, type CameraCommand, type CameraStatus } from "@/lib/firesense/protocol";
import type { CommandOutcome } from "@/components/camera-remote";

const MARKS = [0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
const DELAYS = [0, 3, 10];
const TRIAL_S = 10;

export function RemoteDistanceTrial({
  status,
  disabled,
  run,
}: {
  status: CameraStatus;
  disabled: boolean;
  run: (command: CameraCommand, label: string) => Promise<CommandOutcome>;
}) {
  const [trueM, setTrueM] = useState(1.2);
  const [lateral, setLateral] = useState<(typeof TRIAL_LATERALS)[number]>("center");
  const [delayS, setDelayS] = useState(3);
  const [results, setResults] = useState<{ ok: boolean | null; message: string }[]>([]);
  const rec = status.distanceTrials?.recording ?? null;
  const calibrated = Boolean(status.calibration);
  const off = disabled || !calibrated || rec !== null;

  const record = async () => {
    // Beeps here too, for the person on the mark (the camera beeps as well).
    const timers = [setTimeout(() => beep(880), delayS * 1000), setTimeout(() => beep(440), (delayS + TRIAL_S) * 1000)];
    const out = await run({ kind: "distance_trial", trueM, lateral, delayS }, L(`Distance trial (${trueM.toFixed(2)} m)`, `距離の試行（${trueM.toFixed(2)}m）`));
    if (out.ok === false) timers.forEach(clearTimeout);
    setResults((r) => [{ ok: out.ok, message: out.message }, ...r].slice(0, 20));
  };
  const dropLast = async () => {
    const out = await run({ kind: "distance_trial_drop_last" }, L("Delete the last trial", "最後の試行を削除"));
    setResults((r) => [{ ok: out.ok, message: out.message }, ...r].slice(0, 20));
  };

  const live = status.live?.distanceM;
  return (
    <details className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs">
      <summary className="cursor-pointer font-bold text-slate-200 flex items-center gap-2">
        <Ruler className="w-4 h-4 text-sky-400" />
        {L(" Measure distance accuracy (validation)", " 距離の精度を計測（検証用）")}
        <span className="font-normal text-slate-400">({L(`${status.distanceTrials?.trials ?? 0} trials on the camera`, `カメラに ${status.distanceTrials?.trials ?? 0} 試行`)})</span>
      </summary>
      <div className="space-y-3 pt-2">
        <p className="text-slate-400">
          {L(
            "Stand on a floor mark measured from the screen with a laser meter, holding this phone. Pick that distance and press \"Record 10 s\": the watch camera records 10 s of distances (a high beep starts, a low beep ends) without anyone touching it.",
            "レーザー距離計で画面から測った床の印に、このスマホを持って立ちます。その距離を選んで「10秒記録」を押すと、見守りカメラに触らずに10秒間の距離を記録します（高い音で開始、低い音で終了）。"
          )}
        </p>
        {!calibrated && <p className="text-amber-300">{L("Calibrate the watch camera first.", "先に見守りカメラをキャリブレーションしてください。")}</p>}
        <div className="text-slate-400">
          {L("Distance now", "いまの距離")}: <b className="text-white text-base font-mono">{live === null || live === undefined ? "—" : `${live.toFixed(2)} m`}</b>
        </div>
        <div className="flex flex-wrap gap-1">
          {MARKS.map((m) => (
            <button
              key={m}
              disabled={rec !== null}
              onClick={() => setTrueM(m)}
              className={`px-3 py-2 rounded-lg border font-mono ${trueM === m ? "bg-sky-700 border-sky-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}
            >
              {m.toFixed(1)}
            </button>
          ))}
          <label className="flex items-center gap-1 text-slate-400">
            {L("or", "または")}
            <input
              type="number"
              step={0.01}
              min={0.3}
              max={5}
              value={trueM}
              disabled={rec !== null}
              onChange={(e) => setTrueM(Number(e.target.value))}
              className="w-20 px-2 py-2 rounded bg-slate-900 border border-slate-700 text-white font-mono"
            />
            m
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {TRIAL_LATERALS.map((l) => (
            <button
              key={l}
              disabled={rec !== null}
              onClick={() => setLateral(l)}
              className={`px-3 py-2 rounded-lg border ${lateral === l ? "bg-sky-700 border-sky-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}
            >
              {l === "center" ? L("In front of the TV", "TVの正面") : L("0.5 m to the side", "横に0.5m")}
            </button>
          ))}
          <span className="mx-1" />
          {DELAYS.map((d) => (
            <button
              key={d}
              disabled={rec !== null}
              onClick={() => setDelayS(d)}
              className={`px-3 py-2 rounded-lg border ${delayS === d ? "bg-sky-700 border-sky-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}
            >
              {d === 0 ? L("Start now", "すぐ開始") : L(`Start in ${d} s`, `${d}秒後に開始`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void record()} disabled={off || !(trueM >= 0.3 && trueM <= 5)} className="px-4 py-3 rounded-lg bg-sky-600 text-white font-bold text-sm disabled:opacity-50">
            {rec
              ? rec.waitS > 0
                ? L(`Trial ${rec.trial}: recording in ${rec.waitS} s…`, `試行 ${rec.trial}: あと ${rec.waitS} 秒で記録…`)
                : L(`Trial ${rec.trial}: recording… ${rec.leftS} s`, `試行 ${rec.trial}: 記録中… ${rec.leftS}s`)
              : L(`Record 10 s at ${trueM.toFixed(2)} m`, `${trueM.toFixed(2)}m で10秒記録`)}
          </button>
          <button onClick={() => void dropLast()} disabled={off} className="px-3 py-3 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 disabled:opacity-50">
            {L("Delete the last trial", "最後の試行を削除")}
          </button>
        </div>
        {results.length > 0 && (
          <ul className="space-y-1 font-mono">
            {results.map((r, i) => (
              <li key={results.length - i} className={r.ok === false ? "text-rose-300" : "text-slate-200"}>
                {r.message}
              </li>
            ))}
          </ul>
        )}
        <p className="text-slate-500">
          {L(
            "The frames stay on the watch camera. When done, press \"Save CSV\" there (Development and validation → Measure distance accuracy) and summarize it with node scripts/distance-accuracy-report.mjs.",
            "フレームは見守りカメラに残ります。終わったら、見守りカメラの「CSV を保存」（「開発・検証用」→「距離の精度を計測（検証用）」）を押し、node scripts/distance-accuracy-report.mjs で集計します。"
          )}
        </p>
      </div>
    </details>
  );
}
