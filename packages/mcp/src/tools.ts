import { discoverInstances, type ActiveInstance, type LensHealth, type SessionSummary } from "@opencode-lens/shared";

import { requestUnixJson, requestUnixJsonResult } from "./lens-http";
import { waitForEvents, type EventsCursor } from "./sse";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpTool {
  definition: McpToolDefinition;
  call(input: unknown): Promise<unknown>;
}

export const tools: McpTool[] = [
  {
    definition: {
      name: "instances_list",
      description: "List active local opencode-lens instances and their session summaries. Dead registry entries are cleaned during discovery.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    async call() {
      const discovered = await discoverInstances({
        async probe(instance) {
          return requestUnixJson<LensHealth>(instance.socket, "/health");
        },
      });

      const instances = await Promise.all(
        discovered.active.map(async (instance) => {
          try {
            const sessions = await requestUnixJson<SessionSummary[]>(instance.socket, "/sessions");
            return { ...instance, sessions };
          } catch (error) {
            return {
              ...instance,
              sessions: [],
              sessions_error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      return {
        instances,
        removed: discovered.removed,
        errors: discovered.errors,
      };
    },
  },
  {
    definition: {
      name: "session_status",
      description: "Read the lens-maintained status for a session on a selected opencode instance.",
      inputSchema: sessionInputSchema(),
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/status`);
    },
  },
  {
    definition: {
      name: "tui_status",
      description:
        "Read the live TUI-oriented status for one opencode instance, including current/recent session, whether user input is needed, and pending permission/error information.",
      inputSchema: instanceInputSchema(),
    },
    async call(input) {
      const { instance } = await resolveInstance(input);
      return requestUnixJson(instance.socket, "/tui/status");
    },
  },
  {
    definition: {
      name: "models_list",
      description: "List the opencode runtime providers/models visible to a selected opencode instance.",
      inputSchema: instanceInputSchema(),
    },
    async call(input) {
      const { instance } = await resolveInstance(input);
      return requestUnixJson(instance.socket, "/models");
    },
  },
  {
    definition: {
      name: "model_switch",
      description:
        "Set the session's config model for an instance (this controls which model future default-model messages use). NOTE: this does NOT move the TUI's visible model indicator -- no plugin API can set the indicator to a specific model by ID, so the response always has display_updated:false. Returns model_switch_unavailable only when no config-update mechanism is exposed. In opencode 1.17.x the model is per-message; to run one prompt on a specific model use prompt_send with providerID+modelID. To let the user change the visible indicator, use model_selector_open.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "session", "providerID", "modelID"],
        properties: {
          instance: { type: "string" },
          session: { type: "string" },
          providerID: { type: "string" },
          modelID: { type: "string" },
          variant: { type: "string" },
        },
      },
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      const result = await requestUnixJsonResult(instance.socket, `/session/${encodeURIComponent(session)}/model`, {
        method: "POST",
        timeoutMs: 2_500,
        body: {
          providerID: requiredString(args, "providerID"),
          modelID: requiredString(args, "modelID"),
          ...(typeof args.variant === "string" && args.variant.length > 0 ? { variant: args.variant } : {}),
        },
      });
      if (result.ok) return result.data;
      return { ok: false, error: result.error, status: result.status, details: result.body };
    },
  },
  {
    definition: {
      name: "model_selector_open",
      description: "Open the visible opencode TUI model selector for a selected instance when direct runtime model switching is unavailable.",
      inputSchema: instanceInputSchema(),
    },
    async call(input) {
      const { instance } = await resolveInstance(input);
      const result = await requestUnixJsonResult(instance.socket, "/tui/models", { method: "POST" });
      if (result.ok) return result.data;
      return { ok: false, error: result.error, status: result.status, details: result.body };
    },
  },
  {
    definition: {
      name: "model_selector_close",
      description:
        "Close the currently open opencode TUI dialog/overlay for a selected instance, including a mistakenly opened model selector. Returns ok:false if the plugin runtime does not expose dialog.clear.",
      inputSchema: instanceInputSchema(),
    },
    async call(input) {
      const { instance } = await resolveInstance(input);
      const result = await requestUnixJsonResult(instance.socket, "/tui/overlay/close", { method: "POST" });
      if (result.ok) return result.data;
      return { ok: false, error: result.error, status: result.status, details: result.body };
    },
  },
  {
    definition: {
      name: "messages_read",
      description: "Read recent session messages with tool outputs summarized by opencode-lens.",
      inputSchema: {
        ...sessionInputSchema(),
        properties: { ...sessionInputSchema().properties, limit: { type: "integer", minimum: 1, maximum: 100 } },
      },
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      const limit = optionalInteger(args, "limit");
      const query = limit ? `?limit=${limit}` : "";
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/messages${query}`);
    },
  },
  {
    definition: {
      name: "prompt_send",
      description:
        "Send a prompt to an opencode instance. API mode targets a session in the background; API-with-switch also makes the TUI show that session; TUI mode submits to the visible TUI prompt. Optionally set providerID+modelID (and variant) to run this prompt with a specific model (the supported way to choose a model in opencode 1.17.x, since model is per-message).",
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
          variant: { type: "string" },
        },
      },
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const text = requiredString(args, "text");
      const mode = args.mode === "tui" ? "tui" : "api";
      if (mode === "tui") {
        return requestUnixJson(instance.socket, "/tui/prompt", { method: "POST", body: { text } });
      }
      const session = requiredString(args, "session");
      const model =
        typeof args.providerID === "string" && typeof args.modelID === "string"
          ? { providerID: args.providerID, modelID: args.modelID }
          : {};
      const variant = typeof args.variant === "string" ? { variant: args.variant } : {};
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/prompt`, {
        method: "POST",
        body: { text, switch_tui: args.switch_tui === true, force: args.force === true, ...model, ...variant },
      });
    },
  },
  {
    definition: {
      name: "session_create",
      description:
        "Create a new session on a selected opencode instance. Optionally set title, agent, and an initial providerID+modelID (and variant). Pass switch_tui: true to also make the new session the visible session in that instance's TUI. Returns the new session_id, which you can then target with prompt_send.",
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
          switch_tui: { type: "boolean" },
        },
      },
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const model =
        typeof args.providerID === "string" && typeof args.modelID === "string"
          ? { providerID: args.providerID, modelID: args.modelID }
          : {};
      const optional = (key: string) => (typeof args[key] === "string" ? { [key]: args[key] } : {});
      return requestUnixJson(instance.socket, "/session", {
        method: "POST",
        body: {
          ...optional("title"),
          ...optional("agent"),
          ...optional("parentID"),
          ...optional("variant"),
          ...model,
          ...(args.switch_tui === true ? { switch_tui: true } : {}),
        },
      });
    },
  },
  {
    definition: {
      name: "tui_session_switch",
      description: "Switch the visible opencode TUI to a specific session without sending any prompt text.",
      inputSchema: sessionInputSchema(),
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, "/tui/session", { method: "POST", body: { session } });
    },
  },
  {
    definition: {
      name: "diff_get",
      description: "Read the current diff for a session on a selected opencode instance.",
      inputSchema: sessionInputSchema(),
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/diff`);
    },
  },
  {
    definition: {
      name: "todo_get",
      description: "Read the current todo list for a session on a selected opencode instance.",
      inputSchema: sessionInputSchema(),
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/todo`);
    },
  },
  {
    definition: {
      name: "session_abort",
      description:
        "High-risk operation: abort a running opencode session. Only use when the user explicitly asks to stop or abort that session.",
      inputSchema: sessionInputSchema(),
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      return requestUnixJson(instance.socket, `/session/${encodeURIComponent(session)}/abort`, { method: "POST" });
    },
  },
  {
    definition: {
      name: "permission_respond",
      description:
        "High-risk operation: approve or deny an opencode permission request. Only use when the user explicitly instructs you to allow or deny that request. response: \"allow\" approves once, \"always\" approves and remembers, \"deny\" rejects.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "session", "permission_id", "response"],
        properties: {
          instance: { type: "string" },
          session: { type: "string" },
          permission_id: { type: "string" },
          response: { enum: ["allow", "always", "deny"] },
        },
      },
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const session = requiredString(args, "session");
      const permissionID = requiredString(args, "permission_id");
      const response =
        args.response === "allow"
          ? "allow"
          : args.response === "always"
            ? "always"
            : args.response === "deny"
              ? "deny"
              : undefined;
      if (!response) throw new Error("response must be allow, always, or deny");
      return requestUnixJson(
        instance.socket,
        `/session/${encodeURIComponent(session)}/permissions/${encodeURIComponent(permissionID)}`,
        { method: "POST", body: { response } },
      );
    },
  },
  {
    definition: {
      name: "question_respond",
      description:
        "Answer an opencode interactive 'ask question' prompt (the agent asking the user to pick from options). This is SEPARATE from permission_respond. Get request_id and the valid option labels from tui_status (status.question). For a single-question prompt pass `answer` (one option label, or an array of labels if multiple-select). For multiple questions pass `answers` as an array (one entry per question; each entry is an array of selected labels). Use the exact option label text. Only answer when the user has told you which option to pick (or use question_reject to decline).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "request_id"],
        properties: {
          instance: { type: "string" },
          request_id: { type: "string" },
          answer: {
            description: "Convenience for a single-question prompt: an option label, or an array of labels for multi-select.",
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          answers: {
            description: "For multi-question prompts: an array with one entry per question, each entry an array of selected option labels.",
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const requestID = requiredString(args, "request_id");
      const body: Record<string, unknown> = {};
      if (args.answers !== undefined) body.answers = args.answers;
      else if (args.answer !== undefined) body.answer = args.answer;
      else throw new Error("provide answer (single question) or answers (multiple questions)");
      return requestUnixJson(
        instance.socket,
        `/question/${encodeURIComponent(requestID)}/reply`,
        { method: "POST", body },
      );
    },
  },
  {
    definition: {
      name: "question_reject",
      description:
        "High-risk operation: reject/decline an opencode interactive 'ask question' prompt without answering. Get request_id from tui_status (status.question). Only use when the user explicitly wants to dismiss the question.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["instance", "request_id"],
        properties: {
          instance: { type: "string" },
          request_id: { type: "string" },
        },
      },
    },
    async call(input) {
      const { instance, args } = await resolveInstance(input);
      const requestID = requiredString(args, "request_id");
      return requestUnixJson(
        instance.socket,
        `/question/${encodeURIComponent(requestID)}/reject`,
        { method: "POST", body: {} },
      );
    },
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
            additionalProperties: true,
          },
        },
      },
    },
    async call(input) {
      const args = optionalRecord(input);
      const timeoutMs = optionalInteger(args, "timeout_ms") ?? 30_000;
      const cursor = getCursor(args.cursor);
      const discovered = await discoverInstances({
        async probe(instance) {
          return requestUnixJson<LensHealth>(instance.socket, "/health");
        },
      });
      const requestedInstance = typeof args.instance === "string" ? args.instance : undefined;
      const instances = requestedInstance
        ? discovered.active.filter((instance) => instance.id === requestedInstance || String(instance.pid) === requestedInstance)
        : discovered.active;
      return waitForEvents(instances, cursor, timeoutMs, {
        session: typeof args.session === "string" ? args.session : undefined,
        event_names: getStringArray(args.event_names),
      });
    },
  },
];

function instanceInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["instance"],
    properties: {
      instance: { type: "string" },
    },
  };
}

function sessionInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["instance", "session"],
    properties: {
      instance: { type: "string" },
      session: { type: "string" },
    },
  };
}

async function resolveInstance(input: unknown): Promise<{ instance: ActiveInstance; args: Record<string, unknown> }> {
  const args = asRecord(input);
  const requested = requiredString(args, "instance");
  const discovered = await discoverInstances({
    async probe(instance) {
      return requestUnixJson<LensHealth>(instance.socket, "/health");
    },
  });

  const instance = discovered.active.find((candidate) => candidate.id === requested || String(candidate.pid) === requested);
  if (!instance) {
    throw new Error(
      `instance ${requested} is unreachable; active instances: ${discovered.active.map((candidate) => candidate.id).join(", ") || "none"}`,
    );
  }

  return { instance, args };
}

function asRecord(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("tool arguments must be an object");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function optionalInteger(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function optionalRecord(input: unknown) {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function getCursor(input: unknown): EventsCursor {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const cursor = input as Record<string, unknown>;
  if (typeof cursor.instances !== "object" || cursor.instances === null || Array.isArray(cursor.instances)) return {};
  const instances: Record<string, number> = {};
  for (const [key, value] of Object.entries(cursor.instances as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) instances[key] = value;
  }
  return { instances };
}

function getStringArray(input: unknown) {
  if (!Array.isArray(input)) return undefined;
  const values = input.filter((value): value is string => typeof value === "string" && value.length > 0);
  return values.length > 0 ? values : undefined;
}
