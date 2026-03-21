import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { getPaths } from "../lib/paths.js";
import { ensureDir } from "../lib/fs.js";
import { readDaemonStatus } from "../lib/supervisor.js";

test("readDaemonStatus falls back to live lock or status pids when daemon.pid is stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-supervisor-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  await ensureDir(paths.runDir);

  await writeFile(paths.pidPath, "999999\n", "utf8");
  await writeFile(paths.lockPath, JSON.stringify({ pid: process.pid }), "utf8");
  await writeFile(paths.statusPath, JSON.stringify({ pid: process.pid, phase: "running" }), "utf8");

  const status = await readDaemonStatus(paths);
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  assert.equal(status.status?.phase, "running");
});

test("readDaemonStatus drops stale status payloads from dead pids", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-supervisor-stale-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  await ensureDir(paths.runDir);

  await writeFile(paths.lockPath, JSON.stringify({ pid: process.pid }), "utf8");
  await writeFile(paths.statusPath, JSON.stringify({ pid: 999999, phase: "stale" }), "utf8");

  const status = await readDaemonStatus(paths);
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  assert.equal(status.status, undefined);
});

test("readDaemonStatus does not trust status payloads without a matching live pid", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-supervisor-missing-pid-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  await ensureDir(paths.runDir);

  await writeFile(paths.lockPath, JSON.stringify({ pid: process.pid }), "utf8");
  await writeFile(paths.statusPath, JSON.stringify({ phase: "running-without-pid" }), "utf8");

  const status = await readDaemonStatus(paths);
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  assert.equal(status.status, undefined);
});

test("readDaemonStatus does not report stale status for dead daemons", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-supervisor-dead-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  await ensureDir(paths.runDir);

  await writeFile(paths.pidPath, "999999\n", "utf8");
  await writeFile(paths.statusPath, JSON.stringify({ pid: 999999, phase: "old" }), "utf8");

  const status = await readDaemonStatus(paths);
  assert.equal(status.running, false);
  assert.equal(status.pid, undefined);
  assert.equal(status.status, undefined);
});
