import { expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { locationMemoryFile } from "../src/memory/location-memory";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  GREP_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { addLocation, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

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
  await createTurnHandler({ db: env.db, config: env.config, queryFn: queryFn as never })({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t1",
    text: "where is x?",
  });
  return { env, opts };
}

test("Q&A reads only the registered locations: outside paths, home dotfiles and other locations are denied", async () => {
  const { env, opts } = await qaOptions();
  const location = realpathSync(env.location);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  expect((await can(READ_TOOL_NAME, { file_path: join(location, "a.txt") }, {})).behavior).toBe(
    "allow",
  );
  expect((await can(READ_TOOL_NAME, { file_path: "/etc/hosts" }, {})).behavior).toBe("deny");
  expect((await can(GREP_TOOL_NAME, { pattern: "x", path: "/Users" }, {})).behavior).toBe("deny");
  // Web + skills are allowed in Q&A; writes are denied if asked.
  expect((await can(WEB_FETCH_TOOL_NAME, { url: "https://example.com" }, {})).behavior).toBe(
    "allow",
  );
  expect((await can(SKILL_TOOL_NAME, { skill: "x" }, {})).behavior).toBe("allow");
  // The assistant has the shell capability: Bash is offered and a plain read command is allowed.
  expect(opts.tools).toContain(BASH_TOOL_NAME);
  expect((await can(BASH_TOOL_NAME, { command: "ls" }, {})).behavior).toBe("allow");
  expect(
    (await can(WRITE_TOOL_NAME, { file_path: join(location, "z"), content: "" }, {})).behavior,
  ).toBe("deny");
  // No gateway in Q&A: the question tool is unavailable.
  expect((await can(ASK_USER_QUESTION_TOOL_NAME, { questions: [] }, {})).behavior).toBe("deny");
});

test("Q&A git MCP: reads on registered locations only, never writes", async () => {
  const { env, opts } = await qaOptions();
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  const location = realpathSync(env.location);
  expect(
    (await can(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.LOG), { path: location }, {})).behavior,
  ).toBe("allow");
  expect(
    (await can(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.LOG), { path: "/Users" }, {})).behavior,
  ).toBe("deny");
  expect(
    (await can(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.COMMIT), { path: location, message: "x" }, {}))
      .behavior,
  ).toBe("deny");
  expect(
    (await can(mcpToolName(GIT_MCP_SERVER, GIT_TOOL.CHECKOUT), { path: location, target: "x" }, {}))
      .behavior,
  ).toBe("deny");
});

test("Agent tool: allowed when the stage lists it (legacy Task name too), else the owner decides; no per-type rule", () => {
  const ctx = { writePaths: [], allowTools: [AGENT_TOOL_NAME] };
  const d = (input: Record<string, unknown>, tool = AGENT_TOOL_NAME, c = ctx) =>
    checkToolCall(tool, input, c).decision;
  expect(d({ prompt: "p" })).toBe("allow");
  expect(d({ prompt: "p" }, LEGACY_AGENT_TOOL_NAME)).toBe("allow");
  expect(d({ prompt: "p" }, AGENT_TOOL_NAME, { writePaths: [], allowTools: [] })).toBe("ask");
});

test("Q&A with several locations uses the neutral cwd and lists no CLAUDE.md hint, lists memory", async () => {
  const { env, opts } = await qaOptions((e) => {
    const b = addLocation(e.home, "b"); // workspaces/main/locations/b/location
    writeFileSync(join(b, "CLAUDE.md"), "rules");
    writeFileSync(
      locationMemoryFile(e.home, "main", "b"),
      "# b memory\n\n## 2026-10-06 t\n- uses bun\n",
    );
  });
  expect(opts.cwd).toBe(workspacePaths(env.home).workspace("main").cwd);
  const prompt = opts.systemPrompt.append as string;
  expect(prompt).not.toContain("CLAUDE.md");
  expect(prompt).not.toContain("first]");
  expect(opts.settingSources).toEqual([]);
  expect(prompt).toContain("uses bun");
  expect(opts.skills).toEqual([]); // no location skills here: bundled SDK skills are not listed
});
