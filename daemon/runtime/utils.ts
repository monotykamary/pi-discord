import { readFile } from "node:fs/promises";

export function stripBotMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

export function findTriggerWord(content: string | undefined, triggerWords: string[]): string | undefined {
  if (!content || triggerWords.length === 0) return undefined;
  const lowerContent = content.toLowerCase();
  for (const word of triggerWords) {
    const lowerWord = word.toLowerCase();
    const regex = new RegExp(`\\b${escapeRegExp(lowerWord)}\\b`, "i");
    if (regex.test(lowerContent)) return word;
  }
  return undefined;
}

export function stripTriggerWord(content: string, triggerWord: string): string {
  const regex = new RegExp(`^\\s*\\b${escapeRegExp(triggerWord)}\\b[\\s:,;-]*`, "i");
  return content.replace(regex, "").trim();
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function toImageContent(filePath: string, mediaType: string): Promise<unknown> {
  const data = await readFile(filePath);
  return {
    type: "image",
    source: {
      type: "base64",
      mediaType,
      data: data.toString("base64"),
    },
  };
}
