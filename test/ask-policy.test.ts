import { expect, test } from "bun:test";
import { CREATE_PULL_REQUEST_TOOL } from "../src/mcp/effects/tools/CreatePullRequestTool/constants";
import { DELETE_PATHS_TOOL } from "../src/mcp/effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../src/mcp/effects/tools/MergeBranchTool/constants";
import { askNeeded, type Strategy } from "../src/orchestrator/approval/ask-policy";

/* Every cell of the 5.14 table. */

const ALL: Strategy[] = ["DIRECT", "DELEGATE", "PLAN"];

test("R0 / R1 never ask; R4 asks at every act, in every strategy", () => {
  for (const s of ALL) {
    expect(askNeeded(s, { risk: "R0" }, false, true)).toBe("none");
    expect(askNeeded(s, { risk: "R1" }, true, false)).toBe("none");
    expect(askNeeded(s, { risk: "R4" }, true, true)).toBe("every_time");
    expect(askNeeded(s, { risk: "R4", tool: DELETE_PATHS_TOOL }, false, true)).toBe("every_time");
  }
});

test("known R2 / R3 scope: one question at dispatch (DIRECT, DELEGATE) or inside the plan", () => {
  for (const tool of [GIT_PUSH_TOOL, CREATE_PULL_REQUEST_TOOL, MERGE_BRANCH_TOOL] as const) {
    expect(askNeeded("DIRECT", { risk: "R3", tool }, false, true)).toBe("at_dispatch");
    expect(askNeeded("DELEGATE", { risk: "R3", tool }, false, true)).toBe("at_dispatch");
    expect(askNeeded("PLAN", { risk: "R3", tool }, false, true)).toBe("in_plan");
  }
});

test("deferred scope: in bounds it runs, out of bounds it asks once concrete", () => {
  for (const s of ALL) {
    expect(askNeeded(s, { risk: "R2", tool: MERGE_BRANCH_TOOL }, true, true)).toBe("none");
    expect(askNeeded(s, { risk: "R2", tool: DELETE_PATHS_TOOL }, true, false)).toBe(
      "when_concrete",
    );
  }
});

test("DeletePaths to the trash within the bounds never asks (restorable); known scope past the bounds does", () => {
  for (const s of ALL)
    expect(askNeeded(s, { risk: "R2", tool: DELETE_PATHS_TOOL }, false, true)).toBe("none");
  expect(askNeeded("DIRECT", { risk: "R2", tool: DELETE_PATHS_TOOL }, false, false)).toBe(
    "at_dispatch",
  );
  expect(askNeeded("PLAN", { risk: "R2", tool: DELETE_PATHS_TOOL }, false, false)).toBe("in_plan");
});
