"use client";

/**
 * Distance accuracy recorder (docs/proof/MEASUREMENT_EVIDENCE.md §1), on the watch phone.
 * Stand on a floor mark whose distance from the screen was measured with a laser meter, enter that
 * distance, and record 10 s of the live `distanceM`. The raw frames are kept on this phone and saved
 * as CSV for `node scripts/distance-accuracy-report.mjs`. Nothing is sent anywhere (a parent phone can start a trial
 * and gets back only that trial's summary line).
 */
import { L } from "@/lib/firesense/i18n";
import { useEffect, useRef, useState } from "react";
import { Ruler } from "lucide-react";
import type { PipelineFrame } from "@/lib/firesense/sensor-pipeline";
import { summarize, toRawCsv } from "@/scripts/distance-accuracy.mjs";
import { storage } from "@/lib/client/storage";
import { TRIAL_LATERALS } from "@/lib/firesense/protocol";

const TRIAL_MS = 10_000;
/** Measuring alone: time to walk from the phone to the mark before recording starts. */
const SOLO_DELAY_MS = 10_000;

/** A short beep (start: high, end: low), so someone standing on the mark knows without looking at the phone. */
export function beep(hz: number) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = hz;
    g.gain.value = 0.2;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
    o.onended = () => void ctx.close();
  } catch {
    // No sound is fine: the screen shows the countdown too.
  }
}
const STORE_KEY = "firesense.camera.distanceTrials";
const LATERALS = TRIAL_LATERALS;
export type Lateral = (typeof TRIAL_LATERALS)[number];

type Sample = {
  trial: number;
  method: string;
  trueM: number;
  lateral: string;
  tMs: number;
  distanceM: number | null;
  state: string;
  confidence: number;
};
type Recording = { trial: number; startMs: number; method: string; trueM: number; lateral: Lateral };

const cm = (m: number | null) => (m === null ? "—" : `${(m * 100).toFixed(1)}cm`);
const lateralText = (l: string) => (l === "center" ? L("in front of the TV", "TVの正面") : L("0.5 m to the side", "横に0.5m"));

/**
 * The recorder itself, kept by the watch camera page so that both its own panel and the parent phone
 * (camera_command `distance_trial`, MEASUREMENT_EVIDENCE §1) start trials on the same data.
 */
export function useDistanceTrials(frame: PipelineFrame | null, method: string | null) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const samplesRef = useRef<Sample[]>([]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [now, setNow] = useState(0);
  const startedRef = useRef(false);
  const doneRef = useRef<{ resolve: (m: string) => void; reject: (e: Error) => void } | null>(null);
  const loaded = useRef(false);

  const put = (xs: Sample[]) => {
    samplesRef.current = xs;
    setSamples(xs);
  };
  useEffect(() => {
    put(storage.getJson<Sample[]>(STORE_KEY) ?? []);
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (loaded.current) storage.setJson(STORE_KEY, samples);
  }, [samples]);

  // One sample per pipeline frame while a trial runs.
  useEffect(() => {
    if (!recording || !frame) return;
    const t = Date.now() - recording.startMs;
    if (t < 0 || t > TRIAL_MS) return; // still walking to the mark, or over (the timer below ends it)
    put([
      ...samplesRef.current,
      { trial: recording.trial, method: recording.method, trueM: recording.trueM, lateral: recording.lateral, tMs: t, distanceM: frame.distanceM, state: frame.state, confidence: frame.confidence },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  useEffect(() => {
    if (!recording) return;
    // Ends the trial on time even if frames stop (e.g. the TV paused, so the camera is off).
    const id = setInterval(() => {
      setNow(Date.now());
      const t = Date.now() - recording.startMs;
      if (t >= 0 && !startedRef.current) {
        startedRef.current = true;
        beep(880);
      }
      if (t > TRIAL_MS) {
        beep(440);
        setRecording(null);
        const done = doneRef.current;
        doneRef.current = null;
        const mine = samplesRef.current.filter((x) => x.trial === recording.trial);
        const where = `${recording.trueM.toFixed(2)} m, ${lateralText(recording.lateral)}`;
        if (mine.length === 0) {
          done?.reject(new Error(L(`Trial ${recording.trial} (${where}): no frames were recorded. Is the camera running (the TV playing)?`, `試行 ${recording.trial}（${where}）: フレームが1つも記録されませんでした。カメラは動いていますか（TVは再生中ですか）？`)));
          return;
        }
        const c = summarize(mine).conditions[0];
        done?.resolve(
          c.mean === null
            ? L(`Trial ${recording.trial} (${where}): no distance in any of ${c.frames} frames (feet not found).`, `試行 ${recording.trial}（${where}）: ${c.frames} フレームすべてで距離なし（足が見つからない）。`)
            : L(
                `Trial ${recording.trial} (${where}): mean ${c.mean.toFixed(2)} m, error ${cm(c.mae)}, no distance ${c.missing}/${c.frames} frames`,
                `試行 ${recording.trial}（${where}）: 平均 ${c.mean.toFixed(2)}m、誤差 ${cm(c.mae)}、距離なし ${c.missing}/${c.frames} フレーム`
              )
        );
      }
    }, 250);
    return () => clearInterval(id);
  }, [recording]);

  /** Starts a trial after `delayMs`; resolves with its summary when the 10 s are over. */
  const start = (trueM: number, lateral: Lateral, delayMs: number): Promise<string> => {
    if (recording) return Promise.reject(new Error(L(`Trial ${recording.trial} is still recording.`, `試行 ${recording.trial} を記録中です。`)));
    if (!method) return Promise.reject(new Error(L("Calibrate the floor first (no distance, nothing to measure).", "先に床のキャリブレーションをしてください（距離が出ていないと計測できません）。")));
    if (!(trueM > 0.3 && trueM < 5)) return Promise.reject(new Error(L(`The true distance ${trueM} m is out of range (0.3–5 m).`, `真の距離 ${trueM}m は範囲外です（0.3〜5m）。`)));
    const trial = samplesRef.current.reduce((m, x) => Math.max(m, x.trial), 0) + 1;
    startedRef.current = false;
    setRecording({ trial, startMs: Date.now() + delayMs, method, trueM, lateral });
    setNow(Date.now());
    return new Promise((resolve, reject) => {
      doneRef.current = { resolve, reject };
    });
  };

  /** Deletes the last trial; returns its number, or null when there is none. */
  const dropLast = (): number | null => {
    if (recording) throw new Error(L(`Trial ${recording.trial} is still recording.`, `試行 ${recording.trial} を記録中です。`));
    const last = samplesRef.current.reduce((m, x) => Math.max(m, x.trial), 0);
    if (last === 0) return null;
    put(samplesRef.current.filter((x) => x.trial !== last));
    return last;
  };

  const clear = () => put([]);

  const left = recording ? Math.max(0, Math.ceil((TRIAL_MS - (now - recording.startMs)) / 1000)) : 0;
  const waiting = recording ? Math.max(0, Math.ceil((recording.startMs - now) / 1000)) : 0;
  const trials = new Set(samples.map((x) => x.trial)).size;
  return { samples, recording, left, waiting, trials, start, dropLast, clear };
}
export type DistanceTrials = ReturnType<typeof useDistanceTrials>;

export function DistanceTrialPanel({ trials, method }: { trials: DistanceTrials; method: string | null }) {
  const { samples, recording, left, waiting } = trials;
  const [trueM, setTrueM] = useState(1.2);
  const [lateral, setLateral] = useState<Lateral>("center");
  const [solo, setSolo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const start = () => {
    setError(null);
    setResult(null);
    trials.start(trueM, lateral, solo ? SOLO_DELAY_MS : 0).then(setResult, (e: Error) => setError(e.message));
  };

  const download = () => {
    const blob = new Blob([toRawCsv(samples)], { type: "text/csv" });
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    a.href = URL.createObjectURL(blob);
    a.download = `distance-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const sum = summarize(samples);

  return (
    <details className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-xs space-y-3">
      <summary className="text-sm font-bold text-white cursor-pointer flex items-center gap-2">
        <Ruler className="w-4 h-4 text-sky-400" />{L(" Measure distance accuracy (validation)", " 距離の精度を計測（検証用）")}
      </summary>
      <p className="text-slate-400 mt-2">
        {L(
          "Stand on a floor mark measured from the screen with a laser meter, enter that distance, and press \"Record 10 s\". Saved on this device only; summarize the CSV with",
          "画面からの距離をレーザー距離計で測った床の印に立ち、その距離を入れて「10秒記録」。この端末に保存され、CSV を"
        )}
        <code className="mx-1">node scripts/distance-accuracy-report.mjs</code>
        {L("(docs/proof/MEASUREMENT_EVIDENCE.md §1). The frames stay on this device; a parent phone that starts a trial gets only its one-line summary.", "で集計します（docs/proof/MEASUREMENT_EVIDENCE.md §1）。フレームはこの端末から出ません。保護者のスマホから始めた試行は、その1行の結果だけを返します。")}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-slate-400">
          {L("True distance (m)", "真の距離（m）")}
          <input
            type="number"
            step={0.01}
            value={trueM}
            disabled={recording !== null}
            onChange={(e) => setTrueM(Number(e.target.value))}
            className="w-24 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-white font-mono"
          />
        </label>
        <div className="flex gap-1">
          {LATERALS.map((l) => (
            <button
              key={l}
              disabled={recording !== null}
              onClick={() => setLateral(l)}
              className={`px-3 py-1.5 rounded-lg border ${lateral === l ? "bg-sky-700 border-sky-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}
            >
              {l === "center" ? L("In front of the TV", "TVの正面") : L("0.5 m to the side", "横に0.5m")}
            </button>
          ))}
        </div>
        <button onClick={start} disabled={recording !== null} className="px-3 py-1.5 rounded-lg bg-sky-600 text-white font-bold disabled:opacity-50">
          {recording && waiting > 0
            ? L(`Go to the mark… recording in ${waiting}s`, `印へ… あと ${waiting} 秒で記録`)
            : recording
            ? L(`Recording… ${left}s`, `記録中… ${left}s`)
            : L("Record 10 s", "10秒記録")}
        </button>
      </div>
      <label className="flex items-center gap-2 text-slate-300">
        <input type="checkbox" checked={solo} disabled={recording !== null} onChange={(e) => setSolo(e.target.checked)} />
        {L(
          "Measuring alone: start 10 s after the press (walk to the mark; a high beep starts, a low beep ends)",
          "一人で測る: 押してから10秒後に記録開始（その間に印へ。高い音で開始、低い音で終了）"
        )}
      </label>
      <p className="text-slate-500">
        {L("Calibration method", "キャリブレーション方法")}: {method ?? L("not calibrated", "未キャリブレーション")} {L("(recorded with each trial)", "（試行ごとに記録されます）")}
      </p>
      <p className="text-slate-500">
        {L("A parent phone can start trials too (its \"Measure distance accuracy\"), so you can stay on the mark.", "保護者のスマホからも試行を始められます（その「距離の精度を計測」）。印の上にいたまま回せます。")}
      </p>
      {result && <p className="text-emerald-300">{result}</p>}
      {error && <p className="text-rose-300">{error}</p>}

      {sum.conditions.length > 0 && (
        <>
          <table className="w-full text-left font-mono">
            <thead className="text-slate-500">
              <tr>
                <th>{L("Method", "方法")}</th>
                <th>{L("True", "真値")}</th>
                <th>{L("Position", "位置")}</th>
                <th>{L("Mean", "平均")}</th>
                <th>MAE</th>
                <th>{L("Missing", "欠測")}</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {sum.conditions.map((c) => (
                <tr key={`${c.method}|${c.trueM}|${c.lateral}`}>
                  <td>{c.method}</td>
                  <td>{c.trueM.toFixed(2)}m</td>
                  <td>{c.lateral}</td>
                  <td>{c.mean === null ? "—" : `${c.mean.toFixed(2)}m`}</td>
                  <td>{cm(c.mae)}</td>
                  <td>
                    {c.missing}/{c.frames}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sum.overall.map((o) => (
            <p key={o.method} className="text-slate-300">
              {o.method}: {L("median error", "誤差の中央値")} <b className="text-white">{cm(o.medianAbsError)}</b>{" "}
              {L(
                `(p90 ${cm(o.p90AbsError)}, max ${cm(o.maxAbsError)}, no distance ${o.missing}/${o.frames} frames)`,
                `（p90 ${cm(o.p90AbsError)}、最大 ${cm(o.maxAbsError)}、距離なし ${o.missing}/${o.frames} フレーム）`
              )}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            <button onClick={download} disabled={recording !== null} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white">
              {L("Save CSV", "CSV を保存")}
            </button>
            <button onClick={() => trials.dropLast()} disabled={recording !== null} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300">
              {L("Delete the last trial", "最後の試行を削除")}
            </button>
            <button
              onClick={() => window.confirm(L("Delete all measurement data?", "計測データをすべて消しますか？")) && trials.clear()}
              disabled={recording !== null}
              className="px-3 py-1.5 rounded-lg bg-slate-800 border border-rose-900 text-rose-300"
            >
              {L("Delete all", "すべて消去")}
            </button>
          </div>
        </>
      )}
    </details>
  );
}
