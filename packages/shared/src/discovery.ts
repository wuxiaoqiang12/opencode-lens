import { readdir, readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import { getInstancesDir } from "./paths";
import { readRegisteredInstanceJson } from "./registry";
import type { ActiveInstance, InstanceRecord, LensHealth } from "./types";

export interface DiscoveryFileSystem {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  unlink(path: string): Promise<void>;
}

export interface DiscoverInstancesOptions {
  instancesDir?: string;
  fs?: DiscoveryFileSystem;
  probe(instance: InstanceRecord): Promise<LensHealth>;
}

export interface DiscoverInstancesResult {
  active: ActiveInstance[];
  removed: string[];
  errors: Array<{ registry_path: string; error: string }>;
}

const defaultFs: DiscoveryFileSystem = { readdir, readFile, unlink };

export async function discoverInstances(options: DiscoverInstancesOptions): Promise<DiscoverInstancesResult> {
  const instancesDir = options.instancesDir ?? getInstancesDir();
  const fs = options.fs ?? defaultFs;
  const result: DiscoverInstancesResult = { active: [], removed: [], errors: [] };

  let entries: string[];
  try {
    entries = await fs.readdir(instancesDir);
  } catch (error) {
    if (isNotFound(error)) return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    const registryPath = join(instancesDir, entry);
    const text = await readFileIfExists(fs, registryPath);
    if (text === undefined) continue;

    const parsed = readRegisteredInstanceJson(text);
    if (!parsed) {
      await removePath(fs, registryPath, result);
      continue;
    }

    const record: InstanceRecord = {
      ...parsed,
      id: basename(entry, ".json"),
      registry_path: registryPath,
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

async function readFileIfExists(fs: DiscoveryFileSystem, path: string) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function removePath(fs: DiscoveryFileSystem, path: string, result: DiscoverInstancesResult) {
  try {
    await fs.unlink(path);
    result.removed.push(path);
  } catch (error) {
    if (!isNotFound(error)) result.errors.push({ registry_path: path, error: errorMessage(error) });
  }
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
