/**
 * Synthetic pinhole camera looking at a flat floor.
 * World: X lateral (m, + = right when facing the room from the TV), Y up, Z = perpendicular
 * distance from the TV screen plane into the room.
 */
export interface Cam {
  x: number; // lateral position of the lens
  z: number; // lens distance in front of the TV plane
  h: number; // lens height
  yawDeg: number; // + = turned toward −X (e.g. phone on the right side of the TV looking left-in)
  pitchDownDeg: number;
  vfovDeg: number;
  aspect: number; // width / height
}

export function project(cam: Cam, X: number, Z: number): { x: number; y: number } | null {
  return project3(cam, X, 0, Z);
}

/** Any world point (Y = height above the floor). Null when behind the camera or outside the frame. */
export function project3(cam: Cam, X: number, Y: number, Z: number): { x: number; y: number } | null {
  const yaw = (cam.yawDeg * Math.PI) / 180;
  const pitch = (cam.pitchDownDeg * Math.PI) / 180;
  const f = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const r = [Math.cos(yaw), 0, Math.sin(yaw)];
  let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  if (u[1] < 0) u = u.map((c) => -c);
  const v = [X - cam.x, Y - cam.h, Z - cam.z];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const zc = dot(v, f);
  if (zc <= 0) return null;
  const tv = Math.tan(((cam.vfovDeg / 2) * Math.PI) / 180);
  const th = tv * cam.aspect;
  const x = 0.5 + dot(v, r) / (zc * 2 * th);
  const y = 0.5 - dot(v, u) / (zc * 2 * tv);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/** Phone on the right side of the TV (1 m off-center), turned 35° toward the room, tilted 20° down. */
export const SIDE_CAM: Cam = { x: 1.0, z: 0.1, h: 0.55, yawDeg: 35, pitchDownDeg: 20, vfovDeg: 55, aspect: 4 / 3 };
export const FRONT_CAM: Cam = { x: 0, z: 0, h: 0.55, yawDeg: 0, pitchDownDeg: 20, vfovDeg: 55, aspect: 4 / 3 };

/** A world vector (X, Y up, Z) in camera coordinates (x right, y down, z forward), like MediaPipe world landmarks. */
export function toCameraAxes(cam: Cam, v: [number, number, number]): { x: number; y: number; z: number } {
  const yaw = (cam.yawDeg * Math.PI) / 180;
  const pitch = (cam.pitchDownDeg * Math.PI) / 180;
  const f = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const r = [Math.cos(yaw), 0, Math.sin(yaw)];
  let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  if (u[1] < 0) u = u.map((c) => -c);
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { x: dot(v, r), y: -dot(v, u), z: dot(v, f) };
}
