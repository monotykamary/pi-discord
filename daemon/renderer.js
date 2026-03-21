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
    this.lastMessageId = undefined;
    this.lastSentIndex = 0;
    this.sendingLock = false;
    this.creatingPlaceholder = false;
    this.lastSentContent = undefined;
    this.creatingPlaceholder = false; // Prevent duplicate placeholder messages
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
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.currentAssistantText += event.assistantMessageEvent.delta;
      // Send incremental messages as text arrives (natural conversation)
      this.sendIncrementalResponse();
    }
    if (event.type === "tool_execution_start") {
      this.runInBackground("tool-post-failed", async () => {
        await this.postToolDetail(`🛠️ ${event.toolName}...`);
      });
    }
    if (event.type === "tool_execution_end") {
      this.runInBackground("tool-post-failed", async () => {
        const status = event.isError ? " ❌ failed" : " ✅";
        await this.postToolDetail(`${event.toolName}${status}`);
      });
    }
  }

  async sendIncrementalResponse() {
    // Prevent concurrent execution
    if (this.sendingLock) return;
    this.sendingLock = true;
    
    try {
      const fullText = this.currentAssistantText;
      
      // Safety: nothing to send or all already sent
      if (!fullText || this.lastSentIndex >= fullText.length) {
        return;
      }
      
      const unsentText = fullText.slice(this.lastSentIndex).trimStart();
      
      // Not enough content to send yet
      if (!unsentText || unsentText.length < 20) {
        return;
      }
      
      // Check for paragraph break or sentence end in unsent portion
      const paraBreakIndex = unsentText.indexOf('\n\n');
      const hasParagraphBreak = paraBreakIndex >= 0;
      
      // Find sentence end if no paragraph break
      let sendLength = 0;
      if (hasParagraphBreak) {
        sendLength = paraBreakIndex + 2; // Include the \n\n
      } else {
        // Check for sentence ending
        const sentenceMatch = unsentText.match(/.*[.!?]\s*/s);
        if (sentenceMatch) {
          sendLength = sentenceMatch[0].length;
        } else {
          return; // No good break point yet
        }
      }
      
      // Don't break inside code blocks
      const textToConsider = unsentText.slice(0, sendLength);
      const inCodeBlock = (textToConsider.match(/```/g) || []).length % 2 === 1;
      if (inCodeBlock) {
        return;
      }
      
      // Must have substantial content
      if (sendLength < 10) {
        return;
      }
      
      const toSend = textToConsider.trim();
      if (!toSend) {
        return;
      }
      
      // CRITICAL: Check if we already sent this exact content
      // This prevents race condition duplicates
      if (this.lastSentContent === toSend) {
        return;
      }
      
      // Send the message
      const channel = await this.getTargetChannel();
      const message = await channel.send({ 
        content: toSend.slice(0, DISCORD_MESSAGE_LIMIT), 
        allowedMentions: { parse: [] } 
      });
      
      // Update tracking
      this.lastMessageId = message.id;
      this.lastSentIndex += sendLength;
      this.lastSentContent = toSend; // Track what we just sent
      
    } catch (error) {
      // Log error but don't throw - sending is best effort
      await this.logger.warn("incremental-send-failed", { error: String(error) });
    } finally {
      this.sendingLock = false;
    }
  }

  async postToolDetail(content) {
    // If no message exists yet, create a placeholder for the thread
    if (!this.lastMessageId && !this.creatingPlaceholder) {
      this.creatingPlaceholder = true;
      try {
        const channel = await this.getTargetChannel();
        const placeholder = await channel.send({ 
          content: "🛠️ Using tools...", 
          allowedMentions: { parse: [] } 
        });
        this.lastMessageId = placeholder.id;
      } catch {
        // Can't create placeholder, skip tool detail
      } finally {
        this.creatingPlaceholder = false;
      }
    }
    
    // If still no messageId (creation failed or in progress), skip
    if (!this.lastMessageId) {
      return;
    }
    
    // Create thread off last message if not exists
    if (!this.manifest.detailsThreadId && this.enableDetailsThreads && this.lastMessageId) {
      try {
        const channel = await this.getTargetChannel();
        if ("messages" in channel) {
          const message = await channel.messages.fetch(this.lastMessageId);
          if (typeof message.startThread === "function") {
            const thread = await message.startThread({
              name: "Tool calls",
              autoArchiveDuration: 60,
            });
            this.manifest.detailsThreadId = thread.id;
            await this.persistManifest();
          }
        }
      } catch (err) {
        // Thread creation failed, log but continue
        await this.logger.warn("tool-thread-create-failed", { 
          routeKey: this.manifest.routeKey, 
          lastMessageId: this.lastMessageId,
          error: String(err) 
        });
      }
    }
    
    // Post to thread or silently skip if no thread
    const thread = await this.ensureDetailsThread();
    if (thread && "send" in thread) {
      try {
        await thread.send({ 
          content: content.slice(0, DISCORD_MESSAGE_LIMIT), 
          allowedMentions: { parse: [] } 
        });
      } catch (err) {
        // Log but don't throw
        await this.logger.warn("tool-thread-send-failed", { 
          routeKey: this.manifest.routeKey,
          content: content.slice(0, 50),
          error: String(err) 
        });
      }
    } else {
      await this.logger.info("tool-thread-not-available", { 
        routeKey: this.manifest.routeKey,
        hasThreadId: !!this.manifest.detailsThreadId,
        hasLastMessageId: !!this.lastMessageId,
        enableDetailsThreads: this.enableDetailsThreads
      });
    }
  }

  async renderQueued(item) {
    this.currentAssistantText = "";
    this.lastSentIndex = 0;
    this.lastSentContent = undefined;
    this.creatingPlaceholder = false;
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
    // Send any remaining unsent text
    const remaining = this.currentAssistantText.slice(this.lastSentIndex).trim();
    if (remaining) {
      try {
        const channel = await this.getTargetChannel();
        await channel.send({ content: remaining.slice(0, DISCORD_MESSAGE_LIMIT), allowedMentions: { parse: [] } });
      } catch {
        // Ignore send errors
      }
    }
    // Reset for next request
    this.currentAssistantText = "";
    this.lastSentIndex = 0;
  }

  async renderCancelled(reason = "Stopped.") {
    this.stopTyping();
    try {
      const channel = await this.getTargetChannel();
      await channel.send({ content: `*${reason}*`, allowedMentions: { parse: [] } });
    } catch {
      // Ignore send errors
    }
  }

  async renderFailure(error) {
    this.stopTyping();
    try {
      const channel = await this.getTargetChannel();
      await channel.send({ content: `**Error:** ${String(error).slice(0, 1800)}`, allowedMentions: { parse: [] } });
    } catch {
      // Ignore send errors
    }
  }
}
