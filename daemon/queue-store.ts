import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../lib/fs.js";

export type QueueState = "queued" | "leased" | "running" | "completed" | "failed" | "cancelled";

export interface QueueAttachment {
  path: string;
  name: string;
  contentType?: string;
  isImage: boolean;
}

export interface QueueSource {
  kind: "message" | "interaction";
  sourceId: string;
  userId: string;
  guildId: string | null;
  channelId: string;
  threadId: string | null;
  trigger: string;
}

export interface QueuePayload {
  rawText: string;
  promptText: string;
  attachments: QueueAttachment[];
}

export interface QueueLease {
  workerId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface QueueItem {
  id: string;
  state: QueueState;
  error?: string;
  source: QueueSource;
  payload: QueuePayload;
  lease?: QueueLease;
}

export interface QueueData {
  version: number;
  items: QueueItem[];
}

const QUEUE_STATES = new Set<QueueState>(["queued", "leased", "running", "completed", "failed", "cancelled"]);

interface AttachmentInput {
  path?: string;
  name?: string;
  contentType?: string;
  isImage?: boolean;
}

function normalizeAttachment(value: unknown): QueueAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as AttachmentInput;
  if (typeof v.path !== "string" || typeof v.name !== "string") return undefined;
  return {
    path: v.path,
    name: v.name,
    contentType: typeof v.contentType === "string" ? v.contentType : undefined,
    isImage: Boolean(v.isImage),
  };
}

interface SourceInput {
  kind?: "message" | "interaction";
  sourceId?: string;
  userId?: string;
  channelId?: string;
  trigger?: string;
  guildId?: string;
  threadId?: string;
}

function normalizeSource(value: unknown): QueueSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as SourceInput;
  if (
    (v.kind !== "message" && v.kind !== "interaction") ||
    typeof v.sourceId !== "string" ||
    typeof v.userId !== "string" ||
    typeof v.channelId !== "string" ||
    typeof v.trigger !== "string"
  ) {
    return undefined;
  }
  return {
    kind: v.kind,
    sourceId: v.sourceId,
    userId: v.userId,
    guildId: typeof v.guildId === "string" ? v.guildId : null,
    channelId: v.channelId,
    threadId: typeof v.threadId === "string" ? v.threadId : null,
    trigger: v.trigger,
  };
}

interface LeaseInput {
  workerId?: string;
  acquiredAt?: number;
  expiresAt?: number;
}

function normalizeLease(value: unknown): QueueLease | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as LeaseInput;
  if (typeof v.workerId !== "string" || typeof v.acquiredAt !== "number" || typeof v.expiresAt !== "number") {
    return undefined;
  }
  return {
    workerId: v.workerId,
    acquiredAt: v.acquiredAt,
    expiresAt: v.expiresAt,
  };
}

interface PayloadInput {
  rawText?: string;
  promptText?: string;
  attachments?: unknown[];
}

interface ItemInput {
  id?: string;
  state?: QueueState;
  error?: string;
  source?: unknown;
  payload?: unknown;
  lease?: unknown;
}

function normalizeItem(value: unknown): QueueItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as ItemInput;
  if (typeof v.id !== "string" || !QUEUE_STATES.has(v.state as QueueState)) return undefined;
  const source = normalizeSource(v.source);
  const payloadInput = v.payload as PayloadInput;
  const payload =
    v.payload && typeof v.payload === "object" && !Array.isArray(v.payload)
      ? {
          rawText: typeof payloadInput.rawText === "string" ? payloadInput.rawText : "",
          promptText: typeof payloadInput.promptText === "string" ? payloadInput.promptText : "",
          attachments: Array.isArray(payloadInput.attachments)
            ? (payloadInput.attachments.map(normalizeAttachment).filter(Boolean) as QueueAttachment[])
            : [],
        }
      : undefined;
  if (!source || !payload) return undefined;

  const lease = normalizeLease(v.lease);
  const state = (v.state === "leased" || v.state === "running") && !lease ? "queued" : (v.state as QueueState);
  const error =
    (v.state === "leased" || v.state === "running") && !lease
      ? "Recovered malformed queued work without a valid lease."
      : typeof v.error === "string"
        ? v.error
        : undefined;

  return {
    id: v.id,
    state,
    error,
    source,
    payload,
    lease,
  };
}

interface QueueDataInput {
  items?: unknown[];
}

function normalizeQueueData(value: unknown): QueueData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, items: [] };
  }
  const v = value as QueueDataInput;
  return {
    version: 1,
    items: Array.isArray(v.items) ? (v.items.map(normalizeItem).filter(Boolean) as QueueItem[]) : [],
  };
}

export class RouteQueueStore {
  private filePath: string;
  private leaseMs: number;
  data: QueueData;

  constructor(filePath: string, leaseMs: number) {
    this.filePath = filePath;
    this.leaseMs = leaseMs;
    this.data = { version: 1, items: [] };
  }

  async load(): Promise<QueueData> {
    this.data = normalizeQueueData(await readJson(this.filePath, { version: 1, items: [] }));
    return this.data;
  }

  async save(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeJson(this.filePath, this.data);
  }

  list(): QueueItem[] {
    return this.data.items.slice();
  }

  hasSource(sourceId: string): boolean {
    return this.data.items.some((item) => item.source.sourceId === sourceId && item.state !== "cancelled");
  }

  async enqueue(input: Omit<QueueItem, "id" | "state" | "lease" | "error">): Promise<QueueItem> {
    const item: QueueItem = {
      id: randomUUID(),
      state: "queued",
      error: undefined,
      lease: undefined,
      ...input,
    };
    this.data.items.push(item);
    await this.save();
    return item;
  }

  async replaceQueuedBySource(
    sourceId: string,
    updater: (item: QueueItem) => void,
  ): Promise<QueueItem | undefined> {
    const item = this.data.items.find(
      (entry) => entry.source.sourceId === sourceId && entry.state === "queued",
    );
    if (!item) return undefined;
    updater(item);
    await this.save();
    return item;
  }

  async cancelQueuedBySource(sourceId: string, reason: string = "Cancelled by transport event."): Promise<void> {
    let changed = false;
    for (const item of this.data.items) {
      if (item.source.sourceId === sourceId && item.state === "queued") {
        item.state = "cancelled";
        item.error = reason;
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async recoverExpiredLeases(now: number = Date.now()): Promise<void> {
    let changed = false;
    for (const item of this.data.items) {
      if (
        (item.state === "leased" || item.state === "running") &&
        item.lease &&
        item.lease.expiresAt <= now
      ) {
        item.state = "queued";
        item.lease = undefined;
        item.error = "Recovered abandoned work after lease expiry.";
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async leaseNext(workerId: string, now: number = Date.now()): Promise<QueueItem | undefined> {
    const item = this.data.items.find((entry) => entry.state === "queued");
    if (!item) return undefined;
    item.state = "leased";
    item.lease = {
      workerId,
      acquiredAt: now,
      expiresAt: now + this.leaseMs,
    };
    await this.save();
    return item;
  }

  async markRunning(itemId: string): Promise<QueueItem | undefined> {
    const item = this.data.items.find((entry) => entry.id === itemId);
    if (!item) return undefined;
    item.state = "running";
    if (item.lease) item.lease.expiresAt = Date.now() + this.leaseMs;
    await this.save();
    return item;
  }

  async heartbeat(itemId: string): Promise<QueueItem | undefined> {
    const item = this.data.items.find((entry) => entry.id === itemId);
    if (!item || !item.lease) return undefined;
    item.lease.expiresAt = Date.now() + this.leaseMs;
    await this.save();
    return item;
  }

  async finish(itemId: string, nextState: QueueState, error?: string): Promise<QueueItem | undefined> {
    const item = this.data.items.find((entry) => entry.id === itemId);
    if (!item) return undefined;
    item.state = nextState;
    item.error = error;
    item.lease = undefined;
    await this.save();
    return item;
  }
}
