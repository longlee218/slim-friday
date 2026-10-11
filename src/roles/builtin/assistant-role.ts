import type { RoleDefinition } from "../role-types";

/**
 * Auto-compact window of the assistant `qa` stage: the top of the range P3.0 saw accepted (100k-1M), so the
 * SDK threshold stays at its own default (min(window, model window) - reserve): effectively OFF until the
 * retest of Q12 shows the setting fires. Lower it per stage with COMPACT_WINDOW_ASSISTANT_QA.
 */
export const QA_AUTO_COMPACT_WINDOW = 1_000_000;

/** Q&A run contract: read-only answers with sources. */
const QA = `This run is read-only code Q&A on the registered repositories.
- You cannot and must not modify files or run commands.
- Git MCP tools (git_log, git_diff, ...) must always get path = the repo path (from the repo list when there is one, else the pinned/only repo); a call without path is denied.
- Cite sources as file:line. Summarize code instead of dumping it; quote only a few lines when essential.`;

/** Escalation offer (Q&A run on the cheap tier only; the app parses the line, see orchestrator/outputs/answer-output.ts). */
const ESCALATE = `- If you cannot answer well (deep design, many files, subtle reasoning), end the reply with ONE last line exactly \`ESCALATE: sonnet\` (or \`ESCALATE: opus\` for architecture-level questions); the app then escalates to that model (Opus needs the owner's OK). Otherwise never write that line.`;

/** Read-only Q&A on the registered repos. One stage, `qa`; no handoff tool: change requests are routed to `dev` by the intent layer. */
export const ASSISTANT_ROLE: RoleDefinition = {
  name: "assistant",
  whenToUse:
    "Questions about the code or the repos: explain, find, summarize, compare. Changes nothing and answers with file:line sources.",
  tag: "[ask]",
  output: "answer",
  escalation: true,
  countsTowardCap: false,
  entry: true,
  context: { ledger: true },
  repoScope: "all",
  stages: [
    {
      name: "qa",
      capabilities: ["read", "web", "skills", "subagents", "mcp"],
      gitGroups: ["read"],
      permissionMode: "auto",
      isolation: "none",
      model: "haiku",
      budgetUsd: 0.5,
      autoCompactWindow: QA_AUTO_COMPACT_WINDOW,
      escalatedBudgetUsd: 1.5,
      subagents: ["repo-searcher"],
      promptSections: (ctx) => [QA, ctx.escalation ? ESCALATE : ""],
    },
  ],
};
