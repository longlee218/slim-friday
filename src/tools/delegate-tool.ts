import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** What the Q&A agent asked to hand over: the brief for the plan stage and an optional repo name. */
export interface Proposal {
  brief: string;
  repo?: string;
}

/** Name of the in-process MCP server; the tool is then `mcp__friday__delegate` (see `DELEGATE`). */
export const DELEGATE_SERVER = "friday";

/** Usage rules the agent sees: what a good brief contains and that the turn must end after the call. */
const DESCRIPTION = [
  "Hand a code change over to the dev agent. The owner then reviews its plan before anything is written.",
  "Call it at most once per run, only when a change to the repo is needed.",
  "brief: self-contained task for an agent that has not seen this chat. Include the intent, findings with",
  "file:line, the files to change, and the acceptance criteria.",
  "repo: workspace name; omit it when the thread is pinned or only one repo fits.",
  "After a successful call, end your turn with a short note for the owner. Do not keep working.",
].join(" ");

/** Wrap text as an MCP tool result (`isError` makes the agent relay the refusal instead of retrying). */
const result = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError && { isError }),
});

/**
 * In-process MCP server with the single `delegate` tool. The tool only validates and records the proposal
 * (it writes nothing, starts no run): `check(repo)` returns a refusal text, or undefined when a code task
 * may start; `onPropose` receives the proposal, at most once per server (= per Q&A run).
 */
export function createDelegateServer(h: {
  check: (repo?: string) => string | undefined;
  onPropose: (p: Proposal) => void;
}): McpSdkServerConfigWithInstance {
  /** True once a proposal was accepted: a second call in the same run is refused. */
  let proposed = false;
  return createSdkMcpServer({
    name: DELEGATE_SERVER,
    tools: [
      tool(
        "delegate",
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
          return result(
            "Proposal recorded. The plan stage starts after this turn. End your turn now.",
          );
        },
      ),
    ],
  });
}
