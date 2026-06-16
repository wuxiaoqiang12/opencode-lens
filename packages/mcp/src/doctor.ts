import { access, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { discoverInstances, getInstancesDir, getLensRuntimeDir, LENS_VERSION, type ActiveInstance, type LensHealth } from "@opencode-lens/shared";

import { requestUnixJson } from "./lens-http";

type CheckStatus = "pass" | "warn" | "fail";

type DoctorCheck = {
  name: string;
  status: CheckStatus;
  message: string;
  details?: unknown;
};

type DoctorReport = {
  version: string;
  node: string;
  platform: string;
  checks: DoctorCheck[];
  instances: Array<{
    pid: number;
    directory: string;
    socket: string;
    lens_version: string;
    opencode_version: string;
  }>;
};

export async function runDoctor(options: { json?: boolean } = {}) {
  const report = await buildDoctorReport();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  process.stdout.write(formatDoctorReport(report));
  return report;
}

export async function buildDoctorReport(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "mcp-version", status: "pass", message: `opencode-lens-mcp ${LENS_VERSION}` });
  checks.push(checkNodeVersion());
  checks.push(await checkCommandOnPath("node"));
  checks.push(await checkCommandOnPath("bun"));

  const instancesDir = getInstancesDir();
  const runtimeDir = getLensRuntimeDir();
  checks.push(await checkDirectory("instances-dir", instancesDir));
  checks.push(await checkDirectory("runtime-dir", runtimeDir));

  const discovery = await discoverInstances({ probe: (instance) => requestUnixJson<LensHealth>(instance.socket, "/health", { timeoutMs: 1_500 }) });
  if (discovery.active.length > 0) {
    checks.push({ name: "active-instances", status: "pass", message: `${discovery.active.length} active opencode-lens instance(s)` });
  } else {
    checks.push({ name: "active-instances", status: "warn", message: "no active opencode-lens instances found" });
  }
  if (discovery.removed.length > 0) {
    checks.push({ name: "stale-registry", status: "warn", message: `removed ${discovery.removed.length} stale registry/socket path(s)`, details: discovery.removed });
  }
  if (discovery.errors.length > 0) {
    checks.push({ name: "discovery-errors", status: "warn", message: `${discovery.errors.length} discovery error(s)`, details: discovery.errors });
  }

  checks.push(await checkOpencodeTuiConfig());
  checks.push(await checkHermesMcpConfig());

  return {
    version: LENS_VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    checks,
    instances: discovery.active.map(instanceSummary),
  };
}

function checkNodeVersion(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) return { name: "node-version", status: "pass", message: process.version };
  return { name: "node-version", status: "fail", message: `${process.version} is too old; use Node.js 20+` };
}

async function checkCommandOnPath(command: string): Promise<DoctorCheck> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await exists(candidate)) return { name: `${command}-on-path`, status: "pass", message: candidate };
  }

  const status: CheckStatus = command === "bun" ? "warn" : "fail";
  return { name: `${command}-on-path`, status, message: `${command} not found on PATH` };
}

async function checkDirectory(name: string, path: string): Promise<DoctorCheck> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return { name, status: "pass", message: path };
    return { name, status: "fail", message: `${path} exists but is not a directory` };
  } catch {
    return { name, status: "warn", message: `${path} does not exist yet` };
  }
}

async function checkOpencodeTuiConfig(): Promise<DoctorCheck> {
  const path = join(homeDir(), ".config", "opencode", "tui.json");
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as { plugin?: unknown };
    const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
    if (plugins.includes("opencode-lens")) return { name: "opencode-tui-config", status: "pass", message: `${path} includes opencode-lens` };
    return { name: "opencode-tui-config", status: "warn", message: `${path} does not include opencode-lens` };
  } catch (error) {
    return { name: "opencode-tui-config", status: "warn", message: `${path} not readable: ${errorMessage(error)}` };
  }
}

async function checkHermesMcpConfig(): Promise<DoctorCheck> {
  const path = join(homeDir(), ".hermes", "config.yaml");
  try {
    const text = await readFile(path, "utf8");
    if (!text.includes("opencode-lens")) return { name: "hermes-mcp-config", status: "warn", message: `${path} has no opencode-lens entry` };
    if (text.includes("opencode-lens-mcp@latest") || text.includes("opencode-lens-mcp.js")) {
      return { name: "hermes-mcp-config", status: "pass", message: `${path} contains opencode-lens MCP config` };
    }
    return { name: "hermes-mcp-config", status: "warn", message: `${path} mentions opencode-lens but command is not recognized` };
  } catch (error) {
    return { name: "hermes-mcp-config", status: "warn", message: `${path} not readable: ${errorMessage(error)}` };
  }
}

function instanceSummary(instance: ActiveInstance) {
  return {
    pid: instance.pid,
    directory: instance.directory,
    socket: instance.socket,
    lens_version: instance.health.lens_version,
    opencode_version: instance.health.opencode_version,
  };
}

function formatDoctorReport(report: DoctorReport) {
  const lines = [`opencode-lens doctor`, `version: ${report.version}`, `node: ${report.node}`, `platform: ${report.platform}`, "", "Checks:"];
  for (const check of report.checks) lines.push(`${icon(check.status)} ${check.name}: ${check.message}`);
  lines.push("", "Instances:");
  if (report.instances.length === 0) {
    lines.push("- none");
  } else {
    for (const instance of report.instances) {
      lines.push(`- pid=${instance.pid} lens=${instance.lens_version} opencode=${instance.opencode_version} dir=${instance.directory}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function icon(status: CheckStatus) {
  if (status === "pass") return "[ok]";
  if (status === "warn") return "[warn]";
  return "[fail]";
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function homeDir() {
  return process.env.HOME ?? process.env.USERPROFILE ?? ".";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
