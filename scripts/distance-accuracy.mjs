/**
 * Distance accuracy (docs/proof/MEASUREMENT_EVIDENCE.md §1): raw samples → the table and headline.
 *
 * The watch phone (/camera → "Measure distance accuracy") records `distanceM` for 10 s while a person stands on a
 * floor mark whose true distance was measured with a laser meter, and saves one CSV row per frame
 * (RAW_COLUMNS). This module is pure (used by /camera and tested in tests/distance-accuracy.test.ts);
 * scripts/distance-accuracy-report.mjs prints the Markdown table for one or more raw CSV files.
 *
 * Nothing is filled in: a frame without a distance (feet not found, BELOW_FRAME) is counted as
 * "missing" and never becomes an error of 0. A condition with no distance at all has empty cells.
 */
export const RAW_COLUMNS = ["trial", "method", "true_m", "lateral", "t_ms", "distance_m", "state", "confidence"];

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Nearest-rank percentile of a non-empty list (p in 0..100). */
export function percentile(xs, p) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (p === 50 && s.length % 2 === 0) return (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

function stats(samples, trueM) {
  const ds = samples.map((s) => s.distanceM).filter((d) => d !== null);
  const errors = ds.map((d) => Math.abs(d - trueM));
  if (ds.length === 0) return { frames: samples.length, missing: samples.length, mean: null, bias: null, mae: null, std: null, medianAbsError: null };
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const std = Math.sqrt(ds.reduce((a, d) => a + (d - mean) ** 2, 0) / ds.length);
  return {
    frames: samples.length,
    missing: samples.length - ds.length,
    mean: round(mean),
    bias: round(mean - trueM),
    mae: round(errors.reduce((a, b) => a + b, 0) / errors.length),
    std: round(std),
    medianAbsError: round(percentile(errors, 50)),
  };
}

/**
 * samples: { trial, method, trueM, lateral, tMs, distanceM: number|null, state, confidence }[]
 * → one row per method × true distance × lateral position, and per-method overall numbers
 *   (median / p90 absolute error over every frame that had a distance).
 */
export function summarize(samples) {
  const groups = new Map();
  for (const s of samples) {
    const k = `${s.method}|${s.trueM}|${s.lateral}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const conditions = [...groups.values()]
    .map((g) => ({ method: g[0].method, trueM: g[0].trueM, lateral: g[0].lateral, trials: new Set(g.map((s) => s.trial)).size, ...stats(g, g[0].trueM) }))
    .sort((a, b) => a.method.localeCompare(b.method) || a.trueM - b.trueM || a.lateral.localeCompare(b.lateral));

  const methods = [...new Set(samples.map((s) => s.method))].sort();
  const overall = methods.map((method) => {
    const ms = samples.filter((s) => s.method === method);
    const errors = ms.filter((s) => s.distanceM !== null).map((s) => Math.abs(s.distanceM - s.trueM));
    return {
      method,
      frames: ms.length,
      missing: ms.length - errors.length,
      conditions: conditions.filter((c) => c.method === method).length,
      medianAbsError: errors.length ? round(percentile(errors, 50)) : null,
      p90AbsError: errors.length ? round(percentile(errors, 90)) : null,
      maxAbsError: errors.length ? round(Math.max(...errors)) : null,
    };
  });
  return { conditions, overall };
}

const cell = (v, unit = "") => (v === null || v === undefined ? "" : `${v}${unit}`);
const cm = (m) => (m === null ? "" : `${round(m * 100, 1)} cm`);

/** The MEASUREMENT_EVIDENCE §1 table plus one headline line per calibration method. */
export function toMarkdown(summary) {
  const lines = [
    "| Method | True distance | Lateral | Trials | Frames | Missing | Mean estimate | Bias | MAE | Median abs error | Std dev |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...summary.conditions.map(
      (c) =>
        `| ${c.method} | ${c.trueM.toFixed(2)}m | ${c.lateral} | ${c.trials} | ${c.frames} | ${c.missing} | ${cell(c.mean, "m")} | ${cell(c.bias, "m")} | ${cell(c.mae, "m")} | ${cell(c.medianAbsError, "m")} | ${cell(c.std, "m")} |`
    ),
    "",
    ...summary.overall.map(
      (o) =>
        `- **${o.method}**: median distance error **${cm(o.medianAbsError) || "—"}** (p90 ${cm(o.p90AbsError) || "—"}, max ${cm(o.maxAbsError) || "—"}) over ${o.frames - o.missing} frames in ${o.conditions} conditions; ${o.missing} frames without a distance.`
    ),
  ];
  return lines.join("\n");
}

export function toRawCsv(samples) {
  // Every value is a number or a fixed label (method, lateral, state), so no quoting is needed.
  const esc = (v) => (v === null || v === undefined ? "" : String(v));
  const rows = samples.map((s) => [s.trial, s.method, s.trueM, s.lateral, s.tMs, s.distanceM, s.state, s.confidence].map(esc).join(","));
  return [RAW_COLUMNS.join(","), ...rows].join("\n") + "\n";
}

/** Parses a CSV written by toRawCsv. Fails on a missing column or a bad number (no guessing). */
export function parseRawCsv(text, source = "csv") {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  for (const c of RAW_COLUMNS) if (!cols.includes(c)) throw new Error(`${source}: column "${c}" is missing`);
  const at = (cells, c) => cells[cols.indexOf(c)];
  const num = (v, c, line) => {
    const n = Number(v);
    if (v === "" || !Number.isFinite(n)) throw new Error(`${source}:${line}: ${c} must be a number (got "${v}")`);
    return n;
  };
  return rows.map((r, i) => {
    const cells = r.split(",");
    const line = i + 2;
    const d = at(cells, "distance_m");
    return {
      trial: num(at(cells, "trial"), "trial", line),
      method: at(cells, "method"),
      trueM: num(at(cells, "true_m"), "true_m", line),
      lateral: at(cells, "lateral"),
      tMs: num(at(cells, "t_ms"), "t_ms", line),
      distanceM: d === "" ? null : num(d, "distance_m", line),
      state: at(cells, "state"),
      confidence: num(at(cells, "confidence"), "confidence", line),
    };
  });
}
