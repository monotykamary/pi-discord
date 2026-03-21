import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { buildInjectedContext } from "../daemon/prompt-shaper.js";
import type { JournalStore } from "../daemon/journal.js";

test("injected context excludes the active inbound source to avoid duplicating the current request", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-context-"));
  const memoryPath = path.join(tempDir, "memory.md");
  await writeFile(memoryPath, "Remember the deployment project name.", "utf8");

  const journalEntries = [
    { kind: "ambient", sourceId: "a1", authorName: "alice", text: "Can someone inspect prod?" },
    { kind: "inbound", sourceId: "m2", authorName: "bob", text: "current request should not be duplicated" },
  ];
  const journal = {
    recent(limit: number, predicate: (entry: any) => boolean) {
      return journalEntries.filter(predicate).slice(-limit);
    },
  } as unknown as JournalStore;

  const injected = await buildInjectedContext({
    memoryPath,
    journal,
    excludeSourceId: "m2",
  });

  assert.match(injected, /Remember the deployment project name/);
  assert.match(injected, /alice: Can someone inspect prod\?/);
  assert.doesNotMatch(injected, /current request should not be duplicated/);
});
