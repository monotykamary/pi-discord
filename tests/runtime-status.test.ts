// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile } from "node:fs/promises";
import { PiDiscordDaemon } from "../daemon/runtime.js";
import { getPaths } from "../lib/paths.js";
import { createDefaultConfig } from "../lib/config.js";

test("writeStatus preserves bot metadata across later updates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-runtime-status-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  const daemon = new PiDiscordDaemon({ paths, config: createDefaultConfig(paths) });

  await daemon.writeStatus({ phase: "ready", userTag: "bot#1234" });
  await daemon.writeStatus({ phase: "running" });

  const status = JSON.parse(await readFile(paths.statusPath, "utf8"));
  assert.equal(status.phase, "running");
  assert.equal(status.userTag, "bot#1234");
  assert.deepEqual(status.activeRuns, []);
  assert.equal(status.routeCount, 0);
});

test("stop clears active runs before writing stopping status", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-runtime-stop-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  const daemon = new PiDiscordDaemon({
    paths,
    config: createDefaultConfig(paths),
    client: { destroy: async () => undefined },
    logger: {
    log: async () => undefined,
    info: async () => undefined,
    warn: async () => undefined,
    error: async () => undefined,
  },
  });

  daemon.currentRuns.set("route-1", { abort: async () => undefined });
  await daemon.stop();

  const status = JSON.parse(await readFile(paths.statusPath, "utf8"));
  assert.equal(status.phase, "stopping");
  assert.deepEqual(status.activeRuns, []);
});
