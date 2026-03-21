// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { PiDiscordDaemon } from "../daemon/runtime.js";
import { getPaths } from "../lib/paths.js";
import { createDefaultConfig } from "../lib/config.js";

async function createDaemon() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-runtime-scope-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  return new PiDiscordDaemon({ paths, config: createDefaultConfig(paths) });
}

test("resolveScopeFromChannel keeps parent channel and thread identity separate", async () => {
  const daemon = await createDaemon();

  const scope = daemon.resolveScopeFromChannel("g1", "thread-1", {
    id: "thread-1",
    parentId: "channel-1",
    isThread: () => true,
  });

  assert.deepEqual(scope, {
    guildId: "g1",
    channelId: "channel-1",
    threadId: "thread-1",
    routeKey: "g1__channel-1__thread-1",
  });
});

test("resolveScopeFromChannel falls back to channelId when parentId is unavailable", async () => {
  const daemon = await createDaemon();

  const scope = daemon.resolveScopeFromChannel("g1", "thread-1", {
    id: "thread-1",
    isThread: () => true,
  });

  assert.deepEqual(scope, {
    guildId: "g1",
    channelId: "thread-1",
    threadId: "thread-1",
    routeKey: "g1__thread-1__thread-1",
  });
});
