import { DISCORD_MESSAGE_LIMIT } from "../../lib/constants.js";

export function splitDiscordText(text: string): string[] {
  if (!text) return ["(no assistant output)"];
  const chunks: string[] = [];
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
