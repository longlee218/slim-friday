import { expect, test } from "bun:test";
import { openDb } from "../src/storage/db";
import {
  bumpCycle,
  deleteThreadSummary,
  getThreadSummary,
  markFlushed,
  needsFlush,
  saveSummary,
  summaryHitId,
  summaryPath,
  THREAD_SUMMARY_MAX_CHARS,
} from "../src/storage/thread-summary-store";

test("save is an upsert per thread; get returns workspace and text", () => {
  const db = openDb(":memory:");
  expect(getThreadSummary(db, "t1")).toBeNull();
  saveSummary(db, "t1", "main", "first", 10);
  saveSummary(db, "t1", "main", "second", 20);
  const row = getThreadSummary(db, "t1");
  expect(row).toMatchObject({ workspace: "main", summary: "second", updated_at: 20, cycle: 0 });
  expect(row?.flushed_cycle).toBe(-1);
});

test("summary is redacted and clipped", () => {
  const db = openDb(":memory:");
  saveSummary(
    db,
    "t1",
    "main",
    `key sk-ant-api03-${"a".repeat(40)} ${"x".repeat(THREAD_SUMMARY_MAX_CHARS * 2)}`,
  );
  const s = getThreadSummary(db, "t1")?.summary ?? "";
  expect(s).not.toContain("sk-ant-api03");
  expect(s.length).toBeLessThanOrEqual(THREAD_SUMMARY_MAX_CHARS);
});

test("no row -> needsFlush true; markFlushed clears it; bumpCycle makes it true again; idempotent", () => {
  const db = openDb(":memory:");
  expect(needsFlush(db, "t1", 0)).toBe(true); // the first compaction must not skip its flush
  markFlushed(db, "t1", "main", 0);
  markFlushed(db, "t1", "main", 0);
  expect(needsFlush(db, "t1", 0)).toBe(false);
  expect(getThreadSummary(db, "t1")).toMatchObject({
    workspace: "main",
    cycle: 0,
    flushed_cycle: 0,
  });
  saveSummary(db, "t1", "main", "s");
  bumpCycle(db, "t1", "main");
  expect(getThreadSummary(db, "t1")).toMatchObject({ cycle: 1, flushed_cycle: 0 });
  expect(needsFlush(db, "t1", 1)).toBe(true);
  markFlushed(db, "t1", "main", 1);
  expect(needsFlush(db, "t1", 1)).toBe(false);
});

test("bumpCycle creates the row when missing and makes needsFlush true after a flush", () => {
  const db = openDb(":memory:");
  bumpCycle(db, "t1", "main");
  expect(getThreadSummary(db, "t1")).toMatchObject({ summary: "", cycle: 1, flushed_cycle: -1 });
  markFlushed(db, "t1", "main", 1);
  expect(needsFlush(db, "t1", 1)).toBe(false);
  bumpCycle(db, "t1", "main");
  expect(needsFlush(db, "t1", 2)).toBe(true);
});

test("markFlushed marks only the given cycle and never moves flushed_cycle back", () => {
  const db = openDb(":memory:");
  bumpCycle(db, "t1", "main");
  bumpCycle(db, "t1", "main"); // cycle 2 queued while flush 1 runs
  markFlushed(db, "t1", "main", 1);
  expect(getThreadSummary(db, "t1")).toMatchObject({ cycle: 2, flushed_cycle: 1 });
  expect(needsFlush(db, "t1", 2)).toBe(true); // flush 2 is not skipped
  markFlushed(db, "t1", "main", 2);
  markFlushed(db, "t1", "main", 1); // a late older flush cannot lower it
  expect(getThreadSummary(db, "t1")).toMatchObject({ flushed_cycle: 2 });
});

test("summary keys are shared helpers", () => {
  expect(summaryPath("th1")).toBe("summary/th1");
  expect(summaryHitId("th1", 3)).toBe("summary/th1@3");
});

test("saveSummary keeps cycle and flushed_cycle", () => {
  const db = openDb(":memory:");
  saveSummary(db, "t1", "main", "a");
  bumpCycle(db, "t1", "main");
  markFlushed(db, "t1", "main", 1);
  saveSummary(db, "t1", "main", "b");
  expect(getThreadSummary(db, "t1")).toMatchObject({ cycle: 1, flushed_cycle: 1 });
});

test("threads and workspaces are isolated; rows only for the touched thread; delete removes the row", () => {
  const db = openDb(":memory:");
  saveSummary(db, "t1", "ws-a", "a");
  saveSummary(db, "t2", "ws-b", "b");
  bumpCycle(db, "t1", "ws-a");
  expect(needsFlush(db, "t2", 0)).toBe(true); // t2 never flushed
  markFlushed(db, "t2", "ws-b", 0);
  expect(needsFlush(db, "t2", 0)).toBe(false);
  expect(getThreadSummary(db, "t2")).toMatchObject({ workspace: "ws-b", cycle: 0 });
  expect(needsFlush(db, "nope", 0)).toBe(true);
  const ws = db
    .query<{ thread_id: string }, [string]>(
      "SELECT thread_id FROM thread_summaries WHERE workspace = ?",
    )
    .all("ws-a");
  expect(ws.map((r) => r.thread_id)).toEqual(["t1"]);
  deleteThreadSummary(db, "t1");
  expect(getThreadSummary(db, "t1")).toBeNull();
  expect(getThreadSummary(db, "t2")).not.toBeNull();
});
