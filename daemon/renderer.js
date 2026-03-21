import { basename } from "node:path";
import { AttachmentBuilder, ChannelType } from "discord.js";
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
    this.enableDetailsThreads = options.enableDetailsThreads;
    this.currentAssistantText = "";
    this.typingInterval = undefined;
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

  async ensureDetailsThread() {
    // Details thread requires a primary message - returns undefined if not set
    if (!this.enableDetailsThreads || !this.manifest.primaryMessageId) {
      return undefined;
    }
    if (this.manifest.detailsThreadId) {
      try {
        const channel = await this.client.channels.fetch(this.manifest.detailsThreadId);
        return channel && "send" in channel ? channel : undefined;
      } catch {
        this.manifest.detailsThreadId = undefined;
        await this.persistManifest();
        return undefined;
      }
    }
    return undefined;
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
    // Accumulate response text for final message
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.currentAssistantText += event.assistantMessageEvent.delta;
    }
    // Tool events are logged to journal only, not posted to Discord
    // for clean conversation flow
  }

  async renderQueued(item) {
    this.startTyping();
  }

  async renderRunning(item) {
    this.startTyping();
  }

  startTyping() {
    this.stopTyping();
    this.sendTyping();
    this.typingInterval = setInterval(() => {
      this.sendTyping();
    }, 8000);
  }

  async sendTyping() {
    try {
      const channel = await this.getTargetChannel();
      if (channel && "sendTyping" in channel) {
        await channel.sendTyping();
      }
    } catch {
      // Ignore typing errors
    }
  }

  stopTyping() {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = undefined;
    }
  }

  async renderSuccess() {
    this.stopTyping();
    const channel = await this.getTargetChannel();
    const chunks = splitDiscordText(this.currentAssistantText || "Done.");
    const message = await channel.send({ content: chunks[0], allowedMentions: { parse: [] } });
    this.manifest.primaryMessageId = message.id;
    await this.persistManifest();
    // Send remaining chunks if any
    for (const chunk of chunks.slice(1)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }

  async renderCancelled(reason = "Stopped.") {
    this.stopTyping();
    const channel = await this.getTargetChannel();
    await channel.send({ content: `*${reason}*`, allowedMentions: { parse: [] } });
  }

  async renderFailure(error) {
    this.stopTyping();
    const channel = await this.getTargetChannel();
    await channel.send({ content: `**Error:** ${String(error).slice(0, 1800)}`, allowedMentions: { parse: [] } });
  }
}
