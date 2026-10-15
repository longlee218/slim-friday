import { expect, test } from "bun:test";
import { expireHeldTasks } from "../src/lifecycle/startup";
import { type FlowResult, RESUMABLE, resumeReasonOf } from "../src/orchestrator/turns/turn-result";
import { insertTurn } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

/* `failed_resumable`: which failures qualify, and how a held task expires. The resume / `/go` / yes flows went with the
   intent layer; the lead now decides what to do with a failed worker. */

test("which failures qualify: the reasons table, and nothing else", () => {
  const r = (over: Partial<FlowResult>): FlowResult => ({
    text: "",
    outcome: "error",
    sessionId: undefined,
    ...over,
  });
  expect(Object.keys(RESUMABLE)).toEqual(["budget", "error"]); // no config reason any more
  expect(resumeReasonOf(r({ outcome: "error" }))).toBe("error");
  expect(resumeReasonOf(r({ outcome: "max_budget" }))).toBe("budget");
  // owner stop, restart (also `aborted`), timeout, quota, turn limit, success: never
  for (const outcome of ["aborted", "timeout", "quota", "max_turns", "success"] as const)
    expect(resumeReasonOf(r({ outcome }))).toBeUndefined();
});

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
