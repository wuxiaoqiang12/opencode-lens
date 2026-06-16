// @bun
// src/runtime.ts
import { chmod, mkdir, rm, writeFile } from "fs/promises";
import { rmSync } from "fs";
import { dirname } from "path";

// ../shared/src/paths.ts
import { homedir } from "os";
import { join } from "path";
var APP_DIR = "opencode-lens";
function getLensDataDir(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), APP_DIR);
}
function getLensRuntimeDir(options = {}) {
  const env = options.env ?? process.env;
  if (env.XDG_RUNTIME_DIR)
    return join(env.XDG_RUNTIME_DIR, APP_DIR);
  return join(getLensDataDir(options), "sockets");
}
function getInstancesDir(options = {}) {
  return join(getLensDataDir(options), "instances");
}
function getInstanceRegistryPath(pid = process.pid, options = {}) {
  return join(getInstancesDir(options), `${pid}.json`);
}
function getSocketPath(pid = process.pid, options = {}) {
  return join(getLensRuntimeDir(options), `${pid}.sock`);
}
// ../shared/src/types.ts
var LENS_VERSION = "0.1.2";
// src/events.ts
class EventHub {
  capacity;
  nextID = 1;
  buffer = [];
  listeners = new Set;
  constructor(capacity = 100) {
    this.capacity = capacity;
  }
  publish(type, data) {
    const event = { id: this.nextID++, type, at: Date.now(), data };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity)
      this.buffer.shift();
    for (const listener of this.listeners)
      listener(event);
  }
  stream(lastEventID) {
    const encoder = new TextEncoder;
    return new Response(new ReadableStream({
      start: (controller) => {
        for (const event of this.replayAfter(lastEventID)) {
          controller.enqueue(encoder.encode(formatSse(event)));
        }
        const listener = (event) => controller.enqueue(encoder.encode(formatSse(event)));
        this.listeners.add(listener);
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}

`));
        }, 15000);
        return () => {
          clearInterval(heartbeat);
          this.listeners.delete(listener);
        };
      },
      cancel: () => {
        return;
      }
    }), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      }
    });
  }
  replayAfter(lastEventID) {
    if (!lastEventID)
      return [];
    return this.buffer.filter((event) => event.id > lastEventID);
  }
}
function formatSse(event) {
  return `id: ${event.id}
event: ${event.type}
data: ${JSON.stringify(event)}

`;
}

// src/persistence.ts
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir as homedir2 } from "os";
import { isAbsolute, join as join2 } from "path";
var DEFAULT_LIMIT = 20;
function readPersistedMessages(sessionID, limit = DEFAULT_LIMIT) {
  const databasePath = getOpencodeDatabasePath();
  if (!existsSync(databasePath))
    return;
  const db = new Database(databasePath, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 1000");
    const messages = db.query("select id, time_created, data from message where session_id = ? order by time_created desc, id desc limit ?").all(sessionID, clampLimit(limit)).reverse();
    if (!messages.length)
      return [];
    const messageIDs = messages.map((message) => message.id);
    const parts = db.query(`select id, message_id, data
         from part
         where message_id in (${messageIDs.map(() => "?").join(",")})
         order by time_created asc, id asc`).all(...messageIDs);
    const partsByMessage = groupParts(parts);
    return messages.map((message) => {
      const data = parseJsonRecord(message.data);
      return {
        id: message.id,
        role: data?.role,
        time: data?.time ?? { created: message.time_created },
        parts: partsByMessage.get(message.id) ?? []
      };
    });
  } finally {
    db.close();
  }
}
function groupParts(rows) {
  const result = new Map;
  for (const row of rows) {
    const part = parseJsonRecord(row.data);
    if (!part)
      continue;
    const list = result.get(row.message_id) ?? [];
    list.push({ id: row.id, ...part });
    result.set(row.message_id, list);
  }
  return result;
}
function getOpencodeDatabasePath() {
  const custom = process.env.OPENCODE_DB;
  if (custom)
    return isAbsolute(custom) || custom === ":memory:" ? custom : join2(getOpencodeDataDir(), custom);
  return join2(getOpencodeDataDir(), "opencode.db");
}
function getOpencodeDataDir() {
  return join2(process.env.XDG_DATA_HOME || join2(homedir2(), ".local", "share"), "opencode");
}
function clampLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : DEFAULT_LIMIT;
}
function parseJsonRecord(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}

// src/state.ts
class SessionStateMachine {
  statuses = new Map;
  currentSessionID;
  handleEvent(event) {
    const sessionID = getSessionID(event.properties);
    if (!sessionID)
      return;
    this.currentSessionID = sessionID;
    if (event.type === "message.updated" && getMessageRole(event.properties) === "user") {
      return this.setState(sessionID, "running");
    }
    if (event.type === "session.status") {
      const status = getStatusType(event.properties);
      if (status === "idle")
        return this.setState(sessionID, "idle");
      if (status === "busy")
        return this.setState(sessionID, "running");
      return;
    }
    if (event.type === "session.idle") {
      return this.setState(sessionID, "idle");
    }
    if (event.type === "permission.asked") {
      return this.setState(sessionID, "waiting-permission", { permission_id: getPermissionID(event.properties) });
    }
    if (event.type === "question.asked") {
      return this.setState(sessionID, "waiting-input");
    }
    if (event.type === "permission.replied") {
      return this.setState(sessionID, "running");
    }
    if (event.type === "session.error") {
      return this.setState(sessionID, "error", { error: getErrorMessage(event.properties) });
    }
    return;
  }
  get(sessionID) {
    return this.statuses.get(sessionID) ?? {
      session_id: sessionID,
      state: "idle",
      updated_at: Date.now(),
      rebuilt: true
    };
  }
  entries() {
    return Array.from(this.statuses.values());
  }
  current() {
    return this.currentSessionID;
  }
  markCurrent(sessionID) {
    this.currentSessionID = sessionID;
  }
  markRunning(sessionID) {
    this.currentSessionID = sessionID;
    return this.setState(sessionID, "running");
  }
  markIdle(sessionID) {
    this.currentSessionID = sessionID;
    return this.setState(sessionID, "idle");
  }
  setState(sessionID, state, extra = {}) {
    const status = {
      session_id: sessionID,
      state,
      updated_at: Date.now(),
      ...extra
    };
    this.statuses.set(sessionID, status);
    return status;
  }
}
function attachSessionStateEvents(api, state, publish) {
  const event = getEventApi(api);
  if (!event)
    return [];
  return [
    "message.updated",
    "tui.session.select",
    "session.status",
    "session.idle",
    "permission.asked",
    "question.asked",
    "permission.replied",
    "session.error"
  ].map((type) => event.on(type, (lensEvent) => {
    publish?.(lensEvent.type, lensEvent.properties ?? {});
    const status = state.handleEvent(lensEvent);
    if (status)
      publish?.("session.state", status);
  }));
}
function getEventApi(input) {
  if (typeof input !== "object" || input === null || !("event" in input))
    return;
  const event = input.event;
  if (typeof event !== "object" || event === null || !("on" in event) || typeof event.on !== "function")
    return;
  return event;
}
function getSessionID(properties) {
  if (!properties)
    return;
  if (typeof properties.sessionID === "string")
    return properties.sessionID;
  const info = getRecord(properties.info);
  if (typeof info?.sessionID === "string")
    return info.sessionID;
  const session = getRecord(properties.session);
  if (typeof session?.id === "string")
    return session.id;
  return;
}
function getMessageRole(properties) {
  return getRecord(properties?.info)?.role;
}
function getStatusType(properties) {
  return getRecord(properties?.status)?.type;
}
function getPermissionID(properties) {
  if (!properties)
    return;
  if (typeof properties.requestID === "string")
    return properties.requestID;
  if (typeof properties.permissionID === "string")
    return properties.permissionID;
  if (typeof properties.id === "string")
    return properties.id;
  return;
}
function getErrorMessage(properties) {
  if (!properties)
    return;
  if (typeof properties.error === "string")
    return properties.error;
  const error = getRecord(properties.error);
  if (typeof error?.message === "string")
    return error.message;
  return;
}
function getRecord(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
}

// src/runtime.ts
var startedAt = Date.now();
function getSdkCallTimeoutMs() {
  const raw = Number(process.env.OPENCODE_LENS_SDK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}
async function startLens(input) {
  const api = normalizeApi(input);
  const socketPath = getSocketPath();
  const registryPath = getInstanceRegistryPath();
  await ensurePrivateDir(getLensDataDir());
  await ensurePrivateDir(getInstancesDir());
  await ensurePrivateDir(getLensRuntimeDir());
  await rm(socketPath, { force: true });
  const health = createHealth(api);
  const state = new SessionStateMachine;
  const events = new EventHub(100);
  const eventDisposers = attachSessionStateEvents(input, state, (type, data) => events.publish(type, data));
  const serveOptions = {
    unix: socketPath,
    idleTimeout: 30,
    fetch(request) {
      return handleRequest(request, { api, health, state, events });
    }
  };
  const server = Bun.serve(serveOptions);
  const runtime = {
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
    }
  };
  await writeRegistryFile(registryPath, socketPath, api);
  registerCleanup(runtime);
  api.lifecycle?.onDispose?.(() => runtime.cleanupSync());
  return runtime;
}
async function handleRequest(request, context) {
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
  const sessionID = sessionMatch?.sessionID;
  if (request.method === "GET" && sessionMatch?.tail.length === 0) {
    return withSdkError(async () => {
      const stateSession = context.api.state?.session?.get?.(sessionMatch.sessionID);
      if (stateSession)
        return json(stateSession);
      const session = await withTimeout(bindMethod(context.api.client?.session, "get", "session.get")({
        sessionID: sessionMatch.sessionID
      }), getSdkCallTimeoutMs(), "session_get_timeout");
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
      if (summarizedStateMessages && hasUsableMessageParts(summarizedStateMessages))
        return json(summarizedStateMessages);
      const persistedMessages = readPersistedMessages(sessionMatch.sessionID, limit);
      if (persistedMessages && persistedMessages.length > 0)
        return json(persistedMessages.map(summarizeMessage));
      const sdkMessages = await readSdkMessages(context.api, sessionMatch.sessionID, limit);
      const summarizedSdkMessages = sdkMessages.map(summarizeMessage);
      if (hasUsableMessageParts(summarizedSdkMessages))
        return json(summarizedSdkMessages);
      if (persistedMessages)
        return json([]);
      if (summarizedStateMessages)
        return json(summarizedStateMessages);
      return json(summarizedSdkMessages);
    });
  }
  if (request.method === "GET" && sessionMatch?.tail[0] === "diff") {
    return withSdkError(async () => {
      const stateDiff = context.api.state?.session?.diff?.(sessionMatch.sessionID);
      if (Array.isArray(stateDiff))
        return json(stateDiff);
      const diff = await withTimeout(bindMethod(context.api.client?.session, "diff", "session.diff")({
        sessionID: sessionMatch.sessionID,
        ...url.searchParams.get("messageID") ? { messageID: url.searchParams.get("messageID") } : {}
      }), getSdkCallTimeoutMs(), "session_diff_timeout");
      return json(unwrapData(diff));
    });
  }
  if (request.method === "GET" && sessionMatch?.tail[0] === "todo") {
    return withSdkError(async () => {
      const stateTodo = context.api.state?.session?.todo?.(sessionMatch.sessionID);
      if (Array.isArray(stateTodo))
        return json(stateTodo);
      const todo = await withTimeout(bindMethod(context.api.client?.session, "todo", "session.todo")({
        sessionID: sessionMatch.sessionID
      }), getSdkCallTimeoutMs(), "session_todo_timeout");
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
      const parts = [{ type: "text", text }];
      const model = getOptionalModel(body);
      const variant = typeof body.variant === "string" && body.variant.length > 0 ? body.variant : undefined;
      const modelBody = { ...model ? { model } : {}, ...variant ? { variant } : {} };
      const session = context.api.client?.session;
      const promptAsync = bindOptionalMethod(session, "promptAsync");
      const prompt = bindOptionalMethod(session, "prompt");
      if (body.no_reply === true && prompt) {
        assertSdkOk(await prompt({ sessionID: sessionMatch.sessionID, parts, noReply: true, ...modelBody }), "session.prompt");
      } else if (promptAsync) {
        const enqueue = promptAsync({ sessionID: sessionMatch.sessionID, parts, ...modelBody });
        const settled = await raceSettled(enqueue, 5000);
        if (settled.status === "rejected")
          throw settled.reason;
        if (settled.status === "pending") {
          enqueue.catch(() => {});
          throw new LensHttpError(504, "prompt_enqueue_timeout");
        }
        assertSdkOk(settled.value, "session.promptAsync");
      } else if (prompt) {
        const pending = prompt({ sessionID: sessionMatch.sessionID, parts, ...modelBody });
        const early = await raceSettled(pending, 800);
        if (early.status === "rejected")
          throw early.reason;
        if (early.status === "fulfilled") {
          assertSdkOk(early.value, "session.prompt");
        } else {
          pending.then((value) => assertSdkOk(value, "session.prompt")).catch((error) => {
            const status2 = context.state.handleEvent({
              type: "session.error",
              properties: { sessionID: sessionMatch.sessionID, error: errorMessage(error) }
            });
            if (status2)
              context.events.publish("session.state", status2);
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
        ...title ? { title } : {},
        ...agent ? { agent } : {},
        ...parentID ? { parentID } : {},
        ...model ? { model: { providerID: model.providerID, id: model.modelID, ...variant ? { variant } : {} } } : {}
      };
      const created = unwrapData(await create(createArgs));
      const sessionID2 = getString(getRecord2(created)?.id);
      let switchedTui = false;
      if (body.switch_tui === true && sessionID2) {
        await switchTuiSession(context.api, sessionID2);
        context.state.markCurrent(sessionID2);
        context.events.publish("session.current", { session_id: sessionID2 });
        switchedTui = true;
      }
      return json({ ok: true, session_id: sessionID2, switched_tui: switchedTui, session: created }, 201);
    });
  }
  if (request.method === "POST" && sessionMatch?.tail[0] === "model") {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const providerID = getRequiredModelField(body, "providerID");
      const modelID = getRequiredModelField(body, "modelID");
      const variant = typeof body.variant === "string" && body.variant.length > 0 ? body.variant : undefined;
      const result = await withTimeout(setSessionModel(context.api, sessionMatch.sessionID, providerID, modelID, variant), 1500).catch(async (error) => {
        if (error instanceof LensHttpError && error.status === 501 && error.message === "model_switch_unavailable") {
          const selectorOpened = await openModelSelector(context.api).catch(() => false);
          return json({
            ok: false,
            error: "model_switch_unavailable",
            selector_opened: selectorOpened,
            message: selectorOpened ? "Direct runtime model switching is unavailable; opened the TUI model selector instead." : "Direct runtime model switching is unavailable and the TUI model selector could not be opened."
          }, 501);
        }
        throw error;
      });
      if (result instanceof Response)
        return result;
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
      const sessionID2 = getRequiredSession(body);
      await switchTuiSession(context.api, sessionID2);
      context.state.markCurrent(sessionID2);
      context.events.publish("session.current", { session_id: sessionID2 });
      return json({ accepted: true, session_id: sessionID2 }, 202);
    });
  }
  const questionMatch = matchQuestionRoute(url.pathname);
  if (request.method === "POST" && questionMatch?.tail === "reply") {
    return withSdkError(async () => {
      const body = await readJsonObject(request);
      const answers = getQuestionAnswers(body);
      await bindMethod(context.api.client?.question, "reply", "question.reply")({
        requestID: questionMatch.requestID,
        answers
      });
      return json({ ok: true, request_id: questionMatch.requestID, answers });
    });
  }
  if (request.method === "POST" && questionMatch?.tail === "reject") {
    return withSdkError(async () => {
      await bindMethod(context.api.client?.question, "reject", "question.reject")({
        requestID: questionMatch.requestID
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
      const replyMethod = bindOptionalMethod(context.api.client?.permission, "reply");
      if (replyMethod) {
        await replyMethod({ requestID: permissionID, reply });
      } else {
        const respondMethod = bindOptionalMethod(context.api.client?.permission, "respond");
        if (!respondMethod)
          throw new LensHttpError(503, "permission reply unavailable");
        await respondMethod({ sessionID: sessionMatch.sessionID, permissionID, response: reply });
      }
      const status = context.state.markRunning(sessionMatch.sessionID);
      context.events.publish("session.state", status);
      return json({ ok: true, session_id: sessionMatch.sessionID, permission_id: permissionID, reply });
    });
  }
  return json({ error: "not_found" }, 404);
}
async function writeRegistryFile(registryPath, socketPath, api) {
  const directory = api.directory || process.cwd();
  const record = {
    pid: process.pid,
    socket: socketPath,
    transport: "unix",
    directory,
    worktree: api.worktree || directory,
    project_id: api.project?.id || "unknown",
    opencode_version: api.app?.version || "unknown",
    lens_version: LENS_VERSION,
    started_at: startedAt
  };
  await ensurePrivateDir(dirname(registryPath));
  await writeFile(registryPath, `${JSON.stringify(record, null, 2)}
`, { mode: 384 });
}
function createHealth(api) {
  return {
    lens_version: LENS_VERSION,
    opencode_version: api.app?.version || "unknown",
    uptime_ms: 0,
    directory: api.directory || process.cwd(),
    capabilities: createCapabilities(api)
  };
}
function createCapabilities(api) {
  return [
    { name: "health", status: "stable" },
    { name: "sessions", status: "stable" },
    { name: "messages", status: "stable" },
    { name: "diff", status: "stable" },
    { name: "todo", status: "stable" },
    { name: "api_prompt", status: "stable", reason: "non-blocking via promptAsync; blocking prompt is not awaited to completion" },
    { name: "tui_prompt", status: "stable" },
    api.client?.session?.create ? { name: "session_create", status: "stable" } : { name: "session_create", status: "unavailable", reason: "session.create not exposed by opencode plugin host" },
    api.route?.navigate ? { name: "tui_route", status: "stable" } : { name: "tui_route", status: "unavailable", reason: "route.navigate not exposed by opencode plugin host" },
    { name: "abort", status: "stable" },
    { name: "permission_reply", status: "experimental", reason: "real permission request flow pending integration test" },
    { name: "events", status: "degraded", reason: "permission and error events not yet covered by integration tests" },
    { name: "tui_status", status: "stable" },
    { name: "models", status: "stable" },
    { name: "model_switch", status: "experimental", reason: "uses opencode ACP/config model-switch methods when exposed" },
    api.client?.tui?.openModels || api.keymap?.dispatchCommand || api.keymap?.runCommand ? { name: "model_selector", status: "stable" } : { name: "model_selector", status: "unavailable", reason: "TUI model selector API not exposed by opencode plugin host" }
  ];
}
async function buildTuiStatus(context) {
  const sessions = await listSessionSummaries(context, 20);
  const currentID = getCurrentSessionID(context.api) ?? context.state.current();
  const current = currentID ? sessions.find((session) => session.id === currentID) : undefined;
  let status = current ? resolveLiveStatus(context.api, context.state, current.id) : undefined;
  const pendingPermission = current ? firstRecord(context.api.state?.session?.permission?.(current.id)) : undefined;
  const pendingQuestion = current ? firstRecord(context.api.state?.session?.question?.(current.id)) : undefined;
  if (pendingPermission && current)
    status = { ...context.state.get(current.id), state: "waiting-permission", permission_id: getString(pendingPermission.id) ?? getString(pendingPermission.requestID) };
  if (pendingQuestion && current)
    status = { ...context.state.get(current.id), state: "waiting-input" };
  const question = parsePendingQuestion(pendingQuestion);
  const state = status?.state ?? "unknown";
  return {
    current_session: current,
    sessions,
    state,
    needs_user: Boolean(pendingPermission || pendingQuestion) || state === "idle" || state === "waiting-permission" || state === "waiting-input" || state === "error",
    needs_user_kind: pendingPermission || state === "waiting-permission" ? "permission" : pendingQuestion || state === "waiting-input" ? "question" : state === "error" ? "error" : state === "idle" ? "assistant-done" : undefined,
    permission_id: status?.permission_id ?? getString(pendingPermission?.id) ?? getString(pendingPermission?.requestID),
    question,
    error: status?.error,
    updated_at: status?.updated_at ?? Date.now(),
    source: getCurrentSessionID(context.api) ? "tui-route" : currentID ? "lens-events" : "unknown"
  };
}
function parsePendingQuestion(pending) {
  if (!pending)
    return;
  const requestID = getString(pending.id) ?? getString(pending.requestID);
  if (!requestID)
    return;
  const rawQuestions = Array.isArray(pending.questions) ? pending.questions : [];
  const questions = rawQuestions.map((entry) => getRecord2(entry)).filter((entry) => Boolean(entry)).map((entry) => {
    const options = (Array.isArray(entry.options) ? entry.options : []).map((opt) => getRecord2(opt)).filter((opt) => Boolean(opt)).map((opt) => ({ label: getString(opt.label) ?? "", description: getString(opt.description) })).filter((opt) => opt.label.length > 0);
    return {
      question: getString(entry.question) ?? "",
      header: getString(entry.header),
      options,
      multiple: entry.multiple === true ? true : undefined,
      custom: entry.custom === true ? true : undefined
    };
  });
  return { request_id: requestID, questions };
}
function resolveLiveStatus(api, state, sessionID) {
  const live = getRecord2(api.state?.session?.status?.(sessionID));
  const liveType = getRecord2(live?.status)?.type ?? live?.type ?? live?.state;
  if (liveType === "busy" || liveType === "running")
    return state.markRunning(sessionID);
  if (liveType === "idle")
    return state.markIdle(sessionID);
  if (liveType === "error")
    return { ...state.get(sessionID), state: "error", error: getString(live?.error) };
  return state.get(sessionID);
}
function isSessionBusy(context, sessionID) {
  const reconciled = resolveLiveStatus(context.api, context.state, sessionID);
  const live = getRecord2(context.api.state?.session?.status?.(sessionID));
  const liveType = getRecord2(live?.status)?.type ?? live?.type ?? live?.state;
  if (liveType === "idle")
    return false;
  if (liveType === "busy" || liveType === "running")
    return true;
  return reconciled.state === "running" || reconciled.state === "waiting-permission";
}
async function raceSettled(promise, ms) {
  const pendingMarker = Symbol("pending");
  try {
    const value = await Promise.race([promise, delay(ms).then(() => pendingMarker)]);
    if (value === pendingMarker)
      return { status: "pending" };
    return { status: "fulfilled", value };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function listSessionSummaries(context, limit) {
  const sessions = await withTimeout(bindMethod(context.api.client?.session, "list", "session.list")({
    ...limit ? { limit } : {}
  }), getSdkCallTimeoutMs(), "session_list_timeout");
  return unwrapArray(sessions).map((session) => summarizeSession(session, context));
}
async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 448 });
  await chmod(path, 448);
}
function registerCleanup(runtime) {
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
function disposeEvents(disposers) {
  for (const dispose of disposers)
    dispose?.();
}
function normalizeApi(input) {
  const record = getRecord2(input);
  if (!record)
    return {};
  const nestedApi = getRecord2(record.api);
  return nestedApi ? { ...record, ...nestedApi } : record;
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
function matchSessionRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "session" || !parts[1])
    return;
  return { sessionID: decodeURIComponent(parts[1]), tail: parts.slice(2) };
}
function matchQuestionRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "question" || !parts[1])
    return;
  return { requestID: decodeURIComponent(parts[1]), tail: parts[2] };
}
function getLimit(url) {
  const raw = url.searchParams.get("limit");
  if (!raw)
    return;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : undefined;
}
function getLastEventID(request) {
  const raw = request.headers.get("last-event-id") ?? undefined;
  if (!raw)
    return;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
function bindMethod(owner, key, name) {
  const method = bindOptionalMethod(owner, key);
  if (!method)
    throw new LensHttpError(503, `${name} unavailable`);
  return method;
}
function bindOptionalMethod(owner, key) {
  const method = owner?.[key];
  return typeof method === "function" ? method.bind(owner) : undefined;
}
async function readSdkMessages(api, sessionID, limit) {
  if (!sessionID)
    return [];
  const messages = bindOptionalMethod(api.client?.session, "messages");
  if (!messages)
    return [];
  const response = await Promise.race([
    messages({
      sessionID,
      ...limit ? { limit } : {}
    }),
    new Promise((resolve) => setTimeout(() => resolve(undefined), 750))
  ]);
  return response ? unwrapArray(response) : [];
}
async function withSdkError(handler) {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof LensHttpError)
      return json({ error: error.message }, error.status);
    return json({ error: errorMessage(error) }, errorStatus(error));
  }
}
async function withTimeout(promise, timeoutMs, label = "model_switch_timeout") {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new LensHttpError(504, label)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout)
      clearTimeout(timeout);
  }
}
function unwrapData(response) {
  return response.data;
}
function assertSdkOk(response, name) {
  const record = getRecord2(response);
  if (!record)
    return;
  const status = getRecord2(record.response)?.status;
  const statusNum = typeof status === "number" ? status : undefined;
  if (record.error !== undefined && record.error !== null) {
    throw new LensHttpError(statusNum && statusNum >= 400 ? statusNum : 502, `${name} failed: ${errorMessage(record.error)}`);
  }
  if (statusNum !== undefined && (statusNum < 200 || statusNum >= 300)) {
    throw new LensHttpError(statusNum, `${name} failed with status ${statusNum}`);
  }
}
function unwrapArray(response) {
  return Array.isArray(response.data) ? response.data : [];
}
function summarizeSession(input, context) {
  const session = getRecord2(input) ?? {};
  const id = String(session.id ?? session.sessionID ?? "unknown");
  const time = getRecord2(session.time);
  return {
    id,
    title: typeof session.title === "string" ? session.title : undefined,
    status: reconcileSessionStatus(context, id),
    last_active: getNumber(session.updated_at) ?? getNumber(time?.updated) ?? getNumber(time?.created),
    message_count: getNumber(session.message_count) ?? getNumber(session.messageCount)
  };
}
function reconcileSessionStatus(context, sessionID) {
  const live = getRecord2(context.api.state?.session?.status?.(sessionID));
  const liveType = getRecord2(live?.status)?.type ?? live?.type ?? live?.state;
  if (liveType === "idle")
    return context.state.markIdle(sessionID);
  if (liveType === "busy" || liveType === "running")
    return context.state.markRunning(sessionID);
  if (liveType === "error")
    return { ...context.state.get(sessionID), state: "error", error: getString(live?.error) };
  const cached = context.state.get(sessionID);
  if (cached.state === "running")
    return { ...cached, state: "idle" };
  return cached;
}
function summarizeMessage(input) {
  const message = getRecord2(input) ?? {};
  const info = getRecord2(message.info) ?? message;
  const parts = Array.isArray(message.parts) ? message.parts.map(summarizePart) : [];
  return {
    id: info.id,
    role: info.role,
    time: info.time,
    text: collectText(parts),
    parts
  };
}
function summarizeProviders(input) {
  if (!Array.isArray(input))
    return [];
  return input.map((provider) => {
    const record = getRecord2(provider) ?? {};
    return {
      providerID: getString(record.id) ?? getString(record.providerID) ?? "unknown",
      models: getModelIDs(record.models)
    };
  });
}
function getModelIDs(input) {
  if (Array.isArray(input)) {
    return input.map((model) => getString(getRecord2(model)?.id) ?? getString(getRecord2(model)?.modelID)).filter(isString);
  }
  const record = getRecord2(input);
  if (!record)
    return [];
  return Object.entries(record).map(([key, model]) => getString(getRecord2(model)?.id) ?? key).filter(isString);
}
function isString(input) {
  return typeof input === "string";
}
function hasUsableMessageParts(messages) {
  return messages.some((message) => message.parts.length > 0);
}
function summarizePart(input) {
  const part = getRecord2(input) ?? {};
  if (part.type === "text")
    return { type: "text", text: part.text };
  if (part.type === "tool") {
    return {
      type: "tool",
      tool: part.tool,
      state: part.state,
      callID: part.callID
    };
  }
  return { type: part.type ?? "unknown" };
}
function collectText(parts) {
  const values = [];
  for (const input of parts) {
    const part = getRecord2(input);
    if (part?.type === "text" && typeof part.text === "string")
      values.push(part.text);
  }
  const text = values.join(`
`);
  return text.length > 0 ? text : undefined;
}
function getRecord2(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
}
function getNumber(input) {
  return typeof input === "number" ? input : undefined;
}
function getString(input) {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}
function getCurrentSessionID(api) {
  const current = api.route?.current;
  if (current?.name !== "session")
    return;
  return getString(current.params?.sessionID);
}
function firstRecord(input) {
  return Array.isArray(input) ? getRecord2(input[0]) : getRecord2(input);
}
async function readJsonObject(request) {
  const body = await request.json().catch(() => {
    return;
  });
  const record = getRecord2(body);
  if (!record)
    throw new LensHttpError(400, "request body must be a JSON object");
  return record;
}
function getRequiredText(body) {
  if (typeof body.text !== "string" || body.text.length === 0) {
    throw new LensHttpError(400, "text is required");
  }
  return body.text;
}
function getRequiredSession(body) {
  if (typeof body.session !== "string" || body.session.length === 0) {
    throw new LensHttpError(400, "session is required");
  }
  return body.session;
}
async function switchTuiSession(api, sessionID) {
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
function getPermissionReply(body) {
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
function getQuestionAnswers(body) {
  const raw = body.answers ?? body.answer;
  if (typeof raw === "string")
    return [[raw]];
  if (Array.isArray(raw)) {
    if (raw.length === 0)
      throw new LensHttpError(400, "answers must not be empty");
    if (raw.every((item) => typeof item === "string")) {
      const flat = raw;
      return body.answer !== undefined ? [flat] : flat.map((label) => [label]);
    }
    if (raw.every((item) => Array.isArray(item) && item.every((s) => typeof s === "string"))) {
      return raw;
    }
  }
  throw new LensHttpError(400, "answers must be a string, string[], or string[][] of selected option labels");
}
function getRequiredModelField(body, key) {
  const camel = body[key];
  const snake = body[key === "providerID" ? "provider_id" : "model_id"];
  const value = typeof camel === "string" ? camel : typeof snake === "string" ? snake : undefined;
  if (!value)
    throw new LensHttpError(400, `${key} is required`);
  return value;
}
function getOptionalModel(body) {
  const provider = body.providerID ?? body.provider_id;
  const model = body.modelID ?? body.model_id;
  if (typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0) {
    return { providerID: provider, modelID: model };
  }
  if (provider !== undefined || model !== undefined) {
    throw new LensHttpError(400, "providerID and modelID must be provided together");
  }
  return;
}
async function setSessionModel(api, sessionID, providerID, modelID, variant) {
  const session = api.client?.session;
  const fullModelID = `${providerID}/${modelID}`;
  const setModel = bindOptionalMethod(session, "setModel");
  if (setModel) {
    return { ...unwrapData(await setModel({ sessionID, providerID, modelID, variant })), display_updated: false };
  }
  const setSessionConfigOption = bindOptionalMethod(session, "setSessionConfigOption") ?? bindOptionalMethod(api, "setSessionConfigOption");
  if (setSessionConfigOption) {
    const result = await setSessionConfigOption({ sessionId: sessionID, configId: "model", value: fullModelID });
    if (variant)
      await setSessionConfigOption({ sessionId: sessionID, configId: "effort", value: variant });
    return { ...unwrapData(result), display_updated: false };
  }
  const setConfigOption = bindOptionalMethod(session, "setConfigOption");
  if (setConfigOption) {
    const result = await setConfigOption({ sessionID, configID: "model", value: fullModelID });
    if (variant)
      await setConfigOption({ sessionID, configID: "effort", value: variant });
    return { ...unwrapData(result), display_updated: false };
  }
  const unstableSetSessionModel = bindOptionalMethod(session, "unstable_setSessionModel") ?? bindOptionalMethod(api, "unstable_setSessionModel");
  if (unstableSetSessionModel) {
    return { ...unwrapData(await unstableSetSessionModel({ sessionId: sessionID, modelId: fullModelID })), display_updated: false };
  }
  throw new LensHttpError(501, "model_switch_unavailable");
}
async function openModelSelector(api) {
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
async function closeTuiOverlay(api) {
  const clearDialog = bindOptionalMethod(api.ui?.dialog, "clear");
  if (clearDialog) {
    await clearDialog();
    return true;
  }
  throw new LensHttpError(503, "tui_overlay_close_unavailable");
}
function errorStatus(error) {
  const record = getRecord2(error);
  const response = getRecord2(record?.response);
  const status = getNumber(response?.status) ?? getNumber(record?.status);
  return status && status >= 400 && status < 600 ? status : 500;
}
function errorMessage(error) {
  if (error instanceof Error)
    return error.message;
  if (typeof error === "string")
    return error;
  if (error === null || error === undefined)
    return String(error);
  if (typeof error === "object") {
    const record = error;
    const data = record.data;
    if (data && typeof data === "object") {
      const nested = data.message;
      if (typeof nested === "string" && nested.length > 0)
        return nested;
    }
    for (const key of ["message", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0)
        return value;
    }
    const name = typeof record.name === "string" ? record.name : undefined;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}")
        return name ? `${name}: ${serialized}` : serialized;
    } catch {}
    if (name)
      return name;
  }
  return String(error);
}

class LensHttpError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// src/index.ts
var runtime;
async function start(input) {
  if (runtime)
    return runtime;
  runtime = await startLens(input).catch((error) => {
    console.error("opencode-lens failed to initialize", error);
    return;
  });
  return runtime;
}
var OpencodeLensPlugin = async (input) => {
  const lens = await start(input);
  return {
    event: async ({ event }) => {
      if (!lens)
        return;
      lens.events.publish(event.type, event.properties ?? {});
      const status = lens.state.handleEvent(event);
      if (status)
        lens.events.publish("session.state", status);
    }
  };
};
var OpencodeLensTuiPlugin = {
  id: "opencode-lens",
  tui: OpencodeLensPlugin
};
var src_default = OpencodeLensTuiPlugin;
export {
  src_default as default,
  OpencodeLensTuiPlugin,
  OpencodeLensPlugin
};
