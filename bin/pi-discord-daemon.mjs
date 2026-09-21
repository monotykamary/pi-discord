#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(__dirname, "pi-discord-daemon.ts");

// Resolve the tsx CLI from this package's own node_modules so the daemon works
// regardless of whether node_modules/.bin is on PATH; fall back to the bare
// "tsx" command for globally installed tsx.
let tsxCommand = "tsx";
let tsxArgs = [];
try {
  const require = createRequire(import.meta.url);
  const tsxCli = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
  tsxCommand = process.execPath;
  tsxArgs = [tsxCli];
} catch {
  // tsx not installed locally; keep the previous PATH-based lookup.
}

const child = spawn(tsxCommand, [...tsxArgs, daemonPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
