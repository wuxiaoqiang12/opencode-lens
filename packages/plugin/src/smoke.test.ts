import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverInstances } from "@opencode-lens/shared";
import { requestUnixJson, requestUnixJsonResult } from "../../mcp/src/lens-http";
import { waitForEvents } from "../../mcp/src/sse";
import { startLens } from "./runtime";

describe("lens smoke primitives", () => {
  const cleanup: string[] = [];

  afterAll(async () => {
    await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })));
  });

  test("discovers lens runtime, sends no-reply prompt, and receives SSE event", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-smoke-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const prompts: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async list() {
            return { data: [] };
          },
          async prompt(input: unknown) {
            prompts.push(input);
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      const result = await discoverInstances({
        async probe(instance) {
          return requestUnixJson(instance.socket, "/health");
        },
      });

      expect(result.active).toHaveLength(1);
      expect(result.active[0]?.health.opencode_version).toBe("1.17.4");
      const events = waitForEvents(result.active, {}, 1_000);
      const accepted = await requestUnixJson(runtime.socketPath, "/session/ses_smoke/prompt", {
        method: "POST",
        body: { text: "smoke", no_reply: true },
      });

      expect(accepted).toMatchObject({ accepted: true, session_id: "ses_smoke" });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        sessionID: "ses_smoke",
        noReply: true,
        parts: [{ type: "text", text: "smoke" }],
      });
      expect(await events).toMatchObject({
        events: [{ instance: String(process.pid), event: "session.state" }],
      });
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("falls back to persisted SQLite messages when live messages have empty parts", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-persisted-"));
    const runtimeDir = join(root, "runtime");
    const opencodeDir = join(root, "opencode");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    const oldOpencodeDb = process.env.OPENCODE_DB;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    process.env.OPENCODE_DB = join(opencodeDir, "opencode.db");

    seedMessages(process.env.OPENCODE_DB, "ses_persisted");

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      state: { session: { messages: () => [{ info: { id: "msg_live", role: "assistant" }, parts: [] }] } },
      client: { session: { async messages() { return { data: [] }; } } },
    });

    try {
      const messages = await requestUnixJson<Array<{ id: string; role?: string; text?: string; parts: unknown[] }>>(
        runtime.socketPath,
        "/session/ses_persisted/messages?limit=5",
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ id: "msg_persisted", role: "assistant" });
      expect(messages[0]?.text).toBe("persisted review");
      expect(messages[0]?.parts).toEqual([{ type: "text", text: "persisted review" }]);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
      process.env.OPENCODE_DB = oldOpencodeDb;
    }
  });

  test("reports live tui status with pending question", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-status-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      route: { current: { name: "session", params: { sessionID: "ses_status" } } },
      state: {
        session: {
          status: () => ({ type: "busy" }),
          question: () => [{ id: "question_1", text: "choose" }],
        },
      },
      client: {
        session: {
          async list() {
            return { data: [{ id: "ses_status", title: "Needs input" }] };
          },
        },
      },
    });

    try {
      const status = await requestUnixJson<Record<string, unknown>>(runtime.socketPath, "/tui/status");
      expect(status).toMatchObject({ state: "waiting-input", needs_user: true, needs_user_kind: "question" });
      expect(status.current_session).toMatchObject({ id: "ses_status", title: "Needs input" });
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("uses tui route current session instead of guessing from shared session list", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-current-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      route: { current: { name: "session", params: { sessionID: "ses_visible" } } },
      client: {
        session: {
          async list() {
            return {
              data: [
                { id: "ses_recent", title: "Shared DB Recent" },
                { id: "ses_visible", title: "Visible Window Session" },
              ],
            };
          },
        },
      },
    });

    try {
      const status = await requestUnixJson<Record<string, unknown>>(runtime.socketPath, "/tui/status");
      expect(status).toMatchObject({ source: "tui-route" });
      expect(status.current_session).toMatchObject({ id: "ses_visible", title: "Visible Window Session" });
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("does not guess current session without tui route or lens event", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-no-current-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async list() {
            return { data: [{ id: "ses_recent", title: "Shared DB Recent" }] };
          },
        },
      },
    });

    try {
      const status = await requestUnixJson<Record<string, unknown>>(runtime.socketPath, "/tui/status");
      expect(status).toMatchObject({ state: "unknown", source: "unknown", needs_user: false });
      expect(status.current_session).toBeUndefined();
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("returns slim provider and model IDs without full model metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-models-slim-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      state: {
        provider: [
          {
            id: "zhipuai-coding-plan",
            name: "ZhipuAI Coding Plan",
            key: "secret",
            models: {
              "GLM-5.1": { id: "GLM-5.1", name: "GLM 5.1", capabilities: { toolcall: true } },
              "GLM-5.2": { name: "GLM 5.2", cost: { input: 1 } },
            },
          },
        ],
        config: { model: "happysolve_pub/gpt-5.5" },
      },
    });

    try {
      const models = await requestUnixJson<Record<string, unknown>>(runtime.socketPath, "/models");

      expect(models).toEqual({
        providers: [{ providerID: "zhipuai-coding-plan", models: ["GLM-5.1", "GLM-5.2"] }],
      });
      expect(JSON.stringify(models)).not.toContain("secret");
      expect(JSON.stringify(models)).not.toContain("capabilities");
      expect(JSON.stringify(models)).not.toContain("happysolve_pub/gpt-5.5");
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("does not report success from unsupported session update model field", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-model-update-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    let updateCalled = false;
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async update() {
            updateCalled = true;
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      const result = await requestUnixJsonResult(runtime.socketPath, "/session/ses_update/model", {
        method: "POST",
        body: { providerID: "provider", modelID: "model" },
      });

      expect(result).toMatchObject({
        ok: false,
        status: 501,
        body: { error: "model_switch_unavailable" },
      });
      expect(updateCalled).toBe(false);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("switches model through ACP session config option shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-model-config-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const calls: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async setSessionConfigOption(input: unknown) {
            calls.push(input);
            return { data: { configOptions: [] } };
          },
        },
      },
    });

    try {
      const result = await requestUnixJson(runtime.socketPath, "/session/ses_config/model", {
        method: "POST",
        body: { providerID: "zhipuai-coding-plan", modelID: "GLM-5.1" },
      });

      expect(result).toMatchObject({ ok: true, session_id: "ses_config" });
      expect(calls).toEqual([{ sessionId: "ses_config", configId: "model", value: "zhipuai-coding-plan/GLM-5.1" }]);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("switches model via session config and reports the TUI indicator is not updated", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-model-config-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const configCalls: unknown[] = [];
    let openModelsCalled = 0;
    // NOTE: no `local` key at all -- this mirrors the real plugin runtime where
    // `api.local` is undefined, so model_switch must NOT depend on it.
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async setSessionConfigOption(input: unknown) {
            configCalls.push(input);
            return { data: { configOptions: [] } };
          },
        },
        tui: {
          async openModels() {
            openModelsCalled += 1;
            return { data: true };
          },
        },
      },
    });

    try {
      const result = await requestUnixJson(runtime.socketPath, "/session/ses_disp/model", {
        method: "POST",
        body: { providerID: "zhipuai-coding-plan", modelID: "glm-5.2" },
      });

      expect(result).toMatchObject({
        ok: true,
        session_id: "ses_disp",
        result: { display_updated: false },
      });
      // The config model is set (controls inference); the selector is NOT opened
      // and the visible TUI indicator is intentionally left untouched.
      expect(configCalls).toEqual([
        { sessionId: "ses_disp", configId: "model", value: "zhipuai-coding-plan/glm-5.2" },
      ]);
      expect(openModelsCalled).toBe(0);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("answers an interactive question through client.question.reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-question-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const replyCalls: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        question: {
          async reply(input: unknown) {
            replyCalls.push(input);
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      // Single-question convenience form: `answer` -> answers [["方案 A"]].
      const single = await requestUnixJson(runtime.socketPath, "/question/que_abc/reply", {
        method: "POST",
        body: { answer: "方案 A" },
      });
      expect(single).toMatchObject({ ok: true, request_id: "que_abc", answers: [["方案 A"]] });
      expect(replyCalls.at(-1)).toEqual({ requestID: "que_abc", answers: [["方案 A"]] });

      // Explicit multi-question form passes through untouched.
      const multi = await requestUnixJson(runtime.socketPath, "/question/que_def/reply", {
        method: "POST",
        body: { answers: [["A"], ["B", "C"]] },
      });
      expect(multi).toMatchObject({ ok: true, request_id: "que_def", answers: [["A"], ["B", "C"]] });
      expect(replyCalls.at(-1)).toEqual({ requestID: "que_def", answers: [["A"], ["B", "C"]] });
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("translates allow/always/deny to once/always/reject via client.permission.reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-permission-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const replyCalls: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        permission: {
          async reply(input: unknown) {
            replyCalls.push(input);
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      const allow = await requestUnixJson(runtime.socketPath, "/session/ses_1/permissions/perm_1", {
        method: "POST",
        body: { response: "allow" },
      });
      expect(allow).toMatchObject({ ok: true, session_id: "ses_1", permission_id: "perm_1", reply: "once" });
      expect(replyCalls.at(-1)).toEqual({ requestID: "perm_1", reply: "once" });

      await requestUnixJson(runtime.socketPath, "/session/ses_1/permissions/perm_2", {
        method: "POST",
        body: { response: "always" },
      });
      expect(replyCalls.at(-1)).toEqual({ requestID: "perm_2", reply: "always" });

      const deny = await requestUnixJson(runtime.socketPath, "/session/ses_1/permissions/perm_3", {
        method: "POST",
        body: { response: "deny" },
      });
      expect(deny).toMatchObject({ reply: "reject" });
      expect(replyCalls.at(-1)).toEqual({ requestID: "perm_3", reply: "reject" });
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("attaches per-message model and variant to the prompt body when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-prompt-model-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const prompts: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async promptAsync(input: unknown) {
            prompts.push(input);
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      const accepted = await requestUnixJson(runtime.socketPath, "/session/ses_model_prompt/prompt", {
        method: "POST",
        body: { text: "review", providerID: "zhipuai-coding-plan", modelID: "glm-5.1", variant: "high" },
      });

      expect(accepted).toMatchObject({ accepted: true, session_id: "ses_model_prompt" });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        sessionID: "ses_model_prompt",
        parts: [{ type: "text", text: "review" }],
        model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.1" },
        variant: "high",
      });
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("returns immediately for a streaming prompt instead of blocking until completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-prompt-async-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    let resolvePrompt: (() => void) | undefined;
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          // Only blocking prompt() is available (no promptAsync); it never resolves during the test.
          prompt() {
            return new Promise((resolve) => {
              resolvePrompt = () => resolve({ data: { ok: true } });
            });
          },
        },
      },
    });

    try {
      const started = Date.now();
      const accepted = await requestUnixJson(runtime.socketPath, "/session/ses_block/prompt", {
        method: "POST",
        body: { text: "long running" },
      });
      const elapsed = Date.now() - started;

      expect(accepted).toMatchObject({ accepted: true, session_id: "ses_block" });
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      resolvePrompt?.();
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("does not report accepted when promptAsync returns an error envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-prompt-fail-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          // SDK reports failures inside the envelope instead of throwing.
          async promptAsync() {
            return { error: { message: "provider unavailable" }, response: { status: 502 } };
          },
        },
      },
    });

    try {
      const result = await requestUnixJsonResult(runtime.socketPath, "/session/ses_fail/prompt", {
        method: "POST",
        body: { text: "hi", providerID: "zhipuai-coding-plan", modelID: "glm-5.1" },
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("does not stay stuck on session_busy when live status reports idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-busy-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const prompts: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      state: { session: { status: () => ({ status: { type: "idle" } }) } },
      client: {
        session: {
          async promptAsync(input: unknown) {
            prompts.push(input);
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      // First prompt marks lens state as running.
      await requestUnixJson(runtime.socketPath, "/session/ses_busy/prompt", { method: "POST", body: { text: "one" } });
      // Second prompt would 409 from the stale running marker, but live status says idle, so it must go through.
      const second = await requestUnixJson(runtime.socketPath, "/session/ses_busy/prompt", {
        method: "POST",
        body: { text: "two" },
      });
      expect(second).toMatchObject({ accepted: true, session_id: "ses_busy" });
      expect(prompts).toHaveLength(2);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("creates a new session with an initial model through session.create", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-session-create-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const creates: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async create(input: unknown) {
            creates.push(input);
            return { data: { id: "ses_new", title: "Test link" } };
          },
        },
      },
    });

    try {
      const created = await requestUnixJson(runtime.socketPath, "/session", {
        method: "POST",
        body: { title: "Test link", providerID: "zhipuai-coding-plan", modelID: "glm-5.1" },
      });

      expect(created).toMatchObject({ ok: true, session_id: "ses_new" });
      expect(creates).toEqual([
        { title: "Test link", model: { providerID: "zhipuai-coding-plan", id: "glm-5.1" } },
      ]);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("switches the TUI to the new session when session create requests switch_tui", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-create-switch-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const selected: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async create() {
            return { data: { id: "ses_created", title: "Fresh" } };
          },
        },
        tui: {
          _client: { ok: true },
          async selectSession(this: { _client?: unknown }, input: unknown) {
            if (!this || !this._client) throw new Error("this.client lost");
            selected.push(input);
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      const created = await requestUnixJson(runtime.socketPath, "/session", {
        method: "POST",
        body: { title: "Fresh", switch_tui: true },
      });
      expect(created).toMatchObject({ ok: true, session_id: "ses_created", switched_tui: true });
      expect(selected).toEqual([{ sessionID: "ses_created" }]);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("calls session.get and session.messages with sessionID path for non-current sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-session-path-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const gets: unknown[] = [];
    const messageReads: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      // No api.state: forces fall-through to the SDK client, exercising the path shape.
      client: {
        session: {
          async get(input: unknown) {
            gets.push(input);
            return { data: { id: "ses_other", title: "Other" } };
          },
          async messages(input: unknown) {
            messageReads.push(input);
            return { data: [] };
          },
        },
      },
    });

    try {
      await requestUnixJson(runtime.socketPath, "/session/ses_other", { method: "GET" });
      await requestUnixJson(runtime.socketPath, "/session/ses_other/messages", { method: "GET" });

      // The opencode SDK substitutes /session/{sessionID} from path.sessionID; an
      // `id`-only path leaves the placeholder literal and fails after ~12s.
      expect(gets).toHaveLength(1);
      expect(gets[0]).toMatchObject({ sessionID: "ses_other" });
      expect(messageReads).toHaveLength(1);
      expect(messageReads[0]).toMatchObject({ sessionID: "ses_other" });
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("opens TUI model selector when direct runtime model switch is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-model-selector-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    let openModelsCalled = 0;
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        tui: {
          async openModels() {
            openModelsCalled += 1;
            return { data: true };
          },
        },
      },
    });

    try {
      const fallback = await requestUnixJsonResult(runtime.socketPath, "/session/ses_selector/model", {
        method: "POST",
        body: { providerID: "happysolve_pub", modelID: "gpt-5.4" },
      });
      expect(fallback).toMatchObject({
        ok: false,
        status: 501,
        body: { error: "model_switch_unavailable", selector_opened: true },
      });

      const opened = await requestUnixJson(runtime.socketPath, "/tui/models", { method: "POST" });
      expect(opened).toEqual({ ok: true, selector_opened: true });
      expect(openModelsCalled).toBe(2);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("closes an open TUI overlay through api.ui.dialog.clear", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-overlay-close-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    let cleared = 0;
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      ui: {
        dialog: {
          clear() {
            cleared += 1;
          },
        },
      },
    });

    try {
      const result = await requestUnixJson(runtime.socketPath, "/tui/overlay/close", { method: "POST" });
      expect(result).toEqual({ ok: true, overlay_closed: true });
      expect(cleared).toBe(1);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("bounds model switch latency when runtime config update hangs", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-model-timeout-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          async setSessionConfigOption() {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      const started = Date.now();
      const result = await requestUnixJsonResult(runtime.socketPath, "/session/ses_timeout/model", {
        method: "POST",
        body: { providerID: "provider", modelID: "model" },
        timeoutMs: 3_000,
      });

      expect(result).toMatchObject({
        ok: false,
        status: 504,
        body: { error: "model_switch_timeout" },
      });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("switches the visible TUI through tui.selectSession so messages refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-select-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const selected: unknown[] = [];
    const navigated: unknown[] = [];
    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      route: { navigate: (name: string, params: unknown) => navigated.push({ name, params }) },
      client: {
        tui: {
          // Reads `this.client` like the real SDK method, so the runtime must
          // call it bound to its owner (regression guard for lost `this`).
          _client: { ok: true },
          async selectSession(this: { _client?: unknown }, input: unknown) {
            if (!this || !this._client) throw new Error("this.client lost");
            selected.push(input);
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      const result = await requestUnixJson(runtime.socketPath, "/tui/session", {
        method: "POST",
        body: { session: "ses_target" },
      });
      expect(result).toMatchObject({ accepted: true, session_id: "ses_target" });
      // Must use the canonical select-session call (which refreshes messages),
      // not the lower-level route.navigate that leaves the list stale.
      expect(selected).toEqual([{ sessionID: "ses_target" }]);
      expect(navigated).toHaveLength(0);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("reports a stuck running session as idle when live status has no busy signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-stuck-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      // Live status returns nothing for the session: the idle event was missed.
      state: { session: { status: () => undefined } },
      client: {
        session: {
          async list() {
            return { data: [{ id: "ses_other", title: "done" }] };
          },
          async promptAsync() {
            return { data: { ok: true } };
          },
        },
      },
    });

    try {
      // Mark the non-current session running (as a prompt would), then list.
      await requestUnixJson(runtime.socketPath, "/session/ses_other/prompt", {
        method: "POST",
        body: { text: "hi" },
      });
      const sessions = (await requestUnixJson(runtime.socketPath, "/sessions")) as Array<{
        id: string;
        status: { state: string };
      }>;
      const target = sessions.find((session) => session.id === "ses_other");
      expect(target?.status.state).toBe("idle");
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });

  test("bounds a hanging session.list with a 504 instead of stalling until Bun idleTimeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-list-timeout-"));
    const runtimeDir = join(root, "runtime");
    cleanup.push(root);
    await mkdir(runtimeDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    const oldSdkTimeout = process.env.OPENCODE_LENS_SDK_TIMEOUT_MS;
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    // Drive the timeout path quickly; the real default is 8s.
    process.env.OPENCODE_LENS_SDK_TIMEOUT_MS = "200";

    const runtime = await startLens({
      app: { version: "1.17.4" },
      directory: root,
      worktree: root,
      project: { id: "project" },
      client: {
        session: {
          // Simulate the opencode server stalling: never resolves.
          list() {
            return new Promise(() => {});
          },
        },
      },
    });

    try {
      const started = Date.now();
      const result = await requestUnixJsonResult(runtime.socketPath, "/sessions", { timeoutMs: 5_000 });
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(504);
        expect(result.body).toMatchObject({ error: "session_list_timeout" });
      }
      // Must resolve well under Bun's 10s idleTimeout (and our 200ms cap).
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      await runtime.cleanup();
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
      if (oldSdkTimeout === undefined) delete process.env.OPENCODE_LENS_SDK_TIMEOUT_MS;
      else process.env.OPENCODE_LENS_SDK_TIMEOUT_MS = oldSdkTimeout;
    }
  });
});

function seedMessages(path: string, sessionID: string) {
  const db = new Database(path);
  try {
    db.exec(`
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
      create table part (
        id text primary key,
        message_id text not null,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
    `);
    db.query(
      "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
    ).run("msg_persisted", sessionID, 1, 1, JSON.stringify({ role: "assistant", time: { created: 1 } }));
    db.query("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run(
      "prt_persisted",
      "msg_persisted",
      sessionID,
      2,
      2,
      JSON.stringify({ type: "text", text: "persisted review" }),
    );
  } finally {
    db.close();
  }
}
