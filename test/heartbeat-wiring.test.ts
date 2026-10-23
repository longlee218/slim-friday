import { expect, test } from "bun:test";
import { liveWorkers } from "../src/orchestrator/run/live-runs";
import { guardFor } from "../src/policy/check-tool-call";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { makeEnv, resultMsg } from "./helpers";
import { teammateHarness, until } from "./teammate-harness";

/* The heartbeat wiring: a tool start reaches `onToolStart` (sdk-options), and a real worker run turns it into activity. */

/** Run the PreToolUse hook of the options the fake query received, for one tool call. */
const preToolUse = (options: any, tool: string) =>
  options.hooks.PreToolUse[0].hooks[0](
    { hook_event_name: "PreToolUse", tool_use_id: "u1", tool_name: tool, tool_input: {} },
    "u1",
    { signal: new AbortController().signal },
  );

test("runAgent: every PreToolUse guard decision (allow or deny) calls onToolStart", async () => {
  const env = makeEnv();
  let calls = 0;
  const queryFn = (a: { options?: any }) =>
    (async function* () {
      await preToolUse(a.options, "Read");
      await preToolUse(a.options, "SomeUnknownTool");
      yield resultMsg({ result: "ok" });
    })();
  await runAgent({
    prompt: "q",
    turnId: "t1",
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: queryFn as never,
    role: getRole("scout"),
    guard: guardFor(getRole("scout"), { readPaths: [env.location] }),
    code: { threadId: "th", gateway: undefined },
    onToolStart: () => void calls++,
  });
  expect(calls).toBe(2);
});

test("a worker run: a tool start stamps the live run, Report progress records percent and note (full path)", async () => {
  let before = -1;
  let after = -1;
  const h = teammateHarness(async (c) => {
    if (c.kind === "worker") {
      const run = liveWorkers()[0];
      if (!run) throw new Error("worker run is not live");
      run.lastActivityAt = 1; // long ago
      before = run.lastActivityAt;
      await preToolUse(c.options, "Read");
      after = run.lastActivityAt;
      await c.report("progress", { percent: 50, note: "half way" });
      expect(run.progress).toMatchObject({ percent: 50, note: "half way" });
      await c.report("result", { title: "T", status: "COMPLETED", summary: "ok" });
      return "done";
    }
    if (c.prompt.includes("<owner_message>")) {
      await c.orchestrate("dispatch", {
        strategy: "DELEGATE",
        small: true,
        intent: "work",
        reason: "test",
        assignments: [{ key: "a", subject: "task", role: "scout", brief: "do a", dependsOn: [] }],
      });
      return "On it.";
    }
    return "";
  });
  await h.send("do one thing");
  await until(() => after !== -1);
  expect(before).toBe(1);
  expect(after).toBeGreaterThan(1);
});
