import type { SessionEvent, ExtractedContent } from "./types.js";
import type { Logger } from "../logger.js";

export function extractToolContent(
  event: SessionEvent,
  storedParams: Record<string, unknown> | null = null,
  logger?: Logger,
  routeKey?: string,
): ExtractedContent {
  const result = event.result;
  if (!result) return { content: null, filename: null, isDiff: false };

  const params = storedParams || event.args || {};

  logger?.info("extract-tool-debug", {
    toolName: event.toolName,
    paramKeys: Object.keys(params),
    hasOldString: !!(params.old_string || params.search || params.oldString || params.old),
    hasNewString: !!(params.new_string || params.replace || params.newString || params.new),
  });

  if (event.toolName === "read" && result.content) {
    if (Array.isArray(result.content)) {
      const textBlock = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text");
      if (textBlock && textBlock.text) {
        return {
          content: textBlock.text,
          filename: (result.filePath || result.path || params.filePath || params.path) as string | undefined,
          isDiff: false,
        };
      }
    }
    if (typeof result.content === "string") {
      return {
        content: result.content,
        filename: (result.filePath || result.path || params.filePath || params.path) as string | undefined,
        isDiff: false,
      };
    }
  }

  if (event.toolName === "str_replace" || event.toolName === "edit" || event.toolName === "apply_diff") {
    const filePath = (params.path || params.filePath || result.filePath || result.path) as string | undefined;

    if (result.details?.diff) {
      return {
        content: result.details.diff,
        filename: filePath ?? null,
        isDiff: true,
      };
    }

    const oldStr = (params.oldText || params.old_string || params.search || params.oldString || params.old) as string | undefined;
    const newStr = (params.newText || params.new_string || params.replace || params.newString || params.new) as string | undefined;

    if (oldStr && newStr) {
      const diff = `--- ${filePath || "original"}\n+++ ${filePath || "modified"}\n@@ -1,1 +1,1 @@\n-${oldStr}\n+${newStr}`;
      return {
        content: diff,
        filename: filePath ?? null,
        isDiff: true,
      };
    }

    if (result.message) {
      return {
        content: result.message,
        filename: filePath ?? null,
        isDiff: false,
      };
    }
  }

  if (event.toolName === "read" || event.toolName === "read_file") {
    const filePath = (params.path || result.path || result.filePath) as string | undefined;

    if (result.content) {
      if (Array.isArray(result.content)) {
        const textBlock = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text");
        if (textBlock && textBlock.text) {
          return { content: textBlock.text, filename: filePath ?? null, isDiff: false };
        }
      }
      if (typeof result.content === "string") {
        return { content: result.content, filename: filePath ?? null, isDiff: false };
      }
    }
  }

  if (result.content) {
    if (Array.isArray(result.content)) {
      const textBlock = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text");
      if (textBlock && textBlock.text) {
        return { content: textBlock.text, filename: null, isDiff: false };
      }
    }
    if (typeof result.content === "string") {
      return { content: result.content, filename: null, isDiff: false };
    }
  }

  return { content: null, filename: null, isDiff: false };
}
