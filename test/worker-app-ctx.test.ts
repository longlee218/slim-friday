import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleRunInput } from "../src/orchestrator/run/role-run-types";
import type {
  TeammateRuntime,
  TeammateThreadCtx,
} from "../src/orchestrator/teammate/teammate-runtime";
import { checkReportFiles } from "../src/orchestrator/worker/report-files";
import { workerAppCtx } from "../src/orchestrator/worker/worker-app-ctx";
import { listTaskMessages } from "../src/storage/task-message-store";
import { makeEnv } from "./helpers";
import { approvedPlan, byKey, TH } from "./plan-fixture";

/* The ctx a worker's MCP tools get: progress becomes a stored message; reported scratch files are copied per run. */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A goal with one item and the ctx function of a run `turnId` of it (scratch dir with `notes.md`). */
function world() {
  const env = makeEnv();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "wac-scratch-")));
  roots.push(scratch);
  writeFileSync(join(scratch, "notes.md"), "# notes");
  const { db, goalId } = approvedPlan([
    {
      key: "a",
      subject: "Do a",
      role: "developer",
      brief: "do a",
      location: "repo",
      dependsOn: [],
      risk: "R1",
    },
  ]);
  const itemId = byKey(db, goalId, "a").id;
  const rt = { deps: { db, config: { agentHome: env.home } } } as unknown as TeammateRuntime;
  const ctx = { workspace: "ws1", channel: "ch1", locations: [] } as unknown as TeammateThreadCtx;
  /** The tool ctx of one run (turn) of the item. */
  const run = (turnId: string) =>
    (
      workerAppCtx(rt, ctx, {
        threadId: TH,
        goalId,
        itemId,
        turnId,
        role: "developer",
        language: "en",
        envelope: { goalDir: scratch } as never,
        sink: {},
      }) as Extract<NonNullable<RoleRunInput["appCtx"]>, () => unknown>
    )();
  return { db, itemId, run, scratch };
}

test("Report progress is stored as a progress message of the task", () => {
  const { db, itemId, run } = world();
  run("turn-1").progress?.({ percent: 40, note: "tests written" });
  const rows = listTaskMessages(db, itemId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "progress",
    author: "developer",
    text: "40%: tests written",
  });
});

test("the same scratch file can be reported again by a later run of the item (retry)", () => {
  const { run, scratch } = world();
  const body = [{ title: "Notes", path: "notes.md" }];
  const first = run("turn-1").reportFiles as { home: string; copyDir: string };
  const second = run("turn-2").reportFiles as { home: string; copyDir: string };
  expect(first.copyDir).not.toBe(second.copyDir);
  for (const c of [first, second]) {
    const r = checkReportFiles(body, { ...c, scratchDir: scratch });
    expect(r).toHaveProperty("files");
  }
});
