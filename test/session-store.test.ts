import { expect, test } from "bun:test";
import { getSession, setSession } from "../src/storage/session-store";
import { makeEnv } from "./helpers";

test("get returns null for unknown thread", () => {
  expect(getSession(makeEnv().db, "nope")).toBeNull();
});

test("set then get, then upsert replaces session id", () => {
  const { db } = makeEnv();
  setSession(db, { threadId: "t1", sessionId: "s1", location: "r", cwd: "/r" });
  expect(getSession(db, "t1")?.session_id).toBe("s1");
  setSession(db, { threadId: "t1", sessionId: "s2", location: "r", cwd: "/r" });
  expect(getSession(db, "t1")?.session_id).toBe("s2");
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
});

test("session survives reopening the db file (restart)", async () => {
  const { db, paths } = makeEnv();
  setSession(db, { threadId: "t1", sessionId: "s1", location: "r", cwd: "/r" });
  db.close();
  const { openDb } = await import("../src/storage/db");
  expect(getSession(openDb(paths.dbFile), "t1")?.session_id).toBe("s1");
});
