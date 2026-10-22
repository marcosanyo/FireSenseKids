/**
 * FireSense Kids — TV-side engine (`FireSenseViewer`).
 *
 * Everything a player needs to *consume* FireSense, with no UI and no React:
 * relay connection (tv_hello / session / credentials), QR pairing tokens and their
 * refresh, seq ordering, disconnect detection (plan §3), the disconnect ledger,
 * viewing_state, the calibration_pattern handshake, and the parent-phone QR tokens.
 *
 * The player only draws: blur its own video with `frame.blurPx`, show its own
 * mascot on `event`, render the QR from `pairing.pairingUrl`.
 *
 * Contract enforced here (not left to the player): while the sensor link is down,
 * every frame carries `blurPx: 0` — a broken sensor never punishes the child. The same holds
 * in shadow mode (field pilot, record only): the frame still carries the state for recording,
 * but nothing to draw.
 * The TV never decides safety; it renders what the phone decided.
 *
 * See docs/PROTOCOL.md.
 */

import {
  PROTOCOL_VERSION,
  type CalibrationPatternMessage,
  type ClientMessage,
  type ErrorCode,
  type FireSenseMode,
  type PostureType,
  type ServerMessage,
  type Telemetry,
  type TelemetryEvent,
  type ViewingState,
  type Playlist,
  type TvControl,
  type TvNowPlaying,
  type TvSettings,
} from "./protocol";
import {
  DisconnectLedger,
  PeerLinkMonitor,
  SeqGate,
  WebSocketTransport,
  type LinkStatus,
  type TelemetryTransport,
  type TransportState,
} from "./transport";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface ViewerCredentials {
  sessionId: string;
  tvSecret: string;
}

/**
 * Injected persistence (localStorage, SharedPreferences, …). The engine never touches storage itself.
 * `save(null)` means "forget" (newSession).
 */
export interface ViewerCredentialStore {
  load(): ViewerCredentials | null;
  save(creds: ViewerCredentials | null): void;
}

/** A transport the engine can drive. `WebSocketTransport` is the default; tests inject a fake. */
export type ViewerTransport = TelemetryTransport & { reconnectNow(): void };

export interface FireSenseViewerOptions {
  /** Relay WebSocket URL (wss://…). `role=tv` is appended by the engine. */
  url: string;
  credentials: ViewerCredentialStore;
  /** Builds the URL the phone opens to pair (the player renders it as a QR code). */
  pairingUrl: (sessionId: string, pairingToken: string) => string;
  /** Builds the URL a parent phone opens to pair (optional: only for players that offer a parent QR). */
  parentPairingUrl?: (sessionId: string, pairingToken: string) => string;
  logger?: Pick<Console, "info" | "error">;
  /** For tests / non-browser hosts. Defaults to `new WebSocketTransport(...)`. */
  createTransport?: (opts: { url: string; hello: () => ClientMessage }) => ViewerTransport;
}

export type CalibrationPattern = CalibrationPatternMessage["pattern"];

export interface ViewerFrame {
  /** What to blur the video by. Always 0 while `link.connected` is false or in shadow mode. */
  blurPx: number;
  /**
   * Last mode the phone reported (null until it reports one). In "shadow" the player shows
   * nothing that reacts to distance (no blur, card, voice, stars) but still records.
   */
  mode: FireSenseMode | null;
  /** The phone's decision. null while the link is down (render nothing from it). */
  state: ViewingState | null;
  distanceM: number | null;
  /** Floor position of the measurement (telemetry `floor`), when the phone sends it. */
  floor: { lateralM: number; frontM: number } | null;
  posture: PostureType | null;
  confidence: number | null;
  link: LinkStatus;
  /** Synthetic input from the phone's test mode: label it on screen, never record it. */
  test: boolean;
  seq: number | null;
}

export interface ViewerEvent {
  type: TelemetryEvent;
  /** "shadow": record it, but show and play nothing. */
  mode: FireSenseMode;
  /** From the phone's test mode: show the effect, but do not count it. */
  test: boolean;
}

export interface ViewerPairing {
  sessionId: string;
  token: string;
  expiresAt: number;
  cameraPaired: boolean;
  /** Render this as the QR code. */
  pairingUrl: string;
}

/** A one-time QR token for a parent phone (it adjusts the camera and reads the weekly records). */
export interface ViewerParentPairing {
  sessionId: string;
  token: string;
  expiresAt: number;
  /** Parent phones already registered for this session. */
  parentCount: number;
  /** Render this as the QR code. */
  pairingUrl: string;
}

export type ViewerError =
  | { source: "server"; code: ErrorCode; message: string }
  | { source: "transport"; message: string };

export interface FireSenseViewerEvents {
  frame: ViewerFrame;
  /** The relay opened or resumed the session (sent on every (re)connect, followed by `pairing`). */
  session: { sessionId: string; created: boolean };
  event: ViewerEvent;
  pairing: ViewerPairing;
  /** A phone completed QR pairing (not sent on reconnects). */
  paired: { sessionId: string };
  /** A parent-phone QR token (after `requestParentPairing`, and refreshed while visible). */
  parentPairing: ViewerParentPairing;
  /** A parent phone completed QR pairing. */
  parentJoined: { sessionId: string; parentCount: number };
  calibrationPattern: CalibrationPattern;
  error: ViewerError;
  /** Relay socket state (for "reconnecting…" UI and diagnostics). */
  relay: { state: TransportState; detail?: string };
  /** Phone heartbeat (1 Hz), with its current inference rate. */
  heartbeat: { fps: number };
  /**
   * The link went down (after having been up). `lastPeerMessageAgoMs`: how long before the drop was
   * detected the last telemetry / heartbeat arrived (null if none). For measurements (MEASUREMENT §6).
   */
  linkLost: { atMs: number; link: LinkStatus; lastPeerMessageAgoMs: number | null; blurPxBefore: number; test: boolean };
  /** A parent phone picked a playlist (play it from the start). */
  playlist: Playlist;
  /** A parent phone skipped within the list. */
  playbackControl: TvControl["action"];
  /** A parent phone asked to reset the records (the TV clears its counters and deletes the stored days). */
  recordsReset: { sessionId: string };
  /** TV intervention settings (child cues, marker, pause). */
  tvSettings: TvSettings;
}

export const INITIAL_VIEWER_FRAME: ViewerFrame = {
  blurPx: 0,
  mode: null,
  state: null,
  distanceM: null,
  floor: null,
  posture: null,
  confidence: null,
  link: { connected: false, reason: "SOCKET_CLOSED" },
  test: false,
  seq: null,
};

/** `[code] message` for server errors, the raw message otherwise. */
export function formatViewerError(err: ViewerError): string {
  return err.source === "server" ? `[${err.code}] ${err.message}` : err.message;
}

const TICK_MS = 250;
const PAIRING_REFRESH_LEAD_MS = 10_000;

type Listener<K extends keyof FireSenseViewerEvents> = (payload: FireSenseViewerEvents[K]) => void;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export class FireSenseViewer {
  private transport: ViewerTransport | null = null;
  private creds: ViewerCredentials | null = null;
  private monitor = new PeerLinkMonitor();
  private seq = new SeqGate();
  private ledger = new DisconnectLedger();
  private last: Telemetry | null = null;
  private mode: FireSenseMode | null = null;
  private link: LinkStatus | null = null;
  private pairing: ViewerPairing | null = null;
  private playing = false;
  private pairingVisible = false;
  private parentPairing: ViewerParentPairing | null = null;
  private parentPairingVisible = false;
  private parentRefreshHandle: ReturnType<typeof setTimeout> | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private refreshHandle: ReturnType<typeof setTimeout> | null = null;
  private offs: Array<() => void> = [];
  private listeners = new Map<keyof FireSenseViewerEvents, Set<(payload: never) => void>>();
  private readonly onOnline = () => this.transport?.reconnectNow();
  private rttSeq = 0;
  private rttWaiting = new Map<number, () => void>();

  constructor(private readonly opts: FireSenseViewerOptions) {}

  on<K extends keyof FireSenseViewerEvents>(name: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    const s = set;
    s.add(cb);
    return () => void s.delete(cb);
  }

  start(): void {
    if (this.transport) return;
    this.creds = this.opts.credentials.load();
    const url = `${this.opts.url}${this.opts.url.includes("?") ? "&" : "?"}role=tv`;
    const hello = () => this.hello();
    const t = this.opts.createTransport ? this.opts.createTransport({ url, hello }) : new WebSocketTransport({ url, hello });
    this.transport = t;
    this.offs = [
      t.onState((state, detail) => this.onTransportState(state, detail)),
      t.onMessage((msg) => this.onMessage(msg)),
      t.onError((err) => {
        this.opts.logger?.error(err);
        this.emit("error", { source: "transport", message: err.message });
      }),
    ];
    this.tickHandle = setInterval(() => this.updateLink(Date.now()), TICK_MS);
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
    t.connect();
  }

  stop(): void {
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
    if (this.tickHandle !== null) clearInterval(this.tickHandle);
    this.tickHandle = null;
    this.clearRefresh();
    this.clearParentRefresh();
    this.offs.forEach((off) => off());
    this.offs = [];
    this.transport?.close();
    this.transport = null;
  }

  /** Current credentials (for the player's own HTTP calls, e.g. daily summaries). */
  get credentials(): ViewerCredentials | null {
    return this.creds;
  }

  /** The last accepted telemetry, unfiltered. Diagnostics only — render from `frame`, never from this. */
  get lastTelemetry(): Telemetry | null {
    return this.last;
  }

  /** Disconnect count / seconds since start (plan §3: recorded in the daily summary). */
  disconnects(nowMs = Date.now()): { count: number; seconds: number } {
    return this.ledger.snapshot(nowMs);
  }

  /** Tell the phone whether the video is playing (it sleeps its inference while paused). */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.sendViewingState();
  }

  /** Tell the parent phones what is playing (the relay keeps the last one for phones that connect later). */
  reportNowPlaying(np: Omit<TvNowPlaying, "v" | "type" | "sessionId">): boolean {
    const c = this.creds;
    if (!c) return false;
    return this.send({ v: PROTOCOL_VERSION, type: "tv_now_playing", sessionId: c.sessionId, ...np });
  }

  /** While the QR is on screen, keep its one-time token fresh (refreshed 10s before expiry). */
  setPairingVisible(visible: boolean): void {
    this.pairingVisible = visible;
    this.scheduleRefresh();
  }

  /** Ask the relay for a fresh one-time pairing token. */
  refreshPairing(): void {
    this.send(this.hello());
  }

  /**
   * Ask for a one-time parent QR token (answered with `on("parentPairing")`).
   * `reset: true` first revokes every registered parent phone.
   */
  requestParentPairing(reset = false): boolean {
    if (!this.opts.parentPairingUrl) throw new Error("FireSenseViewer: parentPairingUrl is not configured");
    return this.send({ v: PROTOCOL_VERSION, type: "parent_pairing_request", ...(reset ? { reset: true } : {}) });
  }

  /** While the parent QR is on screen, keep its one-time token fresh (refreshed 10s before expiry). */
  setParentPairingVisible(visible: boolean): void {
    this.parentPairingVisible = visible;
    this.scheduleParentRefresh();
  }

  /** Revoke the paired phone and get a fresh QR token. */
  resetPairing(): void {
    this.send({ v: PROTOCOL_VERSION, type: "pairing_reset" });
  }

  /** Forget the stored credentials and open a brand-new session. */
  /** Reconnect the relay now (back from the background: the socket may be dead without having closed). */
  reconnect(): void {
    this.transport?.reconnectNow();
  }

  newSession(): void {
    this.creds = null;
    this.opts.credentials.save(null);
    this.transport?.reconnectNow();
  }

  /**
   * One round trip TV → relay → phone → relay → TV (rtt_ping / rtt_pong), in ms on this device's
   * clock. Rejects when there is no session or socket, or when no reply arrives within timeoutMs.
   */
  measureRoundTrip(timeoutMs = 5000, now: () => number = () => performance.now()): Promise<number> {
    const c = this.creds;
    if (!c) return Promise.reject(new Error("no session"));
    const id = this.rttSeq++;
    return new Promise<number>((resolve, reject) => {
      const t0 = now();
      const timer = setTimeout(() => {
        this.rttWaiting.delete(id);
        reject(new Error(`no rtt_pong within ${timeoutMs} ms`));
      }, timeoutMs);
      this.rttWaiting.set(id, () => {
        clearTimeout(timer);
        resolve(now() - t0);
      });
      if (!this.send({ v: PROTOCOL_VERSION, type: "rtt_ping", sessionId: c.sessionId, id })) {
        clearTimeout(timer);
        this.rttWaiting.delete(id);
        reject(new Error("relay socket is not open"));
      }
    });
  }

  /** Call once the requested calibration pattern is actually painted (e.g. two animation frames later). */
  ackCalibrationPattern(pattern: CalibrationPattern): boolean {
    const c = this.creds;
    if (!c) return false;
    return this.send({ v: PROTOCOL_VERSION, type: "calibration_pattern_ack", sessionId: c.sessionId, pattern });
  }

  // -------------------------------------------------------------------------
  private hello(): ClientMessage {
    const c = this.creds;
    return c ? { v: PROTOCOL_VERSION, type: "tv_hello", sessionId: c.sessionId, tvSecret: c.tvSecret } : { v: PROTOCOL_VERSION, type: "tv_hello" };
  }

  private lastRehelloMs = 0;

  private send(msg: ClientMessage): boolean {
    return this.transport?.send(msg) ?? false;
  }

  private sendViewingState(): void {
    const c = this.creds;
    if (c) this.send({ v: PROTOCOL_VERSION, type: "viewing_state", sessionId: c.sessionId, playing: this.playing });
  }

  private onTransportState(state: TransportState, detail?: string): void {
    this.opts.logger?.info(`[FireSenseViewer] relay ${state}${detail ? ` (${detail})` : ""}`);
    if (state === "open") this.monitor.onSocketOpen();
    else {
      this.monitor.onSocketClosed();
      this.seq.reset();
    }
    this.emit("relay", { state, detail });
    this.updateLink(Date.now());
  }

  private onMessage(msg: ServerMessage): void {
    const now = Date.now();
    switch (msg.type) {
      case "session":
        if (msg.tvSecret) {
          this.creds = { sessionId: msg.sessionId, tvSecret: msg.tvSecret };
          this.opts.credentials.save(this.creds);
        }
        this.emit("session", { sessionId: msg.sessionId, created: Boolean(msg.tvSecret) });
        this.setPairing({
          sessionId: msg.sessionId,
          token: msg.pairingToken,
          expiresAt: msg.pairingExpiresAt,
          cameraPaired: msg.cameraPaired,
          pairingUrl: this.opts.pairingUrl(msg.sessionId, msg.pairingToken),
        });
        this.sendViewingState();
        break;
      case "peer_status":
        if (msg.peer !== "camera") break;
        this.monitor.onPeerStatus(msg.connected);
        if (msg.connected) this.markCameraPaired();
        else this.seq.reset();
        this.updateLink(now);
        break;
      case "camera_paired":
        this.markCameraPaired();
        this.emit("paired", { sessionId: msg.sessionId });
        break;
      case "heartbeat":
        this.monitor.onHeartbeat(now);
        this.emit("heartbeat", { fps: msg.fps });
        this.updateLink(now, this.setMode(msg.mode));
        break;
      case "telemetry":
        if (!this.seq.accept(msg)) break;
        this.monitor.onTelemetry(now);
        this.last = msg;
        this.setMode(msg.mode);
        this.updateLink(now, true);
        if (msg.event) this.emit("event", { type: msg.event, mode: msg.mode, test: Boolean(msg.test) });
        break;
      case "calibration_pattern":
        this.emit("calibrationPattern", msg.pattern);
        break;
      case "parent_pairing": {
        const build = this.opts.parentPairingUrl;
        if (!build) break;
        this.parentPairing = {
          sessionId: msg.sessionId,
          token: msg.pairingToken,
          expiresAt: msg.pairingExpiresAt,
          parentCount: msg.parentCount,
          pairingUrl: build(msg.sessionId, msg.pairingToken),
        };
        this.scheduleParentRefresh();
        this.emit("parentPairing", this.parentPairing);
        break;
      }
      case "parent_joined":
        this.emit("parentJoined", { sessionId: msg.sessionId, parentCount: msg.parentCount });
        // The shown token was used: show a fresh one if the QR is still up.
        if (this.parentPairingVisible) this.requestParentPairing();
        break;
      case "camera_leaving":
        if (msg.sessionId !== this.creds?.sessionId) break;
        this.monitor.onPeerLeaving(msg.reason);
        this.seq.reset();
        this.updateLink(now);
        break;
      case "rtt_pong": {
        const done = this.rttWaiting.get(msg.id);
        if (done) {
          this.rttWaiting.delete(msg.id);
          done();
        }
        break;
      }
      case "tv_playlist":
        if (msg.sessionId === this.creds?.sessionId) this.emit("playlist", msg.playlist);
        break;
      case "tv_control":
        if (msg.sessionId === this.creds?.sessionId) this.emit("playbackControl", msg.action);
        break;
      case "tv_records_reset":
        if (msg.sessionId === this.creds?.sessionId) this.emit("recordsReset", { sessionId: msg.sessionId });
        break;
      case "tv_settings":
        if (msg.sessionId === this.creds?.sessionId) this.emit("tvSettings", msg.settings);
        break;
      case "error":
        this.emit("error", { source: "server", code: msg.code, message: msg.message });
        if (msg.code === "NOT_PAIRED" && this.creds && rehelloAllowed(msg.message, this.lastRehelloMs)) {
          this.lastRehelloMs = Date.now();
          this.refreshPairing();
        }
        break;
      default:
        break;
    }
  }

  /** Returns true when the mode changed. */
  private setMode(mode: FireSenseMode): boolean {
    if (this.mode === mode) return false;
    this.mode = mode;
    return true;
  }

  private markCameraPaired(): void {
    if (this.pairing && !this.pairing.cameraPaired) this.setPairing({ ...this.pairing, cameraPaired: true });
  }

  private setPairing(p: ViewerPairing): void {
    this.pairing = p;
    this.scheduleRefresh();
    this.emit("pairing", p);
  }

  private clearRefresh(): void {
    if (this.refreshHandle !== null) clearTimeout(this.refreshHandle);
    this.refreshHandle = null;
  }

  private scheduleRefresh(): void {
    this.clearRefresh();
    const p = this.pairing;
    if (!this.pairingVisible || !p || !this.creds) return;
    const inMs = Math.max(1000, p.expiresAt - Date.now() - PAIRING_REFRESH_LEAD_MS);
    this.refreshHandle = setTimeout(() => {
      this.refreshHandle = null;
      this.refreshPairing();
    }, inMs);
  }

  private clearParentRefresh(): void {
    if (this.parentRefreshHandle !== null) clearTimeout(this.parentRefreshHandle);
    this.parentRefreshHandle = null;
  }

  private scheduleParentRefresh(): void {
    this.clearParentRefresh();
    const p = this.parentPairing;
    if (!this.parentPairingVisible || !p) return;
    const inMs = Math.max(1000, p.expiresAt - Date.now() - PAIRING_REFRESH_LEAD_MS);
    this.parentRefreshHandle = setTimeout(() => {
      this.parentRefreshHandle = null;
      this.requestParentPairing();
    }, inMs);
  }

  /** Recompute the link (plan §3) and emit a frame when it changed, or when `force` (new telemetry). */
  private updateLink(nowMs: number, force = false): void {
    const s = this.monitor.status(nowMs);
    this.ledger.update(s.connected, nowMs);
    const prev = this.link;
    const changed = !prev || prev.connected !== s.connected || prev.reason !== s.reason || prev.peerLeft !== s.peerLeft;
    if (changed && prev?.connected && !s.connected) {
      const last = this.monitor.lastPeerMessageMs;
      const t = this.last;
      this.emit("linkLost", {
        atMs: nowMs,
        link: s,
        lastPeerMessageAgoMs: last === null ? null : nowMs - last,
        blurPxBefore: t && this.mode !== "shadow" ? t.blurPx : 0,
        test: Boolean(t?.test),
      });
    }
    if (changed) this.link = s;
    if (changed || force) this.emit("frame", this.frame());
  }

  private frame(): ViewerFrame {
    const link = this.link ?? INITIAL_VIEWER_FRAME.link;
    const t = this.last;
    if (!link.connected || !t) return { ...INITIAL_VIEWER_FRAME, mode: this.mode, link, seq: t?.seq ?? null };
    return {
      blurPx: this.mode === "shadow" ? 0 : t.blurPx,
      mode: this.mode,
      state: t.state,
      distanceM: t.distanceM,
      floor: t.floor ?? null,
      posture: t.posture,
      confidence: t.confidence,
      link,
      test: Boolean(t.test),
      seq: t.seq,
    };
  }

  private emit<K extends keyof FireSenseViewerEvents>(name: K, payload: FireSenseViewerEvents[K]): void {
    const set = this.listeners.get(name) as Set<Listener<K>> | undefined;
    set?.forEach((cb) => cb(payload));
  }
}

/**
 * After NOT_PAIRED, say hello again (a message that overtook the hello after a reconnect) —
 * but not when this connection was replaced by another device or tab of the same session (the relay's
 * "replaced by a newer one"): saying hello would take the session back, and the two would take it from
 * each other forever. At most once per `minGapMs`.
 */
export function rehelloAllowed(message: string, lastMs: number, nowMs = Date.now(), minGapMs = 5000): boolean {
  return !/replaced/i.test(message) && nowMs - lastMs >= minGapMs;
}
