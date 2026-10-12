import { afterEach, expect, spyOn, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { MAX_TURNS } from "../src/config/effort-mapping";
import { guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { getStage } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { SEND_MESSAGE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv, resultMsg } from "./helpers";

/**
 * BEHAVIOR LOCK for the roles refactor: the SDK options `runAgent` passes to `query` for the three
 * stages (qa, plan, exec). Written against the pre-refactor code and kept green through it. Functions are
 * compared by presence, not identity; per-run values (cwd, env, abort controller) are asserted apart.
 */

type Kind = "qa" | "plan" | "exec";

/** Config limits are fixed so timeout and budget assertions are exact. */
const ENV = {
  MODEL: "model-qa",
  MODEL_DEV_PLAN: "model-code",
  MODEL_DEV_EXEC: "model-code",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", // real Anthropic login: exec may use auto mode
  MAX_BUDGET_USD: "3",
};

const timers: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const t of timers.splice(0)) t.mockRestore();
});

/** Run one stage with a fake `query`; returns the options it received and the run timeout delay. */
async function capture(kind: Kind) {
  const env = makeEnv(ENV);
  let options: Options | undefined;
  const queryFn = (a: { options?: Options }) =>
    (async function* () {
      options = a.options;
      yield resultMsg({ result: "ok" });
    })();
  // The run timer is the only setTimeout of a run that is not the SDK's: record its delay.
  const delays: number[] = [];
  const realSet = globalThis.setTimeout;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    if (typeof ms === "number") delays.push(ms);
    return realSet(fn, ms);
  }) as never);
  timers.push(spy);
  const base = {
    prompt: "q",
    turnId: "t1",
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: queryFn as never,
  };
  const scope = { readPaths: [env.repo], gitReadRepos: [env.repo], writePaths: [] };
  if (kind === "qa") {
    await runAgent({
      ...base,
      stage: getStage("assistant", "qa"),
      guard: guardFor("qa", scope),
    });
  } else if (kind === "plan") {
    await runAgent({
      ...base,
      stage: getStage("dev", "plan"),
      guard: guardFor("plan", scope),
      code: { threadId: "th", plan: { repos: ["repo"], onApproved: () => {} } },
    });
  } else {
    await runAgent({
      ...base,
      stage: getStage("dev", "exec"),
      guard: guardFor("exec", { ...scope, writePaths: [env.home], gitWriteRepo: env.home }),
      gitAuthor: { name: "Test Owner", email: "owner@example.com" },
      gitBaseDir: env.home,
      code: { threadId: "th", gateway: undefined },
    });
  }
  spy.mockRestore();
  if (!options) throw new Error("query was not called");
  return { o: options, env, delays };
}

/** Options without per-run values, functions as "[fn]", MCP servers by key + type (stable under snapshot). */
function normalize(o: Options, home: string) {
  const { cwd, env: _env, abortController, mcpServers, ...rest } = o;
  const json = JSON.stringify(rest, (_k, v) => (typeof v === "function" ? "[fn]" : v), 2)
    .replaceAll(home, "<home>")
    // The OS line of the prompt depends on the machine running the test.
    .replace(/- Host: [^"\\]*\./, "- Host: <os>.");
  return {
    ...JSON.parse(json),
    cwd: cwd === home ? "<home>" : cwd,
    mcpServers: Object.fromEntries(
      // The github server depends on the local `gh` login: only its presence rule is pinned elsewhere.
      Object.entries(mcpServers ?? {})
        .filter(([k]) => k !== "github")
        .map(([k, v]) => [k, (v as { type?: string }).type ?? "stdio"]),
    ),
  };
}

const KINDS: Kind[] = ["qa", "plan", "exec"];

for (const kind of KINDS) {
  test(`options lock: ${kind} options snapshot`, async () => {
    const { o, env } = await capture(kind);
    expect(normalize(o, env.home)).toMatchSnapshot();
  });
}

test("options lock: tools, mcp servers, permission mode per stage", async () => {
  const qa = await capture("qa");
  const plan = await capture("plan");
  const exec = await capture("exec");
  // Built-in tools: Q&A is read + web; both code stages share the code set.
  expect(qa.o.tools).toContain("WebFetch");
  expect(exec.o.tools).toEqual(plan.o.tools);
  expect(qa.o.tools).toContain(SEND_MESSAGE_TOOL_NAME); // every stage gets Agent + SendMessage
  expect(plan.o.tools).toContain("Write");
  expect(qa.o.tools).not.toContain("Write");
  // MCP: git always; no in-process app server in any stage (no handoff tool).
  for (const r of [qa, plan, exec]) {
    expect(Object.keys(r.o.mcpServers ?? {})).toContain(GIT_MCP_SERVER);
    expect(Object.keys(r.o.mcpServers ?? {})).not.toContain("tasks");
  }
  // plan mode in the plan stage, auto mode (classifier) in exec.
  expect(plan.o.permissionMode).toBe("plan");
  expect(exec.o.permissionMode).toBe("bypassPermissions");
  expect(exec.o.allowDangerouslySkipPermissions).toBe(true);
  expect(plan.o.allowDangerouslySkipPermissions).toBeUndefined();
  expect(qa.o.permissionMode).toBe("auto");
  // Never any filesystem settings; strict MCP config.
  for (const r of [qa, plan, exec]) {
    expect(r.o.settingSources).toEqual([]);
    expect(r.o.strictMcpConfig).toBe(true);
    expect(typeof r.o.canUseTool).toBe("function");
  }
  // No app-defined subagents: the SDK's built-in one is what the Agent tool starts.
  for (const r of [qa, plan, exec]) expect("agents" in r.o).toBe(false);
});

test("options lock: model and limits per stage, no run timeout", async () => {
  const qa = await capture("qa");
  const plan = await capture("plan");
  const exec = await capture("exec");
  expect(qa.o.model).toBe("model-qa");
  expect(plan.o.model).toBe("model-code");
  expect(exec.o.model).toBe("model-code");
  for (const r of [qa, plan, exec]) expect(r.o.maxTurns).toBe(MAX_TURNS);
  // Per-stage budget (qa 1, plan 1.5, exec 3) capped by MAX_BUDGET_USD=3.
  expect(qa.o.maxBudgetUsd).toBe(1);
  expect(plan.o.maxBudgetUsd).toBe(1.5);
  expect(exec.o.maxBudgetUsd).toBe(3);
  // No run timeout: no timer is armed for the run (owner decision).
  for (const r of [qa, plan, exec]) expect(r.delays).toEqual([]);
});

test("options lock: per-run values", async () => {
  const exec = await capture("exec");
  expect(exec.o.cwd).toBe(exec.env.home);
  expect(exec.o.abortController).toBeInstanceOf(AbortController);
  expect(typeof exec.o.env).toBe("object");
});
