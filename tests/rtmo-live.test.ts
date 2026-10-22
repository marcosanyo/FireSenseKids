/**
 * RTMO through ONNX Runtime Web (WASM, in Node) with the same pre/post-processing as the watch camera
 * (lib/firesense/rtmo.ts). Runs only when the model is in .model-cache/ (scripts/upload-models.sh with
 * NO_UPLOAD=1 fetches it); otherwise skipped, never mocked.
 *
 * Frames in .model-cache/frames/*.jpg (local only, never committed: they can show the family) are also run
 * and printed, to compare with scripts/pose-bench/eval_rtm.py on the same images.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import { decodeRtmo, letterbox, RTMO_INPUT, toInputTensor } from "../lib/firesense/rtmo";

const CACHE = join(__dirname, "..", ".model-cache");
const model = (size: string) => join(CACHE, `rtmo-${size}.onnx`);
const hasModel = existsSync(model("s"));

/** Bilinear resize of RGBA into the top-left of a size×size RGBA buffer (what the browser canvas does). */
function letterboxRgba(src: { data: Uint8Array; width: number; height: number }) {
  const lb = letterbox(src.width, src.height);
  const out = new Uint8ClampedArray(RTMO_INPUT * RTMO_INPUT * 4);
  for (let y = 0; y < lb.h; y++) {
    const sy = Math.min(src.height - 1, (y + 0.5) / lb.ratio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < lb.w; x++) {
      const sx = Math.min(src.width - 1, (x + 0.5) / lb.ratio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      for (let c = 0; c < 4; c++) {
        const p = (yy: number, xx: number) => src.data[(yy * src.width + xx) * 4 + c];
        const top = p(y0, x0) * (1 - fx) + p(y0, x1) * fx;
        const bot = p(y1, x0) * (1 - fx) + p(y1, x1) * fx;
        out[(y * RTMO_INPUT + x) * 4 + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { rgba: out, lb };
}

async function run(size: string, file: string) {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(readFileSync(model(size)), { executionProviders: ["wasm"] });
  const img = jpeg.decode(readFileSync(file), { useTArray: true });
  const { rgba, lb } = letterboxRgba(img);
  const input = new ort.Tensor("float32", toInputTensor(rgba, lb), [1, 3, RTMO_INPUT, RTMO_INPUT]);
  const out = await session.run({ input });
  const dets = out.dets;
  const n = dets.dims[1];
  return decodeRtmo(dets.data as Float32Array, out.keypoints.data as Float32Array, n, lb, img.width, img.height);
}

describe.skipIf(!hasModel)("RTMO live (ONNX Runtime Web, WASM)", () => {
  it("finds the person in the generated TV-marker debug scene, with feet, hips and face", async () => {
    const people = await run("s", join(__dirname, "..", "public/debug/tv-person-near.jpg"));
    expect(people.length).toBeGreaterThanOrEqual(1);
    const p = people[0].landmarks;
    expect(Math.max(p[27].visibility ?? 0, p[28].visibility ?? 0)).toBeGreaterThan(0.5); // an ankle
    expect(Math.min(p[23].visibility ?? 0, p[24].visibility ?? 0)).toBeGreaterThan(0.5); // hips
    expect(p[0].visibility ?? 0).toBeGreaterThan(0.3); // nose
    expect(p[29].y).toBeGreaterThan(p[27].y); // estimated heel below the ankle
  }, 120_000);

  const frames = existsSync(join(CACHE, "frames")) ? readdirSync(join(CACHE, "frames")).filter((f) => f.endsWith(".jpg")) : [];
  it.skipIf(frames.length === 0)("local frames: print detections (compare with eval_rtm.py)", async () => {
    for (const size of ["s", "m"]) {
      for (const f of frames) {
        const people = await run(size, join(CACHE, "frames", f));
        const desc = people.map((p) => {
          const ys = p.landmarks.filter((l) => (l.visibility ?? 0) > 0.3).map((l) => l.y);
          const xs = p.landmarks.filter((l) => (l.visibility ?? 0) > 0.3).map((l) => l.x);
          return `h=${(Math.max(...ys) - Math.min(...ys)).toFixed(2)}@x=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)} s=${p.score.toFixed(2)}`;
        });
        console.log(`rtmo-${size} ${f}: ${people.length}: ${desc.join("; ")}`);
      }
    }
  }, 600_000);
});
