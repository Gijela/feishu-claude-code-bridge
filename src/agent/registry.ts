import { log } from '../core/logger';
import type { AgentRole } from './role';

export class AgentRegistry {
  private roles = new Map<string, AgentRole>();

  register(role: AgentRole): void {
    this.roles.set(role.id, role);
    log.info('registry', 'register', { id: role.id, name: role.displayName, mention: role.mentionName });
  }

  get(roleId: string): AgentRole | undefined {
    return this.roles.get(roleId);
  }

  getByMention(text: string): AgentRole | undefined {
    const mention = text.replace(/^@/, '').toLowerCase();
    for (const role of this.roles.values()) {
      const clean = role.mentionName.replace(/^@/, '').toLowerCase();
      if (clean === mention) return role;
    }
    return undefined;
  }

  matchRole(content: string): AgentRole | undefined {
    const lower = content.toLowerCase();
    for (const role of this.roles.values()) {
      if (lower.includes(role.mentionName.toLowerCase())) return role;
    }
    return undefined;
  }

  list(): AgentRole[] {
    return [...this.roles.values()];
  }

  size(): number {
    return this.roles.size;
  }
}
