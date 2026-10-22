import { describe, expect, test } from "vitest";
import { parseRawCsv, percentile, summarize, toMarkdown, toRawCsv } from "../scripts/distance-accuracy.mjs";

const s = (trial: number, trueM: number, lateral: string, distanceM: number | null, method = "tv_marker") => ({
  trial,
  method,
  trueM,
  lateral,
  tMs: 0,
  distanceM,
  state: distanceM === null ? "BELOW_FRAME" : "SAFE",
  confidence: 0.9,
});

describe("distance accuracy (MEASUREMENT_EVIDENCE §1)", () => {
  const samples = [
    s(1, 1.0, "center", 1.02),
    s(1, 1.0, "center", 0.98),
    s(1, 1.0, "center", 1.06),
    s(1, 1.0, "center", null),
    s(2, 1.6, "+0.5m", 1.5),
    s(2, 1.6, "+0.5m", 1.7),
    s(3, 0.8, "center", null),
    s(4, 1.0, "center", 1.1, "lines"),
  ];
  const sum = summarize(samples);

  test("per condition: mean, bias, MAE, std; frames without a distance are missing, not error 0", () => {
    const c = sum.conditions.find((c: any) => c.method === "tv_marker" && c.trueM === 1.0)!;
    expect(c).toMatchObject({ trials: 1, frames: 4, missing: 1, mean: 1.02, bias: 0.02, mae: 0.033, medianAbsError: 0.02 });
    const empty = sum.conditions.find((c: any) => c.trueM === 0.8)!;
    expect(empty).toMatchObject({ frames: 1, missing: 1, mean: null, mae: null, medianAbsError: null });
  });

  test("overall headline per calibration method, over every frame with a distance", () => {
    const tv = sum.overall.find((o: any) => o.method === "tv_marker")!;
    // |errors| = 0.02, 0.02, 0.06, 0.1, 0.1 → median 0.06, p90 0.1
    expect(tv).toMatchObject({ frames: 7, missing: 2, conditions: 3, medianAbsError: 0.06, p90AbsError: 0.1, maxAbsError: 0.1 });
    expect(toMarkdown(sum)).toContain("- **tv_marker**: median distance error **6 cm** (p90 10 cm, max 10 cm) over 5 frames in 3 conditions; 2 frames without a distance.");
  });

  test("CSV round trip keeps missing distances as missing", () => {
    expect(parseRawCsv(toRawCsv(samples))).toEqual(samples);
  });

  test("a malformed CSV fails loudly", () => {
    expect(() => parseRawCsv("trial,method\n1,x", "f.csv")).toThrow('f.csv: column "true_m" is missing');
    const bad = toRawCsv([s(1, 1.0, "center", 1.0)]).replace(",1,center,", ",abc,center,");
    expect(() => parseRawCsv(bad, "f.csv")).toThrow('f.csv:2: true_m must be a number (got "abc")');
  });

  test("percentile", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });
});
