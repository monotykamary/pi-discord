import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile } from "node:fs/promises";
import { writeJson } from "../lib/fs.js";

test("writeJson handles concurrent writes to the same file even when timestamps collide", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-fs-"));
  const filePath = path.join(tempDir, "data.json");
  const originalNow = Date.now;
  Date.now = () => 1;

  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => writeJson(filePath, { index })),
    );
  } finally {
    Date.now = originalNow;
  }

  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(typeof parsed.index, "number");
  assert.ok(parsed.index >= 0 && parsed.index < 12);
});
