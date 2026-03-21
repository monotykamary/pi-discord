import { readFile } from "node:fs/promises";
import { MAX_CONTEXT_CHARS, MAX_CONTEXT_LINES } from "../lib/constants.js";
import type { JournalStore } from "./journal.js";

export interface RequesterInfo {
  id: string;
  name: string;
}

export interface ScopeInfo {
  guildId: string | null;
  channelId: string;
  threadId: string | null;
}

export interface AttachmentInfo {
  path: string;
  name: string;
  contentType?: string;
  isImage: boolean;
}

export interface BuildPromptInput {
  routeKey: string;
  scope: ScopeInfo;
  requester: RequesterInfo;
  trigger: string;
  rawText: string;
  replyContext?: string;
  savedAttachments: AttachmentInfo[];
}

export function buildPromptText(input: BuildPromptInput): string {
  const sections = [
    `Discord route: ${input.routeKey}`,
    `Requester: ${input.requester.name} (${input.requester.id})`,
    `Trigger: ${input.trigger}`,
    `Guild: ${input.scope.guildId ?? "DM"}`,
    `Channel: ${input.scope.channelId}`,
  ];

  if (input.scope.threadId) sections.push(`Thread: ${input.scope.threadId}`);
  if (input.replyContext) sections.push(`Reply context:\n${input.replyContext}`);
  if (input.savedAttachments.length > 0) {
    sections.push(
      `Saved attachments:\n${input.savedAttachments
        .map((attachment) => `- ${attachment.name} -> ${attachment.path}${attachment.contentType ? ` (${attachment.contentType})` : ""}`)
        .join("\n")}`,
    );
  }
  sections.push(`User request:\n${input.rawText || "(empty message)"}`);
  return sections.join("\n\n");
}

export interface BuildContextInput {
  memoryPath: string;
  journal: JournalStore;
  excludeSourceId?: string;
}

export async function buildInjectedContext(input: BuildContextInput): Promise<string> {
  let memoryText = "";
  try {
    memoryText = await readFile(input.memoryPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const recentMessages = input.journal
    .recent(
      MAX_CONTEXT_LINES,
      (entry) => entry.sourceId !== input.excludeSourceId,
    )
    .map((entry) => `[${new Date(entry.timestamp as number).toISOString()}] ${entry.type}: ${JSON.stringify(entry.summary ?? entry.text ?? "(no text)")}`)
    .join("\n");

  const sections = [];
  if (memoryText.trim()) sections.push(`## Route Memory\n${memoryText.slice(0, MAX_CONTEXT_CHARS)}`);
  if (recentMessages) sections.push(`## Recent Events\n${recentMessages}`);
  return sections.join("\n\n");
}
