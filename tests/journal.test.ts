import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { JournalStore } from "../daemon/journal.js";

test("journal load skips malformed lines instead of failing startup", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-journal-"));
  const journalPath = path.join(tempDir, "journal.jsonl");
  await writeFile(
    journalPath,
    '{"kind":"ambient","sourceId":"m1","text":"hello"}\nnot-json\n{"kind":"ambient","sourceId":"m2","text":"world"}\n',
    "utf8",
  );

  const journal = new JournalStore(journalPath);
  const entries = await journal.load();

  assert.equal(entries.length, 2);
  assert.equal(journal.hasSource("m1"), true);
  assert.equal(journal.hasSource("m2"), true);
});
