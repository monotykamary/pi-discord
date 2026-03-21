import test from "node:test";
import assert from "node:assert/strict";
import { makeRouteKey } from "../daemon/route-key.js";

test("route key keeps guild, channel, and thread identity", () => {
  assert.equal(makeRouteKey({ guildId: "g1", channelId: "c1", threadId: null }), "g1__c1__root");
  assert.equal(makeRouteKey({ guildId: null, channelId: "c1", threadId: null }), "dm__c1__root");
  assert.equal(makeRouteKey({ guildId: "g1", channelId: "c1", threadId: "t1" }), "g1__c1__t1");
});
