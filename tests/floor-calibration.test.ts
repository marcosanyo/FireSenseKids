import { describe, test, expect } from "vitest";
import {
  fitFloorCalibration,
  estimateDistanceFromFloorModel,
  extractGroundContactPoint,
  filterGroundSamplesIQR,
  computeMedian,
  FloorSample,
  DEFAULT_MARKER_A_METERS,
  DEFAULT_MARKER_B_METERS,
} from "../lib/firesense/floor-calibration";

describe("FireSense Kids — 2-Point Floor Position Calibration", () => {
  test("computeMedian calculates correct median for odd and even length arrays", () => {
    expect(computeMedian([1, 2, 3])).toBe(2);
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
    expect(computeMedian([5, 1, 9, 3, 7])).toBe(5);
    expect(computeMedian([])).toBe(0);
  });

  test("filterGroundSamplesIQR removes statistical outliers", () => {
    const samples: FloorSample[] = [
      { groundY: 0.80, confidence: 0.9, timestamp: 1 },
      { groundY: 0.81, confidence: 0.9, timestamp: 2 },
      { groundY: 0.80, confidence: 0.9, timestamp: 3 },
      { groundY: 0.82, confidence: 0.9, timestamp: 4 },
      { groundY: 0.79, confidence: 0.9, timestamp: 5 },
      { groundY: 0.10, confidence: 0.9, timestamp: 6 }, // extreme outlier
      { groundY: 0.99, confidence: 0.9, timestamp: 7 }, // extreme outlier
    ];

    const filtered = filterGroundSamplesIQR(samples);
    const ys = filtered.map((s) => s.groundY);
    expect(ys).not.toContain(0.10);
    expect(ys).not.toContain(0.99);
    expect(filtered.length).toBe(5);
  });

  test("fitFloorCalibration successfully fits 1/d = a*y + b with 1.2m and 1.8m markers", () => {
    // Simulated ground contact y coordinates:
    // Near marker A (1.2m): foot is lower in frame -> yA = 0.85
    // Far marker B (1.8m): foot is higher in frame -> yB = 0.55
    const samplesA: FloorSample[] = Array.from({ length: 20 }, (_, i) => ({
      groundY: 0.85 + (i % 3 - 1) * 0.005,
      confidence: 0.90,
      timestamp: Date.now() + i * 100,
    }));

    const samplesB: FloorSample[] = Array.from({ length: 20 }, (_, i) => ({
      groundY: 0.55 + (i % 3 - 1) * 0.005,
      confidence: 0.90,
      timestamp: Date.now() + i * 100,
    }));

    const result = fitFloorCalibration(samplesA, samplesB, 1.2, 1.8);
    expect(result.success).toBe(true);
    expect(result.model).toBeDefined();

    const model = result.model!;
    expect(model.markerADistance).toBe(1.2);
    expect(model.markerBDistance).toBe(1.8);
    expect(model.a).toBeGreaterThan(0);

    // Test estimated distance at calibrated points
    const distAtA = estimateDistanceFromFloorModel(0.85, model);
    expect(Math.abs(distAtA - 1.2)).toBeLessThanOrEqual(0.02);

    const distAtB = estimateDistanceFromFloorModel(0.55, model);
    expect(Math.abs(distAtB - 1.8)).toBeLessThanOrEqual(0.02);

    // Test interpolation at intermediate point (e.g. y = 0.70 should be between 1.2m and 1.8m)
    const distAtMid = estimateDistanceFromFloorModel(0.70, model);
    expect(distAtMid).toBeGreaterThan(1.2);
    expect(distAtMid).toBeLessThan(1.8);
  });

  test("fitFloorCalibration fails safely when sample count is insufficient (< 15)", () => {
    const insufficientA: FloorSample[] = Array.from({ length: 8 }, (_, i) => ({
      groundY: 0.85,
      confidence: 0.90,
      timestamp: Date.now() + i,
    }));
    const samplesB: FloorSample[] = Array.from({ length: 20 }, (_, i) => ({
      groundY: 0.55,
      confidence: 0.90,
      timestamp: Date.now() + i,
    }));

    const result = fitFloorCalibration(insufficientA, samplesB, 1.2, 1.8);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("Marker A needs at least 15 valid samples");
  });

  test("fitFloorCalibration detects geometric inversion and refuses calibration", () => {
    // Inverted geometry: user stood on marker B during step A (yA < yB)
    const invertedA: FloorSample[] = Array.from({ length: 20 }, (_, i) => ({
      groundY: 0.40, // higher up in image, but claim to be at 1.2m
      confidence: 0.90,
      timestamp: Date.now() + i,
    }));
    const samplesB: FloorSample[] = Array.from({ length: 20 }, (_, i) => ({
      groundY: 0.85, // lower down in image, claim to be at 1.8m
      confidence: 0.90,
      timestamp: Date.now() + i,
    }));

    const result = fitFloorCalibration(invertedA, samplesB, 1.2, 1.8);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("Geometric inversion detected");
  });

  test("extractGroundContactPoint extracts lowest foot landmark coordinate", () => {
    const dummyLandmarks = Array.from({ length: 33 }, () => ({
      x: 0.5,
      y: 0.5,
      visibility: 0.9,
    }));

    // Set feet keypoints (27: left_ankle, 28: right_ankle, 31: left_foot_index, 32: right_foot_index)
    dummyLandmarks[27] = { x: 0.48, y: 0.88, visibility: 0.95 };
    dummyLandmarks[28] = { x: 0.52, y: 0.89, visibility: 0.95 };
    dummyLandmarks[31] = { x: 0.47, y: 0.91, visibility: 0.95 };
    dummyLandmarks[32] = { x: 0.53, y: 0.92, visibility: 0.95 }; // lowest point

    const ground = extractGroundContactPoint(dummyLandmarks);
    expect(ground).not.toBeNull();
    expect(ground!.groundY).toBe(0.92);
    expect(ground!.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

import {
  computeEdgeDistance as edgeOf,
  estimateDistanceFromFloorModel as estimate,
  floorYForDistance,
  geometricEdgeDistance,
  modelFromCameraGeometry,
} from "../lib/firesense/floor-calibration";

describe("manual calibration from camera geometry", () => {
  const g = { heightM: 0.55, pitchDownDeg: 20, vfovDeg: 55 };

  test("fitted model reproduces geometric distances within 7cm over the 0.8–2.2m decision range", () => {
    const { model, maxErrorM } = modelFromCameraGeometry(g);
    expect(model.method).toBe("geometry");
    expect(maxErrorM).toBeLessThan(0.07);
    for (const d of [1.0, 1.3, 1.65, 2.2]) {
      expect(Math.abs(estimate(floorYForDistance(d, g), model) - d)).toBeLessThan(0.06);
    }
  });

  test("2-point calibration on a tilted camera stays within 4cm over 0.8–2.2m (model linearity check)", () => {
    const mk = (d: number) => Array.from({ length: 20 }, () => ({ groundY: floorYForDistance(d, g), confidence: 0.9, timestamp: 0 }));
    const fit = fitFloorCalibration(mk(1.2), mk(1.8));
    for (let d = 0.8; d <= 2.2; d += 0.1) {
      const y = floorYForDistance(d, g);
      if (y <= 1) expect(Math.abs(estimate(y, fit.model!) - d)).toBeLessThan(0.04);
    }
  });

  test("d_edge from the fitted model agrees with pure geometry", () => {
    const { model } = modelFromCameraGeometry(g);
    expect(Math.abs(edgeOf(model) - geometricEdgeDistance(g))).toBeLessThan(0.08);
  });

  test("tilting down brings d_edge closer (setup guide direction is right)", () => {
    expect(geometricEdgeDistance({ ...g, pitchDownDeg: 30 })).toBeLessThan(geometricEdgeDistance(g));
  });

  test("a camera that cannot see the floor fails fast", () => {
    expect(() => modelFromCameraGeometry({ heightM: 0.55, pitchDownDeg: -40, vfovDeg: 40 })).toThrow(/not in view|floor/);
  });
});
