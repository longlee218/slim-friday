import { stableJson } from "@friday/core";

/** Same tool, same input this many times in a row means the bot is stuck, not paginating (R§8). */
export const LOOP_LIMIT = 6;

/** Rakazo's loop guard text (R§8), the final answer of a run the guard stopped. */
export function loopStopText(tool: string, count: number): string {
  return `I got stuck calling ${tool} with the same input ${count} times in a row without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.`;
}

/** Rakazo's tool-call cap text (R§8), the final answer of a run that went over the cap. */
export function capStopText(limit: number): string {
  return `I stopped after reaching the limit of ${limit} tool calls in this turn. Send another message to continue.`;
}

/** What the guard says about one call: run it, or deny it and stop the run with `reason` as the final. */
export type GuardVerdict = { ok: true } | { ok: false; reason: string; stop: true };

/** Loop guard and tool-call cap of one session (`PreToolUse` hook). */
export interface CallGuard {
  /**
   * Count one call. `agentId` is set for a subagent's call: it has its own streak and does not count toward the
   * turn's cap (the SDK runs subagents inside the parent).
   */
  check(tool: string, input: Record<string, unknown>, agentId?: string): GuardVerdict;
  /** A new turn starts: the cap count and the streaks start over. */
  resetTurn(): void;
}

/**
 * A guard for one session: the `LOOP_LIMIT`-th identical call in a row (same tool, deep-equal input) is denied
 * with a stop; a different call resets the streak. With `maxToolCallsPerTurn` above 0, the main thread's call
 * past that many in a turn is denied with a stop (0 = no cap).
 */
export function createCallGuard(limits: { maxToolCallsPerTurn: number }): CallGuard {
  /** Last call key and how many times in a row it came, per thread ("" = the main thread). */
  const streaks = new Map<string, { key: string; count: number }>();
  /** Main-thread calls in the current turn. */
  let calls = 0;
  return {
    check(tool, input, agentId) {
      const thread = agentId ?? "";
      const key = `${tool}\n${stableJson(input)}`;
      const last = streaks.get(thread);
      const count = last?.key === key ? last.count + 1 : 1;
      streaks.set(thread, { key, count });
      if (count >= LOOP_LIMIT) return { ok: false, reason: loopStopText(tool, count), stop: true };
      if (agentId !== undefined) return { ok: true };
      calls += 1;
      const cap = limits.maxToolCallsPerTurn;
      if (cap > 0 && calls > cap) return { ok: false, reason: capStopText(cap), stop: true };
      return { ok: true };
    },
    resetTurn() {
      streaks.clear();
      calls = 0;
    },
  };
}
