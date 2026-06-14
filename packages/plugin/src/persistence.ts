import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  data: string;
}

export interface PersistedMessage {
  id: string;
  role?: unknown;
  time?: unknown;
  parts: unknown[];
}

const DEFAULT_LIMIT = 20;

export function readPersistedMessages(sessionID: string, limit = DEFAULT_LIMIT): PersistedMessage[] | undefined {
  const databasePath = getOpencodeDatabasePath();
  if (!existsSync(databasePath)) return undefined;

  const db = new Database(databasePath, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 1000");

    const messages = db
      .query<MessageRow, [string, number]>(
        "select id, time_created, data from message where session_id = ? order by time_created desc, id desc limit ?",
      )
      .all(sessionID, clampLimit(limit))
      .reverse();

    if (!messages.length) return [];

    const messageIDs = messages.map((message) => message.id);
    const parts = db
      .query<PartRow, string[]>(
        `select id, message_id, data
         from part
         where message_id in (${messageIDs.map(() => "?").join(",")})
         order by time_created asc, id asc`,
      )
      .all(...messageIDs);
    const partsByMessage = groupParts(parts);

    return messages.map((message) => {
      const data = parseJsonRecord(message.data);
      return {
        id: message.id,
        role: data?.role,
        time: data?.time ?? { created: message.time_created },
        parts: partsByMessage.get(message.id) ?? [],
      };
    });
  } finally {
    db.close();
  }
}

function groupParts(rows: PartRow[]) {
  const result = new Map<string, unknown[]>();
  for (const row of rows) {
    const part = parseJsonRecord(row.data);
    if (!part) continue;
    const list = result.get(row.message_id) ?? [];
    list.push({ id: row.id, ...part });
    result.set(row.message_id, list);
  }
  return result;
}

function getOpencodeDatabasePath() {
  const custom = process.env.OPENCODE_DB;
  if (custom) return isAbsolute(custom) || custom === ":memory:" ? custom : join(getOpencodeDataDir(), custom);
  return join(getOpencodeDataDir(), "opencode.db");
}

function getOpencodeDataDir() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}

function clampLimit(limit: number) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : DEFAULT_LIMIT;
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
