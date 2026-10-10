import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { delegableRoleNames } from "../../roles/role-registry";
import { DELEGATE_TASK_TOOL_NAME } from "./constants";
import { DESCRIPTION } from "./prompt";

/** What the Q&A agent asked to hand over: the role, the brief for its first stage and an optional repo name. */
export interface Proposal {
  /** Role from the tool's enum (the registry's delegable roles). */
  role: string;
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
      // Roles the registry lets Q&A hand work to (today: dev); any other value fails the schema.
      role: z.enum(delegableRoleNames()),
      brief: z.string().min(20).max(4000),
      repo: z.string().min(1).max(100).optional(),
    },
    async ({ role, brief, repo }) => {
      if (proposed) return result("Already delegated in this run. End your turn now.", true);
      const refusal = h.check(repo);
      if (refusal) return result(`Cannot delegate: ${refusal}`, true);
      proposed = true;
      h.onPropose({ role, brief, repo });
      return result("Proposal recorded. The plan stage starts after this turn. End your turn now.");
    },
    // Keep the routing tool in the initial prompt even if ToolSearch ever reaches Q&A (MCP tools are
    // deferred otherwise). A no-op today: Q&A has no ToolSearch, so tool search is off.
    { alwaysLoad: true },
  );
}
