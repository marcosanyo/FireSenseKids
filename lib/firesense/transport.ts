/**
 * FireSense Kids — Telemetry transport over the AWS API Gateway WebSocket relay.
 *
 * - WebSocketTransport: reconnects with exponential backoff (1→2→4…30s) to the SAME
 *   endpoint. This is not a fallback path: there is only one path.
 * - PeerLinkMonitor (TV): decides "sensor disconnected" per plan §3.
 * - SeqGate (TV): drops stale/out-of-order telemetry.
 */

import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type CameraLeavingReason,
  type ClientMessage,
  type ServerMessage,
  type Telemetry,
} from "./protocol";

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------
export class ReconnectBackoff {
  private attempt = 0;
  constructor(private readonly baseMs = 1000, private readonly maxMs = 30000) {}
  next(): number {
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt += 1;
    return delay;
  }
  reset(): void {
    this.attempt = 0;
  }
}

// ---------------------------------------------------------------------------
// Sequence gate
// ---------------------------------------------------------------------------
export class SeqGate {
  private last = -1;
  /** Returns true if the telemetry is newer than anything seen since the last reset. */
  accept(t: Pick<Telemetry, "seq">): boolean {
    if (t.seq <= this.last) return false;
    this.last = t.seq;
    return true;
  }
  reset(): void {
    this.last = -1;
  }
}

// ---------------------------------------------------------------------------
// TV-side link monitor (plan §3)
// ---------------------------------------------------------------------------
/**
 * Why the link is down. PEER_LEFT: the phone said it is leaving (camera_leaving), `peerLeft` says how.
 * SILENT is the only reason the TV cannot explain: nothing arrived for 3 s and nobody said why.
 */
export type LinkDownReason = "SOCKET_CLOSED" | "PEER_LEFT" | "PEER_OFFLINE" | "SILENT" | "WAITING_FIRST_TELEMETRY";

export interface LinkStatus {
  connected: boolean;
  reason?: LinkDownReason;
  /** Only with reason PEER_LEFT. */
  peerLeft?: CameraLeavingReason;
}

export class PeerLinkMonitor {
  private socketOpen = false;
  private peerOnline = false;
  private lastCameraMsgMs: number | null = null;
  /** Set when the link is up; cleared on any drop so recovery requires fresh telemetry. */
  private live = false;
  /** The phone's own notice (camera_leaving); kept until fresh telemetry arrives. */
  private left: CameraLeavingReason | null = null;

  constructor(private readonly silenceMs = 3000) {}

  onSocketOpen(): void {
    this.socketOpen = true;
  }

  onSocketClosed(): void {
    this.socketOpen = false;
    this.peerOnline = false;
    this.live = false;
  }

  onPeerStatus(connected: boolean): void {
    this.peerOnline = connected;
    if (!connected) this.live = false;
  }

  /** The phone announced it is going away: the link drops now, not 3 s later. */
  onPeerLeaving(reason: CameraLeavingReason): void {
    this.left = reason;
    this.live = false;
  }

  /** When the last telemetry or heartbeat arrived (TV clock), or null. */
  get lastPeerMessageMs(): number | null {
    return this.lastCameraMsgMs;
  }

  onHeartbeat(nowMs: number): void {
    this.peerOnline = true;
    this.lastCameraMsgMs = nowMs;
  }

  onTelemetry(nowMs: number): void {
    this.peerOnline = true;
    this.lastCameraMsgMs = nowMs;
    this.live = true;
    this.left = null;
  }

  status(nowMs: number): LinkStatus {
    if (!this.socketOpen) return { connected: false, reason: "SOCKET_CLOSED" };
    if (this.left) return { connected: false, reason: "PEER_LEFT", peerLeft: this.left };
    if (!this.peerOnline) return { connected: false, reason: "PEER_OFFLINE" };
    if (this.lastCameraMsgMs === null || nowMs - this.lastCameraMsgMs >= this.silenceMs) {
      this.live = false;
      return { connected: false, reason: "SILENT" };
    }
    if (!this.live) return { connected: false, reason: "WAITING_FIRST_TELEMETRY" };
    return { connected: true };
  }
}

/** Accumulates disconnect count/duration for the daily summary. */
export class DisconnectLedger {
  private downSinceMs: number | null = null;
  private everConnected = false;
  count = 0;
  totalMs = 0;

  update(connected: boolean, nowMs: number): void {
    if (connected) {
      if (this.downSinceMs !== null) this.totalMs += nowMs - this.downSinceMs;
      this.downSinceMs = null;
      this.everConnected = true;
    } else if (this.everConnected && this.downSinceMs === null) {
      this.downSinceMs = nowMs;
      this.count += 1;
    }
  }

  snapshot(nowMs: number): { count: number; seconds: number } {
    const open = this.downSinceMs !== null ? nowMs - this.downSinceMs : 0;
    return { count: this.count, seconds: Math.round((this.totalMs + open) / 1000) };
  }
}

// ---------------------------------------------------------------------------
// WebSocket transport
// ---------------------------------------------------------------------------
export type TransportState = "idle" | "connecting" | "open" | "closed";

export interface TelemetryTransport {
  connect(): void;
  close(): void;
  send(msg: ClientMessage): boolean;
  onMessage(cb: (msg: ServerMessage) => void): () => void;
  onState(cb: (state: TransportState, detail?: string) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
}

type WebSocketLike = Pick<WebSocket, "send" | "close" | "readyState"> & {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

export interface WebSocketTransportOptions {
  url: string;
  /** Sent on every (re)connect before anything else, e.g. tv_hello / camera_hello. */
  hello: () => ClientMessage | null;
  createSocket?: (url: string) => WebSocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  backoff?: ReconnectBackoff;
}

const OPEN = 1;

export class WebSocketTransport implements TelemetryTransport {
  private socket: WebSocketLike | null = null;
  private stopped = true;
  private retryHandle: unknown = null;
  private readonly backoff: ReconnectBackoff;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private messageCbs = new Set<(msg: ServerMessage) => void>();
  private stateCbs = new Set<(state: TransportState, detail?: string) => void>();
  private errorCbs = new Set<(err: Error) => void>();

  constructor(private readonly opts: WebSocketTransportOptions) {
    if (!opts.url.startsWith("wss://") && !opts.url.startsWith("ws://")) {
      throw new Error(`WebSocketTransport: invalid URL "${opts.url}"`);
    }
    this.backoff = opts.backoff ?? new ReconnectBackoff();
    this.createSocket = opts.createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.retryHandle !== null) this.clearTimer(this.retryHandle);
    this.retryHandle = null;
    this.socket?.close(1000, "client closed");
    this.socket = null;
    this.emitState("closed", "client closed");
  }

  /** Reconnect now (e.g. after re-pairing), resetting the backoff. */
  reconnectNow(): void {
    this.backoff.reset();
    if (this.retryHandle !== null) this.clearTimer(this.retryHandle);
    this.retryHandle = null;
    const s = this.socket;
    this.socket = null;
    s?.close(1000, "reconnect");
    if (!this.stopped) this.open();
  }

  send(msg: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  onMessage(cb: (msg: ServerMessage) => void) {
    this.messageCbs.add(cb);
    return () => void this.messageCbs.delete(cb);
  }
  onState(cb: (state: TransportState, detail?: string) => void) {
    this.stateCbs.add(cb);
    return () => void this.stateCbs.delete(cb);
  }
  onError(cb: (err: Error) => void) {
    this.errorCbs.add(cb);
    return () => void this.errorCbs.delete(cb);
  }

  private open(): void {
    this.emitState("connecting");
    const socket = this.createSocket(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.backoff.reset();
      this.emitState("open");
      const hello = this.opts.hello();
      if (hello) socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      try {
        const msg = parseServerMessage(String(ev.data));
        this.messageCbs.forEach((cb) => cb(msg));
      } catch (err) {
        this.emitError(new Error(`Invalid server message: ${(err as Error).message}`));
      }
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.emitError(new Error(`WebSocket error on ${this.opts.url}`));
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.emitState("closed", `code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ""}`);
      if (!this.stopped) {
        const delay = this.backoff.next();
        this.retryHandle = this.setTimer(() => {
          this.retryHandle = null;
          if (!this.stopped) this.open();
        }, delay);
      }
    };
  }

  private emitState(state: TransportState, detail?: string) {
    this.stateCbs.forEach((cb) => cb(state, detail));
  }
  private emitError(err: Error) {
    this.errorCbs.forEach((cb) => cb(err));
  }
}

export { PROTOCOL_VERSION };
