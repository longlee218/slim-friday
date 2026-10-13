import { expect, test } from "bun:test";
import { deliveryEvidence } from "../src/orchestrator/outputs/delivery-evidence";
import { insertToolCall } from "../src/storage/run-metrics-store";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv } from "./helpers";

/** Store one Bash call of turn `t` (the stored input is the JSON preview of the tool input). */
const bash = (db: ReturnType<typeof makeEnv>["db"], id: string, input: string, agentId?: string) =>
  insertToolCall(db, {
    id,
    runId: "r",
    turnId: "t",
    tool: BASH_TOOL_NAME,
    inputJson: input,
    outputPreview: "",
    isError: false,
    durationMs: 1,
    agentId,
  });
const cmd = (c: string) => JSON.stringify({ command: c });

test("compound commands, global git options and subagent calls count; reads and listings do not", () => {
  const { db } = makeEnv();
  bash(db, "1", cmd("git add . && git commit -m 'x' && git push origin feat"));
  bash(db, "2", cmd("git -C /repo checkout -b feat/y"), "sub1");
  bash(db, "3", cmd("gh pr create --title t"));
  bash(db, "4", cmd("git status && git diff && git branch --list && git log"));
  const ev = deliveryEvidence(db, "t", "");
  expect(ev.actions).toEqual({
    commit: 1,
    push: 1,
    branch_create: 1,
    pr_create: 1,
    merge: 0,
    cherry_pick: 0,
  });
  expect(ev.any).toBe(true);
});

test("only reads: no evidence; other turns are ignored", () => {
  const { db } = makeEnv();
  bash(db, "1", cmd("git status && git diff"));
  expect(deliveryEvidence(db, "t", "Answer only.").any).toBe(false);
  expect(deliveryEvidence(db, "other", "").any).toBe(false);
});

test("a truncated (invalid JSON) preview is searched as raw text", () => {
  const { db } = makeEnv();
  bash(db, "1", '{"command":"git commit -m \\"a very long message');
  expect(deliveryEvidence(db, "t", "").actions.commit).toBe(1);
});

test("the report counts: a PR URL or `commit <sha>` is evidence and an artifact", () => {
  const { db } = makeEnv();
  const ev = deliveryEvidence(
    db,
    "t",
    "Done: commit abc1234 on feat, https://github.com/o/r/pull/12",
  );
  expect(ev.any).toBe(true);
  expect(ev.artifacts).toEqual(["https://github.com/o/r/pull/12", "abc1234"]);
});

/** Evidence for a single stored Bash command. */
function evOf(command: string) {
  const { db } = makeEnv();
  insertToolCall(db, {
    id: "1",
    runId: "r",
    turnId: "t",
    tool: BASH_TOOL_NAME,
    inputJson: JSON.stringify({ command }),
    outputPreview: "",
    isError: false,
    durationMs: 1,
  });
  return deliveryEvidence(db, "t", "").any;
}

// Finishing choices of the dev role: "merge" is local (pushes to main are refused), so it must count as delivery.
test("known gap: a local `git merge` / `gh pr merge` finish leaves no evidence (false no-delivery note)", () => {
  expect(evOf("git merge feat/x")).toBe(true);
  expect(evOf("gh pr merge 7 --squash")).toBe(true);
});

test("wrapped shells: `bash -c 'git commit ...'` is still evidence", () => {
  expect(evOf(`bash -c "git commit -m x"`)).toBe(true);
});

test("`git cherry-pick` counts too", () => {
  expect(evOf("git cherry-pick abc1234")).toBe(true);
});
