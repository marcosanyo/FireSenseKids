import { describe, expect, test } from "vitest";
import { snapToStep } from "../lib/client/slider-step";

describe("snapToStep", () => {
  test("rounds to the nearest step from min, without floating-point tails", () => {
    expect(snapToStep(1.337, 0.6, 2.5, 0.05)).toBe(1.35);
    expect(snapToStep(0.3 * 3, 0, 1, 0.1)).toBe(0.9);
    expect(snapToStep(-0.123, -0.5, 0.5, 0.05)).toBe(-0.1);
    expect(snapToStep(17, 10, 60, 5)).toBe(15);
  });
  test("clamps to the range", () => {
    expect(snapToStep(9, 0.5, 1, 0.01)).toBe(1);
    expect(snapToStep(-9, 0.5, 1, 0.01)).toBe(0.5);
    expect(snapToStep(-40, -15, 15, 1)).toBe(-15);
  });
});
