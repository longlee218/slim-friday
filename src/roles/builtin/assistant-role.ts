import { HANDOFF_RULES } from "../../tools/DelegateTaskTool/prompt";
import type { RoleDefinition } from "../role-types";

/** Q&A run contract: read-only answers with sources. */
const QA = `This run is read-only code Q&A on the registered repositories.
- You cannot and must not modify files or run commands.
- Git MCP tools (git_log, git_diff, ...) must always get path = the repo path (from the repo list when there is one, else the pinned/only repo); a call without path is denied.
- Cite sources as file:line. Summarize code instead of dumping it; quote only a few lines when essential.`;

/** Read-only Q&A on the registered repos. One stage, `qa`; it can hand a change over to `dev` (`recommend`). */
export const ASSISTANT_ROLE: RoleDefinition = {
  name: "assistant",
  whenToUse:
    "Questions about the code or the repos: explain, find, summarize, compare. Changes nothing and answers with file:line sources.",
  output: "answer",
  countsTowardCap: false,
  readOnly: true,
  stages: [
    {
      name: "qa",
      capabilities: ["read", "web", "skills", "subagents", "recommend"],
      gitGroups: ["read"],
      isolation: "none",
      model: "default",
      subagents: ["repo-searcher"],
      promptSections: (ctx) => [QA, ctx.handoff ? HANDOFF_RULES : ""],
    },
  ],
};
