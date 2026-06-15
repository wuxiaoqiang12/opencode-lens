import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tools } from "./tools";

describe("mcp tools", () => {
  const cleanup: string[] = [];

  afterAll(async () => {
    await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })));
  });

  test("instances_list stays compact and sessions_list fetches limited sessions explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-lens-mcp-tools-"));
    const dataHome = join(root, "data");
    const runtimeDir = join(root, "runtime");
    const socketPath = join(runtimeDir, "opencode-lens", "12345.sock");
    const instancesDir = join(dataHome, "opencode-lens", "instances");
    cleanup.push(root);
    await mkdir(join(runtimeDir, "opencode-lens"), { recursive: true });
    await mkdir(instancesDir, { recursive: true });

    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const sessionPayload = Array.from({ length: 200 }, (_, index) => ({
      id: `ses_${index}`,
      title: `historical session ${index}`,
      status: { session_id: `ses_${index}`, state: "idle", updated_at: index },
    }));
    const seenPaths: string[] = [];
    const server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        const url = new URL(request.url);
        seenPaths.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/health") {
          return Response.json({
            lens_version: "0.1.1",
            opencode_version: "1.17.7",
            uptime_ms: 123,
            directory: root,
            capabilities: [],
          });
        }
        if (url.pathname === "/sessions") {
          const limit = Number(url.searchParams.get("limit") || "20");
          return Response.json(sessionPayload.slice(0, limit));
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    await writeFile(
      join(instancesDir, "12345.json"),
      `${JSON.stringify({
        pid: 12345,
        socket: socketPath,
        transport: "unix",
        directory: root,
        worktree: root,
        project_id: "project",
        opencode_version: "1.17.7",
        lens_version: "0.1.1",
        started_at: 1,
      })}\n`,
    );

    try {
      const instancesList = tools.find((tool) => tool.definition.name === "instances_list");
      const sessionsList = tools.find((tool) => tool.definition.name === "sessions_list");
      expect(instancesList).toBeDefined();
      expect(sessionsList).toBeDefined();

      const listed = (await instancesList!.call({})) as { instances: Array<Record<string, unknown>> };
      expect(listed.instances).toHaveLength(1);
      expect(listed.instances[0]?.pid).toBe(12345);
      expect(listed.instances[0]?.sessions).toBeUndefined();
      expect(seenPaths).toEqual(["/health"]);
      expect(JSON.stringify(listed).length).toBeLessThan(2_000);

      const sessions = (await sessionsList!.call({ instance: "12345", limit: 3 })) as {
        sessions: Array<Record<string, unknown>>;
        limit: number;
      };
      expect(sessions.limit).toBe(3);
      expect(sessions.sessions.map((session) => session.id)).toEqual(["ses_0", "ses_1", "ses_2"]);
      expect(seenPaths).toEqual(["/health", "/health", "/sessions?limit=3"]);
    } finally {
      server.stop(true);
      process.env.XDG_DATA_HOME = oldDataHome;
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
  });
});
