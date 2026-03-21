import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createDefaultConfig, loadConfig, normalizeConfig, saveConfig, validateConfig, type PiDiscordConfig } from "./lib/config.js";
import { syncSlashCommands, type SyncResult } from "./lib/discord-commands.js";
import { pathExists } from "./lib/fs.js";
import { getPaths, type Paths } from "./lib/paths.js";
import { readDaemonLogs, readDaemonStatus, startDaemon, stopDaemon, type StartResult, type StopResult } from "./lib/supervisor.js";

function sendText(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({ customType: "pi-discord", content: text, display: true });
}

function helpText(paths: Paths): string {
  return [
    "`/discord setup` prompts for the Discord token, application id, guild allowlist, and writes the runtime config.",
    "`/discord start` validates config, syncs slash commands when enabled, and launches the detached daemon.",
    "`/discord stop` stops the detached daemon.",
    "`/discord status` shows daemon health, workspace paths, and route activity.",
    "`/discord logs [lines]` tails the daemon log.",
    "`/discord sync-commands` registers or refreshes the Discord slash commands.",
    "`/discord open-config` opens the JSON config in pi's editor and saves it on valid JSON.",
    "",
    `Config: ${paths.configPath}`,
    `Workspace: ${paths.workspaceDir}`,
    `Logs: ${paths.daemonLogPath}`,
  ].join("\n");
}

function parseSubcommand(input: string): { subcommand: string; args: string[] } {
  const [subcommand = "help", ...rest] = input.trim().split(/\s+/).filter(Boolean);
  return { subcommand, args: rest };
}

function isConfigSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

async function loadConfigOrDefault(paths: Paths): Promise<PiDiscordConfig> {
  if (!(await pathExists(paths.configPath))) {
    return createDefaultConfig(paths);
  }

  try {
    return await loadConfig(paths);
  } catch (error) {
    if (!isConfigSyntaxError(error)) throw error;
    return createDefaultConfig(paths);
  }
}

async function tryLoadConfig(paths: Paths): Promise<{ config?: PiDiscordConfig; error?: string }> {
  try {
    return { config: await loadConfig(paths) };
  } catch (error) {
    return { error: String(error) };
  }
}

async function getEditableConfigText(paths: Paths): Promise<string> {
  if (!(await pathExists(paths.configPath))) {
    return JSON.stringify(createDefaultConfig(paths), null, 2);
  }

  try {
    return JSON.stringify(await loadConfig(paths), null, 2);
  } catch (error) {
    if (!isConfigSyntaxError(error)) throw error;
    return readFile(paths.configPath, "utf8");
  }
}

export interface CommandContext {
  hasUI: boolean;
  ui: {
    input: (label: string, value?: string) => Promise<string | null>;
    editor: (title: string, content: string) => Promise<string | null>;
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("discord", {
    description: "Manage the pi Discord bridge: /discord setup|start|stop|status|logs|sync-commands|open-config",
    handler: async (input: string, ctx: CommandContext) => {
      const paths = getPaths();
      const { subcommand, args } = parseSubcommand(input);

      if (subcommand === "help") {
        sendText(pi, helpText(paths));
        return;
      }

      if (subcommand === "setup") {
        if (!ctx.hasUI) {
          sendText(pi, `Interactive setup requires Pi UI. Edit ${paths.configPath} directly or run /discord open-config in interactive mode.`);
          return;
        }
        let config: PiDiscordConfig;
        try {
          config = await loadConfigOrDefault(paths);
        } catch (error) {
          sendText(pi, `Could not read ${paths.configPath}: ${String(error)}`);
          return;
        }
        const token = await ctx.ui.input("Discord bot token", config.botToken || "");
        const applicationId = await ctx.ui.input("Discord application id", config.applicationId || "");
        const guilds = await ctx.ui.input("Allowlisted guild ids (comma separated, blank for all)", config.allowedGuildIds.join(","));

        if (token == null && applicationId == null && guilds == null) {
          return;
        }

        if (token?.trim()) config.botToken = token.trim();
        if (applicationId?.trim()) config.applicationId = applicationId.trim();
        if (guilds != null) {
          const parsed = guilds.split(",").map((value: string) => value.trim()).filter(Boolean);
          if (parsed.length > 0 || guilds.trim() === "") {
            config.allowedGuildIds = parsed;
          }
        }

        const nextConfig = normalizeConfig(paths, config);
        await saveConfig(paths, nextConfig);
        const validation = validateConfig(nextConfig);
        let text = `Saved Discord config to ${paths.configPath}`;
        if (validation.errors.length > 0) {
          text += `\n\nValidation errors:\n- ${validation.errors.join("\n- ")}`;
        } else if (nextConfig.syncCommandsOnStart) {
          const canSync = nextConfig.registerCommandsGlobally || nextConfig.allowedGuildIds.length > 0;
          if (canSync) {
            try {
              const syncResult: SyncResult = await syncSlashCommands(nextConfig);
              text += `\n\nSynced ${syncResult.count} slash command(s) to ${syncResult.scope} scope.`;
            } catch (error) {
              text += `\n\nSlash command sync failed: ${String(error)}`;
            }
          } else {
            text += `\n\nTo enable slash commands, add guild IDs: Discord → Settings → Advanced → Developer Mode, then right-click your server → Copy Server ID. Run /discord setup again or edit ${paths.configPath}.`;
          }
        }
        sendText(pi, text);
        return;
      }

      if (subcommand === "open-config") {
        if (!ctx.hasUI) {
          sendText(pi, `Open ${paths.configPath} in an editor and run /discord start when ready.`);
          return;
        }
        let editableConfigText: string;
        try {
          editableConfigText = await getEditableConfigText(paths);
        } catch (error) {
          sendText(pi, `Could not read ${paths.configPath}: ${String(error)}`);
          return;
        }
        const edited = await ctx.ui.editor("Edit pi-discord config", editableConfigText);
        if (edited == null) return;
        try {
          const parsed = normalizeConfig(paths, JSON.parse(edited));
          await saveConfig(paths, parsed);
          const validation = validateConfig(parsed);
          sendText(pi, validation.errors.length > 0
            ? `Saved ${paths.configPath}\n\nValidation errors:\n- ${validation.errors.join("\n- ")}`
            : `Saved ${paths.configPath}`);
        } catch (error) {
          sendText(pi, `Could not save ${paths.configPath}: ${String(error)}`);
        }
        return;
      }

      if (subcommand === "sync-commands") {
        const loaded = await tryLoadConfig(paths);
        if (loaded.error) {
          sendText(pi, `Could not read ${paths.configPath}: ${loaded.error}\n\nRun /discord open-config to repair it.`);
          return;
        }
        const validation = validateConfig(loaded.config!);
        if (validation.errors.length > 0) {
          sendText(pi, `Config errors:\n- ${validation.errors.join("\n- ")}`);
          return;
        }
        try {
          const result = await syncSlashCommands(loaded.config!);
          sendText(pi, `Synced ${result.count} slash command(s) to ${result.scope} scope.`);
        } catch (error) {
          sendText(pi, `Slash command sync failed: ${String(error)}`);
        }
        return;
      }

      if (subcommand === "start") {
        const loaded = await tryLoadConfig(paths);
        if (loaded.error) {
          sendText(pi, `Could not read ${paths.configPath}: ${loaded.error}\n\nRun /discord open-config to repair it.`);
          return;
        }
        const validation = validateConfig(loaded.config!);
        if (validation.errors.length > 0) {
          sendText(pi, `Config errors:\n- ${validation.errors.join("\n- ")}`);
          return;
        }
        if (loaded.config!.syncCommandsOnStart) {
          const canSync = loaded.config!.registerCommandsGlobally || loaded.config!.allowedGuildIds.length > 0;
          if (canSync) {
            try {
              await syncSlashCommands(loaded.config!);
            } catch (error) {
              sendText(pi, `Slash command sync failed: ${String(error)}`);
              return;
            }
          }
        }
        const result: StartResult = await startDaemon(paths);
        sendText(pi, result.started
          ? `Started pi-discord daemon as pid ${result.pid}.\nWorkspace: ${paths.workspaceDir}`
          : result.reason!);
        return;
      }

      if (subcommand === "stop") {
        const result: StopResult = await stopDaemon(paths);
        sendText(pi, result.stopped ? `Stopped pi-discord daemon pid ${result.pid}.` : result.reason!);
        return;
      }

      if (subcommand === "status") {
        const daemon = await readDaemonStatus(paths);
        const configExists = await pathExists(paths.configPath);
        const loaded = configExists ? await tryLoadConfig(paths) : { config: createDefaultConfig(paths) };
        const validation = loaded.config ? validateConfig(loaded.config) : { errors: [], warnings: [] };
        const statusText = [
          `Running: ${daemon.running ? "yes" : "no"}`,
          daemon.pid ? `PID: ${daemon.pid}` : undefined,
          daemon.status?.phase ? `Phase: ${daemon.status.phase}` : undefined,
          daemon.status?.userTag ? `Bot user: ${daemon.status.userTag}` : undefined,
          daemon.status?.routeCount !== undefined ? `Known routes: ${daemon.status.routeCount}` : undefined,
          daemon.status?.activeRuns?.length ? `Active runs: ${daemon.status.activeRuns.join(", ")}` : undefined,
          `Config: ${paths.configPath}`,
          `Workspace: ${paths.workspaceDir}`,
          `Log: ${paths.daemonLogPath}`,
          loaded.error ? `Config read error: ${loaded.error}` : undefined,
          validation.errors.length ? `Config errors: ${validation.errors.join("; ")}` : undefined,
          validation.warnings.length ? `Config warnings: ${validation.warnings.join("; ")}` : undefined,
        ].filter(Boolean).join("\n");
        sendText(pi, statusText);
        return;
      }

      if (subcommand === "logs") {
        const requestedLines = Number(args[0] ?? "80");
        const lineCount = Number.isInteger(requestedLines) && requestedLines > 0
          ? Math.min(requestedLines, 500)
          : 80;
        const logs = await readDaemonLogs(paths, lineCount);
        sendText(pi, logs ? `Last log lines from ${paths.daemonLogPath}:\n\n${logs}` : `No daemon logs yet at ${paths.daemonLogPath}`);
        return;
      }

      sendText(pi, helpText(paths));
    },
  });
}
