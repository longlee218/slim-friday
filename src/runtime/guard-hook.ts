import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import { checkToolCall, type LoggedDecision } from "../guardrails/check-tool-call";
import { logEvent } from "../observability/logger";
import { agentIdentity } from "../observability/subagent-hooks";
import { describeTool } from "../observability/tool-target";
import { PLAN_FLOW_TOOLS } from "../tools/tool-catalog";
import type { ToolPermissionInput } from "./tool-permissions";

/**
 * PreToolUse hook of a gated stage: runs the guard. deny = hard deny (logged here: a denied call has no Post hook);
 * allow = continue; ask = force the owner prompt, except a SOFT ask in an active auto-mode run, which is left to the
 * SDK classifier (logged as decision "auto"). Records the decision per tool_use_id for the `tool.done` line.
 */
export function guardHook(
  p: ToolPermissionInput,
  decisions: Map<string, LoggedDecision>,
  log: Logger,
): HookCallback {
  return async (i) => {
    if (i.hook_event_name !== "PreToolUse") return { continue: true };
    // Plan/question tools are handled by canUseTool.
    if (PLAN_FLOW_TOOLS.has(i.tool_name)) return { continue: true };
    const d = checkToolCall(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, p.guard);
    // Auto mode: a soft `ask` is deferred to the classifier; logged as decision "auto" (reason only, no content).
    const deferred = d.decision === "ask" && !d.ownerOnly && p.autoMode?.active;
    if (d.decision !== "deny")
      decisions.set(i.tool_use_id, deferred ? { ...d, decision: "auto" } : d);
    if (d.decision === "allow" || deferred) return { continue: true };
    if (d.decision === "deny")
      logEvent(
        log,
        "tool.denied",
        {
          ...agentIdentity(i),
          tool: i.tool_name,
          toolUseId: i.tool_use_id,
          target: describeTool(i.tool_name, i.tool_input, p.guard.readPaths).target,
          reason: d.reason,
        },
        "warn",
      );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: d.decision,
        permissionDecisionReason: d.reason,
      },
    };
  };
}
