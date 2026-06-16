#!/usr/bin/env node
import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../shared/src/discovery.ts
import { readdir, readFile, unlink } from "node:fs/promises";
import { basename, join as join2 } from "node:path";

// ../shared/src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var APP_DIR = "opencode-lens";
function getLensDataDir(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), APP_DIR);
}
function getInstancesDir(options = {}) {
  return join(getLensDataDir(options), "instances");
}

// ../shared/src/registry.ts
function parseRegisteredInstance(input) {
  if (!isRecord(input))
    return;
  const pid = input.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return;
  if (input.transport !== "unix")
    return;
  if (!isNonEmptyString(input.socket))
    return;
  if (!isNonEmptyString(input.directory))
    return;
  if (!isNonEmptyString(input.worktree))
    return;
  if (!isNonEmptyString(input.project_id))
    return;
  if (!isNonEmptyString(input.opencode_version))
    return;
  if (!isNonEmptyString(input.lens_version))
    return;
  if (typeof input.started_at !== "number")
    return;
  return {
    pid,
    socket: input.socket,
    transport: input.transport,
    directory: input.directory,
    worktree: input.worktree,
    project_id: input.project_id,
    opencode_version: input.opencode_version,
    lens_version: input.lens_version,
    started_at: input.started_at
  };
}
function readRegisteredInstanceJson(text) {
  try {
    return parseRegisteredInstance(JSON.parse(text));
  } catch {
    return;
  }
}
function isRecord(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function isNonEmptyString(input) {
  return typeof input === "string" && input.length > 0;
}

// ../shared/src/discovery.ts
var defaultFs = { readdir, readFile, unlink };
async function discoverInstances(options) {
  const instancesDir = options.instancesDir ?? getInstancesDir();
  const fs = options.fs ?? defaultFs;
  const result = { active: [], removed: [], errors: [] };
  let entries;
  try {
    entries = await fs.readdir(instancesDir);
  } catch (error) {
    if (isNotFound(error))
      return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json"))
      continue;
    const registryPath = join2(instancesDir, entry);
    const text = await readFileIfExists(fs, registryPath);
    if (text === undefined)
      continue;
    const parsed = readRegisteredInstanceJson(text);
    if (!parsed) {
      await removePath(fs, registryPath, result);
      continue;
    }
    const record = {
      ...parsed,
      id: basename(entry, ".json"),
      registry_path: registryPath
    };
    try {
      const health = await options.probe(record);
      result.active.push({ ...record, health });
    } catch (error) {
      result.errors.push({ registry_path: registryPath, error: errorMessage(error) });
      await removePath(fs, registryPath, result);
      await removePath(fs, record.socket, result);
    }
  }
  return result;
}
async function readFileIfExists(fs, path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error))
      return;
    throw error;
  }
}
async function removePath(fs, path, result) {
  try {
    await fs.unlink(path);
    result.removed.push(path);
  } catch (error) {
    if (!isNotFound(error))
      result.errors.push({ registry_path: path, error: errorMessage(error) });
  }
}
function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
// ../shared/src/types.ts
var LENS_VERSION = "0.1.3";
// src/lens-http.ts
import { createConnection } from "node:net";
async function requestUnixJson(socketPath, path, options = {}) {
  const response = await requestUnix(socketPath, path, options.method ?? "GET", options.body, options.timeoutMs ?? 2000);
  const parsed = parseHttpResponse(response);
  if (parsed.status < 200 || parsed.status >= 300) {
    throw new LensHttpRequestError(parsed.status, parsed.body);
  }
  return JSON.parse(parsed.body);
}
async function requestUnixJsonResult(socketPath, path, options = {}) {
  try {
    return { ok: true, data: await requestUnixJson(socketPath, path, options) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof LensHttpRequestError ? error.status : undefined,
      body: error instanceof LensHttpRequestError ? parseMaybeJson(error.body) : undefined
    };
  }
}

class LensHttpRequestError extends Error {
  status;
  body;
  constructor(status, body) {
    super(`lens returned HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
function requestUnix(socketPath, path, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error("lens request timed out"));
    }, timeoutMs);
    function done(response) {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(response);
    }
    function fail(error) {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    }
    socket.on("connect", () => {
      const encodedBody = body === undefined ? undefined : JSON.stringify(body);
      const headers = [`${method} ${path} HTTP/1.1`, "Host: opencode-lens", "Connection: close"];
      if (encodedBody !== undefined) {
        headers.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(encodedBody)}`);
      }
      socket.write([...headers, "", encodedBody ?? ""].join(`\r
`));
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const response = readCompleteResponse(chunks);
      if (response)
        done(response);
    });
    socket.on("error", (error) => {
      fail(error);
    });
    socket.on("end", () => {
      done(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
function readCompleteResponse(chunks) {
  const buffer = Buffer.concat(chunks);
  const split = buffer.indexOf(`\r
\r
`);
  if (split < 0)
    return;
  const header = buffer.subarray(0, split).toString("utf8");
  const contentLength = getContentLength(header);
  if (contentLength === undefined)
    return;
  if (buffer.length - split - 4 < contentLength)
    return;
  return buffer.subarray(0, split + 4 + contentLength).toString("utf8");
}
function parseHttpResponse(response) {
  const split = response.indexOf(`\r
\r
`);
  if (split < 0)
    throw new Error("invalid lens HTTP response");
  const header = response.slice(0, split);
  const body = response.slice(split + 4);
  const status = Number(header.split(" ")[1]);
  if (!Number.isInteger(status))
    throw new Error("invalid lens HTTP status");
  return { status, body };
}
function getContentLength(header) {
  for (const line of header.split(`\r
`)) {
    const split = line.indexOf(":");
    if (split < 0)
      continue;
    if (line.slice(0, split).trim().toLowerCase() !== "content-length")
      continue;
    const length = Number(line.slice(split + 1).trim());
    return Number.isInteger(length) && length >= 0 ? length : undefined;
  }
  return;
}
function parseMaybeJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

// src/sse.ts
import { createConnection as createConnection2 } from "node:net";
async function waitForEvents(instances, cursor, timeoutMs, filter = {}) {
  const nextCursor = { instances: { ...cursor.instances ?? {} } };
  const events = [];
  const sockets = [];
  return new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => finish(), timeoutMs);
    function finish() {
      if (done)
        return;
      done = true;
      clearTimeout(timeout);
      for (const socket of sockets)
        socket.destroy();
      resolve({ events, cursor: nextCursor });
    }
    if (instances.length === 0)
      finish();
    for (const instance of instances) {
      const socket = createConnection2({ path: instance.socket });
      sockets.push(socket);
      let buffer = "";
      let headersDone = false;
      socket.on("connect", () => {
        const lastID = nextCursor.instances?.[instance.id];
        const headers = ["GET /events HTTP/1.1", "Host: opencode-lens", "Connection: close"];
        if (lastID)
          headers.push(`Last-Event-ID: ${lastID}`);
        socket.write([...headers, "", ""].join(`\r
`));
      });
      socket.on("data", (chunk) => {
        buffer += Buffer.from(chunk).toString("utf8");
        if (!headersDone) {
          const split = buffer.indexOf(`\r
\r
`);
          if (split < 0)
            return;
          buffer = buffer.slice(split + 4);
          headersDone = true;
        }
        while (true) {
          const blockEnd = buffer.indexOf(`

`);
          if (blockEnd < 0)
            break;
          const block = buffer.slice(0, blockEnd);
          buffer = buffer.slice(blockEnd + 2);
          const event = parseEventBlock(instance.id, block);
          if (!event)
            continue;
          nextCursor.instances = { ...nextCursor.instances ?? {}, [instance.id]: event.id };
          if (!matchesFilter(event, filter))
            continue;
          events.push(event);
          finish();
        }
      });
      socket.on("error", () => {
        return;
      });
      socket.on("end", () => {
        return;
      });
    }
  });
}
function matchesFilter(event, filter) {
  if (filter.event_names && filter.event_names.length > 0 && !filter.event_names.includes(event.event))
    return false;
  if (filter.session && getSessionID(getRecord(event.data)) !== filter.session)
    return false;
  return true;
}
function getSessionID(data) {
  if (!data)
    return;
  if (typeof data.session_id === "string")
    return data.session_id;
  if (typeof data.sessionID === "string")
    return data.sessionID;
  const info = getRecord(data.info);
  if (typeof info?.sessionID === "string")
    return info.sessionID;
  const session = getRecord(data.session);
  if (typeof session?.id === "string")
    return session.id;
  return;
}
function parseEventBlock(instance, block) {
  const lines = block.replaceAll("\r", "").split(`
`);
  if (lines.every((line) => line.startsWith(":")))
    return;
  let id;
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (line.startsWith(":"))
      continue;
    const split = line.indexOf(":");
    const field = split >= 0 ? line.slice(0, split) : line;
    const value = split >= 0 ? line.slice(split + 1).trimStart() : "";
    if (field === "id")
      id = Number(value);
    if (field === "event")
      event = value;
    if (field === "data")
      data.push(value);
  }
  if (!id || !Number.isInteger(id))
    return;
  const parsed = parseData(data.join(`
`));
  return {
    instance,
    event,
    id,
    at: getNumber(getRecord(parsed)?.at),
    data: getRecord(parsed)?.data ?? parsed
  };
}
function parseData(input) {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
function getRecord(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
}
function getNumber(input) {
  return typeof input === "number" ? input : undefined;
}

// src/tools.ts
var tools = [
  {
    definition: {
      name: "instances_list",
      description: "List active local opencode-lens instances. This is intentionally compact and does not include session history; use sessions_list when session summaries are needed. Dead registry entries are cleaned during discovery.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    },
    async call() {
      const discovered = await discoverInstances({
        async probe(instance) {
          return requestUnixJson(instance.socket, "/health");
        }
      });
      return {
        instances: discovered.active,
        removed: discovered.removed,
        errors: discovered.errors
      };
    }
  },
  {
    definition: {
      name: "sessions_list",
      description: "List recent session summaries for one opencode-lens instance. Use this only when session history is explicitly needed; instances_list stays compact by design.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance"],
        properties: {
          instance: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }
        }
      }
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const limit = optionalInteger(args, "limit") ?? 20;
      if (limit > 100)
        throw new Error("limit must be at most 100");
      const sessions = await requestUnixJson(instance.socket, `/sessions?limit=${limit}`);
      return { instance: instance.id, sessions, limit };
    }
  },
  {
    definition: {
      name: "session_status",
      description: "Read the lens-maintained status for a session on a selected opencode instance.",
      inputSchema: sessionInputSchema()
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/status`);
    }
  },
  {
    definition: {
      name: "tui_status",
      description: "Read the live TUI-oriented status for one opencode instance, including current/recent session, whether user input is needed, and pending permission/error information.",
      inputSchema: instanceInputSchema()
    },
    async call(input) {
      const { instance } = await resolveInstance(input);
      return requestUnixJson(instance.socket, "/tui/status");
    }
  },
  {
    definition: {
      name: "models_list",
      description: "List the opencode runtime providers/models visible to a selected opencode instance.",
      inputSchema: instanceInputSchema()
    },
    async call(input) {
      const { instance } = await resolveInstance(input);
      return requestUnixJson(instance.socket, "/models");
    }
  },
  {
    definition: {
      name: "model_switch",
      description: "Set the session's config model for an instance (this controls which model future default-model messages use). NOTE: this does NOT move the TUI's visible model indicator -- no plugin API can set the indicator to a specific model by ID, so the response always has display_updated:false. Returns model_switch_unavailable only when no config-update mechanism is exposed. In opencode 1.17.x the model is per-message; to run one prompt on a specific model use prompt_send with providerID+modelID. To let the user change the visible indicator, use model_selector_open.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "session", "providerID", "modelID"],
        properties: {
          instance: { type: "string" },
          session: { type: "string" },
          providerID: { type: "string" },
          modelID: { type: "string" },
          variant: { type: "string" }
        }
      }
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      const result = await requestUnixJsonResult(instance.socket, `/session/${encodeURIComponent(session)}/model`, {
        method: "POST",
        timeoutMs: 2500,
        body: {
          providerID: requiredString(args, "providerID"),
          modelID: requiredString(args, "modelID"),
          ...typeof args.variant === "string" && args.variant.length > 0 ? { variant: args.variant } : {}
        }
      });
      if (result.ok)
        return result.data;
      return { ok: false, error: result.error, status: result.status, details: result.body };
    }
  },
  {
    definition: {
      name: "model_selector_open",
      description: "Open the visible opencode TUI model selector for a selected instance when direct runtime model switching is unavailable.",
      inputSchema: instanceInputSchema()
    },
    async call(input) {
      const { instance } = await resolveInstance(input);
      const result = await requestUnixJsonResult(instance.socket, "/tui/models", { method: "POST" });
      if (result.ok)
        return result.data;
      return { ok: false, error: result.error, status: result.status, details: result.body };
    }
  },
  {
    definition: {
      name: "model_selector_close",
      description: "Close the currently open opencode TUI dialog/overlay for a selected instance, including a mistakenly opened model selector. Returns ok:false if the plugin runtime does not expose dialog.clear.",
      inputSchema: instanceInputSchema()
    },
    async call(input) {
      const { instance } = await resolveInstance(input);
      const result = await requestUnixJsonResult(instance.socket, "/tui/overlay/close", { method: "POST" });
      if (result.ok)
        return result.data;
      return { ok: false, error: result.error, status: result.status, details: result.body };
    }
  },
  {
    definition: {
      name: "messages_read",
      description: "Read recent session messages with tool outputs summarized by opencode-lens.",
      inputSchema: {
        ...sessionInputSchema(),
        properties: { ...sessionInputSchema().properties, limit: { type: "integer", minimum: 1, maximum: 100 } }
      }
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      const limit = optionalInteger(args, "limit");
      const query = limit ? `?limit=${limit}` : "";
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/messages${query}`);
    }
  },
  {
    definition: {
      name: "prompt_send",
      description: "Send a prompt to an opencode instance. API mode targets a session in the background; API-with-switch also makes the TUI show that session; TUI mode submits to the visible TUI prompt. Optionally set providerID+modelID (and variant) to run this prompt with a specific model (the supported way to choose a model in opencode 1.17.x, since model is per-message).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "text"],
        properties: {
          instance: { type: "string" },
          session: { type: "string" },
          text: { type: "string", minLength: 1 },
          mode: { enum: ["api", "tui"], default: "api" },
          switch_tui: { type: "boolean", default: false },
          force: { type: "boolean", default: false },
          providerID: { type: "string" },
          modelID: { type: "string" },
          variant: { type: "string" }
        }
      }
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const text = requiredString(args, "text");
      const mode = args.mode === "tui" ? "tui" : "api";
      if (mode === "tui") {
        return requestUnixJson(instance.socket, "/tui/prompt", { method: "POST", body: { text } });
      }
      const session = requiredString(args, "session");
      const model = typeof args.providerID === "string" && typeof args.modelID === "string" ? { providerID: args.providerID, modelID: args.modelID } : {};
      const variant = typeof args.variant === "string" ? { variant: args.variant } : {};
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/prompt`, {
        method: "POST",
        body: { text, switch_tui: args.switch_tui === true, force: args.force === true, ...model, ...variant }
      });
    }
  },
  {
    definition: {
      name: "session_create",
      description: "Create a new session on a selected opencode instance. Optionally set title, agent, and an initial providerID+modelID (and variant). Pass switch_tui: true to also make the new session the visible session in that instance's TUI. Returns the new session_id, which you can then target with prompt_send.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance"],
        properties: {
          instance: { type: "string" },
          title: { type: "string" },
          agent: { type: "string" },
          parentID: { type: "string" },
          providerID: { type: "string" },
          modelID: { type: "string" },
          variant: { type: "string" },
          switch_tui: { type: "boolean" }
        }
      }
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const model = typeof args.providerID === "string" && typeof args.modelID === "string" ? { providerID: args.providerID, modelID: args.modelID } : {};
      const optional = (key) => typeof args[key] === "string" ? { [key]: args[key] } : {};
      return requestUnixJson(instance.socket, "/session", {
        method: "POST",
        body: {
          ...optional("title"),
          ...optional("agent"),
          ...optional("parentID"),
          ...optional("variant"),
          ...model,
          ...args.switch_tui === true ? { switch_tui: true } : {}
        }
      });
    }
  },
  {
    definition: {
      name: "tui_session_switch",
      description: "Switch the visible opencode TUI to a specific session without sending any prompt text.",
      inputSchema: sessionInputSchema()
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, "/tui/session", { method: "POST", body: { session } });
    }
  },
  {
    definition: {
      name: "diff_get",
      description: "Read the current diff for a session on a selected opencode instance.",
      inputSchema: sessionInputSchema()
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/diff`);
    }
  },
  {
    definition: {
      name: "todo_get",
      description: "Read the current todo list for a session on a selected opencode instance.",
      inputSchema: sessionInputSchema()
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/todo`);
    }
  },
  {
    definition: {
      name: "session_abort",
      description: "High-risk operation: abort a running opencode session. Only use when the user explicitly asks to stop or abort that session.",
      inputSchema: sessionInputSchema()
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/abort`, { method: "POST" });
    }
  },
  {
    definition: {
      name: "permission_respond",
      description: 'High-risk operation: approve or deny an opencode permission request. Only use when the user explicitly instructs you to allow or deny that request. response: "allow" approves once, "always" approves and remembers, "deny" rejects.',
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "session", "permission_id", "response"],
        properties: {
          instance: { type: "string" },
          session: { type: "string" },
          permission_id: { type: "string" },
          response: { enum: ["allow", "always", "deny"] }
        }
      }
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      const permissionID = requiredString(args, "permission_id");
      const response = args.response === "allow" ? "allow" : args.response === "always" ? "always" : args.response === "deny" ? "deny" : undefined;
      if (!response)
        throw new Error("response must be allow, always, or deny");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/permissions/${encodeURIComponent(permissionID)}`, { method: "POST", body: { response } });
    }
  },
  {
    definition: {
      name: "question_respond",
      description: "Answer an opencode interactive 'ask question' prompt (the agent asking the user to pick from options). This is SEPARATE from permission_respond. Get request_id and the valid option labels from tui_status (status.question). For a single-question prompt pass `answer` (one option label, or an array of labels if multiple-select). For multiple questions pass `answers` as an array (one entry per question; each entry is an array of selected labels). Use the exact option label text. Only answer when the user has told you which option to pick (or use question_reject to decline).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "request_id"],
        properties: {
          instance: { type: "string" },
          request_id: { type: "string" },
          answer: {
            description: "Convenience for a single-question prompt: an option label, or an array of labels for multi-select.",
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }]
          },
          answers: {
            description: "For multi-question prompts: an array with one entry per question, each entry an array of selected option labels.",
            type: "array",
            items: { type: "array", items: { type: "string" } }
          }
        }
      }
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const requestID = requiredString(args, "request_id");
      const body = {};
      if (args.answers !== undefined)
        body.answers = args.answers;
      else if (args.answer !== undefined)
        body.answer = args.answer;
      else
        throw new Error("provide answer (single question) or answers (multiple questions)");
      return requestUnixJson(instance.socket, `/question/${encodeURIComponent(requestID)}/reply`, { method: "POST", body });
    }
  },
  {
    definition: {
      name: "question_reject",
      description: "High-risk operation: reject/decline an opencode interactive 'ask question' prompt without answering. Get request_id from tui_status (status.question). Only use when the user explicitly wants to dismiss the question.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "request_id"],
        properties: {
          instance: { type: "string" },
          request_id: { type: "string" }
        }
      }
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const requestID = requiredString(args, "request_id");
      return requestUnixJson(instance.socket, `/question/${encodeURIComponent(requestID)}/reject`, { method: "POST", body: {} });
    }
  },
  {
    definition: {
      name: "events_wait",
      description: "Wait for lens events across all active opencode instances. Returns immediately when an event arrives or when timeout_ms elapses.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          timeout_ms: { type: "integer", minimum: 1, maximum: 60000, default: 30000 },
          instance: { type: "string" },
          session: { type: "string" },
          event_names: { type: "array", items: { type: "string" } },
          cursor: {
            type: "object",
            additionalProperties: true
          }
        }
      }
    },
    async call(input) {
      const args = optionalRecord(input);
      const timeoutMs = optionalInteger(args, "timeout_ms") ?? 30000;
      const cursor = getCursor(args.cursor);
      const discovered = await discoverInstances({
        async probe(instance) {
          return requestUnixJson(instance.socket, "/health");
        }
      });
      const requestedInstance = typeof args.instance === "string" ? args.instance : undefined;
      const instances = requestedInstance ? discovered.active.filter((instance) => instance.id === requestedInstance || String(instance.pid) === requestedInstance) : discovered.active;
      return waitForEvents(instances, cursor, timeoutMs, {
        session: typeof args.session === "string" ? args.session : undefined,
        event_names: getStringArray(args.event_names)
      });
    }
  }
];
function instanceInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["instance"],
    properties: {
      instance: { type: "string" }
    }
  };
}
function sessionInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["instance", "session"],
    properties: {
      instance: { type: "string" },
      session: { type: "string" }
    }
  };
}
async function resolveInstance(input) {
  const args = asRecord(input);
  const requested = requiredString(args, "instance");
  const discovered = await discoverInstances({
    async probe(instance2) {
      return requestUnixJson(instance2.socket, "/health");
    }
  });
  const instance = discovered.active.find((candidate) => candidate.id === requested || String(candidate.pid) === requested);
  if (!instance) {
    throw new Error(`instance ${requested} is unreachable; active instances: ${discovered.active.map((candidate) => candidate.id).join(", ") || "none"}`);
  }
  return { instance, args };
}
function asRecord(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("tool arguments must be an object");
  return input;
}
function requiredString(input, key) {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${key} is required`);
  return value;
}
function optionalInteger(input, key) {
  const value = input[key];
  if (value === undefined)
    return;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error(`${key} must be a positive integer`);
  return value;
}
function optionalRecord(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
}
function getCursor(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return {};
  const cursor = input;
  if (typeof cursor.instances !== "object" || cursor.instances === null || Array.isArray(cursor.instances))
    return {};
  const instances = {};
  for (const [key, value] of Object.entries(cursor.instances)) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0)
      instances[key] = value;
  }
  return { instances };
}
function getStringArray(input) {
  if (!Array.isArray(input))
    return;
  const values = input.filter((value) => typeof value === "string" && value.length > 0);
  return values.length > 0 ? values : undefined;
}

// src/server.ts
function createServer() {
  return new McpServer;
}

class McpServer {
  async run() {
    let buffer = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        const frame = readFrame(buffer);
        if (!frame)
          break;
        buffer = frame.rest;
        await this.handleMessage(frame.body, frame.style);
      }
    }
  }
  async handleMessage(body, style) {
    const request = parseRequest(body);
    if (!request)
      return;
    if (request.id === undefined) {
      await this.handleNotification(request);
      return;
    }
    const response = await this.dispatch(request);
    writeMessage(response, style);
  }
  async handleNotification(_request) {
    return;
  }
  async dispatch(request) {
    try {
      if (request.method === "initialize") {
        return result(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-lens-mcp", version: LENS_VERSION }
        });
      }
      if (request.method === "tools/list") {
        return result(request.id, { tools: tools.map((tool) => tool.definition) });
      }
      if (request.method === "tools/call") {
        const params = asRecord2(request.params);
        const name = typeof params?.name === "string" ? params.name : undefined;
        const tool = tools.find((candidate) => candidate.definition.name === name);
        if (!tool)
          return failure(request.id, -32602, `unknown tool: ${name ?? "<missing>"}`);
        const output = await tool.call(params?.arguments ?? {});
        return result(request.id, { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] });
      }
      return failure(request.id, -32601, `method not found: ${request.method}`);
    } catch (error) {
      return failure(request.id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
}
function readFrame(buffer) {
  const firstByte = firstNonWhitespaceByte(buffer);
  if (firstByte === 123 || firstByte === 91) {
    const lineEnd = buffer.indexOf(`
`);
    if (lineEnd < 0)
      return;
    const end = lineEnd > 0 && buffer[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
    return {
      body: buffer.subarray(0, end).toString("utf8"),
      rest: buffer.subarray(lineEnd + 1),
      style: "json-line"
    };
  }
  const headerInfo = findHeaderEnd(buffer);
  if (!headerInfo)
    return;
  const header = buffer.subarray(0, headerInfo.index).toString("utf8");
  const length = contentLength(header);
  if (length === undefined)
    return;
  const bodyStart = headerInfo.index + headerInfo.length;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd)
    return;
  return {
    body: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
    rest: buffer.subarray(bodyEnd),
    style: "content-length"
  };
}
function firstNonWhitespaceByte(buffer) {
  for (const byte of buffer) {
    if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13)
      return byte;
  }
  return;
}
function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf(`\r
\r
`);
  const lf = buffer.indexOf(`

`);
  if (crlf < 0 && lf < 0)
    return;
  if (crlf >= 0 && (lf < 0 || crlf < lf))
    return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}
function contentLength(header) {
  for (const line of header.split(`\r
`)) {
    const [name, value] = line.split(":", 2);
    if (name?.toLowerCase() !== "content-length")
      continue;
    const length = Number(value?.trim());
    return Number.isInteger(length) && length >= 0 ? length : undefined;
  }
  return;
}
function parseRequest(body) {
  try {
    const input = JSON.parse(body);
    if (!input || input.jsonrpc !== "2.0" || typeof input.method !== "string")
      return;
    return input;
  } catch {
    return;
  }
}
function writeMessage(message, style) {
  const body = JSON.stringify(message);
  if (style === "json-line") {
    process.stdout.write(`${body}
`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r
\r
${body}`);
}
function result(id, value) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}
function failure(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function asRecord2(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
}

// src/index.ts
async function main() {
  await createServer().run();
}
if (__require.main == __require.module) {
  await main();
}
export {
  main
};
