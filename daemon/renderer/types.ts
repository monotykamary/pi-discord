import type { TextChannel, ThreadChannel, DMChannel } from "discord.js";
import type { RouteManifest } from "../registry.js";
import type { Logger } from "../logger.js";
import type { Client } from "discord.js";

export interface ToolParams {
  name: string;
  params: Record<string, unknown>;
}

export interface ExtractedContent {
  content: string | null;
  filename: string | null;
  isDiff: boolean;
}

export interface SessionEvent {
  type: string;
  toolName?: string;
  result?: {
    content?: unknown;
    filePath?: string;
    path?: string;
    details?: { diff?: string };
    message?: string;
    [key: string]: unknown;
  };
  args?: Record<string, unknown>;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
}

export interface DiscordRendererOptions {
  client: Client;
  manifest: RouteManifest;
  logger: Logger;
  persistManifest: () => Promise<void>;
  enableDetailsThreads: boolean;
}

export type WritableChannel = TextChannel | ThreadChannel | DMChannel;
