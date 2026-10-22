/**
 * GET /report/weekly?today=YYYY-MM-DD&lang=en|ja — Claude Sonnet 4.6 reflection over the last 7 daily summaries,
 * in the parent phone's UI language (English when lang is omitted).
 * Returns requestId / latency / tokens as evidence of the real Bedrock call.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { authenticate, parseReportLang, weeklyReport } from "../lib/insight-core";
import { authHeader, insightContext, json, withErrors } from "../lib/http";

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withErrors(async () => {
    const ctx = insightContext();
    const { sessionId } = await authenticate(ctx.store, authHeader(event), ["tv", "camera", "parent"]);
    const lang = parseReportLang(event.queryStringParameters?.lang);
    return json(200, await weeklyReport(ctx, sessionId, event.queryStringParameters?.today ?? "", lang));
  });
}
