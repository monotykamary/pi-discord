#!/usr/bin/env tsx
import { open, readFile } from "node:fs/promises";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { loadConfig, validateConfig, type PiDiscordConfig } from "../lib/config.js";
import { ensureDir, removeIfExists } from "../lib/fs.js";
import { getPaths, type Paths } from "../lib/paths.js";
import { PiDiscordDaemon } from "../daemon/runtime.js";
import { Logger } from "../daemon/logger.js";

function parseArgs(argv: string[]): { workspace?: string } {
  let workspace: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--workspace") {
      workspace = argv[index + 1];
      index += 1;
    }
  }
  return { workspace };
}

const args = parseArgs(process.argv.slice(2));
const paths: Paths = getPaths({ workspaceDir: args.workspace });
const config: PiDiscordConfig = await loadConfig(paths);
const validation = validateConfig(config);
if (validation.errors.length > 0) {
  throw new Error(`Invalid pi-discord config:\n- ${validation.errors.join("\n- ")}`);
}

await ensureDir(paths.runDir);

let lockHandle: import("node:fs/promises").FileHandle;
try {
  lockHandle = await open(paths.lockPath, "wx");
} catch (error: any) {
  if (error?.code === "EEXIST") {
    let previous: { pid?: number } | undefined;
    try {
      previous = JSON.parse(await readFile(paths.lockPath, "utf8"));
    } catch {
      previous = undefined;
    }

    if (previous?.pid) {
      try {
        process.kill(previous.pid, 0);
        throw new Error(`pi-discord daemon already running as pid ${previous.pid}`);
      } catch (pidError: any) {
        if (pidError?.code !== "ESRCH") throw pidError;
      }
    }

    await removeIfExists(paths.lockPath);
    lockHandle = await open(paths.lockPath, "wx");
  } else {
    throw error;
  }
}
await lockHandle.writeFile(JSON.stringify({ pid: process.pid }));
await lockHandle.close();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const logger = new Logger(paths.daemonLogPath);
const daemon = new PiDiscordDaemon({ paths, config, client, logger });

const shutdown = async (exitCode = 0) => {
  await daemon.stop().catch(() => undefined);
  process.exit(exitCode);
};

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});
process.on("uncaughtException", (error) => {
  console.error(error);
  void shutdown(1);
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  void shutdown(1);
});

try {
  await daemon.start();
} catch (error) {
  console.error(error);
  await daemon.stop().catch(() => undefined);
  process.exit(1);
}
