import { expect, test } from "bun:test";
import type { HubContext } from "../../src/hub/hub-context";
import { postProgress, progressBudget } from "../../src/runs/progress-budget";
import type { RunExec } from "../../src/runs/run-exec";
import { flush, makeHub, tick } from "../bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;
/** The hub's shared context. */
const ctxOf = (h: Hub) => (h.hub as unknown as { ctx: HubContext }).ctx;

/** Start an owner run of editor; returns its live exec. */
async function ownerRun() {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const ctx = ctxOf(h);
  const exec = ctx.runs.get("editor") as RunExec;
  return { h, ctx, exec };
}
const progress = (h: Hub) => [...h.store.msgs].filter((m) => m?.kind === "progress");

test("before the run is 60 s old nothing is posted (fresh)", async () => {
  const { h, ctx, exec } = await ownerRun();
  expect(await progressBudget(ctx, exec, ctx.deps.clock.now())).toBe("fresh");
  expect(await postProgress(ctx, exec, "early")).toEqual({ posted: false, reason: "fresh" });
  expect(progress(h)).toHaveLength(0);
});

test("three updates are posted, the 4th is over budget", async () => {
  const { h, ctx, exec } = await ownerRun();
  await tick(h.clock, 61_000);
  for (const t of ["a", "b", "c"])
    expect(await postProgress(ctx, exec, t)).toEqual({ posted: true, cut: false });
  expect(await postProgress(ctx, exec, "d")).toEqual({ posted: false, reason: "budget" });
  expect(progress(h).map((m) => m?.text)).toEqual(["a", "b", "c"]);
  expect(progress(h)[0]).toMatchObject({ wakeId: exec.row.id, kind: "progress" });
  expect(h.surface.posts.filter((p) => p.message.kind === "progress")).toHaveLength(3);
});

test("600 chars are posted cut at 500 with cut true", async () => {
  const { h, ctx, exec } = await ownerRun();
  await tick(h.clock, 61_000);
  expect(await postProgress(ctx, exec, "x".repeat(600))).toEqual({ posted: true, cut: true });
  expect(progress(h)[0]?.text).toHaveLength(500);
});

test("the count survives a new RunExec of the same wake (resume)", async () => {
  const { h, ctx, exec } = await ownerRun();
  await tick(h.clock, 61_000);
  for (const t of ["a", "b", "c"]) await postProgress(ctx, exec, t);
  const resumed = { ...exec, steps: exec.steps } as RunExec;
  expect(await progressBudget(ctx, resumed, ctx.deps.clock.now())).toBe("budget");
});

test("narration before a tool call is promoted within the budget only", async () => {
  const { h, exec } = await ownerRun();
  const s = h.runtime.last();
  await tick(h.clock, 61_000);
  for (let i = 0; i < 4; i++) {
    s.emit({ type: "text", text: `note ${i}` });
    s.emit({ type: "tool_call", toolUseId: `t${i}`, tool: "Read", input: { file_path: "/a" } });
    s.emit({ type: "tool_result", toolUseId: `t${i}`, ok: true });
    await flush();
  }
  expect(progress(h).map((m) => m?.text)).toEqual(["note 0", "note 1", "note 2"]);
  // All four stay run steps.
  expect(h.surface.runs.filter((r) => r.step.target?.startsWith("note")).length).toBe(4);
  expect(exec.row.id).toBeDefined();
});
