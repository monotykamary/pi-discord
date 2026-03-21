import path from "node:path";
import { ensureDir, readJson, writeJson } from "../lib/fs.js";
import { getRoutePaths } from "../lib/paths.js";
import type { Paths } from "../lib/paths.js";

export interface RouteScope {
  guildId: string | null;
  channelId: string;
  threadId: string | null;
}

export interface RouteRegistryEntry {
  routeKey: string;
  scope: RouteScope;
}

export interface RouteRegistryData {
  version: number;
  routes: Record<string, RouteRegistryEntry>;
}

export interface RouteManifest {
  version: number;
  routeKey: string;
  scope: RouteScope;
  workspaceMode: "dedicated" | "shared";
  executionRoot: string;
  memoryPath: string;
  sessionFile?: string;
  primaryMessageId?: string;
  detailsThreadId?: string;
}

interface ScopeInput {
  guildId?: string;
  channelId?: string;
  threadId?: string;
}

function normalizeScope(value: unknown): RouteScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as ScopeInput;
  if (typeof v.channelId !== "string" || !v.channelId) return undefined;
  return {
    guildId: typeof v.guildId === "string" ? v.guildId : null,
    channelId: v.channelId,
    threadId: typeof v.threadId === "string" ? v.threadId : null,
  };
}

interface RegistryEntryInput {
  routeKey?: string;
  scope?: unknown;
}

interface RegistryInput {
  routes?: Record<string, unknown>;
}

function normalizeRegistry(value: unknown): RouteRegistryData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, routes: {} };
  }

  const routes: Record<string, RouteRegistryEntry> = {};
  const v = value as { routes?: Record<string, unknown> };
  const sourceRoutes = v.routes;
  if (!sourceRoutes || typeof sourceRoutes !== "object" || Array.isArray(sourceRoutes)) {
    return { version: 1, routes };
  }

  for (const [key, entry] of Object.entries(sourceRoutes)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as RegistryEntryInput;
    const routeKey = typeof e.routeKey === "string" && e.routeKey ? e.routeKey : key;
    const scope = normalizeScope(e.scope);
    if (!routeKey || !scope) continue;
    routes[routeKey] = { routeKey, scope };
  }

  return { version: 1, routes };
}

interface ManifestInput {
  scope?: unknown;
  executionRoot?: string;
  memoryPath?: string;
  workspaceMode?: "shared" | "dedicated";
  sessionFile?: string;
  primaryMessageId?: string;
  detailsThreadId?: string;
}

function normalizeManifest(routeKey: string, value: unknown): RouteManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as ManifestInput;
  const scope = normalizeScope(v.scope);
  const executionRoot = typeof v.executionRoot === "string" && v.executionRoot ? v.executionRoot : undefined;
  const memoryPath = typeof v.memoryPath === "string" && v.memoryPath ? v.memoryPath : undefined;
  if (!scope || !executionRoot || !memoryPath) return null;

  return {
    version: 1,
    routeKey,
    scope,
    workspaceMode: v.workspaceMode === "shared" ? "shared" : "dedicated",
    executionRoot,
    memoryPath,
    sessionFile: typeof v.sessionFile === "string" ? v.sessionFile : undefined,
    primaryMessageId: typeof v.primaryMessageId === "string" ? v.primaryMessageId : undefined,
    detailsThreadId: typeof v.detailsThreadId === "string" ? v.detailsThreadId : undefined,
  };
}

export class RouteRegistry {
  private paths: Paths;
  registry: RouteRegistryData;

  constructor(paths: Paths) {
    this.paths = paths;
    this.registry = { version: 1, routes: {} };
  }

  async load(): Promise<RouteRegistryData> {
    this.registry = normalizeRegistry(await readJson(this.paths.registryPath, { version: 1, routes: {} }));
    return this.registry;
  }

  async save(): Promise<void> {
    await ensureDir(path.dirname(this.paths.registryPath));
    await writeJson(this.paths.registryPath, this.registry);
  }

  list(): RouteRegistryEntry[] {
    return Object.values(this.registry.routes);
  }

  async loadManifest(routeKey: string): Promise<RouteManifest | null> {
    const routePaths = getRoutePaths(this.paths, routeKey);
    return normalizeManifest(routeKey, await readJson(routePaths.manifestPath, null));
  }

  async saveManifest(manifest: RouteManifest): Promise<void> {
    const routePaths = getRoutePaths(this.paths, manifest.routeKey);
    await ensureDir(routePaths.routeDir);
    await writeJson(routePaths.manifestPath, manifest);
    this.registry.routes[manifest.routeKey] = {
      routeKey: manifest.routeKey,
      scope: manifest.scope,
    };
    await this.save();
  }
}

export interface CreateManifestInput {
  routeKey: string;
  scope: RouteScope;
  workspaceMode: "dedicated" | "shared";
  executionRoot: string;
  memoryPath: string;
}

export function createRouteManifest(input: CreateManifestInput): RouteManifest {
  return {
    version: 1,
    routeKey: input.routeKey,
    scope: input.scope,
    workspaceMode: input.workspaceMode,
    executionRoot: input.executionRoot,
    memoryPath: input.memoryPath,
    sessionFile: undefined,
    primaryMessageId: undefined,
    detailsThreadId: undefined,
  };
}
