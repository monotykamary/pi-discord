import type { RouteManifest } from "../registry.js";
import { JournalStore } from "../journal.js";
import { RouteQueueStore } from "../queue-store.js";
import { DiscordRenderer } from "../renderer.js";
import { RouteSessionHost } from "../session-host.js";
import type { RoutePaths } from "../../lib/paths.js";

export interface RouteContext {
  manifest: RouteManifest;
  routePaths: RoutePaths;
  queue: RouteQueueStore;
  journal: JournalStore;
  renderer: DiscordRenderer;
  host: RouteSessionHost;
}

export interface ActiveRun {
  abort: () => Promise<void>;
}

export interface DaemonStatus {
  phase?: string;
  userTag?: string;
  pid?: number;
  routeCount?: number;
  activeRuns?: string[];
}
