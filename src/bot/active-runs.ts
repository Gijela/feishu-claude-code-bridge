import type { AgentRun } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
}

/**
 * Tracks active agent runs per scope, with per-role granularity.
 * A single scope (chat) can have multiple agents running concurrently
 * (e.g. PM analyzing while Dev codes).
 *
 * Key structure: scope → Map<roleId, RunHandle>
 */
export class ActiveRuns {
  private readonly handles = new Map<string, Map<string, RunHandle>>();

  register(chatId: string, run: AgentRun, roleId?: string): RunHandle {
    const key = roleId ?? '_default';
    let roleMap = this.handles.get(chatId);
    if (!roleMap) {
      roleMap = new Map();
      this.handles.set(chatId, roleMap);
    }
    const handle: RunHandle = { run, interrupted: false };
    roleMap.set(key, handle);
    return handle;
  }

  unregister(chatId: string, run: AgentRun, roleId?: string): void {
    const key = roleId ?? '_default';
    const roleMap = this.handles.get(chatId);
    if (!roleMap) return;
    const existing = roleMap.get(key);
    if (existing?.run === run) {
      roleMap.delete(key);
      if (roleMap.size === 0) this.handles.delete(chatId);
    }
  }

  /**
   * Interrupt a run for this chat and optionally role.
   * If roleId is omitted, interrupts ALL runs for this chat.
   * Returns true if any interrupt was issued.
   */
  interrupt(chatId: string, roleId?: string): boolean {
    const roleMap = this.handles.get(chatId);
    if (!roleMap) return false;

    if (roleId) {
      return this.interruptOne(roleMap, chatId, roleId);
    }

    let interrupted = false;
    for (const key of [...roleMap.keys()]) {
      if (this.interruptOne(roleMap, chatId, key)) interrupted = true;
    }
    return interrupted;
  }

  private interruptOne(roleMap: Map<string, RunHandle>, chatId: string, roleId: string): boolean {
    const h = roleMap.get(roleId);
    if (!h) return false;
    h.interrupted = true;
    roleMap.delete(roleId);
    if (roleMap.size === 0) this.handles.delete(chatId);
    void h.run.stop().catch(() => {});
    return true;
  }

  /** Get all active runs for a chat. Returns map of roleId → RunHandle. */
  getAllActive(chatId: string): Map<string, RunHandle> {
    return this.handles.get(chatId) ?? new Map();
  }

  async stopAll(): Promise<void> {
    const all: RunHandle[] = [];
    for (const roleMap of this.handles.values()) {
      for (const h of roleMap.values()) {
        h.interrupted = true;
        all.push(h);
      }
    }
    this.handles.clear();
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
}
