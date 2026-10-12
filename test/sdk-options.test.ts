import { afterEach, expect, spyOn, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { MAX_TURNS } from "../src/config/effort-mapping";
import { guardFor } from "../src/guardrails/check-tool-call";
import { GIT_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { SEND_MESSAGE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv, resultMsg } from "./helpers";

/**
 * BEHAVIOR LOCK: the SDK options `runAgent` passes to `query` for the two roles (assistant, dev). Functions are
 * compared by presence, not identity; per-run values (cwd, env, abort controller) are asserted apart.
 */

type Kind = "qa" | "dev";

/** Config limits are fixed so timeout and budget assertions are exact. */
const ENV = {
  MODEL_ASSISTANT: "model-qa",
  MODEL_DEV: "model-code",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", // real Anthropic login: the assistant may use auto mode
  MAX_BUDGET_USD: "3",
};

const timers: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const t of timers.splice(0)) t.mockRestore();
});

/** Run one role with a fake `query`; returns the options it received and the run timeout delay. */
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
      role: getRole("assistant"),
      guard: guardFor(getRole("assistant"), scope),
    });
  } else {
    await runAgent({
      ...base,
      role: getRole("dev"),
      guard: guardFor(getRole("dev"), { ...scope, writePaths: [env.home] }),
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
      Object.entries(mcpServers ?? {}).map(([k, v]) => [
        k,
        (v as { type?: string }).type ?? "stdio",
      ]),
    ),
  };
}

const KINDS: Kind[] = ["qa", "dev"];

for (const kind of KINDS) {
  test(`options lock: ${kind} options snapshot`, async () => {
    const { o, env } = await capture(kind);
    expect(normalize(o, env.home)).toMatchSnapshot();
  });
}

test("options lock: tools, mcp servers, permission mode per role", async () => {
  const qa = await capture("qa");
  const dev = await capture("dev");
  // Built-in tools: the assistant is read + web; dev has the code set.
  expect(qa.o.tools).toContain("WebFetch");
  expect(qa.o.tools).toContain(SEND_MESSAGE_TOOL_NAME); // every role gets Agent + SendMessage
  expect(dev.o.tools).toContain("Write");
  expect(dev.o.tools).toContain("AskUserQuestion"); // the plan approval is an ask
  expect(dev.o.tools).not.toContain("ExitPlanMode"); // no plan mode, no plan gate
  expect(qa.o.tools).not.toContain("Write");
  // MCP: the git server (reads) only for the assistant; dev gets none (git and gh run in the shell); no
  // GitHub server and no in-process app server anywhere.
  expect(Object.keys(qa.o.mcpServers ?? {})).toEqual([GIT_MCP_SERVER]);
  expect(dev.o.mcpServers).toEqual({});
  // dev: bypass from the first token; the assistant: auto mode (classifier).
  expect(dev.o.permissionMode).toBe("bypassPermissions");
  expect(dev.o.allowDangerouslySkipPermissions).toBe(true);
  expect(qa.o.permissionMode).toBe("auto");
  expect(qa.o.allowDangerouslySkipPermissions).toBeUndefined();
  // Never any filesystem settings; strict MCP config.
  for (const r of [qa, dev]) {
    expect(r.o.settingSources).toEqual([]);
    expect(r.o.strictMcpConfig).toBe(true);
    expect(typeof r.o.canUseTool).toBe("function");
  }
  // No app-defined subagents: the SDK's built-in one is what the Agent tool starts.
  for (const r of [qa, dev]) expect("agents" in r.o).toBe(false);
});

test("options lock: model and limits per role, no run timeout", async () => {
  const qa = await capture("qa");
  const dev = await capture("dev");
  expect(qa.o.model).toBe("model-qa");
  expect(dev.o.model).toBe("model-code");
  for (const r of [qa, dev]) expect(r.o.maxTurns).toBe(MAX_TURNS);
  // Per-role budget (assistant 1, dev 4.5) capped by MAX_BUDGET_USD=3.
  expect(qa.o.maxBudgetUsd).toBe(1);
  expect(dev.o.maxBudgetUsd).toBe(3);
  // No run timeout: no timer is armed for the run (owner decision).
  for (const r of [qa, dev]) expect(r.delays).toEqual([]);
});

test("options lock: per-run values", async () => {
  const dev = await capture("dev");
  expect(dev.o.cwd).toBe(dev.env.home);
  expect(dev.o.abortController).toBeInstanceOf(AbortController);
  expect(typeof dev.o.env).toBe("object");
});
