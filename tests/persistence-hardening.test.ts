// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { RouteQueueStore } from "../daemon/queue-store.js";
import { RouteRegistry } from "../daemon/registry.js";
import { ensureDir } from "../lib/fs.js";
import { getPaths } from "../lib/paths.js";

test("queue store drops malformed persisted items instead of crashing later", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-queue-hardening-"));
  const queuePath = path.join(tempDir, "queue.json");
  await writeFile(queuePath, JSON.stringify({
    version: 1,
    items: [
      null,
      { id: "bad-1", state: "queued" },
      {
        id: "good-1",
        state: "queued",
        source: {
          kind: "message",
          sourceId: "m1",
          userId: "u1",
          guildId: null,
          channelId: "c1",
          threadId: null,
          trigger: "dm",
        },
        payload: {
          rawText: "hello",
          promptText: "hello",
          attachments: [{ path: "/tmp/a.png", name: "a.png", isImage: true }],
        },
      },
    ],
  }), "utf8");

  const queue = new RouteQueueStore(queuePath, 60_000);
  const data = await queue.load();

  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, "good-1");
  assert.equal(queue.hasSource("m1"), true);
});

test("queue store recovers malformed running items without a valid lease", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-queue-lease-hardening-"));
  const queuePath = path.join(tempDir, "queue.json");
  await writeFile(queuePath, JSON.stringify({
    version: 1,
    items: [
      {
        id: "stuck-1",
        state: "running",
        source: {
          kind: "message",
          sourceId: "m2",
          userId: "u2",
          guildId: null,
          channelId: "c2",
          threadId: null,
          trigger: "dm",
        },
        payload: {
          rawText: "hello",
          promptText: "hello",
          attachments: [],
        },
      },
    ],
  }), "utf8");

  const queue = new RouteQueueStore(queuePath, 60_000);
  const data = await queue.load();

  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].state, "queued");
  assert.equal(data.items[0].lease, undefined);
  assert.match(data.items[0].error, /Recovered malformed queued work without a valid lease/);
});

test("route registry drops malformed summaries instead of crashing reconcile", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-registry-hardening-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  await ensureDir(path.dirname(paths.registryPath));
  await writeFile(paths.registryPath, JSON.stringify({
    version: 1,
    routes: {
      brokenA: null,
      brokenB: { routeKey: "brokenB" },
      good: {
        routeKey: "g1__c1__root",
        scope: { guildId: "g1", channelId: "c1", threadId: null },
        unused: true,
      },
    },
  }), "utf8");

  const registry = new RouteRegistry(paths);
  const data = await registry.load();

  assert.deepEqual(Object.keys(data.routes), ["g1__c1__root"]);
  assert.deepEqual(registry.list(), [{
    routeKey: "g1__c1__root",
    scope: { guildId: "g1", channelId: "c1", threadId: null },
  }]);
});

test("route registry ignores malformed persisted manifests and lets callers recreate them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-manifest-hardening-"));
  const paths = getPaths({ agentDir: tempDir, workspaceDir: path.join(tempDir, "workspace") });
  const routeKey = "g1__c1__root";
  const manifestPath = path.join(paths.routesDir, routeKey, "manifest.json");
  await ensureDir(path.dirname(manifestPath));
  await writeFile(manifestPath, JSON.stringify({
    routeKey,
    scope: { guildId: "g1" },
    executionRoot: 42,
    memoryPath: null,
  }), "utf8");

  const registry = new RouteRegistry(paths);
  const manifest = await registry.loadManifest(routeKey);

  assert.equal(manifest, null);
});
