import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall, type GuardrailContext, guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";

// Shared setup of the subagent scope tests: a real temp clone, the main agent's exec guard, and calls "made by" a
// subagent type (the recorded Q17 fixture of a subagent call: `agent_id` + `agent_type`, with the type swapped).

const dirs: string[] = [];
/** A real temp dir (removed at process exit: the module is shared by several test files). */
export const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

export const GIT_DIR = ".git";
export const CLONE = tmp("a2-clone-");
export const PLANS = tmp("a2-plans-");
mkdirSync(join(CLONE, GIT_DIR));
/** Full name of a git MCP tool. */
export const git = (t: string) => mcpToolName(GIT_MCP_SERVER, t);
export const FIX = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "sdk-hooks", "pre-tool-use-subagent-builtin-read.json"),
    "utf8",
  ),
);

/** Exec guard of a run whose repo has a test command; same ctx the stage builds (write paths: clone + plans dir). */
export const base = guardFor("exec", {
  cwd: CLONE,
  writePaths: [CLONE, PLANS],
  readPaths: [CLONE, PLANS],
  gitWriteRepo: CLONE,
  allowedCommands: ["bun test"],
});
/** A call made by a subagent of `type`: agent_id + agent_type as the SDK hook delivers them. */
export const as = (type: string): GuardrailContext => ({
  ...base,
  agent: { id: FIX.agent_id, type },
});
export const decide = (type: string, tool: string, input: Record<string, unknown>) =>
  checkToolCall(tool, input, as(type));
