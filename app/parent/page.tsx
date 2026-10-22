"use client";

/**
 * /parent — the parent phone: adjust the installed watch camera without touching it,
 * and read the weekly records.
 *
 * Pairing: the TV shows a parent QR (OK → "Add a parent phone") that opens this page with
 * ?s=<session>&pt=<one-time token>; the relay answers with a parentSecret kept on this phone.
 * A watch phone that opens this page itself still reads the records with its camera secret
 * (no remote controls then: it is the camera).
 *
 * Records show only real data from DynamoDB. With no records it says so — no seed data.
 * The AI reflection is generated on demand by Claude Sonnet 4.6 on Amazon Bedrock;
 * the Bedrock requestId / latency / tokens are displayed as evidence.
 */

import { LangSwitch } from "@/components/lang";
import { L, lang } from "@/lib/firesense/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CameraCommandSchema,
  PROTOCOL_VERSION,
  WebSocketTransport,
  type BedrockTrace,
  type CameraCommand,
  type CameraStatus,
  type ClientMessage,
  type DayRecord,
  type FireSenseMode,
  type ModeStats,
  type ParentReminders,
  type RtcSignal,
  type ServerMessage,
  type Playlist,
  type TvControl,
  type TvNowPlaying,
  type TvSettings,
  type WeeklyReport,
} from "@/lib/firesense";
import { apiFetch, ApiError } from "@/lib/client/api";
import { localDate, WS_URL } from "@/lib/client/config";
import { KEYS } from "@/lib/client/storage";
import { upgradeLegacyUrls } from "@/lib/client/playlists";
import { loadMode, MODE_LABEL } from "@/lib/client/mode";
import { Banner, TraceLine } from "@/components/ui";
import { CameraRemote, LiveCard, type CommandOutcome } from "@/components/camera-remote";
import { LINK_LABEL } from "@/lib/client/labels";
import { TvPlaylistPanel } from "@/components/tv-playlist";
import { TvSettingsPanel } from "@/components/tv-settings-panel";
import { FloorHeatmap } from "@/components/floor-heatmap";
import { daysAgo, KEPT_DAYS, lastDays, PeriodCompare, RangePicker, ResetRecords, type Range } from "@/components/records-range";
import { HeartHandshake, Megaphone, Sparkles, Wifi, WifiOff } from "lucide-react";

type ParentSession = { sessionId: string; parentSecret: string };

// Getters: the language is set after this module loads.
const TABS = [
  { id: "home", get label() { return L("Home", "ホーム"); } },
  { id: "video", get label() { return L("Videos", "動画"); } },
  { id: "watch", get label() { return L("Watch settings", "見守りの設定"); } },
  { id: "records", get label() { return L("Records", "記録"); } },
] as const;
type TabId = (typeof TABS)[number]["id"];
const TAB_KEY = "firesense.parent.tab";
type CameraSession = { sessionId: string; cameraSecret: string };
/** Who this phone is to the API: a registered parent phone, or the watch phone itself (legacy). */
type Auth = { kind: "parent"; sessionId: string; secret: string } | { kind: "camera"; sessionId: string; secret: string };
type ReportResponse = { range: { from: string; to: string }; days: DayRecord[]; report: WeeklyReport | null; trace: BedrockTrace | null };
type Failure = { message: string; status: number; body: unknown };

const toFailure = (err: unknown): Failure =>
  err instanceof ApiError ? { message: err.message, status: err.status, body: err.body } : { message: String((err as Error).message ?? err), status: 0, body: null };
const readJson = <T,>(key: string): T | null => {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as T) : null;
};
const COMMAND_TIMEOUT_MS = 30_000;

export default function ParentPage() {
  const [auth, setAuth] = useState<Auth | null | undefined>(undefined);
  const [pendingToken, setPendingToken] = useState<{ sessionId: string; token: string } | null>(null);
  const [days, setDays] = useState<DayRecord[] | null>(null);
  // Which days the records show, and optionally a second period to compare the heatmaps with.
  const [range, setRange] = useState<Range>(() => lastDays(7));
  const [compare, setCompare] = useState(false);
  const [rangeB, setRangeB] = useState<Range>(() => ({ from: daysAgo(13), to: daysAgo(7) }));
  const [daysB, setDaysB] = useState<DayRecord[] | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetResult, setResetResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [localMode, setLocalMode] = useState<FireSenseMode | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [reminderError, setReminderError] = useState<Failure | null>(null);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [loadError, setLoadError] = useState<Failure | null>(null);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [reportError, setReportError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- relay (parent phones only) --------------------------------------------
  const transportRef = useRef<WebSocketTransport | null>(null);
  const tokenRef = useRef<{ sessionId: string; token: string } | null>(null);
  const parentRef = useRef<ParentSession | null>(null);
  const [link, setLink] = useState<"idle" | "connecting" | "open" | "closed">("idle");
  const [relayError, setRelayError] = useState<string | null>(null);
  const [tvOnline, setTvOnline] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<TvNowPlaying | null>(null);
  // The family's own list, saved with the session (undefined until the relay sends it).
  const [library, setLibrary] = useState<Playlist | null | undefined>(undefined);
  const [tvSettings, setTvSettings] = useState<TvSettings | null>(null);
  const [cameraOnline, setCameraOnline] = useState(false);
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [outcomes, setOutcomes] = useState<CommandOutcome[]>([]);
  const commandSeqRef = useRef(1);
  const waitingRef = useRef(new Map<number, (o: CommandOutcome) => void>());
  const signalCbsRef = useRef(new Set<(m: RtcSignal) => void>());
  const spareTokenRef = useRef<{ sessionId: string; token: string } | null>(null);
  // The open tab is remembered on this phone only (a convenience; nothing depends on it).
  const [tab, setTab] = useState<TabId>("home");
  useEffect(() => {
    try {
      const t = window.localStorage.getItem(TAB_KEY);
      if (t && TABS.some((x) => x.id === t)) setTab(t as TabId);
    } catch {
      /* storage blocked: stay on home */
    }
  }, []);
  const selectTab = (t: TabId) => {
    setTab(t);
    window.scrollTo({ top: 0 });
    try {
      window.localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage blocked */
    }
  };
  const [notice, setNotice] = useState<string | null>(null);
  // The parent QR read by this TV's watch camera: ask before pairing it as a parent phone too.
  const [roleConflict, setRoleConflict] = useState<{ sessionId: string; token: string } | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = q.get("s");
    const pt = q.get("pt");
    const parent = readJson<ParentSession>(KEYS.parentSession);
    if (s && pt && parent?.sessionId === s) {
      // The same phone read the parent QR again (e.g. to get the page back): it is already registered
      // for this TV, so it opens with its own credentials instead of taking another parent slot. The
      // token is kept only in case those credentials were revoked (BAD_CREDENTIALS below).
      spareTokenRef.current = { sessionId: s, token: pt };
      setNotice(L("This phone is already added to this TV. Opened without adding it again.", "このスマホはこのテレビに登録済みです。登録を増やさずに開きました。"));
      window.history.replaceState(null, "", window.location.pathname);
    } else if (s && pt && readJson<CameraSession>(KEYS.cameraSession)?.sessionId === s) {
      setRoleConflict({ sessionId: s, token: pt });
    } else if (s && pt) {
      tokenRef.current = { sessionId: s, token: pt };
      setPendingToken(tokenRef.current);
    }
    const camera = readJson<CameraSession>(KEYS.cameraSession);
    if (parent && !(tokenRef.current && parent.sessionId !== s)) {
      parentRef.current = parent;
      setAuth({ kind: "parent", sessionId: parent.sessionId, secret: parent.parentSecret });
    } else if (camera && !tokenRef.current) {
      setAuth({ kind: "camera", sessionId: camera.sessionId, secret: camera.cameraSecret });
      try {
        setLocalMode(loadMode()); // the watch phone's own mode (same device)
      } catch (err) {
        setModeError((err as Error).message);
      }
    } else {
      setAuth(null);
    }
  }, []);

  // Another tab paired this phone with a (newer) session: follow it instead of staying on the old one.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEYS.parentSession || !e.newValue) return;
      if (parentRef.current && e.newValue !== JSON.stringify(parentRef.current)) window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const send = useCallback((msg: ClientMessage) => transportRef.current?.send(msg) ?? false, []);

  const hello = useCallback((): ClientMessage | null => {
    const tok = tokenRef.current;
    if (tok) return { v: PROTOCOL_VERSION, type: "parent_hello", sessionId: tok.sessionId, pairingToken: tok.token };
    const p = parentRef.current;
    if (p) return { v: PROTOCOL_VERSION, type: "parent_hello", sessionId: p.sessionId, parentSecret: p.parentSecret };
    return null;
  }, []);

  const settle = useCallback((id: number, ok: boolean, message: string) => {
    setOutcomes((list) => list.map((o) => (o.id === id ? { ...o, ok, message, at: Date.now() } : o)));
    const done = waitingRef.current.get(id);
    if (done) {
      waitingRef.current.delete(id);
      done({ id, label: "", ok, message, at: Date.now() });
    }
  }, []);

  const forget = useCallback((message: string) => {
    // Only this tab's own pairing: an old tab must not delete a newer one made in another tab.
    if (parentRef.current && readJson<ParentSession>(KEYS.parentSession)?.sessionId === parentRef.current.sessionId) {
      window.localStorage.removeItem(KEYS.parentSession);
    }
    parentRef.current = null;
    setAuth(null);
    setStatus(null);
    setRelayError(message);
  }, []);

  const onServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "parent_paired": {
          const p = { sessionId: msg.sessionId, parentSecret: msg.parentSecret };
          // Store only a new pairing (QR). The relay also answers every resume with parent_paired; an
          // old tab restored by the browser would otherwise overwrite the newest pairing with its own.
          if (tokenRef.current) window.localStorage.setItem(KEYS.parentSession, JSON.stringify(p));
          parentRef.current = p;
          tokenRef.current = null;
          setPendingToken(null);
          setRelayError(null);
          setAuth((a) => (a?.kind === "parent" && a.secret === p.parentSecret ? a : { kind: "parent", sessionId: p.sessionId, secret: p.parentSecret }));
          window.history.replaceState(null, "", window.location.pathname);
          break;
        }
        case "unpaired":
          forget(L("This parent phone was removed on the TV. Scan the \"Add a parent phone\" QR code on the TV again.", "TVで保護者のスマホの登録が解除されました。TVで「保護者のスマホを登録」のQRコードを読み取り直してください。"));
          break;
        case "tv_now_playing":
          setNowPlaying(msg);
          break;
        case "playlist_library": {
          // Old sample URLs (VP9 / H.264, green stripes on the Fire TV) → their AV1 versions, saved back once.
          const upgraded = msg.custom ? upgradeLegacyUrls(msg.custom) : null;
          setLibrary(upgraded);
          if (upgraded && upgraded !== msg.custom && parentRef.current) {
            send({ v: PROTOCOL_VERSION, type: "playlist_save", sessionId: parentRef.current.sessionId, playlist: upgraded });
          }
          break;
        }
        case "tv_settings":
          setTvSettings(msg.settings);
          break;
        case "peer_status":
          if (msg.peer === "tv") setTvOnline(msg.connected);
          if (msg.peer === "camera") {
            setCameraOnline(msg.connected);
            if (!msg.connected) setStatus(null);
          }
          break;
        case "camera_status":
          setCameraOnline(true);
          setStatus(msg);
          break;
        case "camera_command_result":
          settle(msg.id, msg.ok, msg.message);
          break;
        case "rtc_signal":
          signalCbsRef.current.forEach((cb) => cb(msg));
          break;
        case "error":
          setRelayError(`[${msg.code}] ${msg.message}`);
          if (msg.code === "BAD_CREDENTIALS" && !tokenRef.current && spareTokenRef.current) {
            // This phone's registration was revoked on the TV: register again with the QR just read.
            tokenRef.current = spareTokenRef.current;
            spareTokenRef.current = null;
            parentRef.current = null;
            window.localStorage.removeItem(KEYS.parentSession);
            setNotice(L("This phone had been removed on the TV, so it is being added again with the scanned QR code.", "このスマホの登録はテレビで解除されていたので、読み取ったQRで登録し直します。"));
            setPendingToken(tokenRef.current);
            send({ v: PROTOCOL_VERSION, type: "parent_hello", sessionId: tokenRef.current.sessionId, pairingToken: tokenRef.current.token });
            break;
          }
          if (msg.code === "BAD_CREDENTIALS" && !tokenRef.current) forget(`[${msg.code}] ${msg.message}`);
          if (msg.code === "TOKEN_USED" || msg.code === "TOKEN_EXPIRED" || msg.code === "BAD_CREDENTIALS" || msg.code === "PARENT_LIMIT") {
            tokenRef.current = null;
            setPendingToken(null);
          }
          break;
        default:
          break;
      }
    },
    [forget, settle, send]
  );

  const needsRelay = Boolean(pendingToken || auth?.kind === "parent");
  useEffect(() => {
    if (!needsRelay || transportRef.current) return;
    const t = new WebSocketTransport({ url: `${WS_URL}?role=parent`, hello });
    transportRef.current = t;
    const offs = [
      t.onState((st, detail) => {
        setLink(st);
        if (st !== "open") {
          setTvOnline(false);
          setCameraOnline(false);
        }
        if (st === "closed" && detail) setRelayError(L(`Lost the connection to the relay (${detail}). Reconnecting automatically.`, `中継サーバーとの接続が切れました（${detail}）。自動で再接続します。`));
        if (st === "open") setRelayError(null);
      }),
      t.onMessage(onServerMessage),
      t.onError((e) => setRelayError(e.message)),
    ];
    t.connect();
    return () => {
      offs.forEach((off) => off());
      t.close();
      transportRef.current = null;
    };
  }, [needsRelay, hello, onServerMessage]);

  const sendCommand = useCallback(
    (command: CameraCommand, label: string): Promise<CommandOutcome> => {
      const id = commandSeqRef.current++;
      const outcome: CommandOutcome = { id, label, ok: null, message: "", at: Date.now() };
      setOutcomes((list) => [outcome, ...list].slice(0, 20));
      const p = parentRef.current;
      const parsed = CameraCommandSchema.safeParse(command);
      const fail = (message: string) => {
        settle(id, false, message);
        return Promise.resolve({ ...outcome, ok: false, message });
      };
      if (!parsed.success) return fail(L(`Value out of range: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`, `値が範囲外です: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`));
      if (!p) return fail(L("This phone is not added as a parent phone.", "このスマホは保護者のスマホとして登録されていません。"));
      return new Promise<CommandOutcome>((resolve) => {
        const timer = setTimeout(() => {
          waitingRef.current.delete(id);
          settle(id, false, L(`No reply from the watch camera within ${COMMAND_TIMEOUT_MS / 1000} s.`, `見守りカメラから ${COMMAND_TIMEOUT_MS / 1000} 秒以内に応答がありませんでした。`));
          resolve({ ...outcome, ok: false, message: "timeout" });
        }, COMMAND_TIMEOUT_MS);
        waitingRef.current.set(id, (o) => {
          clearTimeout(timer);
          resolve({ ...outcome, ok: o.ok, message: o.message });
        });
        if (!send({ v: PROTOCOL_VERSION, type: "camera_command", sessionId: p.sessionId, id, command: parsed.data })) {
          clearTimeout(timer);
          waitingRef.current.delete(id);
          settle(id, false, L("Not connected to the relay, so it was not sent.", "中継に接続していないため、送れませんでした。"));
          resolve({ ...outcome, ok: false, message: "not sent" });
        }
      });
    },
    [send, settle]
  );

  const sendPlaylist = useCallback(
    (playlist: Playlist) => {
      const p = parentRef.current;
      return Boolean(p) && send({ v: PROTOCOL_VERSION, type: "tv_playlist", sessionId: p!.sessionId, playlist: { id: playlist.id, title: playlist.title, items: playlist.items } });
    },
    [send]
  );
  const sendTvControl = useCallback(
    (action: TvControl["action"]) => {
      const p = parentRef.current;
      return Boolean(p) && send({ v: PROTOCOL_VERSION, type: "tv_control", sessionId: p!.sessionId, action });
    },
    [send]
  );

  const saveLibrary = useCallback(
    (playlist: Playlist | null) => {
      const p = parentRef.current;
      const sent = Boolean(p) && send({ v: PROTOCOL_VERSION, type: "playlist_save", sessionId: p!.sessionId, playlist });
      if (sent) setLibrary(playlist); // the relay echoes it to every parent phone
      return sent;
    },
    [send]
  );

  const saveTvSettings = useCallback(
    (settings: TvSettings) => {
      const p = parentRef.current;
      if (!p) return false;
      // Shown as saved only when the relay echoes it back (tv_settings to every parent phone).
      return send({ v: PROTOCOL_VERSION, type: "tv_settings_save", sessionId: p.sessionId, settings });
    },
    [send]
  );

  const sendSignal = useCallback(
    (kind: "offer" | "hangup", peerId: string, sdp?: string) => {
      const p = parentRef.current;
      if (!p) return false;
      return send({ v: PROTOCOL_VERSION, type: "rtc_signal", sessionId: p.sessionId, peerId, kind, ...(sdp ? { sdp } : {}) });
    },
    [send]
  );
  const onSignal = useCallback((cb: (m: RtcSignal) => void) => {
    signalCbsRef.current.add(cb);
    return () => void signalCbsRef.current.delete(cb);
  }, []);

  // Reminders count toward the camera's current mode (the camera is the source of truth).
  const mode: FireSenseMode | null = auth?.kind === "parent" ? (cameraOnline ? status?.mode ?? null : null) : localMode;
  const apiAuth = auth ? { sessionId: auth.sessionId, secret: auth.secret } : null;

  const fetchRange = useCallback(
    (a: { sessionId: string; secret: string }, r: Range) => apiFetch<{ days: DayRecord[] }>(`/session/summary?from=${r.from}&to=${r.to}`, a).then((x) => x.days),
    []
  );
  const load = useCallback(
    async (a: { sessionId: string; secret: string }, r: Range) => {
      setLoadError(null);
      try {
        setDays(await fetchRange(a, r));
      } catch (err) {
        setLoadError(toFailure(err));
      }
    },
    [fetchRange]
  );

  const authKey = auth ? `${auth.sessionId}:${auth.secret}` : null;
  useEffect(() => {
    if (auth) void load({ sessionId: auth.sessionId, secret: auth.secret }, range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authKey, load, range.from, range.to]);
  useEffect(() => {
    if (!auth || !compare) return;
    setDaysB(null);
    fetchRange({ sessionId: auth.sessionId, secret: auth.secret }, rangeB)
      .then(setDaysB)
      .catch((err) => setLoadError(toFailure(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authKey, compare, rangeB.from, rangeB.to, fetchRange]);

  /** Ask the TV to reset (it clears its counters, then deletes the stored days); then check that they are gone. */
  const resetRecords = async () => {
    const p = parentRef.current;
    if (!p || !apiAuth) return;
    setResetResult(null);
    if (!send({ v: PROTOCOL_VERSION, type: "tv_records_reset", sessionId: p.sessionId })) {
      setResetResult({ ok: false, text: L("Not connected to the relay, so the TV cannot be asked.", "中継に接続していないため、テレビに頼めません。") });
      return;
    }
    setResetBusy(true);
    try {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const left = (await fetchRange(apiAuth, lastDays(KEPT_DAYS))).filter((d) => (d.summary?.viewingSeconds ?? 0) > 0 || (d.parentReminders && d.parentReminders.intervene + d.parentReminders.shadow > 0));
        if (left.length === 0) {
          setResetResult({ ok: true, text: L("All records were deleted.", "記録をすべて消しました。") });
          await load(apiAuth, range);
          if (compare) setDaysB(await fetchRange(apiAuth, rangeB));
          return;
        }
      }
      setResetResult({ ok: false, text: L("After 12 s the records are still there. Is the TV on and connected? It shows the reason if the reset failed.", "12秒待っても記録が残っています。テレビはついていて、つながっていますか？失敗した場合はテレビに理由が出ます。") });
    } catch (err) {
      setResetResult({ ok: false, text: (err as Error).message });
    } finally {
      setResetBusy(false);
    }
  };

  const generate = async () => {
    if (!apiAuth) return;
    setBusy(true);
    setReportError(null);
    try {
      setReport(await apiFetch<ReportResponse>(`/report/weekly?today=${localDate()}&lang=${lang()}`, apiAuth));
    } catch (err) {
      setReportError(toFailure(err));
    } finally {
      setBusy(false);
    }
  };

  // Field pilot (T2): the parent's "I said 'step back'" counter, for the mode this phone is in.
  const remind = async (delta: 1 | -1) => {
    if (!apiAuth || !mode) return;
    setReminderBusy(true);
    setReminderError(null);
    const today = localDate();
    try {
      const r = await apiFetch<{ date: string; parentReminders: ParentReminders }>(
        "/session/reminder",
        apiAuth,
        { method: "POST", body: { date: today, mode, delta } }
      );
      setDays((prev) => {
        const list = prev ?? [];
        const hit = list.some((d) => d.date === r.date);
        const next = hit
          ? list.map((d) => (d.date === r.date ? { ...d, parentReminders: r.parentReminders } : d))
          : [...list, { date: r.date, summary: null, parentReminders: r.parentReminders }];
        return next.sort((a, b) => a.date.localeCompare(b.date));
      });
    } catch (err) {
      setReminderError(toFailure(err));
    } finally {
      setReminderBusy(false);
    }
  };
  const todayReminders = days?.find((d) => d.date === localDate())?.parentReminders ?? null;

  const viewed = (days ?? []).flatMap((d) => (d.summary ? [d.summary] : []));
  const totals = viewed.reduce(
    (acc, d) => ({
      approach: acc.approach + d.approachCount,
      recovery: acc.recovery + d.selfRecoveryCount,
      warn: acc.warn + (d.modes ? d.modes.intervene.warnSeconds + d.modes.shadow.warnSeconds : 0),
      minutes: acc.minutes + Math.round(d.viewingSeconds / 60),
    }),
    { approach: 0, recovery: 0, warn: 0, minutes: 0 }
  );

  const parent = auth?.kind === "parent";
  const today = days?.find((d) => d.date === localDate())?.summary ?? null;
  const dot = (ok: boolean) => <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-emerald-400" : "bg-slate-600"}`} />;

  return (
    <main className="max-w-xl mx-auto px-4 pb-10 space-y-4">
      <header className="pt-5 space-y-1">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-indigo-300">
          <HeartHandshake className="w-4 h-4" /> FireSense Kids · {L("Parent phone", "保護者のスマホ")}
          <LangSwitch className="ml-2" />
        </div>
        {(parent || pendingToken) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span className="flex items-center gap-1">{dot(tvOnline)}{L(" TV", " テレビ")}</span>
            <span className="flex items-center gap-1">{dot(cameraOnline)}{L(" Watch camera", " 見守りカメラ")}</span>
            <span className="flex items-center gap-1">
              {link === "open" ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />} {L("Relay", "中継")} {LINK_LABEL[link] ?? link}
            </span>
          </div>
        )}
        {notice && <p className="text-xs text-emerald-300">{notice}</p>}
        {roleConflict && (
          <Banner tone="warn" title={L("This phone is the watch camera", "このスマホは見守りカメラです")}>
            <p>
              {L(
                "This phone is already the watch camera for this TV. Scan the parent QR with the other phone, the one you keep in your hand. Add this phone as a parent phone anyway?",
                "このスマホは、このテレビの見守りカメラとして登録されています。保護者のQRは、あなたが持つ別のスマホで読み取ってください。それでも、このスマホを保護者のスマホにも登録しますか？"
              )}
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              <button autoFocus onClick={() => setRoleConflict(null)} className="px-4 py-2 rounded-xl bg-orange-700 text-white text-sm font-bold">
                {L("No", "やめる")}
              </button>
              <button
                onClick={() => {
                  tokenRef.current = roleConflict;
                  setPendingToken(roleConflict);
                  setRoleConflict(null);
                }}
                className="px-4 py-2 rounded-xl bg-slate-700 text-white text-sm font-bold"
              >
                {L("Add as a parent phone", "保護者のスマホとして登録する")}
              </button>
            </div>
          </Banner>
        )}
      </header>

      {auth === null && !pendingToken && (
        <Banner tone="warn" title={L("Not added", "未登録")}>
          {L("This phone is not added as a parent phone yet. On the TV, press OK on the remote and scan the QR code under \"Add a parent phone\".", "このスマホはまだ保護者のスマホとして登録されていません。TVでリモコンの決定ボタンを押し、「保護者のスマホを登録」に出るQRコードを読み取ってください。")}
        </Banner>
      )}
      {pendingToken && !auth && <p className="text-sm text-slate-300">{L("Adding…", "登録中…")}</p>}
      {relayError && <Banner tone="error" title={L("Relay", "中継")}>{relayError}</Banner>}

      {auth?.kind === "camera" && (
        <Banner tone="warn" title={L("This phone is the watch camera", "このスマホは見守りカメラです")}>
          {L("Only the records are shown here. To adjust the installed watch camera without touching it, scan the \"Add a parent phone\" QR code on the TV with another phone.", "ここでは記録だけを表示します。設置した見守りカメラに触らずに調整するには、別のスマホでTVの「保護者のスマホを登録」のQRコードを読み取ってください。")}
        </Banner>
      )}

      {parent && (
        <nav className="sticky top-0 z-30 -mx-4 px-4 py-2 bg-slate-950/95 backdrop-blur border-b border-slate-800">
          <div className="grid grid-cols-4 gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTab(t.id)}
                className={`py-2 rounded-lg text-xs font-bold ${tab === t.id ? "bg-indigo-600 text-white" : "text-slate-300 bg-slate-900"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>
      )}

      {parent && tab === "home" && (
        <>
          {status ? (
            <LiveCard status={status} />
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-400">
              {cameraOnline ? L("Waiting for the watch camera's status…", "見守りカメラの状態を待っています…") : L("The watch camera is not connected. Check that the FireSense page is open on it.", "見守りカメラがつながっていません。FireSense のページが開いているか確認してください。")}
            </div>
          )}
          <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2 text-xs">
            <div className="text-slate-400">{L("Playing on the TV", "テレビで再生中")}</div>
            <div className="text-sm font-bold text-white">{nowPlaying ? nowPlaying.title : tvOnline ? L("(nothing yet)", "（まだ届いていません）") : L("The TV is not connected", "テレビがつながっていません")}</div>
            {nowPlaying?.error && <div className="text-rose-300 break-all">{nowPlaying.error}</div>}
            <div className="flex gap-2">
              <button onClick={() => sendTvControl("previous")} disabled={!tvOnline} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white disabled:opacity-40">
                {L("Previous", "前の動画")}
              </button>
              <button onClick={() => sendTvControl("next")} disabled={!tvOnline} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white disabled:opacity-40">
                {L("Next", "次の動画")}
              </button>
              <button onClick={() => selectTab("video")} className="ml-auto px-3 py-1.5 rounded-lg text-indigo-300">
                {L("Choose videos →", "動画を選ぶ →")}
              </button>
            </div>
          </section>
          <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-xs space-y-2">
            <div className="text-slate-400">{L("Today", "きょう")}</div>
            {today ? (
              <div className="grid grid-cols-3 gap-2 text-center">
                <Total label={L("Watched", "見た時間")} value={L(`${Math.round(today.viewingSeconds / 60)} min`, `${Math.round(today.viewingSeconds / 60)}分`)} />
                <Total label={L("Too-close approaches", "近づきすぎ")} value={L(`${today.approachCount}`, `${today.approachCount}回`)} />
                <Total label={L("Time too close", "近すぎた時間")} value={today.modes ? L(`${today.modes.intervene.warnSeconds + today.modes.shadow.warnSeconds} s`, `${today.modes.intervene.warnSeconds + today.modes.shadow.warnSeconds}秒`) : "—"} />
              </div>
            ) : (
              <div className="text-slate-500">{L("No records today yet.", "きょうの記録はまだありません。")}</div>
            )}
            <button onClick={() => selectTab("records")} className="text-indigo-300">
              {L("See records and the reflection →", "記録とふりかえりを見る →")}
            </button>
          </section>
          <button onClick={() => selectTab("watch")} className="w-full p-3 rounded-2xl bg-slate-900 border border-slate-800 text-left text-xs">
            <div className="font-bold text-white">{L("Fit the watch zone · how the TV responds →", "見守りエリアを合わせる・テレビでの見せ方 →")}</div>
            <div className="text-slate-400">{L("Fit the lines to the floor on the video; blur and pause settings", "映像を見ながら線を床に合わせる、ぼかし・一時停止の設定")}</div>
          </button>
      {(
        <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Megaphone className="w-4 h-4 text-orange-400" />{L(" Reminder log", " 声かけの記録")}
          </h2>
          <p className="text-xs text-slate-400">
            {L("Press this each time you tell your child to step back. It adds to today's count for the current mode", "お子さんに「はなれて」と声をかけたら押してください。いまのモード")} (
            {mode ? MODE_LABEL[mode].title : L("unknown", "不明")}){L(".", "の今日の回数に加えます。")}
            {!mode && auth?.kind === "parent" && L(" The mode is unknown until the watch camera connects, so it cannot be pressed yet.", " 見守りカメラがつながるまでモードがわからないため、押せません。")}
          </p>
          {modeError && <Banner tone="error" title={L("Cannot read the mode", "モードを読み込めません")}>{modeError}</Banner>}
          <div className="flex gap-2">
            <button
              onClick={() => void remind(1)}
              disabled={reminderBusy || !mode}
              className="flex-1 px-4 py-4 rounded-2xl bg-orange-600 text-white text-base font-black disabled:opacity-50"
            >
              {L("Said \"step back\" +1", "「はなれて」と言った ＋1")}
            </button>
            <button
              onClick={() => void remind(-1)}
              disabled={reminderBusy || !mode}
              className="px-4 py-4 rounded-2xl bg-slate-800 border border-slate-600 text-slate-200 text-sm font-bold disabled:opacity-50"
            >
              {L("−1 undo", "−1 取り消し")}
            </button>
          </div>
          <div className="text-xs text-slate-300">
            {L("Today", "今日")}:{" "}
            {todayReminders
              ? L(`Respond ${todayReminders.intervene} / Record only ${todayReminders.shadow}`, `介入 ${todayReminders.intervene}回 / 記録のみ ${todayReminders.shadow}回`)
              : L("not pressed yet", "まだ押されていません")}
          </div>
          {reminderError && <FailureCard title={L("Could not record the reminder", "声かけを記録できませんでした")} failure={reminderError} />}
        </section>
      )}

        </>
      )}

      {parent && tab === "video" && <TvPlaylistPanel tvOnline={tvOnline} nowPlaying={nowPlaying} library={library} sendPlaylist={sendPlaylist} sendControl={sendTvControl} saveLibrary={saveLibrary} />}

      {parent && tab === "watch" && (
        <>
          <CameraRemote status={status} cameraOnline={cameraOnline} sendCommand={sendCommand} outcomes={outcomes} sendSignal={sendSignal} onSignal={onSignal} />
          <TvSettingsPanel tvSettings={tvSettings} saveTvSettings={saveTvSettings} tvOnline={tvOnline} />
        </>
      )}

      {auth && (!parent || tab === "records") && (
        <>
          <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3 text-xs">
            <div className="text-sm font-bold text-white">{L("Period", "期間")}</div>
            <RangePicker value={range} onChange={setRange} accent="#fb923c" />
            <label className="flex items-center gap-2 text-slate-300">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
              {L("Compare the heatmap with another period", "ヒートマップを別の期間と比べる")}
            </label>
            {compare && <RangePicker value={rangeB} onChange={setRangeB} accent="#22d3ee" />}
            <p className="text-[10px] text-slate-500">{L(`Records are daily and kept ${KEPT_DAYS} days.`, `記録は1日ごとで、${KEPT_DAYS}日間残ります。`)}</p>
            {parent && <ResetRecords tvOnline={tvOnline} busy={resetBusy} onReset={() => void resetRecords()} />}
            {resetResult && <p className={resetResult.ok ? "text-emerald-300" : "text-rose-300"}>{resetResult.text}</p>}
          </section>
          {loadError && <FailureCard title={L("Could not load the records", "記録を読み込めませんでした")} failure={loadError} />}
      {auth && days !== null && viewed.length === 0 && (
        <section className="p-6 rounded-2xl bg-slate-900 border border-slate-800 text-center text-slate-300">{L("No records yet", "まだ記録がありません")}</section>
      )}

      {viewed.length > 0 && (
        <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            <Total label={L("Watched", "視聴")} value={L(`${totals.minutes} min`, `${totals.minutes}分`)} />
            <Total label={L("Too-close approaches", "近づきすぎ")} value={L(`${totals.approach}`, `${totals.approach}回`)} />
            <Total label={L("Stepped back", "自分で下がった")} value={L(`${totals.recovery}`, `${totals.recovery}回`)} />
            <Total label={L("Time too close", "近すぎた時間")} value={L(`${Math.round(totals.warn / 60)} min`, `${Math.round(totals.warn / 60)}分`)} />
          </div>
          <table className="w-full text-xs text-slate-300">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left py-1">{L("Date", "日付")}</th>
                <th>{L("Watched", "視聴")}</th>
                <th>{L("Approaches", "近づき")}</th>
                <th>{L("Stepped back", "下がった")}</th>
                <th>{L("Sensor drops", "センサー切断")}</th>
              </tr>
            </thead>
            <tbody>
              {viewed.map((d) => (
                <tr key={d.date} className="border-t border-slate-800 text-center">
                  <td className="text-left py-1 font-mono">{d.date.slice(5)}</td>
                  <td>{L(`${Math.round(d.viewingSeconds / 60)} min`, `${Math.round(d.viewingSeconds / 60)}分`)}</td>
                  <td>{d.approachCount}</td>
                  <td>{d.selfRecoveryCount}</td>
                  <td>
                    {L(`${d.disconnectCount} / ${d.disconnectSeconds} s`, `${d.disconnectCount}回 / ${d.disconnectSeconds}秒`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {days && days.length > 0 && <ModeTable days={days} />}
      {compare && days && daysB && <PeriodCompare a={range} b={rangeB} daysA={days} daysB={daysB} />}
      {days && days.length > 0 && <FloorHeatmap days={days} />}

      {auth && viewed.length > 0 && (
        <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />{L(" AI reflection", " AIのふりかえり")}
            </h2>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
              Claude Sonnet 4.6 · Amazon Bedrock
            </span>
          </div>
          <button onClick={generate} disabled={busy} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold disabled:opacity-50">
            {busy ? L("Writing…", "生成中…") : L("Write this week's reflection", "今週のふりかえりを作る")}
          </button>
          {reportError && <FailureCard title={L("Could not write the reflection", "ふりかえりを生成できませんでした")} failure={reportError} />}
          {report?.report && (
            <div className="space-y-3 text-sm text-slate-200">
              <p className="leading-relaxed">{report.report.parentReflection}</p>
              <ul className="list-disc pl-5 text-xs text-slate-300 space-y-1">
                {report.report.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs space-y-1">
                <div className="text-slate-500">{L("Mascot line ideas", "マスコットのセリフ案")}</div>
                <div>{L("Getting closer", "近づき始め")}: {report.report.mascotLines.approaching}</div>
                <div>{L("Too close", "近すぎ")}: {report.report.mascotLines.tooClose}</div>
                <div>{L("Praise", "ほめ言葉")}: {report.report.mascotLines.praise}</div>
              </div>
              {report.trace && <TraceLine trace={report.trace} />}
            </div>
          )}
        </section>
      )}
        </>
      )}
    </main>
  );
}

/** Field pilot (T2): per-mode numbers per day. Missing data is shown as "—", never as 0. */
function ModeTable({ days }: { days: DayRecord[] }) {
  const cell = (m: ModeStats | undefined, f: (m: ModeStats) => string) => (m ? f(m) : "—");
  const median = (xs: number[]) => {
    if (xs.length === 0) return "—";
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const v = s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
    return L(`${v} s`, `${v}秒`);
  };
  return (
    <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
      <h2 className="text-sm font-bold text-white">{L("By mode (record only vs. respond)", "モード別（フィールド検証）")}</h2>
      <table className="w-full text-[11px] text-slate-300">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left py-1">{L("Date", "日付")}</th>
            <th>{L("Mode", "モード")}</th>
            <th>{L("Watched", "視聴")}</th>
            <th>{L("Too close", "近すぎ")}</th>
            <th>{L("Approaches", "接近")}</th>
            <th>{L("Time to step back (median)", "戻るまで(中央値)")}</th>
            <th>{L("Reminders", "声かけ")}</th>
          </tr>
        </thead>
        <tbody>
          {days.flatMap((d) =>
            (["intervene", "shadow"] as const).map((mode) => {
              const m = d.summary?.modes?.[mode];
              return (
                <tr key={`${d.date}-${mode}`} className="border-t border-slate-800 text-center">
                  <td className="text-left py-1 font-mono">{d.date.slice(5)}</td>
                  <td>{mode === "intervene" ? L("Respond", "介入") : L("Record only", "記録のみ")}</td>
                  <td>{cell(m, (x) => L(`${Math.round(x.viewingSeconds / 60)} min`, `${Math.round(x.viewingSeconds / 60)}分`))}</td>
                  <td>{cell(m, (x) => L(`${x.warnSeconds} s`, `${x.warnSeconds}秒`))}</td>
                  <td>{cell(m, (x) => L(`${x.approachCount}`, `${x.approachCount}回`))}</td>
                  <td>{m ? `${median(m.recoverySeconds)}${m.recoveryTruncated ? L(" (capped at 200)", "（200件で打ち切り）") : ""}` : "—"}</td>
                  <td>{d.parentReminders ? L(`${d.parentReminders[mode]}`, `${d.parentReminders[mode]}回`) : "—"}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      <p className="text-[10px] text-slate-500">{L("\"—\" means the day's record has no such field (no TV record, or an older format).", "「—」はその日の記録にその項目がないこと（TVの記録がない、または古い形式）を表します。")}</p>
    </section>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
      <div className="text-slate-500">{label}</div>
      <div className="font-bold text-white">{value}</div>
    </div>
  );
}

function FailureCard({ title, failure }: { title: string; failure: Failure }) {
  return (
    <div className="p-4 rounded-2xl bg-rose-950/60 border-2 border-rose-500 text-rose-100 text-xs space-y-2">
      <div className="font-bold text-sm">{title}</div>
      <div>
        HTTP {failure.status || "—"} · {failure.message}
      </div>
      {failure.body !== null && <pre className="whitespace-pre-wrap break-all bg-black/40 p-2 rounded-lg">{JSON.stringify(failure.body, null, 2)}</pre>}
    </div>
  );
}
