import { AGENT_TOOL_NAME } from "../tools/sdk-tool-names";
import type { Decision } from "./check-tool-call";

/** Subagents of one run that are started and not finished yet (`tool_use_id` of their Agent calls). */
export interface SubagentLimit {
  /** Most subagents running at once (the role's `subagents.parallel`): the next start is denied. */
  max: number;
  inFlight: Set<string>;
}

/** A fresh counter with the run's parallel cap (one per permission layer = one per run). */
export const newSubagentLimit = (max: number): SubagentLimit => ({ max, inFlight: new Set() });

/** True for the tool that starts a subagent (`Agent`). */
export const isSpawnCall = (tool: string): boolean => tool === AGENT_TOOL_NAME;

/**
 * Known limits, plainly:
 * - A slot taken at PreToolUse is freed by PostToolUse, PostToolUseFailure or PermissionDenied only. If a later layer
 *   blocks the call without any of those firing (e.g. a canUseTool owner deny: whether the SDK fires PermissionDenied
 *   for it is unverified), the slot stays taken until the run ends. The state is per run, so it cannot leak across runs.
 * - A `run_in_background` subagent is not covered: its Post hook fires at launch, not at its end. The child env sets
 *   CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, but that it also disables `run_in_background` on the Agent tool is unverified.
 *
 * Generic parallel cap: no subagent type, name or total count is looked at. A start the guard allowed takes a slot
 * (returns the allow unchanged); over the cap it is denied with a message that tells the agent what to do.
 */
export function gateSpawn(d: Decision, toolUseId: string, limit: SubagentLimit): Decision {
  if (d.decision !== "allow") return d;
  if (limit.inFlight.size >= limit.max)
    return {
      decision: "deny",
      reason: `at most ${limit.max} subagents run at once: wait for some to finish, or do this part yourself`,
    };
  limit.inFlight.add(toolUseId);
  return d;
}

/** The subagent finished (success, failure or a permission denial): free its slot. */
export const spawnFinished = (limit: SubagentLimit, toolUseId: string): void => {
  limit.inFlight.delete(toolUseId);
};
