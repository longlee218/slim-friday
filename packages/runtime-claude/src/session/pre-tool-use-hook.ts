import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { CallGuard } from "./call-guard";
import { type FloorContext, floorCheck } from "./floor-check";

/** A `PreToolUse` deny with `reason`; `stop` also ends the agent loop (`continue: false` + `stopReason`). */
function deny(reason: string, stop: boolean) {
  return {
    ...(stop && { continue: false, stopReason: reason }),
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * The `PreToolUse` hook of a session. It runs for every call, also those the CLI auto-allows (reads inside the cwd,
 * Glob / Grep with no path), so the hard floor holds there: the floor is checked first and its deny is never
 * relaxed. Then the call guard counts the call (loop guard, tool-call cap); a guard stop denies the call, ends the
 * agent loop and reports the guard text through `onGuardStop` (the session's final answer).
 */
export function preToolUseHook(
  floor: FloorContext,
  guard?: CallGuard,
  onGuardStop?: (text: string) => void,
): HookCallback {
  return async (hook) => {
    if (hook.hook_event_name !== "PreToolUse") return { continue: true };
    const call = {
      tool: hook.tool_name,
      input: (hook.tool_input ?? {}) as Record<string, unknown>,
    };
    const floorReason = floorCheck(call, floor);
    const verdict = guard?.check(call.tool, call.input, hook.agent_id);
    if (verdict && !verdict.ok) {
      onGuardStop?.(verdict.reason);
      return deny(verdict.reason, true);
    }
    return floorReason ? deny(floorReason, false) : { continue: true };
  };
}
