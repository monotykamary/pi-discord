export interface RouteKeyInput {
  guildId?: string | null;
  channelId: string;
  threadId?: string | null;
}

export interface ScopeInfo {
  guildId: string | null;
  channelId: string;
  threadId: string | null;
}

export type ScopeInput = ScopeInfo;

export function makeRouteKey(input: RouteKeyInput): string {
  const guildPart = input.guildId ?? "dm";
  const threadPart = input.threadId ?? "root";
  return `${guildPart}__${input.channelId}__${threadPart}`;
}

export function formatRoute(scope: ScopeInfo): string {
  if (scope.guildId === null || scope.guildId === undefined) {
    return "DM";
  }
  
  if (scope.threadId && scope.threadId !== "root") {
    return `<#${scope.threadId}>`;
  }
  
  return `<#${scope.channelId}>`;
}
