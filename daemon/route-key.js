/**
 * Creates a stable route key from Discord identifiers.
 * @param {{ guildId?: string | null, channelId: string, threadId?: string | null }} input
 */
export function makeRouteKey(input) {
  const guildPart = input.guildId ?? "dm";
  const threadPart = input.threadId ?? "root";
  return `${guildPart}__${input.channelId}__${threadPart}`;
}

/**
 * Formats a route for human-readable display in Discord.
 * Uses Discord mention syntax for clickable channel/thread links.
 * @param {{ guildId: string | null, channelId: string, threadId: string | null }} scope
 * @returns {string}
 */
export function formatRoute(scope) {
  if (scope.guildId === null || scope.guildId === undefined) {
    return "DM";
  }
  
  // Threads: mention the thread directly
  if (scope.threadId && scope.threadId !== "root") {
    return `<#${scope.threadId}>`;
  }
  
  // Regular channel
  return `<#${scope.channelId}>`;
}
