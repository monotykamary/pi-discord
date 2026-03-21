// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import type { ChatInputCommandInteraction, ButtonInteraction, Channel } from "discord.js";
import { PiDiscordDaemon } from "../daemon/runtime.js";
import { getPaths, getRoutePaths } from "../lib/paths.js";
import { createDefaultConfig } from "../lib/config.js";
import type { RouteContext } from "../daemon/runtime/types.js";

function createMockInteraction(options: {
  guildId?: string;
  channelId: string;
  userId: string;
  commandName: string;
  subcommand?: string | null;
  isThread?: boolean;
  parentId?: string | null;
}): ChatInputCommandInteraction {
  return {
    guildId: options.guildId ?? null,
    channelId: options.channelId,
    user: { id: options.userId },
    commandName: options.commandName,
    options: {
      getSubcommand: () => options.subcommand ?? null,
    },
    channel: {
      isThread: () => options.isThread ?? false,
      parentId: options.parentId ?? null,
    } as Channel,
    isButton: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
  } as ChatInputCommandInteraction;
}

function createDaemonWithConfig(configOverrides: Record<string, unknown> = {}) {
  return mkdtemp(path.join(os.tmpdir(), "pi-discord-reset-")).then((tempDir) => {
    const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
    const config = createDefaultConfig(paths);
    config.allowedGuildIds = ["g1"];
    config.adminUserIds = ["admin1"];
    config.dmAllowlistUserIds = ["dmuser1"];
    Object.assign(config, configOverrides);
    return { daemon: new PiDiscordDaemon({ paths, config }), paths, config };
  });
}

test("reset command requires admin privileges", async () => {
  const { daemon } = await createDaemonWithConfig();
  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;

  await daemon.handleInteraction({
    ...createMockInteraction({
      guildId: "g1",
      channelId: "c1",
      userId: "regular-user",
      commandName: "reset",
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(replyPayload?.content, "Only admin Discord user ids may reset routes.");
  assert.equal(replyPayload?.ephemeral, true);
});

test("reset command returns error when no route exists", async () => {
  const { daemon } = await createDaemonWithConfig();
  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;

  await daemon.handleInteraction({
    ...createMockInteraction({
      guildId: "g1",
      channelId: "c1",
      userId: "admin1",
      commandName: "reset",
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(replyPayload?.content, "No active route to reset.");
  assert.equal(replyPayload?.ephemeral, true);
});

test("soft reset clears memory, journal, and cancels queued items", async () => {
  const { daemon, paths } = await createDaemonWithConfig();
  const scope = { guildId: "g1", channelId: "c1", threadId: null as string | null, routeKey: "g1__c1__root" };
  const routePaths = getRoutePaths(paths, scope.routeKey);

  // Create the route by ensuring it exists
  const route = await daemon.ensureRoute(scope);

  // Populate some state
  await route.host.dispose(); // No active session yet
  await writeFile(route.manifest.memoryPath, "some memory content", "utf8");
  await route.journal.append({ kind: "test", text: "test entry" });
  await route.queue.enqueue({
    source: {
      kind: "message" as const,
      sourceId: "msg-1",
      userId: "u1",
      guildId: "g1",
      channelId: "c1",
      threadId: null,
      trigger: "mention",
    },
    payload: { rawText: "test", promptText: "test", attachments: [] },
  });

  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;
  await daemon.handleInteraction({
    ...createMockInteraction({
      guildId: "g1",
      channelId: "c1",
      userId: "admin1",
      commandName: "reset",
      subcommand: "soft",
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(replyPayload?.content, "Route reset (soft) complete.");
  assert.equal(replyPayload?.ephemeral, true);

  // Verify memory is cleared
  const { readFile } = await import("node:fs/promises");
  const memoryContent = await readFile(route.manifest.memoryPath, "utf8");
  assert.equal(memoryContent, "");

  // Verify journal is cleared
  assert.equal(route.journal.entries.length, 0);

  // Verify queued items are cancelled
  const queuedItems = route.queue.list().filter((item) => item.state === "queued");
  assert.equal(queuedItems.length, 0);
  const cancelledItems = route.queue.list().filter((item) => item.state === "cancelled");
  assert.equal(cancelledItems.length, 1);

  // Verify route context was removed
  assert.equal(daemon.routeContexts.has(scope.routeKey), false);
});

test("hard reset wipes workspace directory", async () => {
  const { daemon, paths } = await createDaemonWithConfig();
  const scope = { guildId: "g1", channelId: "c1", threadId: null as string | null, routeKey: "g1__c1__root" };
  const routePaths = getRoutePaths(paths, scope.routeKey);

  // Create the route
  const route = await daemon.ensureRoute(scope);
  await route.host.dispose();

  // Create a file in the workspace
  const workspaceFile = path.join(routePaths.dedicatedExecutionRoot, "test-file.txt");
  await mkdir(routePaths.dedicatedExecutionRoot, { recursive: true });
  await writeFile(workspaceFile, "test content", "utf8");

  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;
  await daemon.handleInteraction({
    ...createMockInteraction({
      guildId: "g1",
      channelId: "c1",
      userId: "admin1",
      commandName: "reset",
      subcommand: "hard",
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(replyPayload?.content, "Route reset (hard) complete.");

  // Verify workspace was wiped and recreated
  const { access, readdir } = await import("node:fs/promises");
  try {
    await access(workspaceFile);
    assert.fail("Workspace file should have been deleted");
  } catch (error) {
    // Expected - file should not exist
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  }

  // Workspace dir should exist but be empty
  const workspaceContents = await readdir(routePaths.dedicatedExecutionRoot).catch(() => []);
  assert.equal(workspaceContents.length, 0);
});

test("factory reset clears manifest session references", async () => {
  const { daemon, paths } = await createDaemonWithConfig();
  const scope = { guildId: "g1", channelId: "c1", threadId: null as string | null, routeKey: "g1__c1__root" };

  // Create the route
  const route = await daemon.ensureRoute(scope);
  await route.host.dispose();

  // Set manifest state that should be cleared
  route.manifest.sessionFile = "/some/session/file.json";
  route.manifest.primaryMessageId = "msg-123";
  route.manifest.detailsThreadId = "thread-456";
  await daemon.registry.saveManifest(route.manifest);

  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;
  await daemon.handleInteraction({
    ...createMockInteraction({
      guildId: "g1",
      channelId: "c1",
      userId: "admin1",
      commandName: "reset",
      subcommand: "factory",
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(replyPayload?.content, "Route reset (factory) complete.");

  // Reload manifest to verify it was saved
  const reloadedManifest = await daemon.registry.loadManifest(scope.routeKey);
  assert.equal(reloadedManifest?.sessionFile, undefined);
  assert.equal(reloadedManifest?.primaryMessageId, undefined);
  assert.equal(reloadedManifest?.detailsThreadId, undefined);
});

test("reset with threadId in thread channel", async () => {
  const { daemon } = await createDaemonWithConfig();
  const threadId = "t1";
  const parentChannelId = "c1";
  const scope = { guildId: "g1", channelId: parentChannelId, threadId, routeKey: "g1__c1__t1" };

  // Create the route in a thread
  const route = await daemon.ensureRoute(scope);
  await route.host.dispose();
  await writeFile(route.manifest.memoryPath, "memory", "utf8");

  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;
  await daemon.handleInteraction({
    ...createMockInteraction({
      guildId: "g1",
      channelId: threadId, // Discord reports threadId as channelId in threads
      userId: "admin1",
      commandName: "reset",
      subcommand: "soft",
      isThread: true,
      parentId: parentChannelId,
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(replyPayload?.content, "Route reset (soft) complete.");
  assert.equal(daemon.routeContexts.has(scope.routeKey), false);
});

test("reset aborts active runs before cleanup", async () => {
  const { daemon } = await createDaemonWithConfig();
  const scope = { guildId: "g1", channelId: "c1", threadId: null as string | null, routeKey: "g1__c1__root" };

  // Create route
  const route = await daemon.ensureRoute(scope);

  // Mock an active run
  let abortCalled = false;
  daemon.currentRuns.set(scope.routeKey, {
    abort: async () => {
      abortCalled = true;
    },
  });

  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;
  await daemon.handleInteraction({
    ...createMockInteraction({
      guildId: "g1",
      channelId: "c1",
      userId: "admin1",
      commandName: "reset",
      subcommand: "soft",
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(abortCalled, true);
  assert.equal(daemon.currentRuns.has(scope.routeKey), false);
});

test("reset defaults to soft when no subcommand provided", async () => {
  const { daemon } = await createDaemonWithConfig();
  const scope = { guildId: "g1", channelId: "c1", threadId: null as string | null, routeKey: "g1__c1__root" };

  // Create the route
  const route = await daemon.ensureRoute(scope);
  await route.host.dispose();
  await writeFile(route.manifest.memoryPath, "content", "utf8");

  let replyPayload: { content?: string; ephemeral?: boolean } | undefined;
  await daemon.handleInteraction({
    ...createMockInteraction({
      guildId: "g1",
      channelId: "c1",
      userId: "admin1",
      commandName: "reset",
      subcommand: null, // No subcommand provided
    }),
    reply: async (payload: { content?: string; ephemeral?: boolean }) => {
      replyPayload = payload;
    },
  } as ChatInputCommandInteraction);

  assert.equal(replyPayload?.content, "Route reset (soft) complete.");

  // Verify soft reset behavior (memory cleared)
  const { readFile } = await import("node:fs/promises");
  const memoryContent = await readFile(route.manifest.memoryPath, "utf8");
  assert.equal(memoryContent, "");
});
