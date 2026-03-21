import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createDefaultConfig, loadConfig, normalizeConfig, saveConfig, validateConfig } from "../lib/config.js";
import { getPaths } from "../lib/paths.js";

test("default config uses dedicated workspace mode and sane concurrency", () => {
  const config = createDefaultConfig(getPaths({ agentDir: "/tmp/agent", workspaceDir: "/tmp/agent/pi-discord" }));
  assert.equal(config.workspaceMode, "dedicated");
  assert.equal(config.globalConcurrency, 2);
  assert.equal(config.primaryFlushMs, 1200);
  assert.equal(config.commandName, "pi");
  assert.deepEqual(config.triggerWords, ["pi"]);
  assert.equal(config.triggerWarmOnly, true);
});

test("validation flags missing credentials and invalid shared mode", () => {
  const config = createDefaultConfig(getPaths({ agentDir: "/tmp/agent", workspaceDir: "/tmp/agent/pi-discord" }));
  config.workspaceMode = "shared";
  config.sharedExecutionRoot = "";
  config.commandName = "Not Valid";
  const result = validateConfig(config);
  assert.ok(result.errors.some((entry) => entry.includes("botToken")));
  assert.ok(result.errors.some((entry) => entry.includes("applicationId")));
  assert.ok(result.errors.some((entry) => entry.includes("sharedExecutionRoot")));
  assert.ok(result.errors.some((entry) => entry.includes("commandName")));
});

test("normalizeConfig keeps only valid route override fields", () => {
  const paths = getPaths({ agentDir: "/tmp/agent", workspaceDir: "/tmp/agent/pi-discord" });
  const config = normalizeConfig(paths, {
    routeOverrides: {
      good: { mode: "shared", executionRoot: "/tmp/project" },
      bad: { mode: "broken", executionRoot: 42 },
    },
  });

  assert.deepEqual(config.routeOverrides, {
    good: { mode: "shared", executionRoot: "/tmp/project" },
  });
});

test("normalizeConfig handles null input and trims config strings", () => {
  const paths = getPaths({ agentDir: "/tmp/agent", workspaceDir: "/tmp/agent/pi-discord" });
  const emptyConfig = normalizeConfig(paths, null);
  assert.equal(emptyConfig.commandName, "pi");

  const config = normalizeConfig(paths, {
    botToken: " token ",
    applicationId: " app ",
    commandName: " pi ",
    sharedExecutionRoot: " /tmp/shared ",
    defaultModel: " openai/gpt ",
    allowedGuildIds: [" g1 ", "", "g2", "g1"],
    adminUserIds: [" u1 ", "   ", "u1"],
    dmAllowlistUserIds: [" dm1 "],
    routeOverrides: {
      routeA: { executionRoot: " /tmp/project ", mode: "shared" },
    },
  });

  assert.equal(config.botToken, "token");
  assert.equal(config.applicationId, "app");
  assert.equal(config.commandName, "pi");
  assert.equal(config.sharedExecutionRoot, "/tmp/shared");
  assert.equal(config.defaultModel, "openai/gpt");
  assert.deepEqual(config.allowedGuildIds, ["g1", "g2"]);
  assert.deepEqual(config.adminUserIds, ["u1"]);
  assert.deepEqual(config.dmAllowlistUserIds, ["dm1"]);
  assert.deepEqual(config.routeOverrides, {
    routeA: { executionRoot: "/tmp/project", mode: "shared" },
  });
});

test("saveConfig persists normalized config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-config-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });

  await saveConfig(paths, {
    botToken: " token ",
    applicationId: " app ",
    allowedGuildIds: [" g1 ", "g1"],
    adminUserIds: [" u1 "],
    dmAllowlistUserIds: [" dm1 "],
    commandName: " pi ",
    routeOverrides: { routeA: { executionRoot: " /tmp/project ", mode: "shared" } },
  });

  const config = await loadConfig(paths);
  assert.equal(config.botToken, "token");
  assert.equal(config.applicationId, "app");
  assert.equal(config.commandName, "pi");
  assert.deepEqual(config.allowedGuildIds, ["g1"]);
  assert.deepEqual(config.adminUserIds, ["u1"]);
  assert.deepEqual(config.dmAllowlistUserIds, ["dm1"]);
  assert.deepEqual(config.routeOverrides, {
    routeA: { executionRoot: "/tmp/project", mode: "shared" },
  });
});

test("normalizeConfig handles trigger words and warm-only setting", () => {
  const paths = getPaths({ agentDir: "/tmp/agent", workspaceDir: "/tmp/agent/pi-discord" });
  
  // Uses defaults when not provided
  const defaultConfig = normalizeConfig(paths, {});
  assert.deepEqual(defaultConfig.triggerWords, ["pi"]);
  assert.equal(defaultConfig.triggerWarmOnly, true);

  // Normalizes provided values
  const config = normalizeConfig(paths, {
    triggerWords: [" pi ", "  bot  ", ""],
    triggerWarmOnly: false,
  });
  assert.deepEqual(config.triggerWords, ["pi", "bot"]);
  assert.equal(config.triggerWarmOnly, false);
});

test("validation rejects fractional runtime timing and concurrency values", () => {
  const config = createDefaultConfig(getPaths({ agentDir: "/tmp/agent", workspaceDir: "/tmp/agent/pi-discord" }));
  config.globalConcurrency = 1.5;
  config.queueLeaseMs = 1500.5;
  config.primaryFlushMs = 100.5;

  const result = validateConfig(config);

  assert.ok(result.errors.some((entry) => entry.includes("globalConcurrency") && entry.includes("integer")));
  assert.ok(result.errors.some((entry) => entry.includes("queueLeaseMs") && entry.includes("integer")));
  assert.ok(result.errors.some((entry) => entry.includes("primaryFlushMs") && entry.includes("integer")));
});
