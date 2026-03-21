import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { RouteQueueStore } from "../daemon/queue-store.js";

test("queue store recovers expired leases and preserves source dedupe", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-queue-"));
  const queue = new RouteQueueStore(path.join(tempDir, "queue.json"), 50);
  await queue.load();

  const item = await queue.enqueue({
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
      attachments: [],
    },
  });

  assert.equal(queue.hasSource("m1"), true);
  await queue.leaseNext("worker-1", 1);
  await queue.recoverExpiredLeases(200);
  const queued = queue.list().find((entry) => entry.id === item.id);
  assert.equal(queued.state, "queued");
  assert.equal(queued.lease, undefined);
});
