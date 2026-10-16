import { expect, test } from "bun:test";
import { expireHeldTasks } from "../src/lifecycle/startup";
import { insertTurn } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

/* How a `failed_resumable` row left by an older version expires at startup (nothing writes that status any more). */

test("hold expiry: a non-uuid id is skipped for rm but still failed; a throwing rm does not stop the next id", () => {
  const env = makeEnv();
  const ids = ["not-a-uuid", crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) {
    insertTurn(env.db, { id, threadId: id, source: "t", location: "real", role: "developer" });
    env.db
      .query("UPDATE turns SET status = 'failed_resumable', started_at = 1 WHERE id = ?")
      .run(id);
  }
  const removed: string[] = [];
  const rm = (dir: string) => {
    if (dir.includes(ids[1]!)) throw new Error("EACCES");
    removed.push(dir);
  };
  expect(expireHeldTasks(env.db, env.config.agentHome, Date.now(), rm).sort()).toEqual(
    [...ids].sort(),
  );
  const st = env.db.query("SELECT id, status FROM turns").all() as { id: string; status: string }[];
  expect(st.every((r) => r.status === "failed")).toBe(true);
  expect(removed.length).toBeGreaterThan(0);
  expect(removed.every((d) => d.includes(ids[2]!))).toBe(true); // the uuid after the failing one was still processed
});
