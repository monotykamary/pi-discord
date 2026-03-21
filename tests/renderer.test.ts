// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { DISCORD_MESSAGE_LIMIT } from "../lib/constants.js";
import { splitDiscordText } from "../daemon/renderer.js";

test("splitDiscordText returns placeholder for empty input", () => {
  assert.deepEqual(splitDiscordText(""), ["(no assistant output)"]);
  assert.deepEqual(splitDiscordText(null), ["(no assistant output)"]);
  assert.deepEqual(splitDiscordText(undefined), ["(no assistant output)"]);
});

test("splitDiscordText returns single chunk for text at or below the limit", () => {
  assert.deepEqual(splitDiscordText("Hello world"), ["Hello world"]);
  assert.deepEqual(splitDiscordText("x".repeat(DISCORD_MESSAGE_LIMIT)), ["x".repeat(DISCORD_MESSAGE_LIMIT)]);
});

test("splitDiscordText splits long text at newlines when possible", () => {
  const line = "a".repeat(500);
  const text = `${line}\n${line}\n${line}\n${line}\n${line}`;
  const chunks = splitDiscordText(text);

  assert.ok(chunks.length >= 2, "should split into multiple chunks");
  chunks.forEach((chunk, i) => {
    assert.ok(chunk.length <= DISCORD_MESSAGE_LIMIT, `chunk ${i} exceeds limit`);
  });
});

test("splitDiscordText hard splits when no newline exists near the limit", () => {
  const chunks = splitDiscordText("x".repeat(DISCORD_MESSAGE_LIMIT + 500));

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, DISCORD_MESSAGE_LIMIT);
});

test("splitDiscordText trims leading whitespace from continuation chunks", () => {
  const text = "a".repeat(1890) + "\n   continuation";
  const chunks = splitDiscordText(text);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[1], "continuation");
});
