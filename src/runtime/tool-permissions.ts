import type { CanUseTool, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../observability/logger";
import { clip, errText } from "../observability/redact";
import type { ApprovalGateway } from "../owner-approval/approval-types";
import {
  checkToolCall,
  type GuardrailContext,
  type LoggedDecision,
} from "../policy/check-tool-call";
import { newSubagentLimit } from "../policy/subagent-limit";
import { ASK_USER_QUESTION_TOOL_NAME } from "../tools/sdk-tool-names";
import { type AskLimit, askLimitDenial, newAskLimit } from "./ask-limit";
import { guardHook, subagentPostHooks } from "./guard-hook";
import type { ModeActive } from "./permission-mode";

/** Max chars of a tool input shown inline in the approval message (full input goes in the attachment). */
const SUMMARY_MAX = 300;

/** One question of an AskUserQuestion call (the first option is the default). */
export interface AskQuestion {
  question: string;
  options: { label: string }[];
}

/** Inputs for one run's permission layer. */
export interface ToolPermissionInput {
  turnId: string;
  threadId: string;
  guard: GuardrailContext;
  /** Owner approval via Discord. Omitted (a run without a gateway): every `ask` becomes a deny. */
  gateway?: ApprovalGateway;
  /** The AskUserQuestion budget of the run (the role's `limits.maxAsk`). Omitted = no questions (cap 0). */
  askLimit?: AskLimit;
  /**
   * The run is in SDK `auto` mode: a guard `ask` is left to the SDK classifier (canUseTool only if it cannot
   * decide). Every ask when `active` is false still forces the owner prompt.
   */
  autoMode?: ModeActive;
  /**
   * The run is in SDK `bypassPermissions` mode: the SDK asks nothing, so the hook is the only gate. Hard denies stay
   * denies; EVERY guard `ask` is let through and logged "bypass". When `active` is false (the
   * SDK did not enter bypass) asks go to the owner as in default mode (fail closed).
   */
  bypassMode?: ModeActive;
  /**
   * Teammate-dispatched worker: its AskUserQuestion goes to this relay (a `question` event for the teammate) instead of the
   * owner's buttons. Resolves with the answers by question text, or undefined when nobody answered (then the run stops).
   */
  askRelay?: (questions: AskQuestion[]) => Promise<Record<string, string> | undefined>;
  /** The owner did not answer the questions in time: the caller stops the run and replies "Awaiting clarification". */
  onAskTimeout?: (questions: AskQuestion[]) => void;
  /**
   * The run's abort signal. Once it fires (STOP / REPLACE / shutdown) no NEW tool may start: the hook and canUseTool
   * deny, also a call whose approval was granted while the run was being stopped. It can only deny (never overrides a
   * guard denial or the owner's decision) and never undoes a tool that already ran. Required for real runs.
   */
  runSignal?: AbortSignal;
  /** Most subagents running at once in this run (`RoleDefinition.subagents.parallel`); the next Agent start is denied. Omitted = none. */
  maxSubagents?: number;
  /** Observation only: every guard decision of a PreToolUse call. It cannot change the decision; a throwing observer is ignored. */
  onGuardDecision?: (event: {
    toolUseId: string;
    tool: string;
    decision: "allow" | "ask" | "deny";
    reason: string;
  }) => void;
  /** A tool call was denied by the guard hook or by canUseTool (owner / ask limit): its tool_use_id. For run metrics. */
  onDeny?: (toolUseId: string) => void;
}

/** Reason of a denial by the abort fence. */
export const RUN_STOPPED_REASON = "The owner stopped this run; no new tool may start.";

/** Short one-line description of a tool call for the approval message. */
function summarize(tool: string, input: Record<string, unknown>): string {
  const main = input.command ?? input.file_path ?? input.path ?? JSON.stringify(input);
  const text = String(main).replace(/\s+/g, " ");
  return `${tool}: ${clip(text, SUMMARY_MAX)}`;
}

/**
 * Permission layer of a run with a gateway (spike findings applied):
 * - PreToolUse hook = hard deny, and forces `ask` so even SDK-auto-allowed read-only Bash goes through policy.
 * - canUseTool = ask the owner in Discord (AskUserQuestion, which also carries the plan approval, and risky tools).
 * Never use `allowedTools`: it would bypass canUseTool.
 */
export function buildToolPermissions(p: ToolPermissionInput): {
  canUseTool: CanUseTool;
  hooks: HookCallbackMatcher[];
  /** Post(Failure) hooks of the Agent tool: they free a slot of the parallel subagent cap. */
  postHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Guard decision per tool_use_id (allow/ask/auto/bypass), read by the tool hooks to complete the `tool.done` line. */
  decisions: Map<string, LoggedDecision>;
} {
  const log = logger.child({ module: "tool-permissions" });
  const decisions = new Map<string, LoggedDecision>();
  const askLimit = p.askLimit ?? newAskLimit(0);

  // Subagents in flight of THIS run: one per permission layer, so it resets per run.
  const limit = newSubagentLimit(p.maxSubagents ?? 0);
  const hooks: HookCallbackMatcher[] = [{ hooks: [guardHook(p, decisions, log, limit)] }];

  const decide: CanUseTool = async (tool, rawInput, opts) => {
    // Run stopped/timed out/shut down while waiting: drop the open request (buttons + timer).
    opts?.signal?.addEventListener("abort", () => p.gateway?.cancelTurn(p.turnId), {
      once: true,
    });
    const input = rawInput as Record<string, unknown>;
    // Abort fence: a stopped run starts nothing new (before any approval is requested).
    if (p.runSignal?.aborted) return { behavior: "deny", message: RUN_STOPPED_REASON };
    try {
      if (tool === ASK_USER_QUESTION_TOOL_NAME && p.askRelay) {
        if (askLimit.calls >= askLimit.max)
          return { behavior: "deny", message: askLimitDenial(askLimit.max) };
        askLimit.calls++;
        const questions = (input.questions ?? []) as AskQuestion[];
        const answers = await p.askRelay(questions);
        if (!answers) {
          p.onAskTimeout?.(questions);
          return { behavior: "deny", message: "Nobody answered in time. Stop here." };
        }
        return { behavior: "allow", updatedInput: { ...input, answers } };
      }
      if (tool === ASK_USER_QUESTION_TOOL_NAME && !p.gateway) {
        return { behavior: "deny", message: "Not available in this mode." };
      }
      const gateway = p.gateway!;
      if (tool === ASK_USER_QUESTION_TOOL_NAME) {
        // At most the role's `limits.maxAsk` calls per run, enforced here (not only in the prompt): later ones never reach the owner.
        if (askLimit.calls >= askLimit.max)
          return { behavior: "deny", message: askLimitDenial(askLimit.max) };
        askLimit.calls++;
        const questions = (input.questions ?? []) as AskQuestion[];
        const answers: Record<string, string> = {};
        for (const q of questions) {
          const label = await gateway.askChoice({
            turnId: p.turnId,
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
      // The owner may take up to `timeoutMs` (default 600_000 ms, `discord-approval.ts`) to answer. That is below the
      // watchdog's `STALE_AFTER_MS` (15 min, `config/resilience-caps.ts`) and the tool start just before is a
      // heartbeat, so this wait needs no `setWaiting`.
      const r = await p.gateway.request({
        turnId: p.turnId,
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

  // Every canUseTool deny is reported by tool_use_id (metrics tell our denials from tool failures).
  const canUseTool: CanUseTool = async (tool, rawInput, opts) => {
    let r = await decide(tool, rawInput, opts);
    // Abort fence, after the awaited approval: a "yes" that arrives while the run is being stopped must not start the tool.
    if (r?.behavior === "allow" && p.runSignal?.aborted)
      r = { behavior: "deny", message: RUN_STOPPED_REASON };
    if (r?.behavior === "deny" && opts?.toolUseID) p.onDeny?.(opts.toolUseID);
    return r;
  };

  return { canUseTool, hooks, postHooks: subagentPostHooks(limit), decisions };
}
