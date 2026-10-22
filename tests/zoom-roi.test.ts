import { manualZoomRoi, wholeInCrop } from "../lib/firesense/zoom-roi";
import { CameraCommandSchema, CameraStatusSchema } from "../lib/firesense/protocol";
import { describe, expect, test } from "vitest";
import { computeZoomRoi, mergePeople, scanTiles, ZoomScheduler, modelFromTvScreen, projectFloorPoint, projectRoomPoint, roiToFrame, screenSizeFromInches, type Pt2 } from "../lib/firesense";
import { project3, type Cam } from "./helpers/camera";
import { person } from "./helpers/landmarks";

const TV = screenSizeFromInches(43);
const SCREEN_BOTTOM = 0.5;

function tvModel(cam: Cam) {
  const W = TV.widthM;
  const H = TV.heightM;
  const c = [
    project3(cam, W / 2, SCREEN_BOTTOM + H, 0),
    project3(cam, -W / 2, SCREEN_BOTTOM + H, 0),
    project3(cam, -W / 2, SCREEN_BOTTOM, 0),
    project3(cam, W / 2, SCREEN_BOTTOM, 0),
  ];
  if (c.some((p) => !p)) throw new Error("screen not in view of the test camera");
  return modelFromTvScreen(c as [Pt2, Pt2, Pt2, Pt2], TV, cam.aspect, cam.h).model;
}

// Field setup 2026-09-27: phone on a shelf at 1.7 m across the room (~4.5 m from the TV), wide lens.
// Phone on a shelf beside the TV, looking diagonally into the room (as in detection-accuracy.test.ts).
const NEAR: Cam = { x: 1.9, z: 2.2, h: 1.2, yawDeg: 135, pitchDownDeg: 22, vfovDeg: 60, aspect: 4 / 3 };
const ACROSS: Cam = { x: 0.8, z: 4.5, h: 1.7, yawDeg: 190, pitchDownDeg: 18, vfovDeg: 62, aspect: 4 / 3 };

describe("zoom crop around the watch zone", () => {
  test("projects room points like the test camera (floor and above it)", () => {
    const m = tvModel(ACROSS);
    for (const [X, Y, Z] of [
      [0, 0, 1],
      [0.5, 1.0, 0.6],
      [-0.4, 1.8, 1.5],
    ]) {
      const want = project3(ACROSS, X, Y, Z)!;
      const got = projectRoomPoint(m, -X, Z, Y)!; // the model's lateral axis is the viewer's right (−X here)
      expect(got.x).toBeCloseTo(want.x, 3);
      expect(got.y).toBeCloseTo(want.y, 3);
    }
    expect(projectRoomPoint(m, 0.3, 1, 0)).toEqual(projectFloorPoint(m, 0.3, 1));
  });

  test("phone across the room: a 2×–3× crop that holds the whole zone and a person in it", () => {
    const m = tvModel(ACROSS);
    const roi = computeZoomRoi(m, { radiusM: 1.5 })!;
    expect(roi).not.toBeNull();
    expect(roi.zoom).toBeGreaterThanOrEqual(1.3);
    expect(roi.zoom).toBeLessThanOrEqual(3);
    expect(roi.x).toBeGreaterThanOrEqual(0);
    expect(roi.y).toBeGreaterThanOrEqual(0);
    expect(roi.x + roi.w).toBeLessThanOrEqual(1);
    expect(roi.y + roi.h).toBeLessThanOrEqual(1);
    const inside = (p: { x: number; y: number }) => p.x >= roi.x && p.x <= roi.x + roi.w && p.y >= roi.y && p.y <= roi.y + roi.h;
    // A 1 m child and a 1.8 m adult standing anywhere up to 1.4 m in front of the screen: head and feet in the crop.
    for (const [X, Z] of [
      [0, 0.4],
      [-0.9, 1.0],
      [1.0, 1.2],
      [0.2, 1.4],
    ]) {
      for (const top of [1.0, 1.8]) {
        expect(inside(project3(ACROSS, X, 0, Z)!)).toBe(true);
        expect(inside(project3(ACROSS, X, top, Z)!)).toBe(true);
      }
    }
  });

  test("phone near the TV (the zone fills the view): no crop", () => {
    expect(computeZoomRoi(tvModel(NEAR), { radiusM: 1.5 })).toBeNull();
  });

  test("a larger zone never zooms more", () => {
    const m = tvModel(ACROSS);
    expect(computeZoomRoi(m, { radiusM: 3.0 })?.zoom ?? 1).toBeLessThanOrEqual(computeZoomRoi(m, { radiusM: 1.5 })!.zoom);
  });

  test("landmarks from the crop map back to the frame; the same person from both passes counts once", () => {
    const roi = { x: 0.25, y: 0.2, w: 0.5, h: 0.5, zoom: 2 };
    const inCrop = person({ footY: 0.9, x: 0.5 });
    const [mapped] = roiToFrame([inCrop], roi);
    expect(mapped[27].x).toBeCloseTo(0.25 + inCrop[27].x * 0.5, 6);
    expect(mapped[27].y).toBeCloseTo(0.2 + inCrop[27].y * 0.5, 6);
    // The full frame saw the same person (slightly off) and someone else far from the zone.
    const sameFull = mapped.map((p) => ({ ...p, x: p.x + 0.01 }));
    const other = person({ footY: 0.95, x: 0.05 });
    const merged = mergePeople([sameFull, other], [mapped], 4 / 3);
    expect(merged.from).toEqual([
      { src: "zoom", index: 0 },
      { src: "full", index: 1 },
    ]);
    expect(merged.people[0]).toBe(mapped);
  });
});

describe("zoom scheduler: scan the zone in tiles, then follow", () => {
  const area = { x: 0.2, y: 0.05, w: 0.6, h: 0.6, zoom: 1.67, area: { x0: 0.25, y0: 0.1, x1: 0.75, y1: 0.55 } };

  test("4× tiles overlap and cover the zone's box", () => {
    const tiles = scanTiles(area, 4);
    expect(tiles.length).toBe(9);
    for (const t of tiles) expect(t.w).toBeCloseTo(0.25, 6);
    for (const [x, y] of [
      [0.26, 0.11],
      [0.5, 0.33],
      [0.74, 0.54],
    ]) {
      expect(tiles.some((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h)).toBe(true);
    }
  });

  test("a zone already zoomed enough is one crop", () => {
    expect(scanTiles({ x: 0.4, y: 0.4, w: 0.25, h: 0.25, zoom: 4 }, 4)).toHaveLength(1);
  });

  test("scans until a small person is found, follows them, scans again after 3 misses", () => {
    const z = new ZoomScheduler();
    z.setArea(area);
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) z.next(); // the first quiet frames: nobody yet, no scan
    for (let i = 0; i < 9; i++) {
      const t = z.next()!;
      seen.add(`${t.x},${t.y}`);
      z.observe([]);
    }
    expect(seen.size).toBe(9);
    expect(z.scanning).toBe(true);
    // A child 0.12 of the frame high at (0.6, 0.3).
    z.next();
    const child = person({ footY: 0.36, x: 0.6 }).map((p) => ({ ...p, y: 0.36 - (0.36 - p.y) * 0.15 }));
    z.observe([child]);
    expect(z.scanning).toBe(false);
    const f = z.next()!;
    expect(f.zoom).toBeGreaterThan(3);
    expect(0.6).toBeGreaterThan(f.x);
    expect(0.6).toBeLessThan(f.x + f.w);
    z.observe([]); // follow frame 1: missed
    // While following, every frame is the follow crop (no scan tiles: the target would keep switching).
    const again = z.next()!;
    expect(again).toEqual(f);
    z.observe([]);
    expect(z.scanning).toBe(false);
    z.next();
    z.observe([]); // third miss
    expect(z.scanning).toBe(true);
  });

  test("no scanning while the full frame sees someone; scanning starts after 3 frames with nobody", () => {
    const z = new ZoomScheduler();
    z.setArea(area);
    for (let i = 0; i < 5; i++) expect(z.next(true)).toBeNull();
    expect(z.next(false)).toBeNull();
    expect(z.next(false)).toBeNull();
    expect(z.next(false)).not.toBeNull(); // third quiet frame: scan
    expect(z.next(true)).toBeNull(); // someone again: stop at once
  });

  test("no zone, no zoom pass", () => {
    const z = new ZoomScheduler();
    z.setArea(null);
    expect(z.next()).toBeNull();
  });
});

describe("zoom area drawn by the parent", () => {
  test("a square crop around the drawn box, tiled at 4×, kept in the frame", () => {
    const roi = manualZoomRoi({ x0: 0.6, y0: 0.4, x1: 0.95, y1: 0.7 });
    expect(roi.w).toBeCloseTo(0.35);
    expect(roi.x + roi.w).toBeLessThanOrEqual(1);
    expect(roi.area).toEqual({ x0: 0.6, y0: 0.4, x1: 0.95, y1: 0.7 });
    const tiles = scanTiles(roi, 4);
    expect(tiles.length).toBeGreaterThan(1);
    for (const t of tiles) expect(t.zoom).toBeCloseTo(4);
  });

  test("corners in any order; a tiny box is an error, not a silent default", () => {
    expect(manualZoomRoi({ x0: 0.9, y0: 0.8, x1: 0.5, y1: 0.4 }).area).toEqual({ x0: 0.5, y0: 0.4, x1: 0.9, y1: 0.8 });
    expect(() => manualZoomRoi({ x0: 0.5, y0: 0.5, x1: 0.52, y1: 0.9 })).toThrow(/too small/);
  });

  test("the scheduler scans it like the computed zone", () => {
    const z = new ZoomScheduler();
    z.setArea(manualZoomRoi({ x0: 0.5, y0: 0.3, x1: 1, y1: 0.8 }));
    z.next();
    z.next();
    expect(z.next()).not.toBeNull(); // after the quiet frames, like the computed zone
  });

  test("protocol: the parent's command and the camera's status", () => {
    expect(CameraCommandSchema.safeParse({ kind: "set_zoom_area", area: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 } }).success).toBe(true);
    expect(CameraCommandSchema.safeParse({ kind: "set_zoom_area", area: null }).success).toBe(true);
    expect(CameraCommandSchema.safeParse({ kind: "set_zoom_area", area: { x0: 0.5, y0: 0.2, x1: 0.51, y1: 0.6 } }).success).toBe(false);
    expect(CameraStatusSchema.shape.zoom.safeParse({ area: null, active: false }).success).toBe(true);
  });
});

describe("people cut by the crop are dropped", () => {
  const body = (y0: number, y1: number) => Array.from({ length: 33 }, (_, i) => ({ x: 0.5, y: [0, 11, 12].includes(i) ? y0 : [27, 28].includes(i) ? y1 : (y0 + y1) / 2, visibility: 0.9 }));
  test("a whole small person stays; a tile through an adult's chest (feet invented at the edge) goes", () => {
    expect(wholeInCrop([body(0.2, 0.8)])).toHaveLength(1);
    expect(wholeInCrop([body(0.1, 0.995)])).toHaveLength(0);
    expect(wholeInCrop([body(-0.3, 0.9)])).toHaveLength(0);
  });
});

describe("skeleton-only view", () => {
  test("the parent can switch it; the camera reports it", () => {
    expect(CameraCommandSchema.safeParse({ kind: "set_skeleton_only", on: true }).success).toBe(true);
    expect(CameraStatusSchema.shape.skeletonOnly.safeParse(true).success).toBe(true);
    expect(CameraStatusSchema.shape.skeletonOnly.safeParse(undefined).success).toBe(true);
  });
});
