import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  rehelloAllowed,
  FireSenseViewer,
  type ClientMessage,
  type FireSenseViewerEvents,
  type ServerMessage,
  type Telemetry,
  type TransportState,
  type ViewerCredentials,
  type ViewerTransport,
} from "../lib/firesense";

const SID = "sess_0123456789abcdef";
const SECRET = "tvsec_0123456789abcdef";
const TOKEN = "tok_0123456789abcdef";

class FakeTransport implements ViewerTransport {
  sent: ClientMessage[] = [];
  open = false;
  reconnects = 0;
  private msgCbs = new Set<(m: ServerMessage) => void>();
  private stateCbs = new Set<(s: TransportState, d?: string) => void>();
  private errCbs = new Set<(e: Error) => void>();
  constructor(readonly url: string, readonly hello: () => ClientMessage) {}

  connect() {
    this.setOpen(true);
  }
  close() {
    this.setOpen(false);
  }
  reconnectNow() {
    this.reconnects++;
    this.setOpen(false);
    this.setOpen(true);
  }
  send(msg: ClientMessage) {
    if (!this.open) return false;
    this.sent.push(msg);
    return true;
  }
  onMessage(cb: (m: ServerMessage) => void) {
    this.msgCbs.add(cb);
    return () => void this.msgCbs.delete(cb);
  }
  onState(cb: (s: TransportState, d?: string) => void) {
    this.stateCbs.add(cb);
    return () => void this.stateCbs.delete(cb);
  }
  onError(cb: (e: Error) => void) {
    this.errCbs.add(cb);
    return () => void this.errCbs.delete(cb);
  }

  // test controls
  setOpen(open: boolean) {
    this.open = open;
    this.stateCbs.forEach((cb) => cb(open ? "open" : "closed"));
    if (open) this.send(this.hello());
  }
  deliver(msg: ServerMessage) {
    this.msgCbs.forEach((cb) => cb(msg));
  }
  fail(message: string) {
    this.errCbs.forEach((cb) => cb(new Error(message)));
  }
}

function telemetry(seq: number, extra: Partial<Telemetry> = {}): Telemetry {
  return { v: 1, type: "telemetry", sessionId: SID, seq, sentAt: 0, state: "TOO_CLOSE", distanceM: 0.8, blurPx: 18, posture: "GOOD", confidence: 0.9, mode: "intervene", ...extra };
}

function setup(stored: ViewerCredentials | null = { sessionId: SID, tvSecret: SECRET }) {
  let transport!: FakeTransport;
  const store = { creds: stored, save: vi.fn() };
  const viewer = new FireSenseViewer({
    url: "wss://relay.example/prod",
    credentials: {
      load: () => store.creds,
      save: (c) => {
        store.creds = c;
        store.save(c);
      },
    },
    pairingUrl: (s, t) => `https://web.example/camera/?s=${s}&t=${t}`,
    parentPairingUrl: (s, t) => `https://web.example/parent/?s=${s}&pt=${t}`,
    createTransport: ({ url, hello }) => (transport = new FakeTransport(url, hello)),
  });
  const got: { [K in keyof FireSenseViewerEvents]: FireSenseViewerEvents[K][] } = {
    frame: [], session: [], event: [], pairing: [], paired: [], parentPairing: [], parentJoined: [], calibrationPattern: [], error: [], relay: [], heartbeat: [], linkLost: [], playlist: [], playbackControl: [], recordsReset: [], tvSettings: [],
  };
  (Object.keys(got) as (keyof FireSenseViewerEvents)[]).forEach((k) => viewer.on(k, ((p: unknown) => (got[k] as unknown[]).push(p)) as never));
  viewer.start();
  const lastFrame = () => got.frame[got.frame.length - 1];
  return { viewer, transport, store, got, lastFrame };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FireSenseViewer — connection", () => {
  test("connects as role=tv and resumes with stored credentials", () => {
    const { transport } = setup();
    expect(transport.url).toBe("wss://relay.example/prod?role=tv");
    expect(transport.sent[0]).toEqual({ v: 1, type: "tv_hello", sessionId: SID, tvSecret: SECRET });
  });

  test("without credentials, asks for a new session", () => {
    const { transport } = setup(null);
    expect(transport.sent[0]).toEqual({ v: 1, type: "tv_hello" });
  });
});

describe("FireSenseViewer — frames", () => {
  test("telemetry produces a frame that passes blurPx through", () => {
    const { transport, lastFrame } = setup();
    transport.deliver(telemetry(1, { blurPx: 17.5 }));
    expect(lastFrame()).toMatchObject({ blurPx: 17.5, state: "TOO_CLOSE", distanceM: 0.8, posture: "GOOD", confidence: 0.9, link: { connected: true }, test: false, seq: 1 });
  });

  test("events are forwarded with the test flag", () => {
    const { transport, got } = setup();
    transport.deliver(telemetry(1, { event: "WARN" }));
    transport.deliver(telemetry(2, { event: "STAR_AWARDED", state: "SAFE", blurPx: 0, test: true }));
    expect(got.event).toEqual([
      { type: "WARN", mode: "intervene", test: false },
      { type: "STAR_AWARDED", mode: "intervene", test: true },
    ]);
    expect(got.frame[got.frame.length - 1].test).toBe(true);
  });

  test("out-of-order telemetry is dropped", () => {
    const { transport, got, lastFrame } = setup();
    transport.deliver(telemetry(5, { blurPx: 10 }));
    const n = got.frame.length;
    transport.deliver(telemetry(4, { blurPx: 24, event: "WARN" }));
    transport.deliver(telemetry(5, { blurPx: 24 }));
    expect(got.frame.length).toBe(n);
    expect(got.event).toEqual([]);
    expect(lastFrame().blurPx).toBe(10);
  });

  test("① socket close → blurPx 0, link down", () => {
    const { transport, lastFrame } = setup();
    transport.deliver(telemetry(1));
    transport.setOpen(false);
    expect(lastFrame()).toMatchObject({ blurPx: 0, state: null, link: { connected: false, reason: "SOCKET_CLOSED" } });
  });

  test("② peer_status camera=false → blurPx 0, link down", () => {
    const { transport, lastFrame } = setup();
    transport.deliver(telemetry(1));
    transport.deliver({ v: 1, type: "peer_status", peer: "camera", connected: false });
    expect(lastFrame()).toMatchObject({ blurPx: 0, state: null, link: { connected: false, reason: "PEER_OFFLINE" } });
  });

  test("③ 3 s of silence → blurPx 0, link down (from the engine's own tick)", () => {
    const { transport, lastFrame } = setup();
    transport.deliver(telemetry(1));
    vi.advanceTimersByTime(2750);
    expect(lastFrame().link.connected).toBe(true);
    expect(lastFrame().blurPx).toBe(18);
    vi.advanceTimersByTime(250);
    expect(lastFrame()).toMatchObject({ blurPx: 0, link: { connected: false, reason: "SILENT" } });
  });

  test("recovery needs fresh telemetry; a restarted phone (lower seq) is accepted after a drop", () => {
    const { transport, lastFrame } = setup();
    transport.deliver(telemetry(50));
    transport.deliver({ v: 1, type: "peer_status", peer: "camera", connected: false });
    transport.deliver({ v: 1, type: "heartbeat", sessionId: SID, sentAt: 0, fps: 2, mode: "intervene" });
    expect(lastFrame().blurPx).toBe(0);
    transport.deliver(telemetry(0, { blurPx: 6 }));
    expect(lastFrame()).toMatchObject({ blurPx: 6, link: { connected: true } });
  });

  test("camera_leaving → link down at once with the phone's reason, until fresh telemetry", () => {
    const { transport, lastFrame } = setup();
    transport.deliver(telemetry(1));
    transport.deliver({ v: 1, type: "camera_leaving", sessionId: SID, reason: "pagehide" });
    expect(lastFrame()).toMatchObject({ blurPx: 0, state: null, link: { connected: false, reason: "PEER_LEFT", peerLeft: "pagehide" } });
    transport.deliver({ v: 1, type: "heartbeat", sessionId: SID, sentAt: 0, fps: 2, mode: "intervene" });
    expect(lastFrame().link).toEqual({ connected: false, reason: "PEER_LEFT", peerLeft: "pagehide" });
    transport.deliver(telemetry(0, { blurPx: 5 }));
    expect(lastFrame()).toMatchObject({ blurPx: 5, link: { connected: true } });
  });

  test("linkLost reports how long before detection the phone was last heard, and the blur it had", () => {
    const { transport, got } = setup();
    transport.deliver(telemetry(1, { blurPx: 20 }));
    vi.advanceTimersByTime(3000);
    expect(got.linkLost).toHaveLength(1);
    expect(got.linkLost[0]).toMatchObject({ link: { connected: false, reason: "SILENT" }, lastPeerMessageAgoMs: 3000, blurPxBefore: 20, test: false });
    // Only the up → down transition is reported.
    vi.advanceTimersByTime(3000);
    expect(got.linkLost).toHaveLength(1);
  });

  test("disconnects are counted for the daily summary", () => {
    const { viewer, transport } = setup();
    transport.deliver(telemetry(1));
    transport.setOpen(false);
    vi.advanceTimersByTime(4000);
    expect(viewer.disconnects()).toEqual({ count: 1, seconds: 4 });
  });
});

describe("FireSenseViewer — shadow mode (field pilot)", () => {
  test("shadow: the frame draws no blur but keeps the state for recording; events carry the mode", () => {
    const { transport, got, lastFrame } = setup();
    transport.deliver(telemetry(1, { mode: "shadow", state: "TOO_CLOSE", blurPx: 24, event: "WARN" }));
    expect(lastFrame()).toMatchObject({ blurPx: 0, mode: "shadow", state: "TOO_CLOSE", link: { connected: true } });
    expect(got.event).toEqual([{ type: "WARN", mode: "shadow", test: false }]);
  });

  test("a mode switch on the heartbeat updates the frame at once", () => {
    const { transport, lastFrame } = setup();
    transport.deliver(telemetry(1, { state: "TOO_CLOSE", blurPx: 20 }));
    expect(lastFrame()).toMatchObject({ blurPx: 20, mode: "intervene" });
    transport.deliver({ v: 1, type: "heartbeat", sessionId: SID, sentAt: 0, fps: 8, mode: "shadow" });
    expect(lastFrame()).toMatchObject({ blurPx: 0, mode: "shadow", state: "TOO_CLOSE" });
    transport.deliver({ v: 1, type: "heartbeat", sessionId: SID, sentAt: 0, fps: 8, mode: "intervene" });
    expect(lastFrame()).toMatchObject({ blurPx: 20, mode: "intervene" });
  });
});

describe("FireSenseViewer — session and pairing", () => {
  const session = (extra: Partial<Extract<ServerMessage, { type: "session" }>> = {}): ServerMessage => ({
    v: 1, type: "session", sessionId: SID, pairingToken: TOKEN, pairingExpiresAt: 1_000_000 + 300_000, cameraPaired: false, ...extra,
  });

  test("a new session saves credentials and emits pairing with the QR URL", () => {
    const { viewer, transport, store, got } = setup(null);
    transport.deliver(session({ tvSecret: SECRET }));
    expect(store.save).toHaveBeenCalledWith({ sessionId: SID, tvSecret: SECRET });
    expect(viewer.credentials).toEqual({ sessionId: SID, tvSecret: SECRET });
    expect(got.session).toEqual([{ sessionId: SID, created: true }]);
    expect(got.pairing).toEqual([
      { sessionId: SID, token: TOKEN, expiresAt: 1_300_000, cameraPaired: false, pairingUrl: `https://web.example/camera/?s=${SID}&t=${TOKEN}` },
    ]);
  });

  test("a resumed session does not overwrite credentials, and reports viewing_state", () => {
    const { viewer, transport, store } = setup();
    viewer.setPlaying(true);
    transport.sent = [];
    transport.deliver(session({ cameraPaired: true }));
    expect(store.save).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([{ v: 1, type: "viewing_state", sessionId: SID, playing: true }]);
  });

  test("setPlaying sends viewing_state", () => {
    const { viewer, transport } = setup();
    viewer.setPlaying(false);
    expect(transport.sent.at(-1)).toEqual({ v: 1, type: "viewing_state", sessionId: SID, playing: false });
  });

  test("camera_paired marks the pairing and emits paired", () => {
    const { transport, got } = setup();
    transport.deliver(session());
    transport.deliver({ v: 1, type: "camera_paired", sessionId: SID });
    expect(got.paired).toEqual([{ sessionId: SID }]);
    expect(got.pairing.at(-1)?.cameraPaired).toBe(true);
  });

  test("while the QR is visible, the token is refreshed 10 s before it expires", () => {
    const { viewer, transport } = setup();
    transport.deliver(session());
    transport.sent = [];
    vi.advanceTimersByTime(290_000);
    expect(transport.sent).toEqual([]); // not visible: no refresh
    viewer.setPairingVisible(true);
    expect(transport.sent).toEqual([]);
    vi.advanceTimersByTime(1000); // expiresAt - now - 10s is past → minimum 1 s
    expect(transport.sent).toEqual([{ v: 1, type: "tv_hello", sessionId: SID, tvSecret: SECRET }]);
  });

  test("resetPairing / newSession", () => {
    const { viewer, transport, store } = setup();
    viewer.resetPairing();
    expect(transport.sent.at(-1)).toEqual({ v: 1, type: "pairing_reset" });
    viewer.newSession();
    expect(store.save).toHaveBeenCalledWith(null);
    expect(viewer.credentials).toBeNull();
    expect(transport.reconnects).toBe(1);
    expect(transport.sent.at(-1)).toEqual({ v: 1, type: "tv_hello" });
  });

  test("server errors are passed through as-is", () => {
    const { transport, got } = setup();
    transport.deliver({ v: 1, type: "error", code: "BAD_CREDENTIALS", message: "tvSecret does not match" });
    transport.fail("WebSocket error on wss://relay.example/prod?role=tv");
    expect(got.error).toEqual([
      { source: "server", code: "BAD_CREDENTIALS", message: "tvSecret does not match" },
      { source: "transport", message: "WebSocket error on wss://relay.example/prod?role=tv" },
    ]);
  });
});

describe("FireSenseViewer — parent QR", () => {
  const PT = "pp_0123456789abcdef";
  const parentPairing = (extra = {}): ServerMessage => ({
    v: 1, type: "parent_pairing", sessionId: SID, pairingToken: PT, pairingExpiresAt: 1_300_000, parentCount: 1, ...extra,
  });

  test("requestParentPairing asks the relay; the answer becomes a parent QR URL", () => {
    const { viewer, transport, got } = setup();
    viewer.requestParentPairing();
    expect(transport.sent.at(-1)).toEqual({ v: 1, type: "parent_pairing_request" });
    viewer.requestParentPairing(true);
    expect(transport.sent.at(-1)).toEqual({ v: 1, type: "parent_pairing_request", reset: true });
    transport.deliver(parentPairing());
    expect(got.parentPairing).toEqual([
      { sessionId: SID, token: PT, expiresAt: 1_300_000, parentCount: 1, pairingUrl: `https://web.example/parent/?s=${SID}&pt=${PT}` },
    ]);
  });

  test("while visible, the parent token is refreshed before expiry and after it is used", () => {
    const { viewer, transport, got } = setup();
    transport.deliver(parentPairing());
    transport.sent = [];
    vi.advanceTimersByTime(295_000);
    expect(transport.sent).toEqual([]);
    viewer.setParentPairingVisible(true);
    vi.advanceTimersByTime(1000);
    expect(transport.sent).toEqual([{ v: 1, type: "parent_pairing_request" }]);
    transport.sent = [];
    transport.deliver({ v: 1, type: "parent_joined", sessionId: SID, parentCount: 2 });
    expect(got.parentJoined).toEqual([{ sessionId: SID, parentCount: 2 }]);
    expect(transport.sent).toEqual([{ v: 1, type: "parent_pairing_request" }]);
    viewer.setParentPairingVisible(false);
    transport.sent = [];
    transport.deliver({ v: 1, type: "parent_joined", sessionId: SID, parentCount: 3 });
    expect(transport.sent).toEqual([]);
  });

  test("a player without parentPairingUrl cannot ask for a parent QR", () => {
    const viewer = new FireSenseViewer({
      url: "wss://relay.example/prod",
      credentials: { load: () => null, save: () => {} },
      pairingUrl: (s, t) => `${s}${t}`,
    });
    expect(() => viewer.requestParentPairing()).toThrow(/parentPairingUrl/);
  });
});

describe("FireSenseViewer — calibration pattern", () => {
  test("calibration_pattern is emitted; ackCalibrationPattern sends the ack", () => {
    const { viewer, transport, got } = setup();
    transport.deliver({ v: 1, type: "calibration_pattern", sessionId: SID, pattern: "magenta" });
    expect(got.calibrationPattern).toEqual(["magenta"]);
    expect(viewer.ackCalibrationPattern("magenta")).toBe(true);
    expect(transport.sent.at(-1)).toEqual({ v: 1, type: "calibration_pattern_ack", sessionId: SID, pattern: "magenta" });
  });

  test("stop() closes the transport and stops the tick", () => {
    const { viewer, transport, got } = setup();
    viewer.stop();
    expect(transport.open).toBe(false);
    const n = got.frame.length;
    vi.advanceTimersByTime(5000);
    expect(got.frame.length).toBe(n);
  });
});

describe("FireSenseViewer — round trip", () => {
  test("rtt_ping goes out, the matching rtt_pong resolves with the elapsed time", async () => {
    const { viewer, transport } = setup();
    let t = 100;
    const p = viewer.measureRoundTrip(5000, () => t);
    const ping = transport.sent[transport.sent.length - 1];
    expect(ping).toMatchObject({ type: "rtt_ping", sessionId: SID });
    t = 342;
    transport.deliver({ v: 1, type: "rtt_pong", sessionId: SID, id: 99 }); // not ours: ignored
    transport.deliver({ v: 1, type: "rtt_pong", sessionId: SID, id: (ping as { id: number }).id });
    await expect(p).resolves.toBe(242);
  });

  test("no reply within the timeout rejects (a lost probe is never counted as a time)", async () => {
    const { viewer } = setup();
    const p = viewer.measureRoundTrip(1000);
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toThrow(/no rtt_pong/);
  });

  test("closed socket rejects at once", async () => {
    const { viewer, transport } = setup();
    transport.setOpen(false);
    await expect(viewer.measureRoundTrip()).rejects.toThrow(/not open/);
  });
});

describe("FireSenseViewer — playlist", () => {
  test("tv_playlist / tv_control from a parent are emitted; reportNowPlaying sends tv_now_playing", () => {
    const { viewer, transport, got } = setup();
    const playlist = { id: "custom", title: "おうちの動画", items: [{ title: "A", url: "https://example.com/a.mp4" }] };
    transport.deliver({ v: 1, type: "tv_playlist", sessionId: SID, playlist });
    transport.deliver({ v: 1, type: "tv_control", sessionId: SID, action: "next" });
    transport.deliver({ v: 1, type: "tv_control", sessionId: "s_other_session", action: "previous" });
    expect(got.playlist).toEqual([playlist]);
    expect(got.playbackControl).toEqual(["next"]);
    expect(viewer.reportNowPlaying({ playlistId: "custom", playlistTitle: "おうちの動画", index: 0, count: 1, title: "A", error: null })).toBe(true);
    expect(transport.sent.at(-1)).toMatchObject({ type: "tv_now_playing", sessionId: SID, index: 0, title: "A", error: null });
  });
});

describe("FireSenseViewer — tv_settings & error recovery", () => {
  test("tv_records_reset from a parent is emitted for this session only", () => {
    const { transport, got } = setup();
    transport.deliver({ v: 1, type: "tv_records_reset", sessionId: SID });
    transport.deliver({ v: 1, type: "tv_records_reset", sessionId: "s_other_session_00000000" });
    expect(got.recordsReset).toEqual([{ sessionId: SID }]);
  });

  test("tv_settings is emitted when received for matching session", () => {
    const { transport, got } = setup();
    const settings = { childCues: false, marker: true, pause: { enabled: true, afterSeconds: 20 } };
    transport.deliver({ v: 1, type: "tv_settings", sessionId: SID, settings });
    transport.deliver({ v: 1, type: "tv_settings", sessionId: "other_session", settings: { ...settings, marker: false } });
    expect(got.tvSettings).toEqual([settings]);
  });

  test("NOT_PAIRED error triggers auto-recovery by resending tv_hello", () => {
    const { transport, got } = setup();
    transport.sent = [];
    transport.deliver({ v: 1, type: "error", code: "NOT_PAIRED", message: "connection is not paired with a session" });
    expect(got.error[0]).toMatchObject({ source: "server", code: "NOT_PAIRED" });
    expect(transport.sent[0]).toMatchObject({ type: "tv_hello", sessionId: SID, tvSecret: SECRET });
  });
});


describe("NOT_PAIRED auto re-hello", () => {
  test("re-hellos after a lost hello, at most every 5 s, never when another device replaced this one", () => {
    expect(rehelloAllowed("connection is not paired with a session", 0, 10_000)).toBe(true);
    expect(rehelloAllowed("connection is not paired with a session", 8_000, 10_000)).toBe(false);
    expect(rehelloAllowed("this connection was replaced by a newer one for the session", 0, 10_000)).toBe(false);
  });
});
