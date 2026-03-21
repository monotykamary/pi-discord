// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { PiDiscordDaemon } from "../daemon/runtime.js";
import { getPaths } from "../lib/paths.js";
import { createDefaultConfig } from "../lib/config.js";

test("ensureRoute deduplicates concurrent route initialization", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-runtime-route-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  const daemon = new PiDiscordDaemon({ paths, config: createDefaultConfig(paths) });
  const scope = { guildId: "g1", channelId: "c1", threadId: null, routeKey: "g1__c1__root" };

  let loadCalls = 0;
  daemon.registry.loadManifest = async () => {
    loadCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return null;
  };
  daemon.registry.saveManifest = async () => undefined;

  const [first, second] = await Promise.all([daemon.ensureRoute(scope), daemon.ensureRoute(scope)]);

  assert.equal(first, second);
  assert.equal(loadCalls, 1);
  assert.equal(daemon.routeContexts.size, 1);
  assert.equal(daemon.routePromises.size, 0);
});
