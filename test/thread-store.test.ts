import { expect, test } from "bun:test";
import { openDb } from "../src/storage/db";
import {
  adoptThread,
  getThread,
  isAdopted,
  recordBotThread,
  saveTitle,
} from "../src/storage/thread-store";

test("recordBotThread stores origin bot, placeholder, channel and workspace", () => {
  const db = openDb(":memory:");
  expect(getThread(db, "t1")).toBeNull();
  recordBotThread(db, "t1", "c1", "main", "⏳ 10-14 08:58", 5);
  expect(getThread(db, "t1")).toMatchObject({
    channel_id: "c1",
    workspace: "main",
    origin: "bot",
    placeholder: "⏳ 10-14 08:58",
    title: null,
    created_at: 5,
    updated_at: 5,
  });
  expect(isAdopted(db, "t1")).toBe(false);
});

test("adoptThread inserts origin adopted once; a bot thread is never turned into adopted", () => {
  const db = openDb(":memory:");
  adoptThread(db, "t2", "c1", "main", 1);
  adoptThread(db, "t2", "c9", "other", 2);
  expect(isAdopted(db, "t2")).toBe(true);
  expect(getThread(db, "t2")).toMatchObject({
    channel_id: "c1",
    origin: "adopted",
    placeholder: null,
  });
  recordBotThread(db, "t3", "c1", "main", "p");
  adoptThread(db, "t3", "c1", "main");
  expect(isAdopted(db, "t3")).toBe(false);
  expect(isAdopted(db, "unknown")).toBe(false);
});

test("saveTitle overwrites title and digest, bumps updated_at, keeps the rest", () => {
  const db = openDb(":memory:");
  recordBotThread(db, "t1", "c1", "main", "p", 1);
  saveTitle(db, "t1", "First", "d1", 10);
  saveTitle(db, "t1", "Second", "d2", 20);
  expect(getThread(db, "t1")).toMatchObject({
    title: "Second",
    digest: "d2",
    placeholder: "p",
    channel_id: "c1",
    created_at: 1,
    updated_at: 20,
  });
});

test("saveTitle creates the row when the thread is unknown", () => {
  const db = openDb(":memory:");
  saveTitle(db, "tx", "T", "D", 7);
  expect(getThread(db, "tx")).toMatchObject({
    title: "T",
    digest: "D",
    origin: "bot",
    created_at: 7,
  });
});

test("saveTitle creates an unknown row with the real channel and workspace, and backfills empty ones", () => {
  const db = openDb(":memory:");
  saveTitle(db, "ty", "T", "D", 7, "chan1", "main");
  expect(getThread(db, "ty")).toMatchObject({ channel_id: "chan1", workspace: "main" });
  saveTitle(db, "tz", "T", "D", 7); // channel unknown: '' (readers ignore it)
  saveTitle(db, "tz", "T2", "D2", 8, "chan2", "ws");
  expect(getThread(db, "tz")).toMatchObject({ channel_id: "chan2", workspace: "ws", title: "T2" });
  saveTitle(db, "tz", "T3", "D3", 9, "other", "other"); // a filled row keeps its channel
  expect(getThread(db, "tz")).toMatchObject({ channel_id: "chan2", workspace: "ws" });
});
