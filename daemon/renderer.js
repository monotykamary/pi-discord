import { basename } from "node:path";
import { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { DISCORD_MESSAGE_LIMIT } from "../lib/constants.js";

export function splitDiscordText(text) {
  if (!text) return ["(no assistant output)"];
  const chunks = [];
  let remaining = text;
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    let index = remaining.lastIndexOf("\n", DISCORD_MESSAGE_LIMIT);
    if (index < 200) index = DISCORD_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class DiscordRenderer {
  /**
   * @param {{
   *   client: import('discord.js').Client,
   *   manifest: import('./registry.js').RouteManifest,
   *   logger: import('./logger.js').Logger,
   *   persistManifest: () => Promise<void>,
   *   flushMs: number,
   *   enableDetailsThreads: boolean,
   * }} options
   */
  constructor(options) {
    this.client = options.client;
    this.manifest = options.manifest;
    this.logger = options.logger;
    this.persistManifest = options.persistManifest;
    this.flushMs = options.flushMs;
    this.enableDetailsThreads = options.enableDetailsThreads;
    this.currentAssistantText = "";
    this.flushTimer = undefined;
  }

  runInBackground(label, task) {
    void Promise.resolve()
      .then(task)
      .catch(async (error) => {
        await this.logger.warn(label, { routeKey: this.manifest.routeKey, error: String(error) });
      });
  }

  async getTargetChannel() {
    const targetId = this.manifest.scope.threadId ?? this.manifest.scope.channelId;
    const channel = await this.client.channels.fetch(targetId);
    if (!channel || !("send" in channel)) {
      throw new Error(`Discord channel ${targetId} is not writable.`);
    }
    return channel;
  }

  createStopRow() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pi-discord:stop:${this.manifest.routeKey}`)
          .setLabel("Stop")
          .setStyle(ButtonStyle.Danger),
      ),
    ];
  }

  async ensurePrimaryMessage(fallbackText = "Working...") {
    const channel = await this.getTargetChannel();
    if (this.manifest.primaryMessageId && "messages" in channel) {
      try {
        const existing = await channel.messages.fetch(this.manifest.primaryMessageId);
        return existing;
      } catch {
        this.manifest.primaryMessageId = undefined;
      }
    }

    const message = await channel.send({
      content: fallbackText,
      components: this.createStopRow(),
      allowedMentions: { parse: [] },
    });
    this.manifest.primaryMessageId = message.id;
    await this.persistManifest();
    return message;
  }

  async updatePrimary(content, { keepStop = true } = {}) {
    const message = await this.ensurePrimaryMessage(content);
    const chunks = splitDiscordText(content);
    const primaryContent = keepStop && chunks.length > 1
      ? `${chunks[0]}\n\n[Output truncated while streaming. Full response will be posted when the run finishes.]`
      : chunks[0];

    await message.edit({
      content: primaryContent,
      components: keepStop ? this.createStopRow() : [],
      allowedMentions: { parse: [] },
    });
    await this.persistManifest();

    if (!keepStop && chunks.length > 1) {
      const channel = await this.getTargetChannel();
      for (const chunk of chunks.slice(1)) {
        await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      }
    }
  }

  schedulePrimaryFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.runInBackground("primary-update-failed", async () => {
        await this.updatePrimary("*Thinking...*", { keepStop: true });
      });
    }, this.flushMs);
  }

  async ensureDetailsThread() {
    if (!this.enableDetailsThreads) return undefined;
    if (!this.manifest.detailsThreadId || !this.manifest.primaryMessageId) {
      const primary = await this.ensurePrimaryMessage();
      if (typeof primary.startThread !== "function") return undefined;
      try {
        const thread = await primary.startThread({
          name: `pi details ${new Date().toISOString().slice(11, 19)}`,
          autoArchiveDuration: 60,
        });
        this.manifest.detailsThreadId = thread.id;
        await this.persistManifest();
        return thread;
      } catch (error) {
        await this.logger.warn("details-thread-create-failed", { routeKey: this.manifest.routeKey, error: String(error) });
        return undefined;
      }
    }

    try {
      const channel = await this.client.channels.fetch(this.manifest.detailsThreadId);
      return channel && "send" in channel ? channel : undefined;
    } catch {
      this.manifest.detailsThreadId = undefined;
      await this.persistManifest();
      return undefined;
    }
  }

  async clearDetailsThread(reason, error) {
    this.manifest.detailsThreadId = undefined;
    await this.persistManifest();
    await this.logger.warn(reason, { routeKey: this.manifest.routeKey, error: String(error) });
  }

  async postDetail(content, { fallbackToChannel = true } = {}) {
    const payload = { content: content.slice(0, DISCORD_MESSAGE_LIMIT), allowedMentions: { parse: [] } };
    const thread = await this.ensureDetailsThread();
    if (thread && "send" in thread && thread.type !== ChannelType.DM) {
      try {
        await thread.send(payload);
        return true;
      } catch (error) {
        await this.clearDetailsThread("details-thread-send-failed", error);
      }
    }
    if (!fallbackToChannel) return false;
    const channel = await this.getTargetChannel();
    await channel.send(payload);
    return true;
  }

  createUploadPayload(filePath, options = {}) {
    return {
      content: options.title ?? `Uploaded ${basename(filePath)}`,
      files: [new AttachmentBuilder(filePath, { name: basename(filePath) })],
      allowedMentions: { parse: [] },
    };
  }

  async uploadFile(filePath, options = {}) {
    const thread = await this.ensureDetailsThread();
    if (thread && "send" in thread) {
      try {
        const message = await thread.send(this.createUploadPayload(filePath, options));
        return {
          messageId: message.id,
          url: message.attachments.first()?.url,
        };
      } catch (error) {
        await this.clearDetailsThread("details-thread-upload-failed", error);
      }
    }

    const channel = await this.getTargetChannel();
    const message = await channel.send(this.createUploadPayload(filePath, options));
    return {
      messageId: message.id,
      url: message.attachments.first()?.url,
    };
  }

  handleSessionEvent(event) {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.currentAssistantText += event.assistantMessageEvent.delta;
      this.schedulePrimaryFlush();
    }
    if (event.type === "tool_execution_start") {
      this.runInBackground("tool-detail-post-failed", async () => {
        await this.postDetail(`Tool started: ${event.toolName}`);
      });
    }
    if (event.type === "tool_execution_end") {
      this.runInBackground("tool-detail-post-failed", async () => {
        await this.postDetail(`Tool finished: ${event.toolName}${event.isError ? " (error)" : ""}`);
      });
    }
  }

  async renderQueued(item) {
    await this.updatePrimary("*Thinking...*", { keepStop: true });
  }

  async renderRunning(item) {
    await this.updatePrimary("*Thinking...*", { keepStop: true });
  }

  async renderSuccess() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.updatePrimary(this.currentAssistantText || "Done.", { keepStop: false });
  }

  async renderCancelled(reason = "Stopped.") {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.updatePrimary(`*${reason}*`, { keepStop: false });
  }

  async renderFailure(error) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.updatePrimary(`**Error:** ${String(error).slice(0, 1800)}`, { keepStop: false });
  }
}
