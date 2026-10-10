import type { RoleDefinition } from "../role-types";

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
  aliases: {
    tag: "[ask]",
    strong: [],
    // Common question openers: only count on an idle thread and never beat a strong dev alias.
    weak: ["hỏi chút", "cho hỏi", "giải thích", "là gì", "tại sao", "như thế nào"],
  },
  output: "answer",
  escalation: true,
  countsTowardCap: false,
  entry: true,
  context: { ledger: true },
  repoScope: "all",
  stages: [
    {
      name: "qa",
      capabilities: ["read", "web", "skills", "subagents"],
      gitGroups: ["read"],
      isolation: "none",
      model: "haiku",
      budgetUsd: 0.5,
      escalatedBudgetUsd: 1.5,
      subagents: ["repo-searcher"],
      promptSections: (ctx) => [QA, ctx.escalation ? ESCALATE : ""],
    },
  ],
};
