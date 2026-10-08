import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { repoMemoryFile } from "../src/memory/repo-memory";
import { createTaskHandler } from "../src/tasks/handle-task";
import {
  AGENT_TOOL_NAME,
  BASH_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GREP_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { SUBAGENT_NAMES } from "../src/tools/tool-catalog";
import { addRepo, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

/** Run one Q&A message and return the SDK options the handler built. */
async function qaOptions(setup?: (env: ReturnType<typeof makeEnv>) => void) {
  const env = makeEnv();
  setup?.(env);
  let opts: any;
  const queryFn = (a: any) => {
    opts = a.options;
    return (async function* () {
      yield resultMsg();
    })();
  };
  await createTaskHandler({ db: env.db, config: env.config, queryFn: queryFn as never })({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t1",
    text: "where is x?",
  });
  return { env, opts };
}

test("Q&A reads only the registered repos: outside paths, home dotfiles and other repos are denied", async () => {
  const { env, opts } = await qaOptions();
  const repo = realpathSync(env.repo);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  expect((await can(READ_TOOL_NAME, { file_path: join(repo, "a.txt") }, {})).behavior).toBe(
    "allow",
  );
  expect((await can(READ_TOOL_NAME, { file_path: "/etc/hosts" }, {})).behavior).toBe("deny");
  expect((await can(GREP_TOOL_NAME, { pattern: "x", path: "/Users" }, {})).behavior).toBe("deny");
  // Web + skills are allowed in Q&A; writes and Bash are not even offered (and denied if asked).
  expect((await can(WEB_FETCH_TOOL_NAME, { url: "https://example.com" }, {})).behavior).toBe(
    "allow",
  );
  expect((await can(SKILL_TOOL_NAME, { skill: "x" }, {})).behavior).toBe("allow");
  expect((await can(BASH_TOOL_NAME, { command: "ls" }, {})).behavior).toBe("deny");
  expect(
    (await can(WRITE_TOOL_NAME, { file_path: join(repo, "z"), content: "" }, {})).behavior,
  ).toBe("deny");
  // No gateway in Q&A: plan/question tools are unavailable.
  expect((await can(EXIT_PLAN_MODE_TOOL_NAME, { plan: "x" }, {})).behavior).toBe("deny");
});

test("Q&A git MCP: reads on registered repos only, never writes", async () => {
  const { env, opts } = await qaOptions();
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  const repo = realpathSync(env.repo);
  expect((await can(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.LOG), { path: repo }, {})).behavior).toBe(
    "allow",
  );
  expect(
    (await can(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.LOG), { path: "/Users" }, {})).behavior,
  ).toBe("deny");
  expect(
    (await can(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.COMMIT), { path: repo, message: "x" }, {}))
      .behavior,
  ).toBe("deny");
  expect(
    (await can(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.CHECKOUT), { path: repo, target: "x" }, {}))
      .behavior,
  ).toBe("deny");
});

test("Agent tool: only configured subagents; general-purpose (Bash/Write capable) is denied", () => {
  const ctx = { writePaths: [], allowedSubagents: SUBAGENT_NAMES };
  const d = (input: Record<string, unknown>, tool = AGENT_TOOL_NAME) =>
    checkToolCall(tool, input, ctx).decision;
  expect(d({ subagent_type: "repo-searcher", prompt: "p" })).toBe("allow");
  expect(d({ subagent_type: "repo-searcher", prompt: "p" }, LEGACY_AGENT_TOOL_NAME)).toBe("allow");
  expect(d({ subagent_type: "general-purpose", prompt: "p" })).toBe("deny");
  expect(d({ prompt: "p" })).toBe("deny");
});

test("Q&A with several repos uses the neutral cwd and lists CLAUDE.md hints + memory", async () => {
  const { env, opts } = await qaOptions((e) => {
    const b = addRepo(e.home, "b"); // workspaces/main/repos/b/repo
    writeFileSync(join(b, "CLAUDE.md"), "rules");
    writeFileSync(
      repoMemoryFile(e.home, "main", "b"),
      "# b memory\n\n## 2026-10-06 t\n- uses bun\n",
    );
  });
  expect(opts.cwd).toBe(workspacePaths(env.home).workspace("main").cwd);
  const prompt = opts.systemPrompt.append as string;
  expect(prompt).toContain("CLAUDE.md first");
  expect(prompt).toContain("uses bun");
  expect(opts.skills).toEqual([]); // no repo skills here: bundled SDK skills are not listed
});
