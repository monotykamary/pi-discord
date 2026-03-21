import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { ensureDir, tailFile } from "./fs.js";
import type { Paths } from "./paths.js";

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function readNumericFile(filePath: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(filePath, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  status?: {
    pid?: number;
    phase?: string;
    userTag?: string;
    routeCount?: number;
    activeRuns?: string[];
  };
}

export async function readDaemonStatus(paths: Paths): Promise<DaemonStatus> {
  const [pidFilePid, lockState, status] = await Promise.all([
    readNumericFile(paths.pidPath),
    readJsonFile(paths.lockPath) as Promise<{ pid?: number } | undefined>,
    readJsonFile(paths.statusPath) as Promise<{ pid?: number } | undefined>,
  ]);

  const candidates = [
    typeof lockState?.pid === "number" ? lockState.pid : undefined,
    typeof status?.pid === "number" ? status.pid : undefined,
    pidFilePid,
  ].filter((pid): pid is number => Number.isInteger(pid) && pid !== undefined && pid > 0);

  const livePid = candidates.find((pid) => isProcessAlive(pid));
  return {
    running: Boolean(livePid),
    pid: livePid,
    status: livePid && status?.pid === livePid ? status : undefined,
  };
}

export interface StartResult {
  started: boolean;
  pid?: number;
  reason?: string;
}

export async function startDaemon(paths: Paths): Promise<StartResult> {
  const state = await readDaemonStatus(paths);
  if (state.running) {
    return { started: false, reason: `Daemon already running as pid ${state.pid}.` };
  }

  await ensureDir(paths.runDir);
  const child = spawn(process.execPath, [paths.daemonEntry, "--workspace", paths.workspaceDir], {
    cwd: paths.packageRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  await writeFile(paths.pidPath, `${child.pid}\n`, "utf8");
  return { started: true, pid: child.pid };
}

export interface StopResult {
  stopped: boolean;
  pid?: number;
  reason?: string;
}

export async function stopDaemon(paths: Paths): Promise<StopResult> {
  const state = await readDaemonStatus(paths);
  if (!state.running || !state.pid) {
    return { stopped: false, reason: "Daemon is not running." };
  }
  try {
    process.kill(state.pid, "SIGTERM");
    return { stopped: true, pid: state.pid };
  } catch (error: any) {
    if (error?.code === "ESRCH") return { stopped: false, reason: "Daemon is no longer running." };
    throw error;
  }
}

export async function readDaemonLogs(paths: Paths, lines: number = 80): Promise<string> {
  return tailFile(paths.daemonLogPath, lines);
}
