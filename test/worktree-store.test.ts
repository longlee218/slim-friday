import { expect, test } from "bun:test";
import {
  deleteWorktree,
  getWorktreeByTask,
  getWorktreeByThread,
  insertWorktree,
  setPrUrl,
} from "../src/storage/worktree-store";
import { makeEnv } from "./helpers";

const row = (taskId: string, threadId: string, createdAt: number) => ({
  taskId,
  threadId,
  repo: "r",
  repoPath: "/r",
  path: `/w/${taskId}`,
  branch: `agent/${taskId}`,
  base: "main",
  createdAt,
});

test("worktree store CRUD; thread lookup returns latest", () => {
  const { db } = makeEnv();
  expect(getWorktreeByThread(db, "th")).toBeNull();
  insertWorktree(db, row("a", "th", 1));
  insertWorktree(db, row("b", "th", 2));
  expect(getWorktreeByThread(db, "th")?.taskId).toBe("b");
  expect(getWorktreeByTask(db, "a")).toMatchObject({ branch: "agent/a", prUrl: null });
  setPrUrl(db, "a", "https://pr");
  expect(getWorktreeByTask(db, "a")?.prUrl).toBe("https://pr");
  deleteWorktree(db, "b");
  expect(getWorktreeByThread(db, "th")?.taskId).toBe("a");
  expect(getWorktreeByTask(db, "b")).toBeNull();
});
