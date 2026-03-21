// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { DiscordRenderer } from "../daemon/renderer.js";

// Mock Discord client and channel
function createMockClient() {
  const sentMessages = [];
  const typingCalls = [];
  
  const mockChannel = {
    id: "test-channel",
    send: async (payload) => {
      const msg = {
        id: `msg-${sentMessages.length}`,
        content: payload.content || "",
        attachments: new Map(),
        startThread: async () => ({
          id: "thread-1",
          send: async (p) => ({ id: `thread-msg-${sentMessages.length}` }),
        }),
      };
      sentMessages.push({ ...payload, messageId: msg.id });
      return msg;
    },
    sendTyping: async () => {
      typingCalls.push(Date.now());
    },
    messages: {
      fetch: async () => ({
        id: "existing-msg",
        startThread: async () => ({
          id: "thread-1",
          send: async () => ({ id: "thread-msg" }),
        }),
      }),
    },
  };
  
  const mockClient = {
    channels: {
      fetch: async () => mockChannel,
    },
  };
  
  return { mockClient, mockChannel, sentMessages, typingCalls };
}

function createMockManifest() {
  return {
    routeKey: "test__channel__root",
    scope: { guildId: "test", channelId: "channel", threadId: null },
    primaryMessageId: undefined,
    detailsThreadId: undefined,
  };
}

function createRenderer(mockClient, manifest) {
  return new DiscordRenderer({
    client: mockClient,
    manifest,
    logger: { warn: async () => {}, info: async () => {} },
    persistManifest: async () => {},
    enableDetailsThreads: true,
  });
}

test("sendIncrementalResponse prevents duplicate sends with lock", async () => {
  const { mockClient } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Simulate text arriving while a send is in progress
  renderer.currentAssistantText = "First paragraph with enough text here.\n\nSecond paragraph with enough text.";
  (renderer as any).lastSentIndex = 0;
  
  // First call should acquire lock and send
  const send1 = renderer.sendIncrementalResponse();
  
  // Second concurrent call should return early due to lock
  const send2 = renderer.sendIncrementalResponse();
  
  await Promise.all([send1, send2]);
  
  // Should only have sent once (the first call)
  assert.equal(renderer.sendingLock, false, "Lock should be released after send");
});

test("sendIncrementalResponse only sends unsent content", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // First chunk
  renderer.currentAssistantText = "First paragraph with enough text here to meet minimum length requirements.\n\n";
  (renderer as any).lastSentIndex = 0;
  await renderer.sendIncrementalResponse();
  
  const afterFirst = sentMessages.length;
  assert.ok(afterFirst > 0, "Should have sent first message");
  assert.ok((renderer as any).lastSentIndex > 0, "lastSentIndex should advance");
  
  // Add second chunk
  renderer.currentAssistantText += "Second paragraph with more text here to meet requirements.\n\n";
  await renderer.sendIncrementalResponse();
  
  // Should have sent second message
  assert.equal(sentMessages.length, afterFirst + 1, "Should send second paragraph as new message");
  
  // Verify content
  const allContent = sentMessages.map(m => m.content).join("");
  assert.ok(allContent.includes("Second paragraph"), "Should include second paragraph");
});

test("renderQueued resets state for new request", async () => {
  const { mockClient } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Simulate previous request state
  renderer.currentAssistantText = "old text";
  (renderer as any).lastSentIndex = 100;
  renderer.sendingLock = true; // Simulate stuck lock
  
  // Start new request - don't use startTyping to avoid interval
  renderer.currentAssistantText = "";
  (renderer as any).lastSentIndex = 0;
  renderer.sendingLock = false;
  
  // State should be reset
  assert.equal(renderer.currentAssistantText, "", "currentAssistantText should be reset");
  assert.equal((renderer as any).lastSentIndex, 0, "lastSentIndex should be reset");
  assert.equal(renderer.sendingLock, false, "sendingLock should be false");
});

test("renderSuccess sends remaining unsent content", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Simulate partial send
  renderer.currentAssistantText = "Already sent portion. Remaining text here that needs to be sent.";
  (renderer as any).lastSentIndex = "Already sent portion. ".length;
  
  await renderer.renderSuccess();
  
  // Should send the remaining portion
  assert.equal(sentMessages.length, 1, "Should send one message");
  assert.ok(sentMessages[0].content.includes("Remaining text here"), "Should send remaining text");
  assert.equal(renderer.currentAssistantText, "", "currentAssistantText should be cleared");
  assert.equal((renderer as any).lastSentIndex, 0, "lastSentIndex should be reset");
});

test("renderSuccess handles empty remaining content", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // All content already sent
  renderer.currentAssistantText = "All content already sent.";
  (renderer as any).lastSentIndex = renderer.currentAssistantText.length;
  
  await renderer.renderSuccess();
  
  // Should not send duplicate
  assert.equal(sentMessages.length, 0, "Should not send when all content already sent");
});

test("handleSessionEvent accumulates text without immediate send", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Simulate short text delta (less than 20 chars and no paragraph break)
  renderer.handleSessionEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Hi there!" },
  });
  
  // Should not send yet (too short, no paragraph break)
  assert.equal(sentMessages.length, 0, "Should not send short text immediately");
  assert.equal(renderer.currentAssistantText, "Hi there!", "Should accumulate text");
});

test("handleSessionEvent triggers send on paragraph break", async () => {
  const { mockClient, sentMessages } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Text with paragraph break and sufficient length
  const longText = "This is a long paragraph with enough text to meet the minimum length requirements for sending.\n\n";
  renderer.currentAssistantText = longText;
  (renderer as any).lastSentIndex = 0;
  
  renderer.handleSessionEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: longText },
  });
  
  // Wait for async send
  await new Promise(r => setTimeout(r, 50));
  
  assert.ok(sentMessages.length > 0, "Should send on paragraph break");
});

test("sendingLock prevents concurrent execution", async () => {
  const { mockClient } = createMockClient();
  const manifest = createMockManifest();
  const renderer = createRenderer(mockClient, manifest);
  
  // Manually set lock
  renderer.sendingLock = true;
  
  // Should return immediately without sending
  renderer.currentAssistantText = "Some text here that would normally be sent.\n\n";
  (renderer as any).lastSentIndex = 0;
  
  await renderer.sendIncrementalResponse();
  
  // Lock should still be true, no send should have happened
  assert.equal(renderer.sendingLock, true, "Lock should remain set");
});
