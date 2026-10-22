import { beforeEach, describe, expect, test } from "vitest";
import { onConnect, onDisconnect, onMessage, PAIRING_TOKEN_TTL_MS, type Ctx } from "../infra/lambda/src/lib/relay-core";
import { MemoryStore } from "../infra/lambda/src/lib/store";
import type { Pusher } from "../infra/lambda/src/lib/push";
import type { ServerMessage, TvSettings } from "../lib/firesense/protocol";

class FakePusher implements Pusher {
  sent: { to: string; msg: ServerMessage }[] = [];
  gone = new Set<string>();
  async post(to: string, msg: ServerMessage) {
    if (this.gone.has(to)) return "gone" as const;
    this.sent.push({ to, msg });
    return "ok" as const;
  }
  to(conn: string) {
    return this.sent.filter((s) => s.to === conn).map((s) => s.msg);
  }
  last(conn: string, type?: string) {
    const list = this.to(conn).filter((m) => !type || m.type === type);
    return list[list.length - 1] as any;
  }
  clear() {
    this.sent = [];
  }
}

let store: MemoryStore;
let pusher: FakePusher;
let now: number;
let ctx: Ctx;
const send = (conn: string, msg: object) => onMessage(ctx, conn, JSON.stringify({ v: 1, ...msg }));

beforeEach(() => {
  store = new MemoryStore();
  pusher = new FakePusher();
  now = 1_000_000;
  ctx = { store, pusher, now: () => now };
});

async function pairedSession() {
  await onConnect(ctx, "tv1", "tv");
  await send("tv1", { type: "tv_hello" });
  const s = pusher.last("tv1", "session");
  await onConnect(ctx, "cam1", "camera");
  await send("cam1", { type: "camera_hello", sessionId: s.sessionId, pairingToken: s.pairingToken });
  const paired = pusher.last("cam1", "paired");
  pusher.clear();
  return { sessionId: s.sessionId as string, tvSecret: s.tvSecret as string, cameraSecret: paired.cameraSecret as string };
}

const telemetry = (sessionId: string, seq = 1) => ({
  type: "telemetry",
  sessionId,
  seq,
  sentAt: 1,
  state: "TOO_CLOSE",
  distanceM: 1.1,
  blurPx: 13,
  posture: "GOOD",
  confidence: 0.9,
  event: "WARN",
  mode: "intervene",
});

describe("$connect", () => {
  test("requires role=tv|camera|parent", async () => {
    await expect(onConnect(ctx, "x", undefined)).rejects.toThrow(/role/);
    await expect(onConnect(ctx, "x", "admin")).rejects.toThrow(/role/);
  });
});

describe("QR pairing (plan §4)", () => {
  test("tv_hello creates a session with 128-bit ids and a 5-minute one-time token", async () => {
    await onConnect(ctx, "tv1", "tv");
    await send("tv1", { type: "tv_hello" });
    const s = pusher.last("tv1", "session");
    expect(s.sessionId).toMatch(/^s_[A-Za-z0-9_-]{22}$/);
    expect(s.pairingToken).toMatch(/^pt_[A-Za-z0-9_-]{22}$/);
    expect(s.tvSecret).toBeDefined();
    expect(s.pairingExpiresAt).toBe(now + PAIRING_TOKEN_TTL_MS);
    expect(pusher.last("tv1", "peer_status")).toMatchObject({ peer: "camera", connected: false });
    // Only hashes are stored.
    const rec = await store.getSession(s.sessionId);
    expect(JSON.stringify(rec)).not.toContain(s.pairingToken);
    expect(JSON.stringify(rec)).not.toContain(s.tvSecret);
  });

  test("camera pairs with the token; TV is told the camera is online; token cannot be reused", async () => {
    await onConnect(ctx, "tv1", "tv");
    await send("tv1", { type: "tv_hello" });
    const s = pusher.last("tv1", "session");
    await onConnect(ctx, "cam1", "camera");
    await send("cam1", { type: "camera_hello", sessionId: s.sessionId, pairingToken: s.pairingToken });
    expect(pusher.last("cam1", "paired").cameraSecret).toMatch(/^cs_/);
    expect(pusher.last("cam1", "peer_status")).toMatchObject({ peer: "tv", connected: true });
    expect(pusher.last("tv1", "peer_status")).toMatchObject({ peer: "camera", connected: true });
    expect(pusher.last("tv1", "camera_paired")).toMatchObject({ sessionId: s.sessionId });

    await onConnect(ctx, "cam2", "camera");
    await send("cam2", { type: "camera_hello", sessionId: s.sessionId, pairingToken: s.pairingToken });
    expect(pusher.last("cam2", "error")).toMatchObject({ code: "TOKEN_USED" });
  });

  test("expired token is rejected", async () => {
    await onConnect(ctx, "tv1", "tv");
    await send("tv1", { type: "tv_hello" });
    const s = pusher.last("tv1", "session");
    now += PAIRING_TOKEN_TTL_MS + 1;
    await onConnect(ctx, "cam1", "camera");
    await send("cam1", { type: "camera_hello", sessionId: s.sessionId, pairingToken: s.pairingToken });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  test("wrong token is rejected", async () => {
    await onConnect(ctx, "tv1", "tv");
    await send("tv1", { type: "tv_hello" });
    const s = pusher.last("tv1", "session");
    await onConnect(ctx, "cam1", "camera");
    await send("cam1", { type: "camera_hello", sessionId: s.sessionId, pairingToken: "pt_wrongwrongwrongwrong" });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_CREDENTIALS" });
  });

  test("both devices resume without rescanning (tv secret / camera secret)", async () => {
    const { sessionId, tvSecret, cameraSecret } = await pairedSession();
    await onConnect(ctx, "tv2", "tv");
    await send("tv2", { type: "tv_hello", sessionId, tvSecret });
    expect(pusher.last("tv2", "session")).toMatchObject({ sessionId, cameraPaired: true });
    expect(pusher.last("tv2", "session").tvSecret).toBeUndefined();

    await onConnect(ctx, "cam2", "camera");
    await send("cam2", { type: "camera_hello", sessionId, cameraSecret });
    expect(pusher.last("cam2", "paired")).toMatchObject({ sessionId, cameraSecret });
    expect(pusher.last("tv2", "peer_status")).toMatchObject({ peer: "camera", connected: true });
    // A reconnect is not a new pairing: the TV must not treat it as one (QR stays as the user left it).
    expect(pusher.last("tv2", "camera_paired")).toBeUndefined();
  });

  test("wrong tv secret fails fast instead of silently creating a new session", async () => {
    const { sessionId } = await pairedSession();
    await onConnect(ctx, "tv2", "tv");
    await send("tv2", { type: "tv_hello", sessionId, tvSecret: "tv_notthesecretatall00" });
    expect(pusher.last("tv2", "error")).toMatchObject({ code: "BAD_CREDENTIALS" });
    expect(store.sessions.size).toBe(1);
  });

  test("pairing_reset revokes the old camera secret and notifies the phone", async () => {
    const { sessionId, cameraSecret } = await pairedSession();
    await send("tv1", { type: "pairing_reset" });
    expect(pusher.last("cam1", "unpaired")).toMatchObject({ sessionId });
    expect(pusher.last("tv1", "session")).toMatchObject({ cameraPaired: false });

    await onConnect(ctx, "cam2", "camera");
    await send("cam2", { type: "camera_hello", sessionId, cameraSecret });
    expect(pusher.last("cam2", "error")).toMatchObject({ code: "BAD_CREDENTIALS" });
  });
});

describe("relay", () => {
  test("camera telemetry is forwarded verbatim to the TV", async () => {
    const { sessionId } = await pairedSession();
    await send("cam1", telemetry(sessionId));
    expect(pusher.last("tv1", "telemetry")).toMatchObject({ state: "TOO_CLOSE", blurPx: 13, event: "WARN" });
  });

  test("viewing_state goes TV → camera and is remembered for the next camera join", async () => {
    const { sessionId } = await pairedSession();
    await send("tv1", { type: "viewing_state", sessionId, playing: true });
    expect(pusher.last("cam1", "viewing_state")).toMatchObject({ playing: true });
    expect((await store.getSession(sessionId))?.playing).toBe(true);
  });

  test("calibration_pattern goes camera → TV and the ack comes back; roles are enforced", async () => {
    const { sessionId } = await pairedSession();
    await send("cam1", { type: "calibration_pattern", sessionId, pattern: "magenta" });
    expect(pusher.last("tv1", "calibration_pattern")).toMatchObject({ pattern: "magenta" });
    await send("tv1", { type: "calibration_pattern_ack", sessionId, pattern: "magenta" });
    expect(pusher.last("cam1", "calibration_pattern_ack")).toMatchObject({ pattern: "magenta" });
    await send("tv1", { type: "calibration_pattern", sessionId, pattern: "off" });
    expect(pusher.last("tv1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("cam1", { type: "calibration_pattern", sessionId, pattern: "rainbow" });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
  });

  test("camera_leaving and rtt_pong go camera → TV, rtt_ping TV → camera; roles are enforced", async () => {
    const { sessionId } = await pairedSession();
    await send("cam1", { type: "camera_leaving", sessionId, reason: "hidden" });
    expect(pusher.last("tv1", "camera_leaving")).toMatchObject({ reason: "hidden" });
    await send("tv1", { type: "rtt_ping", sessionId, id: 7 });
    expect(pusher.last("cam1", "rtt_ping")).toMatchObject({ id: 7 });
    await send("cam1", { type: "rtt_pong", sessionId, id: 7 });
    expect(pusher.last("tv1", "rtt_pong")).toMatchObject({ id: 7 });
    await send("tv1", { type: "camera_leaving", sessionId, reason: "pagehide" });
    expect(pusher.last("tv1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("cam1", { type: "rtt_ping", sessionId, id: 1 });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("cam1", { type: "camera_leaving", sessionId, reason: "crashed" });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
  });

  test("telemetry from an unpaired connection is dropped (plan §4)", async () => {
    const { sessionId } = await pairedSession();
    await onConnect(ctx, "intruder", "camera");
    await send("intruder", telemetry(sessionId));
    expect(pusher.last("intruder", "error")).toMatchObject({ code: "NOT_PAIRED" });
    expect(pusher.to("tv1")).toHaveLength(0);
  });

  test("role and session checks: TV cannot send telemetry; sessionId must match", async () => {
    const { sessionId } = await pairedSession();
    await send("tv1", telemetry(sessionId));
    expect(pusher.last("tv1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("cam1", telemetry("s_someothersession000000"));
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
  });

  test("GoneException on the TV → peer_status tv=false back to the camera, stale conn cleared", async () => {
    const { sessionId } = await pairedSession();
    pusher.gone.add("tv1");
    await send("cam1", telemetry(sessionId));
    expect(pusher.last("cam1", "peer_status")).toMatchObject({ peer: "tv", connected: false });
    expect((await store.getSession(sessionId))?.tvConnId).toBeUndefined();
  });

  test("invalid payloads are rejected with BAD_MESSAGE (no partial relay)", async () => {
    const { sessionId } = await pairedSession();
    await send("cam1", { ...telemetry(sessionId), blurPx: 99 });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await onMessage(ctx, "cam1", "not json");
    expect(pusher.to("tv1")).toHaveLength(0);
  });
});

describe("$disconnect", () => {
  test("camera disconnect → TV gets peer_status camera=false", async () => {
    await pairedSession();
    await onDisconnect(ctx, "cam1");
    expect(pusher.last("tv1", "peer_status")).toMatchObject({ peer: "camera", connected: false });
    expect(store.connections.has("cam1")).toBe(false);
  });

  test("a replaced (stale) connection disconnecting does not flap the peer", async () => {
    const { sessionId, cameraSecret } = await pairedSession();
    await onConnect(ctx, "cam2", "camera");
    await send("cam2", { type: "camera_hello", sessionId, cameraSecret });
    pusher.clear();
    await onDisconnect(ctx, "cam1");
    expect(pusher.to("tv1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parent phones: paired from a parent QR on the TV, talk to the camera through the relay.
// ---------------------------------------------------------------------------
async function withParent(parentConn = "par1") {
  const base = await pairedSession();
  await send("tv1", { type: "parent_pairing_request" });
  const pp = pusher.last("tv1", "parent_pairing");
  await onConnect(ctx, parentConn, "parent");
  await send(parentConn, { type: "parent_hello", sessionId: base.sessionId, pairingToken: pp.pairingToken });
  const paired = pusher.last(parentConn, "parent_paired");
  return { ...base, parentSecret: paired.parentSecret as string, parentToken: pp.pairingToken as string };
}

const status = (sessionId: string) => ({
  type: "camera_status",
  sessionId,
  sentAt: 1,
  mode: "shadow",
  monitoring: true,
  cameraOn: true,
  source: "user",
  tvOnline: true,
  playing: false,
  blackout: false,
  settings: { tooCloseM: 1.3, safeM: 1.65, markerAM: 1.2, markerBM: 1.8 },
  tvCalibration: { inches: 55, heightCm: 55 },
  calibration: { method: "tv_marker", floorBottomY: 1, edgeM: 0.9, tooCloseVisible: 1 },
  busy: null,
  message: null,
  errors: [],
  live: { state: "SAFE", distanceM: 2.1, blurPx: 0, posture: "GOOD", fps: 4, peopleCount: 1 },
  previewPeers: 0,
});

describe("parent pairing", () => {
  test("TV gets a one-time parent token; the parent gets a secret, peers and presence are announced", async () => {
    const { sessionId } = await pairedSession();
    await send("tv1", { type: "parent_pairing_request" });
    const pp = pusher.last("tv1", "parent_pairing");
    expect(pp).toMatchObject({ sessionId, parentCount: 0, pairingExpiresAt: now + PAIRING_TOKEN_TTL_MS });
    expect(pp.pairingToken).toMatch(/^pp_/);

    await onConnect(ctx, "par1", "parent");
    await send("par1", { type: "parent_hello", sessionId, pairingToken: pp.pairingToken });
    expect(pusher.last("par1", "parent_paired").parentSecret).toMatch(/^ps_/);
    expect(pusher.to("par1").filter((m) => m.type === "peer_status")).toEqual([
      { v: 1, type: "peer_status", peer: "tv", connected: true },
      { v: 1, type: "peer_status", peer: "camera", connected: true },
    ]);
    expect(pusher.last("cam1", "peer_status")).toMatchObject({ peer: "parent", connected: true });
    expect(pusher.last("tv1", "parent_joined")).toMatchObject({ parentCount: 1 });
    // The camera pairing is untouched.
    expect((await store.getSession(sessionId))?.cameraSecretHash).toBeDefined();
  });

  test("the parent token is one-time; a second parent needs a fresh one; the secret resumes", async () => {
    const { sessionId, parentSecret, parentToken } = await withParent();
    await onConnect(ctx, "par2", "parent");
    await send("par2", { type: "parent_hello", sessionId, pairingToken: parentToken });
    expect(pusher.last("par2", "error")).toMatchObject({ code: "TOKEN_USED" });
    await send("tv1", { type: "parent_pairing_request" });
    await send("par2", { type: "parent_hello", sessionId, pairingToken: pusher.last("tv1", "parent_pairing").pairingToken });
    expect(pusher.last("par2", "parent_paired")).toBeDefined();
    expect((await store.getSession(sessionId))?.parentSecretHashes).toHaveLength(2);

    await onConnect(ctx, "par3", "parent");
    await send("par3", { type: "parent_hello", sessionId, parentSecret });
    expect(pusher.last("par3", "parent_paired")).toMatchObject({ parentSecret });
    expect((await store.getSession(sessionId))?.parentConnIds).toEqual(["par1", "par2", "par3"]);
  });

  test("expired token, wrong secret, camera secret as parent secret, and the parent limit are rejected", async () => {
    const { sessionId, cameraSecret } = await pairedSession();
    await send("tv1", { type: "parent_pairing_request" });
    const token = pusher.last("tv1", "parent_pairing").pairingToken;
    now += PAIRING_TOKEN_TTL_MS + 1;
    await onConnect(ctx, "par1", "parent");
    await send("par1", { type: "parent_hello", sessionId, pairingToken: token });
    expect(pusher.last("par1", "error")).toMatchObject({ code: "TOKEN_EXPIRED" });
    await send("par1", { type: "parent_hello", sessionId, parentSecret: cameraSecret });
    expect(pusher.last("par1", "error")).toMatchObject({ code: "BAD_CREDENTIALS" });

    for (let i = 0; i < 4; i++) {
      await send("tv1", { type: "parent_pairing_request" });
      await onConnect(ctx, `p${i}`, "parent");
      await send(`p${i}`, { type: "parent_hello", sessionId, pairingToken: pusher.last("tv1", "parent_pairing").pairingToken });
      expect(pusher.last(`p${i}`, "parent_paired")).toBeDefined();
    }
    await send("tv1", { type: "parent_pairing_request" });
    expect(pusher.last("tv1", "parent_pairing").parentCount).toBe(4);
    await onConnect(ctx, "p5", "parent");
    await send("p5", { type: "parent_hello", sessionId, pairingToken: pusher.last("tv1", "parent_pairing").pairingToken });
    expect(pusher.last("p5", "error")).toMatchObject({ code: "PARENT_LIMIT" });
  });

  test("only the TV can ask for a parent token; a camera cannot say parent_hello", async () => {
    const { sessionId } = await pairedSession();
    await send("cam1", { type: "parent_pairing_request" });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("tv1", { type: "parent_pairing_request" });
    await send("cam1", { type: "parent_hello", sessionId, pairingToken: pusher.last("tv1", "parent_pairing").pairingToken });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
  });

  test("reset revokes every parent phone (told unpaired; the camera hears no parent is left)", async () => {
    const { sessionId, parentSecret } = await withParent();
    pusher.clear();
    await send("tv1", { type: "parent_pairing_request", reset: true });
    expect(pusher.last("par1", "unpaired")).toMatchObject({ sessionId });
    expect(pusher.last("cam1", "peer_status")).toMatchObject({ peer: "parent", connected: false });
    expect(pusher.last("tv1", "parent_pairing").parentCount).toBe(0);
    const s = await store.getSession(sessionId);
    expect(s?.parentSecretHashes).toBeUndefined();
    await onConnect(ctx, "par9", "parent");
    await send("par9", { type: "parent_hello", sessionId, parentSecret });
    expect(pusher.last("par9", "error")).toMatchObject({ code: "BAD_CREDENTIALS" });
  });
});

describe("parent <-> camera relay", () => {
  test("camera_status and command results go to every parent; commands go to the camera; never to the TV", async () => {
    const { sessionId } = await withParent("par1");
    await send("tv1", { type: "parent_pairing_request" });
    await onConnect(ctx, "par2", "parent");
    await send("par2", { type: "parent_hello", sessionId, pairingToken: pusher.last("tv1", "parent_pairing").pairingToken });
    pusher.clear();

    await send("cam1", status(sessionId));
    expect(pusher.last("par1", "camera_status")).toMatchObject({ mode: "shadow", live: { distanceM: 2.1 } });
    expect(pusher.last("par2", "camera_status")).toBeDefined();

    await send("par1", { type: "camera_command", sessionId, id: 3, command: { kind: "set_settings", settings: { tooCloseM: 1.4 } } });
    expect(pusher.last("cam1", "camera_command")).toMatchObject({ id: 3, command: { kind: "set_settings", settings: { tooCloseM: 1.4 } } });
    await send("cam1", { type: "camera_command_result", sessionId, id: 3, ok: true, message: "しきい値を変更しました" });
    expect(pusher.last("par2", "camera_command_result")).toMatchObject({ id: 3, ok: true });
    expect(pusher.to("tv1")).toHaveLength(0);
  });

  test("distance accuracy trial: parent → camera, with the recorder state in camera_status (MEASUREMENT_EVIDENCE §1)", async () => {
    const { sessionId } = await withParent("par1");
    pusher.clear();
    await send("par1", { type: "camera_command", sessionId, id: 7, command: { kind: "distance_trial", trueM: 1.2, lateral: "+0.5m", delayS: 3 } });
    expect(pusher.last("cam1", "camera_command")).toMatchObject({ id: 7, command: { kind: "distance_trial", trueM: 1.2, lateral: "+0.5m", delayS: 3 } });
    await send("par1", { type: "camera_command", sessionId, id: 8, command: { kind: "distance_trial_drop_last" } });
    expect(pusher.last("cam1", "camera_command")).toMatchObject({ id: 8, command: { kind: "distance_trial_drop_last" } });
    await send("cam1", { ...status(sessionId), distanceTrials: { trials: 2, recording: { trial: 3, trueM: 1.2, lateral: "center", waitS: 0, leftS: 7 } } });
    expect(pusher.last("par1", "camera_status")).toMatchObject({ distanceTrials: { trials: 2, recording: { trial: 3, leftS: 7 } } });
  });

  test("viewing_state from the TV also reaches the parents", async () => {
    const { sessionId } = await withParent();
    await send("tv1", { type: "viewing_state", sessionId, playing: true });
    expect(pusher.last("par1", "viewing_state")).toMatchObject({ playing: true });
  });

  test("rtc_signal: offer parent → camera, answer camera → parents; the SDP is not logged", async () => {
    const logs: Record<string, unknown>[] = [];
    ctx.log = (e) => logs.push(e);
    const { sessionId } = await withParent();
    const sdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
    await send("par1", { type: "rtc_signal", sessionId, peerId: "peer_0001", kind: "offer", sdp });
    expect(pusher.last("cam1", "rtc_signal")).toMatchObject({ kind: "offer", sdp, peerId: "peer_0001" });
    await send("cam1", { type: "rtc_signal", sessionId, peerId: "peer_0001", kind: "answer", sdp });
    expect(pusher.last("par1", "rtc_signal")).toMatchObject({ kind: "answer", sdp });
    const logged = JSON.stringify(logs.filter((l) => l.evt === "relay"));
    expect(logged).not.toContain("IN IP4");
    expect(logged).toContain(`<${sdp.length} chars>`);
  });

  test("roles: a parent cannot send telemetry or camera_status; the TV cannot command the camera", async () => {
    const { sessionId } = await withParent();
    pusher.clear();
    await send("par1", telemetry(sessionId));
    expect(pusher.last("par1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("par1", status(sessionId));
    expect(pusher.last("par1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("tv1", { type: "camera_command", sessionId, id: 1, command: { kind: "set_blackout", on: true } });
    expect(pusher.last("tv1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("par1", { type: "camera_command", sessionId, id: 1, command: { kind: "set_settings", settings: { tooCloseM: 9 } } });
    expect(pusher.last("par1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    expect(pusher.to("cam1")).toHaveLength(0);
    expect(pusher.to("tv1").filter((m) => m.type !== "error")).toHaveLength(0);
  });

  test("an unregistered parent connection cannot command the camera", async () => {
    const { sessionId } = await withParent();
    await onConnect(ctx, "par2", "parent");
    await store.bindConnection("par2", sessionId); // bound but never said parent_hello
    await send("par2", { type: "camera_command", sessionId, id: 1, command: { kind: "set_blackout", on: true } });
    expect(pusher.last("par2", "error")).toMatchObject({ code: "NOT_PAIRED" });
  });

  test("command with no camera online → the parent hears camera=false", async () => {
    const { sessionId } = await withParent();
    await onDisconnect(ctx, "cam1");
    expect(pusher.last("par1", "peer_status")).toMatchObject({ peer: "camera", connected: false });
    pusher.clear();
    await send("par1", { type: "camera_command", sessionId, id: 1, command: { kind: "set_mode", mode: "intervene" } });
    expect(pusher.last("par1", "peer_status")).toMatchObject({ peer: "camera", connected: false });
  });

  test("the last parent leaving tells the camera; a gone parent is dropped on the next status", async () => {
    const { sessionId, parentSecret } = await withParent("par1");
    await onConnect(ctx, "par2", "parent");
    await send("par2", { type: "parent_hello", sessionId, parentSecret });
    pusher.clear();
    await onDisconnect(ctx, "par1");
    expect(pusher.to("cam1")).toHaveLength(0);
    pusher.gone.add("par2");
    await send("cam1", status(sessionId));
    expect(pusher.last("cam1", "peer_status")).toMatchObject({ peer: "parent", connected: false });
    expect((await store.getSession(sessionId))?.parentConnIds).toBeUndefined();
  });

  test("a camera joining later is told whether a parent is connected", async () => {
    const { sessionId, cameraSecret } = await withParent();
    await onConnect(ctx, "cam2", "camera");
    await send("cam2", { type: "camera_hello", sessionId, cameraSecret });
    expect(pusher.last("cam2", "peer_status")).toMatchObject({ peer: "parent", connected: true });
    expect(pusher.last("par1", "peer_status")).toMatchObject({ peer: "camera", connected: true });
  });
});

describe("playlist: parent ↔ TV", () => {
  const playlist = {
    id: "custom",
    title: "おうちの動画",
    items: [
      { title: "Big Buck Bunny", url: "https://example.com/bbb.mp4", credit: "© Blender Foundation (CC BY 3.0)" },
      { title: "内蔵のおためし", url: "/videos/cartoon.mp4" },
    ],
  };
  const nowPlaying = (sessionId: string, index = 0) => ({
    type: "tv_now_playing",
    sessionId,
    playlistId: "custom",
    playlistTitle: "おうちの動画",
    index,
    count: 2,
    title: index ? "内蔵のおためし" : "Big Buck Bunny",
    error: null,
  });

  test("tv_playlist and tv_control go parent → TV only; tv_now_playing goes TV → every parent", async () => {
    const { sessionId } = await withParent("par1");
    pusher.clear();
    await send("par1", { type: "tv_playlist", sessionId, playlist });
    expect(pusher.last("tv1", "tv_playlist")).toMatchObject({ playlist: { id: "custom", items: [{ title: "Big Buck Bunny" }, { url: "/videos/cartoon.mp4" }] } });
    await send("par1", { type: "tv_control", sessionId, action: "next" });
    expect(pusher.last("tv1", "tv_control")).toMatchObject({ action: "next" });
    await send("par1", { type: "tv_records_reset", sessionId });
    expect(pusher.last("tv1", "tv_records_reset")).toMatchObject({ sessionId });
    expect(pusher.to("cam1")).toHaveLength(0);

    await send("tv1", nowPlaying(sessionId, 1));
    expect(pusher.last("par1", "tv_now_playing")).toMatchObject({ index: 1, title: "内蔵のおためし" });
    expect(pusher.to("cam1")).toHaveLength(0);
  });

  test("a parent that connects later gets the last now-playing at once", async () => {
    const { sessionId, parentSecret } = await withParent("par1");
    await send("tv1", nowPlaying(sessionId, 1));
    await onConnect(ctx, "par9", "parent");
    await send("par9", { type: "parent_hello", sessionId, parentSecret });
    expect(pusher.last("par9", "tv_now_playing")).toMatchObject({ index: 1 });
  });

  test("roles and URLs are enforced; TV offline is reported to the parent", async () => {
    const { sessionId } = await withParent("par1");
    await send("cam1", { type: "tv_playlist", sessionId, playlist });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("par1", nowPlaying(sessionId));
    expect(pusher.last("par1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("par1", { type: "tv_playlist", sessionId, playlist: { ...playlist, items: [{ title: "x", url: "http://insecure.example/v.mp4" }] } });
    expect(pusher.last("par1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await onDisconnect(ctx, "tv1");
    await send("par1", { type: "tv_control", sessionId, action: "previous" });
    expect(pusher.last("par1", "peer_status")).toMatchObject({ peer: "tv", connected: false });
  });
});

describe("the family's own list (DynamoDB, shared by parent phones)", () => {
  const custom = { id: "custom", title: "うちのリスト", items: [{ title: "Llamigos", url: "https://upload.wikimedia.org/x/llamigos.webm", credit: "CC BY 3.0" }] };

  test("a save is stored with the session and sent to every parent; a parent connecting later gets it", async () => {
    const { sessionId, parentSecret } = await withParent("par1");
    await send("tv1", { type: "parent_pairing_request" });
    await onConnect(ctx, "par2", "parent");
    await send("par2", { type: "parent_hello", sessionId, pairingToken: pusher.last("tv1", "parent_pairing").pairingToken });
    expect(pusher.last("par2", "playlist_library")).toMatchObject({ custom: null });

    await send("par1", { type: "playlist_save", sessionId, playlist: custom });
    expect((await store.getSession(sessionId))?.customPlaylist).toMatchObject({ items: [{ title: "Llamigos" }] });
    expect(pusher.last("par2", "playlist_library")).toMatchObject({ custom: { items: [{ title: "Llamigos" }] } });
    expect(pusher.to("tv1").filter((m) => m.type === "playlist_library")).toHaveLength(0);

    await onConnect(ctx, "par3", "parent");
    await send("par3", { type: "parent_hello", sessionId, parentSecret });
    expect(pusher.last("par3", "playlist_library")).toMatchObject({ custom: { title: "うちのリスト" } });

    await send("par1", { type: "playlist_save", sessionId, playlist: null });
    expect((await store.getSession(sessionId))?.customPlaylist).toBeUndefined();
    expect(pusher.last("par3", "playlist_library")).toMatchObject({ custom: null });
  });

  test("only a registered parent may save", async () => {
    const { sessionId } = await withParent("par1");
    await send("cam1", { type: "playlist_save", sessionId, playlist: custom });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
  });
});

describe("tv_settings (DynamoDB, TV intervention settings shared by parents and TV)", () => {
  const settings: TvSettings = {
    childCues: true,
    marker: false,
    pause: { enabled: true, afterSeconds: 30 },
  };

  test("a save is stored with the session and sent to TV and every parent; TV and parents connecting later get it", async () => {
    const { sessionId, parentSecret, tvSecret } = await withParent("par1");
    await send("tv1", { type: "parent_pairing_request" });
    await onConnect(ctx, "par2", "parent");
    await send("par2", { type: "parent_hello", sessionId, pairingToken: pusher.last("tv1", "parent_pairing").pairingToken });

    pusher.clear();
    await send("par1", { type: "tv_settings_save", sessionId, settings });
    expect((await store.getSession(sessionId))?.tvSettings).toEqual(settings);
    expect(pusher.last("tv1", "tv_settings")).toMatchObject({ settings });
    expect(pusher.last("par1", "tv_settings")).toMatchObject({ settings });
    expect(pusher.last("par2", "tv_settings")).toMatchObject({ settings });

    // TV reconnecting gets saved settings on tv_hello
    await onConnect(ctx, "tv2", "tv");
    await send("tv2", { type: "tv_hello", sessionId, tvSecret });
    expect(pusher.last("tv2", "tv_settings")).toMatchObject({ settings });

    // Parent reconnecting gets saved settings on parent_hello
    await onConnect(ctx, "par3", "parent");
    await send("par3", { type: "parent_hello", sessionId, parentSecret });
    expect(pusher.last("par3", "tv_settings")).toMatchObject({ settings });
  });

  test("only a registered parent may save tv_settings", async () => {
    const { sessionId } = await withParent("par1");
    await send("cam1", { type: "tv_settings_save", sessionId, settings });
    expect(pusher.last("cam1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
    await send("tv1", { type: "tv_settings_save", sessionId, settings });
    expect(pusher.last("tv1", "error")).toMatchObject({ code: "BAD_MESSAGE" });
  });
});

