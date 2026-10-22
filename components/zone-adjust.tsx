"use client";

/**
 * After the TV-marker calibration: make the distances match a tape measure, and move / turn the watch
 * zone by hand. Used on the camera phone (applied directly) and on the parent phone (sent as commands).
 * The zone lines on the preview follow every change, so the parent can see where the floor lines land.
 */

import { L } from "@/lib/firesense/i18n";
import { useEffect, useRef, useState } from "react";
import { ADJUST_LIMITS, NO_ADJUST, type ZoneAdjust } from "@/lib/firesense";
import { TouchSlider } from "@/components/touch-slider";

export function ZoneAdjustPanel({
  adjust,
  measuredPoints,
  disabled,
  slidersDisabled = disabled,
  onAdjust,
  onMeasure,
}: {
  /** Current correction; null = the calibration is not a TV-marker one (nothing to adjust). */
  adjust: ZoneAdjust | null;
  measuredPoints: number;
  /** The buttons (tape-measure points, reset). */
  disabled: boolean;
  /**
   * The sliders. On the parent phone they stay usable while a command is on its way (only a lost connection
   * disables them): a slider that turns disabled under the finger ends the drag on iPad Safari.
   */
  slidersDisabled?: boolean;
  /** Apply or send; a promise (the parent phone's command) keeps the camera's value from overwriting the draft until it settles. */
  onAdjust: (a: ZoneAdjust) => void | Promise<unknown>;
  onMeasure: (trueM: number, step: 1 | 2) => void;
}) {
  const [draft, setDraft] = useState<ZoneAdjust>(adjust ?? NO_ADJUST);
  const [trueM, setTrueM] = useState(1.0);
  const editingUntilRef = useRef(0);
  const inFlightRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the camera's value, except while this phone is editing: during a drag, while a change is on its way to
  // the camera, and 1.5 s after it was applied (a status sent before the change may still arrive, which would make
  // the thumb jump back).
  useEffect(() => {
    if (adjust && inFlightRef.current === 0 && Date.now() > editingUntilRef.current) setDraft(adjust);
  }, [adjust]);
  useEffect(() => () => void (timerRef.current && clearTimeout(timerRef.current)), []);

  if (!adjust) return <p className="text-[11px] text-slate-500">{L("After TV-marker calibration you can fine-tune with a tape measure and adjust the zone.", "TVマーカーでキャリブレーションすると、実測での補正とエリアの調整ができます。")}</p>;

  const edit = (patch: Partial<ZoneAdjust>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    editingUntilRef.current = Date.now() + 1500;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      inFlightRef.current++;
      void Promise.resolve(onAdjust(next)).finally(() => {
        inFlightRef.current--;
        editingUntilRef.current = Math.max(editingUntilRef.current, Date.now() + 1500);
      });
    }, 300);
  };
  const row = (label: string, key: keyof ZoneAdjust, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <div className="space-y-0.5">
      <span className="flex justify-between text-slate-400">
        <span>{label}</span>
        <span className="font-mono text-white">{fmt(draft[key])}</span>
      </span>
      <TouchSlider label={label} min={min} max={max} step={step} value={draft[key]} disabled={slidersDisabled} onChange={(v) => edit({ [key]: v })} />
    </div>
  );
  const signed = (v: number, unit: string, digits = 2) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}${unit}`;

  return (
    <div className="space-y-3 text-xs">
      <div className="rounded-lg border border-slate-800 p-2 space-y-2">
        <div className="font-bold text-slate-200">{L("Watch zone position and rotation", "見守りエリアの位置と向き")}</div>
        <p className="text-slate-400">{L("Move the red and green lines so they lie on the floor in front of the TV (the view updates at once).", "映像の赤と緑の線が、床の上でテレビの前に来るように動かします（すぐ映像に反映されます）。")}</p>
        {row(L("Shift left/right (+ = right, facing the TV)", "左右にずらす（テレビに向かって右が＋）"), "dxM", -ADJUST_LIMITS.shiftM, ADJUST_LIMITS.shiftM, 0.05, (v) => signed(v, "m"))}
        {row(L("Shift forward/back (+ = into the room)", "前後にずらす（部屋の奥が＋）"), "dzM", -ADJUST_LIMITS.shiftM, ADJUST_LIMITS.shiftM, 0.05, (v) => signed(v, "m"))}
        {row(L("Rotate", "向きを回す"), "angleDeg", -ADJUST_LIMITS.angleDeg, ADJUST_LIMITS.angleDeg, 1, (v) => signed(v, "°", 0))}
        {row(L("Distance scale", "距離の倍率"), "scale", ADJUST_LIMITS.scaleMin, ADJUST_LIMITS.scaleMax, 0.01, (v) => `×${v.toFixed(2)}`)}
        <button
          disabled={disabled}
          onClick={() => {
            setDraft(NO_ADJUST);
            onAdjust(NO_ADJUST);
          }}
          className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white disabled:opacity-40"
        >
          {L("Reset all adjustments", "調整をすべて元に戻す")}
        </button>
      </div>
      <div className="rounded-lg border border-slate-800 p-2 space-y-2">
        <div className="font-bold text-slate-200">{L("Match the distance with a tape measure", "距離を実測で合わせる（メジャー）")}</div>
        <p className="text-slate-400">
          {L("Have someone stand at a spot measured from the TV screen, with their feet in view, press, and hold still for 3 s. One point fixes the offset; a second point at least 0.5 m away also fixes the scale.", "テレビの画面からメジャーで測った位置に、足元が映るように立ってもらい、押してから3秒そのまま。1点で距離のずれ、0.5m 以上離れた2点目で遠近の伸び縮みも合わせます。")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-slate-300">
            {L("From the screen", "画面から")}
            <input
              type="number"
              min={0.2}
              max={3.5}
              step={0.05}
              value={trueM}
              onChange={(e) => setTrueM(Number(e.target.value))}
              className="w-16 rounded bg-slate-900 border border-slate-700 px-1 py-0.5 text-white"
            />
            m
          </label>
          <button disabled={disabled} onClick={() => onMeasure(trueM, 1)} className="px-3 py-1.5 rounded-lg bg-orange-700 text-white font-bold disabled:opacity-40">
            {L("Record point 1", "1点目を記録")}
          </button>
          <button disabled={disabled || measuredPoints < 1} onClick={() => onMeasure(trueM, 2)} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white disabled:opacity-40">
            {L("Record point 2", "2点目を記録")}
          </button>
          <span className="text-slate-500">{L("Recorded", "記録済み")} {measuredPoints}/2</span>
        </div>
      </div>

    </div>
  );
}
