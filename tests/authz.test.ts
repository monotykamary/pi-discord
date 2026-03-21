import test from "node:test";
import assert from "node:assert/strict";
import { authorizeInteraction } from "../daemon/authz.js";
import type { PiDiscordConfig } from "../lib/config.js";
import type { Message, ChatInputCommandInteraction, ButtonInteraction } from "discord.js";

function mockMessage(partial: { guildId?: string | null; author: { id: string } }): Message {
  return partial as unknown as Message;
}

function mockInteraction(partial: { guildId: string; user: { id: string } }): ChatInputCommandInteraction {
  return partial as unknown as ChatInputCommandInteraction;
}

test("authorizeInteraction allows guild member when guild is allowlisted", () => {
  const config: PiDiscordConfig = {
    allowedGuildIds: ["g1"],
    adminUserIds: ["admin1"],
    dmAllowlistUserIds: [],
  } as unknown as PiDiscordConfig;

  const result = authorizeInteraction(mockMessage({ guildId: "g1", author: { id: "u1" } }), config);
  assert.equal(result.allowed, true);
  assert.equal(result.canControl, false);
});

test("authorizeInteraction allows control for admin in guild", () => {
  const config: PiDiscordConfig = {
    allowedGuildIds: ["g1"],
    adminUserIds: ["u1"],
    dmAllowlistUserIds: [],
  } as unknown as PiDiscordConfig;

  const result = authorizeInteraction(mockInteraction({ guildId: "g1", user: { id: "u1" } }), config);
  assert.equal(result.allowed, true);
  assert.equal(result.canControl, true);
});

test("authorizeInteraction denies DM for non-allowlisted user", () => {
  const config: PiDiscordConfig = {
    allowedGuildIds: [],
    adminUserIds: [],
    dmAllowlistUserIds: ["u2"],
  } as unknown as PiDiscordConfig;

  const result = authorizeInteraction(mockInteraction({ guildId: null as any, user: { id: "u1" } }), config);
  assert.equal(result.allowed, false);
});
