import { describe, expect, test, vi } from "vitest";
import { parseModelJson } from "../infra/lambda/src/lib/bedrock";
import { hashSecret } from "../infra/lambda/src/lib/crypto";
import {
  addReminder,
  authenticate,
  buildReportPrompt,
  HttpError,
  listRange,
  listWeek,
  parseRange,
  putSummary,
  REPORT_SYSTEM_EN,
  REPORT_SYSTEM_JA,
  parseReportLang,
  weeklyReport,
  weekRange,
  type InsightCtx,
} from "../infra/lambda/src/lib/insight-core";
import { MemoryStore } from "../infra/lambda/src/lib/store";
import { emptyModeStats } from "../lib/firesense";

const trace = { modelId: "us.anthropic.claude-sonnet-4-6", requestId: "req-1", latencyMs: 1200, inputTokens: 300, outputTokens: 200 };

function setup(modelText = "{}", bedrockDailyLimit = 30) {
  const store = new MemoryStore();
  store.sessions.set("s_1", {
    sessionId: "s_1",
    tvSecretHash: hashSecret("tv_secret_value"),
    cameraSecretHash: hashSecret("cs_secret_value"),
    parentSecretHashes: [hashSecret("ps_first_parent"), hashSecret("ps_second_parent")],
    createdAt: 0,
    ttl: 0,
  });
  const invoke = vi.fn(async () => ({ text: modelText, trace }));
  let now = Date.UTC(2026, 9, 7, 12);
  const ctx: InsightCtx = { store, now: () => now, invoke, parse: parseModelJson, bedrockDailyLimit };
  const setNow = (ms: number) => (now = ms);
  return { store, ctx, invoke, setNow };
}

const day = (date: string, n = 1) => ({
  date,
  approachCount: 3 * n,
  selfRecoveryCount: 2 * n,
  starCount: n,
  disconnectCount: 0,
  disconnectSeconds: 0,
  viewingSeconds: 1800,
  modes: { intervene: { ...emptyModeStats(), viewingSeconds: 1200, warnSeconds: 30, approachCount: 3 * n, recoverySeconds: [4.2, 6] }, shadow: emptyModeStats() },
});

describe("authenticate", () => {
  test("accepts the allowed role's secret and rejects the other", async () => {
    const { store } = setup();
    await expect(authenticate(store, "Bearer s_1:tv_secret_value", ["tv"])).resolves.toEqual({ sessionId: "s_1", role: "tv" });
    await expect(authenticate(store, "Bearer s_1:cs_secret_value", ["tv"])).rejects.toMatchObject({ status: 403 });
    await expect(authenticate(store, "Bearer s_1:cs_secret_value", ["tv", "camera"])).resolves.toMatchObject({ role: "camera" });
    await expect(authenticate(store, undefined, ["tv"])).rejects.toMatchObject({ status: 401 });
    await expect(authenticate(store, "Bearer s_9:x", ["tv"])).rejects.toMatchObject({ status: 401 });
  });

  test("any registered parent secret is accepted where parent is allowed, and nowhere else", async () => {
    const { store } = setup();
    await expect(authenticate(store, "Bearer s_1:ps_second_parent", ["tv", "camera", "parent"])).resolves.toEqual({ sessionId: "s_1", role: "parent" });
    await expect(authenticate(store, "Bearer s_1:ps_first_parent", ["tv", "camera"])).rejects.toMatchObject({ status: 403 });
    await expect(authenticate(store, "Bearer s_1:ps_unknown_parent", ["parent"])).rejects.toMatchObject({ status: 403 });
  });
});

describe("summaries", () => {
  test("validates and stores with a 30-day TTL", async () => {
    const { ctx, store } = setup();
    const saved = await putSummary(ctx, "s_1", day("2026-10-01"));
    expect(saved.ttl).toBe(Math.floor(ctx.now() / 1000) + 30 * 86400);
    expect(store.summaries.size).toBe(1);
    await expect(putSummary(ctx, "s_1", { date: "yesterday" })).rejects.toBeInstanceOf(HttpError);
  });

  test("weekRange covers 7 days inclusive and requires today", () => {
    expect(weekRange("2026-10-07")).toEqual({ from: "2026-10-01", to: "2026-10-07" });
    expect(() => weekRange("")).toThrow(/today/);
  });
});

describe("weekly report", () => {
  test("no data → no Claude call, report null (UI says 'まだ記録がありません')", async () => {
    const { ctx, invoke } = setup();
    const r = await weeklyReport(ctx, "s_1", "2026-10-07");
    expect(r).toMatchObject({ days: [], report: null, trace: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  test("sends only this session's last 7 days and returns the Bedrock trace", async () => {
    const reply = JSON.stringify({
      parentReflection: "今週は自分で下がれた回数が増えました。",
      highlights: ["自分で下がった回数 4回"],
      mascotLines: { approaching: "おや？", tooClose: "すこし はなれてね", praise: "えらいね！" },
    });
    const { ctx, invoke, store } = setup(reply);
    await putSummary(ctx, "s_1", day("2026-09-30")); // outside window
    await putSummary(ctx, "s_1", day("2026-10-02"));
    await putSummary(ctx, "s_1", day("2026-10-06", 2));
    await store.putSummary({ ...day("2026-10-05"), sessionId: "s_other", updatedAt: 0, ttl: 0 });
    const r = await weeklyReport(ctx, "s_1", "2026-10-07", "ja");
    expect(r.days.map((d) => d.date)).toEqual(["2026-10-02", "2026-10-06"]);
    expect(r.trace).toEqual(trace);
    expect(r.report?.mascotLines.praise).toBe("えらいね！");
    const prompt = (invoke.mock.calls[0] as any)[0].content[0].text as string;
    expect(prompt).toContain("2026-10-06: 視聴30分, 近づきすぎ6回, 自分で下がった4回, スター2個");
    expect(prompt).not.toContain("2026-09-30");
  });

  test("malformed model output fails fast with the raw text", async () => {
    const { ctx } = setup("not json");
    await putSummary(ctx, "s_1", day("2026-10-02"));
    await expect(weeklyReport(ctx, "s_1", "2026-10-07")).rejects.toMatchObject({ rawText: "not json", trace });
  });

  test("health or eyesight wording fails fast with the phrase and the raw text", async () => {
    const out = (tooClose: string, reflection = "今週は近づきすぎが減りました。") =>
      JSON.stringify({ parentReflection: reflection, highlights: ["3日目は0回でした"], mascotLines: { approaching: "ちょっと ちかいよ", tooClose, praise: "えらいね！" } });
    const bad = setup(out("めがつかれちゃうよ！"));
    await putSummary(bad.ctx, "s_1", day("2026-10-02"));
    await expect(weeklyReport(bad.ctx, "s_1", "2026-10-07")).rejects.toMatchObject({
      message: expect.stringContaining('mascotLines.tooClose: "めがつかれ"'),
      rawText: out("めがつかれちゃうよ！"),
      trace,
    });
    const kanji = setup(out("はなれてね", "近くで見ると目に負担がかかります。"));
    await putSummary(kanji.ctx, "s_1", day("2026-10-02"));
    await expect(weeklyReport(kanji.ctx, "s_1", "2026-10-07")).rejects.toThrow(/parentReflection: "目"/);
    // Counters such as 「3日目」 and 「目印」 are not health words.
    const ok = setup(out("うしろの 目印まで さがろう"));
    await putSummary(ok.ctx, "s_1", day("2026-10-02"));
    await expect(weeklyReport(ok.ctx, "s_1", "2026-10-07")).resolves.toMatchObject({ report: { highlights: ["3日目は0回でした"] } });
  });

  test("the prompts forbid health and eyesight wording, in both languages", () => {
    expect(REPORT_SYSTEM_JA).toMatch(/目・視力・近視・健康/);
    expect(REPORT_SYSTEM_EN).toMatch(/Never mention eyes, eyesight, vision, myopia, health/);
  });

  test("English wording is checked too; 'television' is not 'vision'", async () => {
    const out = (reflection: string) =>
      JSON.stringify({ parentReflection: reflection, highlights: [], mascotLines: { approaching: "A bit close!", tooClose: "Step back, please", praise: "Great job!" } });
    const bad = setup(out("Sitting close can strain the eyes."));
    await putSummary(bad.ctx, "s_1", day("2026-10-02"));
    await expect(weeklyReport(bad.ctx, "s_1", "2026-10-07", "en")).rejects.toThrow(/parentReflection: "eyes"/);
    const ok = setup(out("The television stayed at a good distance on most days."));
    await putSummary(ok.ctx, "s_1", day("2026-10-02"));
    await expect(weeklyReport(ok.ctx, "s_1", "2026-10-07", "en")).resolves.toMatchObject({ report: { mascotLines: { praise: "Great job!" } } });
  });

  test("the report language: English by default, Japanese on request, anything else is a 400", async () => {
    expect(parseReportLang(undefined)).toBe("en");
    expect(parseReportLang("ja")).toBe("ja");
    expect(() => parseReportLang("fr")).toThrow(/lang must be "en" or "ja"/);
    const { ctx, invoke } = setup(JSON.stringify({ parentReflection: "x", highlights: [], mascotLines: { approaching: "a", tooClose: "b", praise: "c" } }));
    await putSummary(ctx, "s_1", day("2026-10-02"));
    await weeklyReport(ctx, "s_1", "2026-10-07");
    expect((invoke.mock.calls[0] as any)[0].system).toBe(REPORT_SYSTEM_EN);
    expect((invoke.mock.calls[0] as any)[0].content[0].text).toMatch(/^Period: 2026-10-01 to 2026-10-07/);
    await weeklyReport(ctx, "s_1", "2026-10-07", "ja");
    expect((invoke.mock.calls[1] as any)[0].system).toBe(REPORT_SYSTEM_JA);
  });

  test("buildReportPrompt contains numbers only (no names, no images)", () => {
    const p = buildReportPrompt([day("2026-10-02")], { from: "2026-10-01", to: "2026-10-07" }, "ja");
    expect(p).toMatch(/^期間: 2026-10-01 〜 2026-10-07/);
  });
});

describe("field pilot (T2): per-mode summaries and the parent's reminder counter", () => {
  test("a summary without modes is rejected", async () => {
    const { ctx } = setup();
    const { modes: _drop, ...old } = day("2026-10-02");
    await expect(putSummary(ctx, "s_1", old)).rejects.toMatchObject({ status: 400 });
  });

  test("the rejection names the fields, and says an old TV build must be reinstalled", async () => {
    const { ctx } = setup();
    const { modes: _drop, ...old } = day("2026-10-02");
    await expect(putSummary(ctx, "s_1", old)).rejects.toThrow(/^invalid daily summary \(modes: Required\) — the TV app is an old build.*make install-apk$/);
    const bad = { ...day("2026-10-02"), disconnectSeconds: -1 };
    await expect(putSummary(ctx, "s_1", bad)).rejects.toThrow(/^invalid daily summary \(disconnectSeconds: Number must be greater than or equal to 0\)$/);
  });

  test("reminders count per mode, survive the TV's upsert, and cannot go below 0", async () => {
    const { ctx } = setup();
    await expect(addReminder(ctx, "s_1", { date: "2026-10-02", mode: "shadow", delta: 1 })).resolves.toEqual({
      date: "2026-10-02",
      parentReminders: { intervene: 0, shadow: 1 },
    });
    await addReminder(ctx, "s_1", { date: "2026-10-02", mode: "shadow", delta: 1 });
    await putSummary(ctx, "s_1", day("2026-10-02")); // the TV's 60 s upsert must not reset the counter
    const r = await addReminder(ctx, "s_1", { date: "2026-10-02", mode: "shadow", delta: -1 });
    expect(r.parentReminders).toEqual({ intervene: 0, shadow: 1 });
    await expect(addReminder(ctx, "s_1", { date: "2026-10-02", mode: "intervene", delta: -1 })).rejects.toMatchObject({ status: 409 });
    await expect(addReminder(ctx, "s_1", { date: "2026-10-02", delta: 1 })).rejects.toMatchObject({ status: 400 });
  });

  test("reading back: old-format records say 'missing', not 0; reminder-only days have no summary", async () => {
    const { ctx, store } = setup();
    const { modes: _drop, ...legacy } = day("2026-10-01");
    await store.summaries.set("s_1|2026-10-01", { ...legacy, sessionId: "s_1", updatedAt: 0, ttl: 0 }); // written before T2
    await putSummary(ctx, "s_1", day("2026-10-02"));
    await addReminder(ctx, "s_1", { date: "2026-10-03", mode: "intervene", delta: 1 });
    const days = await listWeek(ctx, "s_1", "2026-10-07");
    expect(days).toEqual([
      { date: "2026-10-01", summary: { ...legacy, modes: null }, parentReminders: null },
      { date: "2026-10-02", summary: day("2026-10-02"), parentReminders: { intervene: 0, shadow: 0 } },
      { date: "2026-10-03", summary: null, parentReminders: { intervene: 1, shadow: 0 } },
    ]);
  });

  test("the weekly report skips reminder-only days and is not called when no TV data exists", async () => {
    const { ctx, invoke } = setup();
    await addReminder(ctx, "s_1", { date: "2026-10-03", mode: "intervene", delta: 1 });
    const r = await weeklyReport(ctx, "s_1", "2026-10-07");
    expect(r.report).toBeNull();
    expect(r.days).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("per-session daily cap on Bedrock calls (T4)", () => {
  const reply = JSON.stringify({ parentReflection: "ok", highlights: [], mascotLines: { approaching: "a", tooClose: "b", praise: "c" } });

  test("calls up to the limit go through; the next one is 429 RATE_LIMITED and Claude is not called", async () => {
    const { ctx, invoke } = setup(reply, 3);
    await putSummary(ctx, "s_1", day("2026-10-06"));
    for (let i = 0; i < 3; i++) await expect(weeklyReport(ctx, "s_1", "2026-10-07")).resolves.toMatchObject({ report: { parentReflection: "ok" } });
    await expect(weeklyReport(ctx, "s_1", "2026-10-07")).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  test("the cap is per session and per UTC day (server clock, not the client's 'today')", async () => {
    const { ctx, store, setNow } = setup(reply, 1);
    store.sessions.set("s_2", { ...(await store.getSession("s_1"))!, sessionId: "s_2" });
    await putSummary(ctx, "s_1", day("2026-10-06"));
    await putSummary(ctx, "s_2", day("2026-10-06"));
    await weeklyReport(ctx, "s_1", "2026-10-07");
    await weeklyReport(ctx, "s_2", "2026-10-07"); // another household is not affected
    await expect(weeklyReport(ctx, "s_1", "2026-10-08")).rejects.toMatchObject({ status: 429 }); // spoofed "today"
    setNow(Date.UTC(2026, 9, 8, 0, 1));
    await expect(weeklyReport(ctx, "s_1", "2026-10-08")).resolves.toMatchObject({ report: { parentReflection: "ok" } });
  });

  test("no data → no Claude call → nothing counted", async () => {
    const { ctx, store } = setup(reply, 1);
    await weeklyReport(ctx, "s_1", "2026-10-07");
    expect(store.quotas.size).toBe(0);
  });
});

describe("HTTP error surface", () => {
  test("429 carries { code: RATE_LIMITED, message } as-is", async () => {
    const { withErrors } = await import("../infra/lambda/src/lib/http");
    const res = (await withErrors(async () => {
      throw new HttpError(429, "上限に達しました", { limit: 30 }, "RATE_LIMITED");
    })) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: "上限に達しました", code: "RATE_LIMITED", message: "上限に達しました", details: { limit: 30 } });
  });
});


describe("records: any period, and reset", () => {
  test("parseRange: dates, order and at most 31 days", () => {
    expect(parseRange("2026-10-01", "2026-10-31")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(parseRange("2026-10-05", "2026-10-05")).toEqual({ from: "2026-10-05", to: "2026-10-05" });
    expect(() => parseRange("2026-10-08", "2026-10-07")).toThrow(/after/);
    expect(() => parseRange("2026-09-01", "2026-10-07")).toThrow(/at most 31/);
    expect(() => parseRange(undefined, "2026-10-07")).toThrow(/from=YYYY-MM-DD/);
    expect(() => parseRange("2026/10/01", "2026-10-07")).toThrow(/from=YYYY-MM-DD/);
  });

  test("listRange returns the days inside the period only", async () => {
    const { ctx } = setup();
    for (const d of ["2026-10-01", "2026-10-05", "2026-10-09"]) await putSummary(ctx, "s_1", day(d));
    expect((await listRange(ctx, "s_1", "2026-10-02", "2026-10-09")).map((x) => x.date)).toEqual(["2026-10-05", "2026-10-09"]);
  });

  test("deleteSummaries removes every day of the session (TV fields and reminders), not other sessions'", async () => {
    const { ctx, store } = setup();
    await putSummary(ctx, "s_1", day("2026-10-01"));
    await addReminder(ctx, "s_1", { date: "2026-10-02", mode: "intervene", delta: 1 });
    await putSummary(ctx, "s_2", day("2026-10-01"));
    expect(await store.deleteSummaries("s_1")).toBe(2);
    expect(await listRange(ctx, "s_1", "2026-10-01", "2026-10-31")).toEqual([]);
    expect(await listRange(ctx, "s_2", "2026-10-01", "2026-10-31")).toHaveLength(1);
  });
});
