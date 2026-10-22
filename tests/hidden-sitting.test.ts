/**
 * Hidden feet and sitting, with real pose-model keypoints and the app's own pipeline.
 *
 * Needs scripts/pose-bench/images/nb2/keypoints.json (gen_nb.py --paired, then eval_hidden.py); skipped without
 * it, never mocked. The scenes are generated images: the same person stands, stands with the legs hidden,
 * sits on the floor / behind a table, or sits on a chair, with the same room and camera.
 *
 * Each case replays the model's keypoints as the watch camera would see them: the standing frame for half a
 * second (the pipeline learns the hip height while the feet are visible), then, 1.5 s later, the other frame.
 * The real camera is unknown (generated images), so the TV-marker calibration is a synthetic camera, and the
 * result is reported over many plausible cameras (height 1.0–1.6 m, pitch 15–35°, field of view 60–72°, three
 * positions) rather than for one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { modelFromTvScreen, screenSizeFromInches, SensorPipeline, type LandmarkPoint, type Pt2 } from "../lib/firesense";
import { cocoToLandmarks } from "../lib/firesense/rtmo";
import { HIP_MEMORY_TORSO_TOLERANCE, learnHip, torsoRatio } from "../lib/firesense/hip-ground";
import { project3, type Cam } from "./helpers/camera";

const DIR = join(__dirname, "..", "scripts/pose-bench/images/nb2");
const have = existsSync(join(DIR, "keypoints.json")) && existsSync(join(DIR, "truth.json"));

type KP = Record<string, Record<string, { xy: number[][]; s: number[] }>>;
type Truth = Record<string, { room: string; variant: string; feet_visible: boolean; posture: string }>;
const NO_DEBOUNCE = {
  smoothing: { windowMs: 0 },
  stateMachine: { enterDwellMs: 0, exitDwellMs: 0, tooCloseExitHysteresisMeters: 0.05, safeHysteresisMeters: 0 },
};
const TV = screenSizeFromInches(43);

function tvModel(cam: Cam) {
  const W = TV.widthM;
  const H = TV.heightM;
  const c = [project3(cam, W / 2, 0.5 + H, 0), project3(cam, -W / 2, 0.5 + H, 0), project3(cam, -W / 2, 0.5, 0), project3(cam, W / 2, 0.5, 0)];
  if (c.some((p) => !p)) return null;
  try {
    return modelFromTvScreen(c as [Pt2, Pt2, Pt2, Pt2], TV, cam.aspect, cam.h).model;
  } catch {
    return null;
  }
}

function cameras(): Cam[] {
  const out: Cam[] = [];
  for (const [x, z, yawDeg] of [
    [1.9, 2.2, 135],
    [-1.9, 2.2, 225],
    [0, 3.0, 180],
  ])
    for (const h of [1.0, 1.3, 1.6])
      for (const pitchDownDeg of [15, 25, 35])
        for (const vfovDeg of [60, 72]) out.push({ x, z, h, yawDeg, pitchDownDeg, vfovDeg, aspect: 4 / 3 });
  return out;
}

const lms = (k: KP[string][string]): LandmarkPoint[] => cocoToLandmarks(k.xy.map(([x, y], i) => ({ x, y, score: k.s[i] })));

describe.skipIf(!have)("hidden feet and sitting: stored keypoints through the pipeline", () => {
  const kp: KP = have ? JSON.parse(readFileSync(join(DIR, "keypoints.json"), "utf8")) : {};
  const truth: Truth = have ? JSON.parse(readFileSync(join(DIR, "truth.json"), "utf8")).scenes : {};
  const rooms = [...new Set(Object.values(truth).map((t) => t.room))];
  const models = ["rtmo_s", "rtmo_m", "rtmo_l"];
  const variants = ["stand_hidden", "sit_floor", "sit_floor_hidden", "sit_chair"];
  // The adult's "sits behind a table" scene still shows the legs beside the table: not a hidden-feet case.
  const EXCLUDED = new Set(["adultC__sit_floor_hidden"]);
  const cams = cameras().flatMap((c) => {
    const m = tvModel(c);
    return m ? [{ cam: c, model: m }] : [];
  });

  type Outcome = { status: string; source: string | null; distanceM: number | null; standM: number | null; posture: string; state: string };
  function replay(model: ReturnType<typeof tvModel>, stand: LandmarkPoint[], target: LandmarkPoint[]): Outcome {
    const p = new SensorPipeline(NO_DEBOUNCE);
    p.setCalibration(model!);
    p.setThresholds(0.6, 1.05);
    let standOut = p.process([stand], 0);
    for (let t = 125; t <= 500; t += 125) standOut = p.process([stand], t);
    const out = p.process([target], 2000);
    return { status: out.foot.status, source: out.distanceSource, distanceM: out.distanceM, standM: standOut.distanceM, posture: out.posture, state: out.state };
  }

  test("the synthetic cameras cover enough setups", () => {
    expect(cams.length).toBeGreaterThanOrEqual(20);
  });

  const table: Record<string, Record<string, Record<string, number>>> = {};
  test("replay every scene over every camera and report", () => {
    for (const room of rooms) {
      for (const variant of variants) {
        const name = `${room}__${variant}`;
        if (EXCLUDED.has(name)) continue;
        for (const model of models) {
          const s = kp[`${room}__stand`]?.[model];
          const t = kp[name]?.[model];
          const cell = ((table[`${variant}`] ??= {})[model] ??= {});
          if (!s || !t) {
            cell["person not found"] = (cell["person not found"] ?? 0) + cams.length;
            continue;
          }
          for (const { model: m } of cams) {
            const o = replay(m, lms(s), lms(t));
            const label = o.source === "hips" ? "hips estimate used" : o.status === "VISIBLE" ? "feet seen" : o.distanceM === null ? "no distance" : `held (${o.status})`;
            cell[label] = (cell[label] ?? 0) + 1;
          }
        }
      }
    }
    const lines = ["variant            model   " + "outcome (share of camera setups, all rooms)"];
    for (const v of variants)
      for (const m of models) {
        const cell = table[v]?.[m] ?? {};
        const n = Object.values(cell).reduce((a, b) => a + b, 0);
        lines.push(`${v.padEnd(18)} ${m.padEnd(7)} ` + Object.entries(cell).map(([k, c]) => `${k} ${Math.round((100 * c) / n)}%`).join(", "));
      }
    console.log(lines.join("\n"));
    expect(Object.keys(table).length).toBe(variants.length);
  }, 120_000);

  test("hidden-feet estimate on the standing child: how far from the feet-based distance", () => {
    const errs: Record<string, number[]> = {};
    for (const room of rooms) {
      for (const model of models) {
        const s = kp[`${room}__stand`]?.[model];
        const t = kp[`${room}__stand_hidden`]?.[model];
        if (!s || !t) continue;
        for (const { model: m } of cams) {
          const o = replay(m, lms(s), lms(t));
          if (o.source === "hips" && o.distanceM !== null && o.standM !== null) (errs[model] ??= []).push(Math.abs(o.distanceM - o.standM));
        }
      }
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log("|distance(hip estimate, legs hidden) − distance(feet, standing)|, median / max over cameras and rooms:\n" +
      Object.entries(errs).map(([m, a]) => `  ${m}: ${med(a).toFixed(2)} m / ${Math.max(...a).toFixed(2)} m (n=${a.length})`).join("\n"));
  }, 120_000);

  test("without 3D points the posture is unknown, never a guess (RTMO used to read every child as lying down)", () => {
    for (const [name, t] of Object.entries(truth)) {
      const k = kp[name]?.rtmo_s;
      if (!k || EXCLUDED.has(name)) continue;
      for (const { model: m } of cams.slice(0, 6)) {
        const p = new SensorPipeline(NO_DEBOUNCE);
        p.setCalibration(m);
        p.process([lms(k)], 0);
        const o = p.process([lms(k)], 125);
        expect(o.posture, `${name} (${t.posture})`).toBe("UNKNOWN");
      }
    }
  });

  test("sitting down: the torso-length check (learned while standing) separates standing from sitting", () => {
    // Share of camera setups in which the check ACCEPTS the hip estimate (|ratio − 1| ≤ tolerance).
    // Feet visibility does not matter here: it is the rule's own discrimination that is measured.
    const accept: Record<string, Record<string, { yes: number; n: number; ratios: number[] }>> = {};
    for (const room of rooms) {
      for (const model of models) {
        const s = kp[`${room}__stand`]?.[model];
        if (!s) continue;
        for (const { model: m } of cams) {
          const pose = (m as { tvPose?: never }).tvPose as Parameters<typeof learnHip>[0] | undefined;
          if (!pose) continue;
          const learned = learnHip(pose, lms(s));
          if (!learned) continue;
          for (const variant of ["stand_hidden", "sit_floor", "sit_floor_hidden", "sit_chair"]) {
            const name = `${room}__${variant}`;
            const t = kp[name]?.[model];
            if (!t || EXCLUDED.has(name)) continue;
            const ratio = torsoRatio(pose, lms(t), learned.hipHeightM, learned.torsoM);
            if (ratio === null) continue;
            const cell = ((accept[variant] ??= {})[model] ??= { yes: 0, n: 0, ratios: [] });
            cell.n++;
            cell.ratios.push(ratio);
            if (Math.abs(ratio - 1) <= HIP_MEMORY_TORSO_TOLERANCE) cell.yes++;
          }
        }
      }
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    // Per room: torso ratio median [min–max] over cameras, to see which rooms and which tolerance fail.
    const perRoom: string[] = ["per room (rtmo_m): torso ratio median [min–max] over cameras"];
    for (const room of rooms) {
      const cells: string[] = [];
      for (const v of ["stand_hidden", "sit_floor", "sit_floor_hidden", "sit_chair"]) {
        const s = kp[`${room}__stand`]?.rtmo_m;
        const t = kp[`${room}__${v}`]?.rtmo_m;
        if (!s || !t || EXCLUDED.has(`${room}__${v}`)) continue;
        const rs: number[] = [];
        for (const { model: m } of cams) {
          const pose = (m as { tvPose?: never }).tvPose as Parameters<typeof learnHip>[0] | undefined;
          const learned = pose ? learnHip(pose, lms(s)) : null;
          const r = pose && learned ? torsoRatio(pose, lms(t), learned.hipHeightM, learned.torsoM) : null;
          if (r !== null) rs.push(r);
        }
        if (rs.length) cells.push(`${v} ${med(rs).toFixed(2)} [${Math.min(...rs).toFixed(2)}–${Math.max(...rs).toFixed(2)}]`);
      }
      perRoom.push(`  ${room}: ` + cells.join("; "));
    }
    console.log(perRoom.join("\n"));
    const lines = [`variant (expected)          model   accepted as "still standing"   median torso ratio (1 = as learned; tolerance ±${HIP_MEMORY_TORSO_TOLERANCE})`];
    for (const v of ["stand_hidden", "sit_floor", "sit_floor_hidden", "sit_chair"])
      for (const m of models) {
        const c = accept[v]?.[m];
        if (c) lines.push(`${(v + (v === "stand_hidden" ? " (accept)" : " (reject)")).padEnd(27)} ${m.padEnd(7)} ${String(Math.round((100 * c.yes) / c.n)).padStart(3)}% of ${String(c.n).padStart(3)} setups      ${med(c.ratios).toFixed(2)}`);
      }
    console.log(lines.join("\n"));
    expect(Object.keys(accept).length).toBeGreaterThan(0);
  }, 120_000);

  test("a seated person judged 'still standing': how wrong is the hip distance? (feet erased from a frame whose feet are visible)", () => {
    const erase = (l: LandmarkPoint[]) => l.map((p, i) => (i >= 25 && i <= 32 ? { ...p, visibility: 0 } : p)); // knees, ankles, heels, toes
    const res: Record<string, Record<string, { n: number; accepted: number; err: number[] }>> = {};
    for (const room of rooms) {
      for (const model of models) {
        const s = kp[`${room}__stand`]?.[model];
        if (!s) continue;
        for (const variant of ["sit_floor", "sit_chair"]) {
          const t = kp[`${room}__${variant}`]?.[model];
          if (!t) continue;
          for (const { model: m } of cams) {
            const withFeet = replay(m, lms(s), lms(t));
            if (withFeet.status !== "VISIBLE" || withFeet.distanceM === null) continue;
            const c = ((res[variant] ??= {})[model] ??= { n: 0, accepted: 0, err: [] });
            c.n++;
            const hidden = replay(m, lms(s), erase(lms(t)));
            if (hidden.source === "hips" && hidden.distanceM !== null) {
              c.accepted++;
              c.err.push(Math.abs(hidden.distanceM - withFeet.distanceM));
            }
          }
        }
      }
    }
    const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
    const lines = ["sitting, feet erased: hip estimate accepted (wrongly as 'standing') and its error against the feet-based distance"];
    for (const v of ["sit_floor", "sit_chair"])
      for (const m of models) {
        const c = res[v]?.[m];
        if (c) lines.push(`  ${v.padEnd(10)} ${m.padEnd(7)} accepted ${c.accepted}/${c.n}` + (c.err.length ? `, error median ${q(c.err, 0.5).toFixed(2)} m, 90th pct ${q(c.err, 0.9).toFixed(2)} m, max ${Math.max(...c.err).toFixed(2)} m` : ""));
      }
    console.log(lines.join("\n"));
  }, 120_000);
});

