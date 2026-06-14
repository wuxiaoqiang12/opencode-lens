import type { RegisteredInstance } from "./types";

export const registeredInstanceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "pid",
    "socket",
    "transport",
    "directory",
    "worktree",
    "project_id",
    "opencode_version",
    "lens_version",
    "started_at",
  ],
  properties: {
    pid: { type: "integer", minimum: 1 },
    socket: { type: "string", minLength: 1 },
    transport: { const: "unix" },
    directory: { type: "string", minLength: 1 },
    worktree: { type: "string", minLength: 1 },
    project_id: { type: "string", minLength: 1 },
    opencode_version: { type: "string", minLength: 1 },
    lens_version: { type: "string", minLength: 1 },
    started_at: { type: "number" },
  },
} as const;

export function parseRegisteredInstance(input: unknown): RegisteredInstance | undefined {
  if (!isRecord(input)) return undefined;
  const pid = input.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (input.transport !== "unix") return undefined;
  if (!isNonEmptyString(input.socket)) return undefined;
  if (!isNonEmptyString(input.directory)) return undefined;
  if (!isNonEmptyString(input.worktree)) return undefined;
  if (!isNonEmptyString(input.project_id)) return undefined;
  if (!isNonEmptyString(input.opencode_version)) return undefined;
  if (!isNonEmptyString(input.lens_version)) return undefined;
  if (typeof input.started_at !== "number") return undefined;

  return {
    pid,
    socket: input.socket,
    transport: input.transport,
    directory: input.directory,
    worktree: input.worktree,
    project_id: input.project_id,
    opencode_version: input.opencode_version,
    lens_version: input.lens_version,
    started_at: input.started_at,
  };
}

export function readRegisteredInstanceJson(text: string): RegisteredInstance | undefined {
  try {
    return parseRegisteredInstance(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.length > 0;
}
