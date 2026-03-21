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
    this.creatingIndicator = false;
    // Tool operation queue to prevent races
    this.toolQueue = [];
    this.processingToolQueue = false;
    // Store tool parameters for diff generation
    this.toolParams = new Map();
    this.currentToolKey = null;
    // Text sending queue to prevent duplicate/race issues
    this.textQueue = [];
    this.processingTextQueue = false;
    this.lastQueuedText = '';
  }

  enqueueTextSend(text) {
    // Only queue if this is new text (not duplicate of last queued)
    if (text !== this.lastQueuedText) {
      this.textQueue.push(text);
      this.lastQueuedText = text;
      void this.processTextQueue();
    }
  }

  async processTextQueue() {
    if (this.processingTextQueue) return;
    this.processingTextQueue = true;
    
    while (this.textQueue.length > 0) {
      const text = this.textQueue.shift();
      try {
        await this.sendTextChunk(text);
      } catch (error) {
        await this.logger.warn("text-send-failed", { 
          routeKey: this.manifest.routeKey, 
          error: String(error) 
        });
      }
    }
    
    this.processingTextQueue = false;
  }

  enqueueToolOperation(operation) {
    this.toolQueue.push(operation);
    void this.processToolQueue();
  }

  async processToolQueue() {
    if (this.processingToolQueue) return;
    this.processingToolQueue = true;
    
    while (this.toolQueue.length > 0) {
      const operation = this.toolQueue.shift();
      try {
        await operation();
      } catch (error) {
        await this.logger.warn("tool-queue-operation-failed", { 
          routeKey: this.manifest.routeKey, 
          error: String(error) 
        });
      }
    }
    
    this.processingToolQueue = false;
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

  async uploadContentToThread(filename, content, lang, options = {}) {
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
              await this.logger.info("tool-thread-created-for-content", { 
                routeKey: this.manifest.routeKey, 
                threadId: thread.id 
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
      allowedMentions: { parse: [] },
    };
    
    if (thread && "send" in thread) {
      try {
        const message = await thread.send(payload);
        return { messageId: message.id, url: message.attachments.first()?.url };
      } catch (error) {
        await this.clearDetailsThread("details-thread-content-upload-failed", error);
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
      // Queue tool start operation to prevent races
      this.enqueueToolOperation(async () => {
        this.pendingTools++;
        // Store parameters with unique key for each tool execution
        if (event.toolName) {
          const key = `${event.toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.currentToolKey = key; // Store for retrieval
          if (event.parameters) {
            this.toolParams.set(key, { name: event.toolName, params: event.parameters });
          }
        }
        await this.showToolIndicator();
      });
    }
    if (event.type === "tool_execution_end") {
      // Queue tool end operation - runs after all queued operations
      this.enqueueToolOperation(async () => {
        const toolDisplay = `🛠️ **${event.toolName}**`;
        
        // Get stored parameters using the key from start
        const key = this.currentToolKey;
        const stored = key ? this.toolParams.get(key) : null;
        const params = stored?.params;
        if (key) {
          this.toolParams.delete(key);
          this.currentToolKey = null;
        }
        
        // Extract content from tool result (pass params for diff generation)
        if (event.result) {
          const { content, filename, isDiff } = this.extractToolContent(event, params);
          
          if (content) {
            // Determine file extension based on tool type or filename
            let ext = filename ? filename.split('.').pop() : 'txt';
            if (event.toolName === 'read' && !filename) ext = 'txt';
            if (isDiff) ext = 'diff';
            
            // Create display filename
            const displayFilename = filename || `${event.toolName}-result.${ext}`;
            
            if (content.length > 1000) {
              // Upload as file attachment
              await this.uploadContentToThread(displayFilename, content, ext, {
                title: toolDisplay
              });
            } else {
              // Wrap in appropriate codeblock
              const resultDisplay = `\n\`\`\`${ext}\n${content}\n\`\`\``;
              await this.postToolDetail(`${toolDisplay}${resultDisplay}`);
            }
          } else {
            // Fallback to JSON if no content extracted
            const resultJson = JSON.stringify(event.result, null, 2);
            if (resultJson.length > 1000) {
              await this.uploadContentToThread(`${event.toolName}-result.json`, resultJson, 'json', {
                title: toolDisplay
              });
            } else {
              const resultDisplay = `\n\`\`\`json\n${resultJson}\n\`\`\``;
              await this.postToolDetail(`${toolDisplay}${resultDisplay}`);
            }
          }
        } else {
          await this.postToolDetail(toolDisplay);
        }
        
        this.pendingTools = Math.max(0, this.pendingTools - 1);
        if (this.pendingTools === 0) {
          await this.hideToolIndicator();
        }
      });
    }
  }

  /**
   * Extract readable content from tool result
   * Returns { content, filename, isDiff }
   */
  extractToolContent(event, storedParams = null) {
    const result = event.result;
    if (!result) return { content: null, filename: null, isDiff: false };
    
    // Use stored params if available (from tool_execution_start)
    const params = storedParams || event.parameters || {};
    
    // DEBUG: Log what we got
    this.logger.info("extract-tool-debug", {
      toolName: event.toolName,
      paramKeys: Object.keys(params),
      hasOldString: !!(params.old_string || params.search || params.oldString || params.old),
      hasNewString: !!(params.new_string || params.replace || params.newString || params.new)
    });
    
    // Handle read tool - extract file content
    if (event.toolName === 'read' && result.content) {
      // SDK returns content as array of blocks
      if (Array.isArray(result.content)) {
        const textBlock = result.content.find(c => c.type === 'text');
        if (textBlock && textBlock.text) {
          return { 
            content: textBlock.text, 
            filename: result.filePath || result.path || params.filePath || params.path,
            isDiff: false 
          };
        }
      }
      // Direct content string
      if (typeof result.content === 'string') {
        return { 
          content: result.content, 
          filename: result.filePath || result.path || params.filePath || params.path,
          isDiff: false 
        };
      }
    }
    
    // Handle diff/edit tools - extract from parameters since SDK doesn't return diff
    if (event.toolName === 'str_replace' || event.toolName === 'edit' || event.toolName === 'apply_diff') {
      const filePath = params.filePath || params.path || result.filePath || result.path;
      
      // Try different parameter name conventions
      const oldStr = params.old_string || params.search || params.oldString || params.old;
      const newStr = params.new_string || params.replace || params.newString || params.new;
      
      if (oldStr && newStr) {
        // Create a simple unified diff format
        const diff = `--- ${filePath || 'original'}\n+++ ${filePath || 'modified'}\n@@ -1,1 +1,1 @@\n-${oldStr}\n+${newStr}`;
        return { 
          content: diff, 
          filename: filePath,
          isDiff: true 
        };
      }
      
      // Fallback: show the success message if no diff available
      if (result.message) {
        return {
          content: result.message,
          filename: filePath,
          isDiff: false
        };
      }
    }
    
    // Handle other tools - try to find any readable content
    if (result.content) {
      if (Array.isArray(result.content)) {
        const textBlock = result.content.find(c => c.type === 'text');
        if (textBlock && textBlock.text) {
          return { content: textBlock.text, filename: null, isDiff: false };
        }
      }
      if (typeof result.content === 'string') {
        return { content: result.content, filename: null, isDiff: false };
      }
    }
    
    return { content: null, filename: null, isDiff: false };
  }

  async sendIncrementalResponse() {
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
    
    // Find a good break point
    let sendLength = 0;
    
    // Check for paragraph break first
    const paraBreakIndex = unsentText.indexOf('\n\n');
    if (paraBreakIndex >= 0) {
      sendLength = paraBreakIndex + 2;
    } else {
      // Check for sentence ending - require at least 50 chars
      const sentenceMatch = unsentText.match(/.*[.!?]\s+/s);
      if (sentenceMatch && sentenceMatch[0].length >= 50) {
        sendLength = sentenceMatch[0].length;
      } else {
        return; // No good break yet
      }
    }
    
    // Don't break inside code blocks
    const textToSend = unsentText.slice(0, sendLength).trim();
    if ((textToSend.match(/```/g) || []).length % 2 === 1) {
      return;
    }
    
    if (!textToSend || textToSend.length < 30) {
      return;
    }
    
    // Update index and send immediately (queue prevents duplicates)
    this.lastSentIndex += sendLength;
    await this.sendTextChunk(textToSend);
  }
  
  async sendTextChunk(text) {
    try {
      const channel = await this.getTargetChannel();
      const message = await channel.send({ 
        content: text.slice(0, DISCORD_MESSAGE_LIMIT), 
        allowedMentions: { parse: [] } 
      });
      
      this.lastMessageId = message.id;
      this.lastSentContent = text;
      
      await this.logger.info("message-sent", { 
        routeKey: this.manifest.routeKey,
        messageId: message.id 
      });
    } catch (error) {
      await this.logger.warn("text-send-failed", { error: String(error) });
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
    // Guard against concurrent creation
    if (this.creatingIndicator) return;
    if (this.toolIndicatorMessageId) return; // Already showing
    
    this.creatingIndicator = true;
    
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
    } finally {
      this.creatingIndicator = false;
    }
  }

  async hideToolIndicator() {
    // Just clear the tracking - don't edit the message
    this.toolIndicatorMessageId = undefined;
    this.creatingIndicator = false;
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
