import path from "node:path";
import { readFile } from "node:fs/promises";
import { appendJsonLine, ensureDir } from "../lib/fs.js";

export interface JournalEntry {
  sourceId?: string;
  [key: string]: unknown;
}

export class JournalStore {
  private filePath: string;
  entries: JournalEntry[];
  private sourceIds: Set<string>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.entries = [];
    this.sourceIds = new Set();
  }

  async load(): Promise<JournalEntry[]> {
    await ensureDir(path.dirname(this.filePath));
    try {
      const content = await readFile(this.filePath, "utf8");
      this.entries = content
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      this.sourceIds = new Set(
        this.entries
          .map((entry) => entry.sourceId)
          .filter((id): id is string => Boolean(id)),
      );
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.entries = [];
      this.sourceIds = new Set();
    }
    return this.entries;
  }

  hasSource(sourceId: string): boolean {
    return this.sourceIds.has(sourceId);
  }

  recent(limit: number = 25, predicate: (entry: JournalEntry) => boolean = () => true): JournalEntry[] {
    return this.entries.filter(predicate).slice(-limit);
  }

  async append(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
    if (entry.sourceId) this.sourceIds.add(entry.sourceId);
    await appendJsonLine(this.filePath, entry);
  }
}
