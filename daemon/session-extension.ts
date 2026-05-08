import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface RuntimeInterface {
  getInjectedContext: () => Promise<string>;
  uploadFile: (filePath: string, options?: { title?: string }) => Promise<{ messageId: string; url?: string }>;
}

export function createRouteSessionExtension(runtime: RuntimeInterface) {
  return (pi: ExtensionAPI) => {
    pi.on("context", async (event) => {
      const injectedText = await runtime.getInjectedContext();
      if (!injectedText.trim()) return undefined;
      return {
        messages: [
          {
            role: "user" as const,
            content: `Discord route context:\n\n${injectedText}`,
            timestamp: Date.now(),
          },
          ...event.messages,
        ],
      };
    });

    pi.registerTool({
      name: "discord_upload",
      label: "Discord Upload",
      description: "Upload a local file to the active Discord route surface.",
      promptSnippet: "Upload route artifacts back to Discord when the user asked for a file.",
      promptGuidelines: [
        "Use this tool instead of assuming local files are automatically sent to Discord.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "Local file path to upload" }),
        title: Type.Optional(Type.String({ description: "Optional message title" })),
      }),
      async execute(_toolCallId: string, params: { path: string; title?: string }) {
        const result = await runtime.uploadFile(params.path, { title: params.title });
        return {
          content: [{ type: "text" as const, text: `Uploaded ${params.path} to Discord.` }],
          details: result,
        };
      },
    });
  };
}
