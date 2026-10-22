/**
 * FireSense Kids — Looking closer at the floor around the TV (camera phone).
 *
 * MediaPipe's person detector sees the whole frame at 224×224. Measured offline (scripts/pose-bench): a person stops being detected below about 0.3–0.4 of the height of the
 * image the model gets, whatever the thresholds, and the heavy model does no better. With the phone
 * across the room (field setup 2026-09-27: a shelf at 1.7 m, wide lens) a small child near the TV is
 * ~0.1 of the frame: never detected. A crop of the zone alone (~2×) was not enough; 4× tiles were.
 *
 *   - `computeZoomRoi`: with a TV-marker model the camera pose is known, so the zone's image box is
 *     computed, not guessed (floor within `radiusM` of the screen and a standing person on it). None
 *     when the zone already fills the view (phone near the TV) or lies partly behind the camera.
 *   - `ZoomScheduler`: scans that box in overlapping 4× tiles, one per frame, and once someone is found,
 *     follows them with a crop sized to them. One extra inference per frame.
 *   - `roiToFrame` / `mergePeople`: crop landmarks back to the frame, without counting anyone twice.
 *
 * Crops keep the frame's aspect ratio (w === h in normalized units), so landmarks map back linearly.
 */

import { invertAdjust, isHomography, screenDistanceContour, type FloorModel, type LandmarkPoint } from "./floor-calibration";

export interface ZoomRoi {
  /** Normalized to the full frame (0..1); w/h keep the frame's aspect (w === h in normalized units). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 1 / w. */
  zoom: number;
  /** The watch zone's own box in the image (clipped to the frame), before squaring and margins. */
  area?: { x0: number; y0: number; x1: number; y1: number };
}

export interface ZoomRoiOptions {
  /** Floor within this distance from the screen (m). */
  radiusM: number;
  /** Height of a standing person above that floor (m). Default 1.8. */
  personHeightM?: number;
  /** Margin around the box, as a fraction of its size. Default 0.12. */
  margin?: number;
  /** Largest zoom (the crop is at least 1/maxZoom of the frame). Default 3. */
  maxZoom?: number;
  /** Smaller zooms are not worth a second inference. Default 1.3. */
  minZoom?: number;
}

/** Image point (normalized) of a point `heightM` above the floor; null behind the camera. */
export function projectRoomPoint(model: FloorModel, lateralM: number, frontM: number, heightM: number): { x: number; y: number } | null {
  if (!isHomography(model) || !model.tvPose) return null;
  const { focal: f, r, camera: C, screenWidthM: W, imageAspect, cameraHeightM: h } = model.tvPose;
  ({ lateralM, frontM } = invertAdjust(model.tvPose.adjust, { lateralM, frontM }));
  const d = [W / 2 + lateralM - C.a, heightM - h, frontM - C.n];
  const cam = [0, 1, 2].map((k) => r[0][k] * d[0] + r[1][k] * d[1] + r[2][k] * d[2]);
  if (cam[2] <= 1e-6) return null;
  return { x: (f * cam[0]) / cam[2] / imageAspect + 0.5, y: (f * cam[1]) / cam[2] + 0.5 };
}

export function computeZoomRoi(model: FloorModel, opts: ZoomRoiOptions): ZoomRoi | null {
  if (!isHomography(model) || !model.tvPose) return null;
  const H = opts.personHeightM ?? 1.8;
  const margin = opts.margin ?? 0.12;
  const maxZoom = opts.maxZoom ?? 3;
  const minZoom = opts.minZoom ?? 1.3;
  const W = model.tvPose.screenWidthM;

  // The zone's outline (rounded band at radiusM) and the screen line, on the floor and at head height.
  const floor: { lateralM: number; frontM: number }[] = [];
  for (let i = 0; i <= 24; i++) floor.push(screenDistanceContour(W, opts.radiusM, -1 + i / 12));
  floor.push({ lateralM: -W / 2, frontM: 0 }, { lateralM: W / 2, frontM: 0 });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of floor) {
    for (const hM of [0, H]) {
      const q = projectRoomPoint(model, p.lateralM, p.frontM, hM);
      if (!q) return null; // part of the zone is behind the camera: the zone fills the view anyway
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      y0 = Math.min(y0, q.y);
      y1 = Math.max(y1, q.y);
    }
  }
  // Clip to the frame, add the margin, square it (in normalized units = the frame's aspect).
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(1, x1);
  y1 = Math.min(1, y1);
  if (!(x1 > x0 && y1 > y0)) return null; // zone not in view
  const s = Math.min(1, Math.max(1 / maxZoom, Math.max(x1 - x0, y1 - y0) * (1 + 2 * margin)));
  if (1 / s < minZoom) return null;
  const clamp = (c: number) => Math.min(1 - s, Math.max(0, c - s / 2));
  const x = clamp((x0 + x1) / 2);
  const y = clamp((y0 + y1) / 2);
  const area = { x0: round(Math.max(0, x0 - (x1 - x0) * margin)), y0: round(Math.max(0, y0 - (y1 - y0) * margin)), x1: round(Math.min(1, x1 + (x1 - x0) * margin)), y1: round(Math.min(1, y1 + (y1 - y0) * margin)) };
  return { x: round(x), y: round(y), w: round(s), h: round(s), zoom: Number((1 / s).toFixed(2)), area };
}

const round = (v: number) => Number(v.toFixed(4));

/** A box in the frame (normalized 0..1), drawn by the parent: "look closer here". */
export interface ZoomArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** Smallest side of a drawn area (normalized): smaller is a slip of the finger. */
export const MIN_ZOOM_AREA = 0.05;

/**
 * The zoom crop for an area the parent drew on the video, instead of the computed watch zone. Works with any
 * calibration (no TV pose needed). Same scan / follow as the computed one (the area is tiled at 4×), and
 * the full-frame pass still runs, so nobody outside the area is lost.
 */
export function manualZoomRoi(a: ZoomArea): ZoomRoi {
  const x0 = Math.max(0, Math.min(a.x0, a.x1));
  const x1 = Math.min(1, Math.max(a.x0, a.x1));
  const y0 = Math.max(0, Math.min(a.y0, a.y1));
  const y1 = Math.min(1, Math.max(a.y0, a.y1));
  if (!(x1 - x0 >= MIN_ZOOM_AREA && y1 - y0 >= MIN_ZOOM_AREA)) throw new Error(`Zoom area too small: ${JSON.stringify(a)}`);
  const s = Math.min(1, Math.max(1 / 5, Math.max(x1 - x0, y1 - y0)));
  const clamp = (c: number) => Math.min(1 - s, Math.max(0, c - s / 2));
  return {
    x: round(clamp((x0 + x1) / 2)),
    y: round(clamp((y0 + y1) / 2)),
    w: round(s),
    h: round(s),
    zoom: Number((1 / s).toFixed(2)),
    area: { x0: round(x0), y0: round(y0), x1: round(x1), y1: round(y1) },
  };
}

/** Head, shoulders, hips and ankles: a person found in a crop counts only when all of these lie inside it. */
const WHOLE_BODY = [0, 11, 12, 23, 24, 27, 28];
/** How close to the crop's edge (crop-normalized) a key point may lie. */
export const CROP_EDGE_MARGIN = 0.02;

/**
 * Keep only people seen whole in the crop (crop-normalized landmarks, before `roiToFrame`). A tile that cuts
 * through someone (a standing adult, a 4× tile over their chest) gives a body whose missing part is invented
 * at the tile's edge: feet at the tile's bottom read as standing far closer to the TV (field 2026-10-17:
 * 0.20 m for a person at 1.3 m). Such a person is large enough for the full-frame pass anyway.
 */
export function wholeInCrop(people: LandmarkPoint[][], margin = CROP_EDGE_MARGIN): LandmarkPoint[][] {
  return people.filter((lms) =>
    WHOLE_BODY.every((i) => {
      const p = lms[i];
      return p !== undefined && p.x >= margin && p.x <= 1 - margin && p.y >= margin && p.y <= 1 - margin;
    })
  );
}

/** Landmarks found in the crop, in full-frame coordinates. */
export function roiToFrame(people: LandmarkPoint[][], roi: ZoomRoi): LandmarkPoint[][] {
  return people.map((lms) => lms.map((p) => ({ ...p, x: roi.x + p.x * roi.w, y: roi.y + p.y * roi.h })));
}

const torsoCenter = (lms: LandmarkPoint[]) => {
  const k = [11, 12, 23, 24].map((i) => lms[i]).filter(Boolean);
  if (k.length === 0) return null;
  return { x: k.reduce((s, p) => s + p.x, 0) / k.length, y: k.reduce((s, p) => s + p.y, 0) / k.length };
};

/**
 * People from the full frame and from the zoomed crop (already in frame coordinates), without doubles:
 * a full-frame person whose torso center is within `sameM` (normalized, aspect-corrected) of a crop
 * person is the same person — the crop's landmarks (more pixels) are kept. Returns the indices into
 * the inputs so world landmarks can follow.
 */
export function mergePeople(
  full: LandmarkPoint[][],
  zoomed: LandmarkPoint[][],
  aspect: number,
  same = 0.08
): { people: LandmarkPoint[][]; from: { src: "full" | "zoom"; index: number }[] } {
  const zc = zoomed.map(torsoCenter);
  const people: LandmarkPoint[][] = [];
  const from: { src: "full" | "zoom"; index: number }[] = [];
  zoomed.forEach((lms, i) => {
    people.push(lms);
    from.push({ src: "zoom", index: i });
  });
  full.forEach((lms, i) => {
    const c = torsoCenter(lms);
    const dup = c !== null && zc.some((z) => z !== null && Math.hypot((z.x - c.x) * aspect, z.y - c.y) < same);
    if (dup) return;
    people.push(lms);
    from.push({ src: "full", index: i });
  });
  return { people, from };
}

// ---------------------------------------------------------------------------
// Which crop to look at in each frame: scan the zone in tiles, then follow the person found.
// ---------------------------------------------------------------------------

export interface ZoomSchedulerOptions {
  /** Zoom of a scan tile. Default 4 (a seated child ~0.1 of the frame needed 4×). */
  tileZoom?: number;
  /** While following, the person fills this fraction of the crop's height. Default 0.5. */
  fill?: number;
  /** Largest zoom while following. Default 5. */
  maxZoom?: number;
  /** Follow frames without the followed person before scanning only. Default 3. */
  lostAfter?: number;
  /** Frames in a row with nobody in the full-frame pass before scanning starts. Default 3. */
  quietFrames?: number;
}

const bodyBox = (lms: LandmarkPoint[]) => {
  const pts = lms.filter((p) => (p.visibility ?? 1) >= 0.3);
  if (pts.length < 4) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
};

/** A square crop (normalized) of size `s` centered on (cx, cy), kept inside the frame. */
function cropAt(cx: number, cy: number, s: number): ZoomRoi {
  const size = Math.min(1, s);
  const c = (v: number) => round(Math.min(1 - size, Math.max(0, v - size / 2)));
  return { x: c(cx), y: c(cy), w: round(size), h: round(size), zoom: Number((1 / size).toFixed(2)) };
}

/**
 * MediaPipe finds a person only when they are ≥ ~0.3–0.4 of the image it sees. The zone's crop alone
 * (often 2×) is not enough for a small child across the room, so:
 *   - scan: the zone's box is covered by overlapping tiles at `tileZoom`, one tile per frame — **only while
 *     nobody is found**: not while the full-frame pass sees someone (and for `quietFrames` frames after), and not
 *     while following someone found in a tile;
 *   - follow: once a person is found in a tile, the crop is centered on them every frame, sized so they fill
 *     `fill` of it; after `lostAfter` frames without them, back to the rule above.
 * Scanning while someone is found made the people seen change from frame to frame (a tile finds one person, the
 * next frame another), so the viewer the distance is about kept switching (field 2026-10-18). The price: while
 * someone is found, a second, small person that only a tile would find is not looked for until nobody is left.
 * At most one extra inference per frame. Pure: the page feeds back what it found.
 */
export class ZoomScheduler {
  private readonly tileZoom: number;
  private readonly fill: number;
  private readonly maxZoom: number;
  private readonly lostAfter: number;
  private tiles: ZoomRoi[] = [];
  private tile = 0;
  private follow: { cx: number; cy: number; s: number } | null = null;
  private misses = 0;
  private current: ZoomRoi | null = null;
  private readonly quietFrames: number;
  /** Frames in a row in which the full-frame pass found nobody. */
  private quiet = 0;

  constructor(opts: ZoomSchedulerOptions = {}) {
    this.tileZoom = opts.tileZoom ?? 4;
    this.fill = opts.fill ?? 0.5;
    this.maxZoom = opts.maxZoom ?? 5;
    this.lostAfter = opts.lostAfter ?? 3;
    this.quietFrames = opts.quietFrames ?? 3;
  }

  /** The zone's crop (computeZoomRoi); null = no zoom pass. */
  public setArea(roi: ZoomRoi | null): void {
    this.tiles = roi ? scanTiles(roi, this.tileZoom) : [];
    this.tile = 0;
    this.follow = null;
    this.misses = 0;
    this.current = null;
    this.quiet = 0;
  }

  public get scanning(): boolean {
    return this.follow === null;
  }

  /**
   * The crop for this frame, or null for no zoom pass: no zone, or someone is already found.
   * @param fullFound the full-frame pass found a (plausible) person in this frame
   */
  public next(fullFound = false): ZoomRoi | null {
    if (this.tiles.length === 0) return (this.current = null);
    if (this.follow) return (this.current = cropAt(this.follow.cx, this.follow.cy, this.follow.s));
    this.quiet = fullFound ? 0 : this.quiet + 1;
    if (this.quiet < this.quietFrames) return (this.current = null);
    this.current = this.tiles[this.tile % this.tiles.length];
    this.tile = (this.tile + 1) % this.tiles.length;
    return this.current;
  }

  /** People the zoom pass found in this frame's crop (full-frame coordinates, plausible ones only). */
  public observe(found: LandmarkPoint[][]): void {
    if (this.tiles.length === 0 || this.current === null) return;
    const boxes = found.map(bodyBox).filter((b): b is NonNullable<ReturnType<typeof bodyBox>> => b !== null);
    if (boxes.length === 0) {
      if (this.follow && ++this.misses >= this.lostAfter) {
        this.follow = null;
        this.misses = 0;
      }
      return;
    }
    // Keep following the same person: the box nearest to the current crop's center.
    const c = this.current ? { x: this.current.x + this.current.w / 2, y: this.current.y + this.current.h / 2 } : { x: 0.5, y: 0.5 };
    boxes.sort((a, b) => Math.hypot(a.cx - c.x, a.cy - c.y) - Math.hypot(b.cx - c.x, b.cy - c.y));
    const b = boxes[0];
    const s = Math.min(1, Math.max(1 / this.maxZoom, Math.max(b.h, b.w) / this.fill));
    this.misses = 0;
    // A person big enough for the full-frame pass needs no zoom: keep scanning for someone smaller.
    this.follow = s >= 1 / 1.3 ? null : { cx: b.cx, cy: b.cy, s };
  }
}

/** Overlapping square tiles (zoom `tileZoom`) covering the zone's box; at least ~40% overlap. */
export function scanTiles(roi: ZoomRoi, tileZoom: number): ZoomRoi[] {
  const t = 1 / tileZoom;
  const a = roi.area ?? { x0: roi.x, y0: roi.y, x1: roi.x + roi.w, y1: roi.y + roi.h };
  if (roi.w <= t * 1.1) return [roi];
  const centers = (lo: number, hi: number) => {
    const span = hi - lo;
    if (span <= t) return [(lo + hi) / 2];
    const n = Math.ceil((span - t) / (t * 0.6)) + 1;
    return Array.from({ length: n }, (_, i) => lo + t / 2 + ((span - t) * i) / (n - 1));
  };
  const out: ZoomRoi[] = [];
  for (const cy of centers(a.y0, a.y1)) for (const cx of centers(a.x0, a.x1)) out.push(cropAt(cx, cy, t));
  return out;
}
