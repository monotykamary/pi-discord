import type { Message, ChatInputCommandInteraction, ButtonInteraction } from "discord.js";
import type { PiDiscordConfig } from "../lib/config.js";

export interface AuthorizationResult {
  allowed: boolean;
  canControl?: boolean;
  reason?: string;
}

export function authorizeInteraction(
  subject: Message | ChatInputCommandInteraction | ButtonInteraction,
  config: PiDiscordConfig,
): AuthorizationResult {
  const guildId = "guildId" in subject ? subject.guildId ?? null : null;
  const userId = getUserId(subject);

  if (!userId) {
    return { allowed: false, reason: "Missing requester identity." };
  }

  if (!guildId) {
    if (config.dmAllowlistUserIds.includes(userId)) {
      return { allowed: true, canControl: config.adminUserIds.includes(userId) };
    }
    return { allowed: false, reason: "Direct messages are restricted to allowlisted Discord user ids." };
  }

  if (config.allowedGuildIds.length > 0 && !config.allowedGuildIds.includes(guildId)) {
    return { allowed: false, reason: `Guild ${guildId} is not allowlisted.` };
  }

  return {
    allowed: true,
    canControl: config.adminUserIds.includes(userId),
  };
}

function getUserId(subject: Message | ChatInputCommandInteraction | ButtonInteraction): string | undefined {
  return (subject as Message).author?.id ?? (subject as ChatInputCommandInteraction | ButtonInteraction).user?.id;
}
