import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import piDiscordExtension from "../index.js";
import { ensureDir, pathExists } from "../lib/fs.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function createMockPi(messages: unknown[] = []): ExtensionAPI & { definition?: any; name?: string } {
  return {
    sendMessage(message: any) {
      messages.push(message);
    },
    registerCommand(name: string, definition: any) {
      (this as any).name = name;
      (this as any).definition = definition;
    },
    on: () => undefined as any,
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
  } as unknown as ExtensionAPI & { definition?: any; name?: string };
}

test("/discord status does not create a config file when none exists", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const messages: unknown[] = [];
  const pi = createMockPi(messages);

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("status", { hasUI: false });

    const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
    assert.equal(await pathExists(configPath), false);
    assert.match((messages.at(-1) as any).content, /Config errors: Missing `botToken`\.; Missing `applicationId`\./);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("/discord open-config can open malformed JSON for repair", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-malformed-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
  await ensureDir(path.dirname(configPath));
  await writeFile(configPath, '{\n  "botToken": "abc",\n', "utf8");

  let editorText: string | undefined;
  const pi = createMockPi();

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("open-config", {
      hasUI: true,
      ui: {
        editor: async (_title: string, text: string) => {
          editorText = text;
          return null;
        },
      },
    });

    assert.equal(editorText, '{\n  "botToken": "abc",\n');
  } finally {
    process.env.HOME = originalHome;
  }
});

test("/discord setup without UI does not create config as a side effect", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-setup-no-ui-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const messages: unknown[] = [];
  const pi = createMockPi(messages);

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("setup", { hasUI: false });

    const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
    assert.equal(await pathExists(configPath), false);
    assert.match((messages.at(-1) as any).content, /Interactive setup requires Pi UI/);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("/discord setup falls back to defaults when existing config JSON is malformed", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-setup-malformed-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
  await ensureDir(path.dirname(configPath));
  await writeFile(configPath, '{\n  "botToken": "abc",\n', "utf8");

  const prompts: Array<{ label: string; value: string }> = [];
  const pi = createMockPi();

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("setup", {
      hasUI: true,
      ui: {
        input: async (label: string, value?: string) => {
          prompts.push({ label, value: value || "" });
          return null;
        },
      },
    });

    assert.deepEqual(prompts, [
      { label: "Discord bot token", value: "" },
      { label: "Discord application id", value: "" },
      { label: "Allowlisted guild ids (comma separated, blank for all)", value: "" },
    ]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("/discord setup full cancel does not overwrite malformed config", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-setup-cancel-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
  const originalText = '{\n  "botToken": "abc",\n';
  await ensureDir(path.dirname(configPath));
  await writeFile(configPath, originalText, "utf8");

  const pi = createMockPi();

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("setup", {
      hasUI: true,
      ui: {
        input: async () => null,
      },
    });

    assert.equal(await readFile(configPath, "utf8"), originalText);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("/discord status reports malformed config instead of crashing", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-status-malformed-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
  await ensureDir(path.dirname(configPath));
  await writeFile(configPath, '{\n  "botToken": "abc",\n', "utf8");

  const messages: unknown[] = [];
  const pi = createMockPi(messages);

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("status", { hasUI: false });

    assert.match((messages.at(-1) as any).content, /Config read error:/);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("/discord start reports malformed config instead of crashing", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-start-malformed-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
  await ensureDir(path.dirname(configPath));
  await writeFile(configPath, '{\n  "botToken": "abc",\n', "utf8");

  const messages: unknown[] = [];
  const pi = createMockPi(messages);

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("start", { hasUI: false });

    assert.match((messages.at(-1) as any).content, /Could not read .*config\.json:/);
    assert.match((messages.at(-1) as any).content, /Run \/discord open-config to repair it\./);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("/discord setup reports unreadable config paths instead of silently falling back", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-setup-unreadable-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
  await ensureDir(configPath);

  const messages: unknown[] = [];
  const pi = createMockPi(messages);

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("setup", {
      hasUI: true,
      ui: {
        input: async () => {
          throw new Error("input should not be reached");
        },
      },
    });

    assert.match((messages.at(-1) as any).content, /Could not read .*config\.json:/);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("/discord open-config reports unreadable config paths instead of crashing", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-open-unreadable-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  const configPath = path.join(tempHome, ".pi", "agent", "pi-discord", "config.json");
  await ensureDir(configPath);

  const messages: unknown[] = [];
  const pi = createMockPi(messages);

  try {
    piDiscordExtension(pi);
    await pi.definition!.handler("open-config", {
      hasUI: true,
      ui: {
        editor: async () => {
          throw new Error("editor should not be reached");
        },
      },
    });

    assert.match((messages.at(-1) as any).content, /Could not read .*config\.json:/);
  } finally {
    process.env.HOME = originalHome;
  }
});
