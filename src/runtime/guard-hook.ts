import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import { checkToolCall, type LoggedDecision } from "../guardrails/check-tool-call";
import {
  gateMainCall,
  isSpawnCall,
  type SubagentRun,
  spawnDone,
  spawnFailed,
} from "../guardrails/subagent-run";
import { logEvent } from "../observability/logger";
import { agentIdentity } from "../observability/subagent-hooks";
import { describeTool } from "../observability/tool-target";
import { SEND_MESSAGE_TOOL_NAME } from "../tools/sdk-tool-names";
import { PLAN_FLOW_TOOLS } from "../tools/tool-catalog";
import type { ToolPermissionInput } from "./tool-permissions";

/**
 * PreToolUse hook of a gated stage: runs the guard. deny = hard deny (logged here: a denied call has no Post hook);
 * allow = continue; ask = force the owner prompt, except: a SOFT ask in an active auto-mode run is left to the SDK
 * classifier (logged "auto"), and EVERY ask (soft or owner-only) in an active bypass-mode run is let through
 * (logged "bypass"; the hook is the only gate there, deny stays a hard deny). Records the decision per tool_use_id
 * for the `tool.done` line. The hook is session-level, so Task subagents of the run pass through it too:
 * their calls carry `agent_id`/`agent_type` into the guard (asks are denies there) and into the log lines.
 * A main-agent spawn or resume the pure guard allows also passes the run's stateful gate (`run`: caps, unique name,
 * known SendMessage target; see subagent-run.ts).
 */
export function guardHook(
  p: ToolPermissionInput,
  decisions: Map<string, LoggedDecision>,
  log: Logger,
  run: SubagentRun,
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
    const input = (i.tool_input ?? {}) as Record<string, unknown>;
    const pure = checkToolCall(i.tool_name, input, ctx);
    const d = agent ? pure : gateMainCall(i.tool_name, input, i.tool_use_id, pure, run);
    if (d.decision === "allow" && i.tool_name === SEND_MESSAGE_TOOL_NAME && !agent)
      logEvent(log, "subagent.resume", { to: String(input.to).slice(0, 80), spawns: run.spawns });
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

/**
 * Post hooks of the Agent tool (main agent only): the call is no longer in flight and its `agentId` becomes a valid
 * SendMessage target (`spawnDone`); logs `subagent.spawned` with the model asked and the one it resolved to and the run's
 * spawn count (no prompt text). Registered for success and failure alike; a failed spawn has no response.
 */
export function subagentPostHooks(
  run: SubagentRun,
  log: Logger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const done = (i: Record<string, unknown>, response: unknown) => {
    if (typeof i.agent_id === "string" || !isSpawnCall(String(i.tool_name))) return;
    const input = (i.tool_input ?? {}) as Record<string, unknown>;
    if (response === undefined) spawnFailed(run, String(i.tool_use_id), input);
    else spawnDone(run, String(i.tool_use_id), response);
    const r = (response ?? {}) as Record<string, unknown>;
    logEvent(log, "subagent.spawned", {
      subagentType: input.subagent_type,
      name: input.name,
      modelAsked: input.model,
      modelResolved: r.resolvedModel,
      agentId: r.agentId,
      spawns: run.spawns,
      ok: response !== undefined,
    });
  };
  const matcher = (fn: (i: Record<string, unknown>) => void): HookCallbackMatcher[] => [
    { hooks: [async (i) => (fn(i as never), { continue: true })] },
  ];
  return {
    PostToolUse: matcher((i) => done(i, i.tool_response)),
    PostToolUseFailure: matcher((i) => done(i, undefined)),
  };
}
