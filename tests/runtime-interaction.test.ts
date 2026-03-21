// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import type { ChatInputCommandInteraction, ButtonInteraction, Channel } from "discord.js";
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

function createMockButtonInteraction(options: {
  guildId?: string;
  channelId?: string;
  userId: string;
  customId: string;
  isThread?: boolean;
}): ButtonInteraction {
  return {
    guildId: options.guildId ?? null,
    channelId: options.channelId ?? null,
    user: { id: options.userId },
    customId: options.customId,
    channel: {
      isThread: () => options.isThread ?? false,
    } as Channel,
    isButton: () => true,
    isChatInputCommand: () => false,
  } as ButtonInteraction;
}

function createMockSlashInteraction(options: {
  guildId?: string;
  channelId?: string;
  userId: string;
  commandName: string;
}): ChatInputCommandInteraction {
  return {
    guildId: options.guildId ?? null,
    channelId: options.channelId ?? null,
    user: { id: options.userId },
    commandName: options.commandName,
    channel: { isThread: () => false } as Channel,
    isButton: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    options: {
      getSubcommand: () => null,
    },
  } as ChatInputCommandInteraction;
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
    ...createMockButtonInteraction({
      guildId: "g1",
      userId: "u1",
      customId: "other:stop:g1__c1__root",
    }),
    reply: async () => {
      replyCalls += 1;
    },
  } as ButtonInteraction);

  assert.equal(abortCalls, 0);
  assert.equal(replyCalls, 0);
});

test("handleInteraction ignores unrelated button ids before auth checks", async () => {
  const daemon = await createDaemon();
  let replyCalls = 0;

  await daemon.handleInteraction({
    ...createMockButtonInteraction({
      guildId: "g9",
      userId: "stranger",
      customId: "other:stop:g1__c1__root",
    }),
    reply: async () => {
      replyCalls += 1;
    },
  } as ButtonInteraction);

  assert.equal(replyCalls, 0);
});

test("handleInteraction handles pi-discord stop buttons", async () => {
  const daemon = await createDaemon();
  let abortedRouteKey: string | undefined;
  daemon.abortRoute = async (routeKey: string) => {
    abortedRouteKey = routeKey;
    return true;
  };

  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;
  await daemon.handleInteraction({
    ...createMockButtonInteraction({
      guildId: "g1",
      channelId: "c1",
      userId: "u1",
      customId: "pi-discord:stop:g1__c1__root",
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ButtonInteraction);

  assert.equal(abortedRouteKey, "g1__c1__root");
  assert.equal(replyPayload?.content, "Stopped.");
  assert.equal(replyPayload?.ephemeral, true);
});

test("handleInteraction replies with auth error for unauthorized guild slash commands", async () => {
  const daemon = await createDaemon();
  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;

  await daemon.handleInteraction({
    ...createMockSlashInteraction({
      guildId: "g9",
      userId: "stranger",
      commandName: "other",
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(replyPayload?.content, "Guild g9 is not allowlisted.");
  assert.equal(replyPayload?.ephemeral, true);
});
