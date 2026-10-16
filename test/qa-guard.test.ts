import { expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { addLocation, makeEnv } from "./helpers";
import { leadHarness, until } from "./lead-harness";

/** Run one owner message through the lead (the foreground role) and return the SDK options of its run. */
async function leadOptions(setup?: (env: ReturnType<typeof makeEnv>) => void) {
  const env = makeEnv();
  setup?.(env);
  let opts: any;
  const h = leadHarness(async (c) => {
    opts = c.options;
    return "ok";
  }, env);
  await h.send("where is x?");
  await until(() => opts !== undefined);
  return { env, opts };
}

test("lead reads nothing outside its own dirs (outside paths, home dotfiles); no shell, no writes, no questions", async () => {
  const { env, opts } = await leadOptions();
  const location = realpathSync(env.location);
  const can = opts.canUseTool as (t: string, i: any, o: any) => Promise<any>;
  // The lead runs in the workspace's neutral dir: it reads the registered locations through a scout, not itself.
  expect(opts.cwd).toBe(workspacePaths(env.home).workspace("main").cwd);
  expect((await can(READ_TOOL_NAME, { file_path: join(opts.cwd, "a.txt") }, {})).behavior).toBe(
    "allow",
  );
  expect((await can(READ_TOOL_NAME, { file_path: "/etc/hosts" }, {})).behavior).toBe("deny");
  expect((await can(GREP_TOOL_NAME, { pattern: "x", path: "/Users" }, {})).behavior).toBe("deny");
  // The lead has no shell capability and cannot change files.
  expect(opts.tools).not.toContain(BASH_TOOL_NAME);
  expect((await can(BASH_TOOL_NAME, { command: "ls" }, {})).behavior).toBe("deny");
  expect(
    (await can(WRITE_TOOL_NAME, { file_path: join(location, "z"), content: "" }, {})).behavior,
  ).toBe("deny");
  // No gateway in a lead run: the question tool is unavailable (it asks through AskOwner).
  expect((await can(ASK_USER_QUESTION_TOOL_NAME, { questions: [] }, {})).behavior).toBe("deny");
});

test("Agent tool: allowed when the stage lists it (legacy Task name too), else the owner decides; no per-type rule", () => {
  const ctx = { writePaths: [], allowTools: [AGENT_TOOL_NAME] };
  const d = (input: Record<string, unknown>, tool = AGENT_TOOL_NAME, c = ctx) =>
    checkToolCall(tool, input, c).decision;
  expect(d({ prompt: "p" })).toBe("allow");
  expect(d({ prompt: "p" }, AGENT_TOOL_NAME, { writePaths: [], allowTools: [] })).toBe("ask");
});

test("lead with several locations uses the neutral cwd and lists no CLAUDE.md hint", async () => {
  const { env, opts } = await leadOptions((e) => {
    const b = addLocation(e.home, "b"); // workspaces/main/locations/b/location
    writeFileSync(join(b, "CLAUDE.md"), "rules");
  });
  expect(opts.cwd).toBe(workspacePaths(env.home).workspace("main").cwd);
  const prompt = opts.systemPrompt.append as string;
  expect(prompt).not.toContain("CLAUDE.md");
  expect(prompt).not.toContain("first]");
  expect(opts.settingSources).toEqual([]);
  expect(opts.skills).toEqual([]); // no location skills here: bundled SDK skills are not listed
});

/* Interrupt-steer plan, Task 3: the abort fence only denies new tools; it never undoes a finished one. */
import { existsSync } from "node:fs";
import { guardFor } from "../src/guardrails/check-tool-call";
import { getRole } from "../src/roles/role-registry";
import { buildToolPermissions, RUN_STOPPED_REASON } from "../src/runtime/tool-permissions";

const fenceInput = (runSignal: AbortSignal, gateway?: any) => ({
  turnId: "t",
  threadId: "th",
  guard: guardFor(getRole("lead"), { readPaths: ["/ws/location"] }),
  runSignal,
  gateway,
});
const readCall = (id: string) =>
  ({
    hook_event_name: "PreToolUse",
    tool_use_id: id,
    tool_name: READ_TOOL_NAME,
    tool_input: { file_path: "/ws/location/a.txt" },
  }) as never;
const SIG = { signal: new AbortController().signal };

test("fence: PreToolUse allows a new tool while the run lives and denies it once the run is aborted", async () => {
  const ac = new AbortController();
  const hook = buildToolPermissions(fenceInput(ac.signal)).hooks[0]!.hooks[0]!;
  expect(await hook(readCall("u1"), "u1", SIG)).toEqual({ continue: true });
  ac.abort();
  const out: any = await hook(readCall("u2"), "u2", SIG);
  expect(out.hookSpecificOutput).toMatchObject({
    permissionDecision: "deny",
    permissionDecisionReason: RUN_STOPPED_REASON,
  });
});

test("fence: canUseTool denies before asking when the run is already stopped, and a 'yes' that lands during the stop does not start the tool", async () => {
  const requests: string[] = [];
  const ac = new AbortController();
  let answer!: (r: { approved: boolean }) => void;
  const gateway = {
    request: (r: { tool: string }) => {
      requests.push(r.tool);
      return new Promise((res) => (answer = res as never));
    },
    askChoice: async () => undefined,
    cancelTurn: () => {},
  };
  const { canUseTool } = buildToolPermissions(fenceInput(ac.signal, gateway));
  const opts = { signal: ac.signal, toolUseID: "u1" } as never;
  // an unknown tool asks the owner; the owner says yes AFTER the run was aborted
  const pending = canUseTool("MysteryTool", {}, opts);
  await Bun.sleep(5);
  expect(requests).toEqual(["MysteryTool"]);
  ac.abort();
  answer({ approved: true });
  expect(await pending).toMatchObject({ behavior: "deny", message: RUN_STOPPED_REASON });
  // a later call never even reaches the owner
  expect(
    await canUseTool("MysteryTool", {}, { ...(opts as object), toolUseID: "u2" } as never),
  ).toMatchObject({
    behavior: "deny",
    message: RUN_STOPPED_REASON,
  });
  expect(requests).toHaveLength(1);
});

test("fence: it cannot override a guard denial (the guard's reason stays) and never undoes a completed write", async () => {
  const env = makeEnv();
  const done = join(env.home, "completed.txt");
  writeFileSync(done, "x\n"); // a tool that finished before the stop
  const ac = new AbortController();
  const { canUseTool } = buildToolPermissions(
    fenceInput(ac.signal, {
      request: async () => ({ approved: true }),
      askChoice: async () => undefined,
      cancelTurn: () => {},
    }),
  );
  const denied: any = await canUseTool(READ_TOOL_NAME, { file_path: "/etc/passwd" }, {
    signal: ac.signal,
    toolUseID: "g1",
  } as never);
  expect(denied.behavior).toBe("deny");
  expect(denied.message).not.toBe(RUN_STOPPED_REASON); // the guard's own reason, run not stopped yet
  ac.abort();
  expect(existsSync(done)).toBe(true);
});

test("guard decision observer sees allow / deny, cannot change them, and a throwing observer never lets a denied call through", async () => {
  const seen: { decision: string; reason: string }[] = [];
  const base = {
    turnId: "t",
    threadId: "th",
    guard: guardFor(getRole("lead"), { readPaths: ["/ws/location"] }),
  };
  const call = (p: string, id: string) =>
    ({
      hook_event_name: "PreToolUse",
      tool_use_id: id,
      tool_name: READ_TOOL_NAME,
      tool_input: { file_path: p },
    }) as never;
  const watched = buildToolPermissions({
    ...base,
    onGuardDecision: (e: { decision: string; reason: string }) => seen.push(e),
  } as never).hooks[0]!.hooks[0]!;
  expect(await watched(call("/ws/location/a.txt", "o1"), "o1", SIG)).toEqual({ continue: true });
  const denied: any = await watched(call("/etc/passwd", "o2"), "o2", SIG);
  expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(seen.map((e) => e.decision)).toEqual(["allow", "deny"]);
  const throwing = buildToolPermissions({
    ...base,
    onGuardDecision: () => {
      throw new Error("observer bug");
    },
  } as never).hooks[0]!.hooks[0]!;
  const still: any = await throwing(call("/etc/passwd", "o3"), "o3", SIG);
  expect(still.hookSpecificOutput.permissionDecision).toBe("deny");
});
