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
    this.pendingTools = 0;
    this.toolIndicatorMessageId = undefined;
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
    // Details thread requires a message to thread from - use lastMessageId for incremental mode
    if (!this.enableDetailsThreads) {
      return undefined;
    }
    // Prefer detailsThreadId if already cached
    if (this.manifest.detailsThreadId) {
      try {
        const channel = await this.client.channels.fetch(this.manifest.detailsThreadId);
        if (channel && "send" in channel) {
          await this.logger.info("details-thread-reused", { 
            routeKey: this.manifest.routeKey,
            threadId: this.manifest.detailsThreadId 
          });
          return channel;
        }
        await this.logger.warn("details-thread-not-writable", { 
          routeKey: this.manifest.routeKey,
          threadId: this.manifest.detailsThreadId 
        });
      } catch (err) {
        await this.logger.warn("details-thread-fetch-failed", { 
          routeKey: this.manifest.routeKey,
          threadId: this.manifest.detailsThreadId,
          error: String(err) 
        });
      }
      // Clear stale thread ID - don't persist, it's ephemeral
      this.manifest.detailsThreadId = undefined;
    }
    return undefined;
  }

  async clearDetailsThread(reason, error) {
    this.manifest.detailsThreadId = undefined;
    await this.logger.warn(reason, { routeKey: this.manifest.routeKey, error: String(error) });
  }

  async uploadJsonToThread(filename, jsonContent, options = {}) {
    // Ensure thread exists first (create if needed)
    let thread = await this.ensureDetailsThread();
    if (!thread && this.enableDetailsThreads) {
      // Need to create thread - MUST use indicator as anchor, never text messages
      if (!this.toolIndicatorMessageId) {
        await this.showToolIndicator();
      }
      const threadAnchorId = this.toolIndicatorMessageId;
      if (threadAnchorId) {
        try {
          const channel = await this.getTargetChannel();
          if ("messages" in channel) {
            const message = await channel.messages.fetch(threadAnchorId);
            if (typeof message.startThread === "function") {
              thread = await message.startThread({
                name: "Tool calls",
                autoArchiveDuration: 60,
              });
              this.manifest.detailsThreadId = thread.id;
              await this.logger.info("tool-thread-created-for-upload", { 
                routeKey: this.manifest.routeKey, 
                threadId: thread.id 
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
      allowedMentions: { parse: [] },
    };
    
    if (thread && "send" in thread) {
      try {
        const message = await thread.send(payload);
        return { messageId: message.id, url: message.attachments.first()?.url };
      } catch (error) {
        await this.clearDetailsThread("details-thread-json-upload-failed", error);
      }
    }
    
    // Fallback to channel
    const channel = await this.getTargetChannel();
    const message = await channel.send(payload);
    return { messageId: message.id, url: message.attachments.first()?.url };
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
    // Only log non-message_update events to reduce noise
    if (event.type !== "message_update") {
      this.logger.info("session-event", { 
        routeKey: this.manifest.routeKey,
        eventType: event.type,
        hasToolName: !!event.toolName
      });
    }
    
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.currentAssistantText += event.assistantMessageEvent.delta;
      this.sendIncrementalResponse();
    }
    if (event.type === "tool_execution_start") {
      this.runInBackground("tool-post-failed", async () => {
        // Show indicator when tools are active
        await this.showToolIndicator();
        // Don't post "starting" - only post results when done
      });
    }
    if (event.type === "tool_execution_end") {
      this.runInBackground("tool-post-failed", async () => {
        // Simple format: 🛠️ toolname (no checkmark, no "done")
        const toolDisplay = `🛠️ **${event.toolName}**`;
        
        // Handle large JSON results as file uploads
        if (event.result) {
          const resultJson = JSON.stringify(event.result, null, 2);
          if (resultJson.length > 1000) {
            // Upload as file attachment
            await this.uploadJsonToThread(`${event.toolName}-result.json`, resultJson, {
              title: toolDisplay
            });
          } else {
            // Wrap in codeblock for small results
            const resultDisplay = `\n\`\`\`json\n${resultJson}\n\`\`\``;
            await this.postToolDetail(`${toolDisplay}${resultDisplay}`);
          }
        } else {
          await this.postToolDetail(toolDisplay);
        }
        
        // Decrement and remove indicator when all tools done
        this.pendingTools = Math.max(0, this.pendingTools - 1);
        if (this.pendingTools === 0) {
          await this.hideToolIndicator();
        }
      });
    }
  }

  async sendIncrementalResponse() {
    // Prevent concurrent execution
    if (this.sendingLock) {
      await this.logger.info("send-incremental-locked", { 
        routeKey: this.manifest.routeKey 
      });
      return;
    }
    this.sendingLock = true;
    
    try {
      const fullText = this.currentAssistantText;
      
      // Safety: nothing to send or all already sent
      if (!fullText || this.lastSentIndex >= fullText.length) {
        await this.logger.info("send-incremental-no-content", { 
          routeKey: this.manifest.routeKey,
          fullTextLength: fullText?.length,
          lastSentIndex: this.lastSentIndex
        });
        return;
      }
      
      const unsentText = fullText.slice(this.lastSentIndex).trimStart();
      
      // Not enough content to send yet
      if (!unsentText || unsentText.length < 20) {
        await this.logger.info("send-incremental-too-short", { 
          routeKey: this.manifest.routeKey,
          unsentLength: unsentText?.length
        });
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
        // Check for sentence ending - require at least 50 chars before break
        // to avoid fragmenting short greetings like "Hi! How are you?"
        const sentenceMatch = unsentText.match(/.*[.!?]\s+/s);
        if (sentenceMatch && sentenceMatch[0].length >= 50) {
          sendLength = sentenceMatch[0].length;
        } else {
          return; // No good break point yet - accumulate more content
        }
      }
      
      // Don't break inside code blocks
      const textToConsider = unsentText.slice(0, sendLength);
      const inCodeBlock = (textToConsider.match(/```/g) || []).length % 2 === 1;
      if (inCodeBlock) {
        return;
      }
      
      // Must have substantial content (at least 30 chars to avoid fragmenting)
      if (sendLength < 30) {
        return;
      }
      
      const toSend = textToConsider.trim();
      if (!toSend) {
        return;
      }
      
      // CRITICAL: Check if we already sent this exact content
      // This prevents race condition duplicates
      const normalizedLast = this.lastSentContent?.trim();
      const normalizedCurrent = toSend.trim();
      if (normalizedLast === normalizedCurrent) {
        await this.logger.info("duplicate-prevented", { 
          routeKey: this.manifest.routeKey,
          content: normalizedCurrent.slice(0, 50)
        });
        return;
      }
      
      await this.logger.info("sending-incremental", { 
        routeKey: this.manifest.routeKey,
        content: normalizedCurrent.slice(0, 50),
        lastSentContent: normalizedLast?.slice(0, 50)
      });
      
      // Send the message
      const channel = await this.getTargetChannel();
      const message = await channel.send({ 
        content: toSend.slice(0, DISCORD_MESSAGE_LIMIT), 
        allowedMentions: { parse: [] } 
      });
      
      // Update tracking
      this.lastMessageId = message.id;
      this.lastSentIndex += sendLength;
      this.lastSentContent = normalizedCurrent; // Track what we just sent
      
      await this.logger.info("message-sent", { 
        routeKey: this.manifest.routeKey,
        messageId: message.id,
        lastSentIndex: this.lastSentIndex
      });
      
    } catch (error) {
      // Log error but don't throw - sending is best effort
      await this.logger.warn("incremental-send-failed", { error: String(error) });
    } finally {
      this.sendingLock = false;
    }
  }

  async postToolDetail(content) {
    // MUST use tool indicator message as thread anchor - never text messages
    if (!this.toolIndicatorMessageId) {
      await this.showToolIndicator();
    }
    const threadAnchorId = this.toolIndicatorMessageId;
    
    // If still no indicator, something is wrong
    if (!threadAnchorId) {
      await this.logger.error("tool-thread-fatal", { 
        routeKey: this.manifest.routeKey,
        error: "Failed to create indicator anchor"
      });
      return;
    }
    
    // Create thread off anchor message if not exists
    if (!this.manifest.detailsThreadId && this.enableDetailsThreads) {
      try {
        const channel = await this.getTargetChannel();
        if ("messages" in channel) {
          const message = await channel.messages.fetch(threadAnchorId);
          if (typeof message.startThread === "function") {
            const thread = await message.startThread({
              name: "Tool calls",
              autoArchiveDuration: 60,
            });
            this.manifest.detailsThreadId = thread.id;
            // Don't persist - thread is ephemeral per request
            await this.logger.info("tool-thread-created", { 
              routeKey: this.manifest.routeKey, 
              threadId: thread.id,
              anchoredTo: threadAnchorId,
              isIndicator: threadAnchorId === this.toolIndicatorMessageId
            });
            
            // Post directly to the newly created thread
            try {
              await thread.send({ 
                content: content.slice(0, DISCORD_MESSAGE_LIMIT), 
                allowedMentions: { parse: [] } 
              });
              await this.logger.info("tool-detail-posted", { 
                routeKey: this.manifest.routeKey, 
                content: content.slice(0, 50),
                threadId: thread.id
              });
              return; // Done - posted to new thread
            } catch (err) {
              await this.logger.warn("tool-detail-post-failed", { 
                routeKey: this.manifest.routeKey,
                content: content.slice(0, 50),
                error: String(err) 
              });
              return;
            }
          }
        }
      } catch (err) {
        await this.logger.warn("tool-thread-create-failed", { 
          routeKey: this.manifest.routeKey, 
          threadAnchorId,
          error: String(err) 
        });
      }
    }
    
    // If we already have a thread, use existing logic
    const thread = await this.ensureDetailsThread();
    if (thread && "send" in thread) {
      try {
        await thread.send({ 
          content: content.slice(0, DISCORD_MESSAGE_LIMIT), 
          allowedMentions: { parse: [] } 
        });
        await this.logger.info("tool-detail-posted-existing", { 
          routeKey: this.manifest.routeKey, 
          content: content.slice(0, 50) 
        });
      } catch (err) {
        await this.logger.warn("tool-detail-post-failed", { 
          routeKey: this.manifest.routeKey,
          content: content.slice(0, 50),
          error: String(err) 
        });
      }
    }
  }

  async showToolIndicator() {
    this.pendingTools++;
    if (this.toolIndicatorMessageId) return; // Already showing
    
    try {
      const channel = await this.getTargetChannel();
      const indicator = await channel.send({ 
        content: "🛠️ Using tools...", 
        allowedMentions: { parse: [] } 
      });
      this.toolIndicatorMessageId = indicator.id;
      this.lastMessageId = indicator.id; // Use as thread anchor
      await this.logger.info("tool-indicator-shown", { 
        routeKey: this.manifest.routeKey,
        messageId: indicator.id 
      });
    } catch (err) {
      await this.logger.warn("tool-indicator-failed", { 
        routeKey: this.manifest.routeKey,
        error: String(err) 
      });
    }
  }

  async hideToolIndicator() {
    if (!this.toolIndicatorMessageId) return;
    
    try {
      const channel = await this.getTargetChannel();
      if ("messages" in channel) {
        const message = await channel.messages.fetch(this.toolIndicatorMessageId);
        if (message) {
          // Edit to show completion instead of deleting
          await message.edit({ content: "✅ Tools finished" });
        }
      }
      this.toolIndicatorMessageId = undefined;
      await this.logger.info("tool-indicator-hidden", { 
        routeKey: this.manifest.routeKey 
      });
    } catch (err) {
      // Ignore errors - message may already be gone
      this.toolIndicatorMessageId = undefined;
    }
  }

  async renderQueued(item) {
    this.currentAssistantText = "";
    this.lastSentIndex = 0;
    this.lastSentContent = undefined;
    this.creatingPlaceholder = false;
    this.pendingTools = 0;
    this.toolIndicatorMessageId = undefined;
    // Reset thread ID - each request gets its own fresh thread (ephemeral)
    this.manifest.detailsThreadId = undefined;
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
      // Check if we already sent this exact content
      const normalizedLast = this.lastSentContent?.trim();
      const normalizedCurrent = remaining.trim();
      if (normalizedLast !== normalizedCurrent) {
        try {
          const channel = await this.getTargetChannel();
          const message = await channel.send({ content: remaining.slice(0, DISCORD_MESSAGE_LIMIT), allowedMentions: { parse: [] } });
          this.lastSentContent = normalizedCurrent;
          this.lastMessageId = message.id;
          await this.logger.info("success-remaining-sent", { 
            routeKey: this.manifest.routeKey,
            messageId: message.id,
            content: normalizedCurrent.slice(0, 50)
          });
        } catch (err) {
          await this.logger.warn("success-remaining-failed", { 
            routeKey: this.manifest.routeKey,
            error: String(err) 
          });
        }
      } else {
        await this.logger.info("success-duplicate-prevented", { 
          routeKey: this.manifest.routeKey,
          content: normalizedCurrent.slice(0, 50)
        });
      }
    }
    // Reset for next request
    this.currentAssistantText = "";
    this.lastSentIndex = 0;
    this.lastSentContent = undefined;
    this.pendingTools = 0;
    this.toolIndicatorMessageId = undefined;
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
