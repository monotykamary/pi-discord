// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathExists } from "../lib/fs.js";

const execFileAsync = promisify(execFile);

test("daemon entrypoint does not create runtime files when startup validation fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-daemon-bin-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const daemonEntry = path.resolve("bin", "pi-discord-daemon.mjs");

  await assert.rejects(
    execFileAsync(process.execPath, [daemonEntry, "--workspace", workspaceDir], {
      cwd: process.cwd(),
      timeout: 15_000,
    }),
    /Invalid pi-discord config/,
  );

  const configPath = path.join(workspaceDir, "config.json");
  const runDir = path.join(workspaceDir, "run");
  assert.equal(await pathExists(configPath), false);
  assert.equal(await pathExists(runDir), false);
});
