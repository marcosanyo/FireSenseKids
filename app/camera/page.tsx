"use client";

/**
 * /camera — the watch phone on the TV stand (served over HTTPS from CloudFront).
 *
 * On-device only: MediaPipe runs here, frames are never stored or sent to any server.
 * Network output: numeric telemetry (protocol v1) to the AWS WebSocket relay, the camera's
 * state for parent phones (camera_status), and — only while a parent phone asks for it —
 * a live preview sent phone-to-phone over WebRTC inside the home network (no ICE servers,
 * so the video cannot take a path through the cloud).
 *
 * Once installed, the camera is meant to be left alone: a parent phone can change the mode,
 * thresholds and calibration (camera_command), and the screen can be blacked out while
 * sensing continues.
 */

import { LangSwitch } from "@/components/lang";
import { L } from "@/lib/firesense/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  edgeDistanceFor,
  fitFloorHomography,
  isHomography,
  isoDistanceY,
  extractGroundContactPoint,
  modelFromCameraGeometry,
  ViewingStateMachine,
  type FrameOutput,
  fitFloorCalibration,
  MAX_ACCEPTABLE_EDGE_DISTANCE_M,
  BELOW_FRAME_MARGIN_Y,
  PROTOCOL_VERSION,
  selectNearestPerson,
  SensorPipeline,
  WebSocketTransport,
  type CameraCommand,
  type CameraCommandMessage,
  type CameraStatus,
  type ClientMessage,
  type FireSenseMode,
  type RtcSignal,
  type FloorModel,
  type FloorPosition,
  type ZoneAdjust,
  fitAdjustToMeasurements,
  imageToFloorRaw,
  NO_ADJUST,
  ZoneAdjustSchema,
  type CoverageReport,
  distanceForFoot,
  type FloorLineSample,
  type FloorSample,
  type LandmarkPoint,
  type PipelineFrame,
  type ServerMessage,
  detectScreenQuad,
  magentaMask,
  computeCoverage,
  projectFloorPoint,
  ZONE_NEAR_M,
  screenDistance,
  screenDistanceContour,
  modelFromTvScreen,
  screenSizeFromInches,
  computeZoomRoi,
  manualZoomRoi,
  wholeInCrop,
  type ZoomArea,
  plausiblePerson,
  ZoomScheduler,
  rehelloAllowed,
  mergePeople,
  roiToFrame,
  type ZoomRoi,
  type RgbaImage,
} from "@/lib/firesense";
import type { Delegate } from "@/lib/firesense/mediapipe";
import {
  createPoseEstimator,
  loadPoseModelChoice,
  POSE_MODEL_INFO,
  savePoseModelChoice,
  type PoseEstimator,
  type PoseModelId,
} from "@/lib/client/pose-estimator";
import { WS_URL } from "@/lib/client/config";
import { DEFAULT_MIN_TORSO_FRACTION } from "@/lib/firesense/person-filter";
import { RTMO_MIN_TORSO_FRACTION } from "@/lib/firesense/rtmo";
import { iceGatheringComplete, RTC_CONFIG } from "@/lib/client/rtc";
import { KEYS } from "@/lib/client/storage";
import { loadMode, MODE_LABEL, saveMode } from "@/lib/client/mode";
import { Camera, CheckCircle2, FlaskConical, Link2, Moon, Ruler, ShieldCheck, Tv, Wifi, WifiOff } from "lucide-react";
import { WhoWatches } from "@/components/who-watches";
import { Banner, Pill, Stat } from "@/components/ui";
import { DistanceTrialPanel, useDistanceTrials } from "@/components/distance-trial";
import { ZoneAdjustPanel } from "@/components/zone-adjust";
import { TouchSlider } from "@/components/touch-slider";
import { STATE_LABEL } from "@/lib/client/labels";
import { angleBetweenDeg, measureGravity, MOTION_STATE_LABEL, requestMotion, upInCamera, watchGravity, type MotionState, type Vec3 } from "@/lib/client/gravity";

type CameraSession = { sessionId: string; cameraSecret: string };
type LinkState = "idle" | "connecting" | "open" | "closed";
type CalibStep = "A" | "B" | null;
/** user = front (selfie) camera, environment = back camera, debug = fixed images run through MediaPipe. */
type Source = "user" | "environment" | "debug";

/** Two debug "rooms": the phone in front of the TV, and the phone beside the TV. Each has its own calibration. */
const DEBUG_IMAGES = [
  { id: "room-empty", get label() { return L("Empty room", "無人"); }, scene: "front" },
  { id: "pose-a-near", get label() { return L("A: standing at 1.2 m", "A 1.2m に立つ"); }, scene: "front" },
  { id: "pose-b-far", get label() { return L("B: standing at 1.8 m", "B 1.8m に立つ"); }, scene: "front" },
  { id: "pose-too-close", get label() { return L("Too close (feet cut off)", "近すぎ（足が切れる）"); }, scene: "front" },
  { id: "tv-black", get label() { return L("TV marker: black screen", "TVマーカー: 画面黒"); }, scene: "tv" },
  { id: "tv-magenta", get label() { return L("TV marker: magenta screen", "TVマーカー: 画面マゼンタ"); }, scene: "tv" },
  { id: "tv-person-near", get label() { return L("TV marker: person (near)", "TVマーカー: 人（近い）"); }, scene: "tv" },
  { id: "tv-person-far", get label() { return L("TV marker: person (far)", "TVマーカー: 人（遠い）"); }, scene: "tv" },
  { id: "tv-sit-upright", get label() { return L("Posture: sitting up", "姿勢: 座って背筋ピン"); }, scene: "tv" },
  { id: "tv-sit-slouch", get label() { return L("Posture: sitting, slouching", "姿勢: 座って猫背"); }, scene: "tv" },
  { id: "tv-lying", get label() { return L("Posture: lying down", "姿勢: 寝そべり"); }, scene: "tv" },
] as const;
type DebugImageId = (typeof DEBUG_IMAGES)[number]["id"];
type DebugScene = "front" | "tv";
const sceneOf = (id: DebugImageId): DebugScene => DEBUG_IMAGES.find((d) => d.id === id)?.scene ?? "front";
const SOURCE_KEY = "firesense.camera.source";
/** Calibration is kept per lens, and per debug scene (front / side are different "cameras"). */
const calibKey = (src: Source, img: DebugImageId) => (src === "debug" ? `debug-${sceneOf(img)}` : src);
const modelKey = (key: string) => `${KEYS.floorModel}:${key}`;
/**
 * TV-marker debug scene: generated as a 55-inch TV. The image generator placed the viewpoint higher
 * than asked (~1.25 m: with that height the screen bottom comes out at a realistic ~43 cm).
 */
const TV_DEBUG = { inches: 55, heightCm: 125 };
/** Analysis resolution for screen detection (long side, px). */
const TV_MARKER_ANALYSIS_PX = 640;

const POSE_CONNECTIONS: [number, number][] = [
  [11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30],
  // Face (nose, eyes, ears, mouth): drawn so the parent can see whether the model really found a person.
  [0, 2], [2, 7], [0, 5], [5, 8], [9, 10],
];
/** Face points drawn as dots (nose, eyes, ears, mouth); MediaPipe has all, RTMO nose/eyes/ears. */
const FACE_POINTS = [0, 2, 5, 7, 8, 9, 10];
const CALIBRATION_MS = 3000;
const CALIBRATION_INTERVAL_MS = 125;
/** The debug images were generated with tape marks at these distances. */
const DEBUG_MARKERS = { A: 1.2, B: 1.8 };

type Settings = { tooCloseM: number; safeM: number; markerAM: number; markerBM: number };
const DEFAULT_SETTINGS: Settings = { tooCloseM: 1.3, safeM: 1.65, markerAM: 1.2, markerBM: 1.8 };
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Keeps the sliders consistent: SAFE ≥ TOO_CLOSE + 0.1m, marker B ≥ A + 0.2m, all within range. */
function normalizeSettings(s: Settings, changed?: keyof Settings): Settings {
  const clamp = (v: number, lo: number, hi: number) => r2(Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo)));
  let tooCloseM = clamp(s.tooCloseM, 0.6, 2.5);
  let safeM = clamp(s.safeM, 0.7, 3.5);
  if (safeM < tooCloseM + 0.1) {
    if (changed === "safeM") tooCloseM = r2(safeM - 0.1);
    else safeM = r2(tooCloseM + 0.1);
  }
  let markerAM = clamp(s.markerAM, 0.5, 3.3);
  let markerBM = clamp(s.markerBM, 0.7, 3.5);
  if (markerBM < markerAM + 0.2) {
    if (changed === "markerBM") markerAM = r2(markerBM - 0.2);
    else markerBM = r2(markerAM + 0.2);
  }
  return { tooCloseM, safeM, markerAM, markerBM };
}
const SETTINGS_KEY = "firesense.camera.settings";
const PREFS_KEY = "firesense.camera.prefs";
type Prefs = { debugImage: DebugImageId; tvInches: number; geo: { heightCm: number; pitchDownDeg: number; vfovDeg: number }; screenBottomCm?: number | null; zoomArea?: ZoomArea | null; skeletonOnly?: boolean };
const LINE_COLORS = ["#38bdf8", "#f472b6", "#a3e635"];
/** Parent phones that may watch the live preview at the same time. */
const MAX_PREVIEW_PEERS = 2;
const PREVIEW_WIDTH = 640;
const METHOD_LABEL = (m: FloorModel): string =>
  isHomography(m) && m.method === "tv_marker" ? "tv_marker" : isHomography(m) ? "tap" : m.method === "geometry" ? "geometry" : "stand";
type StepResult = { ok: boolean; message: string };
type DrawInfo = {
  nearest: number;
  /** Per person: counted as a person (undefined while calibrating: everyone is drawn normally). */
  accepted?: boolean[];
  distanceM: number | null;
  distancePoint: { x: number; y: number } | null;
  distanceSource: PipelineFrame["distanceSource"];
  /** The zoomed crop around the watch zone, when the second pass ran (zoom-roi.ts). */
  roi?: ZoomRoi | null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (v: number) => Math.round(v * 10) / 10;
const steps = () => [L("Pair with the TV", "テレビとつなぐ"), L("Start watching", "見守りを開始"), L("Calibrate", "位置を測る"), L("Watching", "見守り中")];

/** Tilt change since the calibration that counts as "the phone was moved" (degrees). */
const MOVED_TILT_DEG = 3;

const readJson = <T,>(key: string): T | null => {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as T) : null;
};

export default function CameraPage() {
  // ---- pairing / relay --------------------------------------------------------
  const [session, setSession] = useState<CameraSession | null>(null);
  const [pendingToken, setPendingToken] = useState<{ sessionId: string; token: string } | null>(null);
  // The watch camera's QR read by a phone that is already this TV's parent phone: ask before pairing.
  const [roleConflict, setRoleConflict] = useState<{ sessionId: string; token: string } | null>(null);
  const [link, setLink] = useState<LinkState>("idle");
  const [tvOnline, setTvOnline] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const transportRef = useRef<WebSocketTransport | null>(null);
  const sessionRef = useRef<CameraSession | null>(null);
  const tokenRef = useRef<{ sessionId: string; token: string } | null>(null);
  const tvOnlineRef = useRef(false);
  const playingRef = useRef(false);
  const seqRef = useRef(Date.now());
  // Field-pilot mode (T2): chosen here, saved on this phone, sent with every telemetry/heartbeat.
  const [mode, setModeState] = useState<FireSenseMode | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const modeRef = useRef<FireSenseMode | null>(null);

  // ---- sensing ----------------------------------------------------------------
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [source, setSource] = useState<Source>("user");
  const sourceRef = useRef<Source>("user");
  const [debugImage, setDebugImage] = useState<DebugImageId>("pose-a-near");
  const calibKeyRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The pose estimator (MediaPipe or RTMO, lib/client/pose-estimator.ts). MediaPipe also runs a second
  // instance on the zoomed crop around the watch zone (small or seated people far from the phone).
  const estimatorRef = useRef<PoseEstimator | null>(null);
  /** The inference running right now: a model is released only after it settles (WebGPU buffers). */
  const inflightRef = useRef<Promise<unknown> | null>(null);
  /** Shown inference time, refreshed about once a second (the ref changes every frame). */
  const [inferenceMsShown, setInferenceMsShown] = useState(0);
  const inferenceShownAtRef = useRef(0);
  const lastRehelloRef = useRef(0);
  const zoomCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomRoiRef = useRef<{ key: FloorModel | ZoomArea | null; safeM: number; roi: ZoomRoi | null }>({ key: null, safeM: 0, roi: null });
  // The area the parent drew on the video for the zoom pass (null = computed from the TV-marker calibration).
  const [zoomArea, setZoomArea] = useState<ZoomArea | null>(null);
  // Skeleton only: the camera image is not shown nor sent to the parent's preview (filming a child without their image).
  // Calibration and thresholds fold once calibrated (set once, then left alone; a touch on a slider would move them).
  const [calEditing, setCalEditing] = useState<boolean | null>(null);
  const [skeletonOnly, setSkeletonOnly] = useState(false);
  const skeletonOnlyRef = useRef(false);
  skeletonOnlyRef.current = skeletonOnly;
  // Bumped when the camera must be started again: back from the background, or the browser ended the track.
  const [resumeGen, setResumeGen] = useState(0);
  const streamStartedAtRef = useRef(0);
  const zoomAreaRef = useRef<ZoomArea | null>(null);
  zoomAreaRef.current = zoomArea;
  const zoomSchedRef = useRef(new ZoomScheduler());
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pose inference time (ms, smoothed) and the achieved inference rate (fps, smoothed). */
  const inferenceMsRef = useRef(0);
  const effectiveFpsRef = useRef(0);
  const lastTickAtRef = useRef(0);
  const pipelineRef = useRef(new SensorPipeline());
  const [monitoring, setMonitoring] = useState(false);
  const monitoringRef = useRef(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [poseInfo, setPoseInfo] = useState<{ model: PoseModelId; accel: Delegate } | null>(null);
  // A saved choice that is not a known model is shown as an error (MediaPipe is preselected; nothing loads
  // until the user starts watching or picks a model).
  const [initialPose] = useState<{ id: PoseModelId; error: string | null }>(() => {
    try {
      return { id: loadPoseModelChoice(), error: null };
    } catch (err) {
      return { id: "mediapipe-full", error: (err as Error).message };
    }
  });
  const [poseChoiceError, setPoseChoiceError] = useState<string | null>(initialPose.error);
  const [poseModel, setPoseModel] = useState<PoseModelId>(initialPose.id);
  const [modelLoading, setModelLoading] = useState<string | null>(null);
  // For trying a pose model at a desk: keep the camera on although the TV is not playing.
  const [keepCamera, setKeepCamera] = useState(false);
  // WebGPU / GPU (default) or WASM / CPU for the next model load; chosen explicitly, never switched by itself.
  const [accelChoice, setAccelChoice] = useState<Delegate>("GPU");
  const [poseDiag, setPoseDiag] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [wakeLockError, setWakeLockError] = useState<string | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const [frame, setFrame] = useState<PipelineFrame | null>(null);
  /** Events last only one frame; keep the latest one visible for debugging (e.g. POSTURE_NUDGE). */
  const [lastEvent, setLastEvent] = useState<{ event: string; at: number } | null>(null);

  // ---- calibration ------------------------------------------------------------
  const [floorModel, setFloorModel] = useState<FloorModel | null>(null);
  const [calibStep, setCalibStep] = useState<CalibStep>(null);
  const calibStepRef = useRef<CalibStep>(null);
  const samplesRef = useRef<{ A: FloorSample[]; B: FloorSample[] }>({ A: [], B: [] });
  const [calibMessage, setCalibMessage] = useState<string | null>(null);

  const [secureContext, setSecureContext] = useState(true);

  // ---- manual (geometry) calibration ------------------------------------------
  const [geo, setGeo] = useState({ heightCm: 55, pitchDownDeg: 15, vfovDeg: 60 });
  const [geoConfirmed, setGeoConfirmed] = useState(false);
  const [tiltMessage, setTiltMessage] = useState<string | null>(null);

  // ---- thresholds (user adjustable, persisted) ---------------------------------
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const updateSetting = (key: keyof Settings, v: number) => setSettings((s) => normalizeSettings({ ...s, [key]: v }, key));

  // ---- TV-marker calibration (the TV shows magenta/black; no tape) ------------------
  const [tvInches, setTvInches] = useState(55);
  /** Screen bottom above the floor (cm), optional: checks the TV size (modelFromTvScreen). */
  const [screenBottomCm, setScreenBottomCm] = useState<number | null>(null);
  /** Real-distance points of the current correction (raw floor position + tape distance). */
  const measuredRef = useRef<{ raw: FloorPosition; trueM: number }[]>([]);
  const [measuredCount, setMeasuredCount] = useState(0);
  const measureSamplesRef = useRef<FloorPosition[] | null>(null);
  const [measureBusy, setMeasureBusy] = useState<string | null>(null);
  /** The accelerometer for the calibration (null until asked, at "Start watching"). */
  const [motion, setMotion] = useState<MotionState | null>(null);
  /** The phone was moved / turned since the calibration (distances are then wrong): what changed, or null. */
  const [moved, setMoved] = useState<string | null>(null);
  const movedRef = useRef<string | null>(null);
  movedRef.current = moved;
  const movedSinceRef = useRef<{ at: number; why: string } | null>(null);
  const [tvBusy, setTvBusy] = useState<string | null>(null);
  const [tvError, setTvError] = useState<string | null>(null);
  const [tvPreview, setTvPreview] = useState<string | null>(null);
  const [tvReport, setTvReport] = useState<string | null>(null);
  const ackRef = useRef<{ pattern: string; resolve: () => void } | null>(null);

  // ---- tap calibration (any placement, incl. beside the TV) ---------------------
  const [frozen, setFrozen] = useState<string | null>(null);
  const [tapLines, setTapLines] = useState<FloorLineSample[]>([
    { distanceM: 0.8, points: [] },
    { distanceM: 1.2, points: [] },
    { distanceM: 1.8, points: [] },
  ]);
  const [activeLine, setActiveLine] = useState(0);

  // ---- test mode (explicit synthetic input; labeled on the TV, never recorded) -
  const [testMode, setTestMode] = useState(false);
  const testModeRef = useRef(false);
  const [testInput, setTestInput] = useState<{ kind: "distance" | "below" | "lost"; d: number; slouch?: boolean }>({ kind: "distance", d: 2.0 });
  const testInputRef = useRef(testInput);
  testInputRef.current = testInput;
  const [testFrame, setTestFrame] = useState<FrameOutput | null>(null);

  // ---- parent phones: state reports, remote commands, live preview (WebRTC, LAN only) ----
  const [parentOnline, setParentOnline] = useState(false);
  const parentOnlineRef = useRef(false);
  const [blackout, setBlackout] = useState(false);
  const blackoutRef = useRef(false);
  blackoutRef.current = blackout;
  const rtcPeersRef = useRef(new Map<string, RTCPeerConnection>());
  const [previewCount, setPreviewCount] = useState(0);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const previewOverlayRef = useRef(true);
  const commandRef = useRef<(c: CameraCommand) => Promise<string>>(async () => {
    throw new Error("not ready");
  });
  const rtcRef = useRef<(m: RtcSignal) => Promise<void>>(async () => {});
  const statusRef = useRef<Omit<CameraStatus, "sentAt"> | null>(null);

  // --------------------------------------------------------------------------
  // Init: QR params (?s=&t=) or stored pairing; stored floor model
  // --------------------------------------------------------------------------
  useEffect(() => {
    setSecureContext(window.isSecureContext);
    const q = new URLSearchParams(window.location.search);
    const s = q.get("s");
    const t = q.get("t");
    if (s && t && readJson<{ sessionId: string }>(KEYS.parentSession)?.sessionId === s) {
      setRoleConflict({ sessionId: s, token: t });
    } else if (s && t) {
      tokenRef.current = { sessionId: s, token: t };
      setPendingToken(tokenRef.current);
    }
    const stored = readJson<CameraSession>(KEYS.cameraSession);
    if (stored && !(s && t && stored.sessionId !== s)) {
      sessionRef.current = stored;
      setSession(stored);
    }
    const storedSettings = readJson<Settings>(SETTINGS_KEY);
    if (storedSettings) setSettings(normalizeSettings({ ...DEFAULT_SETTINGS, ...storedSettings }));
    // Rear camera by default: in the field (2026-09-27) a tablet's wide front camera found small children
    // far less often than a phone's rear camera.
    const src = (window.localStorage.getItem(SOURCE_KEY) as Source | null) ?? "environment";
    sourceRef.current = src;
    setSource(src);
    const prefs = readJson<Prefs>(PREFS_KEY);
    if (prefs?.debugImage && DEBUG_IMAGES.some((d) => d.id === prefs.debugImage)) setDebugImage(prefs.debugImage);
    if (prefs?.tvInches) setTvInches(prefs.tvInches);
    if (prefs && prefs.screenBottomCm !== undefined) setScreenBottomCm(prefs.screenBottomCm);
    if (prefs?.geo) setGeo(prefs.geo);
    if (prefs?.zoomArea) setZoomArea(prefs.zoomArea);
    if (prefs?.skeletonOnly) setSkeletonOnly(true);
    prefsLoadedRef.current = true;
  }, []);

  // Persist the per-phone setup choices (which debug scene, TV size, phone height/tilt/FOV).
  const prefsLoadedRef = useRef(false);
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    const prefs: Prefs = { debugImage, tvInches, geo, screenBottomCm, zoomArea, skeletonOnly };
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [debugImage, tvInches, geo, screenBottomCm, zoomArea, skeletonOnly]);

  // Load the calibration of the current lens / debug scene whenever it changes.
  useEffect(() => {
    const key = calibKey(source, debugImage);
    if (key === calibKeyRef.current) return;
    const first = calibKeyRef.current === null;
    calibKeyRef.current = key;
    const model = readJson<FloorModel>(modelKey(key)) ?? (key === "user" ? readJson<FloorModel>(KEYS.floorModel) : null);
    if (model) {
      setFloorModel(model);
      pipelineRef.current.setCalibration(model);
      if (!first) setCalibMessage(null);
    } else {
      setFloorModel(null);
      pipelineRef.current.clearCalibration();
      setFrame(null);
      if (!first) setCalibMessage(L("Switched the input. This input is not calibrated yet.", "入力を切り替えました。この入力ではまだキャリブレーションしていません。"));
    }
  }, [source, debugImage]);

  // Apply + persist thresholds (TOO_CLOSE / SAFE drive the state machine, blur ramp and fast-fps range).
  useEffect(() => {
    try {
      pipelineRef.current.setThresholds(settings.tooCloseM, settings.safeM);
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      setSettingsError(null);
    } catch (err) {
      setSettingsError((err as Error).message);
    }
  }, [settings]);

  /** Persists the floor model for the current lens / debug scene and applies it. */
  const saveModel = useCallback((model: FloorModel) => {
    window.localStorage.setItem(modelKey(calibKeyRef.current ?? sourceRef.current), JSON.stringify(model));
    // The first calibration on this page: keep the section open (the thresholds come next) until "Done".
    if (!floorModelRef.current) setCalEditing((e) => (e === null ? true : e));
    setFloorModel(model);
    pipelineRef.current.setCalibration(model);
  }, []);

  /**
   * The TV-marker calibration holds only while the phone stays exactly where it was: a turned screen
   * (portrait ↔ landscape) or a tilt of more than MOVED_TILT_DEG for 2 s makes every distance wrong.
   * Then nothing is sent to the TV until the parent recalibrates or confirms the new position.
   */
  const reportMoved = useCallback((why: string | null) => {
    if (why === null) {
      movedSinceRef.current = null;
      if (movedRef.current) setMoved(null);
      return;
    }
    const now = Date.now();
    if (!movedSinceRef.current) movedSinceRef.current = { at: now, why };
    else movedSinceRef.current.why = why;
    if (now - movedSinceRef.current.at >= 2000 && movedRef.current !== why) setMoved(why);
  }, []);
  useEffect(() => {
    const tp = floorModel && isHomography(floorModel) ? floorModel.tvPose : undefined;
    if (!monitoring || !tp || source === "debug") return;
    let lastA: Vec3 | undefined;
    const check = (fresh?: Vec3) => {
      if (fresh) lastA = fresh;
      const a = lastA;
      const angle = window.screen.orientation?.angle ?? 0;
      if (tp.screenAngle !== undefined && angle !== tp.screenAngle) return reportMoved(L("The screen orientation (portrait/landscape) changed since calibration", "画面の向き（縦・横）が、キャリブレーションのときと変わりました"));
      // A rotated phone delivers a turned frame: its shape must be the calibrated one.
      const src = frameSource();
      if (src && src.ready && src.w > 0 && Math.abs(src.w / src.h / tp.imageAspect - 1) > 0.03) {
        return reportMoved(L(`The camera's aspect ratio (${(src.w / src.h).toFixed(2)}) differs from calibration (${tp.imageAspect.toFixed(2)})`, `カメラの映像の縦横比（${(src.w / src.h).toFixed(2)}）が、キャリブレーションのとき（${tp.imageAspect.toFixed(2)}）と違います`));
      }
      if (a && tp.gravityUp) {
        const d = angleBetweenDeg(upInCamera(a, angle, source === "user" ? "user" : "environment"), tp.gravityUp as Vec3);
        if (d > MOVED_TILT_DEG) return reportMoved(L(`The phone's tilt changed by ${d.toFixed(1)}° since calibration`, `スマホの傾きが、キャリブレーションのときから ${d.toFixed(1)}° 変わりました`));
      }
      reportMoved(null);
    };
    const stop = watchGravity(check);
    const onOrient = () => check();
    window.screen.orientation?.addEventListener("change", onOrient);
    const timer = setInterval(onOrient, 1000); // also without an accelerometer
    return () => {
      stop();
      clearInterval(timer);
      window.screen.orientation?.removeEventListener("change", onOrient);
    };
  }, [monitoring, floorModel, source, reportMoved]);

  /** "It was not moved": the current tilt and orientation become the reference. */
  const acceptPosition = async () => {
    const m = floorModelRef.current;
    if (!m || !isHomography(m) || !m.tvPose) return;
    const g = await measureGravity(1200);
    const angle = window.screen.orientation?.angle ?? 0;
    saveModel({ ...m, tvPose: { ...m.tvPose, gravityUp: upInCamera(g.a, angle, sourceRef.current === "user" ? "user" : "environment"), screenAngle: angle } });
    movedSinceRef.current = null;
    setMoved(null);
  };

  // --------------------------------------------------------------------------
  // Field-pilot mode (T2)
  // --------------------------------------------------------------------------
  useEffect(() => {
    try {
      const m = loadMode();
      modeRef.current = m;
      setModeState(m);
    } catch (err) {
      setModeError((err as Error).message);
    }
  }, []);

  const chooseMode = useCallback((m: FireSenseMode) => {
    saveMode(m);
    modeRef.current = m;
    setModeState(m);
    setModeError(null);
  }, []);

  // --------------------------------------------------------------------------
  // Relay connection
  // --------------------------------------------------------------------------
  const send = useCallback((msg: ClientMessage) => transportRef.current?.send(msg) ?? false, []);

  const hello = useCallback((): ClientMessage | null => {
    const tok = tokenRef.current;
    if (tok) return { v: PROTOCOL_VERSION, type: "camera_hello", sessionId: tok.sessionId, pairingToken: tok.token };
    const s = sessionRef.current;
    if (s) return { v: PROTOCOL_VERSION, type: "camera_hello", sessionId: s.sessionId, cameraSecret: s.cameraSecret };
    return null;
  }, []);

  const runCommandRef = useRef<(m: CameraCommandMessage) => Promise<void>>(async () => {});
  const onServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "paired": {
        const s = { sessionId: msg.sessionId, cameraSecret: msg.cameraSecret };
        // Store only a new pairing (QR); resumes also get "paired", and an old restored tab must not
        // overwrite the newest pairing with its own session.
        if (tokenRef.current) window.localStorage.setItem(KEYS.cameraSession, JSON.stringify(s));
        sessionRef.current = s;
        setSession(s);
        tokenRef.current = null;
        setPendingToken(null);
        setRelayError(null);
        window.history.replaceState(null, "", window.location.pathname);
        break;
      }
      case "unpaired":
        // Only this tab's own pairing (an old tab must not delete a newer one).
        if (readJson<CameraSession>(KEYS.cameraSession)?.sessionId === msg.sessionId) window.localStorage.removeItem(KEYS.cameraSession);
        sessionRef.current = null;
        setSession(null);
        setRelayError(L("Pairing was reset on the TV. Scan the QR code on the TV again.", "TVでペアリングがリセットされました。TVに表示されたQRコードを読み取り直してください。"));
        break;
      case "peer_status":
        if (msg.peer === "tv") {
          tvOnlineRef.current = msg.connected;
          setTvOnline(msg.connected);
        }
        if (msg.peer === "parent") {
          parentOnlineRef.current = msg.connected;
          setParentOnline(msg.connected);
        }
        break;
      case "camera_command":
        void runCommandRef.current(msg);
        break;
      case "rtc_signal":
        void rtcRef.current(msg);
        break;
      case "viewing_state":
        playingRef.current = msg.playing;
        setPlaying(msg.playing);
        break;
      case "calibration_pattern_ack":
        if (ackRef.current?.pattern === msg.pattern) ackRef.current.resolve();
        break;
      case "rtt_ping":
        // Relay round-trip probe from the TV (MEASUREMENT §3): answer at once.
        send({ v: PROTOCOL_VERSION, type: "rtt_pong", sessionId: msg.sessionId, id: msg.id });
        break;
      case "error":
        setRelayError(`[${msg.code}] ${msg.message}`);
        if (msg.code === "NOT_PAIRED" && rehelloAllowed(msg.message, lastRehelloRef.current)) {
          const s = sessionRef.current;
          if (s) {
            lastRehelloRef.current = Date.now();
            send({ v: PROTOCOL_VERSION, type: "camera_hello", sessionId: s.sessionId, cameraSecret: s.cameraSecret });
          }
        }
        if (msg.code === "BAD_CREDENTIALS" && !tokenRef.current) {
          window.localStorage.removeItem(KEYS.cameraSession);
          sessionRef.current = null;
          setSession(null);
        }
        if (msg.code === "TOKEN_USED" || msg.code === "TOKEN_EXPIRED" || msg.code === "BAD_CREDENTIALS") {
          tokenRef.current = null;
          setPendingToken(null);
        }
        break;
      default:
        break;
    }
  }, [send]);

  /** Runs one parent command and always answers it (ok, or the raw error). */
  const runCommand = useCallback(
    async (msg: CameraCommandMessage) => {
      let ok = true;
      let message: string;
      try {
        message = await commandRef.current(msg.command);
      } catch (err) {
        ok = false;
        message = (err as Error).message;
      }
      send({ v: PROTOCOL_VERSION, type: "camera_command_result", sessionId: msg.sessionId, id: msg.id, ok, message: message.slice(0, 1000) });
    },
    [send]
  );

  runCommandRef.current = runCommand;
  const needsRelay = Boolean(session || pendingToken);
  useEffect(() => {
    if (!needsRelay || transportRef.current) return;
    const t = new WebSocketTransport({ url: `${WS_URL}?role=camera`, hello });
    transportRef.current = t;
    const offs = [
      t.onState((s, detail) => {
        setLink(s);
        if (s !== "open") {
          tvOnlineRef.current = false;
          setTvOnline(false);
          parentOnlineRef.current = false;
          setParentOnline(false);
        }
        if (s === "closed" && detail) setRelayError(L(`Lost the connection to the relay (${detail}). Reconnecting automatically.`, `中継サーバーとの接続が切れました（${detail}）。自動で再接続します。`));
        if (s === "open") setRelayError(null);
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

  // Tell the TV why this page is about to go quiet, so it can show the reason next to
  // "Sensor not connected" at once. Best effort: if this never arrives, the TV's 3 s silence rule applies.
  useEffect(() => {
    if (!session) return;
    const leaving = (reason: "hidden" | "pagehide") =>
      send({ v: PROTOCOL_VERSION, type: "camera_leaving", sessionId: session.sessionId, reason });
    const onVis = () => {
      if (document.visibilityState === "hidden") leaving("hidden");
    };
    const onPageHide = () => leaving("pagehide");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [session, send]);

  // Heartbeat 1Hz (always, even when SAFE and unchanged) — lets the TV detect a stalled phone.
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      if (!modeRef.current) return; // no valid mode: send nothing (the error is on screen; the TV shows "not connected")
      send({
        v: PROTOCOL_VERSION,
        type: "heartbeat",
        sessionId: session.sessionId,
        sentAt: Date.now(),
        // Achieved rate (a slow phone runs below the target, see tick); 0 while paused.
        fps: testModeRef.current
          ? 8
          : monitoringRef.current && pipelineRef.current.frameRate.current() > 0
            ? Math.min(pipelineRef.current.frameRate.current(), Math.round(effectiveFpsRef.current * 10) / 10)
            : 0,
        mode: modeRef.current!,
      });
    }, 1000);
    return () => clearInterval(id);
  }, [session, send]);

  // State for parent phones, about once a second while one is connected (numbers and short texts only).
  useEffect(() => {
    if (!session || !parentOnline) return;
    const id = setInterval(() => {
      const st = statusRef.current;
      if (st) send({ ...st, sentAt: Date.now() });
    }, 1000);
    return () => clearInterval(id);
  }, [session, parentOnline, send]);

  // --------------------------------------------------------------------------
  // Camera + model
  // --------------------------------------------------------------------------
  /** Loads the chosen estimator. On failure nothing runs and the error is shown: no other model is tried. */
  const loadModel = useCallback(async (model: PoseModelId, d: Delegate) => {
    setModelError(null);
    setPoseChoiceError(null);
    setPoseModel(model);
    savePoseModelChoice(model);
    const old = estimatorRef.current;
    estimatorRef.current = null;
    await inflightRef.current?.catch(() => undefined);
    old?.close();
    setPoseInfo(null);
    inferenceMsRef.current = 0;
    try {
      setModelLoading(L(`Loading ${POSE_MODEL_INFO[model].label}…`, `${POSE_MODEL_INFO[model].label} を読み込んでいます…`));
      estimatorRef.current = await createPoseEstimator(model, d, setModelLoading);
      pipelineRef.current.setMinTorsoFraction(model === "mediapipe-full" ? DEFAULT_MIN_TORSO_FRACTION : RTMO_MIN_TORSO_FRACTION);
      setPoseInfo({ model, accel: d });
      return true;
    } catch (err) {
      estimatorRef.current = null;
      setModelError(
        L(
          `Could not load ${POSE_MODEL_INFO[model].label} (${d}): ${(err as Error).message}`,
          `${POSE_MODEL_INFO[model].label} (${d}) を読み込めませんでした: ${(err as Error).message}`
        )
      );
      return false;
    } finally {
      setModelLoading(null);
    }
  }, []);

  const modelErrorRef = useRef<string | null>(null);
  modelErrorRef.current = modelError;
  /** While watching: stop the loop, load the other model, resume. */
  const switchPoseModel = async (model: PoseModelId, d: Delegate): Promise<boolean> => {
    if (loopRef.current) clearTimeout(loopRef.current);
    loopRef.current = null;
    const ok = await loadModel(model, d);
    if (ok && activeRef.current) loopRef.current = setTimeout(() => void tick(), 0);
    return ok;
  };

  const startStream = useCallback(async () => {
    if (activeRef.current) return true;
    setCameraError(null);
    if (source === "debug") {
      activeRef.current = true;
      setCameraOn(true);
      return true;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1440 }, facingMode: { ideal: source } },
        audio: false,
      });
      streamRef.current = stream;
      streamStartedAtRef.current = Date.now();
      // The OS can take the camera away (screen off, another app): start it again instead of showing a dead frame.
      // A track that ends right after starting is an error to show, not something to retry in a loop.
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (streamRef.current !== stream) return;
          stopStream();
          if (Date.now() - streamStartedAtRef.current < 3000) {
            setCameraError(L("The camera stopped right after starting (another app may be using it). Close other camera apps and reload.", "カメラが起動直後に止まりました（ほかのアプリがカメラを使っている可能性があります）。ほかのカメラアプリを閉じて、読み込み直してください。"));
            return;
          }
          if (document.visibilityState === "visible") setResumeGen((g) => g + 1);
        });
      }
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      activeRef.current = true;
      setCameraOn(true);
      return true;
    } catch (err) {
      setCameraError(L(`Cannot start the camera (${source === "user" ? "front" : "back"}): ${(err as Error).name} ${(err as Error).message}`, `カメラ（${source === "user" ? "インカメラ" : "アウトカメラ"}）を起動できません: ${(err as Error).name} ${(err as Error).message}`));
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const stopStream = useCallback(() => {
    if (loopRef.current) clearTimeout(loopRef.current);
    loopRef.current = null;
    activeRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  /** Current frame source for MediaPipe (camera video or a fixed debug image). */
  const frameSource = (): { el: HTMLVideoElement | HTMLImageElement; w: number; h: number; ready: boolean } | null => {
    if (sourceRef.current === "debug") {
      const img = imgRef.current;
      return img ? { el: img, w: img.naturalWidth, h: img.naturalHeight, ready: img.complete && img.naturalWidth > 0 } : null;
    }
    const v = videoRef.current;
    return v ? { el: v, w: v.videoWidth, h: v.videoHeight, ready: v.readyState >= 2 } : null;
  };

  /** Waits until the camera (or debug image) delivers frames; the run effect starts it. */
  const waitForFrame = async (timeoutMs = 6000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const src = frameSource();
      if (activeRef.current && src?.ready && src.w > 0) return;
      await sleep(100);
    }
    throw new Error(L(`No camera frames within ${timeoutMs / 1000} s (check the camera permission, and that no other app is using the camera).`, `カメラの映像が ${timeoutMs / 1000} 秒以内に届きませんでした（カメラの許可、ほかのアプリがカメラを使っていないかを確認してください）。`));
  };

  const switchSource = (next: Source) => {
    if (next === sourceRef.current) return;
    stopStream();
    sourceRef.current = next;
    setSource(next);
    window.localStorage.setItem(SOURCE_KEY, next);
    // The calibration for the new lens is loaded by the calibKey effect.
  };

  const acquireWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator)) {
      setWakeLockError(L("This browser does not support Screen Wake Lock. Watching stops when the screen turns off (turn off auto-lock on this device).", "このブラウザは Screen Wake Lock に対応していません。画面が消えると見守りが止まります（端末の自動ロックをオフにしてください）。"));
      return;
    }
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      setWakeLockError(null);
      wakeLockRef.current.addEventListener("release", () => {
        if (monitoringRef.current && document.visibilityState === "visible") {
          setWakeLockError(L("The screen wake lock was released.", "画面の点灯維持（Wake Lock）が解除されました。"));
        }
      });
    } catch (err) {
      setWakeLockError(L(`Could not keep the screen on (Wake Lock): ${(err as Error).message}`, `画面の点灯維持（Wake Lock）に失敗しました: ${(err as Error).message}`));
    }
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && monitoringRef.current) void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [acquireWakeLock]);

  // --------------------------------------------------------------------------
  // Detection loop
  // --------------------------------------------------------------------------
  const floorBottomRef = useRef(1);
  floorBottomRef.current = floorModel?.floorBottomY ?? 1;
  const floorModelRef = useRef<FloorModel | null>(null);
  floorModelRef.current = floorModel;

  /**
   * Skeletons (orange: the person the frame is about; gray: other people; faint dashed: rejected as
   * not a person / not yet confirmed), the watch zone and threshold lines, and the measured distance.
   */
  const draw = useCallback((people: LandmarkPoint[][], w: number, h: number, info: DrawInfo) => {
    const { nearest, accepted, distanceM, distancePoint, distanceSource } = info;
    const c = canvasRef.current;
    if (!c) return;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    people.forEach((lms, i) => {
      const rejected = accepted ? !accepted[i] : false;
      ctx.strokeStyle = i === nearest ? "#f97316" : rejected ? "rgba(148,163,184,0.45)" : "#64748b";
      ctx.lineWidth = i === nearest ? 4 : 2;
      ctx.setLineDash(rejected ? [4, 4] : []);
      for (const [a, b] of POSE_CONNECTIONS) {
        const p = lms[a];
        const q = lms[b];
        if ((p.visibility ?? 1) < 0.5 || (q.visibility ?? 1) < 0.5) continue;
        ctx.beginPath();
        ctx.moveTo(p.x * c.width, p.y * c.height);
        ctx.lineTo(q.x * c.width, q.y * c.height);
        ctx.stroke();
      }
      ctx.fillStyle = ctx.strokeStyle;
      for (const k of FACE_POINTS) {
        const p = lms[k];
        if (!p || (p.visibility ?? 1) < 0.5) continue;
        ctx.beginPath();
        ctx.arc(p.x * c.width, p.y * c.height, i === nearest ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.setLineDash([]);
    // The zoomed crop (second pass), dashed cyan.
    const roiBox = info.roi;
    if (roiBox) {
      ctx.strokeStyle = "rgba(34,211,238,0.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(roiBox.x * c.width, roiBox.y * c.height, roiBox.w * c.width, roiBox.h * c.height);
      ctx.setLineDash([]);
    }
    // Text stays readable on the mirrored (selfie) preview.
    const mirrored = sourceRef.current === "user";
    const label = (text: string, x: number, y: number, color: string) => {
      ctx.save();
      ctx.font = `bold ${Math.round(c.height * 0.045)}px sans-serif`;
      const tw = ctx.measureText(text).width;
      const px = mirrored ? c.width - x : x;
      const lx = Math.min(Math.max(px, 4), c.width - tw - 8);
      if (mirrored) {
        ctx.translate(c.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.fillStyle = "rgba(2,6,23,0.75)";
      ctx.fillRect(lx - 4, y - c.height * 0.045, tw + 8, c.height * 0.058);
      ctx.fillStyle = color;
      ctx.fillText(text, lx, y);
      ctx.restore();
    };
    // Watch zone: the floor in front of the TV, shaded by band (red: too close, amber: approaching,
    // green: safe). TV-marker models project the real zone (distance from the screen: straight in
    // front of it, rounded beside it); other models only know the distance from the screen plane,
    // so the bands span the floor across the frame.
    const zm = floorModelRef.current;
    if (zm) {
      const { tooCloseM, safeM } = settingsRef.current;
      const band = (d: number) => (d < tooCloseM ? "rgba(244,63,94,0.22)" : d < safeM ? "rgba(245,158,11,0.18)" : "rgba(16,185,129,0.14)");
      const far = safeM + 0.8;
      const bottomY = floorBottomRef.current;
      if (isHomography(zm) && zm.tvPose) {
        const W = zm.tvPose.screenWidthM;
        const half = W / 2 + far;
        const N = 24;
        for (let i = 0; i < N; i++)
          for (let j = 0; j < N; j++) {
            const l0 = -half + (2 * half * i) / N;
            const l1 = -half + (2 * half * (i + 1)) / N;
            const f0 = (far * j) / N;
            const f1 = (far * (j + 1)) / N;
            const dc = screenDistance(W, { lateralM: (l0 + l1) / 2, frontM: (f0 + f1) / 2 });
            if (dc < ZONE_NEAR_M || dc > far) continue;
            const q = [projectFloorPoint(zm, l0, f0), projectFloorPoint(zm, l1, f0), projectFloorPoint(zm, l1, f1), projectFloorPoint(zm, l0, f1)];
            if (q.some((p) => !p)) continue;
            ctx.fillStyle = band(dc);
            ctx.beginPath();
            q.forEach((p, k) => (k === 0 ? ctx.moveTo(p!.x * c.width, Math.min(p!.y, bottomY) * c.height) : ctx.lineTo(p!.x * c.width, Math.min(p!.y, bottomY) * c.height)));
            ctx.closePath();
            ctx.fill();
          }
      } else {
        const cols = 40;
        const rows = 30;
        for (let i = 0; i < cols; i++)
          for (let j = 0; j < rows; j++) {
            const x = (i + 0.5) / cols;
            const y = (j + 0.5) / rows;
            if (y > bottomY) continue;
            const d = distanceForFoot(zm, x, y);
            if (d === null || d < ZONE_NEAR_M || d > far) continue;
            ctx.fillStyle = band(d);
            ctx.fillRect((i / cols) * c.width, (j / rows) * c.height, c.width / cols + 1, c.height / rows + 1);
          }
      }
    }
    // Threshold lines on the floor: TOO_CLOSE (red) and SAFE (green). They follow the floor model,
    // so with the phone beside the TV they run diagonally.
    const model = floorModelRef.current;
    if (model) {
      for (const [d, color, name] of [
        [settingsRef.current.tooCloseM, "rgba(244,63,94,0.95)", "tooClose"],
        [settingsRef.current.safeM, "rgba(16,185,129,0.95)", "safe"],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        let started = false;
        let first: { x: number; y: number } | null = null;
        let last: { x: number; y: number } | null = null;
        // TV-marker models: the same distance all around the screen (straight in front, rounded beside it).
        const tvW = isHomography(model) && model.tvPose ? model.tvPose.screenWidthM : null;
        const pts =
          tvW !== null
            ? Array.from({ length: 61 }, (_, k) => {
                const fp = screenDistanceContour(tvW, d, -1 + (2 * k) / 60);
                return projectFloorPoint(model, fp.lateralM, fp.frontM);
              })
            : Array.from({ length: 51 }, (_, k) => {
                const y = isoDistanceY(model, d, k / 50);
                return y === null ? null : { x: k / 50, y };
              });
        for (const pt of pts) {
          const x = pt?.x ?? -1;
          const y = pt?.y ?? null;
          if (pt === null || y === null || y < 0 || y > 1 || x < 0 || x > 1) {
            started = false;
            continue;
          }
          if (!started) ctx.moveTo(x * c.width, y * c.height);
          else ctx.lineTo(x * c.width, y * c.height);
          started = true;
          first ??= { x, y };
          last = { x, y };
        }
        ctx.stroke();
        // Labels at opposite ends so the two never overlap.
        const at = name === "tooClose" ? first : last;
        const text = name === "tooClose" ? L("Too close", "近すぎ") : L("Safe", "安全");
        if (at) label(`${text} ${d.toFixed(2)}m`, at.x * c.width - (name === "tooClose" ? 0 : c.width * 0.25), at.y * c.height - 6, color);
      }
    }
    // Measured distance at the nearest person's feet (or, estimated, at the hips).
    if (distanceM !== null && distancePoint) {
      const text =
        distanceSource === "hips"
          ? L(`~${distanceM.toFixed(2)}m (from the hips)`, `約${distanceM.toFixed(2)}m（腰から推定）`)
          : distanceSource === "seated"
          ? L(`${distanceM.toFixed(2)}m (seated: under the head)`, `${distanceM.toFixed(2)}m（座り: 頭の位置）`)
          : `${distanceM.toFixed(2)}m`;
      label(text, distancePoint.x * c.width + 10, distancePoint.y * c.height + c.height * 0.06, distanceSource === "feet" ? "#fde68a" : "#c4b5fd");
    }
    if (roiBox) label(L(`${zoomSchedRef.current.scanning ? "scan" : "follow"} ${roiBox.zoom.toFixed(1)}×`, `${zoomSchedRef.current.scanning ? "さがす" : "追う"} ${roiBox.zoom.toFixed(1)}×`), roiBox.x * c.width + 6, roiBox.y * c.height + c.height * 0.05, "#67e8f9");
    // Visible floor bottom (amber) and the BELOW_FRAME trigger line (dashed red).
    const bottom = floorBottomRef.current;
    ctx.strokeStyle = "rgba(245,158,11,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, c.height * bottom);
    ctx.lineTo(c.width, c.height * bottom);
    ctx.stroke();
    ctx.strokeStyle = "rgba(244,63,94,0.7)";
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(0, c.height * (bottom - BELOW_FRAME_MARGIN_Y));
    ctx.lineTo(c.width, c.height * (bottom - BELOW_FRAME_MARGIN_Y));
    ctx.stroke();
    ctx.setLineDash([]);
  }, []);

  /** The parent's preview: the raw (unmirrored) frame, plus the zone and threshold lines unless turned off. */
  const paintPreview = (el: CanvasImageSource, w: number, h: number) => {
    const c = previewCanvasRef.current;
    if (!c || w === 0) return;
    const ph = Math.round((PREVIEW_WIDTH * h) / w);
    if (c.width !== PREVIEW_WIDTH || c.height !== ph) {
      c.width = PREVIEW_WIDTH;
      c.height = ph;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    if (skeletonOnlyRef.current) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, c.width, c.height);
    } else ctx.drawImage(el, 0, 0, c.width, c.height);
    // Skeleton only: the lines are all there is to see, so they are always drawn.
    if ((previewOverlayRef.current || skeletonOnlyRef.current) && canvasRef.current) ctx.drawImage(canvasRef.current, 0, 0, c.width, c.height);
  };

  /**
   * The zoom crop: the area the parent drew, else the one computed for the calibration and SAFE line (the zone
   * drawn on the preview: SAFE + 0.8 m).
   */
  const zoomRoiFor = (fullFound: boolean): ZoomRoi | null => {
    const m = floorModelRef.current;
    if (!m || !pipelineRef.current.isCalibrated()) return null;
    const safeM = settingsRef.current.safeM;
    const manual = zoomAreaRef.current;
    const key = manual ?? m;
    const c = zoomRoiRef.current;
    if (c.key !== key || c.safeM !== safeM) {
      zoomRoiRef.current = { key, safeM, roi: manual ? manualZoomRoi(manual) : computeZoomRoi(m, { radiusM: safeM + 0.8 }) };
      zoomSchedRef.current.setArea(zoomRoiRef.current.roi);
    }
    return zoomSchedRef.current.next(fullFound);
  };

  const tick = useCallback(async () => {
    const src = frameSource();
    const pose = estimatorRef.current;
    if (!src || !pose || !activeRef.current) {
      loopRef.current = null;
      return;
    }
    const calibrating = calibStepRef.current;
    let nextMs = CALIBRATION_INTERVAL_MS;

    let inferenceMs = 0;
    const tickAt = performance.now();
    const gap = tickAt - lastTickAtRef.current;
    lastTickAtRef.current = tickAt;
    if (gap > 0 && gap < 5000) effectiveFpsRef.current = effectiveFpsRef.current * 0.7 + (1000 / gap) * 0.3;
    if (src.ready) {
      const t0 = performance.now();
      let res: { people: LandmarkPoint[][]; world: LandmarkPoint[][] | null };
      try {
        const run = pose.detect(src.el, src.w, src.h, t0);
        inflightRef.current = run;
        res = await run;
      } catch (err) {
        // Shown as-is; the loop stops until a model is loaded again (no silent retry on another backend).
        setModelError(L(`Inference failed (${POSE_MODEL_INFO[pose.id].label}): ${(err as Error).message}`, `推論に失敗しました（${POSE_MODEL_INFO[pose.id].label}）: ${(err as Error).message}`));
        loopRef.current = null;
        return;
      }
      // The model was switched while this frame ran: drop it, the new model's loop takes over.
      if (estimatorRef.current !== pose) return;
      let people = res.people;
      let world = res.world;
      // Zoom pass (monitoring only), when the phone is far enough from the watch zone for a crop to help
      // (zoom-roi.ts): 4× tiles over the zone, one per frame, until someone is found; then a crop that
      // follows them. Both passes' people are merged.
      // No scanning while the full frame already shows someone (zoom-roi.ts: the target would keep switching).
      const fullFound = people.some((lms) => plausiblePerson(lms, src.w / src.h).accepted);
      const roi = calibrating || !pose.supportsZoom ? null : zoomRoiFor(fullFound);
      if (roi && pose.detectCrop) {
        const zc = (zoomCanvasRef.current ??= document.createElement("canvas"));
        const zw = 640;
        const zh = Math.round((zw * src.h) / src.w);
        if (zc.width !== zw || zc.height !== zh) {
          zc.width = zw;
          zc.height = zh;
        }
        zc.getContext("2d")!.drawImage(src.el, roi.x * src.w, roi.y * src.h, roi.w * src.w, roi.h * src.h, 0, 0, zw, zh);
        const zrun = pose.detectCrop(zc);
        inflightRef.current = zrun;
        const zres = await zrun;
        if (estimatorRef.current !== pose) return;
        // Only people seen whole in the crop: a tile cutting through someone invents the missing part at its edge.
        const whole = zres.people.map((lms, i) => ({ lms, i })).filter(({ lms }) => wholeInCrop([lms]).length === 1);
        zres.people = whole.map((w) => w.lms);
        if (zres.world) zres.world = whole.map((w) => zres.world![w.i]);
        const zpeople = roiToFrame(zres.people, roi);
        zoomSchedRef.current.observe(zpeople.filter((lms) => plausiblePerson(lms, src.w / src.h).accepted));
        const merged = mergePeople(people, zpeople, src.w / src.h);
        const w0 = world;
        world = w0 && zres.world ? merged.from.map((f) => (f.src === "zoom" ? zres.world![f.index] : w0[f.index])) : null;
        people = merged.people;
      }
      inferenceMs = performance.now() - t0;
      inferenceMsRef.current = inferenceMsRef.current === 0 ? inferenceMs : inferenceMsRef.current * 0.8 + inferenceMs * 0.2;
      if (tickAt - inferenceShownAtRef.current > 1000) {
        inferenceShownAtRef.current = tickAt;
        setInferenceMsShown(Math.round(inferenceMsRef.current));
        setPoseDiag(estimatorRef.current?.diagnostics?.() ?? null);
      }
      let info: DrawInfo = { nearest: selectNearestPerson(people), distanceM: null, distancePoint: null, distanceSource: null };

      if (calibrating) {
        const g = info.nearest >= 0 ? extractGroundContactPoint(people[info.nearest]) : null;
        if (g) samplesRef.current[calibrating].push({ groundY: g.groundY, confidence: g.confidence, timestamp: Date.now() });
      } else if (pipelineRef.current.isCalibrated() && !movedRef.current) {
        const out = pipelineRef.current.process(people, Date.now(), world ?? undefined, src.w / src.h);
        // Real-distance correction: the nearest person's feet, before any correction.
        const fm = floorModelRef.current;
        if (measureSamplesRef.current && out.nearest >= 0 && fm && isHomography(fm) && fm.tvPose) {
          const g = extractGroundContactPoint(people[out.nearest]);
          const raw = g ? imageToFloorRaw(fm.tvPose, g.groundX, g.groundY) : null;
          if (raw) measureSamplesRef.current.push(raw);
        }
        info = {
          nearest: out.nearest,
          accepted: out.verdicts.map((v) => v.accepted),
          distanceM: out.distanceM,
          distancePoint: out.distancePoint,
          distanceSource: out.distanceSource,
          roi,
        };
        setFrame(out);
        if (out.event) setLastEvent({ event: out.event, at: Date.now() });
        const s = sessionRef.current;
        // Nothing while hidden: this page already told the TV it left (camera_leaving).
        if (s && tvOnlineRef.current && !testModeRef.current && modeRef.current && document.visibilityState === "visible") {
          send({
            v: PROTOCOL_VERSION,
            type: "telemetry",
            sessionId: s.sessionId,
            seq: seqRef.current++,
            sentAt: Date.now(),
            state: out.state,
            distanceM: out.distanceM,
            blurPx: out.blurPx,
            posture: out.posture,
            confidence: out.confidence,
            ...(out.event ? { event: out.event } : {}),
            ...(out.floor ? { floor: { lateralM: round1(out.floor.lateralM), frontM: round1(Math.max(0, out.floor.frontM)) } } : {}),
            mode: modeRef.current,
          });
        }
        nextMs = pipelineRef.current.frameRate.intervalMs();
      }
      const previewing = rtcPeersRef.current.size > 0;
      if (!blackoutRef.current || previewing) draw(people, src.w, src.h, info);
      if (previewing) paintPreview(src.el, src.w, src.h);
    }
    // A slow phone lowers the rate by itself: wait at least as long as inference took (≤ 50% duty),
    // so the full pose model never runs back to back and heats the phone.
    if (Number.isFinite(nextMs)) loopRef.current = setTimeout(() => void tick(), Math.max(nextMs - inferenceMs, inferenceMs));
    else loopRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw, send]);

  const ensureRunning = useCallback(async () => {
    if (!estimatorRef.current) return;
    if (!(await startStream())) return;
    if (!loopRef.current) loopRef.current = setTimeout(() => void tick(), 0);
  }, [startStream, tick]);

  // While monitoring, inference runs only while the TV is playing (or calibrating, measuring, previewing). The camera
  // image itself stays on whenever this screen is lit, so the phone can be placed and aimed before anything is
  // connected; with the screen darkened and nothing to infer, the camera is off (battery, heat).
  const inferring = playing || calibStep !== null || source === "debug" || tvBusy !== null || measureBusy !== null || previewCount > 0 || keepCamera;
  useEffect(() => {
    if (!monitoring) return;
    pipelineRef.current.frameRate.setPaused(!inferring);
    if (!inferring) {
      // No stale skeleton or distance over the live image while nothing is inferred.
      const c = canvasRef.current;
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    }
    if (inferring) void ensureRunning();
    else if (!blackout) void startStream(); // camera image only, for placing the phone
    else stopStream(); // screen dark and the TV not playing: camera off, relay connection kept
  }, [monitoring, inferring, blackout, ensureRunning, startStream, stopStream, resumeGen]);

  // Background and back (screen off, another app, the tab switched): the browser stops the camera while hidden,
  // so release it then and start it again on return; after more than a few seconds away the relay socket may be
  // dead without having closed, so reconnect it too (the TV shows "not connected" until the next heartbeat).
  useEffect(() => {
    let hiddenAt: number | null = null;
    const back = () => {
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away > 3000) transportRef.current?.reconnectNow();
      setResumeGen((g) => g + 1);
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        if (sourceRef.current !== "debug") stopStream();
      } else back();
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) back(); // restored from the back-forward cache
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onShow);
    };
  }, [stopStream]);

  const startMonitoring = async (d: Delegate, model: PoseModelId = poseModel) => {
    // Asked first, while this is still the tap: browsers that ask for motion permission allow it only then.
    const motionP = requestMotion();
    void motionP.then(setMotion);
    if (!(await loadModel(model, d))) return;
    monitoringRef.current = true;
    setMonitoring(true);
    await acquireWakeLock();
  };

  useEffect(() => () => {
    stopStream();
    estimatorRef.current?.close();
    void wakeLockRef.current?.release();
    rtcPeersRef.current.forEach((pc) => pc.close());
    rtcPeersRef.current.clear();
  }, [stopStream]);

  // --------------------------------------------------------------------------
  // Calibration
  // --------------------------------------------------------------------------
  const runCalibrationStep = async (step: "A" | "B", markers = { A: settingsRef.current.markerAM, B: settingsRef.current.markerBM }): Promise<StepResult> => {
    calibStepRef.current = step;
    setCalibStep(step); // starts the camera if it was sleeping (TV paused)
    try {
      await waitForFrame();
    } catch (err) {
      calibStepRef.current = null;
      setCalibStep(null);
      setCalibMessage((err as Error).message);
      return { ok: false, message: (err as Error).message };
    }
    samplesRef.current[step] = [];
    setCalibMessage(L(`Stand on the ${markers[step]} m mark and hold still for 3 s…`, `${markers[step]}m の印の上に立って、3秒そのまま…`));
    await sleep(CALIBRATION_MS);
    calibStepRef.current = null;
    setCalibStep(null);
    const n = samplesRef.current[step].length;
    let r: StepResult;
    if (step === "A") {
      r = { ok: n > 0, message: L(`A: ${n} foot samples. Now stand on the ${markers.B} m mark and press B.`, `A: 足元サンプル ${n}件。次に ${markers.B}m の印に立って B を押してください。`) };
    } else {
      const fit = fitFloorCalibration(samplesRef.current.A, samplesRef.current.B, markers.A, markers.B);
      if (!fit.success || !fit.model) {
        r = { ok: false, message: L(`Calibration failed: ${fit.errorMessage}`, `キャリブレーション失敗: ${fit.errorMessage}`) };
      } else {
        saveModel({ ...fit.model, floorBottomY: floorModelRef.current?.floorBottomY });
        r = { ok: true, message: L(`Calibrated (A ${fit.model.sampleCountA} / B ${fit.model.sampleCountB} samples)`, `キャリブレーション完了（A ${fit.model.sampleCountA}件 / B ${fit.model.sampleCountB}件）`) };
      }
    }
    setCalibMessage(r.message);
    return r;
  };

  /** Debug images: stand-on-A then stand-on-B, measured by the same loop as a real calibration. */
  const autoCalibrateDebug = async () => {
    setDebugImage("pose-a-near");
    await sleep(500);
    await runCalibrationStep("A", DEBUG_MARKERS);
    setDebugImage("pose-b-far");
    await sleep(500);
    await runCalibrationStep("B", DEBUG_MARKERS);
  };

  // ---- tap calibration -------------------------------------------------------------
  const freezeFrame = () => {
    const src = frameSource();
    if (!src || !cameraOn || !src.ready || src.w === 0) {
      setCalibMessage(L("The camera (or debug image) is not running, so the frame cannot be frozen. Press \"Start watching\" first.", "カメラ（またはデバッグ画像）が動いていないため、映像を固定できません。先に「見守りを開始」してください。"));
      return;
    }
    // Stays on this phone; only used to pick floor points.
    setFrozen(frameToJpeg(src.el, src.w, src.h, 1024));
    setTapLines((ls) => ls.map((l) => ({ ...l, points: [] })));
  };

  const onTap = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    setTapLines((ls) => ls.map((l, i) => (i === activeLine ? { ...l, points: [...l.points, pt] } : l)));
  };

  const tapCalibrate = (lines: FloorLineSample[]): StepResult => {
    const fit = fitFloorHomography(lines);
    const r: StepResult = fit.success
      ? { ok: true, message: L(`Applied the tap calibration (largest point error ${Math.round(fit.model.maxResidualM * 100)} cm). Check that the red and green lines run parallel to the tape on the floor.`, `タップのキャリブレーションを適用しました（点と距離の最大誤差 ${Math.round(fit.model.maxResidualM * 100)}cm）。映像の赤と緑の線が床のテープと平行になっているか確認してください。`) }
      : { ok: false, message: L(`Tap calibration failed: ${fit.errorMessage}`, `タップのキャリブレーション失敗: ${fit.errorMessage}`) };
    if (fit.success) saveModel({ ...fit.model, floorBottomY: floorModelRef.current?.floorBottomY });
    setCalibMessage(r.message);
    return r;
  };

  const applyTapCalibration = () => {
    if (tapCalibrate(tapLines).ok) setFrozen(null);
  };

  // ---- TV-marker calibration -----------------------------------------------------
  /** Current frame at analysis resolution (pixels for screen detection). */
  const grabFrame = (): RgbaImage & { el: CanvasImageSource; w: number; h: number } => {
    const src = frameSource();
    if (!src || !src.ready || src.w === 0) throw new Error(L("No camera (or debug image) frames. Press \"Start watching\" first.", "カメラ（またはデバッグ画像）の映像がありません。先に「見守りを開始」してください。"));
    const scale = Math.min(1, TV_MARKER_ANALYSIS_PX / Math.max(src.w, src.h));
    const c = document.createElement("canvas");
    c.width = Math.round(src.w * scale);
    c.height = Math.round(src.h * scale);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D is not available");
    ctx.drawImage(src.el, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return { width: img.width, height: img.height, data: img.data, el: c, w: c.width, h: c.height };
  };

  /** Asks the TV for a flat pattern and waits until it reports that the pattern is on screen. */
  const showPattern = (pattern: "magenta" | "black" | "off") =>
    new Promise<void>((resolve, reject) => {
      const s = sessionRef.current;
      if (!s) return reject(new Error(L("Not paired with a TV.", "TVとペアリングしていません。")));
      const timer = setTimeout(() => {
        ackRef.current = null;
        reject(new Error(L(`The TV did not report showing "${pattern}" within 5 s (check that the TV app is open and the relay is connected).`, `TVが「${pattern}」の表示を5秒以内に報告しませんでした（TVアプリが開いているか、中継の接続を確認してください）。`)));
      }, 5000);
      ackRef.current = {
        pattern,
        resolve: () => {
          clearTimeout(timer);
          ackRef.current = null;
          resolve();
        },
      };
      if (!send({ v: PROTOCOL_VERSION, type: "calibration_pattern", sessionId: s.sessionId, pattern })) {
        clearTimeout(timer);
        ackRef.current = null;
        reject(new Error(L("Not connected to the relay, so the TV cannot be asked to show it.", "中継に接続していないため、TVに表示を頼めません。")));
      }
    });

  /**
   * 1. TV black → capture, TV magenta → capture (debug: two fixed images of the same scene).
   * 2. detectScreenQuad: difference + magenta hue → corners (sub-pixel).
   * 3. modelFromTvScreen: focal length and camera pose from the rectangle, then the floor model.
   */
  /** The TV-marker model with a new correction (the zone and every distance follow at once). */
  const setZoneAdjust = (adjust: ZoneAdjust): string => {
    const m = floorModelRef.current;
    if (!m || !isHomography(m) || !m.tvPose) throw new Error(L("Calibrate with the TV marker before adjusting.", "TVマーカーでキャリブレーションしてから調整してください。"));
    const a = ZoneAdjustSchema.parse(adjust);
    saveModel({ ...m, tvPose: { ...m.tvPose, adjust: a } });
    return L(`Adjusted the watch zone (left/right ${a.dxM.toFixed(2)} m, forward/back ${a.dzM.toFixed(2)} m, rotation ${a.angleDeg.toFixed(0)}°, scale ${a.scale.toFixed(2)})`, `見守りエリアを調整しました（左右 ${a.dxM.toFixed(2)}m・前後 ${a.dzM.toFixed(2)}m・向き ${a.angleDeg.toFixed(0)}°・距離の倍率 ${a.scale.toFixed(2)}）`);
  };

  /**
   * Someone stands where a tape measure says `trueM` from the screen; 3 s of their foot positions (median)
   * become a real-distance point. Point 1 shifts the distance; point 2 (another distance) also fixes the scale.
   */
  const measureDistance = async (trueM: number, step: 1 | 2): Promise<StepResult> => {
    const m = floorModelRef.current;
    if (!m || !isHomography(m) || !m.tvPose) return { ok: false, message: L("Calibrate with the TV marker before matching with a tape measure.", "TVマーカーでキャリブレーションしてから実測で合わせてください。") };
    if (step === 2 && measuredRef.current.length === 0) return { ok: false, message: L("Measure point 1 first.", "先に1点目を測ってください。") };
    setMeasureBusy(L(`Stand at ${trueM} m and hold still for 3 s…`, `${trueM}m の位置に立ったまま3秒…`)); // also wakes the camera if the TV is paused
    try {
      await waitForFrame();
      measureSamplesRef.current = [];
      await sleep(3000);
      const samples = measureSamplesRef.current ?? [];
      if (samples.length < 3) {
        return { ok: false, message: L(`The feet were seen only ${samples.length} times (3 or more needed). Stand where the feet are in view and press again.`, `足元が ${samples.length} 回しか見えませんでした（3回以上必要）。足元が映る位置に立って、もう一度押してください。`) };
      }
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const raw = { lateralM: med(samples.map((p) => p.lateralM)), frontM: med(samples.map((p) => p.frontM)) };
      const points = step === 1 ? [{ raw, trueM }] : [measuredRef.current[0], { raw, trueM }];
      const before = m.tvPose.adjust ?? NO_ADJUST;
      const next = fitAdjustToMeasurements(step === 1 ? { ...before, scale: 1 } : before, m.tvPose.screenWidthM, points);
      const parsed = ZoneAdjustSchema.safeParse(next);
      if (!parsed.success) return { ok: false, message: L(`The correction is too large (offset ${next.dzM} m, scale ${next.scale}). Calibrate again or check the distance you entered.`, `補正が大きすぎます（前後 ${next.dzM}m・倍率 ${next.scale}）。キャリブレーションをやり直すか、入力した距離を確認してください。`) };
      measuredRef.current = points;
      setMeasuredCount(points.length);
      saveModel({ ...m, tvPose: { ...m.tvPose, adjust: parsed.data } });
      const dz = `${parsed.data.dzM >= 0 ? "+" : ""}${parsed.data.dzM.toFixed(2)}m`;
      const message =
        L(
          `Point ${step}: matched ${trueM} m (offset ${dz}${step === 2 ? `, scale ${parsed.data.scale.toFixed(2)}` : ""}).`,
          `${step}点目: ${trueM}m の位置を合わせました（補正: 前後 ${dz}${step === 2 ? `・距離の倍率 ${parsed.data.scale.toFixed(2)}` : ""}）。`
        ) +
        (step === 1
          ? L(
              " Measure a second point at another distance (at least 0.5 m away) to match both near and far.",
              "別の距離（0.5m 以上離れた位置）で2点目も測ると、遠い所と近い所の両方が合います。"
            )
          : "");
      setCalibMessage(message);
      return { ok: true, message };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      measureSamplesRef.current = null;
      setMeasureBusy(null);
    }
  };

  const tvMarkerCalibrate = async (opts?: { debug?: true; inches?: number; heightCm?: number; screenBottomCm?: number | null }): Promise<StepResult> => {
    setTvError(null);
    setTvReport(null);
    setTvPreview(null);
    const inches = opts?.debug ? TV_DEBUG.inches : opts?.inches ?? tvInches;
    const heightCm = opts?.debug ? TV_DEBUG.heightCm : opts?.heightCm ?? geo.heightCm;
    const bottomCm = opts?.debug ? null : opts?.screenBottomCm !== undefined ? opts.screenBottomCm : screenBottomCm;
    let tvOn = false;
    let off: ReturnType<typeof grabFrame> | null = null;
    let on: ReturnType<typeof grabFrame> | null = null;
    let gravityP: Promise<{ ok: true; a: Vec3 } | { ok: false; error: string }> | null = null;
    try {
      if (opts?.debug) {
        setTvBusy(L("Loading the debug images (screen black → magenta)…", "デバッグ画像（画面が黒 → マゼンタ）を読み込んでいます…"));
        setDebugImage("tv-black");
        await sleep(800);
        off = grabFrame();
        setDebugImage("tv-magenta");
        await sleep(800);
        on = grabFrame();
      } else {
        if (!monitoringRef.current) throw new Error(L("Watching has not started. Press \"Start watching\" on the watch camera first.", "見守りが開始されていません。先に見守りカメラで「見守りを開始」を押してください。"));
        if (!tvOnlineRef.current) throw new Error(L("The TV is not connected to the relay. Open the app on the TV.", "TVが中継に接続されていません。TVでアプリを開いてください。"));
        setTvBusy(L("Starting the camera…", "カメラを起動しています…")); // starts the camera if it was sleeping (TV paused)
        await waitForFrame();
        // The accelerometer (which way is up) while the TV patterns run; the phone must lie still.
        gravityP = measureGravity(2500).then(
          (g) => ({ ok: true as const, a: g.a }),
          (e: Error) => ({ ok: false as const, error: e.message })
        );
        tvOn = true;
        setTvBusy(L("Turning the TV screen black…", "TVの画面を黒にしています…"));
        await showPattern("black");
        await sleep(700); // camera exposure settles
        off = grabFrame();
        setTvBusy(L("Turning the TV screen magenta…", "TVの画面をマゼンタにしています…"));
        await showPattern("magenta");
        await sleep(700);
        on = grabFrame();
        await showPattern("off");
        tvOn = false;
      }
      setTvBusy(L("Finding the screen corners and solving the phone position…", "画面の四隅を検出して、スマホの位置を計算しています…"));
      const quad = detectScreenQuad(on, off);
      const grav = gravityP ? await gravityP : null;
      const screenAngle = window.screen.orientation?.angle ?? 0;
      const upCam = grav?.ok ? upInCamera(grav.a, screenAngle, sourceRef.current === "user" ? "user" : "environment") : undefined;
      const r = modelFromTvScreen(quad.corners, screenSizeFromInches(inches), on.width / on.height, heightCm / 100, bottomCm === null ? undefined : bottomCm / 100, upCam);
      setTvPreview(drawQuadPreview(on.el, on.w, on.h, quad.corners));
      // A new calibration starts without the previous correction (it belonged to the old camera pose).
      measuredRef.current = [];
      setMeasuredCount(0);
      // Kept with the model: how the phone was held, to notice later that it was moved or turned.
      saveModel({
        ...r.model,
        floorBottomY: floorModelRef.current?.floorBottomY,
        tvPose: { ...r.model.tvPose!, ...(upCam ? { gravityUp: upCam } : {}), screenAngle },
      });
      movedSinceRef.current = null;
      setMoved(null);
      const c = r.pose.camera;
      const lateral = c.a - screenSizeFromInches(inches).widthM / 2;
      setTvReport(
        [
          L(
            `Screen corners: edge line-fit error ${quad.edgeRmsPx.toFixed(2)} px, fill ratio ${quad.fillRatio.toFixed(2)}`,
            `画面の四隅: 辺の直線あてはめ誤差 ${quad.edgeRmsPx.toFixed(2)}px、充填率 ${quad.fillRatio.toFixed(2)}`
          ),
          L(
            `Phone position (estimated): ${c.n.toFixed(2)} m in front of the screen, ${Math.abs(lateral).toFixed(2)} m ${lateral > 0 ? "right" : "left"} of its center (facing the TV), ${Math.round(Math.abs(c.b) * 100)} cm ${c.b >= 0 ? "above" : "below"} the screen bottom`,
            `スマホの位置（推定）: テレビ画面から ${c.n.toFixed(2)}m 手前、画面の中心から ${Math.abs(lateral).toFixed(2)}m ${lateral > 0 ? "右" : "左"}（テレビに向かって）、画面の下端より ${Math.round(c.b * 100)}cm ${c.b >= 0 ? "上" : "下"}`
          ),
          r.gravity
            ? L(
                `Motion sensor used: vertical field of view ${r.pose.vfovDeg.toFixed(1)}° (corners alone: ${r.gravity.cornersOnlyVfovDeg ?? "—"}°), corner error ${r.gravity.rmsPx1000.toFixed(1)} px/1000 px`,
                `傾きセンサーを使用: 縦の画角 ${r.pose.vfovDeg.toFixed(1)}°（四隅だけだと ${r.gravity.cornersOnlyVfovDeg ?? "—"}°）、四隅のずれ ${r.gravity.rmsPx1000.toFixed(1)}px/1000px`
              )
            : L(
                `No motion sensor${grav && !grav.ok ? ` (${grav.error})` : ""}: vertical field of view ${r.pose.vfovDeg.toFixed(1)}° (from the corners alone; with a small TV in view the distance can be far off)`,
                `傾きセンサーなし${grav && !grav.ok ? `（${grav.error}）` : ""}: 縦の画角 ${r.pose.vfovDeg.toFixed(1)}°（四隅だけから推定。テレビが小さく映っていると距離が大きくずれることがあります）`
              ),
          r.sizeScale !== null
            ? L(
                `TV size: from the screen-bottom height ${bottomCm} cm, calculated as about ${Math.round(inches * r.sizeScale)}" instead of the entered ${inches}"`,
                `テレビの大きさ: 画面の下端の高さ ${bottomCm}cm から、入力の ${inches}型 ではなく約 ${Math.round(inches * r.sizeScale)}型 として計算しました`
              )
            : L(
                `Screen-bottom height (estimated): ${Math.round(r.screenBottomHeightM * 100)} cm above the floor. If that is far from the real one, check the TV size or phone height you entered, or also enter the screen-bottom height`,
                `画面の下端の高さ（推定）: 床から ${Math.round(r.screenBottomHeightM * 100)}cm ← 実物と大きく違えば、型（インチ）かスマホの高さの入力を見直すか、画面の下端の高さも入れてください`
              ),
        ].join("\n")
      );
      const message = L(
        `Calibrated with the TV marker (${inches}", lens height ${heightCm} cm, ${r.gravity ? "motion sensor used" : "no motion sensor"}).`,
        `TVマーカーでキャリブレーションしました（${inches}型、レンズの高さ ${heightCm}cm${r.gravity ? "、傾きセンサー使用" : "、傾きセンサーなし"}）。`
      );
      setCalibMessage(message);
      if (opts?.debug) setDebugImage("tv-person-near");
      // What the parent can check against the room with a tape measure.
      const check = [
        L(
          `Calculated phone position: ${c.n.toFixed(2)} m in front of the screen, ${Math.abs(lateral).toFixed(2)} m ${lateral > 0 ? "right" : "left"} of its center`,
          `計算したスマホの位置: テレビ画面から ${c.n.toFixed(2)}m 手前、画面の中心から ${Math.abs(lateral).toFixed(2)}m ${lateral > 0 ? "右" : "左"}`
        ),
        L(
          `Calculated screen-bottom height: ${Math.round(r.screenBottomHeightM * 100)} cm above the floor${r.sizeScale !== null ? ` (TV calculated as about ${Math.round(inches * r.sizeScale)}")` : ""}`,
          `計算した画面の下端の高さ: 床から ${Math.round(r.screenBottomHeightM * 100)}cm${r.sizeScale !== null ? `（テレビは約${Math.round(inches * r.sizeScale)}型として計算）` : ""}`
        ),
        r.gravity
          ? L(`Motion sensor: used (corner error ${r.gravity.rmsPx1000.toFixed(1)} px)`, `傾きセンサー: 使用（四隅のずれ ${r.gravity.rmsPx1000.toFixed(1)}px）`)
          : L(`Motion sensor: none${grav && !grav.ok ? ` (${grav.error})` : ""}. Distances are less accurate`, `傾きセンサー: なし${grav && !grav.ok ? `（${grav.error}）` : ""}。距離の精度が下がります`),
        L("If these are far from the real room, check the inputs (TV size, height) and calibrate again.", "実物と大きく違うときは、入力（型・高さ）を見直してやり直してください。"),
      ];
      return { ok: true, message: `${message}\n${check.join("\n")}` };
    } catch (err) {
      setTvError((err as Error).message);
      // Show what was taken as "screen" (green) on the captured frame, to see why detection failed.
      if (on && off) setTvPreview(drawMaskPreview(on, off));
      return { ok: false, message: (err as Error).message };
    } finally {
      if (tvOn) {
        // Always try to give the TV back; if that fails too, say so (the TV clears itself after 20s).
        await showPattern("off").catch((e: Error) => setTvError((prev) => L(`${prev ?? ""}\nCould not restore the TV picture: ${e.message} (the TV restores it by itself after 20 s)`, `${prev ?? ""}\nTVの表示を戻せませんでした: ${e.message}（20秒後にTV側で自動的に戻ります）`)));
      }
      setTvBusy(null);
    }
  };

  let edge: { value: number | null; error: string | null } = { value: null, error: null };
  if (floorModel) {
    try {
      edge = { value: edgeDistanceFor(floorModel), error: null };
    } catch (err) {
      edge = { value: null, error: (err as Error).message };
    }
  }

  // --------------------------------------------------------------------------
  // Manual calibration from phone height / tilt / FOV (approximate, labeled)
  // --------------------------------------------------------------------------
  const applyGeometry = () => {
    try {
      const { model, maxErrorM } = modelFromCameraGeometry({
        heightM: geo.heightCm / 100,
        pitchDownDeg: geo.pitchDownDeg,
        vfovDeg: geo.vfovDeg,
      });
      saveModel({ ...model, floorBottomY: floorModel?.floorBottomY });
      setGeoConfirmed(true);
      setCalibMessage(
        L(`Applied the approximate calibration (theoretical max error ${Math.round(maxErrorM * 100)} cm over 0.8–2.2 m, plus input errors). For accuracy, use a floor calibration.`, `簡易キャリブレーションを適用しました（概算。0.8〜2.2m で理論上の最大誤差 ${Math.round(maxErrorM * 100)}cm＋入力値の誤差）。正確にするには床の2点キャリブレーションを行ってください。`)
      );
    } catch (err) {
      setCalibMessage(L(`Cannot apply the approximate calibration: ${(err as Error).message}`, `簡易キャリブレーションできません: ${(err as Error).message}`));
    }
  };

  const measureTilt = async () => {
    setTiltMessage(null);
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> } | undefined;
    if (!DOE) {
      setTiltMessage(L("This browser has no motion sensor. Enter the values by hand.", "このブラウザは傾きセンサーに対応していません。手入力してください。"));
      return;
    }
    if (typeof DOE.requestPermission === "function") {
      const r = await DOE.requestPermission();
      if (r !== "granted") {
        setTiltMessage(L("Motion sensor permission was not given. Enter the values by hand.", "傾きセンサーの許可が得られませんでした。手入力してください。"));
        return;
      }
    }
    const angle = window.screen.orientation?.angle ?? 0;
    if (angle !== 0 && angle !== 180) {
      setTiltMessage(L("Cannot measure in landscape. Stand the phone upright or enter the values by hand.", "横向きでは自動で測れません。縦向きに置くか、手入力してください。"));
      return;
    }
    const samples: number[] = [];
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta !== null) samples.push(e.beta);
    };
    window.addEventListener("deviceorientation", onOrient);
    setTiltMessage(L("Measuring… do not move the mounted phone", "測定中…スマホを設置した状態で動かさないでください"));
    setTimeout(() => {
      window.removeEventListener("deviceorientation", onOrient);
      if (samples.length === 0) {
        setTiltMessage(L("No motion sensor readings (this browser or device may not support it). Enter the values by hand.", "傾きセンサーの値が取得できませんでした（このブラウザ／端末では未対応の可能性）。手入力してください。"));
        return;
      }
      const beta = samples.reduce((x, y) => x + y, 0) / samples.length;
      // Portrait, screen facing the room: upright = 90°. Leaning the top toward the room points the camera down.
      const pitch = Math.round(beta - 90);
      setGeo((g) => ({ ...g, pitchDownDeg: pitch }));
      setTiltMessage(L(`Measured ${pitch}° downward (${samples.length} samples)`, `下向き ${pitch}° を測定しました（${samples.length} サンプル）`));
    }, 1200);
  };

  // --------------------------------------------------------------------------
  // Test mode: synthetic distances through the real relay (TV shows "Test input")
  // --------------------------------------------------------------------------
  useEffect(() => {
    testModeRef.current = testMode;
    if (!testMode || !session) return;
    const sm = new ViewingStateMachine();
    let applied = "";
    const id = setInterval(() => {
      // Follow the sliders while test mode runs (same thresholds as live sensing).
      const { tooCloseM, safeM } = settingsRef.current;
      if (applied !== `${tooCloseM}/${safeM}`) {
        sm.setThresholds(tooCloseM, safeM);
        applied = `${tooCloseM}/${safeM}`;
      }
      const input = testInputRef.current;
      const out = sm.update(
        input.kind === "below"
          ? { footStatus: "BELOW_FRAME", distanceM: null, confidence: 0.95, posture: "GOOD" }
          : input.kind === "lost"
          ? { footStatus: "OCCLUDED", distanceM: null, confidence: 0, posture: "UNKNOWN" }
          : { footStatus: "VISIBLE", distanceM: input.d, confidence: 0.95, posture: input.slouch ? "SLOUCH" : "GOOD" },
        Date.now()
      );
      setTestFrame(out);
      // Nothing while hidden: this page already told the TV it left (camera_leaving).
      if (!modeRef.current || document.visibilityState !== "visible") return;
      send({
        v: PROTOCOL_VERSION,
        type: "telemetry",
        sessionId: session.sessionId,
        seq: seqRef.current++,
        sentAt: Date.now(),
        state: out.state,
        distanceM: out.distanceM,
        blurPx: out.blurPx,
        posture: out.posture,
        confidence: out.confidence,
        ...(out.event ? { event: out.event } : {}),
        mode: modeRef.current!,
        test: true,
      });
    }, 125);
    return () => clearInterval(id);
  }, [testMode, session, send]);

  // --------------------------------------------------------------------------
  // Parent phones: remote commands, live preview, state report
  // --------------------------------------------------------------------------
  const requireMonitoring = () => {
    if (!monitoringRef.current) throw new Error(L("Watching has not started. Press \"Start watching\" once on the watch camera (starting the camera and model needs a tap on that device).", "見守りが開始されていません。見守りカメラで一度「見守りを開始」を押してください（カメラとモデルの起動には、その端末での操作が必要です）。"));
  };

  // A floor corrected by hand or with a tape measure is a different method in the accuracy table (MEASUREMENT_EVIDENCE §1).
  const trialAdjust = floorModel && isHomography(floorModel) ? floorModel.tvPose?.adjust : undefined;
  const trialAdjusted = Boolean(trialAdjust && (Object.keys(NO_ADJUST) as (keyof typeof NO_ADJUST)[]).some((k) => trialAdjust[k] !== NO_ADJUST[k]));
  const trialMethod = floorModel ? `${source === "debug" ? "debug-" : ""}${floorModel.method ?? floorModel.kind ?? "linear"}${trialAdjusted ? "+adjusted" : ""}` : null;
  const distanceTrials = useDistanceTrials(frame, trialMethod);

  commandRef.current = async (c: CameraCommand): Promise<string> => {
    const fail = (r: StepResult) => {
      if (!r.ok) throw new Error(r.message);
      return r.message;
    };
    switch (c.kind) {
      case "set_mode":
        chooseMode(c.mode);
        return L(`Mode set to "${MODE_LABEL[c.mode].title}"`, `モードを「${MODE_LABEL[c.mode].title}」にしました`);
      case "set_settings": {
        const changed = Object.keys(c.settings)[0] as keyof Settings | undefined;
        const next = normalizeSettings({ ...settingsRef.current, ...c.settings }, changed);
        setSettings(next);
        return L(
          `Thresholds: too close ${next.tooCloseM.toFixed(2)} m / safe ${next.safeM.toFixed(2)} m, marks A ${next.markerAM.toFixed(2)} m / B ${next.markerBM.toFixed(2)} m`,
          `しきい値: 近すぎ ${next.tooCloseM.toFixed(2)}m / 安全 ${next.safeM.toFixed(2)}m、印 A ${next.markerAM.toFixed(2)}m / B ${next.markerBM.toFixed(2)}m`
        );
      }
      case "set_floor_bottom": {
        const m = floorModelRef.current;
        if (!m) throw new Error(L("Not calibrated yet, so the floor bottom line cannot be set.", "まだキャリブレーションしていないため、床の下端ラインは設定できません。"));
        saveModel({ ...m, floorBottomY: c.floorBottomY });
        return L(`Set the floor bottom line to ${c.floorBottomY.toFixed(2)}`, `床の下端ラインを ${c.floorBottomY.toFixed(2)} にしました`);
      }
      case "set_zoom_area":
        manualZoomRoi(c.area ?? { x0: 0, y0: 0, x1: 1, y1: 1 }); // throws on an unusable area
        setZoomArea(c.area);
        return c.area
          ? L("Zoomed search: in the drawn area", "拡大して探す範囲: 描いた範囲にしました")
          : L("Zoomed search: computed from the calibration", "拡大して探す範囲: キャリブレーションから自動にしました");
      case "set_skeleton_only":
        setSkeletonOnly(c.on);
        return c.on
          ? L("Skeleton only: the camera image is hidden on the watch camera and in the preview", "骨格だけ: 見守りカメラの画面とプレビューで、カメラの映像を隠しました")
          : L("Showing the camera image again", "カメラの映像を表示に戻しました");
      case "set_blackout":
        setBlackout(c.on);
        return c.on
          ? L("Darkened the watch camera screen (watching continues)", "見守りカメラの画面を暗くしました（見守りは続いています）")
          : L("Turned the watch camera screen back on", "見守りカメラの画面を戻しました");
      case "calibrate_tv":
        requireMonitoring();
        if (tvBusy !== null) throw new Error(L(`The watch camera is busy: ${tvBusy}`, `見守りカメラは別の処理中です: ${tvBusy}`));
        if (sourceRef.current === "debug") return fail(await tvMarkerCalibrate({ debug: true }));
        setTvInches(c.inches);
        setGeo((g) => ({ ...g, heightCm: c.heightCm }));
        setScreenBottomCm(c.screenBottomCm ?? null);
        return fail(await tvMarkerCalibrate({ inches: c.inches, heightCm: c.heightCm, screenBottomCm: c.screenBottomCm ?? null }));
      case "measure_distance":
        requireMonitoring();
        if (measureSamplesRef.current) throw new Error(L("The watch camera is measuring a tape point", "見守りカメラは実測の計測中です"));
        return fail(await measureDistance(c.trueM, c.step));
      case "set_zone_adjust":
        return setZoneAdjust(c.adjust);
      case "calibrate_stand":
        requireMonitoring();
        if (calibStepRef.current) throw new Error(L(`The watch camera is measuring (${calibStepRef.current})`, `見守りカメラは計測中です（${calibStepRef.current}）`));
        if (sourceRef.current === "debug") {
          setDebugImage(c.step === "A" ? "pose-a-near" : "pose-b-far");
          await sleep(500);
          return fail(await runCalibrationStep(c.step, DEBUG_MARKERS));
        }
        return fail(await runCalibrationStep(c.step));
      case "calibrate_tap":
        return fail(tapCalibrate(c.lines));
      case "preview_overlay":
        previewOverlayRef.current = c.on;
        return c.on ? L("Drawing the lines on the video", "映像に線を重ねます") : L("Sending the video without lines", "線を重ねずに映像を送ります");
      case "distance_trial":
        requireMonitoring();
        return distanceTrials.start(c.trueM, c.lateral, c.delayS * 1000);
      case "distance_trial_drop_last": {
        const dropped = distanceTrials.dropLast();
        return dropped === null
          ? L("No trial to delete", "消す試行はありません")
          : L(`Deleted trial ${dropped} (${distanceTrials.trials - 1} left)`, `試行 ${dropped} を消しました（残り ${distanceTrials.trials - 1}）`);
      }
      case "set_pose_model": {
        requireMonitoring();
        if (!(await switchPoseModel(c.model, c.accel))) throw new Error(modelErrorRef.current ?? L("Could not load the model", "モデルを読み込めませんでした"));
        return L(`Pose model: ${POSE_MODEL_INFO[c.model].label} (${c.accel})`, `推論モデル: ${POSE_MODEL_INFO[c.model].label}（${c.accel}）`);
      }
    }
  };

  const closePeer = useCallback((peerId: string) => {
    const pc = rtcPeersRef.current.get(peerId);
    if (!pc) return;
    pc.close();
    rtcPeersRef.current.delete(peerId);
    setPreviewCount(rtcPeersRef.current.size);
  }, []);

  rtcRef.current = async (m: RtcSignal) => {
    if (m.kind === "hangup") return closePeer(m.peerId);
    if (m.kind !== "offer" || !m.sdp) return;
    const reply = (kind: "answer" | "error", extra: { sdp?: string; message?: string }) =>
      send({ v: PROTOCOL_VERSION, type: "rtc_signal", sessionId: m.sessionId, peerId: m.peerId, kind, ...extra });
    closePeer(m.peerId);
    try {
      requireMonitoring();
      if (typeof RTCPeerConnection === "undefined") throw new Error(L("This browser does not support WebRTC, so it cannot send video.", "このブラウザは WebRTC に対応していないため、映像を送れません。"));
      if (rtcPeersRef.current.size >= MAX_PREVIEW_PEERS) throw new Error(L(`Up to ${MAX_PREVIEW_PEERS} phones can watch the video at once.`, `映像を見られるのは同時に ${MAX_PREVIEW_PEERS} 台までです。`));
      if (!previewCanvasRef.current) {
        const c = document.createElement("canvas");
        c.width = PREVIEW_WIDTH;
        c.height = 480;
        c.getContext("2d")?.fillRect(0, 0, c.width, c.height);
        previewCanvasRef.current = c;
      }
      const canvas = previewCanvasRef.current as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };
      if (!canvas.captureStream) throw new Error(L("This browser does not support canvas.captureStream, so it cannot send video.", "このブラウザは canvas.captureStream に対応していないため、映像を送れません。"));
      previewStreamRef.current ??= canvas.captureStream(10);
      const stream = previewStreamRef.current;
      const pc = new RTCPeerConnection(RTC_CONFIG);
      rtcPeersRef.current.set(m.peerId, pc);
      setPreviewCount(rtcPeersRef.current.size);
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") closePeer(m.peerId);
      });
      await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      stream.getVideoTracks().forEach((t) => pc.addTrack(t, stream));
      await pc.setLocalDescription(await pc.createAnswer());
      await iceGatheringComplete(pc);
      reply("answer", { sdp: pc.localDescription?.sdp });
    } catch (err) {
      closePeer(m.peerId);
      reply("error", { message: (err as Error).message });
    }
  };

  // No preview without a parent to watch it.
  useEffect(() => {
    if (!parentOnline) rtcPeersRef.current.forEach((_, id) => closePeer(id));
  }, [parentOnline, closePeer]);

  {
    let coverage: number | null = null;
    if (floorModel) {
      try {
        coverage = computeCoverage(floorModel, { tooCloseM: settings.tooCloseM, safeM: settings.safeM, floorBottomY: floorModel.floorBottomY }).tooCloseVisible;
      } catch {
        coverage = null; // the reason is shown on the camera (CoveragePanel) and in errors below
      }
    }
    const shown = frame && !testMode ? frame : null;
    statusRef.current = session
      ? {
          v: PROTOCOL_VERSION,
          type: "camera_status",
          sessionId: session.sessionId,
          mode,
          monitoring,
          cameraOn,
          source,
          tvOnline,
          playing,
          blackout,
          settings,
          tvCalibration: { inches: Math.min(100, Math.max(20, tvInches)), heightCm: Math.min(200, Math.max(10, geo.heightCm)), screenBottomCm },
          motion,
          calibration: floorModel
            ? {
                method: METHOD_LABEL(floorModel),
                floorBottomY: floorModel.floorBottomY ?? 1,
                edgeM: edge.value,
                tooCloseVisible: coverage === null ? null : Math.min(1, Math.max(0, coverage)),
                adjust: isHomography(floorModel) && floorModel.tvPose ? floorModel.tvPose.adjust ?? NO_ADJUST : null,
                measuredPoints: measuredCount,
              }
            : null,
          busy: tvBusy ?? measureBusy ?? (calibStep ? L(`Standing calibration: measuring ${calibStep}`, `立ってキャリブレーション ${calibStep} を計測中`) : null),
          message: calibMessage,
          errors: [moved ? L(`The watch camera moved, so distances are not being sent: ${moved}. Calibrate again.`, `見守りカメラが動いたため、距離を送るのを止めています: ${moved}。キャリブレーションし直してください。`) : null, modeError, modelError, cameraError, wakeLockError, tvError, settingsError, relayError, edge.error]
            .filter((e): e is string => Boolean(e))
            .map((e) => e.slice(0, 1000))
            .slice(0, 8),
          live: shown
            ? {
                state: shown.state,
                distanceM: shown.distanceM,
                blurPx: shown.blurPx,
                posture: shown.posture,
                fps: Math.min(60, Math.round(effectiveFpsRef.current * 10) / 10),
                peopleCount: shown.peopleCount,
                distanceSource: shown.distanceSource,
              }
            : null,
          skeletonOnly,
          zoom: { area: zoomArea, active: Boolean(poseInfo?.model === "mediapipe-full" && zoomRoiRef.current.roi) },
          previewPeers: previewCount,
          pose: poseInfo ? { ...poseInfo, inferenceMs: Math.min(60_000, Math.round(inferenceMsRef.current)) } : null,
          distanceTrials: {
            trials: distanceTrials.trials,
            recording: distanceTrials.recording
              ? { trial: distanceTrials.recording.trial, trueM: distanceTrials.recording.trueM, lateral: distanceTrials.recording.lateral, waitS: Math.min(60, distanceTrials.waiting), leftS: Math.min(60, distanceTrials.left) }
              : null,
          },
        }
      : null;
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------
  const calOpen = calEditing ?? !floorModel;
  const paired = Boolean(session);
  const step = !paired ? 0 : !monitoring ? 1 : !floorModel ? 2 : 3;

  return (
    <main className="max-w-xl mx-auto px-4 py-6 space-y-4">
      {blackout && (
        <button
          onClick={() => setBlackout(false)}
          aria-label={L("Turn the screen back on", "画面を戻す")}
          className="fixed inset-0 z-[200] bg-black flex items-end justify-center pb-10 text-[11px] text-neutral-800"
        >
          {L("Watching (tap to turn the screen back on)", "見守り中（タップで画面を戻す）")}
        </button>
      )}
      <header className="space-y-2">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-orange-400">
          <Camera className="w-4 h-4" /> FireSense Kids · {L("Watch camera", "見守りカメラ")}
          <LangSwitch className="ml-2" />
        </div>
        <ol className="grid grid-cols-4 gap-1 text-[11px]">
          {steps().map((label, i) => {
            const done = i < step;
            const now = i === step;
            return (
              <li
                key={label}
                className={`px-1 py-1.5 rounded-lg text-center border ${
                  done ? "bg-emerald-950/50 border-emerald-700 text-emerald-200" : now ? "bg-orange-600 border-orange-400 text-white font-bold" : "bg-slate-900 border-slate-800 text-slate-500"
                }`}
              >
                {done ? "✓ " : `${i + 1}. `}
                {label}
              </li>
            );
          })}
        </ol>
        <p className="text-[11px] text-slate-500">{L("Video is processed only on this device, never saved or sent to the cloud. Only numbers such as distance go to the TV.", "映像はこの端末の中だけで処理し、保存もクラウドへの送信もしません。TVに送るのは距離などの数値だけです。")}</p>
      </header>

      {moved && (
        <div className="p-4 rounded-2xl bg-rose-950/70 border-2 border-rose-500 text-rose-100 space-y-2">
          <div className="font-bold">{L("The watch camera seems to have moved", "見守りカメラが動いたようです")}</div>
          <p className="text-xs">
            {moved}. {L("Distances would be off, so they are not being sent to the TV.", "距離がずれるため、TVに距離を送るのを止めています。")}
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void tvMarkerCalibrate()} disabled={tvBusy !== null} className="px-3 py-2 rounded-xl bg-rose-600 text-white text-sm font-bold disabled:opacity-40">
              {L("Calibrate again", "キャリブレーションし直す")}
            </button>
            <button onClick={() => void acceptPosition().catch((e: Error) => setCalibMessage(e.message))} className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-600 text-white text-sm">
              {L("It did not move (use the current placement)", "動かしていない（今の置き方を基準にする）")}
            </button>
          </div>
        </div>
      )}

      {/* What to do next (until everything is set), or what the camera sees now. */}
      {step < 3 ? (
        <section className="p-4 rounded-2xl bg-slate-900 border-2 border-orange-500/70 space-y-3">
          <div className="text-xs text-orange-300 font-bold">{L("Next step", "次にやること")}</div>
          {step === 0 && (
            <p className="text-base text-white">
              {L("Scan the \"Connect the watch camera\" QR code on the TV with this device's camera.", "テレビの画面に出ている「見守りカメラをつなぐ」の QR コードを、この端末のカメラで読み取ってください。")}
              {pendingToken && <span className="block text-sm text-slate-300 mt-1">{L("Connecting…", "つないでいます…")}</span>}
            </p>
          )}
          {step === 1 && (
            <>
              <p className="text-base text-white">{L("Put this device where it will stay, then start watching.", "置き場所に端末を置いて、見守りを始めます。")}</p>
              <p className="text-xs text-slate-400">{L("Make sure the TV and the floor in front of it are in view. The back camera is recommended. Do not move it afterwards.", "テレビとその前の床が映るように。アウトカメラ（背面）がおすすめです。置いたら、あとで動かさないでください。")}</p>
              <div className="flex flex-wrap gap-2 text-xs">
                {(
                  [
                    ["environment", L("Back camera (recommended)", "アウトカメラ（おすすめ）")],
                    ["user", L("Front camera", "インカメラ")],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => switchSource(id)}
                    className={`px-3 py-1.5 rounded-lg border ${source === id ? "bg-orange-700 border-orange-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button onClick={() => startMonitoring("GPU")} className="w-full px-4 py-3 rounded-xl bg-orange-600 text-white text-base font-bold">
                {L("Start watching", "見守りを開始")}
              </button>
              {modelError && (
                <button onClick={() => startMonitoring("CPU")} className="w-full px-4 py-2 rounded-xl bg-slate-700 text-white text-sm font-bold">
                  {L("Retry on CPU", "CPU で再試行")}
                </button>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <p className="text-base text-white">{L("Now measure where the TV is (TV marker).", "テレビの位置を測ります（TVマーカー）。")}</p>
              <p className="text-xs text-slate-400">
                {L(
                  `The TV flashes black, then magenta. Do not touch this device meanwhile (the motion sensor is used too). TV ${tvInches}", lens height ${geo.heightCm} cm${screenBottomCm !== null ? `, screen bottom ${screenBottomCm} cm` : ""}. If any of these is wrong, fix it under "Calibration" below first.`,
                  `テレビが一瞬「黒 → マゼンタ」になります。そのあいだ端末に触らないでください（傾きセンサーも使います）。テレビ ${tvInches}型・レンズの高さ ${geo.heightCm}cm${screenBottomCm !== null ? `・画面の下端 ${screenBottomCm}cm` : ""}。違っていれば下の「キャリブレーション」で直してから押してください。`
                )}
              </p>
              <MotionNotice motion={motion} onAllow={() => void requestMotion().then(setMotion)} />
              <button onClick={() => void tvMarkerCalibrate()} disabled={tvBusy !== null || source === "debug"} className="w-full px-4 py-3 rounded-xl bg-cyan-700 text-white text-base font-bold disabled:opacity-40">
                {L("Calibrate on the TV", "テレビに表示してキャリブレーション")}
              </button>
              {tvBusy && <p className="text-sm text-cyan-300">{tvBusy}</p>}
              {tvError && <Banner tone="error" title={L("Calibration", "キャリブレーション")}><pre className="whitespace-pre-wrap text-[11px]">{tvError}</pre></Banner>}
            </>
          )}
        </section>
      ) : (
        <LocalLiveCard frame={frame} cameraOn={cameraOn} playing={playing} onBlackout={() => setBlackout(true)} />
      )}

      {/* Field-pilot mode (T2): always visible, colored, so nobody forgets which one is on */}
      <section
        className={`p-3 rounded-2xl border-2 space-y-2 ${
          mode === "shadow" ? "bg-sky-950/60 border-sky-400" : mode === "intervene" ? "bg-orange-950/40 border-orange-400" : "bg-slate-900 border-rose-500"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-xs text-slate-400">{L("Mode ", "モード ")}</span>
            <span className="text-lg font-black text-white">{mode ? MODE_LABEL[mode].title : L("not set", "未設定")}</span>
          </div>
          <div className="flex gap-1">
            {(["intervene", "shadow"] as const).map((m) => (
              <button
                key={m}
                onClick={() => chooseMode(m)}
                aria-pressed={mode === m}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border ${mode === m ? "bg-white text-slate-900 border-white" : "bg-slate-800 text-slate-200 border-slate-600"}`}
              >
                {MODE_LABEL[m].title}
              </button>
            ))}
          </div>
        </div>
        <div className="text-[11px] text-slate-300">{mode ? MODE_LABEL[mode].detail : L("Choose a mode (nothing is sent to the TV until you do)", "モードを選んでください（選ぶまで TV には何も送りません）")}</div>
        {modeError && <Banner tone="error" title={L("Cannot read the mode", "モードを読み込めません")}>{modeError}</Banner>}
      </section>

      {!secureContext && (
        <Banner tone="error" title={L("Open it over HTTPS", "HTTPS で開いてください")}>
          {L("The camera works only over a secure connection (HTTPS). Open the page again from the TV's QR code.", "カメラは安全な接続（HTTPS）でしか使えません。TVのQRコードから開き直してください。")}
        </Banner>
      )}

      {roleConflict && (
        <Banner tone="warn" title={L("This phone is your parent phone", "このスマホは保護者のスマホです")}>
          <p>
            {L(
              "This phone is already registered as the parent phone for this TV. The watch camera should be a different phone that stays by the TV. Make this phone the watch camera anyway?",
              "このスマホは、このテレビの保護者のスマホとして登録されています。見守りカメラは、テレビの近くに置く別のスマホにしてください。それでも、このスマホを見守りカメラにしますか？"
            )}
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              autoFocus
              onClick={() => {
                setRoleConflict(null);
                window.location.href = `${window.location.pathname.replace(/camera\/?$/, "")}parent/`;
              }}
              className="px-4 py-2 rounded-xl bg-indigo-700 text-white text-sm font-bold"
            >
              {L("No, open the parent page", "やめる（保護者のページを開く）")}
            </button>
            <button
              onClick={() => {
                tokenRef.current = roleConflict;
                setPendingToken(roleConflict);
                setRoleConflict(null);
              }}
              className="px-4 py-2 rounded-xl bg-slate-700 text-white text-sm font-bold"
            >
              {L("Use this phone as the watch camera", "このスマホを見守りカメラにする")}
            </button>
          </div>
        </Banner>
      )}

      {/* Connection details */}
      <details className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2" open={!paired}>
        <summary className="cursor-pointer text-sm font-bold text-white flex items-center gap-2">
          <Link2 className="w-4 h-4 text-orange-400" />{L(" Connection", " つながり")}
          <span className="font-normal text-xs text-slate-400">
            {paired
              ? L(
                  `(TV ${tvOnline ? "connected" : "not connected"} · parent phone ${parentOnline ? "connected" : "none"})`,
                  `（TV ${tvOnline ? "接続中" : "未接続"}・保護者のスマホ ${parentOnline ? "接続中" : "なし"}）`
                )
              : L("(not connected)", "（未接続）")}
          </span>
        </summary>
        {!paired && !pendingToken && (
          <p className="text-sm text-slate-300">{L("Scan the QR code on the TV with this device's camera.", "TVの画面に出ているQRコードを、この端末のカメラで読み取ってください。")}</p>
        )}
        {pendingToken && !paired && <p className="text-sm text-slate-300">{L("Pairing…", "ペアリング中…")}</p>}
        {paired && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill ok>{L("Paired", "ペアリング済み")}</Pill>
            <Pill ok={link === "open"}>{link === "open" ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />} {L("Relay", "中継")} {link}</Pill>
            <Pill ok={tvOnline}>TV {tvOnline ? L("connected", "接続中") : L("not connected", "未接続")}</Pill>
            <Pill ok={playing}>{playing ? L("Playing on the TV", "TVで再生中") : L("TV stopped (inference paused)", "TVは停止中（推論を休止）")}</Pill>
            <Pill ok={parentOnline}>{L("Parent phone", "保護者のスマホ")} {parentOnline ? L("connected", "接続中") : L("none", "なし")}</Pill>
            {previewCount > 0 && <Pill ok>{L(`Showing video to parents (${previewCount})`, `保護者に映像を表示中（${previewCount}台）`)}</Pill>}
          </div>
        )}
        {relayError && <Banner tone="error" title={L("Relay", "中継")}>{relayError}</Banner>}
      </details>

      {/* Camera */}
      <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-orange-400" />{L(" Camera", " カメラ")}
        </h2>
        <PoseModelPicker
          value={poseModel}
          busy={modelLoading !== null}
          accel={accelChoice}
          inferenceMs={monitoring && poseInfo ? inferenceMsShown : null}
          onAccel={(a) => {
            setAccelChoice(a);
            if (monitoring) void switchPoseModel(poseModel, a);
          }}
          onPick={(m) => (monitoring ? void switchPoseModel(m, accelChoice) : setPoseModel(m))}
        />
        {monitoring && poseDiag && <p className="text-[11px] text-slate-400 font-mono break-words">{poseDiag}</p>}
        {monitoring && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={keepCamera} onChange={(e) => setKeepCamera(e.target.checked)} />
            {L("Keep watching (inference) while the TV is stopped (to try a pose model at a desk)", "TV が止まっていても見守り（推論）を続ける（推論モデルを手元で試すとき）")}
          </label>
        )}
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={skeletonOnly} onChange={(e) => setSkeletonOnly(e.target.checked)} />
          {L("Skeleton only: hide the camera image here and in the parent's preview (to film without showing anyone)", "骨格だけ表示: この画面と保護者のプレビューでカメラの映像を隠す（人を映さずに撮影するとき）")}
        </label>
        {modelLoading && <p className="text-xs text-cyan-300">{modelLoading}</p>}
        {poseChoiceError && <Banner tone="error" title={L("Pose model", "推論モデル")}>{poseChoiceError}</Banner>}
        {monitoring && modelError && (
          <button onClick={() => void switchPoseModel(poseModel, "CPU")} className="px-4 py-2 rounded-xl bg-slate-700 text-white text-sm font-bold">
            {poseModel === "mediapipe-full" ? L("Retry on CPU", "CPU で再試行") : L("Retry on WASM (CPU)", "WASM（CPU）で再試行")}
          </button>
        )}
        {!monitoring ? (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => startMonitoring(accelChoice)} className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-bold">
              {L("Start watching (GPU)", "見守りを開始（GPU）")}
            </button>
            {modelError && (
              <button onClick={() => startMonitoring("CPU")} className="px-4 py-2 rounded-xl bg-slate-700 text-white text-sm font-bold">
                {L("Retry on CPU", "CPU で再試行")}
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill ok={poseInfo !== null}>
              {L("Inference", "推論")}: {poseInfo ? `${POSE_MODEL_INFO[poseInfo.model].label} (${poseInfo.accel === "GPU" ? (poseInfo.model === "mediapipe-full" ? "GPU" : "WebGPU") : poseInfo.model === "mediapipe-full" ? "CPU" : "WASM"}) · ${inferenceMsShown}ms · ${Math.round(effectiveFpsRef.current * 10) / 10}fps` : L("not loaded", "未読み込み")}
            </Pill>
            {poseInfo?.model === "mediapipe-full" ? (
              <>
              <Pill ok>
                {zoomRoiRef.current.roi
                  ? zoomArea
                    ? L("Also inferring zoomed in on the area drawn on the parent phone (cyan box)", "保護者のスマホで描いた範囲を拡大しても推論（水色の枠）")
                    : L("Also inferring on a zoomed view around the TV (cyan box)", "テレビまわりを拡大しても推論（水色の枠）")
                  : L("No zoomed pass (the area around the TV is already large; draw an area on the parent phone to zoom in)", "拡大推論なし（テレビまわりが大きく映っている。保護者のスマホで範囲を描くと拡大して探します）")}
              </Pill>
              {zoomArea && (
                <button onClick={() => setZoomArea(null)} className="px-2 py-0.5 rounded-lg bg-slate-700 text-white">
                  {L("Zoom area: back to auto", "拡大の範囲を自動に戻す")}
                </button>
              )}
              </>
            ) : poseInfo ? (
              <Pill ok={false}>
                {L(
                  "RTMO: no posture. Feet hidden: estimated from the hips for up to 4 s after the feet were last seen, and not while sitting down",
                  "RTMO: 姿勢の判定なし。足が隠れたら、最後に足が見えてから4秒まで腰から推定（座ったら推定しない）"
                )}
              </Pill>
            ) : null}
            <Pill ok={cameraOn}>{L("Camera", "カメラ")} {cameraOn ? "ON" : "OFF"}</Pill>
            <Pill ok={!wakeLockError}>{L("Screen on", "画面点灯")} {wakeLockError ? "NG" : L("kept", "維持中")}</Pill>
          </div>
        )}
        {monitoring && (
          <div className="space-y-1">
            <button onClick={() => setBlackout(true)} className="px-4 py-2 rounded-xl bg-slate-800 border border-slate-600 text-white text-sm font-bold flex items-center gap-2">
              <Moon className="w-4 h-4" />{L(" Darken the screen (watching continues)", " 画面を暗くする（見守りは続きます）")}
            </button>
            <p className="text-[11px] text-slate-500">
              {L("A browser stops the camera when the screen turns off, so the screen stays on but black (on an OLED screen this uses about as little power as off). Lowest brightness saves more. Tap the screen to bring it back; the parent phone can switch it too.", "ブラウザでは画面を消すとカメラが止まるため、画面は点けたまま真っ黒にします（有機ELの画面なら、ほぼ消灯と同じ電力）。端末の明るさを最低にすると、さらに省電力です。画面をタップすると戻ります。保護者のスマホからも切り替えられます。")}
            </p>
          </div>
        )}
        {modelError && <Banner tone="error" title={L("Model", "モデル")}>{modelError}</Banner>}
        {cameraError && <Banner tone="error" title={L("Camera", "カメラ")}>{cameraError}</Banner>}
        {monitoring && !floorModel && (
          <Banner tone="warn" title={L("Not calibrated", "未キャリブレーション")}>
            {L(
              `This input (${source === "user" ? "front camera" : source === "environment" ? "back camera" : "debug image"}) is not calibrated yet, so there is no distance and nothing is sent to the TV. Use "Next step" above or "Calibration" below.`,
              `この入力（${source === "user" ? "インカメラ" : source === "environment" ? "アウトカメラ" : "デバッグ画像"}）はまだキャリブレーションしていないため、距離を測れず、TVには何も送っていません。上の「次にやること」か下の「キャリブレーション」から行ってください。`
            )}
            {source === "debug" && sceneOf(debugImage) === "front" && (
              <button onClick={autoCalibrateDebug} disabled={calibStep !== null} className="mt-2 block px-3 py-1.5 rounded-lg bg-fuchsia-700 text-white font-bold disabled:opacity-40">
                {L("Front placement: auto calibration (from images standing at A then B)", "正面置き: 自動キャリブレーション（A→B に立った画像で測る）")}
              </button>
            )}
            {source === "debug" && sceneOf(debugImage) === "tv" && (
              <button onClick={() => tvMarkerCalibrate({ debug: true })} disabled={tvBusy !== null} className="mt-2 block px-3 py-1.5 rounded-lg bg-cyan-700 text-white font-bold disabled:opacity-40">
                {L("TV marker: auto calibration (from the black → magenta screen)", "TVマーカー: 自動キャリブレーション（画面の黒→マゼンタで測る）")}
              </button>
            )}
          </Banner>
        )}
        {wakeLockError && <Banner tone="warn" title="Wake Lock">{wakeLockError}</Banner>}

        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["environment", L("Back camera (recommended)", "アウトカメラ（おすすめ）")],
                ["user", L("Front camera", "インカメラ")],
                ["debug", L("Debug image", "デバッグ画像")],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => switchSource(id)}
                className={`px-3 py-1.5 rounded-lg border ${source === id ? "bg-orange-700 border-orange-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-slate-500">
            {source === "environment"
              ? L("Back camera: place the phone with its screen toward the wall. Higher quality and less distortion, so small children are easier to find. Once placed, check the view on the parent phone.", "アウトカメラ: 画面を壁側に向けて置きます。高画質で歪みが少なく、小さな子どもも見つけやすくなります。置いたあとの映像は保護者のスマホの「映像で確認」で見られます。")
              : source === "debug"
              ? L("Debug image: MediaPipe runs continuously on fixed images (generated, so the distances are not real). The front-placement and TV-marker scenes are separate rooms and cameras, each with its own calibration. The TV marker finds the screen corners from a black and a magenta frame (a generated 55\" scene, eye height about 1.25 m). The TV-marker room also has sitting upright / slouching / lying down for posture checks.", "デバッグ画像: 固定画像に MediaPipe をかけ続けます（生成画像なので実際の距離ではありません）。正面置きとTVマーカーの2つは別の部屋・別のカメラとして、キャリブレーションを別々に持ちます。TVマーカーは「画面が黒」と「画面がマゼンタ」の2枚から画面の四隅を見つけてスマホの位置を計算します（55型、視点の高さ約1.25mの生成画像）。TVマーカーの部屋には姿勢の確認用に「座って背筋ピン / 座って猫背 / 寝そべり」もあります。")
              : L("Front camera: place the phone with its screen toward the room. You can see the view while setting up, but many phones have a low-quality, very wide (distorted) front camera, and small children are easily lost.", "インカメラ: 画面を部屋側に向けて置きます。設置中に映像を確認できますが、画質が低く画角が広すぎる（歪む）機種が多く、小さな子どもを見失いやすくなります。")}
          </p>
          {source === "debug" && monitoring && (
            <div className="flex flex-wrap gap-2">
              <button onClick={autoCalibrateDebug} disabled={calibStep !== null} className="px-3 py-1.5 rounded-lg bg-fuchsia-800 border border-fuchsia-600 text-white font-bold disabled:opacity-40">
                {L("Front placement: auto calibration", "正面置き: 自動キャリブレーション")}
              </button>
              <button onClick={() => tvMarkerCalibrate({ debug: true })} disabled={tvBusy !== null} className="px-3 py-1.5 rounded-lg bg-cyan-800 border border-cyan-600 text-white font-bold disabled:opacity-40 flex items-center gap-1">
                <Tv className="w-3.5 h-3.5" />{L(" TV marker: auto calibration", " TVマーカー: 自動キャリブレーション")}
              </button>
            </div>
          )}
          {source === "debug" && (tvBusy || tvError) && (
            <div className="space-y-2">
              {tvBusy && <p className="text-cyan-300">{tvBusy}</p>}
              {tvError && <Banner tone="error" title={L("TV marker", "TVマーカー")}><pre className="whitespace-pre-wrap text-[11px]">{tvError}</pre></Banner>}
            </div>
          )}
          {source === "debug" && (
            <div className="flex flex-wrap gap-2">
              {DEBUG_IMAGES.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setDebugImage(d.id)}
                  className={`px-3 py-1.5 rounded-lg border ${debugImage === d.id ? "bg-fuchsia-700 border-fuchsia-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="relative rounded-xl overflow-hidden bg-black aspect-[4/3]">
          <video ref={videoRef} playsInline muted className={`absolute inset-0 w-full h-full object-cover ${source === "user" ? "-scale-x-100" : ""} ${source === "debug" ? "hidden" : ""} ${skeletonOnly ? "invisible" : ""}`} />
          {source === "debug" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img ref={imgRef} src={`/debug/${debugImage}.jpg`} alt={L("Debug image", "デバッグ画像")} className={`absolute inset-0 w-full h-full object-cover ${skeletonOnly ? "invisible" : ""}`} />
          )}
          <canvas ref={canvasRef} className={`absolute inset-0 w-full h-full object-cover ${source === "user" ? "-scale-x-100" : ""}`} />
          {monitoring && cameraOn && !inferring && (
            <div className="absolute bottom-2 inset-x-2 px-2 py-1 rounded-lg bg-black/70 text-[11px] text-slate-200 text-center">
              {L("Camera image only, for placing the phone. Watching (inference) starts when the TV plays.", "置き場所を決めるためのカメラ映像です。見守り（推論）は TV で再生が始まると動きます。")}
            </div>
          )}
          {skeletonOnly && (
            <button onClick={() => setSkeletonOnly(false)} className="absolute top-2 left-2 px-2 py-1 rounded-lg bg-white/90 text-slate-900 text-[11px] font-bold">
              {L("Skeleton only: the camera image is hidden — tap to show it", "骨格だけ表示中: カメラの映像は隠しています — タップで表示")}
            </button>
          )}
          {!cameraOn && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
              {monitoring ? L("Camera off while this screen is dark and the TV is not playing", "画面が暗く、TV が再生していない間はカメラを止めています") : L("Camera stopped", "カメラ停止中")}
            </div>
          )}
        </div>
      </section>

      {/* Calibration */}
      <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Ruler className="w-4 h-4 text-orange-400" />{L(" Calibration and distances", " キャリブレーションと判定の距離")}
          <span className="font-normal text-xs text-slate-400">{floorModel ? L("(done)", "（済み）") : L("(not yet)", "（未）")}</span>
        </h2>
        {floorModel && !calOpen && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="flex-1">
              {L(
                `Locked: too close ${settings.tooCloseM.toFixed(2)} m / safe ${settings.safeM.toFixed(2)} m. Set once; change it from the parent phone, or here.`,
                `ロック中: 近すぎ ${settings.tooCloseM.toFixed(2)}m / 安全 ${settings.safeM.toFixed(2)}m。一度決めたら触らない設定です。保護者のスマホか、ここから変えられます。`
              )}
            </span>
            <button onClick={() => setCalEditing(true)} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white font-bold shrink-0">
              {L("Change", "変える")}
            </button>
          </div>
        )}
        {floorModel && calOpen && (
          <button onClick={() => setCalEditing(false)} className="px-3 py-1.5 rounded-lg bg-cyan-700 text-white text-xs font-bold">
            {L("Done (lock the setup)", "完了（設定をロック）")}
          </button>
        )}
        {calOpen && (
        <>
        <MotionNotice motion={motion} onAllow={() => void requestMotion().then(setMotion)} />

        <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 space-y-2 text-xs">
          <div className="font-bold text-slate-200">{L("Thresholds (distance from the TV screen)", "判定のしきい値（テレビ画面からの距離）")}</div>
          <Slider
            label={L("Too close (closer than this, a strong blur)", "近すぎ（これより近いと強くぼかす）")}
            value={settings.tooCloseM}
            min={0.6}
            max={2.5}
            onChange={(v) => updateSetting("tooCloseM", v)}
          />
          <Slider
            label={L("Safe (farther than this, clear; in between, a light blur as a hint)", "安全（これより離れるとクリア。間はうっすらぼかして知らせる）")}
            value={settings.safeM}
            min={0.7}
            max={3.5}
            onChange={(v) => updateSetting("safeM", v)}
          />
          <p className="text-[11px] text-slate-500">
            {L("Between \"Safe\" and \"Too close\" the blur is light (a hint); past \"Too close\" it is strong, strongest 0.3 m inside it. Red (too close) and green (safe) lines show them on the video. \"Safe\" stays at least 0.1 m beyond \"Too close\": moving one shifts the other.", "「安全」と「近すぎ」の間はうっすら（ヒント程度）、「近すぎ」を越えると強くぼかし、その 0.3m 手前で最大になります。映像に赤（近すぎ）と緑（安全）の線で表示します。「安全」は「近すぎ」より0.1m以上遠くなるよう、片方を動かすともう片方が自動でずれます。")}
          </p>
          {settingsError && <Banner tone="error" title={L("Thresholds", "しきい値")}>{settingsError}</Banner>}
        </div>

        <div className="rounded-xl border border-cyan-800 bg-cyan-950/30 p-3 space-y-2 text-xs">
          <div className="font-bold text-cyan-200 flex items-center gap-1">
            <Tv className="w-4 h-4" />{L(" TV-marker calibration (recommended, no tape)", " TVマーカーでキャリブレーション（おすすめ・テープ不要）")}
          </div>
          <p className="text-slate-300">
            {L("Place the phone on a shelf at the side of the room so that", "スマホを部屋の横の棚などに置き、")}{" "}
            <b>{L("both the TV screen and the floor in front of it are in view", "テレビの画面とその前の床が両方映る")}</b>
            {L(
              ". When you press the button, the TV flashes black, then magenta, and the phone finds the screen's corners from the difference. With the screen size as a ruler (and the motion sensor fixing which way is up), it solves the camera and its own position, and maps the floor. No floor markers needed.",
              "ようにします。ボタンを押すと、テレビが一瞬「黒 → マゼンタ」に切り替わり、スマホがその差分から画面の四隅を見つけます。画面の大きさ（型）を物差しにして、カメラの画角とスマホの位置を計算し、床の距離を出します。テープもメジャーでの距離測定も要りません。"
            )}
          </p>
          <p className="text-slate-500">
            {L("It does not work from right beside the TV (in the plane of the screen), where the screen is barely visible. Place the phone so it sees the TV at an angle from the front; straight on does not work either.", "テレビの真横（画面と同じ面）からは画面がほぼ見えないので使えません。テレビを斜め前から見る位置に置いてください。正面すぎても画角が求まりません。")}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <NumField label={L("TV size (inches)", "テレビの大きさ（型・インチ）")} value={tvInches} min={20} max={100} step={1} onChange={setTvInches} />
            <NumField label={L("Phone lens height above the floor (cm)", "スマホのレンズの床からの高さ (cm)")} value={geo.heightCm} min={10} max={200} step={1} onChange={(v) => setGeo({ ...geo, heightCm: v })} />
            <label className="block space-y-1 col-span-2">
              <span className="text-slate-400">{L("Screen-bottom height above the floor (cm, optional; corrects a wrong TV size automatically)", "テレビ画面の下端の床からの高さ (cm・任意。入れると、テレビの大きさの入力違いを自動で直します)")}</span>
              <input
                type="number"
                min={0}
                max={200}
                step={1}
                value={screenBottomCm ?? ""}
                placeholder={L("e.g. 50", "例: 50")}
                onChange={(e) => setScreenBottomCm(e.target.value === "" ? null : Number(e.target.value))}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-white"
              />
            </label>
          </div>
          <button
            onClick={() => tvMarkerCalibrate()}
            disabled={tvBusy !== null || !monitoring || source === "debug"}
            className="px-3 py-1.5 rounded-lg bg-cyan-700 text-white font-bold disabled:opacity-40 flex items-center gap-1"
          >
            <Tv className="w-3.5 h-3.5" /> {L("Calibrate on the TV", "テレビに表示してキャリブレーション")}
          </button>
          {source === "debug" && <p className="text-slate-500">{L("With debug images, use \"TV marker: auto calibration\" above.", "デバッグ画像では上の「TVマーカー: 自動キャリブレーション」を使います。")}</p>}
          {tvBusy && <p className="text-cyan-300">{tvBusy}</p>}
          {tvError && <pre className="whitespace-pre-wrap text-[11px] text-rose-300">{tvError}</pre>}
          {tvReport && <pre className="whitespace-pre-wrap text-[11px] text-slate-300">{tvReport}</pre>}
          {tvPreview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tvPreview} alt={L("Detected screen corners", "検出した画面の四隅")} className="w-full h-auto rounded-lg" />
          )}
          {measureBusy && <p className="text-cyan-300">{measureBusy}</p>}
          <ZoneAdjustPanel
            adjust={floorModel && isHomography(floorModel) && floorModel.tvPose ? floorModel.tvPose.adjust ?? NO_ADJUST : null}
            measuredPoints={measuredCount}
            disabled={!monitoring || measureBusy !== null || tvBusy !== null}
            onAdjust={(a) => {
              try {
                setCalibMessage(setZoneAdjust(a));
              } catch (err) {
                setCalibMessage((err as Error).message);
              }
            }}
            onMeasure={(trueM, step) => void measureDistance(trueM, step).then((r) => setCalibMessage(r.message))}
          />
        </div>

        {floorModel && <CoveragePanel model={floorModel} settings={settings} mirrored={source === "user"} />}

        <details className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs text-slate-300" open={frozen !== null || calibStep !== null}>
          <summary className="cursor-pointer font-bold text-slate-400">{L("Other methods (development and validation; the TV marker is normally all you need)", "ほかの方法（開発・検証用。ふつうは TVマーカーだけで足ります）")}</summary>
          <div className="mt-3 space-y-3">
        <div className="font-bold text-slate-200 text-xs pt-1">{L("A. Standing calibration (phone placed in front)", "A. 立ってキャリブレーション（スマホを正面に置く場合）")}</div>
        <p className="text-xs text-slate-400">
          {L("Tape marks on the floor, stand on each, and press A then B. The sliders set the mark distances.", "床にテープで印をつけ、それぞれの上に立って A → B の順に押します。印の距離はスライダーで変えられます。")}
        </p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Slider label={L("Mark A", "印 A")} value={settings.markerAM} min={0.5} max={3.3} onChange={(v) => updateSetting("markerAM", v)} />
          <Slider label={L("Mark B", "印 B")} value={settings.markerBM} min={0.7} max={3.5} onChange={(v) => updateSetting("markerBM", v)} />
        </div>
        <div className="flex gap-2">
          {(["A", "B"] as const).map((s) => (
            <button
              key={s}
              disabled={!monitoring || calibStep !== null}
              onClick={() => runCalibrationStep(s)}
              className="px-4 py-2 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm font-bold disabled:opacity-40"
            >
              {s}: {s === "A" ? settings.markerAM : settings.markerBM}m {calibStep === s ? L("measuring…", "計測中…") : ""}
            </button>
          ))}
        </div>
        {calibMessage && <p className="text-xs text-slate-300">{calibMessage}</p>}
        {floorModel && edge.value !== null && (
          <div className="text-xs space-y-1">
            <p className="text-slate-300">
              {L("Distance where the feet leave the bottom of the view", "足が画面の下端から消える距離")} d_edge = <span className="font-mono text-white">{edge.value.toFixed(2)}m</span>{" "}
              {L("(closer than this: BELOW_FRAME, full blur)", "（これより近いと「BELOW_FRAME」で最大ブラー）")}
            </p>
            {edge.value > MAX_ACCEPTABLE_EDGE_DISTANCE_M ? (
              <Banner tone="warn" title={L("Placement", "設置ガイド")}>
                {L(
                  `Point the camera a little lower (d_edge is over ${MAX_ACCEPTABLE_EDGE_DISTANCE_M} m). Calibrate again after turning it.`,
                  `カメラをもう少し下へ向けてください（d_edge が ${MAX_ACCEPTABLE_EDGE_DISTANCE_M}m を超えています）。向きを変えたら再キャリブレーションしてください。`
                )}
              </Banner>
            ) : (
              <p className="text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />{L(" Placement OK", " 設置OK")}
              </p>
            )}
          </div>
        )}
        {edge.error && <Banner tone="error" title={L("Calibration", "キャリブレーション")}>{edge.error}</Banner>}
        {floorModel && (
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-3 text-slate-300">
              <span className="shrink-0">{L("Floor bottom line", "床の下端ライン")}</span>
              <div className="flex-1">
                <TouchSlider
                  label={L("Floor bottom line", "床の下端ライン")}
                  min={0.5}
                  max={1}
                  step={0.01}
                  value={floorModel.floorBottomY ?? 1}
                  onChange={(v) => saveModel({ ...floorModel, floorBottomY: v })}
                />
              </div>
              <span className="font-mono text-white w-10 text-right">{(floorModel.floorBottomY ?? 1).toFixed(2)}</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {L("When a TV stand top or similar shows at the bottom of the view, set this to the lowest visible floor (yellow line). Feet disappearing below the dashed red line trigger BELOW_FRAME.", "映像の下にテレビ台の天板などが写っているときは、床が見えている一番下（黄色の線）に合わせます。足がこの線の手前（赤い点線より下）で消えると BELOW_FRAME になります。")}
            </p>
          </div>
        )}
        {floorModel && (
          <p className="text-[11px] text-slate-500">
            {L("Model in use", "使用中のモデル")}:{" "}
            {isHomography(floorModel) && floorModel.method === "tv_marker"
              ? L("TV marker (field of view and phone position from the screen corners)", "TVマーカー（画面の四隅から画角とスマホの位置を計算）")
              : isHomography(floorModel)
              ? L("Tapped lines (floor homography, any placement)", "タップ（床の射影変換、置き方を問わない）")
              : floorModel.method === "geometry"
              ? L("Approximate (from height, tilt and field of view)", "簡易（高さ・傾き・画角からの概算）")
              : L("Two-point standing calibration", "立って測る2点キャリブレーション")}
          </p>
        )}


        <details className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs text-slate-300" open={frozen !== null}>
          <summary className="cursor-pointer font-bold text-slate-200">{L("B. Tap calibration (works beside or diagonal to the TV too)", "B. タップでキャリブレーション（テレビの横・斜めに置く場合も可）")}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-slate-400">
              {L("Uses three floor lines parallel to the TV (two tapes plus the front of the TV stand or a rug edge). Set each distance, then tap each line at two or more places on the frozen frame. Nobody needs to stand. The frame never leaves this phone.", "テレビと平行な床の線を3本使います（テープ2本＋テレビ台の前端やラグの端など）。それぞれの距離を設定し、固定した映像の上で各線を2か所以上タップします。人は立たなくて大丈夫です。タップの映像はこのスマホから出ません。")}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {tapLines.map((l, i) => (
                <button
                  key={i}
                  onClick={() => setActiveLine(i)}
                  className={`p-2 rounded-lg border text-left ${activeLine === i ? "border-white" : "border-slate-700"}`}
                  style={{ background: `${LINE_COLORS[i]}22` }}
                >
                  <div className="font-bold" style={{ color: LINE_COLORS[i] }}>
                    {L(`Line ${i + 1} (${l.points.length} points)`, `線${i + 1}（${l.points.length}点）`)}
                  </div>
                  <input
                    type="number"
                    step={0.05}
                    min={0.1}
                    max={5}
                    value={l.distanceM}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setTapLines((ls) => ls.map((x, j) => (j === i ? { ...x, distanceM: Number(e.target.value) } : x)))}
                    className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-1 py-0.5 text-white"
                  />
                  <span className="text-slate-500">m</span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={freezeFrame} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white">
                {frozen ? L("Capture again", "映像を撮り直す") : L("Freeze the current frame", "今の映像を固定")}
              </button>
              <button
                onClick={() => setTapLines((ls) => ls.map((l, i) => (i === activeLine ? { ...l, points: l.points.slice(0, -1) } : l)))}
                className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white"
              >
                {L(`Delete the last point of line ${activeLine + 1}`, `線${activeLine + 1}の最後の点を消す`)}
              </button>
              <button onClick={applyTapCalibration} disabled={!frozen} className="px-3 py-1.5 rounded-lg bg-orange-700 text-white font-bold disabled:opacity-40">
                {L("Apply these three lines", "この3本で適用")}
              </button>
            </div>
            {frozen && (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={frozen} alt={L("Frozen frame", "固定した映像")} onClick={onTap} className="w-full h-auto rounded-lg cursor-crosshair select-none" />
                {tapLines.flatMap((l, i) =>
                  l.points.map((p, k) => (
                    <span
                      key={`${i}-${k}`}
                      className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white pointer-events-none"
                      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: LINE_COLORS[i] }}
                    />
                  ))
                )}
                <p className="mt-1 text-slate-500">
                  {L(
                    `Selected: line ${activeLine + 1}. Tap on the tape (line) on the floor (this is the real, unmirrored frame, even with the front camera).`,
                    `いま選んでいる線: 線${activeLine + 1}。床のテープ（線）の上をタップしてください（インカメラでも左右反転していない実際の映像です）。`
                  )}
                </p>
              </div>
            )}
          </div>
        </details>

        <details className="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs text-slate-300">
          <summary className="cursor-pointer font-bold text-slate-200">{L("C. Start without tape: approximate calibration", "C. テープなしで始める：簡易キャリブレーション（概算）")}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-slate-400">
              {L("Builds a distance model from the lens height, the downward tilt and the vertical field of view. Less accurate than a two-point calibration.", "スマホのレンズの床からの高さ、下向きの傾き、カメラの縦の画角から距離モデルを計算します。精度は2点キャリブレーションより下がります。")}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <NumField label={L("Height (cm)", "高さ (cm)")} value={geo.heightCm} min={10} max={200} step={1} onChange={(v) => setGeo({ ...geo, heightCm: v })} />
              <NumField label={L("Tilt down (°)", "下向き (°)")} value={geo.pitchDownDeg} min={-20} max={70} step={1} onChange={(v) => setGeo({ ...geo, pitchDownDeg: v })} />
              <NumField label={L("Vertical field of view (°)", "縦の画角 (°)")} value={geo.vfovDeg} min={30} max={100} step={1} onChange={(v) => setGeo({ ...geo, vfovDeg: v })} />
            </div>
            <p className="text-[11px] text-slate-500">
              {L("Typical field of view: 60–70° in portrait, 45–55° in landscape (front camera).", "画角の目安: 縦向きに置いたとき 60〜70°、横向きのとき 45〜55°（前面カメラ）。")}
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={measureTilt} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white">
                {L("Measure the tilt with the sensor", "傾きをセンサーで測る")}
              </button>
              <button onClick={applyGeometry} className="px-3 py-1.5 rounded-lg bg-orange-700 text-white font-bold">
                {L("Apply these values", "この値で適用")}
              </button>
            </div>
            {tiltMessage && <p className="text-slate-400">{tiltMessage}</p>}
          </div>
        </details>
          </div>
        </details>
        </>
        )}
      </section>

      <details className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-4">
        <summary className="cursor-pointer text-sm font-bold text-slate-300">{L("Development and validation (test mode, numbers, distance check)", "開発・検証用（テストモード・数値・距離の検証）")}</summary>

      {/* Test mode */}
      <section className="p-4 rounded-2xl bg-slate-900 border border-fuchsia-900/60 space-y-3">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-fuchsia-400" />{L(" Test mode (development and demo)", " テストモード（開発・デモ確認用）")}
        </h2>
        <p className="text-xs text-slate-400">
          {L("Sends a chosen distance to the TV through the real relay, without the camera. The TV shows \"Test input\" and records nothing.", "カメラを使わず、指定した距離を実際の中継経由でTVに送ります。TVには「テスト入力中」と表示され、記録には残りません。")}
        </p>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={testMode} disabled={!paired} onChange={(e) => setTestMode(e.target.checked)} />
          {L("Send test input", "テスト入力を送る")}
        </label>
        {testMode && (
          <div className="space-y-2 text-xs">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <TouchSlider
                  label={L("Test distance", "テストの距離")}
                  accent="#c026d3"
                  min={0.6}
                  max={3}
                  step={0.05}
                  value={testInput.d}
                  onChange={(v) => setTestInput({ ...testInput, kind: "distance", d: v })}
                />
              </div>
              <span className="font-mono text-white w-14 text-right">{testInput.d.toFixed(2)}m</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setTestInput({ ...testInput, kind: "distance" })} className={`px-3 py-1.5 rounded-lg border ${testInput.kind === "distance" ? "bg-fuchsia-700 border-fuchsia-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}>
                {L("Distance", "距離")}
              </button>
              <button onClick={() => setTestInput({ ...testInput, kind: "below" })} className={`px-3 py-1.5 rounded-lg border ${testInput.kind === "below" ? "bg-fuchsia-700 border-fuchsia-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}>
                {L("Feet left the bottom (BELOW_FRAME)", "足が下端から消えた（BELOW_FRAME）")}
              </button>
              <button onClick={() => setTestInput({ ...testInput, kind: "lost" })} className={`px-3 py-1.5 rounded-lg border ${testInput.kind === "lost" ? "bg-fuchsia-700 border-fuchsia-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}>
                {L("Lost (LOW_CONFIDENCE)", "見失う（LOW_CONFIDENCE）")}
              </button>
              <button onClick={() => setTestInput({ ...testInput, slouch: !testInput.slouch })} className={`px-3 py-1.5 rounded-lg border ${testInput.slouch ? "bg-fuchsia-700 border-fuchsia-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"}`}>
                {L("Slouch", "猫背")} (SLOUCH) {testInput.slouch ? "ON" : "OFF"}
              </button>
            </div>
            <p className="text-slate-500">
              {L("Posture nudge (child cues only): after 4 s of slouching or lying down at a safe distance, the TV says \"Let's sit up tall\" once (then waits 30 s). It never blurs.", "姿勢の声かけは、安全な距離（SAFE）で猫背・寝そべりが4秒続くと1回（30秒あけて）TVが「せなかを ピンと のばそう」と言います。ブラーはかけません（姿勢は距離ほど危険ではないので、視聴を止めない設計）。")}
            </p>
            {!tvOnline && <p className="text-amber-300">{L("The TV is not connected to the relay.", "TVが中継に接続されていません。")}</p>}
            {testFrame && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat label={L("State", "状態")} value={testFrame.state} />
                <Stat label={L("Blur", "ブラー")} value={`${testFrame.blurPx}px`} />
                <Stat label={L("Event", "イベント")} value={testFrame.event ?? "—"} />
              </div>
            )}
          </div>
        )}
      </section>

      {/* Live numbers */}
      {frame && (
        <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 grid grid-cols-3 gap-2 text-center text-xs">
          <Stat label={L("State", "状態")} value={frame.state} />
          <Stat label={L("Distance", "距離")} value={frame.distanceM === null ? "—" : `${frame.distanceM.toFixed(2)}m`} />
          <Stat label={L("Blur", "ブラー")} value={`${frame.blurPx}px`} />
          <Stat label={L("Feet", "足元")} value={frame.foot.status} />
          <Stat label={L("Inference", "推論")} value={`${effectiveFpsRef.current.toFixed(1)}/${frame.fps}fps · ${Math.round(inferenceMsRef.current)}ms`} />
          <Stat label={L("People", "人数")} value={L(`${frame.peopleCount} (rejected ${frame.verdicts.filter((v) => !v.accepted).length})`, `${frame.peopleCount}（除外 ${frame.verdicts.filter((v) => !v.accepted).length}）`)} />
          <Stat
            label={L("Posture", "姿勢")}
            value={`${frame.posture}${frame.postureAngles ? L(` torso ${frame.postureAngles.torsoDeg}° neck ${frame.postureAngles.neckDeg}°`, ` 胴${frame.postureAngles.torsoDeg}° 首${frame.postureAngles.neckDeg}°`) : ""}`}
          />
          <Stat label={L("Event", "イベント")} value={frame.event ?? "—"} />
          <p className="col-span-3 text-slate-500">
            {L("Last event", "最後のイベント")}: {lastEvent ? `${lastEvent.event} (${new Date(lastEvent.at).toLocaleTimeString()})` : "—"}
            {L(
              " · The posture nudge (POSTURE_NUDGE) fires after 4 s of slouching or lying down at a safe distance (also with the feet hidden, if the last state was safe).",
              "・姿勢の声かけ（POSTURE_NUDGE）は、安全な距離で猫背・寝そべりが4秒続くと出ます（足が隠れていても、直前が安全なら可）。"
            )}
          </p>
        </section>
      )}

      <DistanceTrialPanel trials={distanceTrials} method={trialMethod} />
      </details>

      {paired && (
        <p className="text-center text-xs text-slate-500">
          {L("After setup, adjust and review from a parent phone (on the TV press OK → scan the \"Add a parent phone\" QR code).", "設置後の調整と振り返りは、保護者のスマホで行えます（TVで決定 →「保護者のスマホを登録」のQRを読み取る）。")}
          <a href="/parent/" className="ml-1 text-orange-400 underline">
            {L("See the records on this phone →", "このスマホで振り返りを見る →")}
          </a>
        </p>
      )}
    </main>
  );
}

function frameToJpeg(el: CanvasImageSource, w: number, h: number, maxSide: number): string {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** The analyzed frame with the detected screen outline, for the parent to check. */
/** The magenta frame with the raw screen mask (before hole filling) tinted green. */
function drawMaskPreview(on: RgbaImage & { el: CanvasImageSource; w: number; h: number }, off: RgbaImage): string {
  const mask = magentaMask(on, off);
  const c = document.createElement("canvas");
  c.width = on.w;
  c.height = on.h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  ctx.drawImage(on.el, 0, 0, on.w, on.h);
  const img = ctx.getImageData(0, 0, on.w, on.h);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    img.data[i * 4] = img.data[i * 4] >> 1;
    img.data[i * 4 + 1] = 128 + (img.data[i * 4 + 1] >> 1);
    img.data[i * 4 + 2] = img.data[i * 4 + 2] >> 1;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/jpeg", 0.85);
}

function drawQuadPreview(el: CanvasImageSource, w: number, h: number, q: { x: number; y: number }[]): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  ctx.drawImage(el, 0, 0, w, h);
  ctx.strokeStyle = "#22d3ee";
  ctx.lineWidth = 2;
  ctx.beginPath();
  q.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * w, p.y * h) : ctx.lineTo(p.x * w, p.y * h)));
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = "#22d3ee";
  ctx.font = `bold ${Math.round(h * 0.04)}px sans-serif`;
  [L("TL", "左上"), L("TR", "右上"), L("BR", "右下"), L("BL", "左下")].forEach((t, i) => {
    ctx.beginPath();
    ctx.arc(q[i].x * w, q[i].y * h, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(t, q[i].x * w + 6, q[i].y * h - 6);
  });
  return c.toDataURL("image/jpeg", 0.85);
}

/** Watch-zone summary: how much of the floor in front of the TV is covered, and what to change. */
function CoveragePanel({ model, settings, mirrored }: { model: FloorModel; settings: Settings; mirrored: boolean }) {
  let r: CoverageReport;
  try {
    r = computeCoverage(model, { tooCloseM: settings.tooCloseM, safeM: settings.safeM, floorBottomY: model.floorBottomY });
  } catch (err) {
    return <Banner tone="error" title={L("Watch zone", "見守りエリア")}>{(err as Error).message}</Banner>;
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  // Hints refer to the preview as the parent sees it (the selfie preview is mirrored).
  const side = (t: "left" | "right") => ((t === "left") !== mirrored ? L("left", "左") : L("right", "右"));
  const hint =
    r.turn === null
      ? null
      : r.turn === "left" || r.turn === "right"
      ? L(
          `Part of the too-close zone is off the ${side(r.turn)} edge of the view. Turn the phone a little to the ${side(r.turn)}.`,
          `近すぎエリアの一部が映像の${side(r.turn)}の外にあります。スマホを${side(r.turn)}側へ少し向けてください。`
        )
      : r.turn === "down"
      ? L("Part of the too-close zone is below the view. Point the phone a little lower, or place it farther from the TV (with the TV marker, keeping the screen in view).", "近すぎエリアの一部が映像の下の外にあります。スマホを少し下へ向けるか、テレビから離れた位置に置いてください（TVマーカーでは、画面も映る範囲で）。")
      : r.turn === "up"
      ? L("Part of the too-close zone is above the view. Point the phone a little higher.", "近すぎエリアの一部が映像の上の外にあります。スマホを少し上へ向けてください。")
      : L("Part of the too-close zone is behind the camera. Place the phone a little farther from the TV.", "近すぎエリアの一部がカメラの後ろ側にあります。スマホをテレビからもう少し離して置いてください。");
  const ok = r.tooCloseVisible >= 0.95;
  return (
    <div className={`rounded-xl border p-3 text-xs space-y-1 ${ok ? "border-emerald-800 bg-emerald-950/30" : "border-amber-700 bg-amber-950/30"}`}>
      <div className="font-bold text-slate-200">{L("Watch zone (on the video: red = too close, amber = approaching, green = safe)", "見守りエリア（映像に色で表示: 赤=近すぎ・黄=注意・緑=安全）")}</div>
      {r.zoneVisible !== null && (
        <p className="text-slate-300">
          {L(
            `Area around the TV (${ZONE_NEAR_M}–${(settings.safeM + 0.8).toFixed(1)} m from the screen; straight in front, rounded beside it) in view:`,
            `テレビのまわり（画面から ${ZONE_NEAR_M}〜${(settings.safeM + 0.8).toFixed(1)}m。正面はまっすぐ、画面の横は丸く）のうち映っている割合:`
          )}{" "}
          <b>{pct(r.zoneVisible)}</b>
        </p>
      )}
      <p className="text-slate-300">
        {L(
          `Too-close ${r.zoneVisible === null ? "line" : "zone"} (${ZONE_NEAR_M}–${settings.tooCloseM.toFixed(2)} m) in view:`,
          `近すぎエリア（${ZONE_NEAR_M}〜${settings.tooCloseM.toFixed(2)}m）${r.zoneVisible === null ? "の線" : ""}が映っている割合:`
        )}{" "}
        <b>{pct(r.tooCloseVisible)}</b>
      </p>
      {r.cmPerPixel !== null && (
        <p className="text-slate-400">
          {L(
            `Resolution at the too-close line: one pixel at the feet is about ${r.cmPerPixel.toFixed(1)} cm (in a 480-pixel frame)`,
            `近すぎの線での細かさ: 足元が1画素ずれると約 ${r.cmPerPixel.toFixed(1)}cm（480画素の映像で）`
          )}
        </p>
      )}
      {r.zoneVisible === null && <p className="text-slate-500">{L("This method only knows distance; calibrate with the TV marker to see the left/right extent.", "この方式は距離しか分からないため、左右の範囲はTVマーカーでキャリブレーションすると表示されます。")}</p>}
      {ok ? (
        <p className="text-emerald-400 flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" />{L(" The whole too-close zone is in view", " 近すぎエリアはすべて見えています")}
        </p>
      ) : (
        hint && <p className="text-amber-300">{hint}</p>
      )}
    </div>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <span className="flex justify-between text-slate-400">
        <span>{props.label}</span>
        <span className="font-mono text-white">{props.value.toFixed(2)}m</span>
      </span>
      <TouchSlider label={props.label} min={props.min} max={props.max} step={0.05} value={props.value} onChange={props.onChange} />
    </div>
  );
}

function NumField(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="space-y-1">
      <span className="block text-slate-500">{props.label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-white"
      />
    </label>
  );
}

const LIVE_TONE = {
  ok: "bg-emerald-950/60 border-emerald-600 text-emerald-100",
  warn: "bg-amber-950/60 border-amber-600 text-amber-100",
  bad: "bg-rose-950/60 border-rose-600 text-rose-100",
  none: "bg-slate-900 border-slate-700 text-slate-200",
} as const;

/** Once everything is set: what the camera sees, large, and the screen-off button. */
function LocalLiveCard({ frame, cameraOn, playing, onBlackout }: { frame: PipelineFrame | null; cameraOn: boolean; playing: boolean; onBlackout: () => void }) {
  const st = frame && cameraOn ? STATE_LABEL[frame.state] : null;
  return (
    <section className={`p-4 rounded-2xl border-2 space-y-2 ${LIVE_TONE[st?.tone ?? "none"]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xl font-black">{st ? st.text : playing ? L("Starting the camera…", "カメラを起動しています…") : L("Resting while the TV is stopped", "TVが止まっているあいだは休んでいます")}</div>
        <div className="text-3xl font-black text-white">{st && frame?.distanceM != null ? `${frame.distanceM.toFixed(2)}m` : ""}</div>
      </div>
      {st && frame && (
        <div className="text-xs opacity-80">
          {frame.distanceSource === "hips" ? L("Feet hidden, estimated from the hips · ", "足元が隠れているので腰から推定・") : frame.distanceSource === "seated" ? L("Seated: measured under the head, not the feet · ", "座っているので足ではなく頭の位置で計測・") : ""}
          {L("TV blur", "TVのぼかし")} {frame.blurPx > 0 ? L("on", "あり") : L("off", "なし")} · {L("People in view", "映っている人")} {frame.peopleCount}
        </div>
      )}
      <button onClick={onBlackout} className="w-full mt-1 px-4 py-2 rounded-xl bg-black/40 border border-white/20 text-white text-sm font-bold flex items-center justify-center gap-2">
        <Moon className="w-4 h-4" />{L(" Darken the screen and keep watching (tap to come back)", " 画面を暗くして見守る（タップで戻ります）")}
      </button>
    </section>
  );
}

/** The tilt sensor makes the TV-marker calibration several times more accurate; say when it is missing. */
function MotionNotice({ motion, onAllow }: { motion: MotionState | null; onAllow: () => void }) {
  if (motion === "ok") return <p className="text-xs text-emerald-300">{L("Motion sensor: available (more accurate calibration)", "傾きセンサー: 使えます（キャリブレーションの精度が上がります）")}</p>;
  return (
    <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-600/60 text-amber-100 text-xs space-y-2">
      <div>
        {L("Motion sensor", "傾きセンサー")}: <b>{motion ? MOTION_STATE_LABEL[motion] : L("not checked yet", "まだ確認していません")}</b>.{" "}
        {L("Without it, distances can be far off when the TV looks small in the view.", "使えないと、テレビが小さく映る置き方では距離が大きくずれることがあります。")}
      </div>
      <button onClick={onAllow} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-bold">
        {L("Allow the motion sensor (tap on this device)", "傾きセンサーを許可する（この端末でタップ）")}
      </button>
      {(motion === "denied" || motion === "no-data") && (
        <p className="text-amber-200/80">
          {L("If no permission prompt appears, allow \"Motion sensors\" (or \"Motion & Orientation\") for this site in the browser's site settings. Privacy-focused browsers may block it by default; Chrome (Android) or Safari (iPhone, iPad) also work.", "許可の確認が出ないときは、ブラウザのサイト設定で「モーションセンサー」（または「動きと向き」）をこのサイトに許可してください。プライバシー重視のブラウザでは既定で止められていることがあります。Chrome（Android）や Safari（iPhone・iPad）でも試せます。")}
        </p>
      )}
    </div>
  );
}

/** The pose estimator choice. MediaPipe (standard) is the default; RTMO (high accuracy) has no 3D points. */
function PoseModelPicker({ value, busy, accel, inferenceMs, onAccel, onPick }: { value: PoseModelId; busy: boolean; accel: Delegate; inferenceMs: number | null; onAccel: (a: Delegate) => void; onPick: (m: PoseModelId) => void }) {
  return (
    <div className="space-y-1">
      <WhoWatches value={value} disabled={busy} inferenceMs={inferenceMs} onPick={onPick} />
      <div className="flex items-center gap-1 text-xs text-slate-400">
        {L("Run on", "実行先")}
        {(["GPU", "CPU"] as const).map((a) => (
          <button
            key={a}
            disabled={busy || a === accel}
            onClick={() => onAccel(a)}
            className={`px-2.5 py-1 rounded-lg font-bold border disabled:opacity-60 ${a === accel ? "bg-white text-slate-900 border-white" : "bg-slate-800 text-slate-200 border-slate-600"}`}
          >
            {value === "mediapipe-full" ? a : a === "GPU" ? "WebGPU" : "WASM (CPU)"}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        {L(
          "Check on the video that the skeleton (face included) sits on the person; if a model does not work well, switch back. Nothing switches by itself.",
          "映像の骨格（顔も）が人に重なっているかで確かめ、うまくいかなければ戻してください。自動では切り替わりません。"
        )}
      </p>
    </div>
  );
}
