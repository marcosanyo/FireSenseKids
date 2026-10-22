/**
 * FireSense Kids — Per-frame sensing pipeline (camera phone, on-device).
 *
 *   MediaPipe landmarks (all people)
 *     → PersonFilter (drop implausible / one-frame "people", person-filter.ts)
 *     → nearest person (smallest distance from the TV when the model knows it, else lowest in the image)
 *     → BodyObservation → BelowFrameTracker (VISIBLE / BELOW_FRAME / OCCLUDED / NO_PERSON)
 *     → floor-model distance (feet VISIBLE), or the floor point under the hips when the feet are
 *       OCCLUDED and the model is a TV-marker model (ESTIMATED, hip-ground.ts); seated (thighs near
 *       horizontal, world landmarks), the floor point under the head instead of the feet
 *     → ViewingStateMachine → FrameOutput (the numbers that go into Telemetry)
 *     → AdaptiveFrameRate (next inference interval)
 *
 * Pure logic: no DOM, no network. The raw frame never leaves this module.
 */

import { BelowFrameTracker, type BelowFrameConfig, type FootClassification } from "./below-frame";
import {
  belowFrameEdgeY,
  distanceForFoot,
  extractGroundContactPoint,
  imageToFloor,
  isHomography,
  type FloorPosition,
  observeBody,
  type FloorModel,
  type LandmarkPoint,
} from "./floor-calibration";
import { AdaptiveFrameRate, type FrameRateConfig } from "./frame-rate";
import { estimateGroundFromHips, estimateSeatedViewpoint, HIP_ESTIMATE_CONFIDENCE_FACTOR, HipMemory, isSeated } from "./hip-ground";
import { PersonFilter, type PersonFilterConfig, type PersonVerdict } from "./person-filter";
import { DistanceSmoother, type DistanceSmootherConfig } from "./distance-smoother";
import { evaluatePosture, type Landmark3D } from "./posture";
import { ViewingStateMachine, type FrameOutput, type StateMachineConfig } from "./state-machine";

export interface PipelineFrame extends FrameOutput {
  foot: FootClassification;
  /** Posture measurements behind `posture` (degrees from vertical), for tuning / debugging. */
  postureAngles: { torsoDeg: number; neckDeg: number } | null;
  fps: number;
  peopleCount: number;
  /** Index (into the input people) of the person the frame is about; -1 = nobody. */
  nearest: number;
  /** Per input person: counted as a person, or why not. */
  verdicts: PersonVerdict[];
  /** Where the distance came from: the feet, the hips (estimate), the head of a seated person, or nowhere. */
  distanceSource: "feet" | "hips" | "seated" | null;
  /** Image point (normalized) the distance belongs to: ground contact, or hip center for an estimate. */
  distancePoint: { x: number; y: number } | null;
  /** Floor position of this frame's measurement (TV-marker models; not for a held distance). */
  floor: FloorPosition | null;
}

export interface SensorPipelineConfig {
  stateMachine?: StateMachineConfig;
  belowFrame?: BelowFrameConfig;
  frameRate?: FrameRateConfig;
  personFilter?: PersonFilterConfig;
  smoothing?: DistanceSmootherConfig;
}

/**
 * Debounce used on the phone (field feedback 2026-09-26: the card and "nice step" flickered).
 * Unit tests of the plain state machine construct it without these.
 */
/** Another person must be this much closer to the TV to take over as "the nearest viewer". */
export const NEAREST_SWITCH_M = 0.3;

export const PIPELINE_STATE_DEBOUNCE: StateMachineConfig = {
  enterDwellMs: 400,
  exitDwellMs: 800,
  tooCloseExitHysteresisMeters: 0.1,
  safeHysteresisMeters: 0.05,
};

const PROXIMITY_VISIBILITY = 0.5;

/**
 * Nearest viewer for a phone in front of the TV = the person whose lowest visible landmark is lowest
 * in the image. Works both when feet are visible and when they are already cut off at the bottom.
 * (With the phone beside the TV the bottom of the image is near the phone, not the TV; the pipeline
 * then compares distances instead, see `SensorPipeline.pickNearest`.)
 */
export function selectNearestPerson(people: LandmarkPoint[][]): number {
  let best = -1;
  let bestY = -Infinity;
  people.forEach((lms, idx) => {
    let lowest = -Infinity;
    for (const lm of lms) {
      if ((lm.visibility ?? 1) >= PROXIMITY_VISIBILITY && lm.y > lowest) lowest = lm.y;
    }
    if (lowest > bestY) {
      bestY = lowest;
      best = idx;
    }
  });
  return best;
}

export class SensorPipeline {
  readonly stateMachine: ViewingStateMachine;
  tracker: BelowFrameTracker;
  readonly frameRate: AdaptiveFrameRate;
  readonly personFilter: PersonFilter;
  private readonly smoother: DistanceSmoother;
  private hipMemory = new HipMemory();
  private lastPersonKey: string | null = null;
  /** Track id of the person the last frame was about (nearest-person stickiness). */
  private lastTrackId: number | undefined;
  private model: FloorModel | null = null;
  private readonly belowFrameConfig: BelowFrameConfig;

  constructor(config: SensorPipelineConfig = {}) {
    this.stateMachine = new ViewingStateMachine({ ...PIPELINE_STATE_DEBOUNCE, ...config.stateMachine });
    this.belowFrameConfig = config.belowFrame ?? {};
    this.tracker = new BelowFrameTracker(this.belowFrameConfig);
    this.frameRate = new AdaptiveFrameRate(config.frameRate);
    this.personFilter = new PersonFilter(config.personFilter);
    this.smoother = new DistanceSmoother(config.smoothing);
  }

  /** Smallest torso (share of the frame height) that counts as a person: depends on the pose model. */
  public setMinTorsoFraction(fraction: number): void {
    this.personFilter.setMinTorsoFraction(fraction);
  }

  /** Applies a floor model; BELOW_FRAME is re-armed against the model's visible floor bottom. */
  public setCalibration(model: FloorModel): void {
    this.model = model;
    this.stateMachine.reset();
    this.smoother.reset();
    this.hipMemory = new HipMemory(); // learned heights belong to the previous camera pose
    this.tracker = new BelowFrameTracker({
      ...this.belowFrameConfig,
      edgeY: belowFrameEdgeY(model),
      // Front placement (y-only model): the bottom edge is always toward the TV, no gate.
      // Any-placement homography (side / diagonal): the bottom edge may be near the phone.
      maxExitDistanceM: isHomography(model) ? this.stateMachine.tooCloseThreshold : undefined,
    });
  }

  /** User thresholds; fast inference starts 0.35m beyond SAFE (default 1.65 → 2.0m). */
  public setThresholds(tooCloseM: number, safeM: number): void {
    this.stateMachine.setThresholds(tooCloseM, safeM);
    if (this.model && isHomography(this.model)) this.tracker.setMaxExitDistance(tooCloseM);
    this.frameRate.setNearDistance(safeM + 0.35);
  }

  public clearCalibration(): void {
    this.model = null;
    this.stateMachine.reset();
    this.tracker.reset();
    this.personFilter.reset();
    this.smoother.reset();
    this.lastPersonKey = null;
    this.lastTrackId = undefined;
  }

  public isCalibrated(): boolean {
    return this.model !== null;
  }

  /**
   * @param people      image landmarks per detected person (normalized 0..1)
   * @param worldPeople optional metric world landmarks (same order), used for posture and hip estimates
   * @param aspect      frame width / height (landmarks are normalized per axis)
   */
  public process(people: LandmarkPoint[][], nowMs: number, worldPeople?: Landmark3D[][], aspect = 4 / 3): PipelineFrame {
    if (!this.model) {
      throw new Error("SensorPipeline: floor calibration is required before processing frames");
    }
    const model = this.model;
    const verdicts = this.personFilter.update(people, aspect, nowMs);
    const idx = this.pickNearest(people, verdicts, worldPeople);
    const lms = idx >= 0 ? people[idx] : null;
    const obs = observeBody(lms);
    const measured = obs.groundY !== null && obs.groundX !== null ? distanceForFoot(model, obs.groundX, obs.groundY) : null;
    let foot = this.tracker.update(obs, nowMs, measured);

    let distanceM = foot.status === "VISIBLE" ? measured : null;
    let distanceSource: PipelineFrame["distanceSource"] = distanceM !== null ? "feet" : null;
    let distancePoint = distanceM !== null && obs.groundX !== null && obs.groundY !== null ? { x: obs.groundX, y: obs.groundY } : null;
    let floor: FloorPosition | null =
      distanceM !== null && isHomography(model) && model.tvPose && obs.groundX !== null && obs.groundY !== null ? imageToFloor(model.tvPose, obs.groundX, obs.groundY) : null;
    let hipConfidence = 0;
    const trackId = idx >= 0 ? verdicts[idx]?.trackId : undefined;
    const personKey = trackId !== undefined ? String(trackId) : null;
    const tvPose = isHomography(model) ? model.tvPose : undefined;
    // Without world landmarks (RTMO), the hip height learned while this person's feet were visible.
    if (!worldPeople && tvPose && lms && personKey !== null && foot.status === "VISIBLE") this.hipMemory.observe(personKey, tvPose, lms, nowMs);
    // Seated (MediaPipe + TV marker): under the head, whether the feet are visible or not.
    const world = idx >= 0 ? (worldPeople?.[idx] as LandmarkPoint[] | undefined) : undefined;
    const seated = tvPose && lms && (foot.status === "VISIBLE" || foot.status === "OCCLUDED") && isSeated(lms, world, tvPose.r[1]) ? estimateSeatedViewpoint(model, lms, world) : null;
    if (seated && lms) {
      if (foot.status === "OCCLUDED") {
        foot = { ...foot, status: "ESTIMATED" };
        hipConfidence = obs.torsoConfidence * HIP_ESTIMATE_CONFIDENCE_FACTOR;
      }
      distanceM = seated.distanceM;
      distanceSource = "seated";
      distancePoint = seated.hip;
      floor = seated.floor;
    } else if (foot.status === "OCCLUDED" && lms) {
      const est = worldPeople
        ? estimateGroundFromHips(model, lms, worldPeople[idx] as LandmarkPoint[] | undefined)
        : tvPose && personKey !== null
        ? this.hipMemory.estimate(personKey, tvPose, lms, nowMs)
        : null;
      if (est) {
        foot = { ...foot, status: "ESTIMATED" };
        distanceM = est.distanceM;
        distanceSource = "hips";
        distancePoint = est.hip;
        floor = est.floor;
        hipConfidence = obs.torsoConfidence * HIP_ESTIMATE_CONFIDENCE_FACTOR;
      }
    }

    // Median of the same person's recent measurements (distance-smoother.ts). A frame without a
    // distance (feet lost for a moment, or the person missed for one frame) reuses the last one of the
    // same person for up to 1 s instead of dropping to LOW_CONFIDENCE and back. BELOW_FRAME is never held.
    let smFoot: FootClassification["status"] = foot.status;
    let usedHold = false;
    let smConfidence =
      foot.status === "VISIBLE" ? obs.footConfidence : foot.status === "ESTIMATED" ? hipConfidence : foot.status === "BELOW_FRAME" ? obs.torsoConfidence : 0;
    if (distanceM !== null && distanceSource !== null && personKey !== null) {
      distanceM = this.smoother.update(distanceM, distanceSource, smConfidence, personKey, nowMs).distanceM;
      this.lastPersonKey = personKey;
    } else if (foot.status !== "BELOW_FRAME") {
      const held = this.smoother.hold(personKey ?? this.lastPersonKey, nowMs);
      if (held) {
        distanceM = held.distanceM;
        distanceSource = held.source;
        smFoot = "ESTIMATED";
        usedHold = true;
        smConfidence = held.confidence;
      }
    }

    // Posture needs metric 3D landmarks. Image points alone (RTMO) give nonsense angles — every standing child
    // came out as lying down — so without them the posture is unknown, not guessed.
    const worldForPerson = idx >= 0 ? worldPeople?.[idx] : undefined;
    const pe = lms && worldForPerson?.length ? evaluatePosture(worldForPerson as Landmark3D[]) : null;
    const posture = pe ? pe.posture : "UNKNOWN";

    const out = this.stateMachine.update({ footStatus: smFoot, distanceM, confidence: smConfidence, posture }, nowMs);
    const fps = this.frameRate.update(out.state, out.distanceM, nowMs);

    return {
      ...out,
      confidence: Number(out.confidence.toFixed(2)),
      foot,
      fps,
      peopleCount: verdicts.filter((v) => v.accepted).length,
      postureAngles: pe ? { torsoDeg: pe.torsoAngleDeg, neckDeg: pe.neckAngleDeg } : null,
      nearest: idx,
      verdicts,
      distanceSource: out.distanceM !== null ? distanceSource : null,
      distancePoint: out.distanceM !== null ? distancePoint : null,
      // Only a position measured in this frame (a held distance has none).
      floor: out.distanceM !== null && !usedHold ? floor : null,
    };
  }

  /**
   * Among accepted people: when the model gives a distance from the TV for arbitrary image points
   * (homography: phone anywhere), the one closest to the TV (feet, else hip estimate); people without
   * any distance only count if nobody has one. Otherwise (phone in front of the TV) the lowest in the image.
   */
  private pickNearest(people: LandmarkPoint[][], verdicts: PersonVerdict[], worldPeople?: Landmark3D[][]): number {
    const model = this.model as FloorModel;
    const ids = people.map((_, i) => i).filter((i) => verdicts[i]?.accepted);
    if (ids.length === 0) return -1;
    const lowest = () => {
      const k = selectNearestPerson(ids.map((i) => people[i]));
      return k >= 0 ? ids[k] : -1;
    };
    // Phone in front of the TV: lowest in the image, unless everyone's feet are visible (then compare
    // distances, with the same stickiness). Someone without feet may already be below the frame.
    const allFeet = ids.every((i) => extractGroundContactPoint(people[i]) !== null);
    if (!isHomography(model) && !allFeet) {
      const k = lowest();
      this.lastTrackId = k >= 0 ? verdicts[k]?.trackId : undefined;
      return k;
    }
    let best = -1;
    let bestD = Infinity;
    let stickyD: number | null = null;
    let sticky = -1;
    for (const i of ids) {
      const g = extractGroundContactPoint(people[i]);
      let d = g ? distanceForFoot(model, g.groundX, g.groundY) : null;
      if (d === null) d = estimateGroundFromHips(model, people[i], worldPeople?.[i] as LandmarkPoint[] | undefined)?.distanceM ?? null;
      if (d === null) continue;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      if (verdicts[i]?.trackId !== undefined && verdicts[i].trackId === this.lastTrackId) {
        stickyD = d;
        sticky = i;
      }
    }
    // Stay with the same person unless someone else is clearly (NEAREST_SWITCH_M) closer: two people at
    // about the same distance must not make the frame alternate between them.
    const chosen = sticky >= 0 && stickyD !== null && stickyD - bestD < NEAREST_SWITCH_M ? sticky : best;
    const pick = chosen >= 0 ? chosen : lowest();
    this.lastTrackId = pick >= 0 ? verdicts[pick]?.trackId : undefined;
    return pick;
  }
}
