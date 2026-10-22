/**
 * The room's "up" direction in the camera's coordinates, from the phone's accelerometer.
 *
 * Why: the TV-marker calibration solves the camera from four screen corners alone. The camera's field
 * of view comes out of two weak constraints, and when the TV is seen close to head-on it is badly
 * determined (field, 2026-09-27: 1 m read as 1.7 m, the zone lines far off). The accelerometer knows
 * exactly which way is up; the field of view that makes the TV's vertical edges agree with it is the
 * right one (tv-marker.ts `solveTvPoseWithUp`). The same vector, watched afterwards, tells when the
 * phone was moved or turned since the calibration.
 *
 * Axes. DeviceMotionEvent.accelerationIncludingGravity at rest points up, in the device frame: x to the
 * right of the screen held in its natural (portrait) orientation, y toward its top, z out of the screen.
 * Chrome on Android delivers camera frames rotated to the screen orientation (screen.orientation.angle
 * = how far the content is turned counter-clockwise), so the frame's right/down are the screen's.
 * Camera coordinates: x right, y down in the frame, z forward. The rear camera looks out of the back
 * (−z); the front camera out of the screen (+z), its raw frame is not mirrored (the preview is, by CSS).
 */

import { L } from "../firesense/i18n";


export type Vec3 = [number, number, number];

export function upInCamera(a: Vec3, screenAngleDeg: number, facing: "environment" | "user"): Vec3 {
  const t = (screenAngleDeg * Math.PI) / 180;
  const sx: Vec3 = [Math.cos(t), -Math.sin(t), 0]; // frame right, in device axes
  const sy: Vec3 = [-Math.sin(t), -Math.cos(t), 0]; // frame down, in device axes
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const v: Vec3 = facing === "environment" ? [dot(a, sx), dot(a, sy), -a[2]] : [-dot(a, sx), dot(a, sy), a[2]];
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!(n > 0)) throw new Error(L("The accelerometer reads zero", "加速度センサーの値が0です"));
  return [v[0] / n, v[1] / n, v[2] / n];
}

export const angleBetweenDeg = (u: Vec3, v: Vec3) => (Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) * 180) / Math.PI;

/**
 * Averages the accelerometer for `ms` while the phone lies still. Rejects when the sensor is missing
 * or blocked, or when the phone moved during the measurement (the spread says so).
 */
export async function measureGravity(ms = 1500): Promise<{ a: Vec3; samples: number }> {
  const DME = (typeof window !== "undefined" ? window.DeviceMotionEvent : undefined) as unknown as
    | { requestPermission?: () => Promise<"granted" | "denied"> }
    | undefined;
  if (!DME) throw new Error(L("This browser does not support the accelerometer", "このブラウザは加速度センサーに対応していません"));
  if (typeof DME.requestPermission === "function") {
    // Only succeeds after permission was granted from a tap (requestMotion); asking here, outside a
    // tap, is refused by the browsers that ask at all.
    let r: string;
    try {
      r = await DME.requestPermission();
    } catch (e) {
      r = `refused (${(e as Error).name})`;
    }
    if (r !== "granted") throw new Error(L("The motion sensor is not allowed. On the watch camera, press \"Allow motion sensor\"", "傾きセンサー（加速度）の利用が許可されていません。見守りカメラで「傾きセンサーを許可」を押してください"));
  }
  const xs: Vec3[] = [];
  const on = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (g && g.x !== null && g.y !== null && g.z !== null) xs.push([g.x, g.y, g.z]);
  };
  window.addEventListener("devicemotion", on);
  await new Promise((r) => setTimeout(r, ms));
  window.removeEventListener("devicemotion", on);
  if (xs.length < 5) throw new Error(L(`Only ${xs.length} accelerometer readings arrived (it may not work in this browser)`, `加速度センサーの値が ${xs.length} 回しか届きませんでした（このブラウザでは使えない可能性）`));
  const mean: Vec3 = [0, 1, 2].map((k) => xs.reduce((s, v) => s + v[k], 0) / xs.length) as Vec3;
  const g = Math.hypot(...mean);
  if (g < 8 || g > 11.6) throw new Error(L(`The acceleration ${g.toFixed(1)} m/s² does not match gravity (is the phone moving?)`, `加速度の大きさ ${g.toFixed(1)} m/s² が重力と合いません（動かしていませんか）`));
  const spread = Math.max(...xs.map((v) => angleBetweenDeg(norm(v), norm(mean))));
  if (spread > 4) throw new Error(L(`The phone moved ${spread.toFixed(1)}° while measuring. Leave it in place and do not touch it`, `測っている間にスマホが ${spread.toFixed(1)}° 動きました。置いたまま触らないでください`));
  return { a: norm(mean), samples: xs.length };
}

const norm = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};

/** Keeps a slow average of the accelerometer (for "the phone moved since the calibration"). */
export function watchGravity(onUpdate: (a: Vec3) => void): () => void {
  let avg: Vec3 | null = null;
  const on = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null || g.z === null) return;
    const v = norm([g.x, g.y, g.z]);
    avg = avg ? norm([avg[0] * 0.9 + v[0] * 0.1, avg[1] * 0.9 + v[1] * 0.1, avg[2] * 0.9 + v[2] * 0.1]) : v;
    onUpdate(avg);
  };
  window.addEventListener("devicemotion", on);
  return () => window.removeEventListener("devicemotion", on);
}

/**
 * Whether the accelerometer can be used on this page.
 *  - "ok": readings arrive.
 *  - "denied": the browser asked for permission and it was refused (iOS Safari and browsers built on
 *    it only allow asking from a tap; some privacy-focused browsers refuse or block motion sensors).
 *  - "no-data": no permission prompt, but no readings either (sensor blocked by a browser setting or
 *    missing on the device).
 *  - "unsupported": no DeviceMotionEvent at all.
 */
export type MotionState = "ok" | "denied" | "no-data" | "unsupported";

// Getters: the language is set after this module loads.
export const MOTION_STATE_LABEL: Record<MotionState, string> = {
  get ok() { return L("Available", "使えます"); },
  get denied() { return L("Not allowed", "許可されていません"); },
  get "no-data"() { return L("No readings (a browser setting may be blocking it)", "値が届きません（ブラウザの設定で止められている可能性）"); },
  get unsupported() { return L("Not available in this browser", "このブラウザでは使えません"); },
};

/**
 * Call from a tap (button handler) before any other await: browsers that ask for permission only
 * allow it during a user gesture. Then listens for 1.5 s to see whether readings really arrive.
 */
export async function requestMotion(): Promise<MotionState> {
  if (typeof window === "undefined" || !window.DeviceMotionEvent) return "unsupported";
  const DME = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> };
  if (typeof DME.requestPermission === "function") {
    let r: "granted" | "denied";
    try {
      r = await DME.requestPermission();
    } catch {
      return "denied"; // e.g. not called from a tap
    }
    if (r !== "granted") return "denied";
  }
  let got = 0;
  const on = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (g && g.x !== null && g.y !== null && g.z !== null) got++;
  };
  window.addEventListener("devicemotion", on);
  await new Promise((r) => setTimeout(r, 1500));
  window.removeEventListener("devicemotion", on);
  return got >= 3 ? "ok" : "no-data";
}
