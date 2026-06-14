import { describe, expect, test } from "bun:test";

import { discoverInstances, type DiscoveryFileSystem } from "./discovery";
import type { LensHealth } from "./types";

const health: LensHealth = {
  lens_version: "0.1.0",
  opencode_version: "1.17.4",
  uptime_ms: 10,
  directory: "/repo",
  capabilities: [],
};

describe("discoverInstances", () => {
  test("returns active instances and cleans invalid/dead records", async () => {
    const files = new Map([
      ["/registry/live.json", JSON.stringify(instance(1, "/tmp/live.sock"))],
      ["/registry/dead.json", JSON.stringify(instance(2, "/tmp/dead.sock"))],
      ["/registry/bad.json", "{"],
    ]);
    const removed: string[] = [];
    const fs: DiscoveryFileSystem = {
      async readdir() {
        return ["live.json", "dead.json", "bad.json"];
      },
      async readFile(path) {
        const text = files.get(path);
        if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return text;
      },
      async unlink(path) {
        removed.push(path);
        files.delete(path);
      },
    };

    const result = await discoverInstances({
      instancesDir: "/registry",
      fs,
      async probe(record) {
        if (record.id === "dead") throw new Error("not reachable");
        return health;
      },
    });

    expect(result.active.map((record) => record.id)).toEqual(["live"]);
    expect(removed).toContain("/registry/bad.json");
    expect(removed).toContain("/registry/dead.json");
    expect(removed).toContain("/tmp/dead.sock");
  });
});

function instance(pid: number, socket: string) {
  return {
    pid,
    socket,
    transport: "unix",
    directory: "/repo",
    worktree: "/repo",
    project_id: "proj",
    opencode_version: "1.17.4",
    lens_version: "0.1.0",
    started_at: 1,
  };
}
