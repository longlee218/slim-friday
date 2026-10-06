import type { CanUseTool, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalGateway } from "../approvals/approval-types";
import { checkToolCall, type Decision, type GuardrailContext } from "../guardrails/check-tool-call";
import { logEvent, logger } from "../observability/logger";
import { clip, errText, safePreview } from "../observability/redact";
import { ASK_USER, EXIT_PLAN, PLAN_FLOW_TOOLS } from "../tools/tool-catalog";

/** Max chars of a tool input shown inline in the approval message (full input goes in the attachment). */
const SUMMARY_MAX = 300;

/** Inputs for one code task's permission layer. */
export interface ToolPermissionInput {
  taskId: string;
  threadId: string;
  guard: GuardrailContext;
  /** Owner approval via Discord. Omitted (Q&A): every `ask` becomes a deny. */
  gateway?: ApprovalGateway;
  /**
   * Plan stage of a two-stage code task: the plan must name a repo (`repo: <name>`) from `repos`;
   * after the owner approves, `onApproved` fires (the caller then stops the run and starts stage 2).
   */
  plan?: { repos: string[]; onApproved: (plan: string, repo: string) => void };
}

/** First `repo: <name>` line of a plan, or undefined. */
function parsePlanRepo(plan: string): string | undefined {
  return /^\s*[-*]?\s*\**repo\**\s*:\s*`?([\w.-]+)`?/im.exec(plan)?.[1];
}

/** Short one-line description of a tool call for the approval message. */
function summarize(tool: string, input: Record<string, unknown>): string {
  const main = input.command ?? input.file_path ?? input.path ?? JSON.stringify(input);
  const text = String(main).replace(/\s+/g, " ");
  return `${tool}: ${clip(text, SUMMARY_MAX)}`;
}

/**
 * Permission layer for code tasks (spike findings applied):
 * - PreToolUse hook = hard deny, and forces `ask` so even SDK-auto-allowed read-only Bash goes through policy.
 * - canUseTool = ask the owner in Discord (plan approval, AskUserQuestion, risky tools).
 * Never use `allowedTools`: it would bypass canUseTool.
 */
export function buildToolPermissions(p: ToolPermissionInput): {
  canUseTool: CanUseTool;
  hooks: HookCallbackMatcher[];
  /** Guard decision per tool_use_id (allow/ask), read by the tool hooks to complete the `tool.call` line. */
  decisions: Map<string, Decision>;
} {
  const log = logger.child({ module: "tool-permissions" });
  const decisions = new Map<string, Decision>();

  const hooks: HookCallbackMatcher[] = [
    {
      hooks: [
        async (i) => {
          if (i.hook_event_name !== "PreToolUse") return { continue: true };
          // Plan/question tools are handled by canUseTool.
          if (PLAN_FLOW_TOOLS.has(i.tool_name)) return { continue: true };
          const d = checkToolCall(
            i.tool_name,
            (i.tool_input ?? {}) as Record<string, unknown>,
            p.guard,
          );
          if (d.decision !== "deny") decisions.set(i.tool_use_id, d);
          if (d.decision === "allow") return { continue: true };
          // A denied call never runs, so no Post hook: its `tool.call` line is written here.
          if (d.decision === "deny")
            logEvent(log, "tool.call", {
              tool: i.tool_name,
              decision: d.decision,
              reason: d.reason,
              input: safePreview(i.tool_input, 300),
            });
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: d.decision,
              permissionDecisionReason: d.reason,
            },
          };
        },
      ],
    },
  ];

  const canUseTool: CanUseTool = async (tool, rawInput, opts) => {
    // Run stopped/timed out/shut down while waiting: drop the open request (buttons + timer).
    opts?.signal?.addEventListener("abort", () => p.gateway?.cancelTask(p.taskId), {
      once: true,
    });
    const input = rawInput as Record<string, unknown>;
    try {
      if ((tool === EXIT_PLAN || tool === ASK_USER) && !p.gateway) {
        return { behavior: "deny", message: "Not available in this mode." };
      }
      const gateway = p.gateway!;
      if (tool === EXIT_PLAN) {
        const plan = String(input.plan ?? "");
        const repo = parsePlanRepo(plan);
        if (p.plan && (!repo || !p.plan.repos.includes(repo))) {
          return {
            behavior: "deny",
            message: `The plan must contain a line "repo: <name>" naming exactly one of: ${p.plan.repos.join(", ")}. Add it and call ExitPlanMode again.`,
          };
        }
        const req = {
          taskId: p.taskId,
          threadId: p.threadId,
          tool,
          summary: plan,
          detail: plan,
        };
        const r = await gateway.requestPlan(req);
        if (r.approved && p.plan && repo) p.plan.onApproved(plan, repo);
        return r.approved
          ? { behavior: "allow", updatedInput: input }
          : {
              behavior: "deny",
              message: `Owner rejected the plan (${r.reason ?? "no reason"}). Revise it and call ExitPlanMode again.`,
            };
      }
      if (tool === ASK_USER) {
        const answers: Record<string, string> = {};
        for (const q of (input.questions ?? []) as {
          question: string;
          options: { label: string }[];
        }[]) {
          const label = await gateway.askChoice({
            taskId: p.taskId,
            threadId: p.threadId,
            question: q.question,
            options: q.options.map((o) => o.label),
          });
          if (label === undefined)
            return { behavior: "deny", message: "Owner did not answer in time." };
          answers[q.question] = label;
        }
        return { behavior: "allow", updatedInput: { ...input, answers } };
      }
      const d = checkToolCall(tool, input, p.guard);
      if (d.decision === "deny") return { behavior: "deny", message: d.reason };
      if (d.decision === "allow") return { behavior: "allow", updatedInput: input };
      if (!p.gateway)
        return { behavior: "deny", message: `${d.reason} (needs approval; not available here)` };
      const r = await p.gateway.request({
        taskId: p.taskId,
        threadId: p.threadId,
        tool,
        summary: summarize(tool, input),
        detail: JSON.stringify(input, null, 2),
      });
      return r.approved
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `Owner denied: ${r.reason ?? "no reason"}` };
    } catch (err) {
      // Fail closed: any error in the approval path denies the call.
      log.error({ tool, err: errText(err) }, "permission check failed");
      return { behavior: "deny", message: "Permission check failed." };
    }
  };

  return { canUseTool, hooks, decisions };
}
