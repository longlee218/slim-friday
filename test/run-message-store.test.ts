import { expect, test } from "bun:test";
import { DAY_MS } from "../src/lifecycle/clone-retention";
import { runStartupHygiene } from "../src/lifecycle/startup";
import {
  insertRunMessage,
  listRunMessages,
  purgeRunMessages,
  RUN_MESSAGE_MAX_CHARS,
  RUN_MESSAGES_RETENTION_DAYS,
  setRunMessageStatus,
} from "../src/storage/run-message-store";
import { makeEnv } from "./helpers";

test("rows keep arrival order per thread (seq), ids and the kind / status given", () => {
  const { db } = makeEnv();
  insertRunMessage(db, {
    threadId: "a",
    kind: "steer",
    content: "one",
    messageId: "m1",
    runId: "r",
    sessionId: "s",
  });
  insertRunMessage(db, {
    threadId: "b",
    kind: "followup",
    status: "delivered",
    content: "other thread",
  });
  insertRunMessage(db, { threadId: "a", kind: "stop", status: "delivered", content: "/stop" });
  expect(listRunMessages(db, "a").map((r) => [r.seq, r.kind, r.status])).toEqual([
    [1, "steer", "pending"],
    [2, "stop", "delivered"],
  ]);
  expect(listRunMessages(db, "a")[0]).toMatchObject({
    messageId: "m1",
    runId: "r",
    sessionId: "s",
  });
  expect(listRunMessages(db, "b")[0]?.seq).toBe(1);
});

test("content is redacted, then capped at RUN_MESSAGE_MAX_CHARS", () => {
  const { db } = makeEnv();
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  insertRunMessage(db, { threadId: "a", kind: "steer", content: `use token ${secret} please` });
  insertRunMessage(db, {
    threadId: "a",
    kind: "steer",
    content: "x".repeat(RUN_MESSAGE_MAX_CHARS * 2),
  });
  insertRunMessage(db, {
    threadId: "a",
    kind: "steer",
    content: `${"y".repeat(RUN_MESSAGE_MAX_CHARS - 10)} ${secret}`, // a secret straddling the cap is not half-kept
  });
  const [a, b, c] = listRunMessages(db, "a");
  expect(a?.content).not.toContain(secret);
  expect(a?.content).toContain("please");
  expect(b?.content.length).toBeLessThanOrEqual(RUN_MESSAGE_MAX_CHARS);
  expect(c?.content.length).toBeLessThanOrEqual(RUN_MESSAGE_MAX_CHARS);
  expect(c?.content).not.toContain("ghp_");
});

test("only a pending row changes status (a final status is never reopened)", () => {
  const { db } = makeEnv();
  const id = insertRunMessage(db, { threadId: "a", kind: "steer", content: "x" });
  expect(setRunMessageStatus(db, id, "delivered")).toBe(true);
  expect(setRunMessageStatus(db, id, "dropped")).toBe(false);
  expect(listRunMessages(db, "a")[0]?.status).toBe("delivered");
});

test("retention: 14 days, rows older than that are purged; startup hygiene runs the purge", async () => {
  expect(RUN_MESSAGES_RETENTION_DAYS).toBe(14);
  const env = makeEnv();
  const { db } = env;
  const now = Date.now();
  insertRunMessage(db, { threadId: "a", kind: "steer", content: "old" }, now - 15 * DAY_MS);
  insertRunMessage(db, { threadId: "a", kind: "steer", content: "edge" }, now - 13 * DAY_MS);
  insertRunMessage(db, { threadId: "a", kind: "steer", content: "new" }, now);
  expect(purgeRunMessages(db, now)).toBe(1);
  expect(listRunMessages(db, "a").map((r) => r.content)).toEqual(["edge", "new"]);
  insertRunMessage(db, { threadId: "a", kind: "steer", content: "ancient" }, now - 30 * DAY_MS);
  await runStartupHygiene(db, env.home);
  expect(listRunMessages(db, "a").map((r) => r.content)).toEqual(["edge", "new"]);
});
