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
 * Formats a route key for human-readable display.
 * Shows short IDs with clear separators instead of concatenated numbers.
 * @param {string} routeKey
 * @returns {string}
 */
export function formatRouteKey(routeKey) {
  const parts = routeKey.split("__");
  if (parts.length !== 3) return routeKey;
  
  const [guild, channel, thread] = parts;
  const shortGuild = guild === "dm" ? "DM" : guild.slice(0, 6) + "…";
  const shortChannel = channel.slice(0, 6) + "…";
  const threadLabel = thread === "root" ? "channel" : `thread:${thread.slice(0, 6)}…`;
  
  return `${shortGuild} / ${shortChannel} / ${threadLabel}`;
}
