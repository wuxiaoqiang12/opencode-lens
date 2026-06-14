import { createConnection, type Socket } from "node:net";

import type { ActiveInstance } from "@opencode-lens/shared";

export interface EventsCursor {
  instances?: Record<string, number>;
}

export interface EventsFilter {
  event_names?: string[];
  session?: string;
}

export interface WaitedEvent {
  instance: string;
  event: string;
  id: number;
  at?: number;
  data: unknown;
}

export async function waitForEvents(instances: ActiveInstance[], cursor: EventsCursor, timeoutMs: number, filter: EventsFilter = {}) {
  const nextCursor: EventsCursor = { instances: { ...(cursor.instances ?? {}) } };
  const events: WaitedEvent[] = [];
  const sockets: Socket[] = [];

  return new Promise<{ events: WaitedEvent[]; cursor: EventsCursor }>((resolve) => {
    let done = false;
    const timeout = setTimeout(() => finish(), timeoutMs);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      for (const socket of sockets) socket.destroy();
      resolve({ events, cursor: nextCursor });
    }

    if (instances.length === 0) finish();

    for (const instance of instances) {
      const socket = createConnection({ path: instance.socket });
      sockets.push(socket);
      let buffer = "";
      let headersDone = false;

      socket.on("connect", () => {
        const lastID = nextCursor.instances?.[instance.id];
        const headers = ["GET /events HTTP/1.1", "Host: opencode-lens", "Connection: close"];
        if (lastID) headers.push(`Last-Event-ID: ${lastID}`);
        socket.write([...headers, "", ""].join("\r\n"));
      });

      socket.on("data", (chunk) => {
        buffer += Buffer.from(chunk).toString("utf8");

        if (!headersDone) {
          const split = buffer.indexOf("\r\n\r\n");
          if (split < 0) return;
          buffer = buffer.slice(split + 4);
          headersDone = true;
        }

        while (true) {
          const blockEnd = buffer.indexOf("\n\n");
          if (blockEnd < 0) break;
          const block = buffer.slice(0, blockEnd);
          buffer = buffer.slice(blockEnd + 2);
          const event = parseEventBlock(instance.id, block);
          if (!event) continue;
          nextCursor.instances = { ...(nextCursor.instances ?? {}), [instance.id]: event.id };
          if (!matchesFilter(event, filter)) continue;
          events.push(event);
          finish();
        }
      });

      socket.on("error", () => undefined);
      socket.on("end", () => undefined);
    }
  });
}

function matchesFilter(event: WaitedEvent, filter: EventsFilter) {
  if (filter.event_names && filter.event_names.length > 0 && !filter.event_names.includes(event.event)) return false;
  if (filter.session && getSessionID(getRecord(event.data)) !== filter.session) return false;
  return true;
}

function getSessionID(data: Record<string, unknown> | undefined) {
  if (!data) return undefined;
  if (typeof data.session_id === "string") return data.session_id;
  if (typeof data.sessionID === "string") return data.sessionID;
  const info = getRecord(data.info);
  if (typeof info?.sessionID === "string") return info.sessionID;
  const session = getRecord(data.session);
  if (typeof session?.id === "string") return session.id;
  return undefined;
}

function parseEventBlock(instance: string, block: string): WaitedEvent | undefined {
  const lines = block.replaceAll("\r", "").split("\n");
  if (lines.every((line) => line.startsWith(":"))) return undefined;

  let id: number | undefined;
  let event = "message";
  const data: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const split = line.indexOf(":");
    const field = split >= 0 ? line.slice(0, split) : line;
    const value = split >= 0 ? line.slice(split + 1).trimStart() : "";
    if (field === "id") id = Number(value);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }

  if (!id || !Number.isInteger(id)) return undefined;
  const parsed = parseData(data.join("\n"));
  return {
    instance,
    event,
    id,
    at: getNumber(getRecord(parsed)?.at),
    data: getRecord(parsed)?.data ?? parsed,
  };
}

function parseData(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function getRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function getNumber(input: unknown) {
  return typeof input === "number" ? input : undefined;
}
