import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { BedrockOutputError, invokeClaude, parseModelJson } from "./bedrock";
import { HttpError, type InsightCtx } from "./insight-core";
import { DynamoStore } from "./store";

let store: DynamoStore | null = null;

function dailyLimit(): number {
  const raw = process.env.REPORT_DAILY_LIMIT;
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) throw new Error(`REPORT_DAILY_LIMIT must be a positive integer (got ${String(raw)})`);
  return n;
}

export function insightContext(): InsightCtx {
  store ??= new DynamoStore();
  return { store, now: () => Date.now(), invoke: invokeClaude, parse: parseModelJson, bedrockDailyLimit: dailyLimit() };
}

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) throw new HttpError(400, "request body is required");
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

export function authHeader(event: APIGatewayProxyEventV2): string | undefined {
  return event.headers?.authorization ?? event.headers?.Authorization;
}

/** Fail-fast error surface: raw message, status, and Bedrock trace/raw output when available. */
export async function withErrors(fn: () => Promise<APIGatewayProxyResultV2>): Promise<APIGatewayProxyResultV2> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) {
      return json(err.status, { error: err.message, ...(err.code ? { code: err.code, message: err.message } : {}), details: err.details });
    }
    if (err instanceof BedrockOutputError) {
      console.error(JSON.stringify({ evt: "bedrock_output_error", message: err.message, trace: err.trace }));
      return json(502, { error: err.message, trace: err.trace, rawText: err.rawText });
    }
    const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
    console.error(JSON.stringify({ evt: "unhandled_error", name: e.name, message: e.message, meta: e.$metadata }));
    return json(500, { error: e.message, name: e.name, awsStatus: e.$metadata?.httpStatusCode, awsRequestId: e.$metadata?.requestId });
  }
}
