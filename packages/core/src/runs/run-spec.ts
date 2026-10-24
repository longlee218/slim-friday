import type { Bot } from "../domain/bot";
import { EFFORT_LEVELS, type EffortLevel } from "../domain/effort";
import type { HubContext } from "../hub/hub-context";
import type { BotRuntimeSpec } from "../ports/agent-runtime";
import type { RunExec } from "./run-exec";

/** A stored effort that is a known level, else undefined. */
const levelOf = (e?: string): EffortLevel | undefined =>
  (EFFORT_LEVELS as readonly string[]).includes(e ?? "") ? (e as EffortLevel) : undefined;

/**
 * The runtime spec of one run's session (without memory: `openRunSession` adds it). Tool decisions and
 * questions go to the conversation the run answers (a task's call to the conversation that started the
 * task) and only while the run is live; the scope's stored `SetEffort` level is the bot's effort.
 */
export function runSpec(
  ctx: HubContext,
  exec: RunExec,
  effort?: string,
): Omit<BotRuntimeSpec, "memory"> {
  const level = levelOf(effort);
  const bot: Bot = level ? { ...exec.bot, effort: level } : exec.bot;
  const { gate, surface } = ctx.deps;
  return {
    bot,
    sessionKey: exec.key,
    ...(exec.groupId && { groupId: exec.groupId }),
    decide: (c) => {
      const current = exec.live ? exec.current.conversationId : "";
      const conversationId =
        (c.taskId ? exec.tasks.get(c.taskId)?.conversationId : undefined) ?? current;
      if (!conversationId)
        return Promise.resolve({ behavior: "deny", reason: "no conversation to ask in" });
      // A tool resolves "group" scope from the conversation the bot answers now; a task started elsewhere must not
      // reach that group.
      if (c.taskId && c.input.scope === "group" && conversationId !== current)
        return Promise.resolve({
          behavior: "deny",
          reason: "group scope is not reachable from a task started in another conversation",
        });
      return gate.decide({ tool: c.tool, input: c.input, botId: bot.id, conversationId }, bot.name);
    },
    // A question goes to the conversation the run answers; after the run nobody is asked (null).
    ask: async (card) => {
      if (!exec.live) return null;
      return surface.askQuestion(exec.current.conversationId, {
        ...card,
        botId: bot.id,
        botName: bot.name,
        timeoutMs: ctx.limits.approvalTimeoutMs,
      });
    },
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
