// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { RouteSessionHost } from "../daemon/session-host.js";

class FakeRouteSessionHost extends RouteSessionHost {
  constructor() {
    super({
      agentDir: "/tmp/agent",
      config: { enableImageInput: true, allowProjectExtensions: false, defaultThinkingLevel: "medium" },
      manifest: {
        routeKey: "g1__c1__root",
        executionRoot: "/tmp/workspace",
        memoryPath: "/tmp/workspace/discord-memory.md",
        sessionFile: undefined,
      },
      routePaths: { sessionsDir: "/tmp/sessions" },
      journal: { recent: () => [] },
      logger: { info: async () => undefined, error: async () => undefined },
      uploadFile: async () => ({ messageId: "m1" }),
    });
    this.createCalls = 0;
    this.disposeCalls = 0;
  }

  async createSession() {
    this.createCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      sessionFile: "/tmp/sessions/route.json",
      dispose: () => {
        this.disposeCalls += 1;
      },
    };
  }
}

test("ensureSession deduplicates concurrent session creation", async () => {
  const host = new FakeRouteSessionHost();

  const [first, second] = await Promise.all([host.ensureSession(), host.ensureSession()]);

  assert.equal(host.createCalls, 1);
  assert.equal(first, second);
  assert.equal(host.manifest.sessionFile, "/tmp/sessions/route.json");
});

test("dispose waits for an in-flight session and cleans it up", async () => {
  const host = new FakeRouteSessionHost();

  const pendingSession = host.ensureSession();
  await host.dispose();
  const session = await pendingSession;

  assert.equal(host.createCalls, 1);
  assert.equal(host.disposeCalls, 1);
  assert.equal(host.session, undefined);
  assert.equal(session.sessionFile, "/tmp/sessions/route.json");
});
