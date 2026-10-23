import { afterEach, expect, spyOn, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { SONNET_MODEL } from "../src/config/model-ids";
import { guardFor } from "../src/policy/check-tool-call";
import { CHIEF_OF_STAFF_ROLE } from "../src/roles/builtin/chief-of-staff-role";
import { DEVELOPER_ROLE } from "../src/roles/builtin/developer-role";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { SEND_MESSAGE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv, resultMsg } from "./helpers";

/**
 * BEHAVIOR LOCK: the SDK options `runAgent` passes to `query` for the two roles (teammate, dev). Functions are
 * compared by presence, not identity; per-run values (cwd, env, abort controller) are asserted apart.
 */

type Kind = "teammate" | "dev";

/** Config limits are fixed so timeout and budget assertions are exact. */
const ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", // real Anthropic login: the teammate may use auto mode
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
  const scope = { readPaths: [env.location], writePaths: [] };
  if (kind === "teammate") {
    await runAgent({
      ...base,
      role: getRole("chief-of-staff"),
      guard: guardFor(getRole("chief-of-staff"), scope),
    });
  } else {
    await runAgent({
      ...base,
      role: getRole("developer"),
      guard: guardFor(getRole("developer"), { ...scope, writePaths: [env.home] }),
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
    // A plugin copy dir has a random suffix per run.
    .replace(/plugin-[A-Za-z0-9]+/g, "plugin-<id>");
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

const KINDS: Kind[] = ["teammate", "dev"];

for (const kind of KINDS) {
  test(`options lock: ${kind} options snapshot`, async () => {
    const { o, env } = await capture(kind);
    expect(normalize(o, env.home)).toMatchSnapshot();
  });
}

test("options lock: tools, mcp servers, permission mode per role", async () => {
  const teammate = await capture("teammate");
  const dev = await capture("dev");
  // Built-in tools: the teammate is read only; dev has the code set.
  expect(teammate.o.tools).toEqual(["Read", "Glob", "Grep", "LSP", "Skill"]); // read only + Skill (teammate-orchestration): no web, no shell, no subagents
  expect(teammate.o.tools).not.toContain(SEND_MESSAGE_TOOL_NAME); // the teammate dispatches through its tools only
  expect(dev.o.tools).toContain("Write");
  expect(dev.o.tools).toContain("AskUserQuestion"); // the plan approval is an ask
  expect(dev.o.tools).not.toContain("ExitPlanMode"); // no plan mode, no plan gate
  expect(teammate.o.tools).not.toContain("Write");
  // MCP: none from `runAgent` itself (the teammate's own server is passed by the teammate runner); dev gets none (git and gh
  // run in the shell); no GitHub server anywhere.
  expect(teammate.o.mcpServers).toEqual({});
  expect(dev.o.mcpServers).toEqual({});
  // dev (a shell): never auto-approved, whatever the role asks (`RunProtection.permissionDefault`); the teammate: auto mode (classifier).
  expect(dev.o.permissionMode).toBe("default");
  expect(dev.o.allowDangerouslySkipPermissions).toBeUndefined();
  expect(teammate.o.permissionMode).toBe("auto");
  expect(teammate.o.allowDangerouslySkipPermissions).toBeUndefined();
  // Never any filesystem settings; strict MCP config.
  for (const r of [teammate, dev]) {
    expect(r.o.settingSources).toEqual([]);
    expect(r.o.strictMcpConfig).toBe(true);
    expect(typeof r.o.canUseTool).toBe("function");
  }
  // No app-defined subagents: the SDK's built-in one is what the Agent tool starts.
  for (const r of [teammate, dev]) expect("agents" in r.o).toBe(false);
});

test("options lock: model and limits per role, no run timeout", async () => {
  const teammate = await capture("teammate");
  const dev = await capture("dev");
  expect(teammate.o.model).toBe(SONNET_MODEL);
  expect(dev.o.model).toBe(SONNET_MODEL);
  expect(teammate.o.maxTurns).toBe(CHIEF_OF_STAFF_ROLE.limits.maxTurns);
  expect(dev.o.maxTurns).toBe(DEVELOPER_ROLE.limits.maxTurns);
  // Env depth = the role's `subagents.depth`.
  expect(teammate.o.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe(
    String(CHIEF_OF_STAFF_ROLE.subagents.depth),
  );
  expect(dev.o.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe(
    String(DEVELOPER_ROLE.subagents.depth),
  );
  // Per-role budget (teammate, dev) capped by MAX_BUDGET_USD=3.
  expect(teammate.o.maxBudgetUsd).toBe(CHIEF_OF_STAFF_ROLE.budgetUsd);
  expect(dev.o.maxBudgetUsd).toBe(3);
  // No run timeout: no timer is armed for the run (owner decision).
  for (const r of [teammate, dev]) expect(r.delays).toEqual([]);
});

test("options lock: per-run values", async () => {
  const dev = await capture("dev");
  expect(dev.o.cwd).toBe(dev.env.home);
  expect(dev.o.abortController).toBeInstanceOf(AbortController);
  expect(typeof dev.o.env).toBe("object");
});
