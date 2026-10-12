import type { RoleDefinition } from "../role-types";

/** Owner questions per run: the assistant has no ask tool today, so this only fills the role contract. */
const MAX_ASK = 6;
/** Budget (USD) of an answer run on the cheap tier, and of its escalated re-run. Wired into the role below. */
const BUDGET_USD = 1.0;
const ESCALATED_BUDGET_USD = 2.5;

/**
 * Auto-compact window of the assistant: the top of the range P3.0 saw accepted (100k-1M), so the
 * SDK threshold stays at its own default (min(window, model window) - reserve): effectively OFF until the
 * retest of Q12 shows the setting fires. Lower it with COMPACT_WINDOW_ASSISTANT.
 */
export const QA_AUTO_COMPACT_WINDOW = 1_000_000;

/** Run contract of the generalist: answers with sources; the tools it has come from role data, not from this text. */
const QA = `This run is general help, answered now: answer, research, look up, summarize, compare or advise on the registered repositories and on anything else the owner asks.
- A greeting or small talk gets a short friendly reply; do not ask which code to look at.
- Use only the tools listed for this run. You cannot and must not modify files or run commands.
- Git MCP tools (git_log, git_diff, ...) must always get path = the repo path (from the repo list when there is one, else the pinned/only repo); a call without path is denied.
- Answer first. When you cite code, give file:line; summarize code instead of dumping it, quote a few lines only when essential.
- If you are unsure or find nothing, say so; never guess.
- A multi-step job that changes files or needs an approved plan is a [dev] task: say so in one line.`;

/** Escalation offer (answer run on the cheap tier only; the app parses the line, see orchestrator/outputs/answer-output.ts). */
const ESCALATE = `- If you cannot answer well (deep design, many files, subtle reasoning), end the reply with ONE last line exactly \`ESCALATE: sonnet\` (or \`ESCALATE: opus\` for architecture-level questions); the app then escalates to that model (Opus needs the owner's OK). Otherwise never write that line.`;

/** The generalist: short foreground answers, escalation to a stronger model when the cheap one cannot answer. A long job is the specialist's. */
export const ASSISTANT_ROLE: RoleDefinition = {
  name: "assistant",
  whenToUse:
    "General help answered now: explain, research, look up, summarize, compare, advise, draft; the registered repos or anything else. Changes nothing. Not for: a multi-step job that changes files or needs a plan.",
  tag: "[ask]",
  background: false,
  escalation: true,
  entry: true,
  skills: "none", // the generalist: no publisher skills (widening is a one-word edit)
  limits: { maxAsk: MAX_ASK },
  context: { ledger: true },
  repoScope: "all",
  capabilities: ["read", "web", "skills", "mcp"],
  gitGroups: ["read"],
  permissionMode: "auto",
  model: "haiku",
  budgetUsd: BUDGET_USD,
  escalatedBudgetUsd: ESCALATED_BUDGET_USD,
  autoCompactWindow: QA_AUTO_COMPACT_WINDOW,
  promptSections: (ctx) => [QA, ctx.escalation ? ESCALATE : ""],
};
