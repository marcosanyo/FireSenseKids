"use client";

import { L } from "@/lib/firesense/i18n";
import { useEffect, useState } from "react";
import { Sliders, Tv, VolumeX, Eye, PauseCircle, Check } from "lucide-react";
import { DEFAULT_TV_SETTINGS, type TvSettings } from "../lib/firesense/protocol";
import { TouchSlider } from "@/components/touch-slider";

export interface TvSettingsPanelProps {
  tvSettings: TvSettings | null;
  /** False when the message could not be sent (not connected to the relay). */
  saveTvSettings: (settings: TvSettings) => boolean;
  tvOnline: boolean;
}

export function TvSettingsPanel({ tvSettings, saveTvSettings, tvOnline }: TvSettingsPanelProps) {
  const [draft, setDraft] = useState<TvSettings>(tvSettings ?? DEFAULT_TV_SETTINGS);
  const [savedBadge, setSavedBadge] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (tvSettings) {
      setDraft(tvSettings);
    }
  }, [tvSettings]);

  const update = (patch: Partial<TvSettings> | { pause: Partial<TvSettings["pause"]> }) => {
    let next: TvSettings;
    if ("pause" in patch && patch.pause) {
      next = {
        ...draft,
        pause: {
          ...draft.pause,
          ...patch.pause,
        },
      };
    } else {
      next = {
        ...draft,
        ...(patch as Partial<TvSettings>),
      };
    }
    setDraft(next);
    if (!saveTvSettings(next)) {
      setSendError(L("Not connected to the relay, so it could not be saved.", "中継に接続していないため、保存できませんでした。"));
      return;
    }
    setSendError(null);
    setSavedBadge(true);
    setTimeout(() => setSavedBadge(false), 2000);
  };

  return (
    <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Tv className="w-4 h-4 text-orange-400" />{L(" How the TV responds", " テレビでの見せ方")}
        </h2>
        {savedBadge && (
          <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-950/80 border border-emerald-800/80 px-2 py-0.5 rounded-full animate-fade-in">
            <Check className="w-3 h-3" />{L(" Saved", " 保存しました")}
          </span>
        )}
      </div>

      <p className="text-xs text-slate-400">
        {L("How the TV keeps your rule, without scolding.", "決めたルールを叱りつけるのではなく自然に守らせるための、テレビ画面の見せ方の設定です。")}
        {tvOnline ? L(" (the TV is connected now)", "（現在TV接続中）") : L(" (you can save while the TV is off; it applies the next time the TV connects)", "（TV未接続でも保存でき、次にTVがつながったときに反映されます）")}
      </p>

      {sendError && <p className="text-xs text-rose-300">{sendError}</p>}

      <div className="space-y-3">
        {/* 1. Child cues */}
        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="toggle-child-cues" className="text-xs font-bold text-slate-200 flex items-center gap-2 cursor-pointer">
              <VolumeX className="w-4 h-4 text-slate-400" />{L(" Child-friendly cues and stars", " 子ども向けの声かけと星")}
            </label>
            <input
              id="toggle-child-cues"
              type="checkbox"
              checked={draft.childCues}
              onChange={(e) => update({ childCues: e.target.checked })}
              className="w-4 h-4 accent-orange-500 rounded cursor-pointer"
            />
          </div>
          <p className="text-[11px] text-slate-400">
            {L("Shows a card and a voice line when the child comes close, and a star and a sound when they step back. Off: only the blur and the marker.", "近づいたときのカード・声かけや、離れたときの星と効果音を出します（オフにすると、ぼかしと目印だけで自然に距離を保ちます）。")}
          </p>
        </div>

        {/* 2. Marker */}
        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="toggle-marker" className="text-xs font-bold text-slate-200 flex items-center gap-2 cursor-pointer">
              <Eye className="w-4 h-4 text-slate-400" />{L(" Small marker", " 小さな目印")}
            </label>
            <input
              id="toggle-marker"
              type="checkbox"
              checked={draft.marker}
              onChange={(e) => update({ marker: e.target.checked })}
              className="w-4 h-4 accent-orange-500 rounded cursor-pointer"
            />
          </div>
          <p className="text-[11px] text-slate-400">
            {L("A small marker (a floor line and an arrow) at the bottom center while the viewer is close. No character, no sound.", "近づいたときに画面の下端中央に小さな目印（足あと／床ライン）を出します（キャラクターや音はありません）。")}
          </p>
        </div>

        {/* 3. Pause */}
        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 space-y-3">
          <div className="flex items-center justify-between">
            <label htmlFor="toggle-pause" className="text-xs font-bold text-slate-200 flex items-center gap-2 cursor-pointer">
              <PauseCircle className="w-4 h-4 text-slate-400" />{L(" Pause after sustained too-close viewing (stronger rule)", " 近すぎが続いたら一時停止（より強いルール）")}
            </label>
            <input
              id="toggle-pause"
              type="checkbox"
              checked={draft.pause.enabled}
              onChange={(e) => update({ pause: { enabled: e.target.checked } })}
              className="w-4 h-4 accent-orange-500 rounded cursor-pointer"
            />
          </div>
          <p className="text-[11px] text-slate-400">
            {L("Off by default (blur and dimming only; stepping back restores the picture). On: the video pauses after the viewer stays too close, and resumes 2 s after they step back.", "標準はオフです（ぼかしと減光だけで、下がれば元に戻ります）。オンにすると、近すぎた状態が続いたときに動画を一時停止し、離れると2秒後に自動で再開します。")}
          </p>

          {draft.pause.enabled && (
            <div className="pt-2 border-t border-slate-800/80 space-y-1">
              <div className="flex justify-between text-xs text-slate-300">
                <span>{L("Pause after", "一時停止までの時間")}</span>
                <span className="font-mono font-bold text-orange-400">{draft.pause.afterSeconds} s</span>
              </div>
              <TouchSlider
                label={L("Pause after", "一時停止までの時間")}
                accent="#f97316"
                min={10}
                max={60}
                step={5}
                value={draft.pause.afterSeconds}
                onChange={(v) => update({ pause: { afterSeconds: v } })}
              />
              <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                <span>{L("10 s", "10秒")}</span>
                <span>{L("20 s (default)", "20秒（標準）")}</span>
                <span>{L("60 s", "60秒")}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
