/**
 * TV rendering benchmark (MEASUREMENT_EVIDENCE §5): one key press on the TV steps through
 * blur 0 / 12 / 24 px × full / downscale, and records render fps and video fps for each.
 *
 * - render fps: requestAnimationFrame callbacks per second.
 * - video fps: requestVideoFrameCallback callbacks per second (frames actually presented). If the
 *   WebView has no requestVideoFrameCallback it is recorded as null — never estimated.
 * - decoded / dropped: deltas of getVideoPlaybackQuality() over the window (null if unavailable).
 *
 * The run stops with an error if the video is paused or not playing, instead of recording numbers
 * for a still picture. Note: the player applies downscale only when blur > 0, so "0 px downscale" is
 * the same picture as "0 px full"; it is measured anyway, as a second baseline.
 */

import { L } from "../firesense/i18n";


export type BlurMode = "full" | "downscale";

export interface BenchStep {
  blurPx: number;
  mode: BlurMode;
}

export const BENCH_STEPS: readonly BenchStep[] = [
  { blurPx: 0, mode: "full" },
  { blurPx: 12, mode: "full" },
  { blurPx: 24, mode: "full" },
  { blurPx: 0, mode: "downscale" },
  { blurPx: 12, mode: "downscale" },
  { blurPx: 24, mode: "downscale" },
];

/** Wait after switching (the CSS transition is 500 ms), then count for measureMs. */
export const BENCH_SETTLE_MS = 2000;
export const BENCH_MEASURE_MS = 5000;

export interface BenchStepResult extends BenchStep {
  measuredMs: number;
  renderFps: number;
  /** null: requestVideoFrameCallback is not available in this WebView. */
  videoFps: number | null;
  /** null: getVideoPlaybackQuality is not available. */
  decodedFrames: number | null;
  droppedFrames: number | null;
}

export interface BenchResult {
  steps: BenchStepResult[];
  userAgent: string;
  screen: { width: number; height: number; devicePixelRatio: number };
  video: { width: number; height: number; src: string };
}

export function perSecond(count: number, ms: number): number {
  if (ms <= 0) throw new Error(`invalid measurement window: ${ms} ms`);
  return Math.round((count / ms) * 1000 * 10) / 10;
}

export function benchToCsv(r: BenchResult): string {
  const cell = (v: number | null) => (v === null ? "" : String(v));
  const rows = r.steps.map((s) =>
    [s.blurPx, s.mode, s.renderFps, cell(s.videoFps), cell(s.decodedFrames), cell(s.droppedFrames), s.measuredMs].join(",")
  );
  return ["blur_px,mode,render_fps,video_fps,decoded_frames,dropped_frames,measured_ms", ...rows].join("\n");
}

type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };

function quality(v: HTMLVideoElement): { decoded: number; dropped: number } | null {
  if (typeof v.getVideoPlaybackQuality !== "function") return null;
  const q = v.getVideoPlaybackQuality();
  return { decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames };
}

function assertPlaying(v: HTMLVideoElement) {
  if (v.paused || v.ended) throw new Error(L("The video is not playing. Run it again while it plays", "動画が再生されていません。再生中にもう一度実行してください"));
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error(L("Cancelled", "中止しました")));
    });
  });

async function measure(v: VideoWithRvfc, ms: number, signal: AbortSignal) {
  let frames = 0;
  let vFrames = 0;
  let raf = 0;
  let rvfc = 0;
  const hasRvfc = typeof v.requestVideoFrameCallback === "function";
  const loop = () => {
    frames++;
    raf = requestAnimationFrame(loop);
  };
  const onVideoFrame = () => {
    vFrames++;
    rvfc = v.requestVideoFrameCallback!(onVideoFrame);
  };
  const q0 = quality(v);
  const t0 = performance.now();
  raf = requestAnimationFrame(loop);
  if (hasRvfc) rvfc = v.requestVideoFrameCallback!(onVideoFrame);
  try {
    await sleep(ms, signal);
  } finally {
    cancelAnimationFrame(raf);
    if (hasRvfc) v.cancelVideoFrameCallback?.(rvfc);
  }
  const elapsed = performance.now() - t0;
  const q1 = quality(v);
  return {
    measuredMs: Math.round(elapsed),
    renderFps: perSecond(frames, elapsed),
    videoFps: hasRvfc ? perSecond(vFrames, elapsed) : null,
    decodedFrames: q0 && q1 ? q1.decoded - q0.decoded : null,
    droppedFrames: q0 && q1 ? q1.dropped - q0.dropped : null,
  };
}

export async function runRenderBenchmark(opts: {
  video: HTMLVideoElement;
  /** Applies the step's blur + mode to the player (the settle time covers the render and the CSS transition). */
  onStep: (index: number, step: BenchStep) => void;
  signal: AbortSignal;
}): Promise<BenchResult> {
  const { video, onStep, signal } = opts;
  const steps: BenchStepResult[] = [];
  for (let i = 0; i < BENCH_STEPS.length; i++) {
    const step = BENCH_STEPS[i];
    assertPlaying(video);
    onStep(i, step);
    await sleep(BENCH_SETTLE_MS, signal);
    assertPlaying(video);
    const m = await measure(video as VideoWithRvfc, BENCH_MEASURE_MS, signal);
    assertPlaying(video);
    steps.push({ ...step, ...m });
  }
  return {
    steps,
    userAgent: navigator.userAgent,
    screen: { width: window.screen.width, height: window.screen.height, devicePixelRatio: window.devicePixelRatio },
    video: { width: video.videoWidth, height: video.videoHeight, src: video.currentSrc },
  };
}
