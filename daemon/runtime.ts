import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type {
  Client,
  Message,
  ChatInputCommandInteraction,
  ButtonInteraction,
  Interaction,
  Collection,
  Channel,
  GuildTextBasedChannel,
} from "discord.js";
import {
  Events,
} from "discord.js";
import { authorizeInteraction } from "./authz.js";
import { JournalStore, type JournalEntry } from "./journal.js";
import type { Logger } from "./logger.js";
import { buildPromptText, type AttachmentInfo } from "./prompt-shaper.js";
import { RouteQueueStore, type QueueItem, type QueueAttachment } from "./queue-store.js";
import { DiscordRenderer } from "./renderer.js";
import { RouteRegistry, createRouteManifest, type RouteManifest } from "./registry.js";
import { makeRouteKey, formatRoute, type ScopeInfo } from "./route-key.js";
import { RouteSessionHost } from "./session-host.js";
import { ensureDir, pathExists, removeIfExists, writeJson } from "../lib/fs.js";
import { getRoutePaths, type Paths, type RoutePaths } from "../lib/paths.js";
import type { PiDiscordConfig } from "../lib/config.js";

function stripBotMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .trim();
}

function findTriggerWord(content: string | undefined, triggerWords: string[]): string | undefined {
  if (!content || triggerWords.length === 0) return undefined;
  const lowerContent = content.toLowerCase();
  for (const word of triggerWords) {
    const lowerWord = word.toLowerCase();
    const regex = new RegExp(`\\b${escapeRegExp(lowerWord)}\\b`, "i");
    if (regex.test(lowerContent)) {
      return word;
    }
  }
  return undefined;
}

function stripTriggerWord(content: string, triggerWord: string): string {
  const regex = new RegExp(`^\\s*\\b${escapeRegExp(triggerWord)}\\b[\\s:,;-]*`, "i");
  return content.replace(regex, "").trim();
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function toImageContent(filePath: string, mediaType: string): Promise<unknown> {
  const data = await readFile(filePath);
  return {
    type: "image",
    source: {
      type: "base64",
      mediaType,
      data: data.toString("base64"),
    },
  };
}

export interface RouteContext {
  manifest: RouteManifest;
  routePaths: RoutePaths;
  queue: RouteQueueStore;
  journal: JournalStore;
  renderer: DiscordRenderer;
  host: RouteSessionHost;
}

export interface ActiveRun {
  abort: () => Promise<void>;
}

export interface DaemonStatus {
  phase?: string;
  userTag?: string;
  pid?: number;
  routeCount?: number;
  activeRuns?: string[];
}

export class PiDiscordDaemon {
  private paths: Paths;
  private config: PiDiscordConfig;
  private logger: Logger;
  private registry: RouteRegistry;
  private client: Client;
  private routeContexts: Map<string, RouteContext>;
  private routePromises: Map<string, Promise<RouteContext>>;
  private currentRuns: Map<string, ActiveRun>;
  private userHotZones: Map<string, number>;
  private workerId: string;
  private heartbeat: NodeJS.Timeout | undefined;
  private stopping: boolean;
  private status: DaemonStatus;

  constructor(options: { paths: Paths; config: PiDiscordConfig; client: Client; logger: Logger }) {
    this.paths = options.paths;
    this.config = options.config;
    this.logger = options.logger;
    this.registry = new RouteRegistry(this.paths);
    this.client = options.client;
    this.routeContexts = new Map();
    this.routePromises = new Map();
    this.currentRuns = new Map();
    this.userHotZones = new Map();
    this.workerId = `daemon-${process.pid}`;
    this.heartbeat = undefined;
    this.stopping = false;
    this.status = {};
  }

  runInBackground(label: string, task: () => Promise<void>, details: Record<string, unknown> = {}): void {
    void Promise.resolve()
      .then(task)
      .catch(async (error) => {
        await this.logger.error(label, { ...details, error: String(error) });
      });
  }

  async start(): Promise<void> {
    await ensureDir(this.paths.workspaceDir);
    await ensureDir(this.paths.runDir);
    await ensureDir(this.paths.logsDir);
    await this.registry.load();
    this.attachEventHandlers();
    await this.writeStatus({ phase: "starting" });
    await this.client.login(this.config.botToken);
    this.heartbeat = setInterval(() => {
      this.runInBackground("status-write-failed", async () => {
        await this.writeStatus({ phase: "running" });
      });
    }, 15_000);
  }

  attachEventHandlers(): void {
    this.client.once(Events.ClientReady, async (client) => {
      await this.logger.info("discord-ready", { userId: client.user?.id, tag: client.user?.tag });
      await this.writeStatus({ phase: "ready", userTag: client.user?.tag });
      await this.reconcileKnownRoutes();
      await this.scheduleWork();
    });

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        await this.handleMessageCreate(message as Message);
      } catch (error) {
        await this.logger.error("message-create-failed", { error: String(error) });
      }
    });

    this.client.on(Events.MessageUpdate, async (_previousMessage, nextMessage) => {
      let message = nextMessage as Message;
      try {
        if (!message?.id || !message.channelId) return;
        if (message.partial) {
          try {
            message = await message.fetch();
          } catch {
            return;
          }
        }
        if (message.author?.bot) return;
        if (message.guildId && this.config.allowedGuildIds.length > 0 && !this.config.allowedGuildIds.includes(message.guildId)) {
          return;
        }
        if (!authorizeInteraction(message, this.config).allowed) return;

        const scope = this.resolveScopeFromChannel(message.guildId ?? null, message.channelId, message.channel as Channel);
        const route = await this.getExistingRoute(scope);
        if (!route) return;
        if (!route.journal.hasSource(message.id) && !route.queue.hasSource(message.id)) {
          return;
        }

        await route.journal.append({
          kind: "edit",
          sourceId: message.id,
          timestamp: Date.now(),
          routeKey: route.manifest.routeKey,
          text: message.content ?? "",
          authorId: message.author?.id,
          authorName: message.author?.username,
        } as JournalEntry);
        const replyContext = message.reference?.messageId ? await this.fetchReplyContext(message) : undefined;
        await route.queue.replaceQueuedBySource(message.id, (item) => {
          const rawText = item.source.trigger === "mention" && this.client.user
            ? stripBotMention(message.content ?? item.payload.rawText, this.client.user.id)
            : (message.content ?? item.payload.rawText);
          item.payload.rawText = rawText;
          item.payload.promptText = buildPromptText({
            routeKey: route.manifest.routeKey,
            scope: route.manifest.scope,
            requester: { id: item.source.userId, name: message.author?.username ?? item.source.userId },
            trigger: item.source.trigger,
            rawText,
            replyContext,
            savedAttachments: item.payload.attachments ?? [],
          });
        });
      } catch (error) {
        await this.logger.error("message-update-failed", { error: String(error) });
      }
    });

    this.client.on(Events.MessageDelete, async (message) => {
      try {
        if (!message.id || !message.channelId) return;
        if (message.guildId && this.config.allowedGuildIds.length > 0 && !this.config.allowedGuildIds.includes(message.guildId)) {
          return;
        }
        const scope = this.resolveScopeFromChannel(message.guildId ?? null, message.channelId, message.channel as Channel);
        const route = await this.getExistingRoute(scope);
        if (!route) return;
        if (!route.journal.hasSource(message.id) && !route.queue.hasSource(message.id)) {
          return;
        }
        await route.journal.append({
          kind: "delete",
          sourceId: message.id,
          timestamp: Date.now(),
          routeKey: route.manifest.routeKey,
        } as JournalEntry);
        await route.queue.cancelQueuedBySource(message.id, "Source message was deleted before execution.");
      } catch (error) {
        await this.logger.error("message-delete-failed", { error: String(error) });
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
        await this.handleInteraction(interaction as ChatInputCommandInteraction | ButtonInteraction);
      } catch (error) {
        await this.logger.error("interaction-failed", { error: String(error) });
        if (interaction.isRepliable()) {
          const responder = interaction.deferred || interaction.replied 
            ? interaction.followUp.bind(interaction) 
            : interaction.reply.bind(interaction);
          await responder({ content: String(error), ephemeral: true }).catch(() => undefined);
        }
      }
    });
  }

  resolveScope(guildId: string | null, channelId: string, threadId: string | null): ScopeInfo & { routeKey: string } {
    return {
      guildId,
      channelId,
      threadId,
      routeKey: makeRouteKey({ guildId, channelId, threadId }),
    };
  }

  resolveScopeFromChannel(guildId: string | null, channelId: string, channel: Channel | null): ScopeInfo & { routeKey: string } {
    const isThread = (channel as any)?.isThread?.() ?? false;
    return this.resolveScope(
      guildId,
      isThread ? ((channel as any).parentId ?? channelId) : channelId,
      isThread ? channelId : null,
    );
  }

  checkTriggerWord(content: string | undefined): string | undefined {
    if (!this.config.triggerWarmOnly) {
      return findTriggerWord(content, this.config.triggerWords);
    }
    return findTriggerWord(content, this.config.triggerWords);
  }

  async getExistingRoute(scope: ScopeInfo & { routeKey: string }): Promise<RouteContext | undefined> {
    if (this.routeContexts.has(scope.routeKey)) {
      return this.routeContexts.get(scope.routeKey);
    }
    if (!(await this.registry.loadManifest(scope.routeKey))) {
      return undefined;
    }
    return this.ensureRoute(scope);
  }

  async ensureRoute(scope: ScopeInfo & { routeKey: string }): Promise<RouteContext> {
    if (this.routeContexts.has(scope.routeKey)) {
      return this.routeContexts.get(scope.routeKey)!;
    }
    if (!this.routePromises.has(scope.routeKey)) {
      const routePromise = this.createRouteContext(scope)
        .finally(() => {
          if (this.routePromises.get(scope.routeKey) === routePromise) {
            this.routePromises.delete(scope.routeKey);
          }
        });
      this.routePromises.set(scope.routeKey, routePromise);
    }
    return this.routePromises.get(scope.routeKey)!;
  }

  private async createRouteContext(scope: ScopeInfo & { routeKey: string }): Promise<RouteContext> {
    if (this.routeContexts.has(scope.routeKey)) {
      return this.routeContexts.get(scope.routeKey)!;
    }

    const routePaths = getRoutePaths(this.paths, scope.routeKey);
    let manifest = await this.registry.loadManifest(scope.routeKey);
    if (!manifest) {
      const override = this.config.routeOverrides[scope.routeKey] ?? {};
      const workspaceMode = override.mode ?? this.config.workspaceMode;
      const executionRoot = workspaceMode === "shared"
        ? (override.executionRoot ?? this.config.sharedExecutionRoot!)
        : routePaths.dedicatedExecutionRoot;
      if (!executionRoot) throw new Error(`No execution root configured for ${scope.routeKey}`);
      const memoryPath = workspaceMode === "dedicated"
        ? path.join(executionRoot, "discord-memory.md")
        : routePaths.sharedMemoryPath;
      manifest = createRouteManifest({
        routeKey: scope.routeKey,
        scope: { guildId: scope.guildId, channelId: scope.channelId, threadId: scope.threadId },
        workspaceMode,
        executionRoot,
        memoryPath,
      });
      await ensureDir(executionRoot);
      await ensureDir(path.dirname(memoryPath));
      if (!(await pathExists(memoryPath))) {
        await writeFile(memoryPath, "", "utf8");
      }
      await this.registry.saveManifest(manifest);
    }

    await ensureDir(manifest.executionRoot);
    await ensureDir(path.dirname(manifest.memoryPath));
    if (!(await pathExists(manifest.memoryPath))) {
      await writeFile(manifest.memoryPath, "", "utf8");
    }
    await ensureDir(routePaths.routeDir);
    await ensureDir(routePaths.sessionsDir);
    await ensureDir(routePaths.inboundAttachmentsDir);

    const queue = new RouteQueueStore(routePaths.queuePath, this.config.queueLeaseMs);
    await queue.load();
    await queue.recoverExpiredLeases();
    const journal = new JournalStore(routePaths.journalPath);
    await journal.load();
    const renderer = new DiscordRenderer({
      client: this.client,
      manifest,
      logger: this.logger,
      persistManifest: async () => {
        await this.registry.saveManifest(manifest);
      },
      flushMs: this.config.primaryFlushMs,
      enableDetailsThreads: this.config.enableDetailsThreads,
    });
    const host = new RouteSessionHost({
      agentDir: this.paths.agentDir,
      config: this.config,
      manifest,
      routePaths,
      journal,
      logger: this.logger,
      uploadFile: (filePath, options) => renderer.uploadFile(filePath, options),
    });

    const context: RouteContext = { manifest, routePaths, queue, journal, renderer, host };
    this.routeContexts.set(scope.routeKey, context);
    this.runInBackground("status-write-failed", async () => {
      await this.writeStatus();
    });
    return context;
  }

  async handleMessageCreate(message: Message): Promise<void> {
    if (!this.client.user || message.author?.bot) return;
    const authorization = authorizeInteraction(message, this.config);
    if (!authorization.allowed) return;

    const botMentioned = message.mentions.users.has(this.client.user.id);
    const isDm = !message.guildId;
    const triggerMatch = this.checkTriggerWord(message.content);

    const isWarmTrigger = !botMentioned && !isDm && triggerMatch;

    const scope = this.resolveScopeFromChannel(message.guildId ?? null, message.channelId, message.channel as Channel);
    const hotZoneKey = `${scope.routeKey}:${message.author.id}`;
    const now = Date.now();
    const inHotZone = (this.userHotZones.get(hotZoneKey) ?? 0) > now;

    const shouldProcess = botMentioned || isDm || triggerMatch || inHotZone;
    if (!shouldProcess) {
      const route = await this.getExistingRoute(scope);
      if (!route) return;
      await route.journal.append({
        kind: "ambient",
        sourceId: message.id,
        routeKey: route.manifest.routeKey,
        timestamp: Date.now(),
        text: message.content ?? "",
        authorId: message.author.id,
        authorName: message.author.username,
      } as JournalEntry);
      return;
    }

    const route = isWarmTrigger
      ? await this.getExistingRoute(scope)
      : await this.ensureRoute(scope);

    if (!route) return;
    if (route.journal.hasSource(message.id) || route.queue.hasSource(message.id)) return;

    const isExplicitTrigger = botMentioned || isDm || triggerMatch;
    if (isExplicitTrigger && this.config.hotZoneMinutes > 0) {
      const expiry = now + this.config.hotZoneMinutes * 60_000;
      this.userHotZones.set(hotZoneKey, expiry);
    }

    const savedAttachments = await this.saveInboundAttachments(route, [...message.attachments.values()], message.id);
    const replyContext = message.reference?.messageId ? await this.fetchReplyContext(message) : undefined;
    let rawText: string;
    if (botMentioned) {
      rawText = stripBotMention(message.content ?? "", this.client.user.id);
    } else if (triggerMatch) {
      rawText = stripTriggerWord(message.content ?? "", triggerMatch);
    } else {
      rawText = message.content ?? "";
    }
    const triggerLabel = isDm ? "dm" : (triggerMatch ? "trigger" : inHotZone ? "hotzone" : "mention");
    const promptText = buildPromptText({
      routeKey: route.manifest.routeKey,
      scope: route.manifest.scope,
      requester: { id: message.author.id, name: message.author.username },
      trigger: triggerLabel,
      rawText,
      replyContext,
      savedAttachments,
    });

    await route.renderer.startTyping();

    await route.journal.append({
      kind: "inbound",
      sourceId: message.id,
      routeKey: route.manifest.routeKey,
      timestamp: Date.now(),
      text: rawText,
      promptText,
      authorId: message.author.id,
      authorName: message.author.username,
      attachments: savedAttachments,
    } as JournalEntry);

    const item = await route.queue.enqueue({
      source: {
        kind: "message",
        sourceId: message.id,
        userId: message.author.id,
        guildId: message.guildId ?? null,
        channelId: scope.channelId,
        threadId: scope.threadId,
        trigger: isDm ? "dm" : "mention",
      },
      payload: {
        rawText,
        promptText,
        attachments: savedAttachments,
      },
    });
    await route.renderer.renderQueued(item);
    await this.scheduleWork();
  }

  async handleInteraction(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
    if (interaction.isButton()) {
      const [namespace, action, routeKey] = interaction.customId.split(":");
      if (namespace !== "pi-discord" || action !== "stop" || !routeKey) {
        return;
      }
      const authorization = authorizeInteraction(interaction, this.config);
      if (!authorization.allowed) {
        await interaction.reply({ content: authorization.reason ?? "Not allowed.", ephemeral: true });
        return;
      }
      if (!authorization.canControl) {
        await interaction.reply({ content: "Only admin Discord user ids may stop active runs.", ephemeral: true });
        return;
      }
      const stopped = await this.abortRoute(routeKey);
      const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel as Channel);
      await interaction.reply({
        content: stopped ? `Stop requested for ${formatRoute(scope)}.` : `No active run for ${formatRoute(scope)}.`,
        ephemeral: true,
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== this.config.commandName) return;

    const authorization = authorizeInteraction(interaction, this.config);
    if (!authorization.allowed) {
      if (interaction.isRepliable()) {
        const responder = interaction.deferred || interaction.replied 
          ? interaction.followUp.bind(interaction) 
          : interaction.reply.bind(interaction);
        await responder({ content: authorization.reason ?? "Not allowed.", ephemeral: true });
      }
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "status") {
      const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel as Channel);
      const route = await this.getExistingRoute(scope);
      if (!route) {
        await interaction.reply({ content: `Route ${formatRoute(scope)} has no saved state yet.`, ephemeral: true });
        return;
      }
      const queued = route.queue.list().filter((item) => item.state === "queued").length;
      const running = route.queue.list().filter((item) => item.state === "running" || item.state === "leased").length;
      await interaction.reply({ content: `Route ${formatRoute(route.manifest.scope)}\nQueued: ${queued}\nRunning: ${running}`, ephemeral: true });
      return;
    }

    if (subcommand === "stop") {
      if (!authorization.canControl) {
        await interaction.reply({ content: "Only admin Discord user ids may stop active runs.", ephemeral: true });
        return;
      }
      const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel as Channel);
      const stopped = await this.abortRoute(scope.routeKey);
      await interaction.reply({
        content: stopped ? `Stop requested for ${formatRoute(scope)}.` : `No active run for ${formatRoute(scope)}.`,
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "reset") {
      if (!authorization.canControl) {
        await interaction.reply({ content: "Only admin Discord user ids may reset routes.", ephemeral: true });
        return;
      }
      const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel as Channel);
      await this.abortRoute(scope.routeKey);
      const route = await this.getExistingRoute(scope);
      if (!route) {
        await interaction.reply({ content: `Route ${formatRoute(scope)} has no saved state to reset.`, ephemeral: true });
        return;
      }
      await route.host.dispose();
      route.manifest.sessionFile = undefined;
      await this.registry.saveManifest(route.manifest);
      await interaction.reply({ content: `Reset route ${formatRoute(scope)}.`, ephemeral: true });
      return;
    }

    if (subcommand !== "ask") return;

    const rawText = interaction.options.getString("text", true).trim();
    const scope = this.resolveScopeFromChannel(interaction.guildId ?? null, interaction.channelId, interaction.channel as Channel);
    const route = await this.ensureRoute(scope);
    if (route.journal.hasSource(interaction.id) || route.queue.hasSource(interaction.id)) {
      await interaction.reply({ content: "That interaction was already queued.", ephemeral: true });
      return;
    }

    const promptText = buildPromptText({
      routeKey: route.manifest.routeKey,
      scope: route.manifest.scope,
      requester: { id: interaction.user.id, name: interaction.user.username },
      trigger: "slash-command",
      rawText,
      savedAttachments: [],
    });

    await route.renderer.startTyping();
    await interaction.deferReply({ ephemeral: false });
    await interaction.deleteReply();

    await route.journal.append({
      kind: "interaction",
      sourceId: interaction.id,
      routeKey: route.manifest.routeKey,
      timestamp: Date.now(),
      text: rawText,
      promptText,
      authorId: interaction.user.id,
      authorName: interaction.user.username,
    } as JournalEntry);

    const item = await route.queue.enqueue({
      source: {
        kind: "interaction",
        sourceId: interaction.id,
        userId: interaction.user.id,
        guildId: interaction.guildId ?? null,
        channelId: scope.channelId,
        threadId: scope.threadId,
        trigger: "slash-command",
      },
      payload: {
        rawText,
        promptText,
        attachments: [],
      },
    });
    await route.renderer.renderQueued(item);
    await this.scheduleWork();
  }

  async saveInboundAttachments(route: RouteContext, attachments: unknown[], sourceId: string): Promise<AttachmentInfo[]> {
    const saved: AttachmentInfo[] = [];
    for (const attachment of attachments as { id: string; name?: string; url: string; contentType?: string }[]) {
      const extension = path.extname(attachment.name ?? "") || ".bin";
      const filePath = path.join(route.routePaths.inboundAttachmentsDir, `${sourceId}-${attachment.id}${extension}`);
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`Failed to download attachment ${attachment.url}: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(filePath, buffer);
      saved.push({
        path: filePath,
        name: attachment.name ?? path.basename(filePath),
        contentType: attachment.contentType,
        isImage: (attachment.contentType ?? "").startsWith("image/"),
      });
    }
    return saved;
  }

  async fetchReplyContext(message: Message): Promise<string | undefined> {
    try {
      const replied = await message.fetchReference();
      return `${replied.author?.username ?? "unknown"}: ${(replied.content ?? "").slice(0, 400)}`;
    } catch {
      return undefined;
    }
  }

  async scheduleWork(): Promise<void> {
    if (this.stopping) return;
    for (const route of this.routeContexts.values()) {
      if (this.currentRuns.size >= this.config.globalConcurrency) return;
      if (this.currentRuns.has(route.manifest.routeKey)) continue;
      const leased = await route.queue.leaseNext(this.workerId);
      if (!leased) continue;
      this.currentRuns.set(route.manifest.routeKey, { abort: async () => {
        const session = await route.host.ensureSession();
        await session.abort();
      } });
      this.runInBackground("status-write-failed", async () => {
        await this.writeStatus();
      }, { routeKey: route.manifest.routeKey });
      void this.processQueueItem(route, leased)
        .catch(async (error) => {
          await this.logger.error("queue-item-processing-failed", {
            routeKey: route.manifest.routeKey,
            itemId: leased.id,
            error: String(error),
          });
        })
        .finally(() => {
          this.currentRuns.delete(route.manifest.routeKey);
          this.runInBackground("status-write-failed", async () => {
            await this.writeStatus();
          }, { routeKey: route.manifest.routeKey });
          this.runInBackground("schedule-work-failed", async () => {
            await this.scheduleWork();
          }, { routeKey: route.manifest.routeKey });
        });
    }
  }

  async processQueueItem(route: RouteContext, leasedItem: QueueItem): Promise<void> {
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe = () => undefined;

    try {
      await route.queue.markRunning(leasedItem.id);
      route.renderer.currentAssistantText = "";
      await route.renderer.renderRunning(leasedItem);
      route.host.currentSourceId = leasedItem.source.sourceId;
      const session = await route.host.ensureSession();
      await this.registry.saveManifest(route.manifest);

      heartbeat = setInterval(() => {
        this.runInBackground("queue-heartbeat-failed", async () => {
          await route.queue.heartbeat(leasedItem.id);
        }, { routeKey: route.manifest.routeKey, itemId: leasedItem.id });
      }, Math.max(1_000, Math.floor(this.config.queueLeaseMs / 3)));

      unsubscribe = session.subscribe((event: unknown) => {
        route.renderer.handleSessionEvent(event as any);
      });

      const modelSupportsImages = this.config.enableImageInput && (session.model?.input?.includes?.("image") ?? false);
      const images: unknown[] = modelSupportsImages
        ? await Promise.all(
            (leasedItem.payload.attachments as QueueAttachment[])
              .filter((attachment) => attachment.isImage && attachment.contentType)
              .map((attachment) => toImageContent(attachment.path, attachment.contentType!)),
          )
        : [];
      await session.prompt(leasedItem.payload.promptText, {
        expandPromptTemplates: false,
        source: "extension",
        images: images as any[],
      });
      route.manifest.sessionFile = session.sessionFile;
      await this.registry.saveManifest(route.manifest);
      await route.queue.finish(leasedItem.id, "completed");
      await route.journal.append({
        kind: "assistant-final",
        routeKey: route.manifest.routeKey,
        timestamp: Date.now(),
        sourceId: leasedItem.id,
        text: route.renderer.currentAssistantText,
      } as JournalEntry);
      await route.renderer.renderSuccess();
    } catch (error) {
      const text = String(error);
      const nextState = /abort/i.test(text) ? "cancelled" : "failed";
      await route.queue.finish(leasedItem.id, nextState, text);
      await this.registry.saveManifest(route.manifest);
      await route.journal.append({
        kind: nextState === "cancelled" ? "assistant-cancelled" : "assistant-error",
        routeKey: route.manifest.routeKey,
        timestamp: Date.now(),
        sourceId: leasedItem.id,
        error: text,
      } as JournalEntry);
      if (nextState === "cancelled") {
        await route.renderer.renderCancelled("Run stopped.");
      } else {
        await route.renderer.renderFailure(text);
      }
    } finally {
      route.host.currentSourceId = undefined;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      route.renderer.stopTyping();
    }
  }

  async abortRoute(routeKey: string): Promise<boolean> {
    const active = this.currentRuns.get(routeKey);
    if (active) {
      await active.abort();
      return true;
    }
    return false;
  }

  async reconcileKnownRoutes(): Promise<void> {
    for (const summary of this.registry.list()) {
      try {
        const route = await this.ensureRoute({ ...summary.scope, routeKey: summary.routeKey });
        const channel = await this.client.channels.fetch(route.manifest.scope.threadId ?? route.manifest.scope.channelId);
        if (!channel || !("messages" in channel)) continue;
        const recent = await (channel as GuildTextBasedChannel).messages.fetch({ limit: 15 });
        for (const message of [...recent.values()].reverse()) {
          if (message.author?.bot) continue;
          if (!authorizeInteraction(message, this.config).allowed) continue;
          if (route.journal.hasSource(message.id)) continue;
          await route.journal.append({
            kind: "ambient",
            sourceId: message.id,
            routeKey: route.manifest.routeKey,
            timestamp: message.createdTimestamp,
            text: message.content ?? "",
            authorId: message.author?.id,
            authorName: message.author?.username,
          } as JournalEntry);
        }
      } catch (error) {
        await this.logger.warn("route-reconcile-failed", { routeKey: summary.routeKey, error: String(error) });
      }
    }
  }

  async writeStatus(extra: Partial<DaemonStatus> = {}): Promise<void> {
    this.status = {
      ...this.status,
      ...extra,
      pid: process.pid,
      routeCount: this.registry.list().length,
      activeRuns: [...this.currentRuns.keys()],
    };
    await writeJson(this.paths.statusPath, this.status);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const active of this.currentRuns.values()) {
      await active.abort().catch(() => undefined);
    }
    this.currentRuns.clear();
    for (const route of this.routeContexts.values()) {
      await route.host.dispose();
    }
    await this.writeStatus({ phase: "stopping" });
    this.client.destroy();
    await removeIfExists(this.paths.pidPath);
    await removeIfExists(this.paths.lockPath);
  }
}
