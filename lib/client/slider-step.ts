/** Slider values for components/touch-slider.tsx (kept apart from the component so it can be unit-tested). */

/** The value on the step grid from `min`, inside [min, max], without floating-point tails (0.1 + 0.2). */
export function snapToStep(v: number, min: number, max: number, step: number): number {
  const decimals = Math.max((String(step).split(".")[1] ?? "").length, (String(min).split(".")[1] ?? "").length);
  const n = Math.round((Math.min(max, Math.max(min, v)) - min) / step);
  return Math.min(max, Math.max(min, Number((min + n * step).toFixed(decimals))));
}
