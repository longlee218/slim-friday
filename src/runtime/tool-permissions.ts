import type { CanUseTool, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalGateway } from "../approvals/approval-types";
import {
  checkToolCall,
  type GuardrailContext,
  type LoggedDecision,
} from "../guardrails/check-tool-call";
import { logger } from "../observability/logger";
import { clip, errText } from "../observability/redact";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "../tools/sdk-tool-names";
import { ASK_LIMIT_DENIAL, type AskLimit, MAX_ASK_CALLS_PER_TASK, newAskLimit } from "./ask-limit";
import { guardHook } from "./guard-hook";
import type { ModeActive } from "./permission-mode";

/** Max chars of a tool input shown inline in the approval message (full input goes in the attachment). */
const SUMMARY_MAX = 300;

/** One question of an AskUserQuestion call (the first option is the default). */
export interface AskQuestion {
  question: string;
  options: { label: string }[];
}

/** Inputs for one gated stage's permission layer. */
export interface ToolPermissionInput {
  taskId: string;
  threadId: string;
  guard: GuardrailContext;
  /** Owner approval via Discord. Omitted (a stage without a gateway): every `ask` becomes a deny. */
  gateway?: ApprovalGateway;
  /**
   * Plan-approval stage of a staged task: the plan must name a repo (`repo: <name>`) from `repos`;
   * after the owner approves, `onApproved` fires (the caller then stops the run and starts stage 2).
   */
  plan?: { repos: string[]; onApproved: (plan: string, repo: string) => void };
  /** Shared across the task's runs: the AskUserQuestion budget of the task. Omitted = budget per permission layer. */
  askLimit?: AskLimit;
  /**
   * Stage runs in SDK `auto` mode: a SOFT guard `ask` is left to the SDK classifier (canUseTool only if it cannot
   * decide). Owner-only asks (`Decision.ownerOnly`) and every ask when `active` is false still force the owner prompt.
   */
  autoMode?: ModeActive;
  /**
   * Stage runs in SDK `bypassPermissions` mode: the SDK asks nothing, so the hook is the only gate. Hard denies stay
   * denies; EVERY guard `ask` (soft and owner-only) is let through and logged "bypass". When `active` is false (the
   * SDK did not enter bypass) asks go to the owner as in default mode (fail closed).
   */
  bypassMode?: ModeActive;
  /** The owner did not answer the questions in time: the caller stops the run and replies "Awaiting clarification". */
  onAskTimeout?: (questions: AskQuestion[]) => void;
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
 * Permission layer of stages with a gateway (spike findings applied):
 * - PreToolUse hook = hard deny, and forces `ask` so even SDK-auto-allowed read-only Bash goes through policy.
 * - canUseTool = ask the owner in Discord (plan approval, AskUserQuestion, risky tools).
 * Never use `allowedTools`: it would bypass canUseTool.
 */
export function buildToolPermissions(p: ToolPermissionInput): {
  canUseTool: CanUseTool;
  hooks: HookCallbackMatcher[];
  /** Guard decision per tool_use_id (allow/ask/auto/bypass), read by the tool hooks to complete the `tool.done` line. */
  decisions: Map<string, LoggedDecision>;
} {
  const log = logger.child({ module: "tool-permissions" });
  const decisions = new Map<string, LoggedDecision>();
  const askLimit = p.askLimit ?? newAskLimit();

  const hooks: HookCallbackMatcher[] = [{ hooks: [guardHook(p, decisions, log)] }];

  const canUseTool: CanUseTool = async (tool, rawInput, opts) => {
    // Run stopped/timed out/shut down while waiting: drop the open request (buttons + timer).
    opts?.signal?.addEventListener("abort", () => p.gateway?.cancelTask(p.taskId), {
      once: true,
    });
    const input = rawInput as Record<string, unknown>;
    try {
      if (
        (tool === EXIT_PLAN_MODE_TOOL_NAME || tool === ASK_USER_QUESTION_TOOL_NAME) &&
        !p.gateway
      ) {
        return { behavior: "deny", message: "Not available in this mode." };
      }
      const gateway = p.gateway!;
      if (tool === EXIT_PLAN_MODE_TOOL_NAME) {
        const plan = String(input.plan ?? "");
        const repo = parsePlanRepo(plan);
        if (p.plan && (!repo || !p.plan.repos.includes(repo))) {
          return {
            behavior: "deny",
            message: `The plan must contain a line "repo: <name>" naming exactly one of: ${p.plan.repos.join(", ")}. Add it and call ${EXIT_PLAN_MODE_TOOL_NAME} again.`,
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
              message: `Owner rejected the plan (${r.reason ?? "no reason"}). Revise it and call ${EXIT_PLAN_MODE_TOOL_NAME} again.`,
            };
      }
      if (tool === ASK_USER_QUESTION_TOOL_NAME) {
        // At most MAX_ASK_CALLS_PER_TASK calls per task, enforced here (not only in the prompt): later ones never reach the owner.
        if (askLimit.calls >= MAX_ASK_CALLS_PER_TASK)
          return { behavior: "deny", message: ASK_LIMIT_DENIAL };
        askLimit.calls++;
        const questions = (input.questions ?? []) as AskQuestion[];
        const answers: Record<string, string> = {};
        for (const q of questions) {
          const label = await gateway.askChoice({
            taskId: p.taskId,
            threadId: p.threadId,
            question: q.question,
            options: q.options.map((o) => o.label),
          });
          if (label === undefined) {
            p.onAskTimeout?.(questions);
            return { behavior: "deny", message: "Owner did not answer in time. Stop here." };
          }
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
