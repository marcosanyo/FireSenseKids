/**
 * FireSense Kids — Wire protocol v1 (shared by camera phone, TV, and Lambda relay).
 *
 * Only numeric/categorical telemetry crosses the relay. No image data is ever part of
 * this protocol: the parent's live preview goes phone-to-phone over WebRTC on the home
 * network (no ICE servers), and only its connection offer/answer (SDP) passes the relay.
 *
 * The message reference is docs/PROTOCOL.md.
 */

import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const VIEWING_STATES = ["SAFE", "APPROACHING", "TOO_CLOSE", "BELOW_FRAME", "LOW_CONFIDENCE"] as const;
export type ViewingState = (typeof VIEWING_STATES)[number];

export const POSTURES = ["GOOD", "SLOUCH", "LYING_DOWN", "UNKNOWN"] as const;
export type PostureType = (typeof POSTURES)[number];

// POSTURE_NUDGE extends the v1 event set: posture is ambient-only and never blurs.
export const TELEMETRY_EVENTS = ["STAR_AWARDED", "PHASE1_RECOVERY", "WARN", "POSTURE_NUDGE"] as const;
export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number];

export const MAX_BLUR_PX = 24;

/**
 * Field-pilot mode, chosen on the phone (T2).
 * - intervene: normal FireSense (blur, mascot, voice, stars)
 * - shadow:    record only. The TV shows nothing that reacts to distance.
 * Required on every telemetry and heartbeat: a missing or unknown mode is rejected, never assumed.
 */
export const MODES = ["intervene", "shadow"] as const;
export type FireSenseMode = (typeof MODES)[number];

const v = z.literal(PROTOCOL_VERSION);
const id = z.string().min(8).max(128);

// ---------------------------------------------------------------------------
// Camera phone -> TV (relayed)
// ---------------------------------------------------------------------------
export const TelemetrySchema = z.object({
  v,
  type: z.literal("telemetry"),
  sessionId: id,
  seq: z.number().int().nonnegative(),
  sentAt: z.number(),
  state: z.enum(VIEWING_STATES),
  distanceM: z.number().nullable(),
  blurPx: z.number().min(0).max(MAX_BLUR_PX),
  posture: z.enum(POSTURES),
  confidence: z.number().min(0).max(1),
  event: z.enum(TELEMETRY_EVENTS).optional(),
  mode: z.enum(MODES),
  /**
   * Where on the floor the distance was measured (TV-marker calibration only; 0.1 m steps): metres along
   * the screen from its center (viewer's right +) and in front of it. For the floor heatmap (FLOOR_GRID).
   */
  floor: z.object({ lateralM: z.number().min(-10).max(10), frontM: z.number().min(0).max(10) }).optional(),
  /** Set by the phone's explicit test mode (synthetic input). The TV labels it and never records it. */
  test: z.literal(true).optional(),
});
export type Telemetry = z.infer<typeof TelemetrySchema>;

export const HeartbeatSchema = z.object({
  v,
  type: z.literal("heartbeat"),
  sessionId: id,
  sentAt: z.number(),
  fps: z.number().min(0).max(60),
  /** Also on the heartbeat, so a mode switch reaches the TV even while no telemetry is flowing. */
  mode: z.enum(MODES),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

/**
 * TV-marker calibration: the phone asks the TV to fill its screen with a flat color
 * ("magenta" = marker, "black" = reference frame for differencing, "off" = back to video).
 */
export const CALIBRATION_PATTERNS = ["magenta", "black", "off"] as const;
export const CalibrationPatternSchema = z.object({
  v,
  type: z.literal("calibration_pattern"),
  sessionId: id,
  pattern: z.enum(CALIBRATION_PATTERNS),
});
export type CalibrationPatternMessage = z.infer<typeof CalibrationPatternSchema>;

/**
 * The phone tells the TV why it is about to stop sending (sent from visibilitychange / pagehide).
 * - hidden:   the watch page went to the background (another app, the screen turned off)
 * - pagehide: the watch page is being closed or navigated away
 * Best effort: a phone that dies without sending it is still caught by the 3 s silence rule.
 */
export const CAMERA_LEAVING_REASONS = ["hidden", "pagehide"] as const;
export type CameraLeavingReason = (typeof CAMERA_LEAVING_REASONS)[number];
export const CameraLeavingSchema = z.object({
  v,
  type: z.literal("camera_leaving"),
  sessionId: id,
  reason: z.enum(CAMERA_LEAVING_REASONS),
});
export type CameraLeaving = z.infer<typeof CameraLeavingSchema>;

/** Reply to the TV's rtt_ping, sent immediately (MEASUREMENT_EVIDENCE §3). */
export const RttPongSchema = z.object({
  v,
  type: z.literal("rtt_pong"),
  sessionId: id,
  id: z.number().int().nonnegative(),
});
export type RttPong = z.infer<typeof RttPongSchema>;

// ---------------------------------------------------------------------------
// TV -> camera phone (relayed)
// ---------------------------------------------------------------------------
/**
 * Round-trip probe TV → relay → phone → relay → TV, timed on the TV's clock only
 * (MEASUREMENT_EVIDENCE §3). It does not include camera capture or pose detection.
 */
export const RttPingSchema = z.object({
  v,
  type: z.literal("rtt_ping"),
  sessionId: id,
  id: z.number().int().nonnegative(),
});
export type RttPing = z.infer<typeof RttPingSchema>;

/** The TV has painted the requested pattern (sent after two animation frames). */
export const CalibrationPatternAckSchema = z.object({
  v,
  type: z.literal("calibration_pattern_ack"),
  sessionId: id,
  pattern: z.enum(CALIBRATION_PATTERNS),
});
export type CalibrationPatternAck = z.infer<typeof CalibrationPatternAckSchema>;

export const ViewingStateMessageSchema = z.object({
  v,
  type: z.literal("viewing_state"),
  sessionId: id,
  playing: z.boolean(),
});
export type ViewingStateMessage = z.infer<typeof ViewingStateMessageSchema>;

// ---------------------------------------------------------------------------
// Parent phone <-> camera phone (relayed). The parent adjusts the installed camera
// without touching it: the camera reports its state, the parent sends commands.
// ---------------------------------------------------------------------------
const shortText = z.string().max(1000);
const meters = (lo: number, hi: number) => z.number().min(lo).max(hi);

export const CAMERA_SOURCES = ["user", "environment", "debug"] as const;
export type CameraSource = (typeof CAMERA_SOURCES)[number];

/** Distance thresholds and stand-calibration markers, in metres from the TV screen. */
export const CameraSettingsSchema = z.object({
  tooCloseM: meters(0.6, 2.5),
  safeM: meters(0.7, 3.5),
  markerAM: meters(0.5, 3.3),
  markerBM: meters(0.7, 3.5),
});
export type CameraSettings = z.infer<typeof CameraSettingsSchema>;

/** The camera's state, sent about once a second while a parent phone is connected. */
/** Correction of the TV-marker floor (floor-calibration.ts ZoneAdjust). */
export const ZoneAdjustSchema = z.object({
  dxM: z.number().min(-1.5).max(1.5),
  dzM: z.number().min(-1.5).max(1.5),
  angleDeg: z.number().min(-30).max(30),
  scale: z.number().min(0.5).max(2),
});

/** The watch camera's pose estimators (lib/client/pose-estimator.ts). */
export const POSE_MODEL_IDS = ["mediapipe-full", "rtmo-s", "rtmo-m", "rtmo-l"] as const;
export type PoseModelId = (typeof POSE_MODEL_IDS)[number];
/** GPU = MediaPipe GPU delegate / ONNX Runtime WebGPU; CPU = MediaPipe CPU / ONNX Runtime WASM. */
export const POSE_ACCELS = ["GPU", "CPU"] as const;

/** A box in the camera frame (normalized), x0 < x1, y0 < y1. */
export const ZoomAreaSchema = z
  .object({ x0: z.number().min(0).max(1), y0: z.number().min(0).max(1), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1) })
  .refine((a) => a.x1 - a.x0 >= 0.05 && a.y1 - a.y0 >= 0.05, "zoom area: at least 0.05 of the frame each way");

/** Where the person stands for a distance accuracy trial: in front of the TV, or 0.5 m to the side. */
export const TRIAL_LATERALS = ["center", "+0.5m"] as const;

export const CameraStatusSchema = z.object({
  v,
  type: z.literal("camera_status"),
  sessionId: id,
  sentAt: z.number(),
  /** null: no valid mode on the camera (it sends nothing to the TV until one is chosen). */
  mode: z.enum(MODES).nullable(),
  monitoring: z.boolean(),
  cameraOn: z.boolean(),
  source: z.enum(CAMERA_SOURCES),
  tvOnline: z.boolean(),
  playing: z.boolean(),
  blackout: z.boolean(),
  settings: CameraSettingsSchema,
  tvCalibration: z.object({
    inches: z.number().min(20).max(100),
    heightCm: z.number().min(10).max(200),
    /** Height of the screen's bottom edge (optional input; checks the TV size). */
    screenBottomCm: z.number().min(0).max(200).nullable().optional(),
  }),
  /** The camera's accelerometer for the TV-marker calibration (null = not asked yet). */
  motion: z.enum(["ok", "denied", "no-data", "unsupported"]).nullable().optional(),
  calibration: z
    .object({
      method: z.string().max(40),
      floorBottomY: z.number().min(0).max(1),
      /** Distance at which the feet leave the bottom of the frame (null if it cannot be computed). */
      edgeM: z.number().nullable(),
      /** Share of the too-close zone the camera sees (null if it cannot be computed). */
      tooCloseVisible: z.number().min(0).max(1).nullable(),
      /** The parent's correction of the TV-marker floor (null for other methods). */
      adjust: ZoneAdjustSchema.nullable().optional(),
      /** Real-distance points recorded for the current correction (0–2). */
      measuredPoints: z.number().int().min(0).max(2).optional(),
    })
    .nullable(),
  /** What the camera is doing right now (a calibration step), or null. */
  busy: shortText.nullable(),
  /** The last calibration result, as shown on the camera. */
  message: shortText.nullable(),
  /** Errors currently shown on the camera (model, camera, wake lock, TV marker, relay). */
  errors: z.array(shortText).max(8),
  live: z
    .object({
      state: z.enum(VIEWING_STATES),
      distanceM: z.number().nullable(),
      blurPx: z.number().min(0).max(MAX_BLUR_PX),
      posture: z.enum(POSTURES),
      fps: z.number().min(0).max(60),
      peopleCount: z.number().int().nonnegative(),
      /** Where the distance came from: the feet, or estimated from the hips (feet hidden). */
      distanceSource: z.enum(["feet", "hips", "seated"]).nullable().optional(),
    })
    .nullable(),
  /** The camera image is hidden: only the skeleton and lines are shown (and sent to the parent's preview). */
  skeletonOnly: z.boolean().optional(),
  /** The zoom pass: the area drawn by the parent (null = computed), and whether a zoom pass runs. */
  zoom: z.object({ area: ZoomAreaSchema.nullable(), active: z.boolean() }).optional(),
  /** Parent phones currently receiving the live preview. */
  previewPeers: z.number().int().nonnegative(),
  /** The distance accuracy recorder (MEASUREMENT_EVIDENCE §1): trials kept on the camera, and the one running. */
  distanceTrials: z
    .object({
      trials: z.number().int().nonnegative(),
      recording: z
        .object({ trial: z.number().int().positive(), trueM: z.number(), lateral: z.enum(TRIAL_LATERALS), waitS: z.number().int().min(0).max(60), leftS: z.number().int().min(0).max(60) })
        .nullable(),
    })
    .optional(),
  /** The pose estimator in use (null while none is loaded), and its recent inference time. */
  pose: z
    .object({ model: z.enum(POSE_MODEL_IDS), accel: z.enum(POSE_ACCELS), inferenceMs: z.number().min(0).max(60_000) })
    .nullable()
    .optional(),
});
export type CameraStatus = z.infer<typeof CameraStatusSchema>;

const point01 = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

export const CameraCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_mode"), mode: z.enum(MODES) }),
  z.object({ kind: z.literal("set_settings"), settings: CameraSettingsSchema.partial() }),
  z.object({ kind: z.literal("set_floor_bottom"), floorBottomY: z.number().min(0.5).max(1) }),
  z.object({ kind: z.literal("set_blackout"), on: z.boolean() }),
  /** Hide the camera image (watch camera screen and parent preview): only the skeleton, distance and lines on black. */
  z.object({ kind: z.literal("set_skeleton_only"), on: z.boolean() }),
  /** The area the zoom pass searches (drawn on the video); null = computed from the calibration. */
  z.object({ kind: z.literal("set_zoom_area"), area: ZoomAreaSchema.nullable() }),
  /** TV-marker calibration: the TV shows black then magenta; the camera finds the screen corners. */
  z.object({
    kind: z.literal("calibrate_tv"),
    inches: z.number().min(20).max(100),
    heightCm: z.number().min(10).max(200),
    screenBottomCm: z.number().min(0).max(200).nullable().optional(),
  }),
  /** Stand where a tape says `trueM` from the screen; 3 s of foot positions fit the correction (step 2 = second point). */
  z.object({ kind: z.literal("measure_distance"), trueM: z.number().min(0.2).max(3.5), step: z.union([z.literal(1), z.literal(2)]) }),
  /** Shift / turn / stretch the TV-marker floor by hand. */
  z.object({ kind: z.literal("set_zone_adjust"), adjust: ZoneAdjustSchema }),
  /** Stand-on-the-marker calibration, one step (A first, then B). */
  z.object({ kind: z.literal("calibrate_stand"), step: z.enum(["A", "B"]) }),
  /** Tap calibration: floor lines picked on a still of the preview, as raw (unmirrored) frame coordinates. */
  z.object({
    kind: z.literal("calibrate_tap"),
    lines: z.array(z.object({ distanceM: z.number().min(0.1).max(5), points: z.array(point01).max(20) })).length(3),
  }),
  /** Draw the zone and threshold lines into the preview (off while the parent picks tap points). */
  z.object({ kind: z.literal("preview_overlay"), on: z.boolean() }),
  /**
   * Distance accuracy trial (MEASUREMENT_EVIDENCE §1), started from the parent phone held on the floor mark: after
   * `delayS`, the camera records 10 s of distances; the reply is that trial's summary line. The frames stay on the camera.
   */
  z.object({ kind: z.literal("distance_trial"), trueM: z.number().min(0.3).max(5), lateral: z.enum(TRIAL_LATERALS), delayS: z.number().int().min(0).max(15) }),
  /** Delete the last distance accuracy trial on the camera. */
  z.object({ kind: z.literal("distance_trial_drop_last") }),
  /** Switch the pose estimator (the camera must already be watching: loading a model needs no tap). */
  z.object({ kind: z.literal("set_pose_model"), model: z.enum(POSE_MODEL_IDS), accel: z.enum(POSE_ACCELS) }),
]);
export type CameraCommand = z.infer<typeof CameraCommandSchema>;

export const CameraCommandMessageSchema = z.object({
  v,
  type: z.literal("camera_command"),
  sessionId: id,
  id: z.number().int().nonnegative(),
  command: CameraCommandSchema,
});
export type CameraCommandMessage = z.infer<typeof CameraCommandMessageSchema>;

/** The camera's answer to one command. `ok: false` carries the raw error text. */
export const CameraCommandResultSchema = z.object({
  v,
  type: z.literal("camera_command_result"),
  sessionId: id,
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  message: shortText,
});
export type CameraCommandResult = z.infer<typeof CameraCommandResultSchema>;

/**
 * WebRTC signaling for the parent's live preview (no trickle: complete SDP with host candidates).
 * The media itself never touches the relay or any server: both sides use no ICE servers, so the
 * only possible path is inside the home network. `peerId` is chosen by the parent page per preview.
 */
export const RtcSignalSchema = z.object({
  v,
  type: z.literal("rtc_signal"),
  sessionId: id,
  peerId: z.string().min(8).max(64),
  kind: z.enum(["offer", "answer", "hangup", "error"]),
  sdp: z.string().max(20000).optional(),
  message: shortText.optional(),
});
export type RtcSignal = z.infer<typeof RtcSignalSchema>;

// ---------------------------------------------------------------------------
// Session / pairing control (client -> server)
// ---------------------------------------------------------------------------
/** TV opens or resumes a session. Without credentials a new session is created. */
export const TvHelloSchema = z.object({
  v,
  type: z.literal("tv_hello"),
  sessionId: id.optional(),
  tvSecret: id.optional(),
});
export type TvHello = z.infer<typeof TvHelloSchema>;

/** TV requests re-pairing: the old cameraSecret is revoked and a fresh QR token issued. */
export const PairingResetSchema = z.object({
  v,
  type: z.literal("pairing_reset"),
});
export type PairingReset = z.infer<typeof PairingResetSchema>;

/** Camera joins a session with a one-time QR token, or resumes with its cameraSecret. */
export const CameraHelloSchema = z
  .object({
    v,
    type: z.literal("camera_hello"),
    sessionId: id,
    pairingToken: id.optional(),
    cameraSecret: id.optional(),
  })
  .refine((m) => Boolean(m.pairingToken) !== Boolean(m.cameraSecret), {
    message: "exactly one of pairingToken or cameraSecret is required",
  });
export type CameraHello = z.infer<typeof CameraHelloSchema>;

/** TV asks for a one-time QR token for a parent phone. `reset: true` first revokes every parent phone. */
export const ParentPairingRequestSchema = z.object({
  v,
  type: z.literal("parent_pairing_request"),
  reset: z.boolean().optional(),
});
export type ParentPairingRequest = z.infer<typeof ParentPairingRequestSchema>;

/** Parent phone joins with the one-time parent QR token, or resumes with its parentSecret. */
export const ParentHelloSchema = z
  .object({
    v,
    type: z.literal("parent_hello"),
    sessionId: id,
    pairingToken: id.optional(),
    parentSecret: id.optional(),
  })
  .refine((m) => Boolean(m.pairingToken) !== Boolean(m.parentSecret), {
    message: "exactly one of pairingToken or parentSecret is required",
  });
export type ParentHello = z.infer<typeof ParentHelloSchema>;

/** Most parent phones one session keeps. */
export const MAX_PARENTS = 4;

// ---------------------------------------------------------------------------
// Playlist (parent phone ↔ TV). The TV plays what the parent picked; the relay only carries the
// list and the TV's "now playing" back. Video files are fetched by the TV directly (never through
// the relay). URLs must be https (or a path of a video bundled in the TV app, "/videos/…").
// ---------------------------------------------------------------------------
const videoUrl = z
  .string()
  .max(2000)
  .refine((u) => /^https:\/\/[^\s]+$/.test(u) || /^\/videos\/[\w.-]+$/.test(u), { message: "video URL must be https:// (or a bundled /videos/… path)" });

export const PlaylistItemSchema = z.object({
  title: z.string().min(1).max(200),
  url: videoUrl,
  /** Attribution shown on the TV when the item starts (e.g. CC BY). */
  credit: z.string().max(300).optional(),
});
export type PlaylistItem = z.infer<typeof PlaylistItemSchema>;

export const PlaylistSchema = z.object({
  /** Preset id, or "custom". */
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  items: z.array(PlaylistItemSchema).min(1).max(50),
});
export type Playlist = z.infer<typeof PlaylistSchema>;

/** Parent → TV: play this list from the start. */
export const TvPlaylistSchema = z.object({ v, type: z.literal("tv_playlist"), sessionId: id, playlist: PlaylistSchema });
export type TvPlaylist = z.infer<typeof TvPlaylistSchema>;

export const TV_CONTROL_ACTIONS = ["next", "previous", "restart"] as const;
/** Parent → TV: skip within the list. */
export const TvControlSchema = z.object({ v, type: z.literal("tv_control"), sessionId: id, action: z.enum(TV_CONTROL_ACTIONS) });
export type TvControl = z.infer<typeof TvControlSchema>;

/**
 * Parent → TV: reset the records. The TV clears its own running counters for today, then deletes every stored
 * daily record (POST /session/summary/reset) and uploads today's empty record. Through the TV, so its next
 * upload cannot bring back what was deleted.
 */
export const TvRecordsResetSchema = z.object({ v, type: z.literal("tv_records_reset"), sessionId: id });
export type TvRecordsReset = z.infer<typeof TvRecordsResetSchema>;

/**
 * Parent → relay: save the family's own list (built item by item on a parent phone), or clear it
 * (null). The relay keeps it with the session in DynamoDB and sends `playlist_library` to every
 * parent phone, so all of them edit the same list.
 */
export const PlaylistSaveSchema = z.object({ v, type: z.literal("playlist_save"), sessionId: id, playlist: PlaylistSchema.nullable() });
export type PlaylistSave = z.infer<typeof PlaylistSaveSchema>;

/** Relay → parents: the saved list (on connect, and after every save). */
export const PlaylistLibrarySchema = z.object({ v, type: z.literal("playlist_library"), sessionId: id, custom: PlaylistSchema.nullable() });
export type PlaylistLibrary = z.infer<typeof PlaylistLibrarySchema>;

/** TV → parents: what is playing (on every change, on errors, and every 20 s). */
export const TvNowPlayingSchema = z.object({
  v,
  type: z.literal("tv_now_playing"),
  sessionId: id,
  playlistId: z.string().min(1).max(64),
  playlistTitle: z.string().min(1).max(200),
  index: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  title: z.string().min(1).max(200),
  /** Raw playback error of the current item, if any (the TV also shows it). */
  error: shortText.nullable(),
});
export type TvNowPlaying = z.infer<typeof TvNowPlayingSchema>;

// ---------------------------------------------------------------------------
// TV Settings (parent phone ↔ TV). Controls intervention cues, bottom marker,
// and the optional pause (off by default: the core response is the progressive blur and dimming;
// pausing is a stronger rule a parent can choose). Saved in DynamoDB with the session and synced across devices.
// ---------------------------------------------------------------------------
export const TvSettingsPauseSchema = z.object({
  enabled: z.boolean(),
  afterSeconds: z.number().int().min(10).max(60),
});

export const TvSettingsSchema = z.object({
  childCues: z.boolean(),
  marker: z.boolean(),
  pause: TvSettingsPauseSchema,
});
export type TvSettings = z.infer<typeof TvSettingsSchema>;

export const DEFAULT_TV_SETTINGS: TvSettings = Object.freeze({
  childCues: false,
  marker: true,
  pause: Object.freeze({ enabled: false, afterSeconds: 20 }),
});

/** Parent → relay: save the TV intervention settings. */
export const TvSettingsSaveMessageSchema = z.object({
  v,
  type: z.literal("tv_settings_save"),
  sessionId: id,
  settings: TvSettingsSchema,
});
export type TvSettingsSaveMessage = z.infer<typeof TvSettingsSaveMessageSchema>;

/** Relay → TV & parents: the current TV intervention settings. */
export const TvSettingsMessageSchema = z.object({
  v,
  type: z.literal("tv_settings"),
  sessionId: id,
  settings: TvSettingsSchema,
});
export type TvSettingsMessage = z.infer<typeof TvSettingsMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> clients
// ---------------------------------------------------------------------------
export const PeerStatusSchema = z.object({
  v,
  type: z.literal("peer_status"),
  /** "parent" is only sent to the camera and to parent phones (any parent phone connected). */
  peer: z.enum(["camera", "tv", "parent"]),
  connected: z.boolean(),
});
export type PeerStatus = z.infer<typeof PeerStatusSchema>;

export const SessionIssuedSchema = z.object({
  v,
  type: z.literal("session"),
  sessionId: id,
  /** Only present when the session is newly created; the TV must persist it. */
  tvSecret: id.optional(),
  pairingToken: id,
  pairingExpiresAt: z.number(),
  cameraPaired: z.boolean(),
});
export type SessionIssued = z.infer<typeof SessionIssuedSchema>;

export const PairedSchema = z.object({
  v,
  type: z.literal("paired"),
  sessionId: id,
  cameraSecret: id,
});
export type Paired = z.infer<typeof PairedSchema>;

/** Sent to the TV when a phone completes QR pairing (not on reconnects). */
export const CameraPairedSchema = z.object({
  v,
  type: z.literal("camera_paired"),
  sessionId: id,
});
export type CameraPaired = z.infer<typeof CameraPairedSchema>;

/** relay -> TV: a one-time token for the parent QR code. */
export const ParentPairingSchema = z.object({
  v,
  type: z.literal("parent_pairing"),
  sessionId: id,
  pairingToken: id,
  pairingExpiresAt: z.number(),
  parentCount: z.number().int().nonnegative(),
});
export type ParentPairing = z.infer<typeof ParentPairingSchema>;

/** relay -> TV: a parent phone completed QR pairing. */
export const ParentPairedNoticeSchema = z.object({
  v,
  type: z.literal("parent_joined"),
  sessionId: id,
  parentCount: z.number().int().nonnegative(),
});
export type ParentPairedNotice = z.infer<typeof ParentPairedNoticeSchema>;

/** relay -> parent phone: pairing accepted (QR) or resumed; the phone stores `parentSecret`. */
export const ParentPairedSchema = z.object({
  v,
  type: z.literal("parent_paired"),
  sessionId: id,
  parentSecret: id,
});
export type ParentPaired = z.infer<typeof ParentPairedSchema>;

/** Sent to a camera or parent phone whose pairing was revoked by the TV. */
export const UnpairedSchema = z.object({
  v,
  type: z.literal("unpaired"),
  sessionId: id,
});
export type Unpaired = z.infer<typeof UnpairedSchema>;

export const ERROR_CODES = [
  "BAD_MESSAGE",
  "SESSION_NOT_FOUND",
  "BAD_CREDENTIALS",
  "TOKEN_EXPIRED",
  "TOKEN_USED",
  "NOT_PAIRED",
  "PARENT_LIMIT",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ServerErrorSchema = z.object({
  v,
  type: z.literal("error"),
  code: z.enum(ERROR_CODES),
  message: z.string(),
});
export type ServerError = z.infer<typeof ServerErrorSchema>;

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------
export const ClientMessageSchema = z.union([
  TelemetrySchema,
  HeartbeatSchema,
  ViewingStateMessageSchema,
  CalibrationPatternSchema,
  CalibrationPatternAckSchema,
  CameraLeavingSchema,
  RttPingSchema,
  RttPongSchema,
  CameraStatusSchema,
  CameraCommandMessageSchema,
  CameraCommandResultSchema,
  RtcSignalSchema,
  TvHelloSchema,
  PairingResetSchema,
  CameraHelloSchema,
  ParentPairingRequestSchema,
  ParentHelloSchema,
  TvPlaylistSchema,
  TvControlSchema,
  TvRecordsResetSchema,
  TvNowPlayingSchema,
  PlaylistSaveSchema,
  TvSettingsSaveMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerMessageSchema = z.union([
  TelemetrySchema,
  HeartbeatSchema,
  ViewingStateMessageSchema,
  CalibrationPatternSchema,
  CalibrationPatternAckSchema,
  CameraLeavingSchema,
  RttPingSchema,
  RttPongSchema,
  CameraStatusSchema,
  CameraCommandMessageSchema,
  CameraCommandResultSchema,
  RtcSignalSchema,
  PeerStatusSchema,
  SessionIssuedSchema,
  PairedSchema,
  CameraPairedSchema,
  ParentPairingSchema,
  ParentPairedNoticeSchema,
  ParentPairedSchema,
  UnpairedSchema,
  ServerErrorSchema,
  TvPlaylistSchema,
  TvControlSchema,
  TvRecordsResetSchema,
  TvNowPlayingSchema,
  PlaylistLibrarySchema,
  TvSettingsMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// Insight plane (HTTP API)
// ---------------------------------------------------------------------------
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Recovery durations kept per mode per day; beyond this the list stops and `recoveryTruncated` is set. */
export const MAX_RECOVERY_SAMPLES = 200;

/**
 * Floor heatmap grid (seconds of playback per 0.25 m cell, in front of the TV): columns from
 * lateral −2.0 m to +2.0 m (viewer's right +), rows from the screen plane to 3.0 m in front of it.
 * Cell index = row * cols + col. Positions outside the grid are not counted.
 */
export const FLOOR_GRID = { cellM: 0.25, lateralMinM: -2, cols: 16, rows: 12 } as const;
export const FLOOR_GRID_CELLS = FLOOR_GRID.cols * FLOOR_GRID.rows;

/** Per-mode field-pilot metrics, counted on the TV (T2). Test-mode telemetry is never counted. */
export const ModeStatsSchema = z.object({
  viewingSeconds: z.number().nonnegative(), // playing, with a known mode
  warnSeconds: z.number().nonnegative(), // playing AND connected AND state TOO_CLOSE / BELOW_FRAME
  approachCount: z.number().int().nonnegative(), // WARN events
  recoverySeconds: z.array(z.number().nonnegative()).max(MAX_RECOVERY_SAMPLES), // WARN → next SAFE, one per WARN
  recoveryTruncated: z.boolean(),
  /** Floor heatmap (FLOOR_GRID). Absent in records from before it existed (2026-09-27). */
  floorSeconds: z.array(z.number().int().nonnegative()).length(FLOOR_GRID_CELLS).optional(),
});
export type ModeStats = z.infer<typeof ModeStatsSchema>;

export const ModesStatsSchema = z.object({ intervene: ModeStatsSchema, shadow: ModeStatsSchema });
export type ModesStats = z.infer<typeof ModesStatsSchema>;

/** Fields present since the first version (totals over both modes; stars only in intervene). */
const DailySummaryBase = z.object({
  date: dateString,
  approachCount: z.number().int().nonnegative(), // WARN events (entered TOO_CLOSE / BELOW_FRAME)
  selfRecoveryCount: z.number().int().nonnegative(), // PHASE1_RECOVERY events
  starCount: z.number().int().nonnegative(), // STAR_AWARDED events (intervene only: shadow awards nothing)
  disconnectCount: z.number().int().nonnegative(),
  disconnectSeconds: z.number().nonnegative(),
  viewingSeconds: z.number().nonnegative(),
});

/** What the TV sends (POST /session/summary). `modes` is required. */
export const DailySummarySchema = DailySummaryBase.extend({ modes: ModesStatsSchema });
export type DailySummary = z.infer<typeof DailySummarySchema>;

export const PostSummaryRequestSchema = DailySummarySchema;

/** Parent's "I said 'step back'" counter (POST /session/reminder), stored per mode. */
export const ParentRemindersSchema = z.object({
  intervene: z.number().int().nonnegative(),
  shadow: z.number().int().nonnegative(),
});
export type ParentReminders = z.infer<typeof ParentRemindersSchema>;

export const ReminderRequestSchema = z.object({
  date: dateString,
  mode: z.enum(MODES),
  delta: z.union([z.literal(1), z.literal(-1)]),
});
export type ReminderRequest = z.infer<typeof ReminderRequestSchema>;

/**
 * One day as read back (GET /session/summary). Nothing missing is filled with 0:
 * - summary: null when the TV has not sent anything for that day
 * - summary.modes: null for records written before per-mode metrics existed
 * - parentReminders: null for records written before the reminder button existed
 */
export const DayRecordSchema = z.object({
  date: dateString,
  summary: DailySummaryBase.extend({ modes: ModesStatsSchema.nullable() }).nullable(),
  parentReminders: ParentRemindersSchema.nullable(),
});
export type DayRecord = z.infer<typeof DayRecordSchema>;

export const WeeklyReportSchema = z.object({
  parentReflection: z.string(),
  highlights: z.array(z.string()).max(5),
  mascotLines: z.object({
    approaching: z.string(),
    tooClose: z.string(),
    praise: z.string(),
  }),
});
export type WeeklyReport = z.infer<typeof WeeklyReportSchema>;

/** Evidence of a real Bedrock call, surfaced in API responses and CloudWatch. */
export const BedrockTraceSchema = z.object({
  modelId: z.string(),
  requestId: z.string(),
  latencyMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type BedrockTrace = z.infer<typeof BedrockTraceSchema>;

/** Parses an inbound JSON string; throws a ZodError / SyntaxError on invalid input. */
export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessageSchema.parse(JSON.parse(raw));
}

export function parseServerMessage(raw: string): ServerMessage {
  return ServerMessageSchema.parse(JSON.parse(raw));
}
