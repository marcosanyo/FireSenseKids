#!/usr/bin/env node
/**
 * Field pilot (T2): export daily summaries to CSV (per household × mode × day, and per household × mode).
 *
 *   node scripts/export-pilot.mjs --household A=s_xxxx --household B=s_yyyy \
 *     --from 2026-10-05 --to 2026-10-12 [--table <daily summaries table>] [--out docs/proof/pilot]
 *
 * Reads DynamoDB directly with the AWS credentials in the environment (e.g. `set -a; . ./.env`).
 * The table name comes from --table or SUMMARIES_TABLE (`terraform -chdir=infra/terraform output
 * -raw daily_summaries_table`). Records expire after 30 days (TTL), so export within that window.
 * Writes <out>/pilot-days.csv and <out>/pilot-summary.csv. Missing values are empty cells, never 0.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DAY_COLUMNS, dayRows, SUMMARY_COLUMNS, summaryRows, toCsv } from "./pilot-metrics.mjs";

function fail(msg) {
  console.error(`export-pilot: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { households: [], out: "docs/proof/pilot" };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--household") {
      const m = /^([^=]+)=(.+)$/.exec(v ?? "");
      if (!m) fail(`--household expects LABEL=SESSION_ID (got ${v})`);
      args.households.push({ label: m[1], sessionId: m[2] });
    } else if (k === "--from") args.from = v;
    else if (k === "--to") args.to = v;
    else if (k === "--table") args.table = v;
    else if (k === "--out") args.out = v;
    else fail(`unknown argument ${k}`);
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
if (args.households.length === 0) fail("at least one --household LABEL=SESSION_ID is required");
if (!isDate(args.from) || !isDate(args.to)) fail("--from and --to must be YYYY-MM-DD");
const table = args.table ?? process.env.SUMMARIES_TABLE;
if (!table) fail("set --table or SUMMARIES_TABLE (terraform -chdir=infra/terraform output -raw daily_summaries_table)");
if (!process.env.AWS_REGION) fail("AWS_REGION is not set (this project uses us-east-1)");

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const rows = [];
for (const { label, sessionId } of args.households) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "sessionId = :s AND #d BETWEEN :from AND :to",
        ExpressionAttributeNames: { "#d": "date" },
        ExpressionAttributeValues: { ":s": sessionId, ":from": args.from, ":to": args.to },
        ExclusiveStartKey,
      })
    );
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  if (items.length === 0) console.warn(`export-pilot: no records for ${label} (${sessionId}) in ${args.from}..${args.to}`);
  rows.push(...dayRows(label, sessionId, items));
}

mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, "pilot-days.csv"), toCsv(rows, DAY_COLUMNS));
writeFileSync(join(args.out, "pilot-summary.csv"), toCsv(summaryRows(rows), SUMMARY_COLUMNS));
console.log(`wrote ${join(args.out, "pilot-days.csv")} (${rows.length} rows) and ${join(args.out, "pilot-summary.csv")}`);
