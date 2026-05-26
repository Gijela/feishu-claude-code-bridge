export interface DispatchDirective {
  targetRole: string;
  round: number;
  instruction?: string;
  /** Full output text from the dispatching agent, used as context for the next role. */
  sourceContext?: string;
}

const DISPATCH_RE = /🔀\s*(@\S+)\s*(?:#round=(\d+))?\s*(.*)/;

export function parseDispatch(text: string): DispatchDirective | null {
  if (!text) return null;
  const lastLines = text.trim().split('\n').filter(Boolean).slice(-5).join('\n');
  const m = lastLines.match(DISPATCH_RE);
  if (!m) return null;
  return {
    targetRole: m[1]!,
    round: m[2] ? parseInt(m[2], 10) : 1,
    instruction: m[3]?.trim() || undefined,
  };
}
