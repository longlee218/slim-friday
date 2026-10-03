import { expect, test } from "bun:test";
import { RunRecorder } from "../src/observability/record-run";
import { buildToolHooks } from "../src/observability/tool-hooks";
import { makeEnv } from "./helpers";

/** Invoke the PostToolUse hook with a given tool input. */
async function post(
  db: ReturnType<typeof makeEnv>["db"],
  paths: ReturnType<typeof makeEnv>["paths"],
  input: unknown,
) {
  const rec = new RunRecorder(db, "r1", "t1", "m", paths.taskLog("t1"));
  const hook = buildToolHooks(rec).PostToolUse![0]!.hooks[0]!;
  const out = await hook(
    {
      hook_event_name: "PostToolUse",
      tool_use_id: "u1",
      tool_name: "Read",
      tool_input: input,
      tool_response: "ok",
      duration_ms: 3,
    } as never,
    "u1",
    { signal: new AbortController().signal },
  );
  rec.close();
  return out;
}

test("M6: circular tool input is stored, hook does not throw", async () => {
  const { db, paths } = makeEnv();
  const a: Record<string, unknown> = {};
  a.self = a;
  expect(await post(db, paths, a)).toEqual({ continue: true });
  expect(
    db.query<{ input_json: string }, []>("SELECT input_json FROM tool_calls").get()?.input_json,
  ).toContain("[Circular]");
});

test("M6: throwing DB never propagates into the SDK", async () => {
  const { db, paths } = makeEnv();
  db.close();
  expect(await post(db, paths, { file_path: "a" })).toEqual({ continue: true });
});

test("tool_calls row has redacted input", async () => {
  const { db, paths } = makeEnv();
  await post(db, paths, { content: "password: hunter2" });
  expect(
    db.query<{ input_json: string }, []>("SELECT input_json FROM tool_calls").get()?.input_json,
  ).not.toContain("hunter2");
});
