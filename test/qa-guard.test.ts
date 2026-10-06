import { expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { createTaskHandler } from "../src/tasks/handle-task";
import { SUBAGENT_NAMES } from "../src/tools/tool-catalog";
import { addWorkspace, makeEnv, resultMsg } from "./helpers";

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
  expect((await can("Read", { file_path: join(repo, "a.txt") }, {})).behavior).toBe("allow");
  expect((await can("Read", { file_path: "/etc/hosts" }, {})).behavior).toBe("deny");
  expect((await can("Grep", { pattern: "x", path: "/Users" }, {})).behavior).toBe("deny");
  // Web + skills are allowed in Q&A; writes and Bash are not even offered (and denied if asked).
  expect((await can("WebFetch", { url: "https://example.com" }, {})).behavior).toBe("allow");
  expect((await can("Skill", { skill: "x" }, {})).behavior).toBe("allow");
  expect((await can("Bash", { command: "ls" }, {})).behavior).toBe("deny");
  expect((await can("Write", { file_path: join(repo, "z"), content: "" }, {})).behavior).toBe(
    "deny",
  );
  // No gateway in Q&A: plan/question tools are unavailable.
  expect((await can("ExitPlanMode", { plan: "x" }, {})).behavior).toBe("deny");
});

test("Q&A git MCP: reads on registered repos only, never writes", async () => {
  const { env, opts } = await qaOptions();
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  const repo = realpathSync(env.repo);
  expect((await can("mcp__git__git_log", { path: repo }, {})).behavior).toBe("allow");
  expect((await can("mcp__git__git_log", { path: "/Users" }, {})).behavior).toBe("deny");
  expect((await can("mcp__git__git_commit", { path: repo, message: "x" }, {})).behavior).toBe(
    "deny",
  );
  expect((await can("mcp__git__git_checkout", { path: repo, target: "x" }, {})).behavior).toBe(
    "deny",
  );
});

test("Agent tool: only configured subagents; general-purpose (Bash/Write capable) is denied", () => {
  const ctx = { writePaths: [], allowedSubagents: SUBAGENT_NAMES };
  const d = (input: Record<string, unknown>, tool = "Agent") =>
    checkToolCall(tool, input, ctx).decision;
  expect(d({ subagent_type: "repo-searcher", prompt: "p" })).toBe("allow");
  expect(d({ subagent_type: "repo-searcher", prompt: "p" }, "Task")).toBe("allow");
  expect(d({ subagent_type: "general-purpose", prompt: "p" })).toBe("deny");
  expect(d({ prompt: "p" })).toBe("deny");
});

test("Q&A with several repos uses the neutral cwd and lists CLAUDE.md hints + memory", async () => {
  const { env, opts } = await qaOptions((e) => {
    const b = addWorkspace(e.home, "b"); // workspaces/b/repo
    writeFileSync(join(b, "CLAUDE.md"), "rules");
    writeFileSync(
      workspacePaths(e.home).workspace("b").memory,
      "# b memory\n\n## 2026-10-06 t\n- uses bun\n",
    );
  });
  expect(opts.cwd).toBe(join(env.home, "cwd"));
  const prompt = opts.systemPrompt.append as string;
  expect(prompt).toContain("CLAUDE.md first");
  expect(prompt).toContain("uses bun");
  expect(opts.skills).toEqual([]); // no repo skills here: bundled SDK skills are not listed
});
