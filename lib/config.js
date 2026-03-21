import path from "node:path";
import { CONFIG_VERSION, DEFAULT_COMMAND_NAME, DEFAULT_GLOBAL_CONCURRENCY, DEFAULT_PRIMARY_FLUSH_MS, DEFAULT_QUEUE_LEASE_MS } from "./constants.js";
import { ensureDir, readJson, writeJson } from "./fs.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeRouteOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const [routeKey, override] of Object.entries(value)) {
    if (!override || typeof override !== "object" || Array.isArray(override)) continue;
    const executionRoot = normalizeOptionalString(override.executionRoot);
    const mode = override.mode === "shared" || override.mode === "dedicated" ? override.mode : undefined;
    if (!executionRoot && !mode) continue;
    normalized[routeKey] = { executionRoot, mode };
  }
  return normalized;
}

/**
 * @typedef {Object} DiscordRouteOverride
 * @property {string | undefined} [executionRoot]
 * @property {"dedicated" | "shared" | undefined} [mode]
 */

/**
 * @typedef {Object} PiDiscordConfig
 * @property {number} version
 * @property {string} botToken
 * @property {string} applicationId
 * @property {string[]} allowedGuildIds
 * @property {string[]} adminUserIds
 * @property {string[]} dmAllowlistUserIds
 * @property {string} commandName
 * @property {boolean} registerCommandsGlobally
 * @property {boolean} syncCommandsOnStart
 * @property {"dedicated" | "shared"} workspaceMode
 * @property {string | undefined} sharedExecutionRoot
 * @property {Record<string, DiscordRouteOverride>} routeOverrides
 * @property {boolean} allowProjectExtensions
 * @property {boolean} enableImageInput
 * @property {boolean} enableDetailsThreads
 * @property {number} globalConcurrency
 * @property {number} queueLeaseMs
 * @property {number} primaryFlushMs
 * @property {string | undefined} defaultModel
 * @property {"off" | "minimal" | "low" | "medium" | "high" | "xhigh"} defaultThinkingLevel
 * @property {string[]} triggerWords
 * @property {boolean} triggerWarmOnly
 */

/**
 * Builds the default config.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @returns {PiDiscordConfig}
 */
export function createDefaultConfig(paths) {
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
  };
}

/**
 * Normalizes an arbitrary config object into the supported shape.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @param {Record<string, unknown>} loaded
 * @returns {PiDiscordConfig}
 */
export function normalizeConfig(paths, loaded) {
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
      ? input.defaultThinkingLevel
      : fallback.defaultThinkingLevel,
    triggerWords: toStringArray(input.triggerWords).length > 0 ? toStringArray(input.triggerWords) : fallback.triggerWords,
    triggerWarmOnly: typeof input.triggerWarmOnly === "boolean" ? input.triggerWarmOnly : fallback.triggerWarmOnly,
  };
}

/**
 * Loads config from disk and applies normalization.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @returns {Promise<PiDiscordConfig>}
 */
export async function loadConfig(paths) {
  const loaded = await readJson(paths.configPath, {});
  return normalizeConfig(paths, loaded);
}

/**
 * Persists config to disk.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @param {PiDiscordConfig} config
 */
export async function saveConfig(paths, config) {
  await ensureDir(paths.workspaceDir);
  await writeJson(paths.configPath, normalizeConfig(paths, config));
}

/**
 * Validates config and returns human-readable issues.
 * @param {PiDiscordConfig} config
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

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
