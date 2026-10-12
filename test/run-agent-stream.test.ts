import { describe, expect, test } from "bun:test";
import { captureLogs } from "../src/observability/logger";
import { getStage } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { sdkEnv } from "../src/runtime/sdk-env";

/** Vars the app always sets for the subagent limits (never taken from the caller env). */
const SUBAGENT_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
};

import {
  AGENT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  READ_MCP_RESOURCE_DIR_TOOL_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
  READ_TOOL_NAME,
  REFRESH_MCP_TOOLS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
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
    turnId: "T",
    stage: getStage("assistant", "qa"),
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
      SEND_MESSAGE_TOOL_NAME,
      LIST_MCP_RESOURCES_TOOL_NAME,
      READ_MCP_RESOURCE_TOOL_NAME,
      READ_MCP_RESOURCE_DIR_TOOL_NAME,
      REFRESH_MCP_TOOLS_TOOL_NAME,
    ]);
    expect("agents" in seen).toBe(false); // no app-defined subagents
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
    expect(sdkEnv(env.config, src)).toEqual({
      PATH: "/bin",
      HOME: "/h",
      CLAUDE_CONFIG_DIR: "/c",
      ...SUBAGENT_ENV,
    });
  });

  test("real oauth token is passed through", () => {
    const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-" + "oat01-realtokenvalue1234" });
    expect(sdkEnv(env.config, { PATH: "/bin" }).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      env.config.oauthToken,
    );
  });
});

/** Assistant message of one model call (usage as the SDK sends it). */
const asstMsg = (id: string, usage: object, extra: Record<string, unknown> = {}) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, model: "claude-haiku-4-5", usage, content: [{ type: "text", text: "x" }] },
    ...extra,
  }) as never;

test("llm.turn: one line per distinct message.id, subagent turn flagged, parts sum to the result usage", async () => {
  const env = makeEnv();
  const cap = captureLogs();
  const u = (i: number, cr: number, cc: number) => ({
    input_tokens: i,
    cache_read_input_tokens: cr,
    cache_creation_input_tokens: cc,
    output_tokens: 3,
  });
  const msgs = [
    initMsg,
    asstMsg("m1", u(2, 0, 8)),
    asstMsg("m1", u(2, 0, 8)), // parallel tool_use of the same call: same id, same usage
    asstMsg("m2", u(1, 10, 0), { parent_tool_use_id: "toolu_1", agent_id: "agent-1" }),
    asstMsg("m3", u(7, 30, 32)),
    resultMsg({
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 40,
      },
    }),
  ];
  await go(env, fakeQuery(msgs));
  cap.stop();
  const turns = cap.lines.filter((l) => l.event === "llm.turn");
  expect(turns.map((t) => [t.turn, t.in, t.ctxTotal, t.sub, t.agentId])).toEqual([
    [1, 10, 10, undefined, undefined],
    [2, 11, 21, true, "agent-1"],
    [3, 69, 90, undefined, undefined],
  ]);
  // input + cacheRead + cacheCreate over distinct ids == the result's totals
  expect(turns.reduce((a, t) => a + Number(t.in), 0)).toBe(10 + 40 + 40);
});

test("run.finished keeps usage, adds modelUsage per model and the total cost", async () => {
  const env = makeEnv();
  const cap = captureLogs();
  await go(
    env,
    fakeQuery([
      initMsg,
      resultMsg({
        modelUsage: {
          "claude-sonnet-5-5": {
            inputTokens: 5,
            outputTokens: 6,
            cacheReadInputTokens: 7,
            cacheCreationInputTokens: 8,
            costUSD: 0.001,
          },
          "claude-haiku-5-5": { inputTokens: 1, costUSD: 0.0002 },
        },
      }),
    ]),
  );
  cap.stop();
  const fin = cap.lines.find((l) => l.event === "run.finished") as any;
  expect(fin.inputTokens).toBe(10);
  expect(fin.costUsd).toBeCloseTo(0.0012);
  expect(fin.modelUsage["claude-sonnet-5-5"]).toEqual({
    inputTokens: 5,
    outputTokens: 6,
    cacheReadTokens: 7,
    cacheCreationTokens: 8,
    costUsd: 0.001,
  });
  expect(fin.modelUsage["claude-haiku-5-5"].inputTokens).toBe(1);
});

test("runs.stage_idx: written when the stage index is given, NULL for a non-stage run", async () => {
  const env = makeEnv();
  await go(env, fakeQuery([initMsg, resultMsg()]));
  await runAgent({
    prompt: "q",
    turnId: "T",
    stage: getStage("assistant", "qa"),
    stageIdx: 1,
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: fakeQuery([initMsg, resultMsg()]),
  });
  const rows = env.db
    .query<{ stage_idx: number | null }, []>("SELECT stage_idx FROM runs ORDER BY rowid")
    .all();
  expect(rows.map((r) => r.stage_idx)).toEqual([null, 1]);
});
