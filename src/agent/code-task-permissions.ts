import type { CanUseTool, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalGateway } from "../approvals/approval-types";
import { checkToolCall, type GuardrailContext } from "../guardrails/check-tool-call";
import { logger } from "../observability/logger";

/** Max chars of a tool input shown inline in the approval message (full input goes in the attachment). */
const SUMMARY_MAX = 300;

/** Inputs for one code task's permission layer. */
export interface CodeTaskPermissionInput {
  taskId: string;
  threadId: string;
  guard: GuardrailContext;
  gateway: ApprovalGateway;
}

/** Short one-line description of a tool call for the approval message. */
function summarize(tool: string, input: Record<string, unknown>): string {
  const main = input.command ?? input.file_path ?? input.path ?? JSON.stringify(input);
  const text = String(main).replace(/\s+/g, " ");
  return `${tool}: ${text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}...` : text}`;
}

/**
 * Permission layer for code tasks (spike findings applied):
 * - PreToolUse hook = hard deny, and forces `ask` so even SDK-auto-allowed read-only Bash goes through policy.
 * - canUseTool = ask the owner in Discord (plan approval, AskUserQuestion, risky tools).
 * Never use `allowedTools`: it would bypass canUseTool.
 */
export function buildCodeTaskPermissions(p: CodeTaskPermissionInput): {
  canUseTool: CanUseTool;
  hooks: HookCallbackMatcher[];
} {
  const log = logger.child({ module: "code-task-permissions", taskId: p.taskId });

  const hooks: HookCallbackMatcher[] = [
    {
      hooks: [
        async (i) => {
          if (i.hook_event_name !== "PreToolUse") return { continue: true };
          // Plan/question tools are handled by canUseTool.
          if (i.tool_name === "ExitPlanMode" || i.tool_name === "AskUserQuestion")
            return { continue: true };
          const d = checkToolCall(
            i.tool_name,
            (i.tool_input ?? {}) as Record<string, unknown>,
            p.guard,
          );
          if (d.decision === "allow") return { continue: true };
          log.info({ tool: i.tool_name, decision: d.decision, reason: d.reason }, "guardrail");
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
    opts?.signal?.addEventListener("abort", () => p.gateway.cancelTask?.(p.taskId), { once: true });
    const input = rawInput as Record<string, unknown>;
    try {
      if (tool === "ExitPlanMode") {
        const plan = String(input.plan ?? "");
        const req = {
          taskId: p.taskId,
          threadId: p.threadId,
          tool,
          summary: plan.slice(0, 1500),
          detail: plan,
        };
        const r = await (p.gateway.requestPlan ?? p.gateway.request).call(p.gateway, req);
        return r.approved
          ? { behavior: "allow", updatedInput: input }
          : {
              behavior: "deny",
              message: `Owner rejected the plan (${r.reason ?? "no reason"}). Revise it and call ExitPlanMode again.`,
            };
      }
      if (tool === "AskUserQuestion") {
        const answers: Record<string, string> = {};
        for (const q of (input.questions ?? []) as {
          question: string;
          options: { label: string }[];
        }[]) {
          const label = await p.gateway.askChoice({
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
      log.error({ tool, err: String(err) }, "permission check failed");
      return { behavior: "deny", message: "Permission check failed." };
    }
  };

  return { canUseTool, hooks };
}
