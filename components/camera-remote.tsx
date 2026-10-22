"use client";

/**
 * The parent phone's remote for the installed watch camera: its live state, the mode,
 * thresholds, screen blackout, calibration, and a live preview.
 *
 * Commands go through the relay as numbers (camera_command); the camera applies them and
 * answers (camera_command_result). The preview is WebRTC straight from the camera phone
 * inside the home network (lib/client/rtc.ts): no server ever carries the video.
 */

import { POSE_MODEL_INFO } from "@/lib/client/pose-estimator";
import { L, speechLang } from "@/lib/firesense/i18n";
import { ZoneAdjustPanel } from "@/components/zone-adjust";
import { TouchSlider } from "@/components/touch-slider";
import { WhoWatches } from "@/components/who-watches";
import { RemoteDistanceTrial } from "@/components/remote-distance-trial";
import { useCallback, useEffect, useRef, useState } from "react";
import { MODES, type CameraCommand, type CameraSettings, type CameraStatus, type RtcSignal } from "@/lib/firesense/protocol";
import { MODE_LABEL } from "@/lib/client/mode";
import { iceGatheringComplete, previewNetworkHint, RTC_CONFIG } from "@/lib/client/rtc";
import { Banner, Pill } from "@/components/ui";
import { POSTURE_LABEL, STATE_LABEL } from "@/lib/client/labels";
import { Camera, Moon, Ruler, SlidersHorizontal, Tv, Video } from "lucide-react";

export type CommandOutcome = { id: number; label: string; ok: boolean | null; message: string; at: number };

export interface CameraRemoteProps {
  status: CameraStatus | null;
  /** The camera phone is connected to the relay. */
  cameraOnline: boolean;
  sendCommand: (command: CameraCommand, label: string) => Promise<CommandOutcome>;
  outcomes: CommandOutcome[];
  sendSignal: (kind: "offer" | "hangup", peerId: string, sdp?: string) => boolean;
  onSignal: (cb: (m: RtcSignal) => void) => () => void;
}

const STALE_MS = 4000;
// Getters: the language is set after this module loads.
const METHOD_TEXT: Record<string, string> = {
  get tv_marker() { return L("TV marker", "TVマーカー"); },
  get tap() { return L("Tapped lines", "タップ"); },
  get geometry() { return L("Approximate (height, tilt, field of view)", "簡易（高さ・傾き・画角）"); },
  get stand() { return L("Two standing points", "立って測る2点"); },
};

export function CameraRemote(props: CameraRemoteProps) {
  const { status, cameraOnline, sendCommand, outcomes } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (command: CameraCommand, label: string) => {
      setBusy(label);
      try {
        return await sendCommand(command, label);
      } finally {
        setBusy(null);
      }
    },
    [sendCommand]
  );

  // Threshold drafts follow the camera, except while the parent is editing: during a drag, while the change is on its
  // way, and 1.5 s after the camera answered (a status sent before the change may still arrive and snap it back).
  const [draft, setDraft] = useState<CameraSettings | null>(null);
  const editedAtRef = useRef(0);
  const inFlightRef = useRef(0);
  const pendingRef = useRef<{ key: keyof CameraSettings; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    if (status && inFlightRef.current === 0 && Date.now() - editedAtRef.current > 1500) setDraft(status.settings);
  }, [status]);
  const editSetting = (key: keyof CameraSettings, value: number) => {
    editedAtRef.current = Date.now();
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    if (pendingRef.current) clearTimeout(pendingRef.current.timer);
    pendingRef.current = {
      key,
      timer: setTimeout(() => {
        pendingRef.current = null;
        inFlightRef.current++;
        void run({ kind: "set_settings", settings: { [key]: value } }, L("Change thresholds", "しきい値の変更")).finally(() => {
          inFlightRef.current--;
          editedAtRef.current = Date.now();
        });
      }, 400),
    };
  };

  const [tv, setTv] = useState<{ inches: number; heightCm: number; screenBottomCm?: number | null } | null>(null);
  useEffect(() => {
    if (status && !tv) setTv(status.tvCalibration);
  }, [status, tv]);

  // Setup (calibration, distances, watch zone, zoom area) is folded and locked once calibrated: it is set once and
  // then left alone, and a scroll that starts on a slider would move it. "Change setup" opens it, "Done" locks it.
  const [editing, setEditing] = useState<boolean | null>(null);
  // Decided once, from the first status: not calibrated yet = the first setup, which stays open until "Done"
  // (it must not fold the moment the calibration succeeds, in the middle of fitting the lines).
  useEffect(() => {
    if (status && editing === null) setEditing(!status.calibration);
  }, [status, editing]);
  const setupOpen = editing ?? !status?.calibration;

  const age = status ? now - status.sentAt : null;
  const stale = age !== null && age > STALE_MS;
  const usable = cameraOnline && status !== null && !stale;
  const disabled = !usable || busy !== null || Boolean(status?.busy);

  return (
    <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
      <h2 className="text-sm font-bold text-white flex items-center gap-2">
        <Camera className="w-4 h-4 text-orange-400" />{L(" Watch camera (adjust it where it stands)", " 見守りカメラ（設置したまま調整）")}
      </h2>

      {!cameraOnline && (
        <Banner tone="warn" title={L("The watch camera is not connected to the relay", "見守りカメラが中継につながっていません")}>
          {L("Check that the FireSense page is open on the watch camera and that it is online. Its status appears here once it connects.", "見守りカメラで FireSense のページが開いているか、ネットワークにつながっているかを確認してください。つながると、ここに状態が出ます。")}
        </Banner>
      )}
      {cameraOnline && !status && <p className="text-xs text-slate-400">{L("Waiting for the watch camera's status…", "見守りカメラの状態を待っています…")}</p>}
      {cameraOnline && stale && (
        <Banner tone="warn" title={L("No recent status", "最新の状態が届いていません")}>
          {L(`The last one arrived ${Math.round((age ?? 0) / 1000)} s ago. Check that the watch camera page is not in the background.`, `最後に届いたのは ${Math.round((age ?? 0) / 1000)} 秒前です。見守りカメラのページが裏に回っていないか確認してください。`)}
        </Banner>
      )}

      {status && (
        <>
          {status.errors.map((e) => (
            <Banner key={e} tone="error" title={L("Watch camera error", "見守りカメラのエラー")}>
              <span className="whitespace-pre-wrap">{e}</span>
            </Banner>
          ))}
          {!status.monitoring && (
            <Banner tone="warn" title={L("Watching has not started", "見守りが始まっていません")}>
              {L("Press \"Start watching\" once on the watch camera. Starting the camera and the model needs a tap on that device (a browser rule). After that you can adjust everything from here.", "見守りカメラで一度「見守りを開始」を押してください。カメラとモデルの起動は、その端末での操作が必要です（ブラウザの決まり）。それ以降の調整はここから行えます。")}
            </Banner>
          )}
          {status.busy && <p className="text-xs text-cyan-300">{L("Watch camera", "見守りカメラ")}: {status.busy}</p>}

          <LiveCard status={status} />

          <SetupHeader
            open={setupOpen}
            calibrated={Boolean(status.calibration)}
            summary={setupSummary(status, draft)}
            onOpen={() => setEditing(true)}
            onDone={() => setEditing(false)}
          />

          {/* Calibration (TV marker): the main setup step, before the fine adjustment below. */}
          {setupOpen && (
          <div className="rounded-xl bg-slate-950 border border-cyan-900 p-3 text-xs space-y-3">
            <div className="font-bold text-slate-200 flex items-center gap-1">
              <Ruler className="w-4 h-4" />{L(" TV-marker calibration", " TVマーカーでキャリブレーション")}
              <span className="font-normal text-slate-400">
                {status.calibration
                  ? L(
                      ` (done${status.calibration.tooCloseVisible !== null ? `, too-close zone in view: ${Math.round(status.calibration.tooCloseVisible * 100)}%` : ""})`,
                      `（済み${status.calibration.tooCloseVisible !== null ? `・近すぎエリアが映っている割合 ${Math.round(status.calibration.tooCloseVisible * 100)}%` : ""}）`
                    )
                  : L(" (not yet)", "（未）")}
              </span>
            </div>
            {status.motion !== "ok" && (
              <Banner tone="warn" title={L("The watch camera's motion sensor is not available", "見守りカメラの傾きセンサーが使えません")}>
                {status.motion === "denied"
                  ? L("Not allowed.", "許可されていません。")
                  : status.motion === "no-data"
                  ? L("No readings (a browser setting may be blocking it).", "値が届きません（ブラウザの設定で止められている可能性）。")
                  : status.motion === "unsupported"
                  ? L("Not available in this browser.", "このブラウザでは使えません。")
                  : L("Not checked yet.", "まだ確認していません。")}
                {" "}
                {L(
                  "Permission must be given on the watch camera's own screen (a browser rule). Press \"Allow motion sensor\" there before calibrating: distance accuracy improves a lot.",
                  "許可は見守りカメラの画面での操作が必要です（ブラウザの決まり）。見守りカメラの「傾きセンサーを許可する」を押してからキャリブレーションすると、距離の精度が大きく上がります。"
                )}
              </Banner>
            )}
            <div className="space-y-3">
              {status.source === "debug" && <p className="text-fuchsia-300">{L("The watch camera runs on a debug image (calibration uses the debug image).", "見守りカメラはデバッグ画像で動いています（キャリブレーションはデバッグ画像で行われます）。")}</p>}
            {tv && (
                <div className="rounded-lg border border-cyan-800 bg-cyan-950/30 p-2 space-y-2">
                  <div className="font-bold text-cyan-200 flex items-center gap-1">
                    <Tv className="w-3.5 h-3.5" />{L(" TV marker (recommended, no tape)", " TVマーカー（おすすめ・テープ不要）")}
                  </div>
                  <p className="text-slate-400">{L("The TV flashes black, then magenta, and the watch camera solves its position from the screen's four corners.", "テレビが一瞬「黒 → マゼンタ」になり、見守りカメラが画面の四隅から位置を計算します。")}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <NumField label={L("TV size (inches)", "テレビの大きさ（型）")} value={tv.inches} min={20} max={100} onChange={(v) => setTv({ ...tv, inches: v })} />
                    <NumField label={L("Lens height above the floor (cm)", "レンズの床からの高さ (cm)")} value={tv.heightCm} min={10} max={200} onChange={(v) => setTv({ ...tv, heightCm: v })} />
                    <label className="block space-y-1 col-span-2">
                      <span className="text-slate-400">{L("Screen-bottom height above the floor (cm, optional; corrects a wrong TV size automatically)", "画面の下端の床からの高さ (cm・任意。入れるとテレビの大きさの入力違いを自動で直します)")}</span>
                      <input
                        type="number"
                        min={0}
                        max={200}
                        value={tv.screenBottomCm ?? ""}
                        placeholder={L("e.g. 50", "例: 50")}
                        onChange={(e) => setTv({ ...tv, screenBottomCm: e.target.value === "" ? null : Number(e.target.value) })}
                        className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-white"
                      />
                    </label>
                  </div>
                  <button
                    disabled={disabled}
                    onClick={() => void run({ kind: "calibrate_tv", inches: tv.inches, heightCm: tv.heightCm, screenBottomCm: tv.screenBottomCm ?? null }, L("TV-marker calibration", "TVマーカーでキャリブレーション"))}
                    className="px-3 py-1.5 rounded-lg bg-cyan-700 text-white font-bold disabled:opacity-40"
                  >
                    {L("Calibrate on the TV", "テレビに表示してキャリブレーション")}
                  </button>
                </div>
              )}

              {status.calibration && (
                <FloorBottom
                  value={status.calibration.floorBottomY}
                  disabled={!usable}
                  onCommit={(v) => void run({ kind: "set_floor_bottom", floorBottomY: v }, L("Floor bottom line", "床の下端ライン"))}
                />
              )}
            </div>
          </div>
          )}

          {/* Setup: the preview stays on screen (sticky) while the lines are moved right below it. */}
          <Preview
            {...props}
            disabled={!usable}
            mirrored={status.source === "user"}
            editable={setupOpen}
            zoom={status.zoom ?? null}
            onZoomArea={(area) => void run({ kind: "set_zoom_area", area }, area ? L("Zoomed search area", "拡大して探す範囲") : L("Zoomed search: auto", "拡大して探す範囲を自動に"))}
          >
            {setupOpen && draft && (
              <div className="space-y-2">
                <div className="font-bold text-slate-200 flex items-center gap-1">
                  <SlidersHorizontal className="w-4 h-4" />{L(" Distances (from the TV screen)", " 判定の距離（テレビ画面から）")}
                </div>
                <Slider label={L("Too close (red line: closer than this, a strong blur)", "近すぎ（赤の線。これより近いと強くぼかす）")} value={draft.tooCloseM} min={0.6} max={2.5} disabled={!usable} onChange={(v) => editSetting("tooCloseM", v)} />
                <Slider label={L("Safe (green line: farther than this, clear; between the lines, a light blur as a hint)", "安全（緑の線。これより離れるとクリア。線の間はうっすらぼかして知らせる）")} value={draft.safeM} min={0.7} max={3.5} disabled={!usable} onChange={(v) => editSetting("safeM", v)} />
              </div>
            )}
            {!setupOpen ? null : status.calibration ? (
              <ZoneAdjustPanel
                adjust={status.calibration.adjust ?? null}
                measuredPoints={status.calibration.measuredPoints ?? 0}
                disabled={disabled}
                slidersDisabled={!usable}
                onAdjust={(adjust) => run({ kind: "set_zone_adjust", adjust }, L("Adjust the watch zone", "見守りエリアの調整"))}
                onMeasure={(trueM, step) => void run({ kind: "measure_distance", trueM, step }, L(`Match with a tape measure (point ${step}, ${trueM} m)`, `実測で合わせる（${step}点目・${trueM}m）`))}
              />
            ) : (
              <Banner tone="warn" title={L("Not calibrated yet", "まだキャリブレーションしていません")}>
                {L("Run \"TV-marker calibration\" below first. Without it there is no distance, so nothing is sent to the TV.", "下の「TVマーカーでキャリブレーション」を先に行ってください。距離を測れないため、TVには何も送っていません。")}
              </Banner>
            )}
          </Preview>


          {/* Detection model (on top, not folded away). */}
          <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 space-y-1">
            <WhoWatches
              value={status.pose?.model ?? null}
              disabled={disabled || !status.monitoring}
              inferenceMs={status.pose?.inferenceMs ?? null}
              onPick={(m) => void run({ kind: "set_pose_model", model: m, accel: "GPU" }, L(`Pose model: ${POSE_MODEL_INFO[m].label}`, `推論モデル: ${POSE_MODEL_INFO[m].label}`))}
            />
            <p className="text-[11px] text-slate-500">
              {status.pose
                ? L(`In use: ${POSE_MODEL_INFO[status.pose.model].label} (${status.pose.accel}) · ${status.pose.inferenceMs} ms. Check on the video that the skeleton (face included) sits on the person.`, `使用中: ${POSE_MODEL_INFO[status.pose.model].label}（${status.pose.accel}）・${status.pose.inferenceMs}ms。映像の骨格（顔も）が人に重なっているかで確かめてください。`)
                : L("Start watching on the watch camera to switch.", "見守りカメラで見守りを開始すると切り替えられます。")}
            </p>
          </div>

          {/* How the camera phone runs: mode and screen. */}
          <details className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs">
            <summary className="cursor-pointer font-bold text-slate-200">
              {L("How the watch camera runs", "見守りカメラの動かし方")}{" "}
              <span className="font-normal text-slate-400">
                ({status.mode ? MODE_LABEL[status.mode].title : L("no mode set", "モード未設定")} · {L("screen", "画面")} {status.blackout ? L("dark", "暗い") : L("on", "点灯")})
              </span>
            </summary>
            <div className="space-y-3 pt-2">
              <div className="flex flex-wrap gap-2">
                <Pill ok={status.monitoring}>{status.monitoring ? L("Watching started", "見守り 開始済み") : L("Not started", "見守り 未開始")}</Pill>
                <Pill ok={status.cameraOn}>{status.cameraOn ? L("Camera ON", "カメラ ON") : L("Camera OFF (rests while the TV is stopped)", "カメラ OFF（TV停止中は休止）")}</Pill>
                <Pill ok={status.playing}>{status.playing ? L("Playing on the TV", "TVで再生中") : L("TV stopped", "TVは停止中")}</Pill>
              </div>
              <div className="text-slate-400">
                {L("Mode", "いまのモード")}: <b className="text-white">{status.mode ? MODE_LABEL[status.mode].title : L("not set (nothing is sent to the TV)", "未設定（TVには何も送っていません）")}</b>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {MODES.map((m) => (
                  <button
                    key={m}
                    disabled={disabled || status.mode === m}
                    onClick={() => void run({ kind: "set_mode", mode: m }, L(`Mode: ${MODE_LABEL[m].title}`, `モードを「${MODE_LABEL[m].title}」に`))}
                    className={`px-3 py-2 rounded-xl text-sm font-bold border disabled:opacity-60 ${
                      status.mode === m ? "bg-white text-slate-900 border-white" : "bg-slate-800 text-slate-200 border-slate-600"
                    }`}
                  >
                    {MODE_LABEL[m].title}
                  </button>
                ))}
              </div>
              <button
                disabled={disabled}
                onClick={() => void run({ kind: "set_skeleton_only", on: !status.skeletonOnly }, status.skeletonOnly ? L("Show the camera image", "カメラの映像を表示") : L("Skeleton only", "骨格だけ表示"))}
                className={`w-full px-3 py-2 rounded-xl border text-sm font-bold disabled:opacity-50 ${status.skeletonOnly ? "bg-white text-slate-900 border-white" : "bg-slate-800 border-slate-600 text-white"}`}
              >
                {status.skeletonOnly
                  ? L("Skeleton only: ON (the camera image is hidden) — tap to show it", "骨格だけ表示: オン（カメラの映像は隠しています）— 押すと戻す")
                  : L("Skeleton only (hide the camera image, e.g. to film a child)", "骨格だけ表示（カメラの映像を隠す。子どもを撮影するときなど）")}
              </button>
              <button
                disabled={disabled}
                onClick={() => void run({ kind: "set_blackout", on: !status.blackout }, status.blackout ? L("Screen on", "画面を戻す") : L("Screen dark", "画面を暗くする"))}
                className="w-full px-3 py-2 rounded-xl bg-slate-800 border border-slate-600 text-white text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Moon className="w-4 h-4" /> {status.blackout ? L("Turn the watch camera screen back on", "見守りカメラの画面を戻す") : L("Darken the watch camera screen (watching continues)", "見守りカメラの画面を暗くする（見守りは続きます）")}
              </button>
            </div>
          </details>

          <RemoteDistanceTrial status={status} disabled={disabled} run={run} />
        </>
      )}

      {busy && <p className="text-xs text-slate-400">{L("Sending", "送信中")}: {busy}…</p>}
      {outcomes.length > 0 && (
        <ul className="space-y-1 text-[11px]">
          {outcomes.slice(0, 5).map((o) => (
            <li key={o.id} className={o.ok === null ? "text-slate-400" : o.ok ? "text-emerald-300" : "text-rose-300"}>
              {new Date(o.at).toLocaleTimeString(speechLang())} {o.label}: <span className="whitespace-pre-wrap">{o.ok === null ? L("waiting for a reply…", "応答待ち…") : o.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Live preview (WebRTC, home network only). Calibration is the TV marker only.
// ---------------------------------------------------------------------------
type Area = { x0: number; y0: number; x1: number; y1: number };

function Preview(
  props: CameraRemoteProps & {
    disabled: boolean;
    mirrored: boolean;
    /** Setup open: the zoom-area drawing and the sliders below the video. Closed: the video only, to check. */
    editable: boolean;
    zoom: { area: Area | null; active: boolean } | null;
    onZoomArea: (area: Area | null) => void;
    children?: React.ReactNode;
  }
) {
  const { sendSignal, onSignal, disabled, mirrored, zoom, onZoomArea, editable } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  // Drawing the zoomed-search area: a drag over the video, in display coordinates (0..1 of the shown picture).
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  /** Pointer → 0..1 of the picture actually shown (object-contain letterbox), or null outside it. */
  const toPicture = (e: React.PointerEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    const box = e.currentTarget.getBoundingClientRect();
    const vw = v?.videoWidth || 4;
    const vh = v?.videoHeight || 3;
    const scale = Math.min(box.width / vw, box.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    const x = (e.clientX - box.left - (box.width - w) / 2) / w;
    const y = (e.clientY - box.top - (box.height - h) / 2) / h;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };
  /** Display → camera frame (the front camera is shown mirrored). */
  const toFrame = (d: { a: { x: number; y: number }; b: { x: number; y: number } }): Area => {
    const xs = [d.a.x, d.b.x].map((x) => (mirrored ? 1 - x : x));
    const r = (v: number) => Number(v.toFixed(3));
    return { x0: r(Math.min(...xs)), x1: r(Math.max(...xs)), y0: r(Math.min(d.a.y, d.b.y)), y1: r(Math.max(d.a.y, d.b.y)) };
  };
  const pcRef = useRef<{ pc: RTCPeerConnection; peerId: string } | null>(null);
  const [state, setState] = useState<"off" | "connecting" | "on">("off");
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(
    (reason?: string) => {
      const cur = pcRef.current;
      pcRef.current = null;
      if (cur) {
        sendSignal("hangup", cur.peerId);
        cur.pc.close();
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      setState("off");
      if (reason) setError(reason);
    },
    [sendSignal]
  );

  useEffect(() => {
    return onSignal((m) => {
      const cur = pcRef.current;
      if (!cur || m.peerId !== cur.peerId) return;
      if (m.kind === "error") stop(L(`Watch camera: ${m.message ?? "could not send video"}`, `見守りカメラ: ${m.message ?? "映像を送れませんでした"}`));
      if (m.kind === "answer" && m.sdp) {
        cur.pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch((err: Error) => stop(L(`Could not connect the video: ${err.message}`, `映像の接続に失敗しました: ${err.message}`)));
      }
    });
  }, [onSignal, stop]);

  useEffect(() => {
    const onHide = () => stop();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      stop();
    };
  }, [stop]);

  const start = async () => {
    stop();
    setError(null);
    if (typeof RTCPeerConnection === "undefined") {
      setError(L("This browser does not support WebRTC, so the video cannot be shown.", "このブラウザは WebRTC に対応していないため、映像を表示できません。"));
      return;
    }
    const peerId = `pv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = { pc, peerId };
    setState("connecting");
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addEventListener("track", (e) => {
      if (videoRef.current) videoRef.current.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pcRef.current?.pc !== pc) return;
      if (pc.connectionState === "connected") setState("on");
      if (pc.connectionState === "failed") stop(L(`Could not connect directly to the watch camera (connectionState=failed). ${previewNetworkHint()}`, `見守りカメラと直接つながりませんでした（connectionState=failed）。${previewNetworkHint()}`));
      if (pc.connectionState === "disconnected") setError(L("The video is breaking up (the direct connection to the watch camera is failing).", "映像が途切れています（見守りカメラとの直接の接続が切れかけています）。"));
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await iceGatheringComplete(pc);
      if (!sendSignal("offer", peerId, pc.localDescription?.sdp)) throw new Error(L("Not connected to the relay, so the watch camera cannot be asked.", "中継に接続していないため、見守りカメラに頼めません。"));
    } catch (err) {
      stop(L(`Could not start the video: ${(err as Error).message}`, `映像を始められませんでした: ${(err as Error).message}`));
      return;
    }
    setTimeout(() => {
      if (pcRef.current?.pc === pc && pc.connectionState !== "connected") {
        stop(L(`No connection to the watch camera after 10 s (connectionState=${pc.connectionState}, iceConnectionState=${pc.iceConnectionState}). ${previewNetworkHint()}`, `10秒待っても見守りカメラとつながりませんでした（connectionState=${pc.connectionState}, iceConnectionState=${pc.iceConnectionState}）。${previewNetworkHint()}`));
      }
    }, 10_000);
  };

  return (
    <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 space-y-2 text-xs">
      <div className="font-bold text-slate-200 flex items-center gap-1">
        <Video className="w-4 h-4" />
        {editable ? L(" Fit the watch zone on the video", " 見守りエリアを映像で合わせる") : L(" Live video from the watch camera", " 見守りカメラの映像")}
      </div>
      <p className="text-slate-400">
        {editable
          ? L("The video comes straight from the watch camera inside your home Wi-Fi and is never sent to the cloud. Watch it while moving the sliders below so the red (too close) and green (safe) lines sit on the floor.", "映像は家の Wi-Fi の中で見守りカメラから直接届き、クラウドには送られません。映像を見ながら、下のスライダーで赤（近すぎ）と緑（安全）の線を床に合わせます。")
          : L("Straight from the watch camera inside your home Wi-Fi, never sent to the cloud. To change the lines or the zoom area, press \"Change setup\" above.", "家の Wi-Fi の中で見守りカメラから直接届き、クラウドには送られません。線や拡大の範囲を変えるときは、上の「設定を変える」を押してください。")}
      </p>
      <div className="flex gap-2">
        {state === "off" ? (
          <button disabled={disabled} onClick={() => void start()} className="px-3 py-1.5 rounded-lg bg-orange-700 text-white font-bold disabled:opacity-40">
            {L("Show video", "映像を見る")}
          </button>
        ) : (
          <button onClick={() => stop()} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white font-bold">
            {L("Stop video", "映像を止める")}
          </button>
        )}
      </div>
      {state === "connecting" && <p className="text-slate-400">{L("Connecting…", "接続中…")}</p>}
      {error && <Banner tone="error" title={L("Video", "映像")}>{error}</Banner>}
      {/* Sticky: stays at the top of the screen while the sliders below are moved. */}
      <div className={`sticky top-12 z-20 -mx-1 ${state === "off" ? "hidden" : ""}`}>
        <div className="relative rounded-lg overflow-hidden bg-black aspect-[4/3] shadow-lg shadow-black/60 ring-1 ring-slate-700">
          <video ref={videoRef} autoPlay playsInline muted className={`absolute inset-0 w-full h-full object-contain ${mirrored ? "-scale-x-100" : ""}`} />
          {drawing && (
            <div
              className="absolute inset-0 touch-none cursor-crosshair bg-cyan-400/10"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const p = toPicture(e);
                setDrag({ a: p, b: p });
              }}
              onPointerMove={(e) => drag && setDrag({ a: drag.a, b: toPicture(e) })}
              onPointerUp={() => {
                if (!drag) return;
                const area = toFrame(drag);
                setDrag(null);
                if (area.x1 - area.x0 < 0.05 || area.y1 - area.y0 < 0.05) return; // a tap, not a box: keep drawing
                setDrawing(false);
                onZoomArea(area);
              }}
            >
              {drag && (
                <div
                  className="absolute border-2 border-cyan-300 bg-cyan-300/20"
                  style={{ left: `${Math.min(drag.a.x, drag.b.x) * 100}%`, top: `${Math.min(drag.a.y, drag.b.y) * 100}%`, width: `${Math.abs(drag.b.x - drag.a.x) * 100}%`, height: `${Math.abs(drag.b.y - drag.a.y) * 100}%` }}
                />
              )}
              {!drag && <div className="absolute inset-x-0 top-2 text-center text-[11px] font-bold text-cyan-200 drop-shadow">{L("Drag a box over where people come close to the TV", "テレビに近づく人が映る辺りを、指でなぞって囲む")}</div>}
            </div>
          )}
        </div>
      </div>
      {state === "on" && editable && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={disabled} onClick={() => setDrawing((d) => !d)} className={`px-3 py-1.5 rounded-lg font-bold disabled:opacity-40 ${drawing ? "bg-slate-700 text-white" : "bg-cyan-700 text-white"}`}>
              {drawing ? L("Cancel", "やめる") : L("Draw the area to zoom into", "拡大して探す範囲を描く")}
            </button>
            {zoom?.area && !drawing && (
              <button disabled={disabled} onClick={() => onZoomArea(null)} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white font-bold disabled:opacity-40">
                {L("Back to auto", "自動に戻す")}
              </button>
            )}
            <span className="text-slate-400">
              {zoom?.area ? L("Drawn area", "描いた範囲") : L("Auto", "自動")} · {zoom?.active ? L("zoomed search on (cyan box)", "拡大して探索中（水色の枠）") : L("no zoomed search", "拡大の探索なし")}
            </span>
          </div>
          <p className="text-slate-500">
            {L(
              "People who appear small are found by searching this area zoomed in (4×), in addition to the whole picture. Smaller area = faster search. Nobody outside it is lost: the whole picture is still checked every frame.",
              "小さく映る人は、画面全体に加えて、この範囲を拡大（4倍）して探すと見つかります。範囲が狭いほど早く見つかります。範囲の外の人も、画面全体は毎回見ているので見失いません。"
            )}
          </p>
        </div>
      )}
      {mirrored && state !== "off" && <p className="text-slate-500">{L("Front camera: mirrored, as on the watch camera's screen.", "インカメラなので、見守りカメラの画面と同じく左右反転して表示しています。")}</p>}
      {props.children && <div className="space-y-3 pt-1">{props.children}</div>}

    </div>
  );
}

/** One line of what is set, for the folded setup. */
function setupSummary(status: CameraStatus, draft: CameraSettings | null): string {
  const s = draft ?? status.settings;
  const parts = [L(`Too close ${s.tooCloseM.toFixed(2)} m / Safe ${s.safeM.toFixed(2)} m`, `近すぎ ${s.tooCloseM.toFixed(2)}m / 安全 ${s.safeM.toFixed(2)}m`)];
  const a = status.calibration?.adjust;
  if (a && (a.dxM !== 0 || a.dzM !== 0 || a.angleDeg !== 0 || a.scale !== 1)) parts.push(L("zone adjusted", "エリア調整あり"));
  parts.push(status.zoom?.area ? L("zoom area: drawn", "拡大の範囲: 描いた範囲") : L("zoom area: auto", "拡大の範囲: 自動"));
  return parts.join(" · ");
}

function SetupHeader({ open, calibrated, summary, onOpen, onDone }: { open: boolean; calibrated: boolean; summary: string; onOpen: () => void; onDone: () => void }) {
  return (
    <div className={`rounded-xl border p-3 text-xs flex items-center gap-2 ${open ? "bg-cyan-950/40 border-cyan-800" : "bg-slate-950 border-slate-800"}`}>
      <Ruler className="w-4 h-4 text-cyan-300 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-bold text-slate-100">
          {L("Setup", "設置の設定")}
          <span className="font-normal text-slate-400">
            {calibrated ? (open ? L(" (editing — changes apply at once)", "（変更中・すぐ反映されます）") : L(" (calibrated, locked)", "（キャリブレーション済み・ロック中）")) : L(" (calibrate first)", "（まずキャリブレーション）")}
          </span>
        </div>
        {calibrated && <div className="text-slate-400 truncate">{summary}</div>}
      </div>
      {calibrated &&
        (open ? (
          <button onClick={onDone} className="px-3 py-1.5 rounded-lg bg-cyan-700 text-white font-bold shrink-0">
            {L("Done", "完了")}
          </button>
        ) : (
          <button onClick={onOpen} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white font-bold shrink-0">
            {L("Change setup", "設定を変える")}
          </button>
        ))}
    </div>
  );
}

function FloorBottom({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value);
  // Follows the camera's value except during a drag and until the change sent on release has had time to come back.
  const holdUntilRef = useRef(0);
  useEffect(() => {
    if (Date.now() > holdUntilRef.current) setV(value);
  }, [value]);
  const label = L("Floor bottom line (raise it when a TV stand or similar shows at the bottom of the view)", "床の下端ライン（映像の下にテレビ台などが写るときに上げる）");
  return (
    <div className="space-y-1">
      <span className="flex justify-between text-slate-400">
        <span>{label}</span>
        <span className="font-mono text-white">{v.toFixed(2)}</span>
      </span>
      <TouchSlider
        label={label}
        min={0.5}
        max={1}
        step={0.01}
        value={v}
        disabled={disabled}
        onChange={(x) => {
          holdUntilRef.current = Date.now() + 10_000;
          setV(x);
        }}
        onCommit={(x) => {
          holdUntilRef.current = Date.now() + 3000;
          onCommit(x);
        }}
      />
    </div>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <span className="flex justify-between text-slate-400">
        <span>{props.label}</span>
        <span className="font-mono text-white">{props.value.toFixed(2)}m</span>
      </span>
      <TouchSlider label={props.label} min={props.min} max={props.max} step={0.05} value={props.value} disabled={props.disabled} onChange={props.onChange} />
    </div>
  );
}

function NumField(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="space-y-1">
      <span className="block text-slate-500">{props.label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={props.value}
        min={props.min}
        max={props.max}
        step={1}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-white"
      />
    </label>
  );
}

const TONE_CLASS = {
  ok: "bg-emerald-950/60 border-emerald-700 text-emerald-200",
  warn: "bg-amber-950/60 border-amber-700 text-amber-200",
  bad: "bg-rose-950/60 border-rose-700 text-rose-200",
  none: "bg-slate-900 border-slate-700 text-slate-300",
} as const;

/** What the camera phone sees right now, in words (also on the parent's home tab). */
export function LiveCard({ status }: { status: CameraStatus }) {
  const live = status.live;
  const st = live ? STATE_LABEL[live.state] : null;
  return (
    <div className={`rounded-xl border p-3 ${TONE_CLASS[st?.tone ?? "none"]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-base font-black">{st ? st.text : status.cameraOn ? L("Waiting for a measurement", "計測を待っています") : L("Camera resting (while the TV is stopped)", "カメラは休止中（TVが止まっているあいだ）")}</div>
        <div className="text-2xl font-black text-white">{live?.distanceM == null ? "" : `${live.distanceM.toFixed(2)}m`}</div>
      </div>
      {live && (
        <div className="text-[11px] opacity-80 mt-1">
          {live.distanceSource === "hips" ? L("Feet hidden, estimated from the hips · ", "足元が隠れているので腰から推定・") : live.distanceSource === "seated" ? L("Seated: measured under the head, not the feet · ", "座っているので足ではなく頭の位置で計測・") : ""}
          {L("Blur", "画面のぼかし")} {live.blurPx > 0 ? L("on", "あり") : L("off", "なし")} · {L("Posture", "姿勢")} {POSTURE_LABEL[live.posture]} · {L("People in view", "映っている人")} {live.peopleCount} · {live.fps}fps
        </div>
      )}
    </div>
  );
}
