import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent/run-agent";
import { sdkEnv } from "../src/agent/sdk-env";
import {
  AGENT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { fakeQuery, initMsg, makeEnv, resultMsg } from "./helpers";

/** Run the agent against an injected query. */
function go(
  env: ReturnType<typeof makeEnv>,
  queryFn: ReturnType<typeof fakeQuery>,
  ac = new AbortController(),
) {
  return runAgent({
    prompt: "q",
    taskId: "T",
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: ac,
    queryFn,
  });
}

describe("run-agent stream handling", () => {
  test("success result: text, session, usage, run row", async () => {
    const env = makeEnv();
    const r = await go(env, fakeQuery([initMsg, resultMsg()]));
    expect(r.outcome).toBe("success");
    expect(r.text).toBe("alpha is in a.txt:1");
    expect(r.sessionId).toBe("sess-1");
    expect(r.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      turns: 2,
    });
    const row = env.db
      .query<{ outcome: string; cache_read_tokens: number }, []>("SELECT * FROM runs")
      .get();
    expect(row?.outcome).toBe("success");
    expect(row?.cache_read_tokens).toBe(30);
  });

  test("error_max_turns: throw AFTER result keeps outcome", async () => {
    const env = makeEnv();
    const m = resultMsg({
      subtype: "error_max_turns",
      is_error: true,
      terminal_reason: "max_turns",
      errors: ["Reached maximum number of turns (1)"],
      result: undefined,
    });
    const r = await go(env, fakeQuery([initMsg, m], new Error("Reached maximum number of turns")));
    expect(r.outcome).toBe("max_turns");
    expect(r.text).toContain("maximum number of turns");
  });

  test("error_max_budget_usd maps to max_budget", async () => {
    const env = makeEnv();
    const m = resultMsg({ subtype: "error_max_budget_usd", is_error: true, errors: ["budget"] });
    expect((await go(env, fakeQuery([m], new Error("x")))).outcome).toBe("max_budget");
  });

  test("abort throw without result -> aborted, run row still written", async () => {
    const env = makeEnv();
    const ac = new AbortController();
    ac.abort();
    const r = await go(
      env,
      fakeQuery([initMsg], new Error("Claude Code process aborted by user")),
      ac,
    );
    expect(r.outcome).toBe("aborted");
    expect(env.db.query<{ outcome: string }, []>("SELECT outcome FROM runs").get()?.outcome).toBe(
      "aborted",
    );
  });

  test("timeout aborts a hanging query and reports timeout", async () => {
    const env = makeEnv({ TIMEOUT_MS: "100" });
    const hang = (a: { options?: { abortController?: AbortController } }) =>
      (async function* () {
        await new Promise((_, rej) =>
          a.options!.abortController!.signal.addEventListener("abort", () =>
            rej(new Error("aborted")),
          ),
        );
        yield initMsg;
      })();
    const r = await go(env, hang as never);
    expect(r.outcome).toBe("timeout");
  });

  test("sdk options: read-only tools, project settings, abort controller", async () => {
    const env = makeEnv();
    let seen: any;
    await go(env, ((a: any) => {
      seen = a.options;
      return fakeQuery([resultMsg()])(a);
    }) as never);
    expect(seen.tools).toEqual([
      READ_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      WEB_SEARCH_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      SKILL_TOOL_NAME,
      AGENT_TOOL_NAME,
    ]);
    expect(Object.keys(seen.agents)).toEqual(["repo-searcher"]); // subagents have explicit tools
    expect(seen.mcpServers.git.args[0]).toContain("git-mcp-server"); // pinned package, no npx
    expect(seen.mcpServers.git.env.GIT_AUTHOR_EMAIL).toBeUndefined(); // Q&A never commits
    expect(seen.mcpServers.github).toBeUndefined(); // GitHub MCP only in code tasks
    expect(seen.allowedTools).toBeUndefined();
    expect(seen.settingSources).toEqual([]);
    expect(seen.abortController).toBeDefined();
  });

  test("child env is an allowlist: no placeholder token, API key, Discord or other secrets", async () => {
    const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "REPLACE_ME" });
    const src = {
      PATH: "/bin",
      HOME: "/h",
      ANTHROPIC_API_KEY: "x",
      DISCORD_TOKEN: "y",
      GITHUB_TOKEN: "z",
      AWS_SECRET_ACCESS_KEY: "w",
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_CODE_OAUTH_TOKEN: "REPLACE_ME",
    };
    expect(sdkEnv(env.config, src)).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/c" });
  });

  test("real oauth token is passed through", () => {
    const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-" + "oat01-realtokenvalue1234" });
    expect(sdkEnv(env.config, { PATH: "/bin" }).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      env.config.oauthToken,
    );
  });
});
