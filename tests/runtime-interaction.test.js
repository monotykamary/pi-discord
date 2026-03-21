import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { PiDiscordDaemon } from "../daemon/runtime.js";
import { getPaths } from "../lib/paths.js";
import { createDefaultConfig } from "../lib/config.js";

function createDaemon() {
  return mkdtemp(path.join(os.tmpdir(), "pi-discord-runtime-interaction-")).then((tempDir) => {
    const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
    const config = createDefaultConfig(paths);
    config.allowedGuildIds = ["g1"];
    config.adminUserIds = ["u1"];
    return new PiDiscordDaemon({ paths, config });
  });
}

test("handleInteraction ignores unrelated button ids", async () => {
  const daemon = await createDaemon();
  let abortCalls = 0;
  daemon.abortRoute = async () => {
    abortCalls += 1;
    return true;
  };

  let replyCalls = 0;
  await daemon.handleInteraction({
    guildId: "g1",
    user: { id: "u1" },
    customId: "other:stop:g1__c1__root",
    isButton: () => true,
    isChatInputCommand: () => false,
    reply: async () => {
      replyCalls += 1;
    },
  });

  assert.equal(abortCalls, 0);
  assert.equal(replyCalls, 0);
});

test("handleInteraction ignores unrelated button ids before auth checks", async () => {
  const daemon = await createDaemon();
  let replyCalls = 0;

  await daemon.handleInteraction({
    guildId: "g9",
    user: { id: "stranger" },
    customId: "other:stop:g1__c1__root",
    isButton: () => true,
    isChatInputCommand: () => false,
    reply: async () => {
      replyCalls += 1;
    },
  });

  assert.equal(replyCalls, 0);
});

test("handleInteraction handles pi-discord stop buttons", async () => {
  const daemon = await createDaemon();
  let abortedRouteKey;
  daemon.abortRoute = async (routeKey) => {
    abortedRouteKey = routeKey;
    return true;
  };

  let replyPayload;
  await daemon.handleInteraction({
    guildId: "g1",
    user: { id: "u1" },
    customId: "pi-discord:stop:g1__c1__root",
    isButton: () => true,
    isChatInputCommand: () => false,
    reply: async (payload) => {
      replyPayload = payload;
    },
  });

  assert.equal(abortedRouteKey, "g1__c1__root");
  assert.equal(replyPayload.content, "Stop requested for g1… / c1… / channel.");
  assert.equal(replyPayload.ephemeral, true);
});

test("handleInteraction ignores unrelated slash commands before auth checks", async () => {
  const daemon = await createDaemon();
  let replyCalls = 0;

  await daemon.handleInteraction({
    guildId: "g9",
    user: { id: "stranger" },
    commandName: "other",
    isButton: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    reply: async () => {
      replyCalls += 1;
    },
  });

  assert.equal(replyCalls, 0);
});
