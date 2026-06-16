// @bun
// src/discovery.ts
import { readdir, readFile, unlink } from "fs/promises";
import { basename, join as join2 } from "path";

// src/paths.ts
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

// src/registry.ts
var registeredInstanceJsonSchema = {
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
    "started_at"
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
    started_at: { type: "number" }
  }
};
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

// src/discovery.ts
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
// src/types.ts
var LENS_VERSION = "0.1.2";
export {
  registeredInstanceJsonSchema,
  readRegisteredInstanceJson,
  parseRegisteredInstance,
  getSocketPath,
  getLensRuntimeDir,
  getLensDataDir,
  getInstancesDir,
  getInstanceRegistryPath,
  discoverInstances,
  LENS_VERSION
};
