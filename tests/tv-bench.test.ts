import { describe, expect, test } from "vitest";
import { BENCH_STEPS, benchToCsv, perSecond, type BenchResult } from "../lib/client/tv-bench";

describe("TV render benchmark", () => {
  test("covers blur 0/12/24 px in both blur modes", () => {
    expect(BENCH_STEPS.map((s) => `${s.blurPx}:${s.mode}`)).toEqual([
      "0:full",
      "12:full",
      "24:full",
      "0:downscale",
      "12:downscale",
      "24:downscale",
    ]);
  });

  test("per-second rate over the measured window, never over a zero window", () => {
    expect(perSecond(300, 5000)).toBe(60);
    expect(perSecond(149, 5012)).toBe(29.7);
    expect(() => perSecond(10, 0)).toThrow();
  });

  test("CSV keeps unavailable values empty instead of 0", () => {
    const r: BenchResult = {
      steps: [
        { blurPx: 24, mode: "full", measuredMs: 5003, renderFps: 58.2, videoFps: null, decodedFrames: 150, droppedFrames: 3 },
        { blurPx: 24, mode: "downscale", measuredMs: 5001, renderFps: 60, videoFps: 30, decodedFrames: null, droppedFrames: null },
      ],
      userAgent: "test",
      screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
      video: { width: 1280, height: 720, src: "cartoon.mp4" },
    };
    expect(benchToCsv(r).split("\n")).toEqual([
      "blur_px,mode,render_fps,video_fps,decoded_frames,dropped_frames,measured_ms",
      "24,full,58.2,,150,3,5003",
      "24,downscale,60,30,,,5001",
    ]);
  });
});
