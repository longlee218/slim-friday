import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { logEvent, logger, tryLog } from "./logger";

/** Who made a tool call: the hook input carries `agent_id`/`agent_type` only inside a subagent (fixtures: sdk-hooks). */
export type AgentIdentity = { agentId?: string; agentType?: string };

/** Identity fields of a hook input; empty for the main agent (the fields are absent there). */
export function agentIdentity(i: { agent_id?: string; agent_type?: string }): AgentIdentity {
  return {
    ...(i.agent_id && { agentId: i.agent_id }),
    ...(i.agent_type && { agentType: i.agent_type }),
  };
}

/**
 * SubagentStart / SubagentStop hooks: `subagent.start` and `subagent.stop` {agentId, agentType, durationMs,
 * resultChars}. Observe-only: they always return `continue: true` and never decide anything.
 * `resultChars` is the length of the subagent's last message (the text itself is never logged).
 */
export function buildSubagentHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const log = logger.child({ module: "subagent-hooks" });
  /** agent_id -> start timestamp (the stop payload has no duration). */
  const started = new Map<string, number>();
  return {
    SubagentStart: [
      {
        hooks: [
          async (i) => {
            if (i.hook_event_name === "SubagentStart")
              tryLog(log, "subagent hook failed", () => {
                started.set(i.agent_id, Date.now());
                logEvent(log, "subagent.start", agentIdentity(i));
              });
            return { continue: true };
          },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          async (i) => {
            if (i.hook_event_name === "SubagentStop")
              tryLog(log, "subagent hook failed", () => {
                const t0 = started.get(i.agent_id);
                started.delete(i.agent_id);
                logEvent(log, "subagent.stop", {
                  ...agentIdentity(i),
                  // No matching start (e.g. started before this hook set): omit, never claim 0 ms.
                  ...(t0 !== undefined && { durationMs: Date.now() - t0 }),
                  resultChars: i.last_assistant_message?.length ?? 0,
                });
              });
            return { continue: true };
          },
        ],
      },
    ],
  };
}
