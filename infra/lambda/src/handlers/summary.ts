/**
 * POST /session/summary  (TV)          — upsert the day's cumulative summary
 * POST /session/summary/reset (TV)     — delete every daily record of the session (asked by a parent phone via the relay;
 *                                        the TV clears its own running counters first, so nothing comes back)
 * GET  /session/summary?today=YYYY-MM-DD (TV, camera or parent phone) — last 7 days
 * GET  /session/summary?from=YYYY-MM-DD&to=YYYY-MM-DD — any range of up to 31 days
 * POST /session/reminder (camera or parent phone, /parent) — the parent's "I said 'step back'" ±1
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { addReminder, authenticate, listRange, listWeek, putSummary } from "../lib/insight-core";
import { authHeader, insightContext, json, parseBody, withErrors } from "../lib/http";

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withErrors(async () => {
    const ctx = insightContext();
    if (event.requestContext.http.method === "POST" && event.rawPath === "/session/reminder") {
      const { sessionId } = await authenticate(ctx.store, authHeader(event), ["camera", "parent"]);
      const r = await addReminder(ctx, sessionId, parseBody(event));
      console.log(JSON.stringify({ evt: "reminder_add", sessionId, date: r.date }));
      return json(200, r);
    }
    if (event.requestContext.http.method === "POST" && event.rawPath === "/session/summary/reset") {
      const { sessionId } = await authenticate(ctx.store, authHeader(event), ["tv"]);
      const deleted = await ctx.store.deleteSummaries(sessionId);
      console.log(JSON.stringify({ evt: "summary_reset", sessionId, deleted }));
      return json(200, { deleted });
    }
    if (event.requestContext.http.method === "POST") {
      const { sessionId } = await authenticate(ctx.store, authHeader(event), ["tv"]);
      const saved = await putSummary(ctx, sessionId, parseBody(event));
      console.log(JSON.stringify({ evt: "summary_put", sessionId, date: saved.date }));
      return json(200, { saved });
    }
    const { sessionId } = await authenticate(ctx.store, authHeader(event), ["tv", "camera", "parent"]);
    const q = event.queryStringParameters ?? {};
    if (q.from !== undefined || q.to !== undefined) return json(200, { days: await listRange(ctx, sessionId, q.from, q.to) });
    return json(200, { days: await listWeek(ctx, sessionId, q.today ?? "") });
  });
}
