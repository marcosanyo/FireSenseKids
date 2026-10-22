import { describe, expect, test } from "vitest";
import {
  CameraHelloSchema,
  DisconnectLedger,
  HeartbeatSchema,
  parseClientMessage,
  PeerLinkMonitor,
  ReconnectBackoff,
  SeqGate,
  TelemetrySchema,
  WebSocketTransport,
} from "../lib/firesense";

const SID = "sess_0123456789abcdef";

describe("protocol v1", () => {
  test("telemetry: BELOW_FRAME requires explicit null distance; blur bounded", () => {
    const t = { v: 1, type: "telemetry", sessionId: SID, seq: 3, sentAt: 1, state: "BELOW_FRAME", distanceM: null, blurPx: 24, posture: "UNKNOWN", confidence: 0.9, mode: "intervene" };
    expect(TelemetrySchema.parse(t).state).toBe("BELOW_FRAME");
    expect(() => TelemetrySchema.parse({ ...t, blurPx: 30 })).toThrow();
    expect(() => TelemetrySchema.parse({ ...t, v: 2 })).toThrow();
  });

  test("mode is required on telemetry and heartbeat; unknown modes are rejected, never assumed", () => {
    const t = { v: 1, type: "telemetry", sessionId: SID, seq: 3, sentAt: 1, state: "SAFE", distanceM: 2, blurPx: 0, posture: "GOOD", confidence: 0.9 };
    expect(TelemetrySchema.safeParse(t).success).toBe(false);
    expect(TelemetrySchema.safeParse({ ...t, mode: "silent" }).success).toBe(false);
    expect(TelemetrySchema.parse({ ...t, mode: "shadow" }).mode).toBe("shadow");
    expect(() => parseClientMessage(JSON.stringify(t))).toThrow();
    const hb = { v: 1, type: "heartbeat", sessionId: SID, sentAt: 1, fps: 2 };
    expect(HeartbeatSchema.safeParse(hb).success).toBe(false);
    expect(HeartbeatSchema.safeParse({ ...hb, mode: "intervene" }).success).toBe(true);
  });

  test("camera_hello needs exactly one of pairingToken / cameraSecret", () => {
    const base = { v: 1, type: "camera_hello", sessionId: SID };
    expect(CameraHelloSchema.safeParse({ ...base, pairingToken: "tok_0123456789" }).success).toBe(true);
    expect(CameraHelloSchema.safeParse({ ...base, cameraSecret: "sec_0123456789" }).success).toBe(true);
    expect(CameraHelloSchema.safeParse(base).success).toBe(false);
    expect(CameraHelloSchema.safeParse({ ...base, pairingToken: "tok_0123456789", cameraSecret: "sec_0123456789" }).success).toBe(false);
  });

  test("parseClientMessage rejects garbage instead of guessing", () => {
    expect(() => parseClientMessage("not json")).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "telemetry" }))).toThrow();
  });
});

describe("ReconnectBackoff", () => {
  test("1→2→4→…→30s cap, reset on success", () => {
    const b = new ReconnectBackoff();
    expect([b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    b.reset();
    expect(b.next()).toBe(1000);
  });
});

describe("SeqGate", () => {
  test("drops stale and duplicate seq; reset allows a restarted sender", () => {
    const g = new SeqGate();
    expect(g.accept({ seq: 5 })).toBe(true);
    expect(g.accept({ seq: 5 })).toBe(false);
    expect(g.accept({ seq: 4 })).toBe(false);
    expect(g.accept({ seq: 6 })).toBe(true);
    g.reset();
    expect(g.accept({ seq: 0 })).toBe(true);
  });
});

describe("PeerLinkMonitor — disconnect detection (plan §3)", () => {
  const live = () => {
    const m = new PeerLinkMonitor();
    m.onSocketOpen();
    m.onTelemetry(0);
    return m;
  };

  test("connected after the first telemetry", () => {
    expect(live().status(100)).toEqual({ connected: true });
  });

  test("① socket close", () => {
    const m = live();
    m.onSocketClosed();
    expect(m.status(100)).toEqual({ connected: false, reason: "SOCKET_CLOSED" });
  });

  test("② peer_status camera=false", () => {
    const m = live();
    m.onPeerStatus(false);
    expect(m.status(100)).toEqual({ connected: false, reason: "PEER_OFFLINE" });
  });

  test("③ 3s without telemetry or heartbeat (tab backgrounded)", () => {
    const m = live();
    m.onHeartbeat(1_000);
    expect(m.status(3_999).connected).toBe(true);
    expect(m.status(4_000)).toEqual({ connected: false, reason: "SILENT" });
  });

  test("④ the phone says it is leaving: down at once, reason kept until fresh telemetry", () => {
    const m = live();
    m.onPeerLeaving("hidden");
    expect(m.status(100)).toEqual({ connected: false, reason: "PEER_LEFT", peerLeft: "hidden" });
    m.onPeerStatus(false);
    expect(m.status(200)).toEqual({ connected: false, reason: "PEER_LEFT", peerLeft: "hidden" });
    m.onPeerStatus(true);
    m.onTelemetry(300);
    expect(m.status(400)).toEqual({ connected: true });
  });

  test("recovery needs a fresh telemetry, heartbeat alone is not enough", () => {
    const m = live();
    m.onSocketClosed();
    m.onSocketOpen();
    m.onHeartbeat(5_000);
    expect(m.status(5_100)).toEqual({ connected: false, reason: "WAITING_FIRST_TELEMETRY" });
    m.onTelemetry(5_200);
    expect(m.status(5_300).connected).toBe(true);
  });
});

describe("DisconnectLedger", () => {
  test("counts drops after the first connection and accumulates downtime", () => {
    const l = new DisconnectLedger();
    l.update(false, 0); // never connected yet: not a disconnect
    l.update(true, 1_000);
    l.update(false, 2_000);
    l.update(false, 3_000);
    l.update(true, 5_000);
    l.update(false, 10_000);
    expect(l.snapshot(12_000)).toEqual({ count: 2, seconds: 5 });
  });
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

describe("WebSocketTransport", () => {
  test("sends hello on every (re)connect and reconnects with backoff to the same URL", () => {
    FakeSocket.instances = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const states: string[] = [];
    const tr = new WebSocketTransport({
      url: "wss://relay.example/prod",
      hello: () => ({ v: 1, type: "tv_hello" }),
      createSocket: (u) => new FakeSocket(u) as never,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
    });
    tr.onState((s) => states.push(s));
    tr.connect();
    FakeSocket.instances[0].open();
    expect(JSON.parse(FakeSocket.instances[0].sent[0])).toEqual({ v: 1, type: "tv_hello" });

    FakeSocket.instances[0].drop();
    expect(timers[0].ms).toBe(1000);
    timers[0].fn();
    FakeSocket.instances[1].drop();
    expect(timers[1].ms).toBe(2000);
    timers[1].fn();
    FakeSocket.instances[2].open();
    expect(FakeSocket.instances[2].url).toBe("wss://relay.example/prod");
    expect(FakeSocket.instances[2].sent).toHaveLength(1);
    expect(states).toContain("closed");
  });

  test("invalid server messages surface as errors (not swallowed)", () => {
    FakeSocket.instances = [];
    const errors: string[] = [];
    const tr = new WebSocketTransport({
      url: "wss://relay.example/prod",
      hello: () => null,
      createSocket: (u) => new FakeSocket(u) as never,
    });
    tr.onError((e) => errors.push(e.message));
    tr.connect();
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].onmessage?.({ data: "{\"type\":\"bogus\"}" });
    expect(errors[0]).toMatch(/Invalid server message/);
  });

  test("rejects non-websocket URLs", () => {
    expect(() => new WebSocketTransport({ url: "https://x", hello: () => null })).toThrow();
  });
});
