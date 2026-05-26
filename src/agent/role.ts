import type { AgentAdapter } from './types';

export interface AgentRole {
  id: string;
  displayName: string;
  mentionName: string;
  description: string;
  adapter: AgentAdapter;
  systemPrompt?: string;
  maxRoundTrip: number;
}

export function defaultRoles(): AgentRole[] {
  return [];
}
