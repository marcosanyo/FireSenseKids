"use client";

/**
 * The watch camera's pose estimators behind one interface: MediaPipe Pose (full) and RTMO s / m / l.
 *
 * The parent chooses on the watch camera; the choice is saved per device. Nothing switches by itself:
 * a model that fails to load is an error on screen, and the user picks another one or retries.
 *
 *  - MediaPipe: 33 landmarks + metric world landmarks (posture, hip-based distance), and a second
 *    zoomed pass around the TV for small people (the page drives it with `detectCrop`).
 *  - RTMO (ONNX Runtime Web, self-hosted /ort, models from our CloudFront /models): COCO-17 mapped to
 *    the MediaPipe layout (lib/firesense/rtmo.ts). No world landmarks, so posture and the hip-based
 *    estimate are unavailable; no zoom pass (one 640×640 inference already sees small people better).
 *    WebGPU by default; WASM (CPU) only as an explicit retry. ONNX Runtime places the few nodes WebGPU
 *    has no kernel for (NonMaxSuppression, TopK) on its CPU backend inside the same session.
 */

import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { LandmarkPoint } from "../firesense/floor-calibration";
import { L } from "../firesense/i18n";
import { createPoseLandmarker, type Delegate } from "../firesense/mediapipe";
import { POSE_MODEL_IDS, type PoseModelId } from "../firesense/protocol";
import { decodeRtmo, letterbox, RTMO_INPUT, RTMO_SCORE_THRESHOLD, toInputTensor } from "../firesense/rtmo";
import { KEYS, storage } from "./storage";

export const POSE_MODELS = POSE_MODEL_IDS;
export type { PoseModelId };
/** "GPU" = MediaPipe GPU delegate / ONNX Runtime WebGPU; "CPU" = MediaPipe CPU / ONNX Runtime WASM. */
export type Accel = Delegate;

export const POSE_MODEL_INFO: Record<PoseModelId, { readonly label: string; readonly size: string; readonly use: string }> = {
  "mediapipe-full": {
    label: "MediaPipe Pose Full",
    size: "9 MB",
    get use() {
      return L("Standard: light. Also posture, sitting, and the distance from the hips whenever the feet are hidden.", "標準: 軽い。姿勢・座り・足が隠れたときの腰からの距離も判定");
    },
  },
  "rtmo-s": {
    label: "RTMO-s",
    size: "40 MB",
    get use() {
      return L("High accuracy (also small or far people). Fastest RTMO.", "高精度（小さく映る人も）。RTMO でいちばん速い");
    },
  },
  "rtmo-m": {
    label: "RTMO-m",
    size: "89 MB",
    get use() {
      return L("High accuracy, more accurate, slower.", "高精度。より正確で、やや遅い");
    },
  },
  "rtmo-l": {
    label: "RTMO-l",
    size: "176 MB",
    get use() {
      return L("High accuracy, most accurate, slowest (check the inference time).", "高精度。いちばん正確で、いちばん遅い（推論時間を確認）");
    },
  },
};

export function loadPoseModelChoice(): PoseModelId {
  const raw = storage.get(KEYS.poseModel);
  if (raw === null) return "mediapipe-full";
  if ((POSE_MODELS as readonly string[]).includes(raw)) return raw as PoseModelId;
  throw new Error(L(`The saved pose model "${raw}" is unknown`, `保存されている推論モデル "${raw}" は不明です`));
}

export function savePoseModelChoice(id: PoseModelId): void {
  storage.set(KEYS.poseModel, id);
}

export interface PoseResult {
  people: LandmarkPoint[][];
  /** Metric world landmarks in the same order, or null when the model has none. */
  world: LandmarkPoint[][] | null;
}

export interface PoseEstimator {
  readonly id: PoseModelId;
  readonly accel: Accel;
  /** Posture and the hip-based distance estimate need world landmarks. */
  readonly hasWorld: boolean;
  /** The page's zoomed second pass (MediaPipe only). */
  readonly supportsZoom: boolean;
  detect(el: CanvasImageSource, w: number, h: number, tMs: number): Promise<PoseResult>;
  detectCrop?(canvas: HTMLCanvasElement): Promise<PoseResult>;
  /** One line about the last inference (RTMO: candidates, best score, where the time went), for the camera page. */
  diagnostics?(): string | null;
  close(): void;
}

class MediaPipeEstimator implements PoseEstimator {
  readonly id = "mediapipe-full" as const;
  readonly hasWorld = true;
  readonly supportsZoom = true;
  constructor(readonly accel: Accel, private readonly video: PoseLandmarker, private readonly image: PoseLandmarker) {}
  async detect(el: CanvasImageSource, _w: number, _h: number, tMs: number): Promise<PoseResult> {
    const r = this.video.detectForVideo(el as HTMLVideoElement, tMs);
    return { people: r.landmarks as LandmarkPoint[][], world: r.worldLandmarks as LandmarkPoint[][] };
  }
  async detectCrop(canvas: HTMLCanvasElement): Promise<PoseResult> {
    const r = this.image.detect(canvas);
    return { people: r.landmarks as LandmarkPoint[][], world: r.worldLandmarks as LandmarkPoint[][] };
  }
  close() {
    this.video.close();
    this.image.close();
  }
}

type Ort = typeof import("onnxruntime-web");

class RtmoEstimator implements PoseEstimator {
  readonly hasWorld = false;
  readonly supportsZoom = false;
  private readonly canvas = document.createElement("canvas");
  private diag: string | null = null;
  private warm = "";
  constructor(
    readonly id: Exclude<PoseModelId, "mediapipe-full">,
    readonly accel: Accel,
    private readonly ort: Ort,
    private readonly session: import("onnxruntime-web").InferenceSession
  ) {
    this.canvas.width = RTMO_INPUT;
    this.canvas.height = RTMO_INPUT;
  }
  /** One frame through the model: read back the pixels, run, decode. Throws on invalid numbers. */
  private async infer(el: CanvasImageSource, w: number, h: number) {
    const t0 = performance.now();
    const lb = letterbox(w, h);
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(el, 0, 0, w, h, 0, 0, lb.w, lb.h);
    const rgba = ctx.getImageData(0, 0, RTMO_INPUT, RTMO_INPUT).data;
    // Mean brightness of what the model is given (0-255). Near 0 = the camera frame was read back as black.
    let sum = 0;
    let n = 0;
    for (let y = 0; y < lb.h; y += 8) for (let x = 0; x < lb.w; x += 8) { const i = (y * RTMO_INPUT + x) * 4; sum += (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3; n++; }
    const brightness = n ? sum / n : 0;
    const input = new this.ort.Tensor("float32", toInputTensor(rgba, lb), [1, 3, RTMO_INPUT, RTMO_INPUT]);
    const t1 = performance.now();
    const out = await this.session.run({ input });
    const t2 = performance.now();
    const dets = out.dets;
    const detData = dets.data as Float32Array;
    const kptData = out.keypoints.data as Float32Array;
    const release = () => {
      dets.dispose();
      out.keypoints.dispose();
      input.dispose();
    };
    // Invalid numbers mean this GPU / runtime cannot run the model correctly: say so, do not return "nobody".
    for (let i = 0; i < Math.min(detData.length, 500); i++) {
      if (!Number.isFinite(detData[i])) {
        release();
        throw new Error(L(`${POSE_MODEL_INFO[this.id].label} returned invalid numbers (NaN) on this ${this.accel === "GPU" ? "GPU" : "device"}. Retry on WASM (CPU), or choose MediaPipe.`, `${POSE_MODEL_INFO[this.id].label} が、この${this.accel === "GPU" ? "GPU" : "端末"}で不正な数値（NaN）を返しました。WASM（CPU）で再試行するか、MediaPipe を選んでください。`));
      }
    }
    let best = 0;
    let candidates = 0;
    for (let i = 0; i < dets.dims[1]; i++) {
      best = Math.max(best, detData[i * 5 + 4]);
      if (detData[i * 5 + 4] > RTMO_SCORE_THRESHOLD) candidates++;
    }
    const people = decodeRtmo(detData, kptData, dets.dims[1], lb, w, h);
    const t3 = performance.now();
    release();
    return { people, best, candidates, brightness, prepMs: t1 - t0, runMs: t2 - t1, decodeMs: t3 - t2, rawRows: dets.dims[1] };
  }

  async detect(el: CanvasImageSource, w: number, h: number): Promise<PoseResult> {
    const r = await this.infer(el, w, h);
    this.diag = L(
      `RTMO: ${r.candidates} candidate(s) over ${RTMO_SCORE_THRESHOLD} of ${r.rawRows}, best score ${r.best.toFixed(2)}, ${r.people.length} after NMS · frame ${w}×${h}, brightness ${Math.round(r.brightness)}/255 · prep ${Math.round(r.prepMs)} ms, run ${Math.round(r.runMs)} ms, decode ${Math.round(r.decodeMs)} ms`,
      `RTMO: スコア ${RTMO_SCORE_THRESHOLD} 超の候補 ${r.candidates} 件（全 ${r.rawRows} 行）、最高スコア ${r.best.toFixed(2)}、NMS 後 ${r.people.length} 人 · 映像 ${w}×${h}・明るさ ${Math.round(r.brightness)}/255 · 前処理 ${Math.round(r.prepMs)}ms・推論 ${Math.round(r.runMs)}ms・後処理 ${Math.round(r.decodeMs)}ms`
    );
    return { people: r.people.map((p) => p.landmarks), world: null };
  }

  /**
   * Runs the model on a built-in photo of a person standing (the TV-marker debug scene) and fails with the reason
   * when it does not find them. It separates the two ways RTMO can see nobody on a phone: the model cannot run
   * correctly on this GPU (the test photo fails; brightness is normal), or the camera frames are read back wrong
   * (the test photo passes, or the brightness is near 0).
   */
  async selfTest(): Promise<void> {
    const img = new Image();
    img.src = "/debug/tv-person-near.jpg";
    await img.decode();
    const r = await this.infer(img, img.naturalWidth, img.naturalHeight);
    const p = r.people[0]?.landmarks;
    const ankle = p ? Math.max(p[27].visibility ?? 0, p[28].visibility ?? 0) : 0;
    this.selfTestResult = L(`self-test ${r.people.length ? "passed" : "FAILED"} (test photo: ${r.people.length} person, best score ${r.best.toFixed(2)}, brightness ${Math.round(r.brightness)}/255)`, `自己診断 ${r.people.length ? "合格" : "不合格"}（内蔵の写真: ${r.people.length} 人、最高スコア ${r.best.toFixed(2)}、明るさ ${Math.round(r.brightness)}/255）`);
    if (r.people.length < 1 || r.people[0].score < 0.5 || ankle < 0.5) {
      throw new Error(
        L(
          `${POSE_MODEL_INFO[this.id].label} failed its self-test on this ${this.accel === "GPU" ? "GPU (WebGPU)" : "device (WASM)"}: it should find one standing person in the built-in photo, but found ${r.people.length} (best score ${r.best.toFixed(2)}, ankle ${ankle.toFixed(2)}); the photo reached the model with brightness ${Math.round(r.brightness)}/255. ${r.brightness < 10 ? "The canvas gives black pixels here, so camera frames would be black too." : "The model computes wrong results on this device."} Retry on the other backend, or choose MediaPipe.`,
          `${POSE_MODEL_INFO[this.id].label} が、この${this.accel === "GPU" ? "GPU（WebGPU）" : "端末（WASM）"}で自己診断に失敗しました: 内蔵の写真には立っている人が1人いるはずですが、${r.people.length} 人（最高スコア ${r.best.toFixed(2)}、足首 ${ankle.toFixed(2)}）。モデルに渡った写真の明るさは ${Math.round(r.brightness)}/255。${r.brightness < 10 ? "ここでは canvas が黒いピクセルを返すので、カメラ映像も黒になります。" : "この端末ではモデルの計算結果が正しくありません。"}もう一方の実行先で再試行するか、MediaPipe を選んでください。`
        )
      );
    }
  }
  private selfTestResult = "";
  /**
   * Two runs on a blank frame before the camera uses the model. WebGPU compiles its shaders on the first run
   * (seconds on a phone); doing it here shows "preparing" instead of a camera that sees nobody, and the two
   * times (first → second) show what a frame really costs.
   */
  async warmUp(onProgress?: (text: string) => void): Promise<void> {
    const times: number[] = [];
    for (let i = 0; i < 2; i++) {
      onProgress?.(L(`Warming up ${POSE_MODEL_INFO[this.id].label} (run ${i + 1} of 2; the first run compiles the GPU programs and can take several seconds on a phone)…`, `${POSE_MODEL_INFO[this.id].label} を試運転しています（${i + 1}/2 回目。1回目は GPU 用のプログラムのコンパイルで、スマホでは数秒かかることがあります）…`));
      const t = performance.now();
      const input = new this.ort.Tensor("float32", new Float32Array(3 * RTMO_INPUT * RTMO_INPUT).fill(114), [1, 3, RTMO_INPUT, RTMO_INPUT]);
      const out = await this.session.run({ input });
      // Reading the output also waits for the GPU to finish.
      void (out.dets.data as Float32Array)[0];
      out.dets.dispose();
      out.keypoints.dispose();
      input.dispose();
      times.push(Math.round(performance.now() - t));
    }
    this.warm = L(`warm-up ${times[0]} → ${times[1]} ms`, `試運転 ${times[0]} → ${times[1]}ms`);
  }
  diagnostics() {
    const base = this.diag ?? "";
    return [base, this.warm, this.selfTestResult].filter(Boolean).join(" · ") || null;
  }
  close() {
    void this.session.release();
  }
}

/** Loads the chosen model. Throws (with the reason) instead of choosing another model or backend. */
export async function createPoseEstimator(id: PoseModelId, accel: Accel, onProgress?: (text: string) => void): Promise<PoseEstimator> {
  if (id === "mediapipe-full") {
    const video = await createPoseLandmarker(accel);
    const image = await createPoseLandmarker(accel, 2, "IMAGE");
    return new MediaPipeEstimator(accel, video, image);
  }
  if (accel === "GPU" && !("gpu" in navigator)) {
    throw new Error(L("This browser has no WebGPU. Retry on CPU (WASM), or choose MediaPipe.", "このブラウザは WebGPU に対応していません。CPU（WASM）で再試行するか、MediaPipe を選んでください。"));
  }
  const ort = await import("onnxruntime-web/webgpu");
  ort.env.wasm.wasmPaths = "/ort/";
  // Threads need cross-origin isolation, which these pages do not have; say so instead of letting it warn.
  ort.env.wasm.numThreads = 1;
  onProgress?.(L(`Downloading ${POSE_MODEL_INFO[id].label} (${POSE_MODEL_INFO[id].size})…`, `${POSE_MODEL_INFO[id].label}（${POSE_MODEL_INFO[id].size}）をダウンロードしています…`));
  const res = await fetch(`/models/${id}.onnx`);
  if (!res.ok) throw new Error(L(`Could not download /models/${id}.onnx: HTTP ${res.status}`, `/models/${id}.onnx をダウンロードできません: HTTP ${res.status}`));
  const bytes = new Uint8Array(await res.arrayBuffer());
  onProgress?.(L(`Preparing ${POSE_MODEL_INFO[id].label} on ${accel === "GPU" ? "WebGPU" : "WASM"}…`, `${POSE_MODEL_INFO[id].label} を ${accel === "GPU" ? "WebGPU" : "WASM"} で準備しています…`));
  const session = await ort.InferenceSession.create(bytes, { executionProviders: [accel === "GPU" ? "webgpu" : "wasm"] });
  const estimator = new RtmoEstimator(id, accel, ort as unknown as Ort, session);
  await estimator.warmUp(onProgress);
  onProgress?.(L("Self-test on a built-in photo…", "内蔵の写真で自己診断しています…"));
  try {
    await estimator.selfTest();
  } catch (err) {
    estimator.close();
    throw err;
  }
  return estimator;
}
