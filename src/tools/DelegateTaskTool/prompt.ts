import { DELEGATE_TASK_MCP_TOOL_NAME } from "./constants";

/** Usage rules the agent sees on the tool: what a good brief contains and that the turn must end after the call. */
export const DESCRIPTION = [
  "Hand a code change over to the dev agent. The owner then reviews its plan before anything is written.",
  "Call it at most once per run, only when a change to the repo is needed.",
  "brief: self-contained task for an agent that has not seen this chat. Include the intent, findings with",
  "file:line, the files to change, and the acceptance criteria.",
  "repo: repo name from the list; omit it when the thread is pinned or only one repo fits.",
  "After a successful call, end your turn with a short note for the owner. Do not keep working.",
].join(" ");

/**
 * Q&A hand-over rules, injected into the Q&A system prompt (position matters: the golden set was tuned on it).
 * Usage detail (once per run, brief content, end turn) is in `DESCRIPTION`.
 */
export const HANDOFF_RULES = `- You cannot edit files, so any request to change the repo ("fix X", "add", "remove", "rename", "update", "change", "write a test", "sửa đi", "thêm", "làm đi") is completed ONLY by calling ${DELEGATE_TASK_MCP_TOOL_NAME} with role "dev" (after reading what you need). Do not write the change or the fix in your reply, in text or in thinking: put it in the brief. Then end the turn with one short visible line for the owner.
- A pure question: answer only; never call ${DELEGATE_TASK_MCP_TOOL_NAME}.
- Unprompted, you may propose one change per run, only for a clear bug worth fixing; answer the question first.
- Never re-propose a change the owner rejected in this thread (listed under "Rejected code-task plans in this thread:" when any).`;
