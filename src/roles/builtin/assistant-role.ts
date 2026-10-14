import type { RoleDefinition } from "../role-types";

/** Owner questions per run: the assistant has no ask tool today, so this only fills the role contract. */
const MAX_ASK = 6;
/** Budget (USD) of an answer run on the cheap tier, and of its escalated re-run. Wired into the role below. */
const BUDGET_USD = 1.0;
const ESCALATED_BUDGET_USD = 2.5;

/** Run contract of the generalist: answers with sources; the tools it has come from role data, not from this text. */
const QA = `This run is general help, answered now: answer, research, look up, summarize, compare or advise on the registered repositories and on anything else the owner asks.
- A greeting or small talk gets a short friendly reply; do not ask which code to look at.
- Use only the tools listed for this run. You may run read-only shell commands to look things up (ls, cat, grep, git log, ...); never change files or system state.
- Git MCP tools (git_log, git_diff, ...) must always get path = the repo path (from the repo list when there is one, else the pinned/only repo); a call without path is denied.
- Answer first. When you cite code, give file:line; summarize code instead of dumping it, quote a few lines only when essential.
- If you are unsure or find nothing, say so; never guess.
- A multi-step job that changes files or needs an approved plan is a [dev] task: say so in one line.`;

/** Privacy and outward-action care of a role that talks to people (moved here from the owner's SOUL/AGENTS files). */
const CARE = `Care with the owner's things:
- Private things stay private. Use memory to inform an answer, but share its details only in a private/direct chat and never quote it in a group chat.
- In a group chat you are a participant, not the owner's voice or proxy.
- Ask the owner before acting outside their own space (email, posts, anything public); read-only lookups need no ask.`;

/** Escalation offer (the app parses the line, see orchestrator/outputs/answer-output.ts); it lists only the tiers the app can really run. */
const ESCALATE_LEAD =
  "- If you cannot answer well (deep design, many files, subtle reasoning), end the reply with ONE last line exactly";
const ESCALATE_RULES = {
  sonnet: "`ESCALATE: sonnet`; the app then re-runs it on that model",
  opus: "`ESCALATE: opus` for architecture-level questions; the app then escalates to that model (Opus needs the owner's OK)",
} as const;
const escalateRule = (tiers: ("sonnet" | "opus")[]): string =>
  `${ESCALATE_LEAD} ${tiers.map((t) => ESCALATE_RULES[t]).join(", or ")}. Otherwise never write that line.`;

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
  // "shell": Bash runs under the deny-list only (bash-policy.ts), it never asks; the "no changes" rule is the prompt's, not enforced.
  sideEffects: "none",
  approvalRequired: false,
  capabilityVersion: "1",
  capabilities: ["read", "web", "skills", "mcp", "shell"],
  gitGroups: ["read"],
  permissionMode: "auto",
  model: "haiku",
  // Owner decision (P11): the intent class picks the tier up front; no class = the role model. Unsure/failed Haiku runs fall back to Sonnet once (answer-output.ts).
  classTiers: { mechanical: "haiku", standard: "sonnet", design: "sonnet" },
  budgetUsd: BUDGET_USD,
  escalatedBudgetUsd: ESCALATED_BUDGET_USD,
  promptSections: (ctx) => [
    QA,
    CARE,
    ctx.escalationTiers?.length ? escalateRule(ctx.escalationTiers) : "",
  ],
};
