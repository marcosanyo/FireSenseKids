#!/usr/bin/env node
/**
 * Prints the MEASUREMENT_EVIDENCE §1 table (and the median-error headline) from raw CSV files saved
 * by /camera → "Measure distance accuracy".
 *
 *   node scripts/distance-accuracy-report.mjs docs/proof/data/distance-*.csv
 */
import { readFileSync } from "node:fs";
import { parseRawCsv, summarize, toMarkdown } from "./distance-accuracy.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/distance-accuracy-report.mjs <raw.csv> [more.csv ...]");
  process.exit(1);
}
const samples = files.flatMap((f) => parseRawCsv(readFileSync(f, "utf8"), f));
console.log(toMarkdown(summarize(samples)));
