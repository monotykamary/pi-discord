// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { PiDiscordDaemon } from "../daemon/runtime.js";
import { getPaths } from "../lib/paths.js";
import { createDefaultConfig } from "../lib/config.js";

test("ambient guild messages do not create route state before the bot is engaged", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-runtime-ambient-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  const config = createDefaultConfig(paths);
  config.allowedGuildIds = ["g1"];

  const daemon = new PiDiscordDaemon({
    paths,
    config,
    client: { user: { id: "bot-1" } },
    logger: {
    log: async () => undefined,
    info: async () => undefined,
    warn: async () => undefined,
    error: async () => undefined,
  },
  });

  await daemon.handleMessageCreate({
    id: "m1",
    guildId: "g1",
    channelId: "c1",
    channel: { id: "c1", isThread: () => false },
    author: { id: "u1", username: "alice", bot: false },
    content: "hello there",
    mentions: { users: { has: () => false } },
  });

  assert.equal(daemon.routeContexts.size, 0);
});
