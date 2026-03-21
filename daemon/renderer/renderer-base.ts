import { basename } from "node:path";
import { AttachmentBuilder, ChannelType, type Client } from "discord.js";
import { DISCORD_MESSAGE_LIMIT } from "../../lib/constants.js";
import type { RouteManifest } from "../registry.js";
import type { Logger } from "../logger.js";
import type { QueueItem } from "../queue-store.js";
import type { DiscordRendererOptions, SessionEvent, WritableChannel, ToolParams } from "./types.js";
import { splitDiscordText } from "./utils.js";
import { extractToolContent } from "./extraction.js";
import { getLanguageFromExtension } from "./languages.js";

export class DiscordRenderer {
  client: Client;
  manifest: RouteManifest;
  logger: Logger;
  persistManifest: () => Promise<void>;
  enableDetailsThreads: boolean;
  currentAssistantText: string;
  private typingInterval: NodeJS.Timeout | undefined;
  lastMessageId: string | undefined;
  lastSentIndex: number;
  sendingLock: boolean;
  creatingPlaceholder: boolean;
  lastSentContent: string | undefined;
  pendingTools: number;
  toolIndicatorMessageId: string | undefined;
  creatingIndicator: boolean;
  private toolQueue: Array<() => Promise<void>>;
  private processingToolQueue: boolean;
  private toolParams: Map<string, ToolParams>;
  private currentToolKey: string | null;
  private textQueue: string[];
  private processingTextQueue: boolean;
  private lastQueuedText: string;

  constructor(options: DiscordRendererOptions) {
    this.client = options.client;
    this.manifest = options.manifest;
    this.logger = options.logger;
    this.persistManifest = options.persistManifest;
    this.enableDetailsThreads = options.enableDetailsThreads;
    this.currentAssistantText = "";
    this.typingInterval = undefined;
    this.lastMessageId = undefined;
    this.lastSentIndex = 0;
    this.sendingLock = false;
    this.creatingPlaceholder = false;
    this.lastSentContent = undefined;
    this.pendingTools = 0;
    this.toolIndicatorMessageId = undefined;
    this.creatingIndicator = false;
    this.toolQueue = [];
    this.processingToolQueue = false;
    this.toolParams = new Map();
    this.currentToolKey = null;
    this.textQueue = [];
    this.processingTextQueue = false;
    this.lastQueuedText = "";
  }

  enqueueTextSend(text: string): void {
    if (text !== this.lastQueuedText) {
      this.textQueue.push(text);
      this.lastQueuedText = text;
      void this.processTextQueue();
    }
  }

  private async processTextQueue(): Promise<void> {
    if (this.processingTextQueue) return;
    this.processingTextQueue = true;
    while (this.textQueue.length > 0) {
      const text = this.textQueue.shift();
      if (!text) continue;
      try {
        await this.sendTextChunk(text);
      } catch (error) {
        await this.logger.warn("text-send-failed", {
          routeKey: this.manifest.routeKey,
          error: String(error),
        });
      }
    }
    this.processingTextQueue = false;
  }

  enqueueToolOperation(operation: () => Promise<void>): void {
    this.toolQueue.push(operation);
    void this.processToolQueue();
  }

  private async processToolQueue(): Promise<void> {
    if (this.processingToolQueue) return;
    this.processingToolQueue = true;
    while (this.toolQueue.length > 0) {
      const operation = this.toolQueue.shift();
      if (!operation) continue;
      try {
        await operation();
      } catch (error) {
        await this.logger.warn("tool-queue-operation-failed", {
          routeKey: this.manifest.routeKey,
          error: String(error),
        });
      }
    }
    this.processingToolQueue = false;
  }

  async getTargetChannel(): Promise<WritableChannel> {
    const targetId = this.manifest.scope.threadId ?? this.manifest.scope.channelId;
    const channel = await this.client.channels.fetch(targetId);
    if (!channel || !("send" in channel)) {
      throw new Error(`Discord channel ${targetId} is not writable.`);
    }
    return channel as WritableChannel;
  }

  async ensureDetailsThread(): Promise<WritableChannel | undefined> {
    if (!this.enableDetailsThreads) return undefined;
    if (this.manifest.detailsThreadId) {
      try {
        const channel = await this.client.channels.fetch(this.manifest.detailsThreadId);
        if (channel && "send" in channel) {
          await this.logger.info("details-thread-reused", {
            routeKey: this.manifest.routeKey,
            threadId: this.manifest.detailsThreadId,
          });
          return channel as WritableChannel;
        }
      } catch (err) {
        await this.logger.warn("details-thread-fetch-failed", {
          routeKey: this.manifest.routeKey,
          error: String(err),
        });
      }
      this.manifest.detailsThreadId = undefined;
    }
    return undefined;
  }

  async clearDetailsThread(reason: string, error: unknown): Promise<void> {
    this.manifest.detailsThreadId = undefined;
    await this.logger.warn(reason, { routeKey: this.manifest.routeKey, error: String(error) });
  }

  async uploadContentToThread(
    filename: string,
    content: string,
    lang: string,
    options: { title?: string } = {},
  ): Promise<{ messageId: string; url?: string }> {
    let thread = await this.ensureDetailsThread();
    if (!thread && this.enableDetailsThreads) {
      if (!this.toolIndicatorMessageId) await this.showToolIndicator();
      const threadAnchorId = this.toolIndicatorMessageId;
      if (threadAnchorId) {
        try {
          const channel = await this.getTargetChannel();
          if ("messages" in channel) {
            const message = await channel.messages.fetch(threadAnchorId);
            if (typeof (message as any).startThread === "function") {
              thread = await (message as any).startThread({
                name: "Tool calls",
                autoArchiveDuration: 60,
              });
              this.manifest.detailsThreadId = thread.id;
              await this.logger.info("tool-thread-created-for-content", {
                routeKey: this.manifest.routeKey,
                threadId: thread.id,
              });
            }
          }
        } catch (err) {
          await this.logger.warn("tool-thread-create-for-content-failed", { error: String(err) });
        }
      }
    }

    const payload = {
      content: options.title ?? `\`\`\`${lang}\n${filename}\n\`\`\``, 
      files: [new AttachmentBuilder(Buffer.from(content), { name: filename })],
      allowedMentions: { parse: [] as never[] },
    };

    if (thread && "send" in thread) {
      try {
        const message = await thread.send(payload);
        return { messageId: message.id, url: message.attachments.first()?.url };
      } catch (error) {
        await this.clearDetailsThread("details-thread-content-upload-failed", error);
      }
    }

    const channel = await this.getTargetChannel();
    const message = await channel.send(payload);
    return { messageId: message.id, url: message.attachments.first()?.url };
  }

  private createUploadPayload(filePath: string, options: { title?: string } = {}) {
    return {
      content: options.title ?? `Uploaded ${basename(filePath)}`,
      files: [new AttachmentBuilder(filePath, { name: basename(filePath) })],
      allowedMentions: { parse: [] as never[] },
    };
  }

  async uploadFile(filePath: string, options: { title?: string } = {}): Promise<{ messageId: string; url?: string }> {
    const thread = await this.ensureDetailsThread();
    if (thread && "send" in thread) {
      try {
        const message = await thread.send(this.createUploadPayload(filePath, options));
        return { messageId: message.id, url: message.attachments.first()?.url };
      } catch (error) {
        await this.clearDetailsThread("details-thread-upload-failed", error);
      }
    }
    const channel = await this.getTargetChannel();
    const message = await channel.send(this.createUploadPayload(filePath, options));
    return { messageId: message.id, url: message.attachments.first()?.url };
  }

  async uploadJsonToThread(
    filename: string,
    jsonContent: string,
    options: { title?: string } = {},
  ): Promise<{ messageId: string; url?: string }> {
    let thread = await this.ensureDetailsThread();
    if (!thread && this.enableDetailsThreads) {
      if (!this.toolIndicatorMessageId) await this.showToolIndicator();
      const threadAnchorId = this.toolIndicatorMessageId;
      if (threadAnchorId) {
        try {
          const channel = await this.getTargetChannel();
          if ("messages" in channel) {
            const message = await channel.messages.fetch(threadAnchorId);
            if (typeof (message as any).startThread === "function") {
              thread = await (message as any).startThread({
                name: "Tool calls",
                autoArchiveDuration: 60,
              });
              this.manifest.detailsThreadId = thread.id;
              await this.logger.info("tool-thread-created-for-upload", {
                routeKey: this.manifest.routeKey,
                threadId: thread.id,
              });
            }
          }
        } catch (err) {
          await this.logger.warn("tool-thread-create-for-upload-failed", { error: String(err) });
        }
      }
    }

    const payload = {
      content: options.title ?? `\`\`\`json\n${filename}\n\`\`\``, 
      files: [new AttachmentBuilder(Buffer.from(jsonContent), { name: filename })],
      allowedMentions: { parse: [] as never[] },
    };

    if (thread && "send" in thread) {
      try {
        const message = await thread.send(payload);
        return { messageId: message.id, url: message.attachments.first()?.url };
      } catch (error) {
        await this.clearDetailsThread("details-thread-json-upload-failed", error);
      }
    }

    const channel = await this.getTargetChannel();
    const message = await channel.send(payload);
    return { messageId: message.id, url: message.attachments.first()?.url };
  }

  async postToolDetail(content: string): Promise<void> {
    if (!this.toolIndicatorMessageId) await this.showToolIndicator();
    const threadAnchorId = this.toolIndicatorMessageId;
    if (!threadAnchorId) {
      await this.logger.error("tool-thread-fatal", {
        routeKey: this.manifest.routeKey,
        error: "Failed to create indicator anchor",
      });
      return;
    }

    if (!this.manifest.detailsThreadId && this.enableDetailsThreads) {
      try {
        const channel = await this.getTargetChannel();
        if ("messages" in channel) {
          const message = await channel.messages.fetch(threadAnchorId);
          if (typeof (message as any).startThread === "function") {
            const thread = await (message as any).startThread({
              name: "Tool calls",
              autoArchiveDuration: 60,
            });
            this.manifest.detailsThreadId = thread.id;
            await thread.send({ content: content.slice(0, DISCORD_MESSAGE_LIMIT), allowedMentions: { parse: [] as never[] } });
            await this.logger.info("tool-detail-posted", {
              routeKey: this.manifest.routeKey,
              content: content.slice(0, 50),
              threadId: thread.id,
            });
            return;
          }
        }
      } catch (err) {
        await this.logger.warn("tool-thread-create-failed", {
          routeKey: this.manifest.routeKey,
          error: String(err),
        });
      }
    }

    const thread = await this.ensureDetailsThread();
    if (thread && "send" in thread) {
      await thread.send({ content: content.slice(0, DISCORD_MESSAGE_LIMIT), allowedMentions: { parse: [] as never[] } });
    }
  }

  async showToolIndicator(): Promise<void> {
    if (this.creatingIndicator || this.toolIndicatorMessageId) return;
    this.creatingIndicator = true;
    try {
      const channel = await this.getTargetChannel();
      const indicator = await channel.send({
        content: "🛠️ Using tools...",
        allowedMentions: { parse: [] as never[] },
      });
      this.toolIndicatorMessageId = indicator.id;
      this.lastMessageId = indicator.id;
      await this.logger.info("tool-indicator-shown", {
        routeKey: this.manifest.routeKey,
        messageId: indicator.id,
      });
    } catch (err) {
      await this.logger.warn("tool-indicator-failed", {
        routeKey: this.manifest.routeKey,
        error: String(err),
      });
    } finally {
      this.creatingIndicator = false;
    }
  }

  async hideToolIndicator(): Promise<void> {
    this.toolIndicatorMessageId = undefined;
    this.creatingIndicator = false;
  }

  async sendIncrementalResponse(): Promise<void> {
    const fullText = this.currentAssistantText;
    if (!fullText || this.lastSentIndex >= fullText.length) return;
    const unsentText = fullText.slice(this.lastSentIndex).trimStart();
    if (!unsentText || unsentText.length < 20) return;

    let sendLength = 0;
    const paraBreakIndex = unsentText.indexOf("\n\n");
    if (paraBreakIndex >= 0) {
      sendLength = paraBreakIndex + 2;
    } else {
      const sentenceMatch = unsentText.match(/.*[.!?]\s+/s);
      if (sentenceMatch && sentenceMatch[0].length >= 50) {
        sendLength = sentenceMatch[0].length;
      } else {
        return;
      }
    }

    const textToSend = unsentText.slice(0, sendLength).trim();
    if ((textToSend.match(/```/g) || []).length % 2 === 1) return;
    if (!textToSend || textToSend.length < 30) return;

    this.lastSentIndex += sendLength;
    await this.sendTextChunk(textToSend);
  }

  async sendTextChunk(text: string): Promise<void> {
    try {
      const channel = await this.getTargetChannel();
      const message = await channel.send({
        content: text.slice(0, DISCORD_MESSAGE_LIMIT),
        allowedMentions: { parse: [] as never[] },
      });
      this.lastMessageId = message.id;
      this.lastSentContent = text;
      await this.logger.info("message-sent", {
        routeKey: this.manifest.routeKey,
        messageId: message.id,
      });
    } catch (error) {
      await this.logger.warn("text-send-failed", { error: String(error) });
    }
  }

  handleSessionEvent(event: SessionEvent): void {
    if (event.type !== "message_update") {
      this.logger.info("session-event", {
        routeKey: this.manifest.routeKey,
        eventType: event.type,
        hasToolName: !!event.toolName,
      });
    }

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.currentAssistantText += event.assistantMessageEvent.delta ?? "";
      this.sendIncrementalResponse();
    }

    if (event.type === "tool_execution_start") {
      this.enqueueToolOperation(async () => {
        const isFirstTool = this.pendingTools === 0;
        this.pendingTools++;
        if (event.toolName) {
          const key = `${event.toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.currentToolKey = key;
          if (event.args) {
            this.toolParams.set(key, { name: event.toolName, params: event.args });
          }
        }
        if (isFirstTool) await this.showToolIndicator();
      });
    }

    if (event.type === "tool_execution_end") {
      this.enqueueToolOperation(async () => {
        const toolDisplay = `🛠️ **${event.toolName}**`;
        const key = this.currentToolKey;
        const stored = key ? this.toolParams.get(key) : null;
        const params = stored?.params;
        if (key) {
          this.toolParams.delete(key);
          this.currentToolKey = null;
        }

        if (event.result) {
          const { content, filename, isDiff } = extractToolContent(event, params, this.logger, this.manifest.routeKey);
          if (content) {
            let ext = filename ? filename.split(".").pop() : "txt";
            if (event.toolName === "read" && !filename) ext = "txt";
            if (isDiff) ext = "diff";
            const lang = getLanguageFromExtension(ext);
            const displayFilename = filename || `${event.toolName}-result.${ext}`;
            if (content.length > 1000) {
              await this.uploadContentToThread(displayFilename, content, lang, { title: toolDisplay });
            } else {
              const resultDisplay = `\n\`\`\`${lang}\n${content}\n\`\`\``;
              await this.postToolDetail(`${toolDisplay}${resultDisplay}`);
            }
          } else {
            const resultJson = JSON.stringify(event.result, null, 2);
            if (resultJson.length > 1000) {
              await this.uploadContentToThread(`${event.toolName}-result.json`, resultJson, "json", { title: toolDisplay });
            } else {
              const resultDisplay = `\n\`\`\`json\n${resultJson}\n\`\`\``;
              await this.postToolDetail(`${toolDisplay}${resultDisplay}`);
            }
          }
        } else {
          await this.postToolDetail(toolDisplay);
        }
        this.pendingTools = Math.max(0, this.pendingTools - 1);
        if (this.pendingTools === 0) await this.hideToolIndicator();
      });
    }
  }

  async renderQueued(item: QueueItem): Promise<void> {
    this.currentAssistantText = "";
    this.lastSentIndex = 0;
    this.lastSentContent = undefined;
    this.creatingPlaceholder = false;
    this.pendingTools = 0;
    this.toolIndicatorMessageId = undefined;
    this.manifest.detailsThreadId = undefined;
    this.startTyping();
  }

  async renderRunning(item: QueueItem): Promise<void> {
    this.startTyping();
  }

  startTyping(): void {
    this.stopTyping();
    void this.sendTyping();
    this.typingInterval = setInterval(() => void this.sendTyping(), 8000);
  }

  async sendTyping(): Promise<void> {
    try {
      const channel = await this.getTargetChannel();
      if (channel && "sendTyping" in channel) {
        await (channel as any).sendTyping();
      }
    } catch {
      // Ignore typing errors
    }
  }

  stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = undefined;
    }
  }

  async renderSuccess(): Promise<void> {
    this.stopTyping();
    const remaining = this.currentAssistantText.slice(this.lastSentIndex).trim();
    if (remaining) {
      const normalizedLast = this.lastSentContent?.trim();
      const normalizedCurrent = remaining.trim();
      if (normalizedLast !== normalizedCurrent) {
        try {
          const channel = await this.getTargetChannel();
          const message = await channel.send({ content: remaining.slice(0, DISCORD_MESSAGE_LIMIT), allowedMentions: { parse: [] as never[] } });
          this.lastSentContent = normalizedCurrent;
          this.lastMessageId = message.id;
          await this.logger.info("success-remaining-sent", {
            routeKey: this.manifest.routeKey,
            messageId: message.id,
            content: normalizedCurrent.slice(0, 50),
          });
        } catch (err) {
          await this.logger.warn("success-remaining-failed", { error: String(err) });
        }
      } else {
        await this.logger.info("success-duplicate-prevented", {
          routeKey: this.manifest.routeKey,
          content: normalizedCurrent.slice(0, 50),
        });
      }
    }
    this.currentAssistantText = "";
    this.lastSentIndex = 0;
    this.lastSentContent = undefined;
    this.pendingTools = 0;
    this.toolIndicatorMessageId = undefined;
  }

  async renderCancelled(reason = "Stopped."): Promise<void> {
    this.stopTyping();
    try {
      const channel = await this.getTargetChannel();
      await channel.send({ content: `*${reason}*`, allowedMentions: { parse: [] as never[] } });
    } catch {
      // Ignore send errors
    }
  }

  async renderFailure(error: unknown): Promise<void> {
    this.stopTyping();
    try {
      const channel = await this.getTargetChannel();
      await channel.send({ content: `**Error:** ${String(error).slice(0, 1800)}`, allowedMentions: { parse: [] as never[] } });
    } catch {
      // Ignore send errors
    }
  }
}
