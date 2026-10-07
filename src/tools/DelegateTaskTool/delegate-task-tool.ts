import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { DELEGATE_TASK_TOOL_NAME } from "./constants";
import { DESCRIPTION } from "./prompt";

/** What the Q&A agent asked to hand over: the brief for the plan stage and an optional repo name. */
export interface Proposal {
  brief: string;
  repo?: string;
}

/** Wrap text as an MCP tool result (`isError` makes the agent relay the refusal instead of retrying). */
const result = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError && { isError }),
});

/**
 * The `DelegateTask` tool (registered on the in-process `tasks` server by qa-flow). It only validates and
 * records the proposal (it writes nothing, starts no run): `check(repo)` returns a refusal text, or
 * undefined when a code task may start; `onPropose` receives the proposal, at most once per tool
 * instance (= per Q&A run).
 */
export function createDelegateTaskTool(h: {
  check: (repo?: string) => string | undefined;
  onPropose: (p: Proposal) => void;
}) {
  /** True once a proposal was accepted: a second call in the same run is refused. */
  let proposed = false;
  return tool(
    DELEGATE_TASK_TOOL_NAME,
    DESCRIPTION,
    {
      // Single role on purpose: dev = plan stage then exec stage. Any other value fails the schema.
      role: z.enum(["dev"]),
      brief: z.string().min(20).max(4000),
      repo: z.string().min(1).max(100).optional(),
    },
    async ({ brief, repo }) => {
      if (proposed) return result("Already delegated in this run. End your turn now.", true);
      const refusal = h.check(repo);
      if (refusal) return result(`Cannot delegate: ${refusal}`, true);
      proposed = true;
      h.onPropose({ brief, repo });
      return result("Proposal recorded. The plan stage starts after this turn. End your turn now.");
    },
    // Keep the routing tool in the initial prompt even if ToolSearch ever reaches Q&A (MCP tools are
    // deferred otherwise). A no-op today: Q&A has no ToolSearch, so tool search is off.
    { alwaysLoad: true },
  );
}
