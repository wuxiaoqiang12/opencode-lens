import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname } from "node:path";

import {
  LENS_VERSION,
  type LensCapability,
  type LensHealth,
  type RegisteredInstance,
  type SessionSummary,
  type SessionStatus,
  type TuiStatus,
  type PendingQuestion,
  type PendingQuestionItem,
  getLensDataDir,
  getLensRuntimeDir,
  getInstanceRegistryPath,
  getInstancesDir,
  getSocketPath,
} from "@opencode-lens/shared";

import { EventHub } from "./events";
import { readPersistedMessages } from "./persistence";
import { SessionStateMachine, attachSessionStateEvents } from "./state";

interface TuiApi {
  app?: { version?: string };
  directory?: string;
  worktree?: string;
  project?: { id?: string };
  client?: LensClient;
  state?: {
    provider?: unknown[];
    config?: unknown;
    session?: {
      get?(sessionID: string): unknown;
      status?(sessionID: string): unknown;
      messages?(sessionID: string): unknown[];
      diff?(sessionID: string): unknown[];
      todo?(sessionID: string): unknown[];
      permission?(sessionID: string): unknown[];
      question?(sessionID: string): unknown[];
    };
  };
  route?: {
    current?: { name?: string; params?: Record<string, unknown> };
    navigate?(name: string, params?: Record<string, unknown>): void;
  };
  keymap?: {
    dispatchCommand?(name: string): unknown | Promise<unknown>;
    runCommand?(name: string): unknown | Promise<unknown>;
  };
  ui?: {
    dialog?: {
      clear?(): unknown | Promise<unknown>;
    };
  };
  lifecycle?: { onDispose?: (dispose: () => void) => void };
  setSessionConfigOption?(input: { sessionId: string; configId: string; value: string }): Promise<ApiResponse<unknown>>;
  unstable_setSessionModel?(input: { sessionId: string; modelId: string }): Promise<ApiResponse<unknown>>;
}

// The opencode SDK (v2 `buildClientParams`) takes flattened top-level arguments
// and maps each known key into the path/query/body of the request itself.
interface LensClient {
  session?: {
    list?(input: { limit?: number }): Promise<ApiResponse<unknown[]>>;
    get?(input: { sessionID: string }): Promise<ApiResponse<unknown>>;
    create?(input: {
      title?: string;
      agent?: string;
      parentID?: string;
      model?: { providerID: string; id: string; variant?: string };
    }): Promise<ApiResponse<unknown>>;
    messages?(input: { sessionID: string; limit?: number }): Promise<ApiResponse<unknown[]>>;
    diff?(input: { sessionID: string; messageID?: string }): Promise<ApiResponse<unknown>>;
    todo?(input: { sessionID: string }): Promise<ApiResponse<unknown>>;
    promptAsync?(input: { sessionID: string; parts: PromptPart[]; model?: PromptModel; noReply?: boolean; variant?: string }): Promise<ApiResponse<unknown>>;
    prompt?(input: { sessionID: string; parts: PromptPart[]; noReply?: boolean; model?: PromptModel; variant?: string }): Promise<ApiResponse<unknown>>;
    abort?(input: { sessionID: string }): Promise<ApiResponse<unknown>>;
    setModel?(input: { sessionID: string; providerID: string; modelID: string; variant?: string }): Promise<ApiResponse<unknown>>;
    setConfigOption?(input: { sessionID: string; configID: string; value: string }): Promise<ApiResponse<unknown>>;
    setSessionConfigOption?(input: { sessionId: string; configId: string; value: string }): Promise<ApiResponse<unknown>>;
    unstable_setSessionModel?(input: { sessionId: string; modelId: string }): Promise<ApiResponse<unknown>>;
  };
  tui?: {
    appendPrompt?(input: { body: { text: string } }): Promise<ApiResponse<unknown>>;
    submitPrompt?(): Promise<ApiResponse<unknown>>;
    openModels?(input?: { query?: { directory?: string } }): Promise<ApiResponse<unknown>>;
    selectSession?(input: { sessionID: string }): Promise<ApiResponse<unknown>>;
    executeCommand?(input: { body: { command: string } }): Promise<ApiResponse<unknown>>;
  };
  permission?: {
    reply?(input: { requestID: string; reply: "once" | "always" | "reject"; message?: string }): Promise<ApiResponse<unknown>>;
    respond?(input: { sessionID: string; permissionID: string; response: "once" | "always" | "reject" }): Promise<ApiResponse<unknown>>;
  };
  question?: {
    reply?(input: { requestID: string; answers: string[][] }): Promise<ApiResponse<unknown>>;
    reject?(input: { requestID: string }): Promise<ApiResponse<unknown>>;
  };
}

interface PromptPart {
  type: "text";
  text: string;
}

interface PromptModel {
  providerID: string;
  modelID: string;
}

interface ApiResponse<T> {
  data?: T;
  error?: unknown;
  response?: { status?: number };
}

export interface LensRuntime {
  socketPath: string;
  registryPath: string;
  server: Server;
  state: SessionStateMachine;
  events: EventHub;
  cleanup(): Promise<void>;
  cleanupSync(): void;
}

type Server = ReturnType<typeof Bun.serve>;

const startedAt = Date.now();

// Upper bound for any single upstream opencode SDK call made while serving a
// request. If the opencode server stalls (observed: session.list hanging ~12s
// on a busy instance), we surface a bounded 504 instead of letting Bun's
// idleTimeout fire and return its generic "request timed out" body. Overridable
// via env so tests can drive the timeout path without waiting the full window.
function getSdkCallTimeoutMs() {
  const raw = Number(process.env.OPENCODE_LENS_SDK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
}

export async function startLens(input: unknown): Promise<LensRuntime> {
  const api = normalizeApi(input);
  const socketPath = getSocketPath();
  const registryPath = getInstanceRegistryPath();

  await ensurePrivateDir(getLensDataDir());
  await ensurePrivateDir(getInstancesDir());
  await ensurePrivateDir(getLensRuntimeDir());
  await rm(socketPath, { force: true });

  const health = createHealth(api);
  const state = new SessionStateMachine();
  const events = new EventHub(100);
  const eventDisposers = attachSessionStateEvents(input, state, (type, data) => events.publish(type, data));
  // idleTimeout is valid at runtime for unix sockets; the bundled Bun types
  // declare it as `undefined` on the unix overload, so build the options object
  // separately and cast through unknown to keep typecheck happy.
  const serveOptions = {
    unix: socketPath,
    // Bun's default idleTimeout is 10s. The lens caps every upstream SDK call
    // with its own withTimeout (<=8s), so the handler always resolves first and
    // returns a structured JSON error. Raise the server ceiling above those caps
    // so Bun never pre-empts our own response with its generic "request timed
    // out" body (which surfaced to MCP clients as a confusing 10s timeout).
    idleTimeout: 30,
    fetch(request: Request) {
      return handleRequest(request, { api, health, state, events });
    },
  } as unknown as Parameters<typeof Bun.serve>[0];
  const server = Bun.serve(serveOptions);

  const runtime: LensRuntime = {
    socketPath,
    registryPath,
    server,
    state,
    events,
    async cleanup() {
      disposeEvents(eventDisposers);
      server.stop(true);
      await Promise.all([rm(socketPath, { force: true }), rm(registryPath, { force: true })]);
    },
    cleanupSync() {
      disposeEvents(eventDisposers);
      server.stop(true);
      rmSync(socketPath, { force: true });
      rmSync(registryPath, { force: true });
    },
  };

  await writeRegistryFile(registryPath, socketPath, api);
  registerCleanup(runtime);
  api.lifecycle?.onDispose?.(() => runtime.cleanupSync());

  return runtime;
}

async function handleRequest(
  request: Request,
  context: { api: TuiApi; health: LensHealth; state: SessionStateMachine; events: EventHub },
) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ...context.health, uptime_ms: Date.now() - startedAt });
  }

  if (request.method === "GET" && url.pathname === "/events") {
    return context.events.stream(getLastEventID(request));
  }

  if (request.method === "GET" && url.pathname === "/tui/status") {
    return withSdkError(async () => json(await buildTuiStatus(context)));
  }

  if (request.method === "GET" && url.pathname === "/models") {
    return json({ providers: summarizeProviders(context.api.state?.provider) });
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    return withSdkError(async () => {
      return json(await listSessionSummaries(context, getLimit(url)));
    });
  }

  const sessionMatch = matchSessionRoute(url.pathname);
  // opencode's SDK (`@opencode-ai/sdk` v2 `buildClientParams`) takes FLATTENED
  // top-level arguments and maps each known key into path/query/body itself. So
  // session methods expect `{ sessionID, parts, model, ... }`, NOT `{ path, body }`.
  // Passing `{ path: { ... } }` leaves the URL placeholder "{sessionID}"
  // unsubstituted and the server returns a generic 500 (previously seen as a
  // ~12s hang / false success on non-current sessions).
  const sessionID = sessionMatch?.sessionID;

  if (request.method === "GET" && sessionMatch?.tail.length === 0) {
    return withSdkError(async () => {
      const stateSession = context.api.state?.session?.get?.(sessionMatch.sessionID);
      if (stateSession) return json(stateSession);
      const session = await withTimeout<ApiResponse<unknown>>(
        bindMethod(context.api.client?.session, "get", "session.get")({
          sessionID: sessionMatch.sessionID,
        }),
        getSdkCallTimeoutMs(),
        "session_get_timeout",
      );
      return json(unwrapData(session));
    });
  }

  if (request.method === "GET" && sessionMatch?.tail[0] === "status") {
    return json(context.state.get(sessionMatch.sessionID));
  }

  if (request.method === "GET" && sessionMatch?.tail[0] === "messages") {
    return withSdkError(async () => {
      const limit = getLimit(url);
      const stateMessages = context.api.state?.session?.messages?.(sessionMatch.sessionID);
      const summarizedStateMessages = Array.isArray(stateMessages) ? stateMessages.map(summarizeMessage) : undefined;
      if (summarizedStateMessages && hasUsableMessageParts(summarizedStateMessages)) return json(summarizedStateMessages);

      const persistedMessages = readPersistedMessages(sessionMatch.sessionID, limit);
      if (persistedMessages && persistedMessages.length > 0) return json(persistedMessages.map(summarizeMessage));

      const sdkMessages = await readSdkMessages(context.api, sessionMatch.sessionID, limit);
      const summarizedSdkMessages = sdkMessages.map(summarizeMessage);
      if (hasUsableMessageParts(summarizedSdkMessages)) return json(summarizedSdkMessages);

      if (persistedMessages) return json([]);

      if (summarizedStateMessages) return json(summarizedStateMessages);
      return json(summarizedSdkMessages);
    });
  }

  if (request.method === "GET" && sessionMatch?.tail[0] === "diff") {
    return withSdkError(async () => {
      const stateDiff = context.api.state?.session?.diff?.(sessionMatch.sessionID);
      if (Array.isArray(stateDiff)) return json(stateDiff);
      const diff = await withTimeout<ApiResponse<unknown>>(
        bindMethod(context.api.client?.session, "diff", "session.diff")({
          sessionID: sessionMatch.sessionID,
          ...(url.searchParams.get("messageID") ? { messageID: url.searchParams.get("messageID")! } : {}),
        }),
        getSdkCallTimeoutMs(),
        "session_diff_timeout",
      );
      return json(unwrapData(diff));
    });
  }

  if (request.method === "GET" && sessionMatch?.tail[0] === "todo") {
    return withSdkError(async () => {
      const stateTodo = context.api.state?.session?.todo?.(sessionMatch.sessionID);
      if (Array.isArray(stateTodo)) return json(stateTodo);
      const todo = await withTimeout<ApiResponse<unknown>>(
        bindMethod(context.api.client?.session, "todo", "session.todo")({
          sessionID: sessionMatch.sessionID,
        }),
        getSdkCallTimeoutMs(),
        "session_todo_timeout",
      );
      return json(unwrapData(todo));
    });
  }

  if (request.method === "POST" && sessionMatch?.tail[0] === "prompt") {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const force = body.force === true;
      if (!force && isSessionBusy(context, sessionMatch.sessionID)) {
        return json({ error: "session_busy", status: context.state.get(sessionMatch.sessionID) }, 409);
      }

      const text = getRequiredText(body);
      const parts: PromptPart[] = [{ type: "text", text }];
      const model = getOptionalModel(body);
      const variant = typeof body.variant === "string" && body.variant.length > 0 ? body.variant : undefined;
      const modelBody = { ...(model ? { model } : {}), ...(variant ? { variant } : {}) };

      const session = context.api.client?.session;
      const promptAsync = bindOptionalMethod(session, "promptAsync");
      const prompt = bindOptionalMethod(session, "prompt");

      if (body.no_reply === true && prompt) {
        // No-reply prompts return quickly; await so callers see immediate validation errors.
        assertSdkOk(await prompt({ sessionID: sessionMatch.sessionID, parts, noReply: true, ...modelBody }), "session.prompt");
      } else if (promptAsync) {
        // Non-blocking enqueue: it should return quickly once the server has accepted the
        // message. We await its confirmation (and verify the envelope) so we never report a
        // false "accepted". If it cannot confirm within a bounded window, surface a timeout
        // instead of pretending it succeeded.
        const enqueue = promptAsync({ sessionID: sessionMatch.sessionID, parts, ...modelBody });
        const settled = await raceSettled(enqueue, 5_000);
        if (settled.status === "rejected") throw settled.reason;
        if (settled.status === "pending") {
          enqueue.catch(() => {});
          throw new LensHttpError(504, "prompt_enqueue_timeout");
        }
        assertSdkOk(settled.value, "session.promptAsync");
      } else if (prompt) {
        // Blocking streaming call: do NOT await to completion or the HTTP request times out.
        // Race a short window so immediate errors (e.g. invalid model) are still surfaced.
        const pending = prompt({ sessionID: sessionMatch.sessionID, parts, ...modelBody });
        const early = await raceSettled(pending, 800);
        if (early.status === "rejected") throw early.reason;
        if (early.status === "fulfilled") {
          assertSdkOk(early.value, "session.prompt");
        } else {
          pending
            .then((value: unknown) => assertSdkOk(value, "session.prompt"))
            .catch((error: unknown) => {
              const status = context.state.handleEvent({
                type: "session.error",
                properties: { sessionID: sessionMatch.sessionID, error: errorMessage(error) },
              });
              if (status) context.events.publish("session.state", status);
            });
        }
      } else {
        throw new LensHttpError(503, "session.prompt unavailable");
      }

      if (body.switch_tui === true) {
        await switchTuiSession(context.api, sessionMatch.sessionID);
        context.state.markCurrent(sessionMatch.sessionID);
        context.events.publish("session.current", { session_id: sessionMatch.sessionID });
      }
      const status = context.state.markRunning(sessionMatch.sessionID);
      context.events.publish("session.state", status);
      return json({ accepted: true, session_id: sessionMatch.sessionID }, 202);
    });
  }

  if (request.method === "POST" && url.pathname === "/session") {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const create = bindMethod(context.api.client?.session, "create", "session.create");
      const title = typeof body.title === "string" && body.title.length > 0 ? body.title : undefined;
      const agent = typeof body.agent === "string" && body.agent.length > 0 ? body.agent : undefined;
      const parentID = typeof body.parentID === "string" && body.parentID.length > 0 ? body.parentID : undefined;
      const model = getOptionalModel(body);
      const variant = typeof body.variant === "string" && body.variant.length > 0 ? body.variant : undefined;
      const createArgs = {
        ...(title ? { title } : {}),
        ...(agent ? { agent } : {}),
        ...(parentID ? { parentID } : {}),
        ...(model ? { model: { providerID: model.providerID, id: model.modelID, ...(variant ? { variant } : {}) } } : {}),
      };
      const created = unwrapData(await create(createArgs));
      const sessionID = getString(getRecord(created)?.id);
      let switchedTui = false;
      if (body.switch_tui === true && sessionID) {
        await switchTuiSession(context.api, sessionID);
        context.state.markCurrent(sessionID);
        context.events.publish("session.current", { session_id: sessionID });
        switchedTui = true;
      }
      return json({ ok: true, session_id: sessionID, switched_tui: switchedTui, session: created }, 201);
    });
  }

  if (request.method === "POST" && sessionMatch?.tail[0] === "model") {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const providerID = getRequiredModelField(body, "providerID");
      const modelID = getRequiredModelField(body, "modelID");
      const variant = typeof body.variant === "string" && body.variant.length > 0 ? body.variant : undefined;
      const result = await withTimeout(setSessionModel(context.api, sessionMatch.sessionID, providerID, modelID, variant), 1_500).catch(
        async (error) => {
          if (error instanceof LensHttpError && error.status === 501 && error.message === "model_switch_unavailable") {
            const selectorOpened = await openModelSelector(context.api).catch(() => false);
            return json(
              {
                ok: false,
                error: "model_switch_unavailable",
                selector_opened: selectorOpened,
                message: selectorOpened
                  ? "Direct runtime model switching is unavailable; opened the TUI model selector instead."
                  : "Direct runtime model switching is unavailable and the TUI model selector could not be opened.",
              },
              501,
            );
          }
          throw error;
        },
      );
      if (result instanceof Response) return result;
      context.state.markCurrent(sessionMatch.sessionID);
      context.events.publish("session.model", { session_id: sessionMatch.sessionID, providerID, modelID, variant });
      return json({ ok: true, session_id: sessionMatch.sessionID, providerID, modelID, variant, result });
    });
  }

  if (request.method === "POST" && url.pathname === "/tui/models") {
    return withSdkError(async () => {
      const opened = await openModelSelector(context.api);
      return json({ ok: true, selector_opened: opened }, 202);
    });
  }

  if (request.method === "POST" && url.pathname === "/tui/overlay/close") {
    return withSdkError(async () => {
      const closed = await closeTuiOverlay(context.api);
      return json({ ok: true, overlay_closed: closed }, 202);
    });
  }

  if (request.method === "POST" && url.pathname === "/tui/prompt") {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const text = getRequiredText(body);
      await bindMethod(context.api.client?.tui, "appendPrompt", "tui.appendPrompt")({ body: { text } });
      await bindMethod(context.api.client?.tui, "submitPrompt", "tui.submitPrompt")();
      return json({ accepted: true }, 202);
    });
  }

  if (request.method === "POST" && url.pathname === "/tui/session") {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const sessionID = getRequiredSession(body);
      await switchTuiSession(context.api, sessionID);
      context.state.markCurrent(sessionID);
      context.events.publish("session.current", { session_id: sessionID });
      return json({ accepted: true, session_id: sessionID }, 202);
    });
  }

  // Answer an interactive "ask question" prompt (the agent asking the user to
  // pick from options). This is a SEPARATE mechanism from permissions: it uses
  // client.question.reply with an `answers` array (one entry per question, each
  // entry a list of the selected option labels). See QuestionRequest/QuestionInfo
  // in the opencode SDK.
  const questionMatch = matchQuestionRoute(url.pathname);
  if (request.method === "POST" && questionMatch?.tail === "reply") {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const answers = getQuestionAnswers(body);
      await bindMethod(context.api.client?.question, "reply", "question.reply")({
        requestID: questionMatch.requestID,
        answers,
      });
      return json({ ok: true, request_id: questionMatch.requestID, answers });
    });
  }

  if (request.method === "POST" && questionMatch?.tail === "reject") {
    return withSdkError(async () => {
      await bindMethod(context.api.client?.question, "reject", "question.reject")({
        requestID: questionMatch.requestID,
      });
      return json({ ok: true, request_id: questionMatch.requestID, rejected: true });
    });
  }

  if (request.method === "POST" && sessionMatch?.tail[0] === "abort") {
    return withSdkError(async () => {
      await bindMethod(context.api.client?.session, "abort", "session.abort")({ sessionID: sessionMatch.sessionID });
      const status = context.state.markIdle(sessionMatch.sessionID);
      context.events.publish("session.state", status);
      return json({ ok: true, session_id: sessionMatch.sessionID });
    });
  }

  if (request.method === "POST" && sessionMatch?.tail[0] === "permissions" && sessionMatch.tail[1]) {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const reply = getPermissionReply(body);
      const permissionID = decodeURIComponent(sessionMatch.tail[1]);
      // Prefer the modern global endpoint client.permission.reply({ requestID, reply });
      // fall back to the deprecated session-scoped respond({ sessionID, permissionID, response }).
      const replyMethod = bindOptionalMethod(context.api.client?.permission, "reply");
      if (replyMethod) {
        await replyMethod({ requestID: permissionID, reply });
      } else {
        const respondMethod = bindOptionalMethod(context.api.client?.permission, "respond");
        if (!respondMethod) throw new LensHttpError(503, "permission reply unavailable");
        await respondMethod({ sessionID: sessionMatch.sessionID, permissionID, response: reply });
      }
      const status = context.state.markRunning(sessionMatch.sessionID);
      context.events.publish("session.state", status);
      return json({ ok: true, session_id: sessionMatch.sessionID, permission_id: permissionID, reply });
    });
  }

  return json({ error: "not_found" }, 404);
}

async function writeRegistryFile(registryPath: string, socketPath: string, api: TuiApi) {
  const directory = api.directory || process.cwd();
  const record: RegisteredInstance = {
    pid: process.pid,
    socket: socketPath,
    transport: "unix",
    directory,
    worktree: api.worktree || directory,
    project_id: api.project?.id || "unknown",
    opencode_version: api.app?.version || "unknown",
    lens_version: LENS_VERSION,
    started_at: startedAt,
  };

  await ensurePrivateDir(dirname(registryPath));
  await writeFile(registryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function createHealth(api: TuiApi): LensHealth {
  return {
    lens_version: LENS_VERSION,
    opencode_version: api.app?.version || "unknown",
    uptime_ms: 0,
    directory: api.directory || process.cwd(),
    capabilities: createCapabilities(api),
  };
}

function createCapabilities(api: TuiApi): LensCapability[] {
  return [
    { name: "health", status: "stable" },
    { name: "sessions", status: "stable" },
    { name: "messages", status: "stable" },
    { name: "diff", status: "stable" },
    { name: "todo", status: "stable" },
    { name: "api_prompt", status: "stable", reason: "non-blocking via promptAsync; blocking prompt is not awaited to completion" },
    { name: "tui_prompt", status: "stable" },
    api.client?.session?.create
      ? { name: "session_create", status: "stable" }
      : { name: "session_create", status: "unavailable", reason: "session.create not exposed by opencode plugin host" },
    api.route?.navigate
      ? { name: "tui_route", status: "stable" }
      : { name: "tui_route", status: "unavailable", reason: "route.navigate not exposed by opencode plugin host" },
    { name: "abort", status: "stable" },
    { name: "permission_reply", status: "experimental", reason: "real permission request flow pending integration test" },
    { name: "events", status: "degraded", reason: "permission and error events not yet covered by integration tests" },
    { name: "tui_status", status: "stable" },
    { name: "models", status: "stable" },
    { name: "model_switch", status: "experimental", reason: "uses opencode ACP/config model-switch methods when exposed" },
    api.client?.tui?.openModels || api.keymap?.dispatchCommand || api.keymap?.runCommand
      ? { name: "model_selector", status: "stable" }
      : { name: "model_selector", status: "unavailable", reason: "TUI model selector API not exposed by opencode plugin host" },
  ];
}

async function buildTuiStatus(context: { api: TuiApi; state: SessionStateMachine }): Promise<TuiStatus> {
  const sessions = await listSessionSummaries(context, 20);
  const currentID = getCurrentSessionID(context.api) ?? context.state.current();
  const current = currentID ? sessions.find((session) => session.id === currentID) : undefined;
  let status = current ? resolveLiveStatus(context.api, context.state, current.id) : undefined;
  const pendingPermission = current ? firstRecord(context.api.state?.session?.permission?.(current.id)) : undefined;
  const pendingQuestion = current ? firstRecord(context.api.state?.session?.question?.(current.id)) : undefined;
  if (pendingPermission && current) status = { ...context.state.get(current.id), state: "waiting-permission", permission_id: getString(pendingPermission.id) ?? getString(pendingPermission.requestID) };
  if (pendingQuestion && current) status = { ...context.state.get(current.id), state: "waiting-input" };
  const question = parsePendingQuestion(pendingQuestion);
  const state = status?.state ?? "unknown";
  return {
    current_session: current,
    sessions,
    state,
    needs_user:
      Boolean(pendingPermission || pendingQuestion) ||
      state === "idle" ||
      state === "waiting-permission" ||
      state === "waiting-input" ||
      state === "error",
    needs_user_kind:
      pendingPermission || state === "waiting-permission"
        ? "permission"
        : pendingQuestion || state === "waiting-input"
          ? "question"
        : state === "error"
          ? "error"
          : state === "idle"
            ? "assistant-done"
            : undefined,
    permission_id: status?.permission_id ?? getString(pendingPermission?.id) ?? getString(pendingPermission?.requestID),
    question,
    error: status?.error,
    updated_at: status?.updated_at ?? Date.now(),
    source: getCurrentSessionID(context.api) ? "tui-route" : currentID ? "lens-events" : "unknown",
  };
}

// Extract the pending "ask question" request so clients know what requestID to
// answer and which option labels are valid. Returns undefined if there is no
// well-formed pending question.
function parsePendingQuestion(pending: Record<string, unknown> | undefined): PendingQuestion | undefined {
  if (!pending) return undefined;
  const requestID = getString(pending.id) ?? getString(pending.requestID);
  if (!requestID) return undefined;
  const rawQuestions = Array.isArray(pending.questions) ? pending.questions : [];
  const questions: PendingQuestionItem[] = rawQuestions
    .map((entry) => getRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => {
      const options = (Array.isArray(entry.options) ? entry.options : [])
        .map((opt) => getRecord(opt))
        .filter((opt): opt is Record<string, unknown> => Boolean(opt))
        .map((opt) => ({ label: getString(opt.label) ?? "", description: getString(opt.description) }))
        .filter((opt) => opt.label.length > 0);
      return {
        question: getString(entry.question) ?? "",
        header: getString(entry.header),
        options,
        multiple: entry.multiple === true ? true : undefined,
        custom: entry.custom === true ? true : undefined,
      } satisfies PendingQuestionItem;
    });
  return { request_id: requestID, questions };
}

function resolveLiveStatus(api: TuiApi, state: SessionStateMachine, sessionID: string) {
  const live = getRecord(api.state?.session?.status?.(sessionID));
  const liveType = getRecord(live?.status)?.type ?? live?.type ?? live?.state;
  if (liveType === "busy" || liveType === "running") return state.markRunning(sessionID);
  if (liveType === "idle") return state.markIdle(sessionID);
  if (liveType === "error") return { ...state.get(sessionID), state: "error" as const, error: getString(live?.error) };
  return state.get(sessionID);
}

// Decide whether a session is genuinely busy. The lens state machine can get stuck on
// "running" if an idle event was missed, so we reconcile against live TUI status first
// and treat a stale running marker (no live confirmation) as not busy.
function isSessionBusy(context: { api: TuiApi; state: SessionStateMachine }, sessionID: string) {
  const reconciled = resolveLiveStatus(context.api, context.state, sessionID);
  const live = getRecord(context.api.state?.session?.status?.(sessionID));
  const liveType = getRecord(live?.status)?.type ?? live?.type ?? live?.state;
  if (liveType === "idle") return false;
  if (liveType === "busy" || liveType === "running") return true;
  return reconciled.state === "running" || reconciled.state === "waiting-permission";
}

async function raceSettled<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown } | { status: "pending" }> {
  const pendingMarker = Symbol("pending");
  try {
    const value = await Promise.race([promise, delay(ms).then(() => pendingMarker)]);
    if (value === pendingMarker) return { status: "pending" };
    return { status: "fulfilled", value: value as T };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function listSessionSummaries(context: { api: TuiApi; state: SessionStateMachine }, limit: number | undefined) {
  const sessions = await withTimeout<ApiResponse<unknown[]>>(
    bindMethod(context.api.client?.session, "list", "session.list")({
      ...(limit ? { limit } : {}),
    }),
    getSdkCallTimeoutMs(),
    "session_list_timeout",
  );
  return unwrapArray(sessions).map((session) => summarizeSession(session, context));
}

async function ensurePrivateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function registerCleanup(runtime: LensRuntime) {
  process.once("exit", () => runtime.cleanupSync());
  process.once("SIGTERM", () => {
    runtime.cleanupSync();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    runtime.cleanupSync();
    process.exit(130);
  });
}

function disposeEvents(disposers: Array<(() => void) | undefined>) {
  for (const dispose of disposers) dispose?.();
}

function normalizeApi(input: unknown): TuiApi {
  const record = getRecord(input);
  if (!record) return {};
  const nestedApi = getRecord(record.api);
  return nestedApi ? ({ ...record, ...nestedApi } as TuiApi) : (record as TuiApi);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function matchSessionRoute(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "session" || !parts[1]) return undefined;
  return { sessionID: decodeURIComponent(parts[1]), tail: parts.slice(2) };
}

function matchQuestionRoute(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "question" || !parts[1]) return undefined;
  return { requestID: decodeURIComponent(parts[1]), tail: parts[2] };
}

function getLimit(url: URL) {
  const raw = url.searchParams.get("limit");
  if (!raw) return undefined;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : undefined;
}

function getLastEventID(request: Request) {
  const raw = request.headers.get("last-event-id") ?? undefined;
  if (!raw) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function bindMethod<T extends object, K extends keyof T>(owner: T | undefined, key: K, name: string) {
  const method = bindOptionalMethod(owner, key);
  if (!method) throw new LensHttpError(503, `${name} unavailable`);
  return method;
}

function bindOptionalMethod<T extends object, K extends keyof T>(owner: T | undefined, key: K) {
  const method = owner?.[key];
  return typeof method === "function" ? method.bind(owner) : undefined;
}

async function readSdkMessages(api: TuiApi, sessionID: string | undefined, limit: number | undefined) {
  if (!sessionID) return [];
  const messages = bindOptionalMethod(api.client?.session, "messages");
  if (!messages) return [];
  const response = await Promise.race([
    messages({
      sessionID,
      ...(limit ? { limit } : {}),
    }),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 750)),
  ]);
  return response ? unwrapArray(response) : [];
}

async function withSdkError(handler: () => Promise<Response>) {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof LensHttpError) return json({ error: error.message }, error.status);
    return json({ error: errorMessage(error) }, errorStatus(error));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = "model_switch_timeout") {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new LensHttpError(504, label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function unwrapData<T>(response: ApiResponse<T>) {
  return response.data;
}

// opencode's SDK returns failures inside the envelope ({ error, response.status })
// instead of throwing. Treat a present `error` or a non-2xx status as a real failure
// so callers (e.g. prompt enqueue) never report false success.
function assertSdkOk(response: unknown, name: string): void {
  const record = getRecord(response);
  if (!record) return;
  const status = getRecord(record.response)?.status;
  const statusNum = typeof status === "number" ? status : undefined;
  if (record.error !== undefined && record.error !== null) {
    throw new LensHttpError(statusNum && statusNum >= 400 ? statusNum : 502, `${name} failed: ${errorMessage(record.error)}`);
  }
  if (statusNum !== undefined && (statusNum < 200 || statusNum >= 300)) {
    throw new LensHttpError(statusNum, `${name} failed with status ${statusNum}`);
  }
}

function unwrapArray<T>(response: ApiResponse<T[]>) {
  return Array.isArray(response.data) ? response.data : [];
}

function summarizeSession(input: unknown, context: { api: TuiApi; state: SessionStateMachine }): SessionSummary {
  const session = getRecord(input) ?? {};
  const id = String(session.id ?? session.sessionID ?? "unknown");
  const time = getRecord(session.time);
  return {
    id,
    title: typeof session.title === "string" ? session.title : undefined,
    // Reconcile against live SDK status so a session whose `idle` event was
    // missed by the lens state machine does not stay stuck on "running".
    status: reconcileSessionStatus(context, id),
    last_active: getNumber(session.updated_at) ?? getNumber(time?.updated) ?? getNumber(time?.created),
    message_count: getNumber(session.message_count) ?? getNumber(session.messageCount),
  };
}

// Resolve a session's status by trusting live TUI/SDK status first, then the
// lens state machine. A stale "running" marker with no live confirmation is
// treated as idle, fixing sessions that get stuck on "running" after a missed
// idle event.
function reconcileSessionStatus(context: { api: TuiApi; state: SessionStateMachine }, sessionID: string): SessionStatus {
  const live = getRecord(context.api.state?.session?.status?.(sessionID));
  const liveType = getRecord(live?.status)?.type ?? live?.type ?? live?.state;
  if (liveType === "idle") return context.state.markIdle(sessionID);
  if (liveType === "busy" || liveType === "running") return context.state.markRunning(sessionID);
  if (liveType === "error") return { ...context.state.get(sessionID), state: "error", error: getString(live?.error) };
  const cached = context.state.get(sessionID);
  // No live confirmation: a lingering "running" is unreliable -> report idle.
  if (cached.state === "running") return { ...cached, state: "idle" };
  return cached;
}

function summarizeMessage(input: unknown) {
  const message = getRecord(input) ?? {};
  const info = getRecord(message.info) ?? message;
  const parts = Array.isArray(message.parts) ? message.parts.map(summarizePart) : [];
  return {
    id: info.id,
    role: info.role,
    time: info.time,
    text: collectText(parts),
    parts,
  };
}

function summarizeProviders(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.map((provider) => {
    const record = getRecord(provider) ?? {};
    return {
      providerID: getString(record.id) ?? getString(record.providerID) ?? "unknown",
      models: getModelIDs(record.models),
    };
  });
}

function getModelIDs(input: unknown) {
  if (Array.isArray(input)) {
    return input.map((model) => getString(getRecord(model)?.id) ?? getString(getRecord(model)?.modelID)).filter(isString);
  }

  const record = getRecord(input);
  if (!record) return [];
  return Object.entries(record).map(([key, model]) => getString(getRecord(model)?.id) ?? key).filter(isString);
}

function isString(input: unknown): input is string {
  return typeof input === "string";
}

function hasUsableMessageParts(messages: Array<{ parts: unknown[] }>) {
  return messages.some((message) => message.parts.length > 0);
}

function summarizePart(input: unknown) {
  const part = getRecord(input) ?? {};
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "tool") {
    return {
      type: "tool",
      tool: part.tool,
      state: part.state,
      callID: part.callID,
    };
  }
  return { type: part.type ?? "unknown" };
}

function collectText(parts: unknown[]) {
  const values: string[] = [];
  for (const input of parts) {
    const part = getRecord(input);
    if (part?.type === "text" && typeof part.text === "string") values.push(part.text);
  }
  const text = values.join("\n");
  return text.length > 0 ? text : undefined;
}

function getRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function getNumber(input: unknown) {
  return typeof input === "number" ? input : undefined;
}

function getString(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function getCurrentSessionID(api: TuiApi) {
  const current = api.route?.current;
  if (current?.name !== "session") return undefined;
  return getString(current.params?.sessionID);
}

function firstRecord(input: unknown) {
  return Array.isArray(input) ? getRecord(input[0]) : getRecord(input);
}

async function readJsonObject(request: Request) {
  const body = await request.json().catch(() => undefined);
  const record = getRecord(body);
  if (!record) throw new LensHttpError(400, "request body must be a JSON object");
  return record;
}

function getRequiredText(body: Record<string, unknown>) {
  if (typeof body.text !== "string" || body.text.length === 0) {
    throw new LensHttpError(400, "text is required");
  }
  return body.text;
}

function getRequiredSession(body: Record<string, unknown>) {
  if (typeof body.session !== "string" || body.session.length === 0) {
    throw new LensHttpError(400, "session is required");
  }
  return body.session;
}

async function switchTuiSession(api: TuiApi, sessionID: string) {
  // Prefer the canonical `tui.selectSession` SDK call (POST /tui/select-session).
  // It triggers opencode's SessionSelect flow, which reactively loads/refreshes
  // the session's messages in the TUI. The lower-level `route.navigate` only
  // changes the route and can leave the message list stale until a manual
  // refresh, so it is used solely as a fallback.
  // Bind via the owner so the SDK method keeps its `this` (it reads `this.client`
  // internally); pulling the function off the object loses that binding.
  const select = bindOptionalMethod(api.client?.tui, "selectSession");
  if (select) {
    const result = await select({ sessionID });
    assertSdkOk(result, "tui.selectSession");
    return;
  }
  if (api.route?.navigate) {
    api.route.navigate("session", { sessionID });
    return;
  }
  throw new LensHttpError(503, "tui session navigation unavailable");
}

// Translate a client-friendly permission response into the value the opencode
// SDK's modern `permission.reply` endpoint actually expects:
//   "once"   -> approve this single request (== allow)
//   "always" -> approve and remember (== allow always)
//   "reject" -> deny
// Accepts the friendly aliases allow/approve/yes and deny/reject/no, as well as
// the raw SDK values, from either `response` or `reply` in the body.
function getPermissionReply(body: Record<string, unknown>): "once" | "always" | "reject" {
  const raw = body.response ?? body.reply;
  switch (raw) {
    case "once":
    case "allow":
    case "approve":
    case "yes":
      return "once";
    case "always":
      return "always";
    case "reject":
    case "deny":
    case "no":
      return "reject";
    default:
      throw new LensHttpError(400, "response must be allow (once), always, or deny (reject)");
  }
}

// Normalize an "ask question" answer body into the SDK shape: string[][], where
// each inner array is the selected option label(s) for one question (in order).
// Accepts several convenience forms:
//   { answers: [["A"], ["B","C"]] }  -> used as-is (multi-question)
//   { answers: ["A", "B"] }          -> one label per question: [["A"],["B"]]
//   { answer: "A" }                  -> single question: [["A"]]
//   { answer: ["A","B"] }            -> single multi-select question: [["A","B"]]
function getQuestionAnswers(body: Record<string, unknown>): string[][] {
  const raw = body.answers ?? body.answer;
  if (typeof raw === "string") return [[raw]];
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw new LensHttpError(400, "answers must not be empty");
    if (raw.every((item) => typeof item === "string")) {
      // Ambiguous flat array. If the body used `answer`, treat it as one
      // multi-select question; if it used `answers`, treat each as its own
      // single-select question.
      const flat = raw as string[];
      return body.answer !== undefined ? [flat] : flat.map((label) => [label]);
    }
    if (raw.every((item) => Array.isArray(item) && (item as unknown[]).every((s) => typeof s === "string"))) {
      return raw as string[][];
    }
  }
  throw new LensHttpError(400, "answers must be a string, string[], or string[][] of selected option labels");
}

function getRequiredModelField(body: Record<string, unknown>, key: "providerID" | "modelID") {
  const camel = body[key];
  const snake = body[key === "providerID" ? "provider_id" : "model_id"];
  const value = typeof camel === "string" ? camel : typeof snake === "string" ? snake : undefined;
  if (!value) throw new LensHttpError(400, `${key} is required`);
  return value;
}

function getOptionalModel(body: Record<string, unknown>): PromptModel | undefined {
  const provider = body.providerID ?? body.provider_id;
  const model = body.modelID ?? body.model_id;
  if (typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0) {
    return { providerID: provider, modelID: model };
  }
  if (provider !== undefined || model !== undefined) {
    throw new LensHttpError(400, "providerID and modelID must be provided together");
  }
  return undefined;
}


async function setSessionModel(api: TuiApi, sessionID: string, providerID: string, modelID: string, variant: string | undefined) {
  const session = api.client?.session;
  const fullModelID = `${providerID}/${modelID}`;

  // NOTE: There is no plugin-accessible API to set the TUI's *visible* model
  // indicator to a specific provider/model by ID. The indicator is driven by
  // the TUI-internal local model state (`local.model.current()`), which is NOT
  // exposed to plugins (`api.local` is undefined in the plugin runtime, verified
  // live). The only plugin-reachable TUI model commands are the interactive
  // selector (`model.list` / `tui.openModels`) and the recent/favorite cyclers
  // (`model.cycle_recent` / `model.cycle_favorite`), none of which can target an
  // arbitrary model by ID. So model_switch only updates the session *config*
  // model (which controls actual inference) and always reports
  // `display_updated: false`.

  const setModel = bindOptionalMethod(session, "setModel");
  if (setModel) {
    return { ...(unwrapData(await setModel({ sessionID, providerID, modelID, variant })) as object), display_updated: false };
  }

  const setSessionConfigOption = bindOptionalMethod(session, "setSessionConfigOption") ?? bindOptionalMethod(api, "setSessionConfigOption");
  if (setSessionConfigOption) {
    const result = await setSessionConfigOption({ sessionId: sessionID, configId: "model", value: fullModelID });
    if (variant) await setSessionConfigOption({ sessionId: sessionID, configId: "effort", value: variant });
    return { ...(unwrapData(result) as object), display_updated: false };
  }

  const setConfigOption = bindOptionalMethod(session, "setConfigOption");
  if (setConfigOption) {
    const result = await setConfigOption({ sessionID, configID: "model", value: fullModelID });
    if (variant) await setConfigOption({ sessionID, configID: "effort", value: variant });
    return { ...(unwrapData(result) as object), display_updated: false };
  }

  const unstableSetSessionModel = bindOptionalMethod(session, "unstable_setSessionModel") ?? bindOptionalMethod(api, "unstable_setSessionModel");
  if (unstableSetSessionModel) {
    return { ...(unwrapData(await unstableSetSessionModel({ sessionId: sessionID, modelId: fullModelID })) as object), display_updated: false };
  }

  throw new LensHttpError(501, "model_switch_unavailable");
}

async function openModelSelector(api: TuiApi) {
  const openModels = bindOptionalMethod(api.client?.tui, "openModels");
  if (openModels) {
    await openModels({});
    return true;
  }

  const dispatchCommand = bindOptionalMethod(api.keymap, "dispatchCommand") ?? bindOptionalMethod(api.keymap, "runCommand");
  if (dispatchCommand) {
    await dispatchCommand("model.choose");
    return true;
  }

  throw new LensHttpError(503, "model_selector_unavailable");
}

async function closeTuiOverlay(api: TuiApi) {
  const clearDialog = bindOptionalMethod(api.ui?.dialog, "clear");
  if (clearDialog) {
    await clearDialog();
    return true;
  }

  throw new LensHttpError(503, "tui_overlay_close_unavailable");
}

function errorStatus(error: unknown) {
  const record = getRecord(error);
  const response = getRecord(record?.response);
  const status = getNumber(response?.status) ?? getNumber(record?.status);
  return status && status >= 400 && status < 600 ? status : 500;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    // opencode SDK error envelopes nest the human-readable text in a few shapes:
    // { data: { message } }, { message }, { error }, { name }.
    const data = record.data;
    if (data && typeof data === "object") {
      const nested = (data as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.length > 0) return nested;
    }
    for (const key of ["message", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    const name = typeof record.name === "string" ? record.name : undefined;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return name ? `${name}: ${serialized}` : serialized;
    } catch {
      // fall through to name / String() below
    }
    if (name) return name;
  }
  return String(error);
}

class LensHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
