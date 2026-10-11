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
 * allow = continue; ask = force the owner prompt, except: a SOFT ask in an active auto-mode run is left to the SDK
 * classifier (logged "auto"), and EVERY ask (soft or owner-only) in an active bypass-mode run is let through
 * (logged "bypass"; the hook is the only gate there, deny stays a hard deny). Records the decision per tool_use_id
 * for the `tool.done` line. The hook is session-level, so Task subagents of the run pass through it too:
 * their calls carry `agent_id`/`agent_type` into the guard (asks are denies there) and into the log lines.
 */
export function guardHook(
  p: ToolPermissionInput,
  decisions: Map<string, LoggedDecision>,
  log: Logger,
): HookCallback {
  return async (i) => {
    if (i.hook_event_name !== "PreToolUse") return { continue: true };
    // Plan/question tools of the MAIN agent are handled by canUseTool; the same call from a subagent (no owner
    // path) goes to the guard, which denies it.
    // The main agent has no agent_id (null/absent); any string, even empty, is a subagent (fail closed).
    const agent =
      typeof i.agent_id === "string"
        ? { id: i.agent_id, ...(i.agent_type && { type: i.agent_type }) }
        : undefined;
    if (!agent && PLAN_FLOW_TOOLS.has(i.tool_name)) return { continue: true };
    // Inside a subagent the guard also gets who is calling (scope by type, asks become denies).
    const ctx = agent ? { ...p.guard, agent } : p.guard;
    const d = checkToolCall(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, ctx);
    // Auto mode: a soft `ask` is deferred to the classifier; logged as decision "auto" (reason only, no content).
    const deferred = d.decision === "ask" && !d.ownerOnly && p.autoMode?.active;
    // Bypass mode: the owner chose "let them run"; an ask never reaches canUseTool (the SDK asks nothing).
    const bypassed = d.decision === "ask" && !!p.bypassMode?.active;
    if (d.decision !== "deny")
      decisions.set(
        i.tool_use_id,
        bypassed ? { ...d, decision: "bypass" } : deferred ? { ...d, decision: "auto" } : d,
      );
    if (d.decision === "allow" || deferred || bypassed) return { continue: true };
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
