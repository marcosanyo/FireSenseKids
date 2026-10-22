import { describe, expect, test } from "vitest";
import {
  detectScreenQuad,
  distanceForFoot,
  isoDistanceY,
  modelFromTvScreen,
  screenSizeFromInches,
  solveTvPose,
  type Pt2,
  type RgbaImage,
} from "../lib/firesense";
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { project, project3, type Cam } from "./helpers/camera";

// Phone on a shelf 1.8 m to the right of the TV center and 1.4 m into the room, 0.75 m high,
// looking back diagonally at the TV and the floor in front of it.
const SHELF_CAM: Cam = { x: 1.8, z: 1.4, h: 0.75, yawDeg: 125, pitchDownDeg: 8, vfovDeg: 55, aspect: 4 / 3 };
const TV = screenSizeFromInches(55);
const SCREEN_BOTTOM = 0.55; // m above the floor

/** Screen corners (TL, TR, BR, BL as seen from the room). World X = right when facing the room from the TV. */
function screenCorners(cam: Cam): [Pt2, Pt2, Pt2, Pt2] {
  const W = TV.widthM;
  const H = TV.heightM;
  const pts = [
    project3(cam, W / 2, SCREEN_BOTTOM + H, 0),
    project3(cam, -W / 2, SCREEN_BOTTOM + H, 0),
    project3(cam, -W / 2, SCREEN_BOTTOM, 0),
    project3(cam, W / 2, SCREEN_BOTTOM, 0),
  ];
  if (pts.some((p) => p === null)) throw new Error("test camera does not see the whole screen");
  return pts as [Pt2, Pt2, Pt2, Pt2];
}

describe("screenSizeFromInches", () => {
  test("55-inch 16:9 is 1.218 m × 0.685 m", () => {
    expect(TV.widthM).toBeCloseTo(1.218, 3);
    expect(TV.heightM).toBeCloseTo(0.685, 3);
  });
});

describe("solveTvPose (self-calibrating)", () => {
  test("recovers the focal length (vertical FOV) and the camera position from the four corners", () => {
    const pose = solveTvPose(screenCorners(SHELF_CAM), TV, 4 / 3);
    expect(pose.vfovDeg).toBeCloseTo(55, 1);
    expect(pose.camera.n).toBeCloseTo(1.4, 3); // distance in front of the screen
    expect(pose.camera.b).toBeCloseTo(0.75 - SCREEN_BOTTOM, 3); // height above the screen bottom
    expect(pose.camera.a).toBeCloseTo(TV.widthM / 2 - 1.8, 3); // viewer's right = −X
    expect(pose.focalMismatch).toBeLessThan(0.01);
  });

  test("a screen seen head-on cannot give the focal length → explicit error", () => {
    const front: Cam = { x: 0, z: 2.5, h: 0.55 + TV.heightM / 2, yawDeg: 180, pitchDownDeg: 0, vfovDeg: 55, aspect: 4 / 3 };
    expect(() => solveTvPose(screenCorners(front), TV, 4 / 3)).toThrow(/almost head-on/);
  });
});

describe("modelFromTvScreen → floor distance", () => {
  test("every visible floor point 0.6–2.4 m reads its true distance from the screen within 1 cm", () => {
    const { model, screenBottomHeightM } = modelFromTvScreen(screenCorners(SHELF_CAM), TV, 4 / 3, SHELF_CAM.h);
    expect(screenBottomHeightM).toBeCloseTo(SCREEN_BOTTOM, 3);
    let n = 0;
    for (let Z = 0.6; Z <= 2.4; Z += 0.2)
      for (let X = -1.2; X <= 1.2; X += 0.3) {
        const p = project(SHELF_CAM, X, Z);
        if (!p) continue;
        n++;
        // Distance from the screen segment: straight ahead in front of it, around its ends beside it.
        const truth = Math.hypot(Math.max(0, Math.abs(X) - TV.widthM / 2), Z);
        expect(distanceForFoot(model, p.x, p.y)).toBeCloseTo(truth, 1);
      }
    expect(n).toBeGreaterThan(20);
  });

  test("zone has rounded ends: 0.5 m in front of the wall but 2 m beside the TV is not too close", () => {
    const { model } = modelFromTvScreen(screenCorners(SHELF_CAM), TV, 4 / 3, SHELF_CAM.h);
    const side = project(SHELF_CAM, -(TV.widthM / 2 + 1.0), 0.5); // beside the screen, toward the camera
    if (!side) throw new Error("test point not in view");
    const d = distanceForFoot(model, side.x, side.y) as number;
    expect(d).toBeCloseTo(Math.hypot(1.0, 0.5), 1); // ≈ 1.12 m, not 0.5 m
    const front = project(SHELF_CAM, 0, 0.5);
    if (front) expect(distanceForFoot(model, front.x, front.y)).toBeCloseTo(0.5, 1);
  });

  test("corner noise of ±0.5 px (at 640×480) keeps the error at 1.2 m under 5 cm", () => {
    const c = screenCorners(SHELF_CAM);
    const jitter = [
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
      [-0.5, -0.5],
    ];
    const noisy = c.map((p, i) => ({ x: p.x + jitter[i][0] / 640, y: p.y + jitter[i][1] / 480 })) as [Pt2, Pt2, Pt2, Pt2];
    const { model } = modelFromTvScreen(noisy, TV, 4 / 3, SHELF_CAM.h);
    for (const X of [-0.6, 0, 0.6]) {
      const p = project(SHELF_CAM, X, 1.2);
      if (p) expect(Math.abs((distanceForFoot(model, p.x, p.y) as number) - 1.2)).toBeLessThan(0.05);
    }
  });

  test("threshold lines follow the floor diagonally (iso-distance y changes with x)", () => {
    const { model } = modelFromTvScreen(screenCorners(SHELF_CAM), TV, 4 / 3, SHELF_CAM.h);
    const ys = Array.from({ length: 21 }, (_, k) => isoDistanceY(model, 1.2, k / 20)).filter((y): y is number => y !== null);
    expect(ys.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(ys[0] - ys[ys.length - 1])).toBeGreaterThan(0.05);
  });

  test("points above the horizon are not on the floor", () => {
    const { model } = modelFromTvScreen(screenCorners(SHELF_CAM), TV, 4 / 3, SHELF_CAM.h);
    expect(distanceForFoot(model, 0.5, 0.02)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Screen detection on rendered frames
// ---------------------------------------------------------------------------
function render(cam: Cam, w: number, h: number, screenColor: [number, number, number] | null, seed = 1): RgbaImage {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const data = new Uint8Array(w * h * 4);
  const [tl, tr, br, bl] = screenCorners(cam);
  const quad = [tl, tr, br, bl].map((p) => ({ x: p.x * w, y: p.y * h }));
  const inside = (x: number, y: number) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c !== 0) {
        if (sign === 0) sign = Math.sign(c);
        else if (Math.sign(c) !== sign) return false;
      }
    }
    return true;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Wood floor / wall with noise, plus a pink cushion that is NOT the screen.
      let c: [number, number, number] = y > h * 0.55 ? [185, 140, 95] : [225, 220, 205];
      if (x > w * 0.75 && x < w * 0.85 && y > h * 0.6 && y < h * 0.7) c = [235, 70, 200];
      if (screenColor) {
        // 4× supersampled coverage for anti-aliased edges.
        let cov = 0;
        for (const [ox, oy] of [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ])
          if (inside(x + ox, y + oy)) cov++;
        cov /= 4;
        c = c.map((v, k) => v * (1 - cov) + screenColor[k] * cov) as [number, number, number];
      }
      const n = (rnd() - 0.5) * 16;
      data[i] = Math.max(0, Math.min(255, c[0] + n));
      data[i + 1] = Math.max(0, Math.min(255, c[1] + n));
      data[i + 2] = Math.max(0, Math.min(255, c[2] + n));
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}

describe("detectScreenQuad", () => {
  const W = 480;
  const H = 360;
  const on = render(SHELF_CAM, W, H, [240, 40, 230], 1);
  const off = render(SHELF_CAM, W, H, [12, 12, 14], 2);

  test("finds the four corners within 0.6 px, ignoring the pink cushion (differencing)", () => {
    const q = detectScreenQuad(on, off);
    const truth = screenCorners(SHELF_CAM);
    q.corners.forEach((c, i) => {
      expect(Math.abs(c.x - truth[i].x) * W).toBeLessThan(0.6);
      expect(Math.abs(c.y - truth[i].y) * H).toBeLessThan(0.6);
    });
    expect(q.fillRatio).toBeGreaterThan(0.95);
  });

  test("end to end: rendered frames → floor distance within 3 cm at 1.2 m", () => {
    const q = detectScreenQuad(on, off);
    const { model } = modelFromTvScreen(q.corners, TV, W / H, SHELF_CAM.h);
    for (const X of [-0.6, 0, 0.6]) {
      const p = project(SHELF_CAM, X, 1.2);
      if (p) expect(Math.abs((distanceForFoot(model, p.x, p.y) as number) - 1.2)).toBeLessThan(0.03);
    }
  });

  test("washed-out center (phone camera overexposes the magenta screen) → still one filled quad", () => {
    // Real phones: the middle of the screen clips to pale pink / white (low saturation), only the
    // rim stays clearly magenta. Seen as fill ratio 0.56 on a 43-inch TV (2026-09-26).
    const washed = new Uint8Array(on.data);
    const truth = screenCorners(SHELF_CAM).map((p) => ({ x: p.x * W, y: p.y * H }));
    const cx = truth.reduce((t, p) => t + p.x, 0) / 4;
    const cy = truth.reduce((t, p) => t + p.y, 0) / 4;
    const rx = (Math.max(...truth.map((p) => p.x)) - Math.min(...truth.map((p) => p.x))) * 0.3;
    const ry = (Math.max(...truth.map((p) => p.y)) - Math.min(...truth.map((p) => p.y))) * 0.3;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (e > 1) continue;
        const i = (y * W + x) * 4;
        const c = e < 0.4 ? [255, 255, 255] : [255, 228, 250]; // white core, pale pink ring
        washed.set(c, i);
      }
    const q = detectScreenQuad({ width: W, height: H, data: washed }, off);
    q.corners.forEach((c, i) => {
      expect(Math.abs(c.x * W - truth[i].x)).toBeLessThan(0.8);
      expect(Math.abs(c.y * H - truth[i].y)).toBeLessThan(0.8);
    });
    expect(q.fillRatio).toBeGreaterThan(0.95);
  });

  test("no screen in view → explicit error", () => {
    const blank = render(SHELF_CAM, W, H, null, 3);
    expect(() => detectScreenQuad(blank, blank)).toThrow(/was not found/);
  });
});

// ---------------------------------------------------------------------------
// Generated debug scene (public/debug/tv-*.jpg) — what /camera uses in debug mode
// ---------------------------------------------------------------------------
function loadDebug(name: string, maxSide = 640): RgbaImage {
  const full = jpeg.decode(readFileSync(`public/debug/${name}.jpg`), { useTArray: true });
  const f = Math.max(full.width, full.height) / maxSide;
  const w = Math.round(full.width / f);
  const h = Math.round(full.height / f);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = Math.floor(y * f); yy < Math.min(full.height, Math.floor((y + 1) * f)); yy++)
        for (let xx = Math.floor(x * f); xx < Math.min(full.width, Math.floor((x + 1) * f)); xx++) {
          const s = (yy * full.width + xx) * 4;
          r += full.data[s];
          g += full.data[s + 1];
          b += full.data[s + 2];
          n++;
        }
      data.set([r / n, g / n, b / n, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

describe("debug scene: generated photos of a 55-inch TV (black / magenta)", () => {
  test("screen found, plausible lens and TV height, near person nearer than far person", () => {
    const on = loadDebug("tv-magenta");
    const off = loadDebug("tv-black");
    const q = detectScreenQuad(on, off);
    // Hand-checked corners in the 1200×896 original.
    const truth = [
      [199, 214],
      [500, 202],
      [506, 382],
      [230, 454],
    ];
    q.corners.forEach((c, i) => {
      expect(Math.abs(c.x * 1200 - truth[i][0])).toBeLessThan(6);
      expect(Math.abs(c.y * 896 - truth[i][1])).toBeLessThan(6);
    });
    // The generated viewpoint is ~1.25 m high (/camera uses the same preset).
    const r = modelFromTvScreen(q.corners, screenSizeFromInches(55), on.width / on.height, 1.25);
    expect(r.pose.vfovDeg).toBeGreaterThan(40);
    expect(r.pose.vfovDeg).toBeLessThan(65);
    expect(r.screenBottomHeightM).toBeGreaterThan(0.3);
    expect(r.screenBottomHeightM).toBeLessThan(0.6);
    // Feet (hand-picked in the original): near ≈ 1 m, far farther.
    const near = distanceForFoot(r.model, 615 / 1200, 598 / 896) as number;
    const far = distanceForFoot(r.model, 690 / 1200, 640 / 896) as number;
    expect(near).toBeGreaterThan(0.7);
    expect(near).toBeLessThan(1.2);
    expect(far).toBeGreaterThan(near);
  });
});
