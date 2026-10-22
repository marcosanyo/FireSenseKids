/**
 * Relay / pairing core (plan §3, §4). Transport-agnostic: Store and Pusher are injected.
 *
 * The relay never inspects or produces image data. It forwards small numeric JSON
 * between the camera phone and the TV of the same session, and between the camera
 * phone and the session's parent phones (state, commands, and WebRTC offer/answer for
 * the parent's live preview; the video itself goes phone-to-phone, never through here).
 */

import {
  CalibrationPatternAckSchema,
  CalibrationPatternSchema,
  CameraCommandMessageSchema,
  CameraCommandResultSchema,
  CameraHelloSchema,
  CameraLeavingSchema,
  CameraStatusSchema,
  HeartbeatSchema,
  MAX_PARENTS,
  PairingResetSchema,
  ParentHelloSchema,
  ParentPairingRequestSchema,
  RtcSignalSchema,
  RttPingSchema,
  RttPongSchema,
  PROTOCOL_VERSION,
  TelemetrySchema,
  TvControlSchema,
  TvRecordsResetSchema,
  TvHelloSchema,
  TvNowPlayingSchema,
  TvPlaylistSchema,
  PlaylistSaveSchema,
  TvSettingsSaveMessageSchema,
  ViewingStateMessageSchema,
  type ErrorCode,
  type ServerMessage,
} from "../../../../lib/firesense/protocol";
import { ZodError } from "zod";
import { hashSecret, randomId, secretMatches } from "./crypto";
import type { Pusher } from "./push";
import {
  CONNECTION_TTL_HOURS,
  SESSION_TTL_DAYS,
  ttlFromNow,
  type Role,
  type SessionRecord,
  type Store,
} from "./store";

export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface Ctx {
  store: Store;
  pusher: Pusher;
  now: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export class RelayError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}

const err = (code: ErrorCode, message: string): ServerMessage => ({ v: PROTOCOL_VERSION, type: "error", code, message });

// ---------------------------------------------------------------------------
// $connect / $disconnect
// ---------------------------------------------------------------------------
export async function onConnect(ctx: Ctx, connectionId: string, roleParam: string | undefined): Promise<void> {
  if (roleParam !== "tv" && roleParam !== "camera" && roleParam !== "parent") {
    throw new RelayError("BAD_MESSAGE", `query parameter role must be "tv", "camera" or "parent" (got ${String(roleParam)})`);
  }
  await ctx.store.putConnection({
    connectionId,
    role: roleParam,
    ttl: ttlFromNow(ctx.now(), CONNECTION_TTL_HOURS * 3600),
  });
}

export async function onDisconnect(ctx: Ctx, connectionId: string): Promise<void> {
  const conn = await ctx.store.getConnection(connectionId);
  await ctx.store.deleteConnection(connectionId);
  if (!conn?.sessionId) return;

  if (conn.role === "parent") {
    const left = await ctx.store.removeParentConnection(conn.sessionId, connectionId);
    if (left && left.length === 0) await tellCameraParentPresence(ctx, conn.sessionId, false);
    return;
  }

  const cleared = await ctx.store.clearPeerConnection(conn.sessionId, conn.role, connectionId);
  if (!cleared) return; // a newer connection already replaced this one

  const session = await ctx.store.getSession(conn.sessionId);
  const peerConn = conn.role === "tv" ? session?.cameraConnId : session?.tvConnId;
  const gone = { v: PROTOCOL_VERSION, type: "peer_status", peer: conn.role as "tv" | "camera", connected: false } as const;
  if (peerConn) await postOrClear(ctx, conn.sessionId, conn.role === "tv" ? "camera" : "tv", peerConn, gone);
  if (session) await tellParents(ctx, session, gone);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export async function onMessage(ctx: Ctx, connectionId: string, body: string | null | undefined): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    await ctx.pusher.post(connectionId, err("BAD_MESSAGE", "body is not valid JSON"));
    return;
  }
  const type = (raw as { type?: unknown })?.type;
  try {
    switch (type) {
      case "tv_hello":
        return await tvHello(ctx, connectionId, raw);
      case "camera_hello":
        return await cameraHello(ctx, connectionId, raw);
      case "pairing_reset":
        return await pairingReset(ctx, connectionId, raw);
      case "parent_pairing_request":
        return await parentPairingRequest(ctx, connectionId, raw);
      case "parent_hello":
        return await parentHello(ctx, connectionId, raw);
      case "camera_status":
      case "camera_command_result":
      case "camera_command":
      case "rtc_signal":
        return await relayParent(ctx, connectionId, raw);
      case "tv_playlist":
      case "tv_control":
      case "tv_records_reset":
      case "tv_now_playing":
        return await relayPlayback(ctx, connectionId, raw);
      case "playlist_save":
        return await savePlaylist(ctx, connectionId, raw);
      case "tv_settings_save":
        return await saveTvSettings(ctx, connectionId, raw);
      case "telemetry":
      case "heartbeat":
      case "viewing_state":
      case "calibration_pattern":
      case "calibration_pattern_ack":
      case "camera_leaving":
      case "rtt_ping":
      case "rtt_pong":
        return await relay(ctx, connectionId, raw);
      default:
        await ctx.pusher.post(connectionId, err("BAD_MESSAGE", `unknown message type ${JSON.stringify(type)}`));
    }
  } catch (e) {
    if (e instanceof RelayError) {
      await ctx.pusher.post(connectionId, err(e.code, e.message));
      return;
    }
    if (e instanceof ZodError) {
      await ctx.pusher.post(connectionId, err("BAD_MESSAGE", e.message));
      return;
    }
    throw e;
  }
}

async function requireConnection(ctx: Ctx, connectionId: string, role: Role) {
  const conn = await ctx.store.getConnection(connectionId);
  if (!conn) throw new RelayError("INTERNAL", `connection ${connectionId} is not registered`);
  if (conn.role !== role) throw new RelayError("BAD_MESSAGE", `this message is only allowed for role=${role}`);
  return conn;
}

function newPairingToken(nowMs: number) {
  const token = randomId("pt");
  return { token, patch: { tokenHash: hashSecret(token), tokenExpiresAt: nowMs + PAIRING_TOKEN_TTL_MS, tokenUsed: false } };
}

async function tvHello(ctx: Ctx, connectionId: string, raw: unknown) {
  const msg = TvHelloSchema.parse(raw);
  await requireConnection(ctx, connectionId, "tv");
  const now = ctx.now();
  const { token, patch } = newPairingToken(now);

  let session: SessionRecord;
  let tvSecret: string | undefined;
  if (msg.sessionId || msg.tvSecret) {
    if (!msg.sessionId || !msg.tvSecret) throw new RelayError("BAD_MESSAGE", "sessionId and tvSecret must be sent together");
    const existing = await ctx.store.getSession(msg.sessionId);
    if (!existing) throw new RelayError("SESSION_NOT_FOUND", `session ${msg.sessionId} does not exist or has expired`);
    if (!secretMatches(msg.tvSecret, existing.tvSecretHash)) throw new RelayError("BAD_CREDENTIALS", "tvSecret does not match this session");
    await ctx.store.updateSession(existing.sessionId, { ...patch, tvConnId: connectionId, ttl: ttlFromNow(now, SESSION_TTL_DAYS * 86400) });
    session = { ...existing, ...patch, tvConnId: connectionId };
  } else {
    tvSecret = randomId("tv");
    session = {
      sessionId: randomId("s"),
      tvSecretHash: hashSecret(tvSecret),
      ...patch,
      tvConnId: connectionId,
      playing: false,
      createdAt: now,
      ttl: ttlFromNow(now, SESSION_TTL_DAYS * 86400),
    };
    await ctx.store.createSession(session);
  }
  await ctx.store.bindConnection(connectionId, session.sessionId);

  await ctx.pusher.post(connectionId, {
    v: PROTOCOL_VERSION,
    type: "session",
    sessionId: session.sessionId,
    ...(tvSecret ? { tvSecret } : {}),
    pairingToken: token,
    pairingExpiresAt: patch.tokenExpiresAt,
    cameraPaired: Boolean(session.cameraSecretHash),
  });
  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "camera", connected: Boolean(session.cameraConnId) });
  if (session.cameraConnId) {
    await postOrClear(ctx, session.sessionId, "camera", session.cameraConnId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "tv", connected: true });
  }
  if (session.tvSettings) {
    await ctx.pusher.post(connectionId, {
      v: PROTOCOL_VERSION,
      type: "tv_settings",
      sessionId: session.sessionId,
      settings: session.tvSettings,
    });
  }
  ctx.log?.({ evt: "tv_hello", sessionId: session.sessionId, resumed: Boolean(msg.sessionId) });
}

async function cameraHello(ctx: Ctx, connectionId: string, raw: unknown) {
  const msg = CameraHelloSchema.parse(raw);
  await requireConnection(ctx, connectionId, "camera");
  const now = ctx.now();
  const session = await ctx.store.getSession(msg.sessionId);
  if (!session) throw new RelayError("SESSION_NOT_FOUND", `session ${msg.sessionId} does not exist or has expired`);

  let cameraSecret: string;
  const previousCamera = session.cameraConnId;
  if (msg.pairingToken) {
    if (!secretMatches(msg.pairingToken, session.tokenHash)) throw new RelayError("BAD_CREDENTIALS", "pairing token does not match; scan the QR code shown on the TV again");
    if (session.tokenUsed) throw new RelayError("TOKEN_USED", "this QR code was already used; press OK on the TV remote to show a new one");
    if ((session.tokenExpiresAt ?? 0) <= now) throw new RelayError("TOKEN_EXPIRED", "this QR code has expired; press OK on the TV remote to show a new one");
    cameraSecret = randomId("cs");
    const ok = await ctx.store.consumePairingToken(session.sessionId, hashSecret(msg.pairingToken), now, hashSecret(cameraSecret), connectionId);
    if (!ok) throw new RelayError("TOKEN_USED", "this QR code was already used");
  } else {
    if (!secretMatches(msg.cameraSecret as string, session.cameraSecretHash)) {
      throw new RelayError("BAD_CREDENTIALS", "this phone is no longer paired with the TV; scan the QR code again");
    }
    cameraSecret = msg.cameraSecret as string;
    await ctx.store.updateSession(session.sessionId, { cameraConnId: connectionId });
  }
  await ctx.store.bindConnection(connectionId, session.sessionId);

  // Only one camera per session: a different previous connection is told it was replaced.
  if (previousCamera && previousCamera !== connectionId && msg.pairingToken) {
    await ctx.pusher.post(previousCamera, { v: PROTOCOL_VERSION, type: "unpaired", sessionId: session.sessionId });
  }

  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "paired", sessionId: session.sessionId, cameraSecret });
  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "tv", connected: Boolean(session.tvConnId) });
  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "viewing_state", sessionId: session.sessionId, playing: Boolean(session.playing) });
  // The camera assumes no parent until told otherwise.
  if (session.parentConnIds?.length) await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "parent", connected: true });
  await tellParents(ctx, session, { v: PROTOCOL_VERSION, type: "peer_status", peer: "camera", connected: true });
  if (session.tvConnId) {
    const delivered = await postOrClear(ctx, session.sessionId, "tv", session.tvConnId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "camera", connected: true });
    if (delivered && msg.pairingToken) {
      await ctx.pusher.post(session.tvConnId, { v: PROTOCOL_VERSION, type: "camera_paired", sessionId: session.sessionId });
    }
  }
  ctx.log?.({ evt: "camera_hello", sessionId: session.sessionId, via: msg.pairingToken ? "qr" : "secret" });
}

async function pairingReset(ctx: Ctx, connectionId: string, raw: unknown) {
  PairingResetSchema.parse(raw);
  const conn = await requireConnection(ctx, connectionId, "tv");
  if (!conn.sessionId) throw new RelayError("NOT_PAIRED", "send tv_hello before pairing_reset");
  const session = await ctx.store.getSession(conn.sessionId);
  if (!session || session.tvConnId !== connectionId) throw new RelayError("SESSION_NOT_FOUND", "session is not bound to this TV connection");

  const now = ctx.now();
  const { token, patch } = newPairingToken(now);
  await ctx.store.updateSession(session.sessionId, { ...patch, cameraSecretHash: null, cameraConnId: null });
  if (session.cameraConnId) {
    await ctx.pusher.post(session.cameraConnId, { v: PROTOCOL_VERSION, type: "unpaired", sessionId: session.sessionId });
    await tellParents(ctx, session, { v: PROTOCOL_VERSION, type: "peer_status", peer: "camera", connected: false });
  }
  await ctx.pusher.post(connectionId, {
    v: PROTOCOL_VERSION,
    type: "session",
    sessionId: session.sessionId,
    pairingToken: token,
    pairingExpiresAt: patch.tokenExpiresAt,
    cameraPaired: false,
  });
  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "camera", connected: false });
  ctx.log?.({ evt: "pairing_reset", sessionId: session.sessionId });
}

// ---------------------------------------------------------------------------
// Parent phones (paired from a parent QR on the TV; several per session)
// ---------------------------------------------------------------------------
async function requireTvSession(ctx: Ctx, connectionId: string, what: string) {
  const conn = await requireConnection(ctx, connectionId, "tv");
  if (!conn.sessionId) throw new RelayError("NOT_PAIRED", `send tv_hello before ${what}`);
  const session = await ctx.store.getSession(conn.sessionId);
  if (!session || session.tvConnId !== connectionId) throw new RelayError("SESSION_NOT_FOUND", "session is not bound to this TV connection");
  return session;
}

async function parentPairingRequest(ctx: Ctx, connectionId: string, raw: unknown) {
  const msg = ParentPairingRequestSchema.parse(raw);
  let session = await requireTvSession(ctx, connectionId, "parent_pairing_request");
  const now = ctx.now();
  const token = randomId("pp");
  const patch: Partial<Record<keyof SessionRecord, unknown>> = {
    parentTokenHash: hashSecret(token),
    parentTokenExpiresAt: now + PAIRING_TOKEN_TTL_MS,
    parentTokenUsed: false,
  };
  if (msg.reset) {
    patch.parentSecretHashes = null;
    patch.parentConnIds = null;
  }
  await ctx.store.updateSession(session.sessionId, patch);
  if (msg.reset) {
    for (const p of session.parentConnIds ?? []) {
      await ctx.pusher.post(p, { v: PROTOCOL_VERSION, type: "unpaired", sessionId: session.sessionId });
    }
    if (session.parentConnIds?.length) await tellCameraParentPresence(ctx, session.sessionId, false);
    session = { ...session, parentSecretHashes: undefined, parentConnIds: undefined };
  }
  await ctx.pusher.post(connectionId, {
    v: PROTOCOL_VERSION,
    type: "parent_pairing",
    sessionId: session.sessionId,
    pairingToken: token,
    pairingExpiresAt: now + PAIRING_TOKEN_TTL_MS,
    parentCount: session.parentSecretHashes?.length ?? 0,
  });
  ctx.log?.({ evt: "parent_pairing_request", sessionId: session.sessionId, reset: Boolean(msg.reset) });
}

async function parentHello(ctx: Ctx, connectionId: string, raw: unknown) {
  const msg = ParentHelloSchema.parse(raw);
  await requireConnection(ctx, connectionId, "parent");
  const now = ctx.now();
  const session = await ctx.store.getSession(msg.sessionId);
  if (!session) throw new RelayError("SESSION_NOT_FOUND", `session ${msg.sessionId} does not exist or has expired`);

  let parentSecret: string;
  if (msg.pairingToken) {
    if (!secretMatches(msg.pairingToken, session.parentTokenHash)) {
      throw new RelayError("BAD_CREDENTIALS", "parent pairing token does not match; scan the parent QR code shown on the TV again");
    }
    if (session.parentTokenUsed) throw new RelayError("TOKEN_USED", "this parent QR code was already used; show a new one on the TV");
    if ((session.parentTokenExpiresAt ?? 0) <= now) throw new RelayError("TOKEN_EXPIRED", "this parent QR code has expired; show a new one on the TV");
    if ((session.parentSecretHashes?.length ?? 0) >= MAX_PARENTS) {
      throw new RelayError("PARENT_LIMIT", `${MAX_PARENTS} parent phones are already registered; remove them on the TV first`);
    }
    parentSecret = randomId("ps");
    const ok = await ctx.store.consumeParentPairingToken(session.sessionId, hashSecret(msg.pairingToken), now, hashSecret(parentSecret), MAX_PARENTS);
    if (!ok) throw new RelayError("TOKEN_USED", "this parent QR code was already used (or the parent limit was reached at the same moment)");
  } else {
    const secret = msg.parentSecret as string;
    if (!(session.parentSecretHashes ?? []).some((h) => secretMatches(secret, h))) {
      throw new RelayError("BAD_CREDENTIALS", "this phone is no longer registered as a parent phone; scan the parent QR code on the TV again");
    }
    parentSecret = secret;
  }
  await ctx.store.bindConnection(connectionId, session.sessionId);
  const wasEmpty = (session.parentConnIds ?? []).length === 0;
  await ctx.store.addParentConnection(session.sessionId, connectionId);

  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "parent_paired", sessionId: session.sessionId, parentSecret });
  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "tv", connected: Boolean(session.tvConnId) });
  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "camera", connected: Boolean(session.cameraConnId) });
  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "viewing_state", sessionId: session.sessionId, playing: Boolean(session.playing) });
  if (session.nowPlaying) await ctx.pusher.post(connectionId, session.nowPlaying);
  await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "playlist_library", sessionId: session.sessionId, custom: session.customPlaylist ?? null });
  if (session.tvSettings) {
    await ctx.pusher.post(connectionId, {
      v: PROTOCOL_VERSION,
      type: "tv_settings",
      sessionId: session.sessionId,
      settings: session.tvSettings,
    });
  }
  if (wasEmpty) await tellCameraParentPresence(ctx, session.sessionId, true);
  if (msg.pairingToken && session.tvConnId) {
    await postOrClear(ctx, session.sessionId, "tv", session.tvConnId, {
      v: PROTOCOL_VERSION,
      type: "parent_joined",
      sessionId: session.sessionId,
      parentCount: (session.parentSecretHashes?.length ?? 0) + 1,
    });
  }
  ctx.log?.({ evt: "parent_hello", sessionId: session.sessionId, via: msg.pairingToken ? "qr" : "secret" });
}

/** camera_status / camera_command_result / rtc_signal (camera -> every parent), camera_command / rtc_signal (parent -> camera). */
async function relayParent(ctx: Ctx, connectionId: string, raw: unknown) {
  const conn = await ctx.store.getConnection(connectionId);
  if (!conn?.sessionId) throw new RelayError("NOT_PAIRED", "connection is not paired with a session");
  const type = (raw as { type: string }).type;
  const msg =
    type === "camera_status"
      ? CameraStatusSchema.parse(raw)
      : type === "camera_command_result"
      ? CameraCommandResultSchema.parse(raw)
      : type === "camera_command"
      ? CameraCommandMessageSchema.parse(raw)
      : RtcSignalSchema.parse(raw);
  const allowed: Role[] = type === "camera_command" ? ["parent"] : type === "rtc_signal" ? ["parent", "camera"] : ["camera"];
  if (!allowed.includes(conn.role)) throw new RelayError("BAD_MESSAGE", `${type} may only be sent by role=${allowed.join("|")}`);
  if (msg.sessionId !== conn.sessionId) throw new RelayError("BAD_MESSAGE", "sessionId does not match this connection");

  const session = await ctx.store.getSession(conn.sessionId);
  if (!session) throw new RelayError("SESSION_NOT_FOUND", `session ${conn.sessionId} has expired`);

  // The SDP carries addresses, not media; it is left out of the log.
  if (msg.type !== "camera_status") {
    ctx.log?.({ evt: "relay", from: conn.role, msg: msg.type === "rtc_signal" ? { ...msg, sdp: msg.sdp ? `<${msg.sdp.length} chars>` : undefined } : msg });
  }

  if (conn.role === "camera") {
    if (session.cameraConnId !== connectionId) throw new RelayError("NOT_PAIRED", "this connection was replaced by a newer one for the session");
    await tellParents(ctx, session, msg);
    return;
  }
  if (!(session.parentConnIds ?? []).includes(connectionId)) throw new RelayError("NOT_PAIRED", "this parent connection is not registered for the session");
  if (!session.cameraConnId || !(await postOrClear(ctx, session.sessionId, "camera", session.cameraConnId, msg))) {
    await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "camera", connected: false });
  }
}

/**
 * Playlist between parent phones and the TV: `tv_playlist` / `tv_control` go from a parent to the TV,
 * `tv_now_playing` from the TV to every parent. Only lists and titles cross the relay; the TV fetches
 * the video files itself. The camera never sees any of it.
 */
async function relayPlayback(ctx: Ctx, connectionId: string, raw: unknown) {
  const conn = await ctx.store.getConnection(connectionId);
  if (!conn?.sessionId) throw new RelayError("NOT_PAIRED", "connection is not paired with a session");
  const type = (raw as { type: string }).type;
  const msg =
    type === "tv_playlist"
      ? TvPlaylistSchema.parse(raw)
      : type === "tv_control"
      ? TvControlSchema.parse(raw)
      : type === "tv_records_reset"
      ? TvRecordsResetSchema.parse(raw)
      : TvNowPlayingSchema.parse(raw);
  const expected: Role = msg.type === "tv_now_playing" ? "tv" : "parent";
  if (conn.role !== expected) throw new RelayError("BAD_MESSAGE", `${type} may only be sent by role=${expected}`);
  if (msg.sessionId !== conn.sessionId) throw new RelayError("BAD_MESSAGE", "sessionId does not match this connection");
  const session = await ctx.store.getSession(conn.sessionId);
  if (!session) throw new RelayError("SESSION_NOT_FOUND", `session ${conn.sessionId} has expired`);

  if (msg.type === "tv_now_playing") {
    if (session.tvConnId !== connectionId) throw new RelayError("NOT_PAIRED", "this connection was replaced by a newer one for the session");
    // Written only when it changed (the TV repeats it every 20 s).
    if (JSON.stringify(session.nowPlaying ?? null) !== JSON.stringify(msg)) await ctx.store.updateSession(session.sessionId, { nowPlaying: msg });
    await tellParents(ctx, session, msg);
    return;
  }
  if (!(session.parentConnIds ?? []).includes(connectionId)) throw new RelayError("NOT_PAIRED", "this parent connection is not registered for the session");
  ctx.log?.({ evt: "relay", from: "parent", msg: msg.type === "tv_playlist" ? { type: msg.type, id: msg.playlist.id, items: msg.playlist.items.length } : msg });
  if (!session.tvConnId || !(await postOrClear(ctx, session.sessionId, "tv", session.tvConnId, msg))) {
    await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "tv", connected: false });
  }
}

/** A parent phone saved (or cleared) the family's own list: keep it with the session, sync every parent. */
async function savePlaylist(ctx: Ctx, connectionId: string, raw: unknown) {
  const msg = PlaylistSaveSchema.parse(raw);
  const conn = await requireConnection(ctx, connectionId, "parent");
  if (!conn.sessionId || msg.sessionId !== conn.sessionId) throw new RelayError("BAD_MESSAGE", "sessionId does not match this connection");
  const session = await ctx.store.getSession(conn.sessionId);
  if (!session) throw new RelayError("SESSION_NOT_FOUND", `session ${conn.sessionId} has expired`);
  if (!(session.parentConnIds ?? []).includes(connectionId)) throw new RelayError("NOT_PAIRED", "this parent connection is not registered for the session");
  await ctx.store.updateSession(session.sessionId, { customPlaylist: msg.playlist });
  ctx.log?.({ evt: "playlist_save", sessionId: session.sessionId, items: msg.playlist?.items.length ?? 0 });
  await tellParents(ctx, session, { v: PROTOCOL_VERSION, type: "playlist_library", sessionId: session.sessionId, custom: msg.playlist });
}

/** A parent phone saved the TV intervention settings: keep it with the session, sync TV and every parent. */
async function saveTvSettings(ctx: Ctx, connectionId: string, raw: unknown) {
  const msg = TvSettingsSaveMessageSchema.parse(raw);
  const conn = await requireConnection(ctx, connectionId, "parent");
  if (!conn.sessionId || msg.sessionId !== conn.sessionId) throw new RelayError("BAD_MESSAGE", "sessionId does not match this connection");
  const session = await ctx.store.getSession(conn.sessionId);
  if (!session) throw new RelayError("SESSION_NOT_FOUND", `session ${conn.sessionId} has expired`);
  if (!(session.parentConnIds ?? []).includes(connectionId)) throw new RelayError("NOT_PAIRED", "this parent connection is not registered for the session");
  await ctx.store.updateSession(session.sessionId, { tvSettings: msg.settings });
  ctx.log?.({ evt: "tv_settings_save", sessionId: session.sessionId, settings: msg.settings });
  const outMsg: ServerMessage = { v: PROTOCOL_VERSION, type: "tv_settings", sessionId: session.sessionId, settings: msg.settings };
  if (session.tvConnId) {
    await postOrClear(ctx, session.sessionId, "tv", session.tvConnId, outMsg);
  }
  await tellParents(ctx, session, outMsg);
}

/** Posts to every connected parent phone of the session, dropping the ones that are gone. */
async function tellParents(ctx: Ctx, session: SessionRecord, msg: ServerMessage): Promise<void> {
  const ids = session.parentConnIds ?? [];
  let emptied = false;
  for (const p of ids) {
    const r = await ctx.pusher.post(p, msg);
    if (r === "gone") {
      await ctx.store.deleteConnection(p);
      const left = await ctx.store.removeParentConnection(session.sessionId, p);
      if (left && left.length === 0) emptied = true;
    }
  }
  if (emptied) await tellCameraParentPresence(ctx, session.sessionId, false);
}

async function tellCameraParentPresence(ctx: Ctx, sessionId: string, connected: boolean): Promise<void> {
  const session = await ctx.store.getSession(sessionId);
  if (session?.cameraConnId) {
    await postOrClear(ctx, sessionId, "camera", session.cameraConnId, { v: PROTOCOL_VERSION, type: "peer_status", peer: "parent", connected });
  }
}

async function relay(ctx: Ctx, connectionId: string, raw: unknown) {
  const conn = await ctx.store.getConnection(connectionId);
  if (!conn?.sessionId) {
    // Unpaired connections cannot inject telemetry (plan §4). Dropped, and the sender is told why.
    throw new RelayError("NOT_PAIRED", "connection is not paired with a session");
  }
  const type = (raw as { type: string }).type;
  const msg =
    type === "telemetry"
      ? TelemetrySchema.parse(raw)
      : type === "heartbeat"
      ? HeartbeatSchema.parse(raw)
      : type === "calibration_pattern"
      ? CalibrationPatternSchema.parse(raw)
      : type === "calibration_pattern_ack"
      ? CalibrationPatternAckSchema.parse(raw)
      : type === "camera_leaving"
      ? CameraLeavingSchema.parse(raw)
      : type === "rtt_ping"
      ? RttPingSchema.parse(raw)
      : type === "rtt_pong"
      ? RttPongSchema.parse(raw)
      : ViewingStateMessageSchema.parse(raw);

  const expectedRole: Role = type === "viewing_state" || type === "calibration_pattern_ack" || type === "rtt_ping" ? "tv" : "camera";
  if (conn.role === "parent") throw new RelayError("BAD_MESSAGE", `${type} may only be sent by role=${expectedRole}`);
  if (conn.role !== expectedRole) throw new RelayError("BAD_MESSAGE", `${type} may only be sent by role=${expectedRole}`);
  if (msg.sessionId !== conn.sessionId) throw new RelayError("BAD_MESSAGE", "sessionId does not match this connection");

  const session = await ctx.store.getSession(conn.sessionId);
  if (!session) throw new RelayError("SESSION_NOT_FOUND", `session ${conn.sessionId} has expired`);
  const ownConn = conn.role === "tv" ? session.tvConnId : session.cameraConnId;
  if (ownConn !== connectionId) throw new RelayError("NOT_PAIRED", "this connection was replaced by a newer one for the session");

  if (msg.type === "viewing_state") {
    await ctx.store.updateSession(session.sessionId, { playing: msg.playing });
    await tellParents(ctx, session, msg);
  }

  // Numeric JSON only — logged as evidence that no image data crosses the relay.
  ctx.log?.({ evt: "relay", from: conn.role, msg });

  const peerRole: "tv" | "camera" = conn.role === "tv" ? "camera" : "tv";
  const peerConn = peerRole === "tv" ? session.tvConnId : session.cameraConnId;
  if (!peerConn) {
    await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: peerRole, connected: false });
    return;
  }
  const delivered = await postOrClear(ctx, session.sessionId, peerRole, peerConn, msg);
  if (!delivered) {
    await ctx.pusher.post(connectionId, { v: PROTOCOL_VERSION, type: "peer_status", peer: peerRole, connected: false });
  }
}

/** Posts to a peer; on GoneException clears the stale connection id. Returns delivery success. */
async function postOrClear(ctx: Ctx, sessionId: string, role: "tv" | "camera", connId: string, msg: ServerMessage): Promise<boolean> {
  const r = await ctx.pusher.post(connId, msg);
  if (r === "gone") {
    await ctx.store.clearPeerConnection(sessionId, role, connId);
    await ctx.store.deleteConnection(connId);
    return false;
  }
  return true;
}
