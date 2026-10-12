import { expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../src/config/agent-config";
import { guardFor } from "../src/guardrails/check-tool-call";
import { captureLogs } from "../src/observability/logger";
import { getStage } from "../src/roles/role-registry";
import { resolvePermissionMode } from "../src/runtime/permission-mode";
import { createPermissionWatch } from "../src/runtime/permission-watch";
import { runAgent } from "../src/runtime/run-agent";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import { READ_TOOL_NAME } from "../src/tools/sdk-tool-names";

const SIG = { signal: new AbortController().signal };
const cfg = (provider: "anthropic" | "openrouter", hasRealAuth: boolean) =>
  ({ provider, hasRealAuth }) as AgentConfig;

test("resolver: auto only on anthropic with a real login; otherwise fail closed to default", () => {
  const qa = getStage("assistant", "qa");
  expect(resolvePermissionMode(qa, cfg("anthropic", true))).toBe("auto");
  expect(resolvePermissionMode(qa, cfg("anthropic", false))).toBe("default");
  expect(resolvePermissionMode(qa, cfg("openrouter", true))).toBe("default");
  expect(resolvePermissionMode(qa, cfg("openrouter", false))).toBe("default");
});

test("resolver: plan stays plan and exec stays bypassPermissions on every provider and auth state", () => {
  for (const c of [cfg("anthropic", true), cfg("openrouter", false)]) {
    expect(resolvePermissionMode(getStage("dev", "plan"), c)).toBe("plan");
    expect(resolvePermissionMode(getStage("dev", "exec"), c)).toBe("bypassPermissions");
  }
});

/** Run the PreToolUse guard hook for one call. */
async function pre(
  autoMode: boolean,
  tool: string,
  input: Record<string, unknown>,
  guard = guardFor("qa", { readPaths: ["/ws/repo"] }),
) {
  const perms = buildToolPermissions({
    turnId: "t",
    threadId: "th",
    guard,
    autoMode: { active: autoMode },
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

test("auto mode: guard ask defers to the classifier and logs decision auto", async () => {
  const { out, perms } = await pre(true, "SomeUnknownTool", {});
  expect(out).toEqual({ continue: true });
  expect(perms.decisions.get("u1")?.decision).toBe("auto");
});

test("default mode: guard ask still forces the owner prompt", async () => {
  const { out, perms } = await pre(false, "SomeUnknownTool", {});
  expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  expect(perms.decisions.get("u1")?.decision).toBe("ask");
});

test("auto mode: guard deny stays a hard deny", async () => {
  const { out } = await pre(true, READ_TOOL_NAME, { file_path: "/etc/passwd" });
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("auto mode: canUseTool (classifier undecided) still asks the owner via the gateway", async () => {
  const asked: string[] = [];
  const perms = buildToolPermissions({
    turnId: "t",
    threadId: "th",
    guard: guardFor("qa", { readPaths: ["/ws/repo"] }),
    autoMode: { active: true },
    gateway: {
      request: async (r: { tool: string }) => (asked.push(r.tool), { approved: true }),
      cancelTurn: () => {},
    } as never,
  });
  const r = await perms.canUseTool("SomeUnknownTool", {}, { signal: SIG.signal } as never);
  expect(r?.behavior).toBe("allow");
  expect(asked).toEqual(["SomeUnknownTool"]);
});

test("auto mode: Bash never asks (deny list): an env override or make runs as allow, sudo is denied", async () => {
  const guard = guardFor("exec", {
    cwd: "/ws/repo",
    writePaths: ["/ws/repo"],
    readPaths: ["/ws/repo"],
  });
  for (const command of ["PATH=./bin make", "make"]) {
    const { out, perms } = await pre(true, "Bash", { command }, guard);
    expect(out).toEqual({ continue: true });
    expect(perms.decisions.get("u1")?.decision).toBe("allow");
  }
  const { out } = await pre(true, "Bash", { command: "sudo make" }, guard);
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
});

/** Feed fake SDK messages to a watch and collect its log lines. */
function watch(requested: "auto" | "default" | undefined, msgs: object[]) {
  const state = { active: requested === "auto" };
  const cap = captureLogs();
  const w = createPermissionWatch(requested, state);
  for (const m of msgs) w(m as never);
  cap.stop();
  return { state, lines: cap.lines };
}
const init = (permissionMode: string) => ({ type: "system", subtype: "init", permissionMode });

test("watch: init with the requested auto mode logs permission.mode, deferral stays on", () => {
  const { state, lines } = watch("auto", [init("auto")]);
  expect(state.active).toBe(true);
  expect(lines.filter((l) => l.event === "permission.mode")).toMatchObject([
    { requested: "auto", actual: "auto", level: 30 },
  ]);
});

test("watch: silent fallback to default warns and switches deferral off", () => {
  const { state, lines } = watch("auto", [init("default")]);
  expect(state.active).toBe(false);
  expect(lines.find((l) => l.event === "permission.mode")).toMatchObject({
    actual: "default",
    fallback: true,
    level: 40,
  });
});

test("watch: after a fallback the hook forces ask and logs ask, not auto", async () => {
  const state = { active: true };
  createPermissionWatch("auto", state)(init("default") as never);
  const perms = buildToolPermissions({
    turnId: "t",
    threadId: "th",
    guard: guardFor("qa", { readPaths: ["/ws/repo"] }),
    autoMode: state,
  });
  const out: any = await perms.hooks[0]!.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_use_id: "u9",
      tool_name: "SomeUnknownTool",
      tool_input: {},
    } as never,
    "u9",
    SIG,
  );
  expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  expect(perms.decisions.get("u9")?.decision).toBe("ask");
});

test("watch: classifier denial logs tool.denied by classifier with tool and id only", () => {
  const { lines } = watch("auto", [
    init("auto"),
    {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "tu1",
      decision_reason_type: "classifier",
      decision_reason: "secret text",
      message: "denied",
    },
    {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "tu2",
      decision_reason_type: "mode",
    },
  ]);
  const denied = lines.filter((l) => l.event === "tool.denied");
  expect(denied).toHaveLength(1);
  expect(denied[0]).toMatchObject({ by: "classifier", tool: "Bash", toolUseId: "tu1", level: 40 });
  expect(JSON.stringify(denied[0])).not.toContain("secret text");
});

/** Run the assistant qa stage with a fake SDK that reports `actual` in its init; returns what the guard hook then does. */
async function execRun(actual: string) {
  const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" });
  let hook: any;
  const queryFn = (a: { options?: Options }) =>
    (async function* () {
      yield { ...initMsg, permissionMode: actual } as never;
      // Called while the stream is open, like a real tool call after init.
      hook = a.options!.hooks!.PreToolUse![0]!.hooks[0]!;
      out = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_use_id: "u1",
          tool_name: "SomeUnknownTool",
          tool_input: {},
        },
        "u1",
        SIG,
      );
      yield resultMsg({ result: "ok" });
    })();
  let out: any;
  await runAgent({
    prompt: "q",
    turnId: "t1",
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: queryFn as never,
    stage: getStage("assistant", "qa"),
    guard: guardFor("qa", { readPaths: [env.repo] }),
    code: { threadId: "th" },
  });
  return out;
}

test("runAgent: SDK confirms auto -> soft ask deferred; SDK reports default -> ask forced", async () => {
  expect(await execRun("auto")).toEqual({ continue: true });
  expect((await execRun("default")).hookSpecificOutput.permissionDecision).toBe("ask");
});

import { initMsg, makeEnv, resultMsg } from "./helpers";
