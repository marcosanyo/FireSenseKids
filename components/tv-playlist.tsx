"use client";

/**
 * Parent phone: what the TV plays.
 *  - Presets: one tap.
 *  - The family's own list: add videos one at a time (title + URL, or a sample with one tap), reorder,
 *    remove. Every change is saved with the session (DynamoDB, via the relay), so all parent phones
 *    share the same list. Before an item is added, this phone checks the TV can fetch it (https, CORS,
 *    a video), so a broken URL is refused here with the reason.
 *  - Next / previous, and what is playing now (reported by the TV, with its raw error if an item fails).
 */

import { L } from "@/lib/firesense/i18n";
import { useState } from "react";
import { ArrowDown, ArrowUp, Film, ListPlus, Play, SkipBack, SkipForward, Trash2 } from "lucide-react";
import type { Playlist, PlaylistItem, TvControl, TvNowPlaying } from "@/lib/firesense";
import { checkVideoUrl, MAX_CUSTOM_ITEMS, parsePlaylistItem, playlistPresets, sampleItems, withItem } from "@/lib/client/playlists";
import { Banner } from "@/components/ui";

type Result = { ok: boolean; text: string } | null;

export function TvPlaylistPanel({
  tvOnline,
  nowPlaying,
  library,
  sendPlaylist,
  sendControl,
  saveLibrary,
}: {
  tvOnline: boolean;
  nowPlaying: TvNowPlaying | null;
  /** The family's saved list (from the relay); undefined until it arrives. */
  library: Playlist | null | undefined;
  /** Each returns false when the message could not be sent (not connected to the relay). */
  sendPlaylist: (p: Playlist) => boolean;
  sendControl: (a: TvControl["action"]) => boolean;
  saveLibrary: (p: Playlist | null) => boolean;
}) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const notSent: Result = { ok: false, text: L("Not connected to the relay, so it was not sent.", "中継に接続していないため、送れませんでした。") };

  const play = (p: Playlist) => {
    if (!tvOnline) return setResult({ ok: false, text: L("The TV is not connected to the relay, so it cannot be sent. Open the app on the TV.", "TVが中継に接続されていないため送れません。TVでアプリを開いてください。") });
    setResult(sendPlaylist(p) ? { ok: true, text: L(`Sent "${p.title}" to the TV.`, `「${p.title}」をTVに送りました。`) } : notSent);
  };
  const save = (next: Playlist | null, message: string) => setResult(saveLibrary(next) ? { ok: true, text: message } : notSent);

  const add = async (item: PlaylistItem) => {
    if (library === undefined) return setResult({ ok: false, text: L("The saved list has not arrived yet. Wait for the relay connection.", "保存済みのリストをまだ受け取っていません。中継への接続を待ってください。") });
    setChecking(item.title);
    setResult(null);
    try {
      await checkVideoUrl(item.url);
      save(withItem(library, item), L(`Added "${item.title}" to the list.`, `「${item.title}」をリストに追加しました。`));
      setTitle("");
      setUrl("");
    } catch (err) {
      setResult({ ok: false, text: L(`Cannot add "${item.title}": ${(err as Error).message}`, `「${item.title}」は追加できません: ${(err as Error).message}`) });
    } finally {
      setChecking(null);
    }
  };
  const addTyped = () => {
    try {
      void add(parsePlaylistItem(title, url));
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    }
  };
  const move = (i: number, delta: number) => {
    if (!library) return;
    const items = [...library.items];
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    save({ ...library, items }, L("Reordered.", "並べ替えました。"));
  };
  const remove = (i: number) => {
    if (!library) return;
    const items = library.items.filter((_, k) => k !== i);
    save(items.length ? { ...library, items } : null, L(`Removed "${library.items[i].title}".`, `「${library.items[i].title}」を外しました。`));
  };

  const host = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return u;
    }
  };

  return (
    <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
      <h2 className="text-sm font-bold text-white flex items-center gap-2">
        <Film className="w-4 h-4 text-orange-400" />{L(" Videos on the TV", " TVの動画")}
      </h2>

      <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs space-y-1">
        {nowPlaying ? (
          <>
            <div className="text-slate-400">
              {L("Playing", "再生中")} ({nowPlaying.playlistTitle} · {nowPlaying.index + 1}/{nowPlaying.count})
            </div>
            <div className="text-white font-bold">{nowPlaying.title}</div>
            {nowPlaying.error && <div className="text-rose-300 break-all">{nowPlaying.error}</div>}
          </>
        ) : (
          <div className="text-slate-500">{L("Nothing from the TV about playback yet.", "TVからの再生状況はまだ届いていません。")}</div>
        )}
        <div className="flex gap-2 pt-1">
          <button onClick={() => !sendControl("previous") && setResult(notSent)} disabled={!tvOnline} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white disabled:opacity-40 flex items-center gap-1">
            <SkipBack className="w-3.5 h-3.5" />{L(" Previous", " 前の動画")}
          </button>
          <button onClick={() => !sendControl("next") && setResult(notSent)} disabled={!tvOnline} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white disabled:opacity-40 flex items-center gap-1">
            {L("Next ", "次の動画 ")}<SkipForward className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="text-xs font-bold text-slate-300">{L("Picks (one tap sends to the TV)", "おすすめ（ワンタップでTVへ）")}</div>
      <div className="grid gap-2">
        {playlistPresets().map((p) => (
          <button
            key={p.id}
            onClick={() => play(p)}
            className={`text-left px-3 py-2 rounded-xl border ${nowPlaying?.playlistId === p.id ? "bg-orange-950/60 border-orange-600" : "bg-slate-800 border-slate-700"}`}
          >
            <div className="text-sm font-bold text-white">{p.title}</div>
            <div className="text-xs text-slate-400">{p.description}</div>
          </button>
        ))}
      </div>

      <div className="pt-1 space-y-2">
        <div className="text-xs font-bold text-slate-300 flex items-center gap-1">
          <ListPlus className="w-3.5 h-3.5" /> {L("Our list", "うちのリスト")} ({library?.items.length ?? 0}/{MAX_CUSTOM_ITEMS}, {L("shared by all parent phones", "保護者のスマホ全台で共有")})
        </div>
        {library === undefined && <p className="text-xs text-slate-500">{L("Loading the saved list…", "保存済みのリストを読み込んでいます…")}</p>}
        {library?.items.length ? (
          <ol className="space-y-1">
            {library.items.map((it, i) => (
              <li key={`${i}-${it.url}`} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800">
                <span className="text-slate-500 text-xs w-4">{i + 1}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-white truncate">{it.title}</span>
                  <span className="block text-[11px] text-slate-500 truncate">{host(it.url)}</span>
                </span>
                <button aria-label={L("Move up", "上へ")} onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-slate-300 disabled:opacity-30">
                  <ArrowUp className="w-4 h-4" />
                </button>
                <button aria-label={L("Move down", "下へ")} onClick={() => move(i, 1)} disabled={i === library.items.length - 1} className="p-1 text-slate-300 disabled:opacity-30">
                  <ArrowDown className="w-4 h-4" />
                </button>
                <button aria-label={L("Remove", "外す")} onClick={() => remove(i)} className="p-1 text-rose-300">
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          library !== undefined && <p className="text-xs text-slate-500">{L("No videos yet. Add some below.", "まだ動画がありません。下から追加してください。")}</p>
        )}
        <button
          onClick={() => library && play(library)}
          disabled={!library?.items.length}
          className="w-full px-3 py-2 rounded-xl bg-orange-600 text-white font-bold disabled:opacity-40 flex items-center justify-center gap-1"
        >
          <Play className="w-4 h-4" />{L(" Play our list on the TV", " うちのリストをTVで流す")}
        </button>

        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-xs">
          <div className="text-slate-300 font-bold">{L("Add a video", "動画を1本追加")}</div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L("Title (optional)", "タイトル（なくてもよい）")} className="w-full p-2 rounded-lg bg-slate-900 border border-slate-700 text-white" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={L("https://… (an mp4 / webm video file)", "https://…（mp4 / webm の動画ファイル）")} inputMode="url" className="w-full p-2 rounded-lg bg-slate-900 border border-slate-700 text-white font-mono text-[11px]" />
          <button onClick={addTyped} disabled={!url.trim() || checking !== null} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white font-bold disabled:opacity-40">
            {checking ? L(`Checking "${checking}"…`, `「${checking}」を確認中…`) : L("Check and add", "確認して追加")}
          </button>
          <p className="text-slate-500">
            {L(
              "Checks that the TV can load it (https, CORS, a video) before adding. Streaming services such as YouTube cannot be used (their terms do not allow a blur on top). On a real Fire TV, H.264 and VP9 at 480p or more can show green stripes; AV1 is recommended (all picks and samples are AV1).",
              "TVが読み込めるか（https・CORS・動画であること）を確かめてから追加します。YouTube などの配信サービスは使えません（ぼかしを重ねることが規約で認められていないため）。Fire TV（実機）では、H.264 や 480p 以上の VP9 の動画に緑の縞が出ることがあります。AV1 形式の動画をおすすめします（サンプルとおすすめはすべて AV1）。"
            )}
          </p>
          <div className="text-slate-300 font-bold pt-1">{L("Samples (tap to add)", "サンプル（タップで追加）")}</div>
          <div className="flex flex-wrap gap-2">
            {sampleItems().map((s) => (
              <button key={s.url} onClick={() => void add(s)} disabled={checking !== null} className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-left disabled:opacity-40">
                <span className="block text-white">＋ {s.title}</span>
                <span className="block text-[10px] text-slate-400">{s.note}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {result &&
        (result.ok ? (
          <p className="text-xs text-emerald-400">{result.text}</p>
        ) : (
          <Banner tone="error" title={L("Could not do it", "できませんでした")}>
            <span className="whitespace-pre-line">{result.text}</span>
          </Banner>
        ))}
      <p className="text-[11px] text-slate-500">
        {L("Picks and samples: Blender Foundation open movies (CC BY 3.0 / 4.0) and the public-domain To Spring (1936) and Gulliver's Travels (1939), transcoded to AV1 and served by us (content unchanged). The TV shows each film's credit at its start.", "おすすめとサンプルの動画: Blender Foundation のオープンムービー（CC BY 3.0 / 4.0）と、パブリックドメインの To Spring（1936年）・ガリバー旅行記（1939年）を AV1 に変換して配信しています（内容は変えていません）。TVでは各動画の始めにクレジットを表示します。")}
      </p>
    </section>
  );
}
