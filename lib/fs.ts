import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const handle = await open(filePath, "a");
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
  } finally {
    await handle.close();
  }
}

export async function removeIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "route";
}

export async function tailFile(filePath: string, maxLines: number = 80): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
