"use client";

/**
 * The detection model choice, shown up front on the watch camera and on the parent phone.
 *
 * Two choices by what they cost and give, not by model name: Standard (MediaPipe, light, with posture and the
 * seated / hidden-feet distance), or High accuracy (RTMO, finds people who appear small or far away, but heavy
 * and needs a recent device with working WebGPU). The size (s / m / l) is a second, smaller choice.
 * Nothing switches by itself; the cost is shown, not hidden.
 */

import { POSE_MODEL_INFO } from "@/lib/client/pose-estimator";
import { L } from "@/lib/firesense/i18n";
import type { PoseModelId } from "@/lib/firesense/protocol";

const RTMO_SIZES: PoseModelId[] = ["rtmo-s", "rtmo-m", "rtmo-l"];
/** Slower than this per frame: say so (the distance then updates about once a second or less). */
export const SLOW_INFERENCE_MS = 400;

export function WhoWatches({
  value,
  disabled,
  inferenceMs,
  onPick,
}: {
  /** The model in use (or chosen, before watching starts); null = not loaded. */
  value: PoseModelId | null;
  disabled?: boolean;
  /** Last inference time on the watch camera, if running. */
  inferenceMs?: number | null;
  onPick: (m: PoseModelId) => void;
}) {
  const kids = value !== null && value !== "mediapipe-full";
  const slow = typeof inferenceMs === "number" && inferenceMs > SLOW_INFERENCE_MS;
  const card = (on: boolean) =>
    `flex-1 min-w-[9rem] p-3 rounded-xl border-2 text-left disabled:opacity-60 ${on ? "border-orange-400 bg-orange-500/15" : "border-slate-700 bg-slate-800/60"}`;
  return (
    <div className="space-y-2">
      <div className="text-sm font-bold text-white">{L("Detection model", "検出モデル")}</div>
      <div className="flex flex-wrap gap-2">
        <button disabled={disabled || value === "mediapipe-full"} onClick={() => onPick("mediapipe-full")} className={card(value === "mediapipe-full")}>
          <div className="text-2xl">⚡</div>
          <div className="font-bold text-white text-sm">{L("Standard", "標準")}</div>
          <div className="text-[11px] text-slate-300">{L("Light, any phone. Also posture, sitting and hidden feet.", "軽い・どのスマホでも。姿勢・座り・足が隠れたときも判定")}</div>
          <div className="text-[10px] text-slate-500 mt-1">MediaPipe Pose</div>
        </button>
        <button disabled={disabled || kids} onClick={() => onPick("rtmo-s")} className={card(kids)}>
          <div className="text-2xl">🎯</div>
          <div className="font-bold text-white text-sm">{L("High accuracy", "高精度")}</div>
          <div className="text-[11px] text-slate-300">{L("Also finds people who appear small or far away.", "小さく映る人や遠くの人も見つける")}</div>
          <div className="text-[11px] text-amber-300">{L("Heavy: a recent phone or tablet with WebGPU.", "重い: WebGPU が動く新しめのスマホ・タブレット向け")}</div>
          <div className="text-[10px] text-slate-500 mt-1">RTMO</div>
        </button>
      </div>
      {kids && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
          {L("Size", "サイズ")}
          {RTMO_SIZES.map((m) => (
            <button
              key={m}
              disabled={disabled || m === value}
              onClick={() => onPick(m)}
              className={`px-2.5 py-1 rounded-lg font-bold border disabled:opacity-60 ${m === value ? "bg-white text-slate-900 border-white" : "bg-slate-800 text-slate-200 border-slate-600"}`}
            >
              {POSE_MODEL_INFO[m].label.replace("RTMO-", "")} <span className="font-normal opacity-70">{POSE_MODEL_INFO[m].size}</span>
            </button>
          ))}
          <span className="text-[11px] text-slate-500">{L("s fastest · l most accurate", "s が速い・l が正確")}</span>
        </div>
      )}
      {kids && (
        <p className="text-[11px] text-slate-400">
          {L(
            "No posture with RTMO. Feet hidden: from the hips for up to 4 s after the feet were seen. Tested: works on Galaxy S26 and iPad mini 7; on Galaxy S20 the GPU gives wrong results (the self-test stops it with the reason).",
            "RTMO は姿勢の判定なし。足が隠れたら、足が見えてから4秒まで腰から推定。確認済み: Galaxy S26・iPad mini 7 で動作、Galaxy S20 は GPU の結果が不正（自己診断が理由つきで止めます）。"
          )}
        </p>
      )}
      {slow && (
        <p className="text-[11px] text-amber-300">
          {L(
            `Slow on this device (${inferenceMs} ms per frame): the distance updates about ${Math.max(0.1, Math.round(10000 / (inferenceMs as number)) / 10)} times a second.`,
            `この端末では重い（1回 ${inferenceMs}ms）: 距離の更新は1秒に約${Math.max(0.1, Math.round(10000 / (inferenceMs as number)) / 10)}回です。`
          )}
        </p>
      )}
    </div>
  );
}
