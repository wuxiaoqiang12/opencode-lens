import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR = "opencode-lens";

export interface LensPathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function getLensDataDir(options: LensPathOptions = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), APP_DIR);
}

export function getLensRuntimeDir(options: LensPathOptions = {}) {
  const env = options.env ?? process.env;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, APP_DIR);
  return join(getLensDataDir(options), "sockets");
}

export function getInstancesDir(options: LensPathOptions = {}) {
  return join(getLensDataDir(options), "instances");
}

export function getInstanceRegistryPath(pid = process.pid, options: LensPathOptions = {}) {
  return join(getInstancesDir(options), `${pid}.json`);
}

export function getSocketPath(pid = process.pid, options: LensPathOptions = {}) {
  return join(getLensRuntimeDir(options), `${pid}.sock`);
}
