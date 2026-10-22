/**
 * Session / connection persistence.
 *
 * Table `sessions` (pk only):
 *   SESSION#<sessionId>  tvSecretHash, cameraSecretHash?, tokenHash?, tokenExpiresAt, tokenUsed,
 *                        tvConnId?, cameraConnId?, playing, ttl,
 *                        parentSecretHashes? (list, up to MAX_PARENTS), parentTokenHash?,
 *                        parentTokenExpiresAt?, parentTokenUsed?, parentConnIds? (string set)
 *   CONN#<connectionId>  role, sessionId?, ttl
 *   QUOTA#<key>          calls, ttl   (per-session daily cap on Bedrock calls, T4)
 *
 * Table `daily_summaries` (pk sessionId, sk date): DailySummary fields (written by the TV) +
 *   reminderIntervene / reminderShadow (the parent's reminder counter, ADDed separately so the
 *   TV's upsert never overwrites it) + ttl. Records from before T2 have no `modes` and no reminder
 *   attributes; readers report them as missing, never as 0.
 */

import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DailySummary, FireSenseMode, ParentReminders, Playlist, TvNowPlaying, TvSettings } from "../../../../lib/firesense/protocol";

export type Role = "tv" | "camera" | "parent";

export interface SessionRecord {
  sessionId: string;
  tvSecretHash: string;
  cameraSecretHash?: string;
  tokenHash?: string;
  tokenExpiresAt?: number;
  tokenUsed?: boolean;
  tvConnId?: string;
  cameraConnId?: string;
  playing?: boolean;
  createdAt: number;
  ttl: number;
  /** One hash per paired parent phone (QR pairing from the TV). */
  parentSecretHashes?: string[];
  parentTokenHash?: string;
  parentTokenExpiresAt?: number;
  parentTokenUsed?: boolean;
  /** Connected parent phones (several may be open at once). */
  parentConnIds?: string[];
  /** The TV's last "now playing" (sent to a parent phone when it connects). */
  nowPlaying?: TvNowPlaying;
  /** The family's own video list, edited on the parent phones (PlaylistSave). */
  customPlaylist?: Playlist;
  /** TV intervention settings (child cues, marker, pause). */
  tvSettings?: TvSettings;
}

export interface ConnectionRecord {
  connectionId: string;
  role: Role;
  sessionId?: string;
  ttl: number;
}

export interface StoredSummary extends DailySummary {
  sessionId: string;
  updatedAt: number;
  ttl: number;
}

/** A raw daily_summaries item: any mix of TV fields (maybe old format) and reminder counters. */
export type StoredDayItem = Partial<Omit<StoredSummary, "sessionId" | "date">> & {
  sessionId: string;
  date: string;
  reminderIntervene?: number;
  reminderShadow?: number;
};

export const REMINDER_ATTR: Record<FireSenseMode, "reminderIntervene" | "reminderShadow"> = {
  intervene: "reminderIntervene",
  shadow: "reminderShadow",
};

export interface Store {
  putConnection(c: ConnectionRecord): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  bindConnection(connectionId: string, sessionId: string): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;

  createSession(s: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  /** Partial update. `null` values remove the attribute. */
  updateSession(sessionId: string, patch: Partial<Record<keyof SessionRecord, unknown>>): Promise<void>;
  /** Clears tvConnId/cameraConnId only if it still equals connectionId. */
  clearPeerConnection(sessionId: string, role: Role, connectionId: string): Promise<boolean>;
  /**
   * Atomically consumes a pairing token: succeeds only if tokenHash matches, it is unused and
   * unexpired. Stores the new camera secret hash and connection id in the same write.
   */
  consumePairingToken(
    sessionId: string,
    tokenHash: string,
    nowMs: number,
    cameraSecretHash: string,
    cameraConnId: string
  ): Promise<boolean>;

  /**
   * Atomically consumes a parent pairing token (matching, unused, unexpired, and fewer than
   * `maxParents` parents already paired) and appends the new parent secret hash.
   */
  consumeParentPairingToken(sessionId: string, tokenHash: string, nowMs: number, parentSecretHash: string, maxParents: number): Promise<boolean>;
  addParentConnection(sessionId: string, connectionId: string): Promise<void>;
  /** Removes one parent connection id. Returns the ids left, or null if it was not there. */
  removeParentConnection(sessionId: string, connectionId: string): Promise<string[] | null>;

  /** Upserts the TV's fields; keeps the reminder counters (initialized to 0 if absent). */
  putSummary(s: StoredSummary): Promise<void>;
  /**
   * Adds ±1 to one mode's reminder counter. Returns the new counters, or null when a −1 would go
   * below 0 (conditional update).
   */
  addReminder(sessionId: string, date: string, mode: FireSenseMode, delta: 1 | -1, ttl: number): Promise<ParentReminders | null>;
  querySummaries(sessionId: string, fromDate: string, toDate: string): Promise<StoredDayItem[]>;
  /** Deletes every daily record of the session (TV fields and reminder counters). Returns how many. */
  deleteSummaries(sessionId: string): Promise<number>;

  /**
   * Counts one call against `key` with a conditional update. Returns the count after this call,
   * or null when `limit` calls were already made (nothing is counted then).
   */
  consumeQuota(key: string, limit: number, ttl: number): Promise<number | null>;
}

export const SESSION_TTL_DAYS = 30;
export const CONNECTION_TTL_HOURS = 24;
export const SUMMARY_TTL_DAYS = 30;

export function ttlFromNow(nowMs: number, seconds: number): number {
  return Math.floor(nowMs / 1000) + seconds;
}

// ---------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const sessionKey = (id: string) => ({ pk: `SESSION#${id}` });
const connKey = (id: string) => ({ pk: `CONN#${id}` });

export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;
  private readonly sessionsTable: string;
  private readonly summariesTable: string;

  constructor(client = new DynamoDBClient({})) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
    this.sessionsTable = requireEnv("SESSIONS_TABLE");
    this.summariesTable = requireEnv("SUMMARIES_TABLE");
  }

  async putConnection(c: ConnectionRecord) {
    await this.doc.send(new PutCommand({ TableName: this.sessionsTable, Item: { ...connKey(c.connectionId), ...c } }));
  }

  async getConnection(connectionId: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.sessionsTable, Key: connKey(connectionId), ConsistentRead: true }));
    return (r.Item as ConnectionRecord | undefined) ?? null;
  }

  async bindConnection(connectionId: string, sessionId: string) {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.sessionsTable,
        Key: connKey(connectionId),
        UpdateExpression: "SET sessionId = :s",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":s": sessionId },
      })
    );
  }

  async deleteConnection(connectionId: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.sessionsTable, Key: connKey(connectionId) }));
  }

  async createSession(s: SessionRecord) {
    await this.doc.send(
      new PutCommand({
        TableName: this.sessionsTable,
        Item: { ...sessionKey(s.sessionId), ...s },
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
  }

  async getSession(sessionId: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.sessionsTable, Key: sessionKey(sessionId), ConsistentRead: true }));
    const item = r.Item as (Omit<SessionRecord, "parentConnIds"> & { parentConnIds?: Set<string> }) | undefined;
    if (!item) return null;
    // parentConnIds is a DynamoDB string set (ADD / DELETE are atomic); callers get a plain array.
    return { ...item, parentConnIds: item.parentConnIds ? [...item.parentConnIds] : undefined };
  }

  async updateSession(sessionId: string, patch: Partial<Record<keyof SessionRecord, unknown>>) {
    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    Object.entries(patch).forEach(([k, v], i) => {
      names[`#k${i}`] = k;
      if (v === null) removes.push(`#k${i}`);
      else {
        sets.push(`#k${i} = :v${i}`);
        values[`:v${i}`] = v;
      }
    });
    const expr = [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""]
      .filter(Boolean)
      .join(" ");
    await this.doc.send(
      new UpdateCommand({
        TableName: this.sessionsTable,
        Key: sessionKey(sessionId),
        UpdateExpression: expr,
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
      })
    );
  }

  async clearPeerConnection(sessionId: string, role: Role, connectionId: string) {
    const attr = role === "tv" ? "tvConnId" : "cameraConnId";
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.sessionsTable,
          Key: sessionKey(sessionId),
          UpdateExpression: `REMOVE ${attr}`,
          ConditionExpression: `${attr} = :c`,
          ExpressionAttributeValues: { ":c": connectionId },
        })
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async consumePairingToken(sessionId: string, tokenHash: string, nowMs: number, cameraSecretHash: string, cameraConnId: string) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.sessionsTable,
          Key: sessionKey(sessionId),
          UpdateExpression: "SET tokenUsed = :true, cameraSecretHash = :sec, cameraConnId = :conn",
          ConditionExpression: "tokenHash = :h AND tokenUsed = :false AND tokenExpiresAt > :now",
          ExpressionAttributeValues: {
            ":true": true,
            ":false": false,
            ":h": tokenHash,
            ":now": nowMs,
            ":sec": cameraSecretHash,
            ":conn": cameraConnId,
          },
        })
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async consumeParentPairingToken(sessionId: string, tokenHash: string, nowMs: number, parentSecretHash: string, maxParents: number) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.sessionsTable,
          Key: sessionKey(sessionId),
          UpdateExpression: "SET parentTokenUsed = :true, parentSecretHashes = list_append(if_not_exists(parentSecretHashes, :empty), :new)",
          ConditionExpression:
            "parentTokenHash = :h AND parentTokenUsed = :false AND parentTokenExpiresAt > :now AND (attribute_not_exists(parentSecretHashes) OR size(parentSecretHashes) < :max)",
          ExpressionAttributeValues: {
            ":true": true,
            ":false": false,
            ":h": tokenHash,
            ":now": nowMs,
            ":empty": [],
            ":new": [parentSecretHash],
            ":max": maxParents,
          },
        })
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async addParentConnection(sessionId: string, connectionId: string) {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.sessionsTable,
        Key: sessionKey(sessionId),
        UpdateExpression: "ADD parentConnIds :c",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":c": new Set([connectionId]) },
      })
    );
  }

  async removeParentConnection(sessionId: string, connectionId: string) {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.sessionsTable,
          Key: sessionKey(sessionId),
          UpdateExpression: "DELETE parentConnIds :c",
          ConditionExpression: "contains(parentConnIds, :id)",
          ExpressionAttributeValues: { ":c": new Set([connectionId]), ":id": connectionId },
          ReturnValues: "ALL_NEW",
        })
      );
      const left = (r.Attributes as { parentConnIds?: Set<string> } | undefined)?.parentConnIds;
      return left ? [...left] : [];
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }

  async putSummary(s: StoredSummary) {
    const { sessionId, date, ...fields } = s;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ":zero": 0 };
    const sets = Object.entries(fields).map(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:f${i}`] = v;
      return `#f${i} = :f${i}`;
    });
    sets.push("reminderIntervene = if_not_exists(reminderIntervene, :zero)", "reminderShadow = if_not_exists(reminderShadow, :zero)");
    await this.doc.send(
      new UpdateCommand({
        TableName: this.summariesTable,
        Key: { sessionId, date },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  }

  async addReminder(sessionId: string, date: string, mode: FireSenseMode, delta: 1 | -1, ttl: number) {
    const attr = REMINDER_ATTR[mode];
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.summariesTable,
          Key: { sessionId, date },
          UpdateExpression: `ADD ${attr} :d SET #ttl = :ttl`,
          ConditionExpression: delta < 0 ? `${attr} > :zero` : undefined,
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: { ":d": delta, ":ttl": ttl, ...(delta < 0 ? { ":zero": 0 } : {}) },
          ReturnValues: "ALL_NEW",
        })
      );
      const item = r.Attributes as StoredDayItem;
      return { intervene: item.reminderIntervene ?? 0, shadow: item.reminderShadow ?? 0 };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }

  async querySummaries(sessionId: string, fromDate: string, toDate: string) {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.summariesTable,
        KeyConditionExpression: "sessionId = :s AND #d BETWEEN :from AND :to",
        ExpressionAttributeNames: { "#d": "date" },
        ExpressionAttributeValues: { ":s": sessionId, ":from": fromDate, ":to": toDate },
      })
    );
    return (r.Items as StoredDayItem[] | undefined) ?? [];
  }

  async deleteSummaries(sessionId: string) {
    let deleted = 0;
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.summariesTable,
          KeyConditionExpression: "sessionId = :s",
          ExpressionAttributeValues: { ":s": sessionId },
          ProjectionExpression: "sessionId, #d",
          ExpressionAttributeNames: { "#d": "date" },
          ExclusiveStartKey: start,
        })
      );
      for (const item of (r.Items ?? []) as { sessionId: string; date: string }[]) {
        await this.doc.send(new DeleteCommand({ TableName: this.summariesTable, Key: { sessionId: item.sessionId, date: item.date } }));
        deleted++;
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return deleted;
  }

  async consumeQuota(key: string, limit: number, ttl: number) {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.sessionsTable,
          Key: { pk: `QUOTA#${key}` },
          UpdateExpression: "ADD calls :one SET #ttl = if_not_exists(#ttl, :ttl)",
          ConditionExpression: "attribute_not_exists(calls) OR calls < :limit",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: { ":one": 1, ":limit": limit, ":ttl": ttl },
          ReturnValues: "UPDATED_NEW",
        })
      );
      return (r.Attributes as { calls: number }).calls;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory (tests only)
// ---------------------------------------------------------------------------
export class MemoryStore implements Store {
  connections = new Map<string, ConnectionRecord>();
  sessions = new Map<string, SessionRecord>();
  summaries = new Map<string, StoredDayItem>();
  quotas = new Map<string, number>();

  async putConnection(c: ConnectionRecord) {
    this.connections.set(c.connectionId, { ...c });
  }
  async getConnection(id: string) {
    return this.connections.get(id) ?? null;
  }
  async bindConnection(id: string, sessionId: string) {
    const c = this.connections.get(id);
    if (!c) throw new Error(`connection ${id} not found`);
    c.sessionId = sessionId;
  }
  async deleteConnection(id: string) {
    this.connections.delete(id);
  }
  async createSession(s: SessionRecord) {
    if (this.sessions.has(s.sessionId)) throw new Error("exists");
    this.sessions.set(s.sessionId, { ...s });
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }
  async updateSession(id: string, patch: Partial<Record<keyof SessionRecord, unknown>>) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete (s as unknown as Record<string, unknown>)[k];
      else (s as unknown as Record<string, unknown>)[k] = v;
    }
  }
  async clearPeerConnection(id: string, role: Role, connectionId: string) {
    const s = this.sessions.get(id);
    const attr = role === "tv" ? "tvConnId" : "cameraConnId";
    if (!s || s[attr] !== connectionId) return false;
    delete s[attr];
    return true;
  }
  async consumePairingToken(id: string, tokenHash: string, nowMs: number, cameraSecretHash: string, cameraConnId: string) {
    const s = this.sessions.get(id);
    if (!s || s.tokenHash !== tokenHash || s.tokenUsed !== false || (s.tokenExpiresAt ?? 0) <= nowMs) return false;
    s.tokenUsed = true;
    s.cameraSecretHash = cameraSecretHash;
    s.cameraConnId = cameraConnId;
    return true;
  }
  async consumeParentPairingToken(id: string, tokenHash: string, nowMs: number, parentSecretHash: string, maxParents: number) {
    const s = this.sessions.get(id);
    if (!s || s.parentTokenHash !== tokenHash || s.parentTokenUsed !== false || (s.parentTokenExpiresAt ?? 0) <= nowMs) return false;
    if ((s.parentSecretHashes?.length ?? 0) >= maxParents) return false;
    s.parentTokenUsed = true;
    s.parentSecretHashes = [...(s.parentSecretHashes ?? []), parentSecretHash];
    return true;
  }
  async addParentConnection(id: string, connectionId: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    s.parentConnIds = [...new Set([...(s.parentConnIds ?? []), connectionId])];
  }
  async removeParentConnection(id: string, connectionId: string) {
    const s = this.sessions.get(id);
    if (!s?.parentConnIds?.includes(connectionId)) return null;
    s.parentConnIds = s.parentConnIds.filter((c) => c !== connectionId);
    if (s.parentConnIds.length === 0) delete s.parentConnIds;
    return s.parentConnIds ?? [];
  }
  async putSummary(s: StoredSummary) {
    const key = `${s.sessionId}|${s.date}`;
    const prev = this.summaries.get(key);
    this.summaries.set(key, {
      ...prev,
      ...structuredClone(s),
      reminderIntervene: prev?.reminderIntervene ?? 0,
      reminderShadow: prev?.reminderShadow ?? 0,
    });
  }
  async addReminder(sessionId: string, date: string, mode: FireSenseMode, delta: 1 | -1, ttl: number) {
    const key = `${sessionId}|${date}`;
    const attr = REMINDER_ATTR[mode];
    const item: StoredDayItem = this.summaries.get(key) ?? { sessionId, date };
    if (delta < 0 && !((item[attr] ?? 0) > 0)) return null;
    const next = { ...item, [attr]: (item[attr] ?? 0) + delta, ttl };
    this.summaries.set(key, next);
    return { intervene: next.reminderIntervene ?? 0, shadow: next.reminderShadow ?? 0 };
  }
  async querySummaries(sessionId: string, from: string, to: string) {
    return [...this.summaries.values()]
      .filter((s) => s.sessionId === sessionId && s.date >= from && s.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  async deleteSummaries(sessionId: string) {
    let n = 0;
    for (const [k, v] of this.summaries) {
      if (v.sessionId !== sessionId) continue;
      this.summaries.delete(k);
      n++;
    }
    return n;
  }
  async consumeQuota(key: string, limit: number) {
    const calls = this.quotas.get(key) ?? 0;
    if (calls >= limit) return null;
    this.quotas.set(key, calls + 1);
    return calls + 1;
  }
}
