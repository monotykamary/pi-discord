import { REST, Routes, SlashCommandBuilder } from "discord.js";
import type { PiDiscordConfig } from "./config.js";

export function buildSlashCommands(config: PiDiscordConfig) {
  return [
    new SlashCommandBuilder()
      .setName(config.commandName)
      .setDescription("Interact with the pi Discord route")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("ask")
          .setDescription("Send a prompt to pi")
          .addStringOption((option) => option.setName("text").setDescription("Prompt text").setRequired(true)),
      )
      .addSubcommand((subcommand) => subcommand.setName("status").setDescription("Show route queue status"))
      .addSubcommand((subcommand) => subcommand.setName("stop").setDescription("Stop the active route run"))
      .addSubcommand((subcommand) => subcommand.setName("reset").setDescription("Reset the current route session")),
  ].map((command) => command.toJSON());
}

export interface SyncResult {
  scope: "global" | "guild";
  count: number;
  guildIds?: string[];
}

export async function syncSlashCommands(config: PiDiscordConfig): Promise<SyncResult> {
  const rest = new REST({ version: "10" }).setToken(config.botToken);
  const body = buildSlashCommands(config);

  if (config.registerCommandsGlobally) {
    await rest.put(Routes.applicationCommands(config.applicationId), { body });
    return { scope: "global", count: body.length };
  }

  if (config.allowedGuildIds.length === 0) {
    throw new Error("Set at least one `allowedGuildIds` entry or enable `registerCommandsGlobally`.");
  }

  for (const guildId of config.allowedGuildIds) {
    await rest.put(Routes.applicationGuildCommands(config.applicationId, guildId), { body });
  }
  return { scope: "guild", count: body.length, guildIds: config.allowedGuildIds.slice() };
}
