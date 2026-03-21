import test from "node:test";
import assert from "node:assert/strict";
import { DiscordRenderer } from "../daemon/renderer.js";

// Mock Discord client and channel with full thread support
function createMockClient() {
  const sentMessages = [];
  const typingCalls = [];
  const threads = new Map();
  
  // Store mock channel reference for later
  let mockChannel;
  
  const createMockChannel = () => ({
    id: "test-channel",
    send: async (payload) => {
      const msg = {
        id: `msg-${sentMessages.length}`,
        content: payload.content || "",
        attachments: new Map(),
        startThread: async (options) => {
          const threadId = `thread-${threads.size}`;
          const thread = {
            id: threadId,
            send: async (p) => {
              const threadMsg = {
                id: `thread-msg-${sentMessages.length}`,
                content: p.content || "",
              };
              sentMessages.push({ ...p, messageId: threadMsg.id, isThread: true, threadId });
              return threadMsg;
            },
          };
          threads.set(threadId, thread);
          return thread;
        },
      };
      sentMessages.push({ ...payload, messageId: msg.id });
      return msg;
    },
    sendTyping: async () => {
      typingCalls.push(Date.now());
    },
    messages: {
      fetch: async (id) => {
        const msg = sentMessages.find(m => m.messageId === id);
        if (!msg) throw new Error("Message not found");
        return {
          id,
          content: msg.content,
          startThread: async (options) => {
            const threadId = `thread-${threads.size}`;
            const thread = {
              id: threadId,
              send: async (p) => {
                const threadMsg = {
                  id: `thread-msg-${sentMessages.length}`,
                  content: p.content || "",
                };
                sentMessages.push({ ...p, messageId: threadMsg.id, isThread: true, threadId });
                return threadMsg;
              },
            };
            threads.set(threadId, thread);
            return thread;
          },
        };
      },
    },
  });
  
  mockChannel = createMockChannel();
  
  const mockClient = {
    channels: {
      fetch: async (id) => {
        // If fetching a thread ID, return the thread
        if (threads.has(id)) {
          return threads.get(id);
        }
        // Otherwise return the main channel
        return mockChannel;
      },
    },
  };
  
  return { mockClient, mockChannel, sentMessages, typingCalls, threads };
}

function createMockManifest() {
  return {
    routeKey: "test__channel__root",
    scope: { guildId: "test", channelId: "channel", threadId: null },
    primaryMessageId: undefined,
    detailsThreadId: undefined,
  };
}

function createRenderer(mockClient, manifest, enableDetailsThreads = true) {
  return new DiscordRenderer({
    client: mockClient,
    manifest,
    logger: { 
      warn: async () => {}, 
      info: async () => {},
      error: async () => {},
    },
    persistManifest: async () => {},
    enableDetailsThreads,
  });
}

test("showToolIndicator creates standalone message and sets lastMessageId", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  await renderer.showToolIndicator();
  
  assert.equal(sentMessages.length, 1, "Should send one message");
  assert.ok(sentMessages[0].content.includes("Using tools"), "Should contain indicator text");
  assert.equal(renderer.toolIndicatorMessageId, sentMessages[0].messageId, "Should track indicator ID");
  assert.equal(renderer.lastMessageId, sentMessages[0].messageId, "Should use indicator as lastMessageId");
  assert.equal(renderer.pendingTools, 1, "Should increment pendingTools");
});

test("showToolIndicator does not create duplicate when already showing", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // First call
  await renderer.showToolIndicator();
  const firstId = renderer.toolIndicatorMessageId;
  
  // Second call while already showing
  await renderer.showToolIndicator();
  
  assert.equal(sentMessages.length, 1, "Should only send one indicator");
  assert.equal(renderer.toolIndicatorMessageId, firstId, "Should keep same indicator ID");
  assert.equal(renderer.pendingTools, 2, "Should increment pendingTools for each call");
});

test("hideToolIndicator edits message to show completion", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Show then hide
  await renderer.showToolIndicator();
  const indicatorId = renderer.toolIndicatorMessageId;
  
  // Mock edit function on the indicator message
  let editedContent = null;
  const mockMessage = {
    id: indicatorId,
    edit: async (payload) => {
      editedContent = payload.content;
    },
  };
  
  // Update the mock channel's messages.fetch to return our mock message
  const mockChannel = await mockClient.channels.fetch();
  mockChannel.messages.fetch = async () => mockMessage;
  
  await renderer.hideToolIndicator();
  
  assert.equal(editedContent, "✅ Tools finished", "Should edit to show completion");
  assert.equal(renderer.toolIndicatorMessageId, undefined, "Should clear indicator ID");
});

test("postToolDetail creates thread from indicator and posts tool details", async () => {
  const { mockClient, sentMessages, threads } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // First create indicator
  await renderer.showToolIndicator();
  const indicatorId = renderer.lastMessageId;
  
  // Then post tool detail
  await renderer.postToolDetail("read tool starting...");
  
  // Should create thread
  assert.ok(manifest.detailsThreadId, "Should set detailsThreadId on manifest");
  assert.equal(threads.size, 1, "Should create one thread");
  
  // Should post to thread
  const threadPosts = sentMessages.filter(m => m.isThread);
  assert.equal(threadPosts.length, 1, "Should post one message to thread");
  assert.ok(threadPosts[0].content.includes("read tool"), "Should contain tool detail");
});

test("postToolDetail reuses existing thread for subsequent tools", async () => {
  const { mockClient, sentMessages, threads } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Create indicator and first tool
  await renderer.showToolIndicator();
  await renderer.postToolDetail("first tool");
  const firstThreadId = manifest.detailsThreadId;
  
  // Second tool should reuse thread
  await renderer.postToolDetail("second tool");
  
  assert.equal(manifest.detailsThreadId, firstThreadId, "Should reuse same thread");
  assert.equal(threads.size, 1, "Should not create second thread");
  
  const threadPosts = sentMessages.filter(m => m.isThread);
  assert.equal(threadPosts.length, 2, "Should have two thread posts");
});

test("tool execution flow: indicator -> thread -> completion", async () => {
  const { mockClient, sentMessages, threads } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Simulate tool execution start event
  renderer.pendingTools = 0;
  await renderer.showToolIndicator();
  await renderer.postToolDetail("read tool starting...");
  
  // Check state
  assert.equal(renderer.pendingTools, 1, "Should track one pending tool");
  assert.ok(renderer.toolIndicatorMessageId, "Should have indicator");
  assert.ok(manifest.detailsThreadId, "Should have thread");
  
  // Simulate tool execution end
  renderer.pendingTools = 0; // Simulate completion
  await renderer.hideToolIndicator();
  
  assert.equal(renderer.toolIndicatorMessageId, undefined, "Should clear indicator after completion");
  assert.equal(threads.size, 1, "Thread should persist");
});

test("postToolDetail falls back to lastMessageId if no indicator", async () => {
  const { mockClient, sentMessages, threads } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Simulate text was sent first (no indicator created)
  renderer.lastMessageId = "msg-text";
  sentMessages.push({ messageId: "msg-text", content: "Some response text" });
  
  // Post tool detail - should use lastMessageId as anchor
  await renderer.postToolDetail("tool detail");
  
  // Should create thread off lastMessageId since no indicator
  assert.ok(manifest.detailsThreadId, "Should create thread using lastMessageId");
  assert.equal(threads.size, 1, "Should create one thread");
  
  const threadPosts = sentMessages.filter(m => m.isThread);
  assert.equal(threadPosts.length, 1, "Should post to thread");
});

test("ensureDetailsThread returns undefined when disabled", async () => {
  const { mockClient } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest, false); // disabled
  
  const thread = await renderer.ensureDetailsThread();
  assert.equal(thread, undefined, "Should return undefined when disabled");
});

test("ensureDetailsThread fetches existing thread from manifest", async () => {
  const { mockClient, threads } = createMockClient();
  const manifest = createMockManifest();
  manifest.detailsThreadId = "existing-thread-123";
  
  // Mock the thread fetch
  const mockThread = {
    id: "existing-thread-123",
    send: async () => ({}),
  };
  mockClient.channels.fetch = async (id) => {
    if (id === "existing-thread-123") return mockThread;
    return mockClient.channels.fetch();
  };
  
  const renderer = createRenderer(mockClient, manifest);
  const thread = await renderer.ensureDetailsThread();
  
  assert.equal(thread.id, "existing-thread-123", "Should return existing thread");
});

test("sendIncrementalResponse does not fragment short greetings", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Short greeting with period
  renderer.currentAssistantText = "Hi! How can I help?";
  renderer.lastSentIndex = 0;
  
  await renderer.sendIncrementalResponse();
  
  // Should NOT send because it's too short
  assert.equal(sentMessages.length, 0, "Should not send short greeting immediately");
});

test("sendIncrementalResponse sends longer content with periods", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Longer content with period after 50+ chars
  renderer.currentAssistantText = "This is a longer response that has enough characters before the period. Here is more.";
  renderer.lastSentIndex = 0;
  
  await renderer.sendIncrementalResponse();
  
  assert.equal(sentMessages.length, 1, "Should send longer content");
});

test("renderQueued resets all tool state", async () => {
  const { mockClient } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Set some state
  renderer.pendingTools = 3;
  renderer.toolIndicatorMessageId = "some-id";
  renderer.lastSentContent = "previous";
  
  // Reset
  renderer.currentAssistantText = "";
  renderer.lastSentIndex = 0;
  renderer.lastSentContent = undefined;
  renderer.creatingPlaceholder = false;
  renderer.pendingTools = 0;
  renderer.toolIndicatorMessageId = undefined;
  
  assert.equal(renderer.pendingTools, 0, "Should reset pendingTools");
  assert.equal(renderer.toolIndicatorMessageId, undefined, "Should reset indicator");
});
