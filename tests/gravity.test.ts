import { describe, expect, test } from "vitest";
import { upInCamera } from "../lib/client/gravity";

describe("gravity → camera up", () => {
  const close = (v: number[], w: number[]) => v.forEach((x, i) => expect(x).toBeCloseTo(w[i], 6));
  test("portrait, upright, rear camera: up is −y in the frame", () => {
    close(upInCamera([0, 1, 0], 0, "environment"), [0, -1, 0]);
  });
  test("portrait, leaning back (screen up a bit): the rear camera looks up, so up tilts toward −z", () => {
    const a = [0, Math.cos(0.3), Math.sin(0.3)] as [number, number, number]; // screen faces up-ish
    const u = upInCamera(a, 0, "environment");
    expect(u[1]).toBeLessThan(0);
    expect(u[2]).toBeLessThan(0);
  });
  test("landscape: at 90° (top of the phone to the left) its right edge (+x) is up in the frame", () => {
    close(upInCamera([1, 0, 0], 90, "environment"), [0, -1, 0]);
    close(upInCamera([-1, 0, 0], 270, "environment"), [0, -1, 0]);
  });
  test("front camera: frame x is mirrored relative to the rear camera, z flips", () => {
    close(upInCamera([0.2, 0.9, 0.3], 0, "user"), [-0.2, -0.9, 0.3].map((x) => x / Math.hypot(0.2, 0.9, 0.3)));
  });
});
