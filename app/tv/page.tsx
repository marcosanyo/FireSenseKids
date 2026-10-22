"use client";

/**
 * /tv — Fire TV screen (bundled into the WebView APK at https://appassets.androidplatform.net/tv/).
 *
 * Render-only: blurPx and state come from the phone. The TV never decides safety.
 * If the sensor link drops (plan §3), the blur clears in 500ms and a calm
 * "Sensor not connected" badge stays visible — never silent, never punishing.
 */

import { switchLang } from "@/lib/client/lang";
import { L, lang, speechLang } from "@/lib/firesense/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  addRecovery,
  countEvent,
  countPlayingSecond,
  FireSenseViewer,
  RecoveryTimer,
  formatViewerError,
  INITIAL_VIEWER_FRAME,
  type CalibrationPattern,
  type CameraLeavingReason,
  type DailySummary,
  type LinkStatus,
  type TransportState,
  type ViewerCredentials,
  type ViewerFrame,
  type ViewerPairing,
  type ViewerParentPairing,
  PlaylistSchema,
  type Playlist,
  DEFAULT_TV_SETTINGS,
  TvSettingsSchema,
  type TvSettings,
  PauseTracker,
} from "@/lib/firesense";
import { apiFetch } from "@/lib/client/api";
import { cameraPairingUrl, parentPairingUrl, WS_URL } from "@/lib/client/config";
import { emptyDay, rollDay } from "@/lib/client/daily-ledger";
import { recordMeasurement } from "@/lib/client/measure-log";
import { BENCH_STEPS, benchToCsv, runRenderBenchmark, type BenchResult, type BenchStep, type BlurMode } from "@/lib/client/tv-bench";
import { KEYS, nativeBridge, storage } from "@/lib/client/storage";
import { claimVideoOverlay, watchVideoDrawn } from "@/lib/client/awv-overlay";
import { defaultPlaylist, upgradeLegacyUrls } from "@/lib/client/playlists";
import { computeTvVisualStyles } from "@/lib/client/tv-visuals";
import { Star, Smartphone } from "lucide-react";

/** Bundled in the APK: a 4 KB black 640×360 clip the hidden overlay holder loops (lib/client/awv-overlay.ts). */
const HOLDER_SRC = "/videos/overlay-holder-black.mp4";
const SEEK_S = 10;
/** A broken item stays on screen with its error this long before the next one starts. */
const ERROR_SKIP_MS = 6000;
type PlaylistState = { playlist: Playlist; index: number };

/** Back from the background after this long (Fire TV standby, TV switched off): start the page afresh. */
const RESUME_RELOAD_AFTER_MS = 30_000;
/** At most one automatic reload in this long, so a page that cannot play does not reload for ever. */
const AUTO_RELOAD_MIN_GAP_MS = 5 * 60_000;
const AUTO_RELOAD_KEY = "firesense.tv.autoReloadAt";

/**
 * After a long standby the WebView's media pipeline and the relay socket are gone: play() rejects with
 * AbortError and nothing recovers until the app is restarted (field, 2026-09-27). A fresh page is what
 * "Done for today?" + relaunch did by hand; the playlist and the position are restored from storage.
 */
function reloadPage(reason: string): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(AUTO_RELOAD_KEY) ?? 0);
    if (Date.now() - last < AUTO_RELOAD_MIN_GAP_MS) return false;
    window.sessionStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  console.info(`[firesense-overlay] ${JSON.stringify({ event: "reload", reason, at: new Date().toISOString() })}`);
  window.location.reload();
  return true;
}

// Optional child cues (off by default). Getters: the language is set after this module loads.
const LINES = {
  get approaching() { return L("Oh? Two steps back and it gets clear", "おや？ 2ほ さがると くっきり みえるよ"); },
  get tooClose() { return L("Let's watch from a little farther 🐾", "すこし はなれて みてね 🐾"); },
  get praise() { return L("You stepped back by yourself! Great!", "じぶんで さがれたね！ えらい！"); },
  get phase1() { return L("Nice step! A little more and it's crystal clear ✨", "ナイスステップ！ もうすこし さがると パッと クリアに ✨"); },
  get posture() { return L("Let's sit up tall", "せなかを ピンと のばそう"); },
};
const TARGET_STARS = 5;
const RTT_PROBES = 20;

/** Why the sensor is not connected, as far as the TV knows. Unknown stays unknown (no guessing). */
function sensorDownReason(link: LinkStatus): string {
  const left: Record<CameraLeavingReason, string> = {
    hidden: L("The watch camera page went to the background (another app, or the screen turned off)", "スマホの見守り画面が裏に回りました（ほかのアプリ・画面オフ）"),
    pagehide: L("The watch camera page was closed", "スマホの見守り画面が閉じられました"),
  };
  switch (link.reason) {
    case "PEER_LEFT":
      return link.peerLeft ? left[link.peerLeft] : L("The phone reported that it disconnected (reason unknown)", "スマホが切断を知らせました（理由は不明）");
    case "PEER_OFFLINE":
      return L("The phone lost its connection to the relay (reason unknown)", "スマホと中継サーバーの接続が切れました（理由は不明）");
    case "SILENT":
      return L("No data from the phone for over 3 seconds (reason unknown)", "スマホから3秒以上データが届いていません（理由は不明）");
    case "WAITING_FIRST_TELEMETRY":
      return L("Waiting for the watch camera to start", "スマホで見守りが始まるのを待っています");
    default:
      return L("Reason unknown", "理由は不明");
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const WARN_STATES = new Set(["TOO_CLOSE", "BELOW_FRAME"]);

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[🐾✨]/g, ""));
  u.lang = speechLang();
  u.rate = 1.05;
  u.pitch = 1.25;
  window.speechSynthesis.speak(u);
}

function chime() {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  [1046.5, 1318.51, 1567.98, 2093].forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime + i * 0.07;
    o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.35);
  });
}

export default function TvPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<FireSenseViewer | null>(null);
  const dayRef = useRef<DailySummary | null>(null);
  const dayBaseRef = useRef({ count: 0, seconds: 0 });
  // Field pilot (T2): the latest frame for the 1 Hz counters, and WARN → SAFE timing.
  const frameRef = useRef<ViewerFrame>(INITIAL_VIEWER_FRAME);
  const recoveryRef = useRef(new RecoveryTimer());

  const [pairing, setPairing] = useState<ViewerPairing | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  // Which QR the dialog shows: the watch camera's, or a parent phone's (adjusts the camera, reads records).
  const [qrView, setQrView] = useState<"camera" | "parent">("camera");
  // First run: step 1/2 the watch camera, then step 2/2 a parent phone (skipped when one is already added).
  const [setup, setSetup] = useState(false);
  const setupRef = useRef(false);
  setupRef.current = setup;
  // After setup, OK opens this menu (both devices' state) instead of a QR code.
  const [menuOpen, setMenuOpen] = useState(false);
  const [parentPairing, setParentPairing] = useState<ViewerParentPairing | null>(null);
  // Measurement menu (OK → QR dialog → measurement menu): the render benchmark and the relay round trip.
  const [measureOpen, setMeasureOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [relayState, setRelayState] = useState<TransportState>("idle");
  const [frame, setFrame] = useState<ViewerFrame>(INITIAL_VIEWER_FRAME);
  const [cameraFps, setCameraFps] = useState<number | null>(null);
  const [stars, setStars] = useState(0);
  const [toast, setToast] = useState<{ kind: "praise" | "phase1" | "posture" | "paired" | "video"; text: string } | null>(null);
  const [exitConfirm, setExitConfirm] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  // The video gets its src only after the APK has taken Amazon WebView's hardware overlay with a
  // hidden holder video; otherwise the real Fire TV shows black with sound (lib/client/awv-overlay.ts).
  const [overlayReady, setOverlayReady] = useState(false);
  // What to play: the parent's pick (or the default), remembered on the TV with the position in it.
  const [pl, setPl] = useState<PlaylistState>(() => ({ playlist: defaultPlaylist(), index: 0 }));
  const [plLoaded, setPlLoaded] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);
  const item = pl.playlist.items[Math.min(pl.index, pl.playlist.items.length - 1)];
  const videoSrc = overlayReady && plLoaded ? item.url : undefined;
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [tvSettings, setTvSettings] = useState<TvSettings>(DEFAULT_TV_SETTINGS);
  const tvSettingsRef = useRef<TvSettings>(tvSettings);
  tvSettingsRef.current = tvSettings;
  const [interventionPaused, setInterventionPaused] = useState(false);
  const interventionPausedRef = useRef(false);
  const backgroundAtRef = useRef<number | null>(null);
  const pauseTrackerRef = useRef(new PauseTracker(tvSettings.pause));
  const [debug, setDebug] = useState(false);
  const [blurMode, setBlurMode] = useState<BlurMode>("full");
  const [renderFps, setRenderFps] = useState(0);
  const [videoFps, setVideoFps] = useState<number | null>(null);
  // Render benchmark (MEASUREMENT §5): overrides blur + mode while it runs.
  const [benchStep, setBenchStep] = useState<{ index: number; step: BenchStep } | null>(null);
  const [benchResult, setBenchResult] = useState<BenchResult | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);
  const benchAbortRef = useRef<AbortController | null>(null);
  const benchRunningRef = useRef(false);
  benchRunningRef.current = benchStep !== null;
  // Relay round trip (MEASUREMENT §3) and disconnect → blur cleared (§6), recorded on the TV.
  const [rtt, setRtt] = useState<{ running: boolean; samples: (number | null)[]; summary?: string; error?: string } | null>(null);
  const rttRunningRef = useRef(false);
  const [lastClear, setLastClear] = useState<string | null>(null);
  const [isApk, setIsApk] = useState(true); // decided after mount (the bridge exists only in the APK WebView)
  useEffect(() => setIsApk(Boolean(nativeBridge())), []);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // TV-marker calibration: the phone asks for a full-screen flat color (magenta, then black).
  const [calibPattern, setCalibPattern] = useState<{ pattern: CalibrationPattern; n: number } | null>(null);

  // The OK key that opens a dialog can also "click" the auto-focused button when it is released
  // (WebView DPAD_CENTER). Ignore dialog button presses for a short moment after a dialog opens.
  const dialogOpenedAtRef = useRef(0);
  const dialogOpen = qrOpen || menuOpen || exitConfirm || measureOpen || Boolean(sessionError);
  useEffect(() => {
    if (dialogOpen) dialogOpenedAtRef.current = Date.now();
  }, [dialogOpen]);
  const guarded = useCallback(
    (fn: () => void) => () => {
      if (Date.now() - dialogOpenedAtRef.current >= 400) fn();
    },
    []
  );

  const showToast = useCallback((t: NonNullable<typeof toast>, ms = 3500) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  // --------------------------------------------------------------------------
  // Daily ledger
  // --------------------------------------------------------------------------
  const saveDay = useCallback((d: DailySummary) => {
    dayRef.current = d;
    storage.setJson(KEYS.tvDaily, d);
    setStars(d.starCount);
  }, []);

  const withDisconnects = useCallback((d: DailySummary): DailySummary => {
    const s = viewerRef.current?.disconnects() ?? { count: 0, seconds: 0 };
    return { ...d, disconnectCount: dayBaseRef.current.count + s.count, disconnectSeconds: dayBaseRef.current.seconds + s.seconds };
  }, []);

  const summaryPendingRef = useRef(false);
  const postSummary = useCallback(async () => {
    const creds = viewerRef.current?.credentials;
    const day = dayRef.current;
    if (!creds || !day) return;
    const body = withDisconnects(rollDay(day));
    saveDay(body);
    summaryPendingRef.current = true;
    try {
      await apiFetch("/session/summary", { sessionId: creds.sessionId, secret: creds.tvSecret }, { method: "POST", body });
      summaryPendingRef.current = false;
      setSummaryError(null);
    } catch (err) {
      // Shown as-is and retried (see effect below); the counts stay safe in local storage.
      const t = new Date().toLocaleTimeString(speechLang(), { hour: "2-digit", minute: "2-digit" });
      setSummaryError(L(`${t} ${(err as Error).message} (will retry automatically)`, `${t} ${(err as Error).message}（自動で再送します）`));
    }
  }, [saveDay, withDisconnects]);

  /**
   * A parent phone asked to reset the records: today's running counters start from zero (disconnects included),
   * then every stored day is deleted and today's empty record is uploaded. Errors are shown like summary errors.
   */
  const resetRecords = useCallback(async () => {
    const creds = viewerRef.current?.credentials;
    if (!creds) return;
    const s = viewerRef.current?.disconnects() ?? { count: 0, seconds: 0 };
    dayBaseRef.current = { count: -s.count, seconds: -s.seconds };
    recoveryRef.current.reset();
    saveDay(emptyDay());
    try {
      await apiFetch("/session/summary/reset", { sessionId: creds.sessionId, secret: creds.tvSecret }, { method: "POST", body: {} });
      await postSummary();
      showToast({ kind: "paired", text: L("The records were reset from the parent phone", "保護者のスマホから記録をリセットしました") }, 5000);
    } catch (err) {
      setSummaryError(L(`Could not reset the records: ${(err as Error).message}`, `記録をリセットできませんでした: ${(err as Error).message}`));
    }
  }, [saveDay, postSummary, showToast]);
  const resetRecordsRef = useRef(resetRecords);
  resetRecordsRef.current = resetRecords;

  // Retry a failed summary every 30s, and immediately when the network comes back (e.g. after sleep).
  // (The viewer reconnects the relay on "online" by itself.)
  useEffect(() => {
    const retry = setInterval(() => {
      if (summaryPendingRef.current) void postSummary();
    }, 30_000);
    const onOnline = () => {
      if (summaryPendingRef.current) void postSummary();
    };
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(retry);
      window.removeEventListener("online", onOnline);
    };
  }, [postSummary]);

  useEffect(() => {
    const d = rollDay(storage.getJson<DailySummary>(KEYS.tvDaily));
    dayBaseRef.current = { count: d.disconnectCount, seconds: d.disconnectSeconds };
    saveDay(d);
    const qs = new URLSearchParams(window.location.search);
    setDebug(qs.get("debug") === "1");
    if (qs.get("blur") === "downscale") setBlurMode("downscale");
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.paused || !dayRef.current) return;
      const cur = rollDay(dayRef.current);
      if (cur.date !== dayRef.current.date) {
        dayBaseRef.current = { count: 0, seconds: 0 };
        recoveryRef.current.reset();
      }
      const f = frameRef.current;
      const next = countPlayingSecond(cur, { mode: f.mode, connected: f.link.connected, state: f.state, test: f.test, floor: f.floor, confidence: f.confidence });
      dayRef.current = next;
      if (next.viewingSeconds % 10 === 0) saveDay(withDisconnects(next));
      if (next.viewingSeconds % 60 === 0) void postSummary();
    }, 1000);
    return () => clearInterval(id);
  }, [saveDay, withDisconnects, postSummary]);

  // --------------------------------------------------------------------------
  // Relay (FireSenseViewer: connection, pairing, ordering, disconnect detection)
  // --------------------------------------------------------------------------
  useEffect(() => {
    const viewer = new FireSenseViewer({
      url: WS_URL,
      credentials: {
        load: () => storage.getJson<ViewerCredentials>(KEYS.tvSession),
        save: (c) => (c ? storage.setJson(KEYS.tvSession, c) : storage.remove(KEYS.tvSession)),
      },
      pairingUrl: cameraPairingUrl,
      parentPairingUrl,
    });
    viewerRef.current = viewer;
    viewer.on("frame", (f) => {
      frameRef.current = f;
      setFrame(f);
      stepPauseRef.current();
      if (!f.link.connected || f.test || !f.state || !dayRef.current) return;
      const done = recoveryRef.current.onState(Date.now(), f.state);
      if (done) saveDay(addRecovery(rollDay(dayRef.current), done.mode, done.seconds));
    });
    viewer.on("relay", ({ state }) => setRelayState(state));
    viewer.on("heartbeat", ({ fps }) => setCameraFps(fps));
    viewer.on("linkLost", (lost) => {
      // Time from detecting the drop until the video is actually unblurred (computed style), §6.
      if (benchRunningRef.current) return;
      const t0 = performance.now();
      const deadline = t0 + 5000;
      const check = () => {
        const v = videoRef.current;
        const now = performance.now();
        const cleared = v ? getComputedStyle(v).filter === "none" : false;
        const recovered = frameRef.current.link.connected; // the phone came back before the blur was gone
        if (!cleared && !recovered && now < deadline) {
          requestAnimationFrame(check);
          return;
        }
        const detectToClearMs = cleared ? Math.round(now - t0) : null;
        recordMeasurement("disconnect_clear", {
          reason: lost.link.reason,
          peerLeft: lost.link.peerLeft ?? null,
          blurPxBefore: lost.blurPxBefore,
          test: lost.test,
          lastPeerMessageAgoMs: lost.lastPeerMessageAgoMs,
          detectToClearMs,
          recoveredBeforeClear: !cleared && recovered,
          lastPeerMessageToClearMs: lost.lastPeerMessageAgoMs !== null && detectToClearMs !== null ? lost.lastPeerMessageAgoMs + detectToClearMs : null,
        });
        setLastClear(
          `${lost.link.reason}${lost.link.peerLeft ? `/${lost.link.peerLeft}` : ""} · blur ${lost.blurPxBefore}px · last msg ${lost.lastPeerMessageAgoMs ?? "—"} ms before detect · cleared ${detectToClearMs !== null ? `${detectToClearMs} ms` : recovered ? "— (link back first)" : "NOT within 5 s"} after`
        );
      };
      requestAnimationFrame(check);
    });
    viewer.on("session", () => {
      setSessionError(null);
      nowPlayingRef.current();
    });
    viewer.on("playlist", (playlist) => {
      setItemError(null);
      setPl({ playlist: upgradeLegacyUrls(playlist), index: 0 });
      showToast({ kind: "paired", text: L(`"${playlist.title}" was chosen on the parent phone`, `保護者のスマホで「${playlist.title}」が選ばれました`) }, 4000);
    });
    viewer.on("playbackControl", (action) => {
      if (action === "next") advanceRef.current(1);
      else if (action === "previous") advanceRef.current(-1);
      else if (videoRef.current) videoRef.current.currentTime = 0;
    });
    viewer.on("recordsReset", () => void resetRecordsRef.current());
    viewer.on("tvSettings", (settings) => {
      setTvSettings(settings);
      storage.setJson(KEYS.tvSettings, settings);
    });
    viewer.on("pairing", (p) => {
      setPairing(p);
      if (!p.cameraPaired) {
        setMenuOpen(false);
        setQrView("camera");
        setQrOpen(true);
        setSetup(true);
      }
    });
    viewer.on("paired", () => {
      // Only a completed QR pairing moves on (reconnects must not). In the first run: step 2/2, a parent phone.
      showToast({ kind: "paired", text: L("Watch camera connected 🐾 Next, calibrate on the phone", "見守りカメラをつなぎました 🐾 次はスマホでキャリブレーション") }, 6000);
      if (setupRef.current) {
        setParentPairing(null);
        viewer.requestParentPairing();
        setQrView("parent");
      } else setQrOpen(false);
    });
    viewer.on("event", ({ type, mode, test }) => {
      if (dayRef.current && !test) {
        saveDay(countEvent(rollDay(dayRef.current), type, mode));
        if (type === "WARN") recoveryRef.current.onWarn(Date.now(), mode);
      }
      // Shadow mode (field pilot): record only — no sound, voice, or toast.
      if (mode === "shadow") return;
      // Child cues disabled: do not play sound, voice, or toast for child events
      if (!tvSettingsRef.current.childCues) return;

      if (type === "STAR_AWARDED") {
        chime();
        speak(LINES.praise);
        showToast({ kind: "praise", text: LINES.praise });
      } else if (type === "WARN") {
        speak(LINES.tooClose);
      } else if (type === "PHASE1_RECOVERY") {
        showToast({ kind: "phase1", text: LINES.phase1 }, 2500);
      } else if (type === "POSTURE_NUDGE") {
        speak(LINES.posture);
        showToast({ kind: "posture", text: LINES.posture }, 4000);
      }
    });
    viewer.on("parentPairing", setParentPairing);
    viewer.on("parentJoined", ({ parentCount }) => {
      setParentPairing((p) => (p ? { ...p, parentCount } : p));
      showToast({ kind: "paired", text: L(`Parent phone added (${parentCount} in total)`, `保護者のスマホを登録しました（${parentCount}台）`) }, 6000);
      if (!setupRef.current) {
        setQrOpen(false);
        setMenuOpen(true);
      }
    });
    viewer.on("calibrationPattern", (pattern) => setCalibPattern((p) => ({ pattern, n: (p?.n ?? 0) + 1 })));
    viewer.on("error", (err) => {
      if (err.source === "server") setSessionError(formatViewerError(err));
      else console.error(err.message);
    });
    viewer.setPlaying(Boolean(videoRef.current && !videoRef.current.paused));
    viewer.start();
    return () => {
      viewer.stop();
      viewerRef.current = null;
    };
  }, [saveDay, showToast]);

  // QR code (the viewer keeps the one-time token fresh while it is on screen)
  useEffect(() => {
    const parentView = qrView === "parent";
    viewerRef.current?.setPairingVisible(qrOpen && !parentView);
    viewerRef.current?.setParentPairingVisible(qrOpen && parentView);
    const url = parentView ? parentPairing?.pairingUrl : pairing?.pairingUrl;
    if (!qrOpen || !url) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(url, { width: 560, margin: 1, errorCorrectionLevel: "M" })
      .then(setQrDataUrl)
      .catch((err: Error) => setSessionError(L(`Cannot create the QR code: ${err.message}`, `QRコードを生成できません: ${err.message}`)));
  }, [qrOpen, qrView, pairing, parentPairing]);

  // Setup step 2/2 ends by itself once a parent phone is registered (or one already was).
  useEffect(() => {
    if (setup && qrOpen && qrView === "parent" && (parentPairing?.parentCount ?? 0) > 0) {
      setQrOpen(false);
      setSetup(false);
    }
  }, [setup, qrOpen, qrView, parentPairing]);

  const openCameraQr = useCallback(() => {
    viewerRef.current?.refreshPairing(); // fresh one-time token
    setMenuOpen(false);
    setQrView("camera");
    setQrOpen(true);
  }, []);

  /** OK: the watch camera's QR while none is paired (setup), else the menu. */
  const openQr = useCallback(() => {
    if (!pairing?.cameraPaired) {
      setSetup(true);
      openCameraQr();
      return;
    }
    viewerRef.current?.requestParentPairing(); // the menu shows how many parent phones are registered
    setMenuOpen(true);
  }, [pairing, openCameraQr]);

  const openParentQr = useCallback((reset = false) => {
    setParentPairing(null);
    viewerRef.current?.requestParentPairing(reset);
    setMenuOpen(false);
    setQrView("parent");
    setQrOpen(true);
  }, []);

  const backToMenu = useCallback(() => {
    setQrOpen(false);
    setSetup(false);
    setMenuOpen(true);
  }, []);

  const resetPairing = useCallback(() => {
    viewerRef.current?.resetPairing();
    setSetup(true);
    setQrView("camera");
    setQrOpen(true);
  }, []);

  const newSession = useCallback(() => {
    setSessionError(null);
    viewerRef.current?.newSession();
  }, []);

  // --------------------------------------------------------------------------
  // Playback + lifecycle
  // --------------------------------------------------------------------------
  const savePosition = useCallback(() => {
    const v = videoRef.current;
    if (v && v.currentSrc && Number.isFinite(v.currentTime) && v.currentTime > 1) storage.setJson(KEYS.tvPosition, { url: v.getAttribute("src") ?? v.currentSrc, t: v.currentTime });
  }, []);

  const play = useCallback(async (attempt = 0): Promise<void> => {
    try {
      await videoRef.current?.play();
      setPlayError(null);
    } catch (err) {
      // On the Fire TV an AbortError right after coming back is the media pipeline restarting: try again,
      // then start the page afresh (same as quitting and relaunching).
      if (nativeBridge() && (err as Error).name === "AbortError") {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500));
          return play(attempt + 1);
        }
        savePosition();
        if (reloadPage("play_abort")) return;
      }
      setPlayError(
        L(`Cannot play (${(err as Error).name}). `, `再生できません（${(err as Error).name}）。`) + `${nativeBridge() ? L("Press Play on the remote.", "リモコンの再生ボタンを押してください。") : L("Click the screen to play.", "画面をクリックすると再生します。")}`
      );
    }
  }, [savePosition]);

  const stepPause = useCallback(() => {
    const f = frameRef.current;
    const action = pauseTrackerRef.current.step({
      state: f.state,
      mode: f.mode,
      connected: f.link.connected,
      nowMs: Date.now(),
    });
    if (action === "pause") {
      interventionPausedRef.current = true;
      setInterventionPaused(true);
      videoRef.current?.pause();
    } else if (action === "resume") {
      interventionPausedRef.current = false;
      setInterventionPaused(false);
      void play();
    }
  }, [play]);

  const stepPauseRef = useRef(stepPause);
  stepPauseRef.current = stepPause;

  useEffect(() => {
    pauseTrackerRef.current.updateConfig(tvSettings.pause);
    stepPauseRef.current();
  }, [tvSettings.pause]);

  useEffect(() => {
    const id = setInterval(() => stepPauseRef.current(), 250);
    return () => clearInterval(id);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // Play pressed during the quiet pause: the adult decided, the pause ends (it comes back only
      // after another full stretch of being too close).
      if (interventionPausedRef.current) {
        interventionPausedRef.current = false;
        setInterventionPaused(false);
        pauseTrackerRef.current.reset();
      }
      void play();
    } else v.pause();
  }, [play]);

  useEffect(() => {
    if (!nativeBridge()) {
      setOverlayReady(true);
      return;
    }
    claimVideoOverlay(HOLDER_SRC).then(
      () => setOverlayReady(true),
      (err: Error) => setPlayError(L(`Could not prepare the video: ${err.message}`, `映像の準備に失敗しました: ${err.message}`))
    );
  }, []);

  // Real Fire TV: keep the picture drawn into the page for as long as the app runs (awv-overlay.ts).
  useEffect(() => {
    const v = videoRef.current;
    if (!overlayReady || !v || !nativeBridge()) return;
    const prefix = L("The video is not being drawn: ", "映像が表示できていません: ");
    return watchVideoDrawn(
      v,
      (message) => setPlayError(`${prefix}${message}`),
      () => setPlayError((e) => (e?.startsWith(prefix) ? null : e))
    );
  }, [overlayReady]);

  // Playlist: restore the parent's pick and the position; save every change.
  useEffect(() => {
    const saved = storage.getJson<PlaylistState>(KEYS.tvPlaylist);
    if (saved) {
      const parsed = PlaylistSchema.safeParse(saved.playlist);
      if (parsed.success) setPl({ playlist: upgradeLegacyUrls(parsed.data), index: Math.max(0, Math.min(parsed.data.items.length - 1, Math.floor(saved.index) || 0)) });
      else {
        storage.remove(KEYS.tvPlaylist);
        setPlayError(L(`The saved video list could not be read and was removed (${parsed.error.issues[0]?.message ?? "invalid"}). Pick it again on the parent phone.`, `保存していた動画リストが読めないため消しました（${parsed.error.issues[0]?.message ?? "invalid"}）。保護者のスマホで選び直してください。`));
      }
    }
    setPlLoaded(true);
  }, []);
  useEffect(() => {
    if (plLoaded) storage.setJson(KEYS.tvPlaylist, pl);
  }, [pl, plLoaded]);

  // Settings: restore saved TV settings (childCues, marker, pause) on mount.
  useEffect(() => {
    const raw = storage.getJson<unknown>(KEYS.tvSettings);
    if (raw === null) return;
    // An older or broken copy is dropped with its error; the relay sends the saved settings on tv_hello.
    const saved = TvSettingsSchema.safeParse(raw);
    if (!saved.success) {
      console.error("[firesense] stored TV settings are invalid, dropped:", saved.error.message);
      storage.remove(KEYS.tvSettings);
      return;
    }
    setTvSettings(saved.data);
    pauseTrackerRef.current.updateConfig(saved.data.pause);
  }, []);

  const advance = useCallback((delta: number) => {
    setItemError(null);
    setPl((p) => ({ ...p, index: (p.index + delta + p.playlist.items.length) % p.playlist.items.length }));
  }, []);
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  const seekBy = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 0.5, v.currentTime + seconds));
  }, []);

  // A new item: play it, credit it on screen, and (once per launch, on the real Fire TV) check that
  // the picture is really drawn into the page.
  useEffect(() => {
    if (!videoSrc) return;
    // Back where this video was before a reload (standby recovery), once.
    const pos = storage.getJson<{ url: string; t: number }>(KEYS.tvPosition);
    storage.remove(KEYS.tvPosition);
    const v = videoRef.current;
    if (v && pos && pos.url === item.url && Number.isFinite(pos.t)) {
      const seek = () => {
        if (Number.isFinite(v.duration) && pos.t < v.duration - 2) v.currentTime = pos.t;
      };
      if (v.readyState >= 1) seek();
      else v.addEventListener("loadedmetadata", seek, { once: true });
    }
    // During the quiet pause (the parent skipped to another video) the new item waits too.
    if (!interventionPausedRef.current) void play();
    showToast({ kind: "video", text: `▶ ${item.title}${item.credit ? `\n${item.credit}` : ""}` }, 6000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSrc, play]);

  // A broken item: say why (the error stays on the TV and goes to the parent), then go on.
  const onVideoError = useCallback(() => {
    const v = videoRef.current;
    const code = v?.error?.code;
    const why =
      code === 2
        ? L("network error", "ネットワークのエラー")
        : code === 3
        ? L("decode error", "デコードのエラー")
        : code === 4
        ? L("unsupported format, or the host does not allow CORS", "形式が未対応か、配信元が CORS を許可していない")
        : L(`error code ${code ?? "?"}`, `エラーコード ${code ?? "?"}`);
    const detail = `${why}${v?.error?.message ? `: ${v.error.message}` : ""}`;
    setItemError(
      L(`Cannot play "${item.title}" (${detail})`, `「${item.title}」を再生できません（${detail}）`) + (item.url.startsWith("http") ? ` ${item.url}` : "")
    );
  }, [item]);
  useEffect(() => {
    if (!itemError || pl.playlist.items.length < 2) return;
    const t = setTimeout(() => advanceRef.current(1), ERROR_SKIP_MS);
    return () => clearTimeout(t);
  }, [itemError, pl.playlist.items.length]);

  // Tell the parent phones what is playing: on every change, and every 20 s.
  const nowPlayingRef = useRef<() => void>(() => undefined);
  nowPlayingRef.current = () => {
    viewerRef.current?.reportNowPlaying({
      playlistId: pl.playlist.id,
      playlistTitle: pl.playlist.title,
      index: Math.min(pl.index, pl.playlist.items.length - 1),
      count: pl.playlist.items.length,
      title: item.title,
      error: itemError,
    });
  };
  useEffect(() => {
    if (plLoaded) nowPlayingRef.current();
  }, [pl, item, itemError, plLoaded]);
  useEffect(() => {
    const t = setInterval(() => nowPlayingRef.current(), 20_000);
    return () => clearInterval(t);
  }, []);

  // Desktop browser trial: autoplay can be blocked until the user interacts with the page. The first
  // click anywhere (e.g. on the pairing link) retries, and the error stays on screen until it plays.
  useEffect(() => {
    if (isApk || !playError) return;
    const retry = () => void play();
    window.addEventListener("pointerdown", retry, { once: true });
    return () => window.removeEventListener("pointerdown", retry);
  }, [isApk, playError, play]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => viewerRef.current?.setPlaying(true);
    const onPause = () => {
      if (interventionPausedRef.current) return;
      viewerRef.current?.setPlaying(false);
      void postSummary();
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [postSummary]);

  useEffect(() => {
    const onLifecycle = (e: Event) => {
      const state = (e as CustomEvent<{ state: "pause" | "resume" }>).detail?.state;
      console.info(`[firesense-overlay] ${JSON.stringify({ event: `app_${state}`, at: new Date().toISOString() })}`);
      if (state === "pause") {
        backgroundAtRef.current = Date.now();
        savePosition();
        videoRef.current?.pause();
      }
      if (state === "resume") {
        const away = backgroundAtRef.current ? Date.now() - backgroundAtRef.current : 0;
        backgroundAtRef.current = null;
        if (away > RESUME_RELOAD_AFTER_MS && reloadPage(`resume_after_${Math.round(away / 1000)}s`)) return;
        // A few seconds in the background can leave a socket that looks open but is dead: reconnect.
        if (away > 3000) viewerRef.current?.reconnect();
        if (!interventionPausedRef.current) void play();
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        savePosition();
        videoRef.current?.pause();
      }
    };
    window.addEventListener("firesense:lifecycle", onLifecycle);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("firesense:lifecycle", onLifecycle);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [play, savePosition]);

  const exitApp = useCallback(async () => {
    videoRef.current?.pause();
    await postSummary();
    nativeBridge()?.exitApp();
    setExitConfirm(false);
  }, [postSummary]);

  // --------------------------------------------------------------------------
  // Render benchmark (MEASUREMENT §5). Fast-forward on the remote (or "f" with the debug overlay
  // open) starts it; pressing again stops it. Results are shown in the debug overlay and recorded.
  // --------------------------------------------------------------------------
  const toggleBenchmark = useCallback(() => {
    if (benchAbortRef.current) {
      benchAbortRef.current.abort();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    const ctrl = new AbortController();
    benchAbortRef.current = ctrl;
    setDebug(true);
    setBenchError(null);
    setBenchResult(null);
    runRenderBenchmark({
      video,
      onStep: (index, step) => setBenchStep({ index, step }),
      signal: ctrl.signal,
    })
      .then((r) => {
        setBenchResult(r);
        recordMeasurement("render_bench", { ...r, csv: benchToCsv(r) });
      })
      .catch((err: Error) => setBenchError(err.message))
      .finally(() => {
        benchAbortRef.current = null;
        setBenchStep(null);
      });
  }, []);

  useEffect(() => () => benchAbortRef.current?.abort(), []);

  // Rewind on the remote (or "t" with the debug overlay open): 20 probes, 1 per second.
  // A probe without a reply within 5 s is counted as lost, never as a time.
  const runRoundTrips = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || rttRunningRef.current) return;
    rttRunningRef.current = true;
    setDebug(true);
    const samples: (number | null)[] = [];
    let error: string | undefined;
    setRtt({ running: true, samples: [] });
    for (let i = 0; i < RTT_PROBES; i++) {
      const started = performance.now();
      try {
        samples.push(Math.round(await viewer.measureRoundTrip(5000)));
      } catch (err) {
        samples.push(null);
        error = (err as Error).message;
      }
      setRtt({ running: true, samples: [...samples], error });
      const wait = 1000 - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const ok = samples.filter((x): x is number => x !== null).sort((a, b) => a - b);
    const data = {
      probes: RTT_PROBES,
      received: ok.length,
      lost: RTT_PROBES - ok.length,
      medianMs: ok.length ? percentile(ok, 50) : null,
      p90Ms: ok.length ? percentile(ok, 90) : null,
      minMs: ok.length ? ok[0] : null,
      maxMs: ok.length ? ok[ok.length - 1] : null,
      samplesMs: samples,
      lastError: error ?? null,
    };
    recordMeasurement("relay_rtt", data);
    setRtt({
      running: false,
      samples,
      error,
      summary: ok.length
        ? `median ${data.medianMs} ms · p90 ${data.p90Ms} ms · min ${data.minMs} · max ${data.maxMs} · lost ${data.lost}/${RTT_PROBES}`
        : `no reply (lost ${RTT_PROBES}/${RTT_PROBES})`,
    });
    rttRunningRef.current = false;
  }, []);

  // --------------------------------------------------------------------------
  // Remote control (D-pad). Enter = QR, Back = close / exit confirm.
  // --------------------------------------------------------------------------
  const onBack = useCallback(() => {
    if (measureOpen) setMeasureOpen(false);
    else if (qrOpen && qrView === "parent" && setup) {
      setQrOpen(false); // "Later"
      setSetup(false);
    } else if (qrOpen && pairing?.cameraPaired) backToMenu();
    else if (menuOpen) setMenuOpen(false);
    else if (exitConfirm) setExitConfirm(false);
    else setExitConfirm(true);
  }, [measureOpen, qrOpen, qrView, setup, menuOpen, pairing, exitConfirm, backToMenu]);

  const openMeasure = useCallback(() => {
    setQrOpen(false);
    setMenuOpen(false);
    setMeasureOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.keyCode;
      const dialogOpen = exitConfirm || qrOpen || menuOpen || measureOpen || sessionError;
      const arrow = e.key.startsWith("Arrow") || (k >= 19 && k <= 22) || (k >= 37 && k <= 40);
      if (dialogOpen && arrow) {
        // Android WebView has no spatial navigation: move focus between the dialog's buttons ourselves.
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-dialog] button"));
        if (buttons.length > 0) {
          e.preventDefault();
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const back = e.key === "ArrowLeft" || e.key === "ArrowUp" || k === 21 || k === 19 || k === 37 || k === 38;
          const next = i < 0 ? 0 : (i + (back ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next].focus();
        }
        return;
      }
      if (e.key === "MediaPlayPause" || k === 85 || k === 179) {
        e.preventDefault();
        togglePlay();
      } else if ((e.key === "Enter" || k === 13 || k === 23) && !dialogOpen) {
        e.preventDefault();
        openQr();
      } else if (e.key === "Escape" || e.key === "GoBack" || k === 27 || k === 8) {
        e.preventDefault();
        onBack();
      } else if (e.key === "ContextMenu" || k === 82 || e.key === "d") {
        setDebug((x) => !x);
      } else if (e.key === "b" && debug) {
        setBlurMode((m) => (m === "full" ? "downscale" : "full"));
      } else if (e.key === "f" && debug) {
        toggleBenchmark();
      } else if (e.key === "t" && debug) {
        void runRoundTrips();
      } else if (e.key === "MediaFastForward" || k === 228) {
        e.preventDefault();
        seekBy(SEEK_S);
      } else if (e.key === "MediaRewind" || k === 227) {
        e.preventDefault();
        seekBy(-SEEK_S);
      } else if (!dialogOpen && (e.key === "ArrowRight" || e.key === "MediaTrackNext" || k === 22 || k === 39 || k === 176)) {
        e.preventDefault();
        advance(1);
      } else if (!dialogOpen && (e.key === "ArrowLeft" || e.key === "MediaTrackPrevious" || k === 21 || k === 37 || k === 177)) {
        e.preventDefault();
        advance(-1);
      }
    };
    const onNativeBack = () => onBack();
    const onNativeKey = (e: Event) => {
      const key = (e as CustomEvent<{ key: "playpause" | "menu" | "seekForward" | "seekBack" | "next" | "previous" }>).detail?.key;
      if (key === "playpause") togglePlay();
      if (key === "menu") setDebug((x) => !x);
      if (key === "seekForward") seekBy(SEEK_S);
      if (key === "seekBack") seekBy(-SEEK_S);
      if (key === "next") advance(1);
      if (key === "previous") advance(-1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("firesense:back", onNativeBack);
    window.addEventListener("firesense:key", onNativeKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("firesense:back", onNativeBack);
      window.removeEventListener("firesense:key", onNativeKey);
    };
  }, [exitConfirm, qrOpen, menuOpen, measureOpen, sessionError, togglePlay, openQr, onBack, debug, toggleBenchmark, runRoundTrips, seekBy, advance]);

  // --------------------------------------------------------------------------
  // Render-performance probes (Phase 4 spike: blur cost on Fire TV)
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!debug) return;
    let frames = 0;
    let raf = 0;
    const loop = () => {
      frames++;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    let vFrames = 0;
    const v = videoRef.current as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }) | null;
    const hasRvfc = Boolean(v?.requestVideoFrameCallback);
    const onVideoFrame = () => {
      vFrames++;
      v?.requestVideoFrameCallback?.(onVideoFrame);
    };
    if (hasRvfc) v!.requestVideoFrameCallback!(onVideoFrame);
    const id = setInterval(() => {
      setRenderFps(frames);
      setVideoFps(hasRvfc ? vFrames : null);
      frames = 0;
      vFrames = 0;
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, [debug]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------
  // The viewer already zeroes blur and withholds state while the link is down.
  const { link } = frame;
  const connected = link.connected;
  // While the render benchmark runs, its step decides blur and mode (and the cards stay hidden).
  const blurPx = benchStep ? benchStep.step.blurPx : frame.blurPx;
  const effectiveBlurMode = benchStep ? benchStep.step.mode : blurMode;
  const state = frame.state ?? "SAFE";
  const telemetry = viewerRef.current?.lastTelemetry ?? null; // debug readout only
  // Shadow mode (field pilot): nothing that reacts to distance; the viewer already sends blurPx 0.
  const shadow = frame.mode === "shadow";
  const showCard = connected && !shadow && !benchStep && tvSettings.childCues && WARN_STATES.has(state);
  const showHint = connected && !shadow && !benchStep && tvSettings.childCues && state === "APPROACHING";
  const showMarker =
    connected && !shadow && !benchStep && tvSettings.marker && (state === "APPROACHING" || state === "TOO_CLOSE" || state === "BELOW_FRAME");
  const relayDown = relayState !== "open";
  const showBadge = !connected && (relayDown || Boolean(pairing?.cameraPaired));
  const downscaled = effectiveBlurMode === "downscale" && blurPx > 0;
  const visualStyles = computeTvVisualStyles(blurPx, effectiveBlurMode);

  // Ack once the pattern is actually on screen (two animation frames after the render).
  // A pattern left on for 20s (phone gone mid-calibration) is cleared so the child is not stuck.
  useEffect(() => {
    if (!calibPattern) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        viewerRef.current?.ackCalibrationPattern(calibPattern.pattern);
      });
    });
    const clear = calibPattern.pattern === "off" ? null : setTimeout(() => setCalibPattern(null), 20_000);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (clear) clearTimeout(clear);
    };
  }, [calibPattern]);

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden select-none">
      {calibPattern && calibPattern.pattern !== "off" && (
        <div
          className="fixed inset-0 z-[100]"
          style={{ background: calibPattern.pattern === "magenta" ? "#ff00ff" : "#000000" }}
          aria-label={L("Calibrating", "キャリブレーション中")}
        />
      )}
      {/* Video (the only thing that is blurred) */}
      <div className="absolute inset-0 overflow-hidden">
        <video
          ref={videoRef}
          onClick={isApk ? undefined : togglePlay /* desktop browser trial: autoplay may be blocked */}
          src={videoSrc}
          crossOrigin="anonymous"
          loop={pl.playlist.items.length === 1}
          onEnded={() => advance(1)}
          onError={onVideoError}
          playsInline
          preload="auto"
          className="absolute top-0 left-0 object-cover"
          style={
            downscaled
              ? {
                  width: "12.5%",
                  height: "12.5%",
                  transformOrigin: "top left",
                  transform: visualStyles.transform,
                  filter: visualStyles.filter,
                  transition: "filter 500ms ease-out",
                }
              : {
                  width: "100%",
                  height: "100%",
                  filter: visualStyles.filter,
                  transform: visualStyles.transform,
                  transition: "filter 500ms ease-out, transform 500ms ease-out",
                }
          }
        />
      </div>

      {/* Top bar: stars (not in shadow mode, and only when childCues is enabled) */}
      {!shadow && tvSettings.childCues && (
        <div className="absolute top-6 right-8 z-30 flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900/80 border border-slate-700">
          <Star className="w-5 h-5 text-yellow-400 fill-yellow-400" />
          <span className="text-white font-black text-lg">{stars}</span>
          <span className="text-slate-400 text-sm">/ {TARGET_STARS}</span>
        </div>
      )}

      {/* Shadow mode: a small fixed label. It never changes with distance (must not steer the child). */}
      {shadow && (
        <div className="absolute top-6 right-8 z-30 px-3 py-1 rounded-full bg-slate-900/70 border border-slate-700 text-slate-400 text-xs">
          {L("Record only", "記録のみ")}
        </div>
      )}

      {/* Sensor-disconnected badge (plan §3): calm colors, persistent, never silent */}
      {showBadge && (
        <div className="absolute top-6 left-8 z-30 flex items-center gap-2 px-4 py-2 rounded-full bg-slate-800/85 border border-slate-600 text-slate-200 text-sm">
          <Smartphone className="w-4 h-4 text-sky-300" />
          <span className="flex flex-col">
            <span>
              {relayDown ? L("Connecting to the relay…", "中継サーバーに接続中…") : L("Sensor not connected", "見守りセンサー未接続")}
              <span className="ml-2 text-slate-400 text-xs">{relayDown ? L("(reconnecting automatically)", "（自動で再接続します）") : L("(press OK for the menu)", "（決定ボタンでメニュー）")}</span>
            </span>
            {!relayDown && <span className="text-slate-300 text-xs">{sensorDownReason(link)}</span>}
          </span>
        </div>
      )}

      {connected && frame.test && (
        <div className="absolute top-20 left-8 z-30 px-3 py-1 rounded-full bg-fuchsia-900/80 border border-fuchsia-400/60 text-fuchsia-100 text-xs">
          {L("Test input (phone test mode, not recorded)", "テスト入力中（スマホのテストモード・記録されません）")}
        </div>
      )}

      {/* APPROACHING: corner hint */}
      {showHint && (
        <div className="absolute top-24 right-8 z-30 px-5 py-4 rounded-2xl bg-amber-950/85 border border-amber-500/50 flex items-center gap-3">
          <span className="text-4xl">🐕</span>
          <span className="text-white font-bold text-lg">{LINES.approaching}</span>
        </div>
      )}

      {/* TOO_CLOSE / BELOW_FRAME: center card */}
      {showCard && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/40">
          <div className="text-center max-w-md p-8 rounded-3xl bg-slate-900/90 border-2 border-orange-400/80 space-y-4">
            <div className="text-7xl">🐕</div>
            <h2 className="text-3xl font-extrabold text-orange-400">{LINES.tooClose}</h2>
            <p className="text-slate-200">{L("Two steps back and it comes right back!", "うしろへ 2ほ さがると パッと もどるよ！")}</p>
          </div>
        </div>
      )}

      {/* Toasts: praise / phase 1 / posture / paired */}
      {toast && (
        <div
          className={`absolute bottom-16 left-1/2 -translate-x-1/2 z-50 px-6 py-4 rounded-2xl border-2 text-white font-bold text-xl ${
            toast.kind === "praise"
              ? "bg-emerald-950/90 border-emerald-400"
              : toast.kind === "posture"
              ? "bg-indigo-950/90 border-indigo-400"
              : toast.kind === "paired"
              ? "bg-slate-900/95 border-orange-400"
              : toast.kind === "video"
              ? "bg-slate-950/80 border-slate-500 !text-base !font-normal whitespace-pre-line text-left"
              : "bg-amber-950/90 border-amber-400"
          }`}
        >
          {toast.kind === "praise" && "🌟 "}
          {toast.text}
        </div>
      )}

      {/* Small calm marker at bottom center (U2 §4) */}
      {showMarker && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-none max-h-[10vh]">
          <div className="px-5 py-2 rounded-full bg-slate-900/80 border border-slate-700/80 backdrop-blur-sm flex items-center gap-3 text-slate-300">
            <svg
              className="w-6 h-6 text-orange-400/90"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="20" x2="21" y2="20" />
              <line x1="12" y1="4" x2="12" y2="15" />
              <polyline points="7 10 12 15 17 10" />
            </svg>
            <span className="text-xs font-medium tracking-wide">{L("Step back", "うしろへ")}</span>
          </div>
        </div>
      )}

      {/* Quiet safety pause overlay (U2 §5) */}
      {interventionPaused && (
        <div className="absolute inset-0 z-40 bg-black/75 flex flex-col items-center justify-center pointer-events-none">
          <div className="px-6 py-4 rounded-2xl bg-slate-900/90 border border-slate-700/80 text-slate-200 text-lg flex items-center gap-3 shadow-2xl">
            <span className="text-xl">⏸</span>
            <span>{L("Step back to keep watching", "はなれると つづきから みられるよ")}</span>
          </div>
        </div>
      )}

      {/* Menu (OK after setup): both devices' state; each opens its own QR screen. */}
      {menuOpen && (
        <div data-dialog className="absolute inset-0 z-50 bg-slate-950/90 flex items-center justify-center">
          <div className="w-[760px] p-10 rounded-3xl bg-slate-900 border border-slate-700 space-y-6">
            <h2 className="text-3xl font-extrabold text-white">{L("Menu", "メニュー")}</h2>
            <div className="grid grid-cols-2 gap-5">
              <div className="p-5 rounded-2xl border-2 border-orange-500/70 bg-orange-500/10 space-y-2">
                <div className="text-4xl">📷</div>
                <div className="text-xl font-bold text-orange-200">{L("Watch camera", "見守りカメラ")}</div>
                <div className="text-sm text-slate-300">{L("The phone that watches the room from near the TV", "テレビの近くから部屋を見守るスマホ")}</div>
                <div className={`text-lg font-bold ${connected ? "text-emerald-300" : "text-amber-300"}`}>
                  {connected ? L("✓ Connected", "✓ 接続中") : pairing?.cameraPaired ? L("Paired · not connected now", "登録済み・いまは未接続") : L("Not paired", "未登録")}
                </div>
              </div>
              <div className="p-5 rounded-2xl border-2 border-indigo-500/70 bg-indigo-500/10 space-y-2">
                <div className="text-4xl">📱</div>
                <div className="text-xl font-bold text-indigo-200">{L("Parent phones", "保護者のスマホ")}</div>
                <div className="text-sm text-slate-300">{L("The phone in your hand: settings and records", "手に持つスマホ: 設定と記録")}</div>
                <div className="text-lg font-bold text-slate-200">
                  {parentPairing ? L(`${parentPairing.parentCount} added (up to 4)`, `${parentPairing.parentCount}台 登録済み（最大4台）`) : "…"}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button autoFocus onClick={guarded(() => openParentQr())} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-indigo-700">
                📱 {L("Add a parent phone", "保護者のスマホを追加")}
              </button>
              <button onClick={guarded(openCameraQr)} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-orange-700">
                📷 {L("Pair the watch camera again", "見守りカメラを登録しなおす")}
              </button>
              <button onClick={guarded(openMeasure)} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-slate-700">
                {L("Measurement menu", "計測メニュー")}
              </button>
              <button onClick={guarded(() => switchLang(lang() === "ja" ? "en" : "ja"))} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-slate-700">
                {lang() === "ja" ? "English" : "日本語"}
              </button>
              <button onClick={guarded(() => setMenuOpen(false))} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-slate-700">
                {L("Close", "とじる")}
              </button>
            </div>
            <p className="text-xs text-slate-500">{L("Choose with ◀ ▶, then OK · Back closes", "◀ ▶ で選んで決定・戻るで閉じる")}</p>
          </div>
        </div>
      )}

      {/* QR screen: one device at a time, in its role's color (orange = watch camera, indigo = parent phone). */}
      {qrOpen && (
        <div data-dialog className="absolute inset-0 z-50 bg-slate-950/90 flex flex-col items-center justify-center gap-5">
          {setup && (
            <div className="flex items-center gap-4 text-lg font-bold">
              <span className={qrView === "camera" ? "text-orange-300" : "text-emerald-300"}>{qrView === "camera" ? "①" : "✓"} {L("Watch camera", "見守りカメラ")}</span>
              <span className="text-slate-600">→</span>
              <span className={qrView === "parent" ? "text-indigo-300" : "text-slate-500"}>② {L("Parent phone", "保護者のスマホ")}</span>
            </div>
          )}
          <div className={`flex items-center gap-12 p-10 rounded-3xl bg-slate-900 border-4 ${qrView === "camera" ? "border-orange-500" : "border-indigo-500"}`}>
            <div className={`w-[280px] h-[280px] bg-white rounded-xl flex items-center justify-center ring-8 ${qrView === "camera" ? "ring-orange-500/60" : "ring-indigo-500/60"}`}>
              {qrDataUrl ? <img src={qrDataUrl} alt={L("Pairing QR code", "ペアリング用QRコード")} className="w-full h-full" /> : <span className="text-slate-500">{L("Preparing…", "準備中…")}</span>}
            </div>
            <div className="max-w-sm space-y-4">
              {qrView === "camera" ? (
                <>
                  <div className="text-sm font-bold tracking-widest text-orange-300">{setup ? L("STEP 1 OF 2 · WATCH CAMERA", "手順 1/2・見守りカメラ") : L("WATCH CAMERA", "見守りカメラ")}</div>
                  <h2 className="text-3xl font-extrabold text-white">📷 {L("Scan with the phone that stays by the TV", "テレビの近くに置くスマホで読み取る")}</h2>
                  <p className="text-slate-300">{L("This phone's camera will watch the room. Not the phone you keep in your hand.", "このスマホのカメラで部屋を見守ります。手に持つスマホではありません。")}</p>
                </>
              ) : (
                <>
                  <div className="text-sm font-bold tracking-widest text-indigo-300">{setup ? L("STEP 2 OF 2 · PARENT PHONE", "手順 2/2・保護者のスマホ") : L("PARENT PHONE", "保護者のスマホ")}</div>
                  <h2 className="text-3xl font-extrabold text-white">📱 {L("Scan with the phone in your hand", "あなたが持つスマホで読み取る")}</h2>
                  <p className="text-slate-300">
                    {L("Change the distances, calibration and mode without touching the watch camera, and see the records.", "見守りカメラに触らずに、距離・キャリブレーション・モードを変えたり、記録を見たりできます。")}
                  </p>
                  <p className="text-sm text-slate-400">
                    {L("Added", "登録済み")}: {parentPairing ? L(`${parentPairing.parentCount}`, `${parentPairing.parentCount}台`) : "…"} {L("(up to 4)", "（最大4台）")}
                  </p>
                </>
              )}
              <p className="text-xs text-slate-500">{L("Each QR code works once (renewed every 5 minutes).", "QRは1回だけ使えます（5分で更新）。")}</p>
              {/* In a desktop browser (not the APK) the phone page can also be opened next to this one — no hardware needed. */}
              {!isApk && qrView === "camera" && pairing && (
                <a href={pairing.pairingUrl} target="_blank" rel="noopener" className="block text-xs text-sky-300 underline break-all">
                  {L("Try on a PC: open this link in a new window (instead of a phone; test mode moves the distance)", "PCで試す: このリンクを新しいウィンドウで開く（スマホの代わり。テストモードで距離を動かせます）")}
                </a>
              )}
              {!isApk && qrView === "parent" && parentPairing && (
                <a href={parentPairing.pairingUrl} target="_blank" rel="noopener" className="block text-xs text-sky-300 underline break-all">
                  {L("Try on a PC: open the parent page in a new window", "PCで試す: 保護者のページを新しいウィンドウで開く")}
                </a>
              )}
              <div className="flex flex-wrap gap-3 pt-2">
                {qrView === "camera" ? (
                  <>
                    {pairing?.cameraPaired ? (
                      <>
                        <button autoFocus onClick={guarded(backToMenu)} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-slate-700">
                          {L("Back", "もどる")}
                        </button>
                        <button onClick={guarded(resetPairing)} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-rose-900">
                          {L("Unpair the current watch camera", "今の見守りカメラの登録を解除")}
                        </button>
                      </>
                    ) : (
                      <button autoFocus onClick={guarded(() => switchLang(lang() === "ja" ? "en" : "ja"))} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-slate-700">
                        {lang() === "ja" ? "English" : "日本語"}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {setup ? (
                      <button
                        autoFocus
                        onClick={guarded(() => {
                          setQrOpen(false);
                          setSetup(false);
                        })}
                        className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-slate-700"
                      >
                        {L("Later", "あとで")}
                      </button>
                    ) : (
                      <button autoFocus onClick={guarded(backToMenu)} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-slate-700">
                        {L("Back", "もどる")}
                      </button>
                    )}
                    {!setup && Boolean(parentPairing?.parentCount) && (
                      <button onClick={guarded(() => openParentQr(true))} className="px-5 py-2 rounded-xl text-white focus:ring-4 focus:ring-orange-400 outline-none bg-rose-900">
                        {L("Remove all parent phones", "保護者のスマホの登録をすべて解除")}
                      </button>
                    )}
                  </>
                )}
              </div>
              <p className="text-xs text-slate-500">{L("Choose with ◀ ▶, then OK", "◀ ▶ で選んで決定")}</p>
            </div>
          </div>
        </div>
      )}

      {/* Measurement menu (⏩ / ⏪ now seek within the video; ◀ / ▶ change the video) */}
      {measureOpen && (
        <div data-dialog className="absolute inset-0 z-50 bg-slate-950/85 flex items-center justify-center">
          <div className="max-w-lg p-8 rounded-3xl bg-slate-900 border border-slate-700 space-y-4">
            <h2 className="text-2xl font-bold text-white">{L("Measurement menu", "計測メニュー")}</h2>
            <p className="text-sm text-slate-400">{L("Results appear in the debug overlay at the bottom right and in the log (firesense-measure).", "結果は右下のデバッグ表示に出て、記録（firesense-measure）にも残ります。")}</p>
            <div className="flex flex-wrap gap-3">
              <button
                autoFocus
                onClick={guarded(() => {
                  setMeasureOpen(false);
                  toggleBenchmark();
                })}
                className="px-5 py-2 rounded-xl bg-orange-600 text-white focus:ring-4 focus:ring-orange-300 outline-none"
              >
                {benchStep ? L("Stop the render benchmark", "描画ベンチマークを中止") : L("Render benchmark", "描画ベンチマーク")}
              </button>
              <button
                onClick={guarded(() => {
                  setMeasureOpen(false);
                  void runRoundTrips();
                })}
                className="px-5 py-2 rounded-xl bg-orange-600 text-white focus:ring-4 focus:ring-orange-300 outline-none"
              >
                {L("Relay round trip", "中継の往復計測")}
              </button>
              <button onClick={guarded(() => setDebug((x) => !x))} className="px-5 py-2 rounded-xl bg-slate-700 text-white focus:ring-4 focus:ring-orange-300 outline-none">
                {L("Debug overlay", "デバッグ表示")} {debug ? "OFF" : "ON"}
              </button>
              <button onClick={guarded(() => setMeasureOpen(false))} className="px-5 py-2 rounded-xl bg-slate-700 text-white focus:ring-4 focus:ring-orange-300 outline-none">
                {L("Close", "とじる")}
              </button>
            </div>
            <p className="text-xs text-slate-500">{L("Choose with ◀ ▶, then OK", "◀ ▶ で選んで決定")}</p>
          </div>
        </div>
      )}

      {/* Session error (fail-fast, explicit recovery) */}
      {sessionError && (
        <div data-dialog className="absolute inset-0 z-50 bg-slate-950/95 flex items-center justify-center">
          <div className="max-w-lg p-8 rounded-3xl bg-slate-900 border-2 border-rose-500 space-y-4 text-center">
            <h2 className="text-2xl font-bold text-rose-300">{L("Error from the relay", "中継サーバーからのエラー")}</h2>
            <p className="font-mono text-sm text-slate-200 break-all">{sessionError}</p>
            <div className="flex justify-center gap-3">
              <button autoFocus onClick={guarded(newSession)} className="px-5 py-2 rounded-xl bg-orange-600 text-white focus:ring-4 focus:ring-orange-300 outline-none">
                {L("Pair again from scratch", "新しくペアリングし直す")}
              </button>
              <button onClick={guarded(() => setSessionError(null))} className="px-5 py-2 rounded-xl bg-slate-700 text-white focus:ring-4 focus:ring-orange-300 outline-none">
                {L("Close", "とじる")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Exit confirmation (Back key) */}
      {exitConfirm && (
        <div data-dialog className="absolute inset-0 z-50 bg-slate-950/80 flex items-center justify-center">
          <div className="p-8 rounded-3xl bg-slate-900 border border-slate-700 space-y-4 text-center">
            <h2 className="text-2xl font-bold text-white">{L("Done for today?", "きょうは おしまいにする？")}</h2>
            <div className="flex justify-center gap-3">
              <button autoFocus onClick={guarded(() => setExitConfirm(false))} className="px-5 py-2 rounded-xl bg-slate-700 text-white focus:ring-4 focus:ring-orange-400 outline-none">
                {L("Keep watching", "つづける")}
              </button>
              <button onClick={guarded(() => void exitApp())} className="px-5 py-2 rounded-xl bg-orange-600 text-white focus:ring-4 focus:ring-orange-400 outline-none">
                {L("Finish", "おわる")}
              </button>
            </div>
          </div>
        </div>
      )}

      {(playError || summaryError || itemError) && (
        <div className="absolute bottom-4 left-8 z-40 max-w-xl px-4 py-2 rounded-xl bg-rose-950/90 border border-rose-500/60 text-rose-100 text-xs space-y-1">
          {playError && <div>{playError}</div>}
          {itemError && <div className="break-all">{itemError}{pl.playlist.items.length > 1 ? L(` (next video in ${ERROR_SKIP_MS / 1000} s)`, `（${ERROR_SKIP_MS / 1000}秒後に次の動画へ）`) : ""}</div>}
          {summaryError && <div>{L("Could not save the records: ", "記録の保存に失敗: ")}{summaryError}</div>}
        </div>
      )}

      {debug && (
        <div className="absolute bottom-4 right-8 z-50 p-3 rounded-xl bg-black/80 border border-slate-700 font-mono text-[11px] text-slate-200 space-y-0.5">
          <div>relay: {relayState} · link: {connected ? "connected" : link.reason}</div>
          <div>state: {telemetry?.state ?? "—"} · blur: {blurPx}px · seq: {telemetry?.seq ?? "—"} · mode: {frame.mode ?? "—"}</div>
          <div>camera inference: {cameraFps ?? "—"} fps</div>
          <div>render: {renderFps} fps · video: {videoFps ?? "n/a"} fps · blur mode: {effectiveBlurMode} (b)</div>
          <div>session: {viewerRef.current?.credentials?.sessionId ?? "—"}</div>
          <div className="text-slate-400">
            relay round trip: measurement menu (t){" "}
            {rtt ? (rtt.running ? `running ${rtt.samples.length}/${RTT_PROBES} · last ${rtt.samples[rtt.samples.length - 1] ?? "—"} ms` : rtt.summary) : ""}
          </div>
          {rtt?.error && <div className="text-rose-300">round trip error: {rtt.error}</div>}
          {lastClear && <div className="text-slate-400">last disconnect: {lastClear}</div>}
          <div className="text-slate-400">benchmark: measurement menu (f) {benchStep ? L(`running ${benchStep.index + 1}/${BENCH_STEPS.length}: ${benchStep.step.blurPx}px ${benchStep.step.mode} (again to stop)`, `running ${benchStep.index + 1}/${BENCH_STEPS.length}: ${benchStep.step.blurPx}px ${benchStep.step.mode}（もう一度で中止）`) : ""}</div>
          {benchError && <div className="text-rose-300">benchmark error: {benchError}</div>}
          {benchResult && (
            <table className="mt-1 border-collapse">
              <thead>
                <tr className="text-slate-400">
                  <td className="pr-3">blur</td>
                  <td className="pr-3">mode</td>
                  <td className="pr-3">render fps</td>
                  <td className="pr-3">video fps</td>
                  <td className="pr-3">decoded</td>
                  <td>dropped</td>
                </tr>
              </thead>
              <tbody>
                {benchResult.steps.map((s) => (
                  <tr key={`${s.blurPx}-${s.mode}`}>
                    <td className="pr-3">{s.blurPx}px</td>
                    <td className="pr-3">{s.mode}</td>
                    <td className="pr-3">{s.renderFps}</td>
                    <td className="pr-3">{s.videoFps ?? "n/a"}</td>
                    <td className="pr-3">{s.decodedFrames ?? "n/a"}</td>
                    <td>{s.droppedFrames ?? "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
