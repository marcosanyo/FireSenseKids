/**
 * FireSense Kids — TV-marker calibration ("the TV tells the phone where it is").
 *
 * No tape. The paired Fire TV fills its screen with magenta, then black. The phone, placed
 * anywhere it can see both the screen and the floor in front of it (e.g. a shelf at the side
 * of the room), captures both frames and:
 *
 *   1. Screen detection (deterministic, sub-pixel)
 *      magenta-hue mask ∧ brightness difference (on − black) → largest connected component →
 *      convex hull → maximum-area inscribed quadrilateral → the boundary pixels of each side are
 *      re-fitted as straight lines (PCA) and intersected → four corners.
 *      Differencing removes pink furniture, clothes, posters: only what the TV itself changed.
 *   2. Self-calibrating pose
 *      The screen is a rectangle of known size (from its diagonal in inches). The plane→image
 *      homography H = K[r1 r2 t] gives the focal length from the orthogonality / equal-norm
 *      constraints of r1, r2 (no FOV input, no lens database), then the full camera pose.
 *   3. Floor model
 *      The TV stands upright, so the floor is perpendicular to the screen plane; with the lens
 *      height above the floor, every foot pixel maps to its perpendicular distance from the
 *      screen. The result is written as the same p/q homography used by tap calibration, so
 *      the threshold lines, d_edge and BELOW_FRAME work unchanged.
 */

import { L } from "./i18n";
import type { FloorHomographyModel } from "./floor-calibration";

export type Pt2 = { x: number; y: number };

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface ScreenQuad {
  /** Normalized image coordinates (0..1): top-left, top-right, bottom-right, bottom-left. */
  corners: [Pt2, Pt2, Pt2, Pt2];
  /** Detected screen area as a fraction of the frame. */
  areaFraction: number;
  /** RMS distance of the side pixels from the fitted side lines, in pixels of the analyzed frame. */
  edgeRmsPx: number;
  /** Component pixels / quadrilateral area (≈1 for an unoccluded screen). */
  fillRatio: number;
}

export interface ScreenSize {
  widthM: number;
  heightM: number;
}

export interface TvPose {
  /** Focal length in units of the image height. */
  focal: number;
  vfovDeg: number;
  /** Relative disagreement of the two focal-length constraints (0 = perfectly consistent). */
  focalMismatch: number;
  /** Camera center in screen coordinates: a = to the viewer's right from the screen's left edge,
   *  b = up from the screen's bottom edge, n = perpendicular distance in front of the screen. */
  camera: { a: number; b: number; n: number };
  /** Rotation world→camera, columns r1 (a), r2 (b), r3 (n), in camera coords (x right, y down, z forward). */
  r: [number[], number[], number[]];
}

export interface TvMarkerResult {
  model: FloorHomographyModel;
  pose: TvPose;
  /** Estimated height of the screen's bottom edge above the floor (a sanity check for the parent). */
  screenBottomHeightM: number;
  /** When the screen-bottom height was given: how far the TV size was off (1 = as entered), else null. */
  sizeScale: number | null;
  /** When gravity was used: the corner fit error, and the field of view the corners alone gave. */
  gravity: { rmsPx1000: number; cornersOnlyVfovDeg: number | null } | null;
}

// ---------------------------------------------------------------------------
// Screen size
// ---------------------------------------------------------------------------
export function screenSizeFromInches(diagonalInches: number, aspect = 16 / 9): ScreenSize {
  if (!(diagonalInches >= 10 && diagonalInches <= 150)) throw new Error(`TV size ${diagonalInches} inches is out of range (10–150)`);
  const d = diagonalInches * 0.0254;
  const k = Math.hypot(aspect, 1);
  return { widthM: (d * aspect) / k, heightM: d / k };
}

// ---------------------------------------------------------------------------
// 1. Screen detection
// ---------------------------------------------------------------------------
const MAGENTA_HUE = 300;
const OVEREXPOSED_MIN_SAT = 0.06;

function hueSatVal(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export interface ScreenDetectOptions {
  hueToleranceDeg?: number;
  minSaturation?: number;
  minValue?: number;
  /** Minimum increase of (R+B)/2 between the black and the magenta frame (0..255). */
  minDiff?: number;
}

/** Mask of pixels that turned magenta when the TV showed the marker (vs. the black reference frame). */
export function magentaMask(on: RgbaImage, off: RgbaImage, opts: ScreenDetectOptions = {}): Uint8Array {
  if (off.width !== on.width || off.height !== on.height) throw new Error("marker and reference frames differ in size");
  const tol = opts.hueToleranceDeg ?? 40;
  const minS = opts.minSaturation ?? 0.3;
  const minV = opts.minValue ?? 0.3;
  const minDiff = opts.minDiff ?? 35;
  const mask = new Uint8Array(on.width * on.height);
  for (let i = 0; i < mask.length; i++) {
    const r = on.data[i * 4];
    const g = on.data[i * 4 + 1];
    const b = on.data[i * 4 + 2];
    const [h, s, v] = hueSatVal(r, g, b);
    if (v < minV || hueDist(h, MAGENTA_HUE) > tol) continue;
    const before = (off.data[i * 4] + off.data[i * 4 + 2]) / 2;
    const rise = (r + b) / 2 - before;
    if (rise < minDiff) continue;
    // Overexposed magenta clips toward white (pale pink, low saturation). Accept it only where the
    // TV brightened the pixel strongly, so pale pink furniture (unchanged between frames) stays out.
    if (s < minS && !(s >= OVEREXPOSED_MIN_SAT && rise >= 3 * minDiff)) continue;
    mask[i] = 1;
  }
  return mask;
}

/** Largest 4-connected component of the mask (labels it 1, clears the rest). Returns its size. */
function keepLargestComponent(mask: Uint8Array, w: number, h: number): number {
  const label = new Int32Array(mask.length);
  let best = 0;
  let bestLabel = 0;
  let next = 0;
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let size = 0;
    stack.push(i);
    label[i] = next;
    while (stack.length) {
      const k = stack.pop() as number;
      size++;
      const x = k % w;
      const y = (k - x) / w;
      const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
      for (const n of nb) {
        if (n >= 0 && mask[n] && !label[n]) {
          label[n] = next;
          stack.push(n);
        }
      }
    }
    if (size > best) {
      best = size;
      bestLabel = next;
    }
  }
  for (let i = 0; i < mask.length; i++) mask[i] = label[i] === bestLabel && bestLabel > 0 ? 1 : 0;
  return best;
}

/**
 * Fills the holes of the (single-component) mask: every unmasked pixel that cannot reach the frame
 * border through unmasked pixels becomes masked. Phone cameras overexpose the middle of the magenta
 * screen to pale pink / white, which fails the hue/saturation test while the rim passes, so the
 * screen arrives as a ring. The screen itself is still a changed, enclosed region. Returns the new size.
 */
function fillHoles(mask: Uint8Array, w: number, h: number): number {
  const outside = new Uint8Array(mask.length);
  const stack: number[] = [];
  const seed = (k: number) => {
    if (!mask[k] && !outside[k]) {
      outside[k] = 1;
      stack.push(k);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const k = stack.pop() as number;
    const x = k % w;
    if (x > 0) seed(k - 1);
    if (x < w - 1) seed(k + 1);
    if (k >= w) seed(k - w);
    if (k < mask.length - w) seed(k + w);
  }
  let size = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!outside[i]) mask[i] = 1;
    size += mask[i];
  }
  return size;
}

function cross(o: Pt2, a: Pt2, b: Pt2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Andrew's monotone chain; returns the hull in counter-clockwise order (math orientation). */
export function convexHull(points: Pt2[]): Pt2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower: Pt2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function polyArea(p: Pt2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Maximum-area quadrilateral with vertices on the hull (hull subsampled to ≤ 48 vertices). */
function maxAreaQuad(hull: Pt2[]): Pt2[] {
  const step = Math.max(1, hull.length / 48);
  const h: Pt2[] = [];
  for (let i = 0; i < hull.length; i += step) h.push(hull[Math.floor(i)]);
  const n = h.length;
  if (n < 4) throw new Error(L("The screen shape is too small to find its four corners", "画面の形が小さすぎて四隅を決められません"));
  let best = -1;
  let quad: Pt2[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++)
        for (let l = k + 1; l < n; l++) {
          const a = polyArea([h[i], h[j], h[k], h[l]]);
          if (a > best) {
            best = a;
            quad = [h[i], h[j], h[k], h[l]];
          }
        }
  return quad;
}

type Line = { px: number; py: number; ux: number; uy: number };

function fitLine(pts: Pt2[]): { line: Line; rms: number } {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const line = { px: mx, py: my, ux: Math.cos(th), uy: Math.sin(th) };
  const rms = Math.sqrt(pts.reduce((s, p) => s + (-line.uy * (p.x - mx) + line.ux * (p.y - my)) ** 2, 0) / n);
  return { line, rms };
}

function intersect(a: Line, b: Line): Pt2 {
  const det = a.ux * -b.uy - a.uy * -b.ux;
  if (Math.abs(det) < 1e-9) throw new Error(L("Two sides of the screen look parallel, so the corner cannot be found", "画面の2辺が平行に見えるため、角を決められません"));
  const dx = b.px - a.px;
  const dy = b.py - a.py;
  const t = (dx * -b.uy - dy * -b.ux) / det;
  return { x: a.px + a.ux * t, y: a.py + a.uy * t };
}

function segDist(p: Pt2, a: Pt2, b: Pt2): { d: number; t: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L2 = vx * vx + vy * vy;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2));
  return { d: Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy), t };
}

export function detectScreenQuad(on: RgbaImage, off: RgbaImage, opts: ScreenDetectOptions = {}): ScreenQuad {
  const { width: w, height: h } = on;
  const mask = magentaMask(on, off, opts);
  const found = keepLargestComponent(mask, w, h);
  if (found < w * h * 0.002) {
    throw new Error(
      L(`The TV screen (magenta) was not found (${found} pixels detected). Check that the TV screen is in the phone's view and has no strong reflection.`, `テレビ画面（マゼンタ）が見つかりません（検出 ${found} 画素）。スマホの映像にテレビ画面が入っているか、画面に強い反射がないか確認してください。`)
    );
  }
  const size = fillHoles(mask, w, h);
  // Sub-pixel boundary samples. α = how much the TV brightened this pixel, relative to the
  // median inside the screen (1 = fully screen, 0 = background). Between an inside pixel and its
  // outside neighbor the edge sits where α crosses ½ (anti-aliasing / lens blur make α fractional).
  const diff = new Float32Array(w * h);
  const inside: number[] = [];
  for (let i = 0; i < diff.length; i++) {
    diff[i] = (on.data[i * 4] + on.data[i * 4 + 2]) / 2 - (off.data[i * 4] + off.data[i * 4 + 2]) / 2;
    if (mask[i]) inside.push(diff[i]);
  }
  inside.sort((a, b) => a - b);
  const full = inside[Math.floor(inside.length / 2)];
  const alpha = (i: number) => Math.max(0, Math.min(1, diff[i] / full));
  const edge: Pt2[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          edge.push({ x: x + 0.5 + dx * 0.5, y: y + 0.5 + dy * 0.5 });
          continue;
        }
        const j = ny * w + nx;
        if (mask[j]) continue;
        const ai = alpha(i);
        const aj = alpha(j);
        const t = ai - aj > 1e-3 ? Math.max(0, Math.min(1, (ai - 0.5) / (ai - aj))) : 0.5;
        edge.push({ x: x + 0.5 + dx * t, y: y + 0.5 + dy * t });
      }
    }
  let quad = maxAreaQuad(convexHull(edge));

  // Refine: re-fit each side from its own boundary samples, then intersect neighbors.
  let rmsAll = 0;
  for (let iter = 0; iter < 3; iter++) {
    const sides: Pt2[][] = [[], [], [], []];
    const tol = Math.max(2, 0.01 * Math.hypot(w, h));
    for (const p of edge) {
      let bi = -1;
      let bd = Infinity;
      let bt = 0;
      for (let i = 0; i < 4; i++) {
        const r = segDist(p, quad[i], quad[(i + 1) % 4]);
        if (r.d < bd) {
          bd = r.d;
          bi = i;
          bt = r.t;
        }
      }
      // Skip the rounded / blurred corners and anything far from the side.
      if (bd <= tol && bt > 0.08 && bt < 0.92) sides[bi].push(p);
    }
    if (sides.some((s) => s.length < 8)) throw new Error(L("Part of a screen edge is not visible (hidden by an object or a person, or cut off at the edge of the view).", "画面の辺の一部が見えていません（物や人で隠れている、または映像の端で切れている可能性）。"));
    const fits = sides.map(fitLine);
    rmsAll = Math.sqrt(fits.reduce((s, f, i) => s + f.rms ** 2 * sides[i].length, 0) / sides.reduce((s, x) => s + x.length, 0));
    quad = [0, 1, 2, 3].map((i) => intersect(fits[(i + 3) % 4].line, fits[i].line));
  }
  const area = polyArea(quad);
  const fillRatio = size / area;
  if (fillRatio < 0.85 || fillRatio > 1.1) {
    throw new Error(L(`The detected area is not a rectangle (fill ratio ${fillRatio.toFixed(2)}). Check that nothing and nobody is in front of the screen.`, `検出した領域が四角形になっていません（充填率 ${fillRatio.toFixed(2)}）。画面の前に物や人がいないか確認してください。`));
  }
  // Order: top side = the side whose midpoint is highest in the image; then clockwise (y down).
  let top = 0;
  for (let i = 1; i < 4; i++) {
    const mi = (quad[i].y + quad[(i + 1) % 4].y) / 2;
    const mt = (quad[top].y + quad[(top + 1) % 4].y) / 2;
    if (mi < mt) top = i;
  }
  const a = quad[top];
  const b = quad[(top + 1) % 4];
  // Walk from the top-left corner in the direction of the top-right one.
  const forward = a.x < b.x;
  const start = forward ? top : (top + 1) % 4;
  const dir = forward ? 1 : 3;
  const ordered = [0, 1, 2, 3].map((k) => quad[(start + dir * k) % 4]);
  const corners = ordered.map((p) => ({ x: p.x / w, y: p.y / h })) as [Pt2, Pt2, Pt2, Pt2];
  return { corners, areaFraction: area / (w * h), edgeRmsPx: Number(rmsAll.toFixed(2)), fillRatio: Number(fillRatio.toFixed(3)) };
}

// ---------------------------------------------------------------------------
// 2. Pose from the screen rectangle (self-calibrating focal length)
// ---------------------------------------------------------------------------
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error("singular system (degenerate screen corners)");
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homography (h33 = 1) mapping src → dst from exactly four correspondences. Row-major 3×3. */
export function homography4(src: Pt2[], dst: Pt2[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(A, b), 1];
}

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const scale3 = (a: number[], s: number) => a.map((c) => c * s);
const sub3 = (a: number[], b: number[]) => a.map((c, i) => c - b[i]);
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Normalized image point → centered coordinates in units of the image height (y down). */
const toCentered = (p: Pt2, aspect: number): Pt2 => ({ x: (p.x - 0.5) * aspect, y: p.y - 0.5 });

/** `focalOverride` (in units of the image height) skips the focal estimate, e.g. when gravity fixes it. */
export function solveTvPose(corners: [Pt2, Pt2, Pt2, Pt2], screen: ScreenSize, imageAspect: number, focalOverride?: number): TvPose {
  const { widthM: W, heightM: H } = screen;
  // Screen plane coordinates: a to the viewer's right, b up (origin = bottom-left as seen from the room).
  const plane: Pt2[] = [
    { x: 0, y: H },
    { x: W, y: H },
    { x: W, y: 0 },
    { x: 0, y: 0 },
  ];
  const img = corners.map((c) => toCentered(c, imageAspect));
  const Hm = homography4(plane, img);
  const h1 = [Hm[0], Hm[3], Hm[6]];
  const h2 = [Hm[1], Hm[4], Hm[7]];
  const h3 = [Hm[2], Hm[5], Hm[8]];

  // K = diag(f, f, 1). With w = 1/f²:  r1·r2 = 0  and  |r1| = |r2|.
  const a1 = h1[0] * h2[0] + h1[1] * h2[1];
  const b1 = h1[2] * h2[2];
  const a2 = h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2;
  const b2 = h1[2] ** 2 - h2[2] ** 2;
  let f: number;
  if (focalOverride !== undefined) {
    f = focalOverride;
  } else {
    const w = -(a1 * b1 + a2 * b2) / (a1 * a1 + a2 * a2);
    if (!(w > 0)) {
      throw new Error(L("The phone sees the TV almost head-on, so the camera's field of view cannot be solved. Place the phone at an angle to the TV.", "テレビ画面を正面に近い角度で見ているため、カメラの画角を求められません。スマホをテレビに対して斜めの位置に置いてください。"));
    }
    f = 1 / Math.sqrt(w);
  }
  const vfovDeg = (2 * Math.atan(0.5 / f) * 180) / Math.PI;
  if (vfovDeg < 20 || vfovDeg > 120) {
    throw new Error(L(`The estimated field of view ${vfovDeg.toFixed(0)}° is impossible for a phone camera. Check the TV size (inches) and the detected screen corners.`, `推定した画角 ${vfovDeg.toFixed(0)}° がスマホのカメラとしてありえません。テレビの型（インチ）と、画面の四隅の検出を確認してください。`));
  }
  // Each constraint alone (where well conditioned) — their disagreement is a quality signal.
  const f1 = Math.abs(b1) > 1e-12 && -a1 / b1 > 0 ? Math.sqrt(-a1 / b1) : null;
  const f2 = Math.abs(b2) > 1e-12 && -a2 / b2 > 0 ? Math.sqrt(-a2 / b2) : null;
  const focalMismatch = f1 !== null && f2 !== null ? Math.abs(f1 - f2) / f : 0;

  const kinv = (h: number[]) => [h[0] / f, h[1] / f, h[2]];
  const k1 = kinv(h1);
  const k2 = kinv(h2);
  let lambda = (norm3(k1) + norm3(k2)) / 2;
  let t = scale3(kinv(h3), 1 / lambda);
  if (t[2] < 0) {
    lambda = -lambda;
    t = scale3(t, -1);
  }
  let r1 = scale3(k1, 1 / lambda);
  let r2 = scale3(k2, 1 / lambda);
  r1 = scale3(r1, 1 / norm3(r1));
  r2 = sub3(r2, scale3(r1, dot3(r1, r2)));
  r2 = scale3(r2, 1 / norm3(r2));
  const r3 = cross3(r1, r2);
  const camera = { a: -dot3(r1, t), b: -dot3(r2, t), n: -dot3(r3, t) };
  if (!(camera.n > 0)) throw new Error(L("The estimated camera position is behind the TV. Check the detected screen corners.", "推定したカメラ位置がテレビの裏側になりました。画面の四隅の検出を確認してください。"));
  return { focal: f, vfovDeg, focalMismatch: Number(focalMismatch.toFixed(3)), camera, r: [r1, r2, r3] };
}

// ---------------------------------------------------------------------------
// 3. Floor model
// ---------------------------------------------------------------------------
/**
 * With the screen bottom's height measured too, the TV size is checked instead of trusted: the camera's
 * height above the screen bottom comes out of the pose in proportion to the assumed screen size, so
 * (lens height − screen-bottom height) / (that height) is the factor the size was off by (a wrong
 * TV size, or a bezel/aspect that differs). Needs at least 0.15 m between the two heights.
 */
export function modelFromTvScreen(
  corners: [Pt2, Pt2, Pt2, Pt2],
  screenIn: ScreenSize,
  imageAspect: number,
  cameraHeightM: number,
  screenBottomHeightM?: number,
  /** Gravity's "up" in camera coordinates (lib/client/gravity.ts); fixes the field of view. */
  upCam?: [number, number, number]
): TvMarkerResult {
  if (upCam) return modelFromGravityPose(corners, screenIn, imageAspect, cameraHeightM, screenBottomHeightM, upCam);
  if (!(cameraHeightM > 0.05 && cameraHeightM < 3)) throw new Error(L(`The phone height ${cameraHeightM} m is out of range`, `スマホの高さ ${cameraHeightM}m が範囲外です`));
  let screen = screenIn;
  let sizeScale: number | null = null;
  if (screenBottomHeightM !== undefined) {
    if (!(screenBottomHeightM >= 0 && screenBottomHeightM < 2.5)) throw new Error(L(`The screen-bottom height ${screenBottomHeightM} m is out of range`, `画面の下端の高さ ${screenBottomHeightM}m が範囲外です`));
    const measured = cameraHeightM - screenBottomHeightM;
    if (Math.abs(measured) < 0.15) {
      throw new Error(L(`The lens and the screen bottom differ in height by only ${Math.round(Math.abs(measured) * 100)} cm, too little to check the TV size (15 cm or more needed). Leave the screen-bottom height empty`, `スマホのレンズと画面の下端の高さの差が ${Math.round(Math.abs(measured) * 100)}cm しかなく、テレビの大きさの確認に使えません（15cm 以上必要）。画面の下端の高さは空欄にしてください`));
    }
    const fromPose = solveTvPose(corners, screenIn, imageAspect).camera.b;
    sizeScale = measured / fromPose;
    if (!(sizeScale > 0.6 && sizeScale < 1.6)) {
      throw new Error(
        L(`The inputs disagree: with this TV size the phone should be ${Math.round(fromPose * 100)} cm above the screen bottom, but the entered heights differ by ${Math.round(measured * 100)} cm. Check the TV size, the lens height and the screen-bottom height`, `入力が食い違っています: この型だとスマホは画面の下端より ${Math.round(fromPose * 100)}cm 上にあるはずですが、入力した高さの差は ${Math.round(measured * 100)}cm です。型・レンズの高さ・画面の下端の高さを確認してください`)
      );
    }
    screen = { widthM: screenIn.widthM * sizeScale, heightM: screenIn.heightM * sizeScale };
  }
  const pose = solveTvPose(corners, screen, imageAspect);
  return { ...floorModelFromPose(pose, screen, imageAspect, cameraHeightM), sizeScale: sizeScale === null ? null : Number(sizeScale.toFixed(3)), gravity: null };
}

function modelFromGravityPose(
  corners: [Pt2, Pt2, Pt2, Pt2],
  screenIn: ScreenSize,
  imageAspect: number,
  cameraHeightM: number,
  screenBottomHeightM: number | undefined,
  upCam: [number, number, number]
): TvMarkerResult {
  const g = solveTvPoseGravity({ corners, screen: screenIn, imageAspect, upCam, cameraHeightM, screenBottomHeightM });
  const screen = { widthM: screenIn.widthM * g.sizeScale, heightM: screenIn.heightM * g.sizeScale };
  let cornersOnlyVfovDeg: number | null = null;
  try {
    cornersOnlyVfovDeg = Number(solveTvPose(corners, screenIn, imageAspect).vfovDeg.toFixed(1));
  } catch {
    cornersOnlyVfovDeg = null; // the corners alone cannot give it (head-on view); shown as "—"
  }
  return {
    ...floorModelFromPose(g.pose, screen, imageAspect, cameraHeightM),
    sizeScale: screenBottomHeightM === undefined ? null : g.sizeScale,
    gravity: { rmsPx1000: g.rmsPx1000, cornersOnlyVfovDeg },
  };
}

function floorModelFromPose(pose: TvPose, screen: ScreenSize, imageAspect: number, cameraHeightM: number): Omit<TvMarkerResult, "sizeScale" | "gravity"> {
  const [r1, r2, r3] = pose.r;
  const f = pose.focal;
  const C = pose.camera;
  // Ray for normalized (x, y): d_cam = ((x − ½)·aspect / f, (y − ½) / f, 1); world components are r_i · d_cam.
  // Each is affine in (x, y): coef = [∂/∂x, ∂/∂y, const].
  const affine = (r: number[]) => [(r[0] * imageAspect) / f, r[1] / f, r[2] - (r[0] * imageAspect) / (2 * f) - r[1] / (2 * f)];
  const db = affine(r2);
  const dn = affine(r3);
  // Floor: b = C.b − h. Along the ray, s = −h / d_b (> 0 needs d_b < 0), n = (C.n·d_b − h·d_n) / d_b.
  const num = db.map((c, i) => C.n * c - cameraHeightM * dn[i]);
  // Normalize so the denominator is positive exactly where the ray goes down to the floor.
  const s = -Math.max(...db.map(Math.abs));
  const p = num.map((c) => c / s) as [number, number, number];
  const den = db.map((c) => c / s);
  const model: FloorHomographyModel = {
    kind: "homography",
    method: "tv_marker",
    p,
    q: [den[0], den[1]],
    q3: den[2],
    maxResidualM: 0,
    lines: [],
    calibratedAt: Date.now(),
    tvPose: { focal: f, r: pose.r, camera: C, screenWidthM: screen.widthM, imageAspect, cameraHeightM },
  };
  return { model, pose, screenBottomHeightM: Number((cameraHeightM - C.b).toFixed(3)) };
}

// ---------------------------------------------------------------------------
// Gravity-anchored pose: fewer unknowns, much less sensitive to the corners
// ---------------------------------------------------------------------------
//
// Solving the full camera pose from four corners of a TV that fills a fifth of the frame is unstable:
// a 1–2 px error in a corner moves the floor by 0.3–0.6 m (tests/zone-adjust.test.ts). With gravity the
// camera's tilt and roll are known; with the lens height the camera's height is known. What is left is
// the direction the camera faces around the vertical (yaw), its position along and in front of the
// screen, the field of view, and the screen bottom's height (unless measured): 4–5 numbers fitted to
// the 8 corner coordinates by least squares (Levenberg–Marquardt, numeric Jacobian).

export interface GravityPoseInput {
  corners: [Pt2, Pt2, Pt2, Pt2];
  screen: ScreenSize;
  imageAspect: number;
  /** Gravity's "up" in camera coordinates (x right, y down, z forward). */
  upCam: [number, number, number];
  cameraHeightM: number;
  /** Measured screen-bottom height; when absent it is fitted. */
  screenBottomHeightM?: number;
}

export interface GravityPose {
  pose: TvPose;
  screenBottomHeightM: number;
  /** Factor the entered TV size was off by (1 unless the screen bottom was measured). */
  sizeScale: number;
  /** Root-mean-square corner reprojection error, in pixels of a 1000-px-high frame. */
  rmsPx1000: number;
}

export function solveTvPoseGravity(input: GravityPoseInput): GravityPose {
  const { corners, screen, imageAspect: asp, cameraHeightM: h } = input;
  const up = normalize3(input.upCam);
  // Horizontal reference: the camera's forward axis, flattened.
  const fwd = [0, 0, 1];
  let h1 = sub3(fwd, scale3(up, dot3(fwd, up)));
  if (norm3(h1) < 1e-6) throw new Error(L("The phone points straight up or down, so its heading cannot be found", "スマホが真上か真下を向いているため、向きを決められません"));
  h1 = scale3(h1, 1 / norm3(h1));
  const h2 = cross3(up, h1);
  const fixedBottom = input.screenBottomHeightM;
  // p[3]: the screen bottom's height when it is not measured; when it is, ln(size factor) of the TV
  // (the entered size may be wrong — the same check as modelFromTvScreen's without gravity).
  const sizeOf = (p: number[]) => (fixedBottom === undefined ? 1 : Math.exp(p[3]));
  const bottomOf = (p: number[]) => fixedBottom ?? p[3];
  const planeOf = (p: number[]) => {
    const W = screen.widthM * sizeOf(p);
    const H = screen.heightM * sizeOf(p);
    return [
      [0, H],
      [W, H],
      [W, 0],
      [0, 0],
    ];
  };

  // p = [yaw, Ca, Cn, Hsb | ln size, ln f]
  const axes = (yaw: number) => {
    // n = direction from the screen toward the room, in camera coordinates; the camera looks roughly at
    // the screen, so n points back toward the camera (−forward) at yaw 0.
    const n = sub3(scale3(h1, -Math.cos(yaw)), scale3(h2, Math.sin(yaw)));
    const a = cross3(up, n);
    return { a, b: up, n };
  };
  const project = (p: number[]) => {
    const { a, b, n } = axes(p[0]);
    const f = Math.exp(p[4]);
    const C = [p[1], h - bottomOf(p), p[2]];
    return planeOf(p).map(([pa, pb]) => {
      const d = [pa - C[0], pb - C[1], 0 - C[2]];
      const X = [0, 1, 2].map((k) => a[k] * d[0] + b[k] * d[1] + n[k] * d[2]);
      if (X[2] <= 1e-6) return null;
      return { x: (f * X[0]) / X[2] / asp + 0.5, y: (f * X[1]) / X[2] + 0.5 };
    });
  };
  const residuals = (p: number[]) => {
    const pr = project(p);
    const r: number[] = [];
    pr.forEach((q, i) => {
      if (!q) r.push(10, 10);
      else r.push((q.x - corners[i].x) * asp, q.y - corners[i].y);
    });
    return r;
  };
  const cost = (p: number[]) => residuals(p).reduce((s, v) => s + v * v, 0);

  // Start: several yaws and fields of view; the camera somewhere in front of the screen.
  let best: number[] | null = null;
  let bestC = Infinity;
  for (const yawDeg of [-60, -30, 0, 30, 60]) {
    for (const vfov of [40, 55, 70, 90]) {
      for (const dist of [1.5, 3, 5]) {
        const yaw = (yawDeg * Math.PI) / 180;
        const p0 = [yaw, screen.widthM / 2 + dist * Math.sin(yaw), dist * Math.cos(yaw), fixedBottom === undefined ? 0.5 : 0, Math.log(0.5 / Math.tan((vfov * Math.PI) / 360))];
        const p = levenbergMarquardt(residuals, p0, []);
        const c = cost(p);
        if (c < bestC) {
          bestC = c;
          best = p;
        }
      }
    }
  }
  if (!best) throw new Error(L("Could not solve the TV position", "テレビの位置を解けませんでした"));
  const p = best;
  const f = Math.exp(p[4]);
  const vfovDeg = (2 * Math.atan(0.5 / f) * 180) / Math.PI;
  const rmsPx1000 = Math.sqrt(bestC / 8) * 1000;
  if (rmsPx1000 > 6) {
    throw new Error(
      L(`The screen corners do not agree with the motion sensor, the entered height and the TV size (error ${rmsPx1000.toFixed(1)} px per 1000 px). Check that the phone has not moved, the TV size and lens height you entered, and the detected corners.`, `画面の四隅と、傾きセンサー・入力した高さ・テレビの大きさが合いません（ずれ ${rmsPx1000.toFixed(1)}px/1000px）。スマホを動かしていないか、テレビの型とレンズの高さの入力、四隅の検出を確認してください。`)
    );
  }
  if (vfovDeg < 20 || vfovDeg > 120) throw new Error(L(`The estimated field of view ${vfovDeg.toFixed(0)}° is impossible for a camera. Check the TV size (inches).`, `推定した画角 ${vfovDeg.toFixed(0)}° がカメラとしてありえません。テレビの型（インチ）を確認してください。`));
  const Hsb = bottomOf(p);
  const sizeScale = sizeOf(p);
  if (!(sizeScale > 0.6 && sizeScale < 1.6)) throw new Error(L(`The entered TV size and the size solved from the corners differ by a factor of ${sizeScale.toFixed(2)}. Check the TV size, the lens height and the screen-bottom height.`, `入力したテレビの型と、四隅から求めた大きさが ${sizeScale.toFixed(2)} 倍違います。型・レンズの高さ・画面の下端の高さを確認してください。`));
  if (fixedBottom === undefined && !(Hsb > -0.1 && Hsb < 2.5)) throw new Error(L(`The estimated screen-bottom height ${Math.round(Hsb * 100)} cm is impossible. Check the lens height and the TV size.`, `推定した画面の下端の高さ ${Math.round(Hsb * 100)}cm がありえません。レンズの高さとテレビの型を確認してください。`));
  const { a, b, n } = axes(p[0]);
  const camera = { a: p[1], b: h - Hsb, n: p[2] };
  if (!(camera.n > 0)) throw new Error(L("The estimated camera position is behind the TV. Check the detected screen corners.", "推定したカメラ位置がテレビの裏側になりました。画面の四隅の検出を確認してください。"));
  return {
    pose: { focal: f, vfovDeg, focalMismatch: 0, camera, r: [a, b, n] },
    screenBottomHeightM: Number(Hsb.toFixed(3)),
    sizeScale: Number(sizeScale.toFixed(3)),
    rmsPx1000: Number(rmsPx1000.toFixed(2)),
  };
}

const normalize3 = (v: number[]) => scale3(v, 1 / norm3(v));

/** Small dense Levenberg–Marquardt with a numeric Jacobian; `frozen` parameter indices stay put. */
function levenbergMarquardt(res: (p: number[]) => number[], p0: number[], frozen: number[], iters = 60): number[] {
  let p = [...p0];
  let lambda = 1e-2;
  const sq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);
  let r = res(p);
  let c = sq(r);
  const free = p.map((_, i) => i).filter((i) => !frozen.includes(i));
  for (let it = 0; it < iters; it++) {
    const J = free.map((i) => {
      const e = 1e-6 * Math.max(1, Math.abs(p[i]));
      const q = [...p];
      q[i] += e;
      const rq = res(q);
      return rq.map((v, k) => (v - r[k]) / e);
    }); // J[j][k] = ∂r_k/∂p_free[j]
    const m = free.length;
    const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => J[i].reduce((s, v, k) => s + v * J[j][k], 0)));
    const g = Array.from({ length: m }, (_, i) => J[i].reduce((s, v, k) => s + v * r[k], 0));
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (A[i][i] || 1) : 0)));
      const step = solveLinear(M, g.map((v) => -v));
      if (!step) {
        lambda *= 10;
        continue;
      }
      const q = [...p];
      free.forEach((i, j) => (q[i] += step[j]));
      const rq = res(q);
      const cq = sq(rq);
      if (cq < c) {
        p = q;
        r = rq;
        const done = c - cq < 1e-14;
        c = cq;
        lambda = Math.max(1e-9, lambda / 3);
        improved = true;
        if (done) return p;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return p;
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
    if (Math.abs(M[piv][i]) < 1e-18) return null;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}
