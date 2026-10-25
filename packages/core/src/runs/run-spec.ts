import type { Bot } from "../domain/bot";
import { EFFORT_LEVELS, type EffortLevel } from "../domain/effort";
import type { HubContext } from "../hub/hub-context";
import { stableJson } from "../permission/input-hash";
import type { BotRuntimeSpec } from "../ports/agent-runtime";
import { effectKeyFor } from "./effect-key";
import { postProgress } from "./progress-budget";
import { decideInRun } from "./run-cards";
import type { RunExec } from "./run-exec";
import { runKindOf } from "./run-kind";
import { askInRun } from "./run-questions";

/** A stored effort that is a known level, else undefined. */
const levelOf = (e?: string): EffortLevel | undefined =>
  (EFFORT_LEVELS as readonly string[]).includes(e ?? "") ? (e as EffortLevel) : undefined;

/**
 * The runtime spec of one run's session (without memory, teammates and scratchpad: `openRunSession` adds them). Tool decisions and
 * questions become cards in the conversation the run answers, and only while the run is live (`run-cards.ts`); the scope's stored `SetEffort` level is the bot's effort.
 */
export function runSpec(
  ctx: HubContext,
  exec: RunExec,
  effort?: string,
): Omit<BotRuntimeSpec, "memory" | "teammates" | "scratchpad"> {
  const level = levelOf(effort);
  const bot: Bot = level ? { ...exec.bot, effort: level } : exec.bot;
  return {
    bot,
    runKind: runKindOf(exec.row),
    sessionKey: exec.key,
    wakeId: exec.row.id,
    ...(exec.groupId && { groupId: exec.groupId }),
    decide: (c) => {
      // Every task of a run starts in the conversation the run answers, so a task's call asks there too.
      const conversationId = exec.live ? exec.current.conversationId : "";
      if (!conversationId)
        return Promise.resolve({ behavior: "deny", reason: "no conversation to ask in" });
      return decideInRun(ctx, exec, { ...c, conversationId });
    },
    // A question becomes a stored card in the conversation the run answers; after the run nobody is asked (null).
    ask: async (cards) =>
      exec.live
        ? askInRun(ctx, exec, cards)
        : { behavior: "refused", reason: "No one can answer questions here." },
    // Effect calls count in `sendCounts` (own `effect|` prefix), which a new execution starts empty.
    effectKey: async (tool, input) => {
      const hash = `effect|${tool}|${stableJson(input)}`;
      const n = (exec.sendCounts.get(hash) ?? 0) + 1;
      exec.sendCounts.set(hash, n);
      return effectKeyFor(exec.row.id, exec.row.cardId, tool, input, n);
    },
    // A progress update counts per wake in the store, so a resumed run keeps its budget.
    postUpdate: (text) => postProgress(ctx, exec, text),
    maxToolCallsPerTurn: ctx.limits.maxToolCallsPerTurn,
    effortControl: {},
    currentConversation: () => (exec.live ? exec.current.conversationId : undefined),
  };
}

/** Make `SetEffort` also keep the new level on the scope, so the next run of the scope opens with it. */
export function persistEffort(
  ctx: HubContext,
  key: string,
  spec: Pick<BotRuntimeSpec, "effortControl">,
) {
  const control = spec.effortControl;
  const apply = control?.apply;
  if (!control || !apply) return;
  control.apply = async (level) => {
    await apply(level);
    await ctx.deps.store.scopes.setEffort(key, level);
  };
}
