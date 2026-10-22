/**
 * Live integration: Claude Sonnet 4.6 on Amazon Bedrock through the Lambda report code path.
 * Runs only when AWS credentials are present; otherwise skipped (never mocked).
 */
import { describe, expect, it } from "vitest";
import { invokeClaude, parseModelJson } from "../infra/lambda/src/lib/bedrock";
import { hashSecret } from "../infra/lambda/src/lib/crypto";
import { putSummary, weeklyReport } from "../infra/lambda/src/lib/insight-core";
import { MemoryStore } from "../infra/lambda/src/lib/store";
import { emptyModeStats } from "../lib/firesense";

const hasAwsCreds = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

describe.skipIf(!hasAwsCreds)("Bedrock live — weekly report via us.anthropic.claude-sonnet-4-6", () => {
  it("returns a schema-valid report with requestId, latency, and token usage", async () => {
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-6";
    process.env.BEDROCK_REGION = "us-east-1";
    const store = new MemoryStore();
    store.sessions.set("s_live", { sessionId: "s_live", tvSecretHash: hashSecret("x".repeat(10)), createdAt: 0, ttl: 0 });
    const ctx = { store, now: () => Date.now(), invoke: invokeClaude, parse: parseModelJson, bedrockDailyLimit: 30 };
    const days = [
      { date: "2026-10-01", approachCount: 6, selfRecoveryCount: 2, starCount: 1, disconnectCount: 0, disconnectSeconds: 0, viewingSeconds: 2400 },
      { date: "2026-10-04", approachCount: 4, selfRecoveryCount: 3, starCount: 2, disconnectCount: 1, disconnectSeconds: 42, viewingSeconds: 1800 },
      { date: "2026-10-06", approachCount: 3, selfRecoveryCount: 3, starCount: 3, disconnectCount: 0, disconnectSeconds: 0, viewingSeconds: 2100 },
    ];
    // Per-mode metrics are required since T2; this report only reads the totals above.
    const modes = { intervene: emptyModeStats(), shadow: emptyModeStats() };
    for (const d of days) await putSummary(ctx, "s_live", { ...d, modes });

    const r = await weeklyReport(ctx, "s_live", "2026-10-07");
    console.log(JSON.stringify({ evidence: "bedrock_weekly_report", trace: r.trace, report: r.report }, null, 2));
    expect(r.trace?.modelId).toBe("us.anthropic.claude-sonnet-4-6");
    expect(r.trace?.requestId).toMatch(/[0-9a-f-]{20,}/);
    expect(r.trace?.inputTokens).toBeGreaterThan(0);
    expect(r.trace?.outputTokens).toBeGreaterThan(0);
    expect(r.report?.parentReflection.length).toBeGreaterThan(10);
    expect(r.report?.mascotLines.praise.length).toBeGreaterThan(0);
  }, 60_000);
});
