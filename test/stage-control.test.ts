import { expect, test } from "bun:test";
import { stageControl } from "../src/orchestrator/engine/stage-control";

// stageControl links a stage's abort controller to the task's `stop` signal.

test("a parent aborted before the stage starts aborts the stage at once", () => {
  const parent = new AbortController();
  parent.abort();
  const { ac } = stageControl(parent.signal, () => {});
  expect(ac.signal.aborted).toBe(true);
});

test("a later parent abort aborts the stage and the ask timeout is then a no-op", () => {
  const parent = new AbortController();
  const awaiting: string[] = [];
  const { ac, onAskTimeout } = stageControl(parent.signal, (t) => awaiting.push(t));
  expect(ac.signal.aborted).toBe(false);
  parent.abort();
  expect(ac.signal.aborted).toBe(true);
  onAskTimeout([
    { question: "q?", header: "h", options: [{ label: "a", description: "" }] },
  ] as never);
  expect(awaiting).toEqual([]);
});
