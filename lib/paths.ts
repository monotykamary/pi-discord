import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSegment } from "./fs.js";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export interface PathsOptions {
  agentDir?: string;
  workspaceDir?: string;
}

export interface Paths {
  packageRoot: string;
  agentDir: string;
  workspaceDir: string;
  configPath: string;
  runDir: string;
  logsDir: string;
  routesDir: string;
  routeWorkspacesDir: string;
  daemonLogPath: string;
  statusPath: string;
  pidPath: string;
  lockPath: string;
  registryPath: string;
  daemonEntry: string;
}

export interface RoutePaths {
  routeDir: string;
  manifestPath: string;
  queuePath: string;
  journalPath: string;
  sessionsDir: string;
  inboundAttachmentsDir: string;
  dedicatedExecutionRoot: string;
  sharedMemoryPath: string;
}

export function getPaths(options: PathsOptions = {}): Paths {
  const agentDir = options.agentDir ?? path.join(homedir(), ".pi", "agent");
  const workspaceDir = options.workspaceDir ?? path.join(agentDir, "pi-discord");
  return {
    packageRoot,
    agentDir,
    workspaceDir,
    configPath: path.join(workspaceDir, "config.json"),
    runDir: path.join(workspaceDir, "run"),
    logsDir: path.join(workspaceDir, "logs"),
    routesDir: path.join(workspaceDir, "routes"),
    routeWorkspacesDir: path.join(workspaceDir, "workspaces"),
    daemonLogPath: path.join(workspaceDir, "logs", "daemon.log"),
    statusPath: path.join(workspaceDir, "run", "status.json"),
    pidPath: path.join(workspaceDir, "run", "daemon.pid"),
    lockPath: path.join(workspaceDir, "run", "daemon.lock"),
    registryPath: path.join(workspaceDir, "routes", "registry.json"),
    daemonEntry: path.join(packageRoot, "bin", "pi-discord-daemon.mjs"),
  };
}

export function getRoutePaths(paths: Paths, routeKey: string): RoutePaths {
  const routeSlug = sanitizeSegment(routeKey);
  const routeDir = path.join(paths.routesDir, routeSlug);
  return {
    routeDir,
    manifestPath: path.join(routeDir, "manifest.json"),
    queuePath: path.join(routeDir, "queue.json"),
    journalPath: path.join(routeDir, "journal.jsonl"),
    sessionsDir: path.join(routeDir, "sessions"),
    inboundAttachmentsDir: path.join(routeDir, "attachments", "inbound"),
    dedicatedExecutionRoot: path.join(paths.routeWorkspacesDir, routeSlug),
    sharedMemoryPath: path.join(routeDir, "route-memory.md"),
  };
}
