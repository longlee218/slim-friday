import { expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { guardFor } from "../src/policy/check-tool-call";
import { defaultEnvelope } from "../src/policy/envelope";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { makeEnv, resultMsg } from "./helpers";

/* BEHAVIOR LOCK: the SDK options of a dispatched worker (a run with an envelope): sandbox, permission mode, env scrub, tools.
   Phase 03 re-derives them from the tool policy; these snapshots must not move. */

async function capture(roleName: string) {
  const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", MAX_BUDGET_USD: "3" });
  const loc = realpathSync(env.location);
  const goalDir = join(env.home, "runs", "t1");
  mkdirSync(goalDir, { recursive: true });
  const role = getRole(roleName);
  const writes = roleName === "developer";
  let options: Options | undefined;
  await runAgent({
    role,
    prompt: "q",
    turnId: "t1",
    cwd: loc,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: ((a: { options?: Options }) =>
      (async function* () {
        options = a.options;
        yield resultMsg({ result: "ok" });
      })()) as never,
    guard: guardFor(role, {
      cwd: loc,
      ...(writes ? { writePaths: [loc, goalDir] } : {}),
      readPaths: [loc, goalDir],
      denyPaths: [realpathSync(env.home)],
      allowInside: [goalDir],
      envelope: defaultEnvelope("g1", ["location"], goalDir),
    }),
    code: { threadId: "th", gateway: undefined },
  });
  if (!options) throw new Error("query was not called");
  const o = options;
  const home = realpathSync(env.home);
  const json = JSON.stringify(
    {
      permissionMode: o.permissionMode,
      allowDangerouslySkipPermissions: o.allowDangerouslySkipPermissions,
      tools: o.tools,
      sandbox: o.sandbox,
      mcp: Object.keys(o.mcpServers ?? {}),
      scrub: o.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
      hasCanUseTool: typeof o.canUseTool,
    },
    null,
    2,
  );
  // A plugin copy dir has a random suffix per run.
  return JSON.parse(
    json
      .replaceAll(home, "<home>")
      .replaceAll(loc, "<loc>")
      .replace(/plugin-[A-Za-z0-9]+/g, "plugin-<id>"),
  );
}

for (const name of ["developer", "scout", "tester", "researcher", "humanizer-writer"])
  test(`worker options lock: ${name}`, async () => {
    expect(await capture(name)).toMatchSnapshot();
  });
