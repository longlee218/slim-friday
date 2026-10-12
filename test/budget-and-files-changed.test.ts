import { expect, test } from "bun:test";
import { BUDGET_SUMMARY_MAX, budgetHitMessage } from "../src/orchestrator/engine/budget";
import { openDb } from "../src/storage/db";
import { filesChangedText, parseDiffstat, recordFilesChanged } from "../src/storage/files-changed";
import { threadLedger } from "../src/storage/ledger-store";
import { insertTurn } from "../src/storage/run-store";
import { insertWorktree } from "../src/storage/worktree-store";

// Budget-hit message parts and the ledger's files-changed line (P2.2 part B).

test("budget message: caps the summary, keeps the overshoot note and the go offer; no diff stat (the app runs no git on the repo)", () => {
  const text = budgetHitMessage({
    spentUsd: 3.21,
    limitUsd: 3,
    summary: "x".repeat(5000),
    goPlusUsd: 3,
  });
  expect(text).toContain("$3.21 of $3.00");
  expect(text).toContain("small overshoot");
  expect(text).toContain("`/go +3`");
  expect(text).not.toContain("Changes so far");
  expect(text.length).toBeLessThan(BUDGET_SUMMARY_MAX + 600);
});

test("budget message without summary / limit: only the facts that are known", () => {
  const text = budgetHitMessage({});
  expect(text).toContain("? of ?");
  expect(text).not.toContain("Last summary");
  expect(text).not.toContain("Changes so far");
  expect(text).not.toContain("/go +");
});

test("parseDiffstat: count, top paths by size; binary and empty input", () => {
  const stat = [
    " a.ts      |  2 +-",
    " dir/b.ts  | 30 +++++++++",
    " c.png     | Bin 0 -> 12 bytes",
    " d.ts      |  9 ++++",
    " e.ts      |  1 +",
    " 5 files changed, 42 insertions(+), 1 deletion(-)",
  ].join("\n");
  expect(parseDiffstat(stat)).toEqual({ count: 5, top: ["dir/b.ts", "d.ts", "a.ts"] });
  expect(parseDiffstat("")).toEqual({ count: 0, top: [] });
});

test("ledger shows files changed (count + top paths, capped) once a diffstat is recorded", () => {
  const db = openDb(":memory:");
  insertTurn(db, { id: "t-1", threadId: "th", source: "d", repo: "r", role: "dev" });
  db.query("UPDATE turns SET counts_toward_cap = 1 WHERE id = 't-1'").run();
  insertWorktree(db, {
    taskId: "t-1",
    threadId: "th",
    repo: "r",
    repoPath: "/r",
    path: "/c",
    branch: "friday/x",
    base: "main",
  });
  expect(threadLedger(db, "th")).not.toContain("files changed");
  recordFilesChanged(
    db,
    "t-1",
    " a.ts | 2 +-\n b.ts | 9 +++\n c.ts | 1 +\n d.ts | 4 ++\n 4 files changed",
  );
  expect(filesChangedText(db, "t-1")).toBe("4 (b.ts, d.ts, a.ts +1 more)");
  expect(threadLedger(db, "th")).toContain("files changed: 4 (b.ts, d.ts, a.ts +1 more)");
});
