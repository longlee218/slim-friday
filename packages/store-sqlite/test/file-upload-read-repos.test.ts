import { expect, test } from "bun:test";
import type { FileRow, UploadRow } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

const fresh = () => openEngineStore(":memory:");
const upload = (id: string, at: number, state: UploadRow["state"] = "pending"): UploadRow => ({
  id,
  key: `uploads/bot:a/${id}/x.png`,
  conversationId: "bot:a",
  purpose: "chat",
  name: "x.png",
  mimeType: "image/png",
  size: 3,
  state,
  at,
});

test("files: insert and get; unknown id is undefined", async () => {
  const s = fresh();
  const f: FileRow = {
    id: "f1",
    key: "files/bot:a/f1/x.png",
    conversationId: "bot:a",
    name: "x.png",
    mimeType: "image/png",
    size: 3,
    width: 2,
    height: 4,
    source: "bot",
    at: 1,
  };
  await s.files.insert(f);
  expect(await s.files.get("f1")).toEqual(f);
  expect(await s.files.get("nope")).toBeUndefined();
  const plain: FileRow = { ...f, id: "f2", width: undefined, height: undefined, source: "upload" };
  await s.files.insert(plain);
  expect((await s.files.get("f2"))?.width).toBeUndefined();
  expect(await s.files.hasKey(f.key)).toBe(true);
  expect(await s.files.hasKey("no/such/key")).toBe(false);
});

test("uploads: insert, markUsed, pendingBefore, delete", async () => {
  const s = fresh();
  await s.uploads.insert(upload("u1", 1));
  await s.uploads.insert(upload("u5", 5));
  await s.uploads.insert(upload("u2", 2, "used"));
  await s.uploads.insert({ ...upload("av", 3), conversationId: null, purpose: "avatar" });
  expect((await s.uploads.pendingBefore(10)).map((u) => u.id)).toEqual(["u1", "av", "u5"]);
  expect((await s.uploads.pendingBefore(5)).map((u) => u.id)).toEqual(["u1", "av"]);
  await s.uploads.markUsed("u1", 7);
  expect(await s.uploads.get("u1")).toMatchObject({ state: "used", messageId: 7 });
  expect((await s.uploads.get("av"))?.conversationId).toBeNull();
  await s.uploads.delete("u5");
  expect(await s.uploads.get("u5")).toBeUndefined();
  expect(await s.uploads.get("none")).toBeUndefined();
});

test("unread counts bot and system messages after the read position; set never goes back", async () => {
  const s = fresh();
  const c = "bot:a";
  const add = (author: { kind: "user" } | { kind: "bot"; botId: string } | { kind: "system" }) =>
    s.messages.append({ conversationId: c, author, text: "t", at: 1 });
  await add({ kind: "user" });
  await add({ kind: "bot", botId: "a" });
  await add({ kind: "system" });
  await add({ kind: "bot", botId: "a" });
  await s.messages.append({
    conversationId: "bot:b",
    author: { kind: "system" },
    text: "t",
    at: 1,
  });
  expect(await s.reads.get(c)).toBe(0);
  expect(await s.reads.unread(c)).toBe(3);
  await s.reads.set(c, 2);
  expect(await s.reads.unread(c)).toBe(2);
  await s.reads.set(c, 1);
  expect(await s.reads.get(c)).toBe(2);
});

test("uploads: claim is atomic, release gives it back; files: delete", async () => {
  const s = fresh();
  await s.uploads.insert(upload("c1", 1));
  expect(await s.uploads.claim("c1")).toBe(true);
  expect(await s.uploads.claim("c1")).toBe(false);
  expect((await s.uploads.get("c1"))?.state).toBe("claimed");
  await s.uploads.release("c1");
  expect((await s.uploads.get("c1"))?.state).toBe("pending");
  expect(await s.uploads.claim("c1")).toBe(true);
  await s.uploads.markUsed("c1", 4);
  expect(await s.uploads.claim("c1")).toBe(false);
  await s.uploads.release("c1");
  expect((await s.uploads.get("c1"))?.state).toBe("used");
  expect(await s.uploads.claim("none")).toBe(false);
  await s.files.insert({
    id: "f",
    key: "k",
    conversationId: "bot:a",
    name: "n",
    mimeType: "x",
    size: 1,
    source: "bot",
    at: 1,
  });
  await s.files.delete("f");
  expect(await s.files.get("f")).toBeUndefined();
});

test("uploads: pendingBefore also returns stale claimed rows, never used ones", async () => {
  const s = fresh();
  await s.uploads.insert(upload("p", 1));
  await s.uploads.insert(upload("c", 2));
  await s.uploads.insert(upload("u", 3, "used"));
  await s.uploads.claim("c");
  expect((await s.uploads.pendingBefore(10)).map((u) => u.id)).toEqual(["p", "c"]);
});

test("unread skips messages of intro, ticket and bot-sender runs, but not a card-resumed one", async () => {
  const s = fresh();
  const c = "bot:a";
  const wake = (id: string, over: Record<string, unknown>) =>
    s.wakes.insert({
      id,
      chainId: id,
      conversationId: c,
      targetBot: "a",
      sender: { kind: "user" },
      intent: "request",
      hop: 0,
      text: "t",
      status: "done",
      attempts: 1,
      createdAt: 1,
      scopeKey: "a",
      priority: "interactive",
      leaseFence: 0,
      cuts: 0,
      transientRetries: 0,
      setupFailures: 0,
      nudges: 0,
      ...over,
    } as never);
  await wake("own", {});
  await wake("intro", { intro: true });
  await wake("tick", { ticketId: "FRI-1" });
  await wake("bot", { sender: { kind: "bot", botId: "b" } });
  await wake("botcard", { sender: { kind: "bot", botId: "b" }, cardId: "k1" });
  for (const wakeId of ["own", "intro", "tick", "bot", "botcard", undefined])
    await s.messages.append({
      conversationId: c,
      author: { kind: "bot", botId: "a" },
      text: "t",
      at: 1,
      ...(wakeId && { wakeId }),
    });
  // own, botcard and the message without a wake count.
  expect(await s.reads.unread(c)).toBe(3);
});
