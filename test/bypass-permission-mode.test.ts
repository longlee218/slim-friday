import { expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { guardFor } from "../src/guardrails/check-tool-call";
import { captureLogs } from "../src/observability/logger";
import { getStage } from "../src/roles/role-registry";
import { createPermissionWatch } from "../src/runtime/permission-watch";
import { runAgent } from "../src/runtime/run-agent";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import { READ_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { initMsg, makeEnv, resultMsg } from "./helpers";

const SIG = { signal: new AbortController().signal };
const guard = guardFor("exec", {
  cwd: "/ws/repo",
  writePaths: ["/ws/repo"],
  readPaths: ["/ws/repo"],
});

/** Run the PreToolUse guard hook of an exec-like stage in (in)active bypass mode. */
async function pre(bypass: boolean, tool: string, input: Record<string, unknown>) {
  const perms = buildToolPermissions({
    taskId: "t",
    threadId: "th",
    guard,
    bypassMode: { active: bypass },
  });
  const out: any = await perms.hooks[0]!.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_use_id: "u1",
      tool_name: tool,
      tool_input: input,
    } as never,
    "u1",
    SIG,
  );
  return { out, perms };
}

test("bypass: guard deny stays a hard deny and is logged tool.denied", async () => {
  const cap = captureLogs();
  const { out } = await pre(true, READ_TOOL_NAME, { file_path: "/etc/passwd" });
  cap.stop();
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(cap.lines.some((l) => l.event === "tool.denied")).toBe(true);
});

test("bypass: hard denies stay (git push, gh)", async () => {
  for (const command of ["git push origin main", "gh pr create"]) {
    const { out } = await pre(true, "Bash", { command });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  }
});

test("bypass: soft ask (make) runs and is logged bypass", async () => {
  const { out, perms } = await pre(true, "Bash", { command: "make" });
  expect(out).toEqual({ continue: true });
  expect(perms.decisions.get("u1")?.decision).toBe("bypass");
});

test("bypass: owner-only asks (env override, $(), xargs, ~) run and are logged bypass", async () => {
  for (const command of ["PATH=./bin make", "echo $(date)", "ls | xargs cat", "cat ~/notes.txt"]) {
    const { out, perms } = await pre(true, "Bash", { command });
    expect(out).toEqual({ continue: true });
    expect(perms.decisions.get("u1")?.decision).toBe("bypass");
  }
});

test("bypass inactive (SDK did not enter bypass): ask is forced to the owner again", async () => {
  const { out, perms } = await pre(false, "Bash", { command: "PATH=./bin make" });
  expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  expect(perms.decisions.get("u1")?.decision).toBe("ask");
});

/** Feed fake SDK messages to a watch and return its state and log lines. */
function watch(msgs: object[]) {
  const auto = { active: false };
  const bypass = { active: true };
  const cap = captureLogs();
  const w = createPermissionWatch("bypassPermissions", auto, bypass);
  for (const m of msgs) w(m as never);
  cap.stop();
  return { bypass, lines: cap.lines };
}

test("watch: init confirming bypassPermissions keeps bypass on", () => {
  const { bypass, lines } = watch([
    { type: "system", subtype: "init", permissionMode: "bypassPermissions" },
  ]);
  expect(bypass.active).toBe(true);
  expect(lines.find((l) => l.event === "permission.mode")).toMatchObject({
    requested: "bypassPermissions",
    actual: "bypassPermissions",
    level: 30,
  });
});

test("watch: any other mode warns and switches bypass off (fail closed)", () => {
  const { bypass, lines } = watch([{ type: "system", subtype: "init", permissionMode: "default" }]);
  expect(bypass.active).toBe(false);
  expect(lines.find((l) => l.event === "permission.mode")).toMatchObject({
    fallback: true,
    level: 40,
  });
});

test("watch: init without a permissionMode switches bypass off (fail closed)", () => {
  const { bypass } = watch([{ type: "system", subtype: "init" }]);
  expect(bypass.active).toBe(false);
});

test("qa owner-only ask is not bypassed (no bypass state on the qa stage)", async () => {
  const perms = buildToolPermissions({
    taskId: "t",
    threadId: "th",
    guard,
    autoMode: { active: true },
  });
  const out: any = await perms.hooks[0]!.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_use_id: "u1",
      tool_name: "Bash",
      tool_input: { command: "PATH=./bin make" },
    } as never,
    "u1",
    SIG,
  );
  expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  expect(perms.decisions.get("u1")?.decision).toBe("ask");
});

/** Run the exec stage with a fake SDK reporting `actual` in its init; return the options and the hook result. */
async function execRun(actual: string) {
  const env = makeEnv();
  let opts: Options | undefined;
  let out: any;
  const queryFn = (a: { options?: Options }) =>
    (async function* () {
      opts = a.options;
      yield { ...initMsg, permissionMode: actual } as never;
      out = await a.options!.hooks!.PreToolUse![0]!.hooks[0]!(
        {
          hook_event_name: "PreToolUse",
          tool_use_id: "u1",
          tool_name: "Bash",
          tool_input: { command: "PATH=./bin make" },
        } as never,
        "u1",
        SIG,
      );
      yield resultMsg({ result: "ok" });
    })();
  await runAgent({
    prompt: "q",
    taskId: "t1",
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: queryFn as never,
    stage: getStage("dev", "exec"),
    guard: guardFor("exec", { cwd: env.home, readPaths: [env.repo], writePaths: [env.home] }),
    code: { threadId: "th" },
  });
  return { opts: opts!, out };
}

test("runAgent: exec asks SDK for bypass with the opt-in; confirmed -> ask runs, else ask forced", async () => {
  const ok = await execRun("bypassPermissions");
  expect(ok.opts.permissionMode).toBe("bypassPermissions");
  expect(ok.opts.allowDangerouslySkipPermissions).toBe(true);
  expect(ok.out).toEqual({ continue: true });
  const fallback = await execRun("default");
  expect(fallback.out.hookSpecificOutput.permissionDecision).toBe("ask");
});

test("plan and qa options carry no allowDangerouslySkipPermissions", async () => {
  expect(getStage("dev", "plan").permissionMode).toBe("plan");
  for (const [role, stage] of [
    ["dev", "plan"],
    ["assistant", "qa"],
  ] as const) {
    const env = makeEnv();
    let opts: Options | undefined;
    await runAgent({
      prompt: "q",
      taskId: "t1",
      cwd: env.home,
      config: env.config,
      db: env.db,
      abortController: new AbortController(),
      queryFn: ((a: { options?: Options }) =>
        (async function* () {
          opts = a.options;
          yield resultMsg({ result: "ok" });
        })()) as never,
      stage: getStage(role, stage),
      guard: guardFor("qa", { readPaths: [env.repo] }),
      code: { threadId: "th" },
    });
    expect(opts!.allowDangerouslySkipPermissions).toBeUndefined();
  }
});
