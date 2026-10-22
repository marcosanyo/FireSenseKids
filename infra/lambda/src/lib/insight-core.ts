/**
 * Insight Plane core (plan Phase 5): daily summaries and the weekly report.
 * HTTP-agnostic; handlers adapt API Gateway events to these functions.
 */

import {
  DailySummarySchema,
  ReminderRequestSchema,
  WeeklyReportSchema,
  type BedrockTrace,
  type DayRecord,
  type ParentReminders,
  type WeeklyReport,
} from "../../../../lib/firesense/protocol";
import { BedrockOutputError, type ClaudeRequest } from "./bedrock";
import { secretMatches } from "./crypto";
import { SUMMARY_TTL_DAYS, ttlFromNow, type Role, type Store, type StoredDayItem, type StoredSummary } from "./store";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    /** Machine-readable code for errors the UI must show as-is, e.g. RATE_LIMITED. */
    public readonly code?: string
  ) {
    super(message);
  }
}

export interface InsightCtx {
  store: Store;
  now: () => number;
  invoke: (req: ClaudeRequest) => Promise<{ text: string; trace: BedrockTrace }>;
  parse: <T>(text: string, schema: import("zod").ZodType<T>, trace: BedrockTrace) => T;
  /** Max Bedrock calls per session per UTC day (T4: keeps the public stack's cost bounded). */
  bedrockDailyLimit: number;
}

/**
 * Counts one Bedrock call for this session today (UTC, server clock — not the client's `today`).
 * Over the limit: HTTP 429 { code: "RATE_LIMITED" }. Nothing is skipped or faked; the UI shows it.
 */
export async function consumeBedrockQuota(ctx: InsightCtx, sessionId: string, route: string): Promise<void> {
  const day = new Date(ctx.now()).toISOString().slice(0, 10);
  const used = await ctx.store.consumeQuota(`${sessionId}#${day}#${route}`, ctx.bedrockDailyLimit, ttlFromNow(ctx.now(), 2 * 86400));
  if (used === null) {
    throw new HttpError(
      429,
      `This session has already called Claude ${ctx.bedrockDailyLimit} times today (UTC ${day}). The daily limit is reached, so nothing more can be generated today.`,
      { route, limit: ctx.bedrockDailyLimit, day },
      "RATE_LIMITED"
    );
  }
}

// ---------------------------------------------------------------------------
// Auth: "Authorization: Bearer <sessionId>:<secret>" (TV, camera, or one of the parent secrets)
// ---------------------------------------------------------------------------
export async function authenticate(
  store: Store,
  header: string | undefined,
  allowed: Role[]
): Promise<{ sessionId: string; role: Role }> {
  const m = /^Bearer ([^:\s]+):(\S+)$/.exec(header ?? "");
  if (!m) throw new HttpError(401, "Authorization header must be 'Bearer <sessionId>:<secret>'");
  const [, sessionId, secret] = m;
  const session = await store.getSession(sessionId);
  if (!session) throw new HttpError(401, `session ${sessionId} not found or expired`);
  if (allowed.includes("tv") && secretMatches(secret, session.tvSecretHash)) return { sessionId, role: "tv" };
  if (allowed.includes("camera") && secretMatches(secret, session.cameraSecretHash)) return { sessionId, role: "camera" };
  if (allowed.includes("parent") && (session.parentSecretHashes ?? []).some((h) => secretMatches(secret, h))) return { sessionId, role: "parent" };
  throw new HttpError(403, `credentials are not valid for this endpoint (allowed: ${allowed.join(", ")})`);
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------
/**
 * The `error` text names the rejected fields, because TV builds show only that string. A body with
 * no `modes` comes from a TV app built before the field pilot (T2), so the text says to update it.
 */
export function summaryRejection(issues: import("zod").ZodIssue[], body: unknown): string {
  const fields = issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join(", ");
  const legacy = typeof body === "object" && body !== null && !("modes" in body);
  return `invalid daily summary (${fields})${legacy ? " — the TV app is an old build (no modes). Reinstall the APK: make install-apk" : ""}`;
}

export async function putSummary(ctx: InsightCtx, sessionId: string, body: unknown): Promise<StoredSummary> {
  const parsed = DailySummarySchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, summaryRejection(parsed.error.issues, body), parsed.error.issues);
  const now = ctx.now();
  const item: StoredSummary = { ...parsed.data, sessionId, updatedAt: now, ttl: ttlFromNow(now, SUMMARY_TTL_DAYS * 86400) };
  await ctx.store.putSummary(item);
  return item;
}

/** The parent's "I said 'step back'" button (T2): ±1 on the day's counter for the given mode. */
export async function addReminder(ctx: InsightCtx, sessionId: string, body: unknown): Promise<{ date: string; parentReminders: ParentReminders }> {
  const parsed = ReminderRequestSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid reminder request", parsed.error.issues);
  const { date, mode, delta } = parsed.data;
  const counts = await ctx.store.addReminder(sessionId, date, mode, delta, ttlFromNow(ctx.now(), SUMMARY_TTL_DAYS * 86400));
  if (!counts) throw new HttpError(409, `${date} has 0 reminders for ${mode}, so it cannot go lower`);
  return { date, parentReminders: counts };
}

/** Reads one stored item back. Anything the record does not have is null, never 0. */
export function toDayRecord(item: StoredDayItem): DayRecord {
  const hasTv = item.approachCount !== undefined;
  const hasReminders = item.reminderIntervene !== undefined || item.reminderShadow !== undefined;
  return {
    date: item.date,
    summary: hasTv
      ? {
          date: item.date,
          approachCount: item.approachCount!,
          selfRecoveryCount: item.selfRecoveryCount!,
          starCount: item.starCount!,
          disconnectCount: item.disconnectCount!,
          disconnectSeconds: item.disconnectSeconds!,
          viewingSeconds: item.viewingSeconds!,
          modes: item.modes ?? null,
        }
      : null,
    // Both counters exist from the first write since T2; one missing means "no presses in that mode".
    parentReminders: hasReminders ? { intervene: item.reminderIntervene ?? 0, shadow: item.reminderShadow ?? 0 } : null,
  };
}

export function weekRange(today: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new HttpError(400, "query parameter today=YYYY-MM-DD is required");
  const end = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) throw new HttpError(400, `invalid date ${today}`);
  const start = new Date(end.getTime() - 6 * 86400_000);
  return { from: start.toISOString().slice(0, 10), to: today };
}

/** Records are kept this long (SUMMARY_TTL_DAYS); a range may span at most this many days. */
export const MAX_RANGE_DAYS = 31;

/** `from`..`to` (inclusive, YYYY-MM-DD), checked: valid dates, from ≤ to, at most MAX_RANGE_DAYS days. */
export function parseRange(from: string | undefined, to: string | undefined): { from: string; to: string } {
  for (const [name, v] of [["from", from], ["to", to]] as const) {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) {
      throw new HttpError(400, `query parameter ${name}=YYYY-MM-DD is required (got "${v ?? ""}")`);
    }
  }
  const days = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400_000 + 1;
  if (days < 1) throw new HttpError(400, `from (${from}) is after to (${to})`);
  if (days > MAX_RANGE_DAYS) throw new HttpError(400, `the range is ${days} days; at most ${MAX_RANGE_DAYS} (records are kept ${SUMMARY_TTL_DAYS} days)`);
  return { from: from as string, to: to as string };
}

export async function listRange(ctx: InsightCtx, sessionId: string, from: string | undefined, to: string | undefined): Promise<DayRecord[]> {
  const r = parseRange(from, to);
  const rows = await ctx.store.querySummaries(sessionId, r.from, r.to);
  return rows.map(toDayRecord);
}

export async function listWeek(ctx: InsightCtx, sessionId: string, today: string): Promise<DayRecord[]> {
  const { from, to } = weekRange(today);
  const rows = await ctx.store.querySummaries(sessionId, from, to);
  return rows.map(toDayRecord);
}

// ---------------------------------------------------------------------------
// Weekly report (Claude Sonnet 4.6)
// ---------------------------------------------------------------------------
/** The weekly report's language follows the parent phone's UI language. */
export type ReportLang = "en" | "ja";

export function parseReportLang(raw: string | undefined): ReportLang {
  if (raw === undefined || raw === "") return "en";
  if (raw === "en" || raw === "ja") return raw;
  throw new HttpError(400, `query parameter lang must be "en" or "ja" (got "${raw}")`);
}

export const REPORT_SYSTEM_JA = `あなたは子ども向け視聴見守りアプリ「FireSense Kids」の振り返りアシスタントです。
保護者向けに、1週間の視聴記録（数値のみ）を短く温かく振り返ります。

守ること:
- 与えられた数値だけを根拠にする。書かれていない出来事や数値を作らない。
- 子どもの性格・気質・発達を断定しない。行動の回数と変化だけを述べる。
- 叱る・罰する表現は使わない。できたことを具体的に認める。
- 「切断」はセンサー（見守りスマホ）の接続状態であり、子どもの行動ではない。
- 目・視力・近視・健康・体への影響には一切触れない（「めがつかれちゃう」「目に悪い」なども不可）。このアプリは健康や視力への効果を主張しない。距離のルールを守れたかどうかだけを述べる。
- マスコット（柴犬の隊長）のセリフは子どもに向けた短い日本語（各30文字以内、ひらがな多め）。

出力はJSONオブジェクトのみ（前置き・コードブロック禁止）:
{"parentReflection": "保護者向けの振り返り（3〜4文）", "highlights": ["数値に基づく気づき（最大3件）"], "mascotLines": {"approaching": "近づき始めたときのセリフ", "tooClose": "近すぎるときのセリフ", "praise": "自分で下がれたときのほめ言葉"}}`;

export const REPORT_SYSTEM_EN = `You are the weekly reflection assistant of FireSense Kids, a Fire TV viewing app for families.
You write a short, warm reflection for parents on one week of viewing records (numbers only).

Rules:
- Use only the numbers given. Do not invent events or numbers.
- Do not judge the child's personality, temperament or development. Describe only counts and changes.
- No scolding or punishing language. Acknowledge concretely what went well.
- "Sensor drops" are the watch camera's connection state, not the child's behavior.
- Never mention eyes, eyesight, vision, myopia, health or effects on the body (not even "your eyes will get tired"). This app makes no health or eyesight claims. Talk only about keeping the household's distance rule.
- Mascot lines are short English lines for a young child (at most 8 words each, simple words).

Output a JSON object only (no preamble, no code block):
{"parentReflection": "reflection for parents (3–4 sentences)", "highlights": ["observations based on the numbers (up to 3)"], "mascotLines": {"approaching": "line when the child starts getting close", "tooClose": "line when too close", "praise": "praise when the child stepped back by themselves"}}`;

export function reportSystem(lang: ReportLang): string {
  return lang === "ja" ? REPORT_SYSTEM_JA : REPORT_SYSTEM_EN;
}

type ReportDay = NonNullable<DayRecord["summary"]>;

export function buildReportPrompt(days: ReportDay[], range: { from: string; to: string }, lang: ReportLang = "en"): string {
  if (lang === "ja") {
    const rows = days
      .map(
        (d) =>
          `${d.date}: 視聴${Math.round(d.viewingSeconds / 60)}分, 近づきすぎ${d.approachCount}回, 自分で下がった${d.selfRecoveryCount}回, スター${d.starCount}個, センサー切断${d.disconnectCount}回(${d.disconnectSeconds}秒)`
      )
      .join("\n");
    return `期間: ${range.from} 〜 ${range.to}（記録がある日: ${days.length}日）\n${rows}`;
  }
  const rows = days
    .map(
      (d) =>
        `${d.date}: watched ${Math.round(d.viewingSeconds / 60)} min, too-close approaches ${d.approachCount}, stepped back by themselves ${d.selfRecoveryCount}, stars ${d.starCount}, sensor drops ${d.disconnectCount} (${d.disconnectSeconds} s)`
    )
    .join("\n");
  return `Period: ${range.from} to ${range.to} (days with records: ${days.length})\n${rows}`;
}

export interface WeeklyReportResponse {
  range: { from: string; to: string };
  days: DayRecord[];
  report: WeeklyReport | null;
  trace: BedrockTrace | null;
}

export async function weeklyReport(ctx: InsightCtx, sessionId: string, today: string, lang: ReportLang = "en"): Promise<WeeklyReportResponse> {
  const range = weekRange(today);
  const days = await listWeek(ctx, sessionId, today);
  const viewed = days.flatMap((d) => (d.summary ? [d.summary] : []));
  if (viewed.length === 0) {
    // No data: say so. Claude is not called and nothing is invented.
    return { range, days, report: null, trace: null };
  }
  await consumeBedrockQuota(ctx, sessionId, "report");
  const { text, trace } = await ctx.invoke({
    system: reportSystem(lang),
    content: [{ type: "text", text: buildReportPrompt(viewed, range, lang) }],
    maxTokens: 1500,
  });
  const report = ctx.parse(text, WeeklyReportSchema, trace);
  assertNoHealthClaims(report, text, trace);
  return { range, days, report, trace };
}

/**
 * Health / eyesight wording that FireSense must never show (it makes no such claims). Day counters such as
 * 「3日目」「2回目」 and 「目印」「目標」 are not health words.
 */
const HEALTH_PATTERNS: RegExp[] = [
  /(?<![0-9０-９一二三四五六七八九十百何回日番週度項])目(?![印標安次指])/,
  /眼|視力|近視|遠視|視覚|健康|医学|医師|病院|病気|治療|疲れ目/,
  /おめめ|めが\s*(つかれ|わるく|いたく|しょぼしょぼ)|めに\s*(わるい|よくない|やさしい|やさしく)|めを\s*(まもろ|まもる|やすめ)/,
  /からだに\s*(わるい|よくない)|体に(悪い|よくない)/,
  // English ("vision" only as a whole word, so "television" is fine)
  /\b(eyes?|eyesight|vision|myopi\w*|nearsight\w*|short-sight\w*|health\w*|medical|doctor|optometrist)\b/i,
];

/** The prompt forbids health wording; if Claude still writes it, fail fast with the phrase (no retry, no rewrite). */
export function assertNoHealthClaims(report: WeeklyReport, rawText: string, trace: BedrockTrace): void {
  const fields: [string, string][] = [
    ["parentReflection", report.parentReflection],
    ...report.highlights.map((h, i): [string, string] => [`highlights[${i}]`, h]),
    ["mascotLines.approaching", report.mascotLines.approaching],
    ["mascotLines.tooClose", report.mascotLines.tooClose],
    ["mascotLines.praise", report.mascotLines.praise],
  ];
  for (const [field, value] of fields) {
    for (const re of HEALTH_PATTERNS) {
      const m = value.match(re);
      if (m) {
        throw new BedrockOutputError(
          `Claude's output mentioned health or eyesight, so it is not shown (${field}: "${m[0]}" in "${value}"). FireSense makes no health or eyesight claims. Generate it again`,
          rawText,
          trace
        );
      }
    }
  }
}
