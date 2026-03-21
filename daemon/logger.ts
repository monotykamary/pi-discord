import { appendFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../lib/fs.js";

export interface LogDetails {
  [key: string]: unknown;
}

export class Logger {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async log(level: string, message: string, details?: LogDetails): Promise<void> {
    try {
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        details,
      });
      await ensureDir(path.dirname(this.filePath));
      await appendFile(this.filePath, `${line}\n`, "utf8");
    } catch {
      return;
    }
  }

  info(message: string, details?: LogDetails): Promise<void> {
    return this.log("info", message, details);
  }

  warn(message: string, details?: LogDetails): Promise<void> {
    return this.log("warn", message, details);
  }

  error(message: string, details?: LogDetails): Promise<void> {
    return this.log("error", message, details);
  }
}
