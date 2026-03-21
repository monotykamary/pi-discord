import path from "node:path";
import {
  CONFIG_VERSION,
  DEFAULT_COMMAND_NAME,
  DEFAULT_GLOBAL_CONCURRENCY,
  DEFAULT_PRIMARY_FLUSH_MS,
  DEFAULT_QUEUE_LEASE_MS,
} from "./constants.js";
import { ensureDir, readJson, writeJson } from "./fs.js";
import type { Paths } from "./paths.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

interface RouteOverrideInput {
  executionRoot?: string;
  mode?: "shared" | "dedicated";
  [key: string]: unknown;
}

function normalizeRouteOverrides(value: unknown): Record<string, DiscordRouteOverride> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, DiscordRouteOverride> = {};
  for (const [routeKey, override] of Object.entries(value)) {
    const ovr = override as RouteOverrideInput;
    if (!ovr || typeof ovr !== "object" || Array.isArray(ovr)) continue;
    const executionRoot = normalizeOptionalString(ovr.executionRoot);
    const mode = ovr.mode === "shared" || ovr.mode === "dedicated" ? ovr.mode : undefined;
    if (!executionRoot && !mode) continue;
    normalized[routeKey] = { executionRoot, mode };
  }
  return normalized;
}

export interface DiscordRouteOverride {
  executionRoot?: string;
  mode?: "dedicated" | "shared";
}

export interface PiDiscordConfig {
  version: number;
  botToken: string;
  applicationId: string;
  allowedGuildIds: string[];
  adminUserIds: string[];
  dmAllowlistUserIds: string[];
  commandName: string;
  registerCommandsGlobally: boolean;
  syncCommandsOnStart: boolean;
  workspaceMode: "dedicated" | "shared";
  sharedExecutionRoot?: string;
  routeOverrides: Record<string, DiscordRouteOverride>;
  allowProjectExtensions: boolean;
  enableImageInput: boolean;
  enableDetailsThreads: boolean;
  globalConcurrency: number;
  queueLeaseMs: number;
  primaryFlushMs: number;
  defaultModel?: string;
  defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  triggerWords: string[];
  triggerWarmOnly: boolean;
  hotZoneMinutes: number;
  [key: string]: unknown;
}

export function createDefaultConfig(paths: Paths): PiDiscordConfig {
  return {
    version: CONFIG_VERSION,
    botToken: "",
    applicationId: "",
    allowedGuildIds: [],
    adminUserIds: [],
    dmAllowlistUserIds: [],
    commandName: DEFAULT_COMMAND_NAME,
    registerCommandsGlobally: false,
    syncCommandsOnStart: true,
    workspaceMode: "dedicated",
    sharedExecutionRoot: path.join(paths.workspaceDir, "shared-workspace"),
    routeOverrides: {},
    allowProjectExtensions: false,
    enableImageInput: true,
    enableDetailsThreads: true,
    globalConcurrency: DEFAULT_GLOBAL_CONCURRENCY,
    queueLeaseMs: DEFAULT_QUEUE_LEASE_MS,
    primaryFlushMs: DEFAULT_PRIMARY_FLUSH_MS,
    defaultModel: undefined,
    defaultThinkingLevel: "medium",
    triggerWords: ["pi"],
    triggerWarmOnly: true,
    hotZoneMinutes: 10,
  };
}

interface ConfigInput {
  version?: number;
  botToken?: string;
  applicationId?: string;
  allowedGuildIds?: unknown;
  adminUserIds?: unknown;
  dmAllowlistUserIds?: unknown;
  commandName?: string;
  registerCommandsGlobally?: boolean;
  syncCommandsOnStart?: boolean;
  workspaceMode?: "shared" | "dedicated";
  sharedExecutionRoot?: string;
  routeOverrides?: unknown;
  allowProjectExtensions?: boolean;
  enableImageInput?: boolean;
  enableDetailsThreads?: boolean;
  globalConcurrency?: number;
  queueLeaseMs?: number;
  primaryFlushMs?: number;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  triggerWords?: unknown;
  triggerWarmOnly?: boolean;
  hotZoneMinutes?: number;
  [key: string]: unknown;
}

export function normalizeConfig(paths: Paths, loaded: ConfigInput): PiDiscordConfig {
  const fallback = createDefaultConfig(paths);
  const input = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
  return {
    version: typeof input.version === "number" ? input.version : fallback.version,
    botToken: normalizeOptionalString(input.botToken) ?? fallback.botToken,
    applicationId: normalizeOptionalString(input.applicationId) ?? fallback.applicationId,
    allowedGuildIds: toStringArray(input.allowedGuildIds),
    adminUserIds: toStringArray(input.adminUserIds),
    dmAllowlistUserIds: toStringArray(input.dmAllowlistUserIds),
    commandName: normalizeOptionalString(input.commandName) ?? fallback.commandName,
    registerCommandsGlobally: typeof input.registerCommandsGlobally === "boolean" ? input.registerCommandsGlobally : fallback.registerCommandsGlobally,
    syncCommandsOnStart: typeof input.syncCommandsOnStart === "boolean" ? input.syncCommandsOnStart : fallback.syncCommandsOnStart,
    workspaceMode: input.workspaceMode === "shared" ? "shared" : fallback.workspaceMode,
    sharedExecutionRoot: normalizeOptionalString(input.sharedExecutionRoot) ?? fallback.sharedExecutionRoot,
    routeOverrides: normalizeRouteOverrides(input.routeOverrides),
    allowProjectExtensions: typeof input.allowProjectExtensions === "boolean" ? input.allowProjectExtensions : fallback.allowProjectExtensions,
    enableImageInput: typeof input.enableImageInput === "boolean" ? input.enableImageInput : fallback.enableImageInput,
    enableDetailsThreads: typeof input.enableDetailsThreads === "boolean" ? input.enableDetailsThreads : fallback.enableDetailsThreads,
    globalConcurrency: typeof input.globalConcurrency === "number" ? input.globalConcurrency : fallback.globalConcurrency,
    queueLeaseMs: typeof input.queueLeaseMs === "number" ? input.queueLeaseMs : fallback.queueLeaseMs,
    primaryFlushMs: typeof input.primaryFlushMs === "number" ? input.primaryFlushMs : fallback.primaryFlushMs,
    defaultModel: normalizeOptionalString(input.defaultModel) ?? fallback.defaultModel,
    defaultThinkingLevel: typeof input.defaultThinkingLevel === "string" && THINKING_LEVELS.has(input.defaultThinkingLevel)
      ? (input.defaultThinkingLevel as PiDiscordConfig["defaultThinkingLevel"])
      : fallback.defaultThinkingLevel,
    triggerWords: toStringArray(input.triggerWords).length > 0 ? toStringArray(input.triggerWords) : fallback.triggerWords,
    triggerWarmOnly: typeof input.triggerWarmOnly === "boolean" ? input.triggerWarmOnly : fallback.triggerWarmOnly,
    hotZoneMinutes: typeof input.hotZoneMinutes === "number" && Number.isFinite(input.hotZoneMinutes) && input.hotZoneMinutes >= 0
      ? input.hotZoneMinutes
      : fallback.hotZoneMinutes,
  };
}

export async function loadConfig(paths: Paths): Promise<PiDiscordConfig> {
  const loaded = await readJson<ConfigInput>(paths.configPath, {});
  return normalizeConfig(paths, loaded);
}

export async function saveConfig(paths: Paths, config: PiDiscordConfig): Promise<void> {
  await ensureDir(paths.workspaceDir);
  await writeJson(paths.configPath, normalizeConfig(paths, config));
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateConfig(config: PiDiscordConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.botToken) errors.push("Missing `botToken`.");
  if (!config.applicationId) errors.push("Missing `applicationId`.");
  if (config.workspaceMode === "shared" && !config.sharedExecutionRoot) {
    errors.push("`sharedExecutionRoot` is required when `workspaceMode` is `shared`.");
  }
  if (!/^[a-z0-9_-]{1,32}$/.test(config.commandName)) {
    errors.push("`commandName` must match Discord slash-command naming rules.");
  }
  if (!Number.isInteger(config.globalConcurrency) || config.globalConcurrency < 1) {
    errors.push("`globalConcurrency` must be an integer of at least 1.");
  }
  if (!Number.isInteger(config.queueLeaseMs) || config.queueLeaseMs < 1_000) {
    errors.push("`queueLeaseMs` must be an integer of at least 1000.");
  }
  if (!Number.isInteger(config.primaryFlushMs) || config.primaryFlushMs < 100) {
    errors.push("`primaryFlushMs` must be an integer of at least 100.");
  }
  if (config.defaultModel && !config.defaultModel.includes("/")) {
    warnings.push("`defaultModel` should look like `provider/model-id`.");
  }
  if (config.allowProjectExtensions) {
    warnings.push("Project extensions are enabled for bot sessions. This is less safe in headless mode.");
  }
  if (config.allowedGuildIds.length === 0) {
    warnings.push("No guild allowlist is configured. The bot will accept slash commands and mentions in any guild it joins.");
  }

  return { errors, warnings };
}
