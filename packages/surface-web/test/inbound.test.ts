import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InboundMessage, UploadRow } from "@friday/core";
import { FakeClock } from "../../core/test/fakes/fake-clock";
import { FakeFileStore } from "../../core/test/fakes/fake-file-store";
import { FakeStore } from "../../core/test/fakes/fake-store";
import { WebSurface } from "../src/web-surface";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const MAX = 20 * 1024 * 1024;

let store: FakeStore;
let fileStore: FakeFileStore;
let surface: WebSurface;
let handled: InboundMessage[];
let inbox: string;

/** Seed a pending upload row and (unless `object` is false) its stored object. */
async function seed(
  id: string,
  o: Partial<UploadRow> & { bytes?: Uint8Array; object?: boolean } = {},
): Promise<string> {
  const key = `uploads/bot:a/${id}/f.bin`;
  const { bytes, object, ...row } = o;
  await store.uploads.insert({
    id,
    key,
    conversationId: "bot:a",
    purpose: "chat",
    name: "f.bin",
    mimeType: "application/octet-stream",
    size: 3,
    state: "pending",
    at: 1,
    ...row,
  });
  if (object !== false) {
    await fileStore.put(key, bytes ?? new Uint8Array([1, 2, 3]), row.mimeType ?? "x");
  }
  return key;
}

const send = (uploadIds: string[], extra: object = {}) =>
  surface.send({ conversationId: "bot:a", text: "t", uploadIds, ...extra });

beforeEach(async () => {
  store = new FakeStore();
  store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  fileStore = new FakeFileStore();
  inbox = mkdtempSync(join(tmpdir(), "ws-in-"));
  surface = new WebSurface({
    store,
    files: fileStore,
    clock: new FakeClock(5000),
    inboxDir: inbox,
  });
  handled = [];
  surface.onMessage(async (m) => {
    handled.push(m);
    return 7;
  });
});

test("createUpload refuses an unknown conversation and a bad size", async () => {
  const i = { name: "a", type: "text/plain" };
  await expect(
    surface.createUpload({ ...i, conversationId: "bot:x", size: 1 }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    surface.createUpload({ ...i, conversationId: "bot:a", size: MAX + 1 }),
  ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  await expect(
    surface.createUpload({ ...i, conversationId: "bot:a", size: 0 }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("createUpload stores a pending row and presigns the engine's key", async () => {
  const r = await surface.createUpload({
    conversationId: "bot:a",
    name: "../a b.txt",
    type: "text/plain",
    size: 4,
  });
  const row = await store.uploads.get(r.uploadId);
  expect(row).toMatchObject({
    purpose: "chat",
    state: "pending",
    conversationId: "bot:a",
    key: `uploads/bot:a/${r.uploadId}/b.txt`.replace("b.txt", "a_b.txt"),
  });
  expect(r.putUrl).toContain(`${row?.key}?exp=600`);
});

test("send refuses an unknown conversation, empty input and a foreign reply", async () => {
  await expect(surface.send({ conversationId: "bot:x", text: "t" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(surface.send({ conversationId: "bot:a", text: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  const id = await store.messages.append({
    conversationId: "bot:b",
    author: { kind: "user" },
    text: "x",
    at: 1,
  });
  await expect(
    surface.send({ conversationId: "bot:a", text: "t", replyTo: id }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "reply to a message of this conversation",
  });
  expect(handled).toEqual([]);
});

test("send refuses 6 files and duplicates", async () => {
  const ids = ["1", "2", "3", "4", "5", "6"];
  for (const id of ids) await seed(id);
  await expect(send(ids)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(send(["1", "1"])).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(handled).toEqual([]);
});

test("send refuses unknown, foreign and avatar uploads alike, and a used one", async () => {
  await seed("foreign", { conversationId: "bot:b" });
  await seed("avatar", { purpose: "avatar", conversationId: null });
  await seed("used", { state: "used" });
  for (const id of ["nope", "foreign", "avatar"]) {
    await expect(send([id])).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  await expect(send(["used"])).rejects.toMatchObject({ code: "CONFLICT" });
  expect(handled).toEqual([]);
});

test("send refuses a missing object", async () => {
  await seed("m", { object: false });
  await expect(send(["m"])).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "upload not received",
  });
});

test("send deletes an object stored larger than the cap", async () => {
  const key = await seed("big", { bytes: new Uint8Array(MAX + 1), size: 10 });
  await expect(send(["big"])).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  expect(fileStore.deleted).toContain(key);
  expect(await store.uploads.get("big")).toBeUndefined();
  expect(handled).toEqual([]);
});

test("send refuses an image whose bytes are not an image, before any write", async () => {
  await seed("img", { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) });
  await seed("ok", { mimeType: "image/png", bytes: PNG, size: PNG.length });
  await expect(send(["ok", "img"])).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await Bun.file(join(inbox, "bot:a")).exists()).toBe(false);
  expect(handled).toEqual([]);
  expect((await store.uploads.get("ok"))?.state).toBe("pending");
});

test("happy path: saved under inbox, files rows, upload used, handler gets both", async () => {
  await seed("png", { mimeType: "image/png", bytes: PNG, size: PNG.length });
  const { messageId } = await send(["png"], { text: "look" });
  expect(messageId).toBe(7);
  const path = handled[0]?.attachments?.[0]?.path as string;
  expect(handled[0]).toMatchObject({
    text: "look",
    files: [{ mimeType: "image/png", size: PNG.length }],
    attachments: [
      { name: "1-f.bin", path: expect.stringMatching(/\/bot:a\/5000-[0-9a-f]{8}\/1-f\.bin$/) },
    ],
  });
  expect(readFileSync(path)).toEqual(PNG);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  const fileId = handled[0]?.files?.[0]?.fileId as string;
  expect(await store.files.get(fileId)).toMatchObject({
    source: "upload",
    conversationId: "bot:a",
  });
  expect(await store.uploads.get("png")).toMatchObject({ state: "used", messageId });
});

test("an image upload carries its pixel size; a non-image has none", async () => {
  await seed("png", { mimeType: "image/png", bytes: PNG, size: PNG.length });
  await send(["png"]);
  expect(handled[0]?.files?.[0]).toMatchObject({ width: 1, height: 1 });
  await seed("bin");
  await send(["bin"]);
  expect(handled[1]?.files?.[0]?.width).toBeUndefined();
});

test("a handler that stores nothing is NOT_FOUND and leaves uploads pending", async () => {
  surface.onMessage(async () => undefined);
  await seed("p");
  await expect(send(["p"])).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await store.uploads.get("p"))?.state).toBe("pending");
});

test("an object replaced between stat and read is refused, nothing written", async () => {
  const key = await seed("sw", { mimeType: "image/png", bytes: PNG, size: PNG.length });
  const read = fileStore.read.bind(fileStore);
  fileStore.read = async (k) => {
    fileStore.objects.set(key, { data: new Uint8Array(PNG.length + 5), contentType: "x" });
    return read(k);
  };
  await expect(send(["sw"])).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await Bun.file(join(inbox, "bot:a")).exists()).toBe(false);
  expect(handled).toEqual([]);
  // Same length but no longer an image.
  fileStore.read = async (k) => {
    fileStore.objects.set(key, { data: new Uint8Array(PNG.length), contentType: "x" });
    return read(k);
  };
  await expect(send(["sw"])).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await store.uploads.get("sw"))?.state).toBe("pending");
  expect(handled).toEqual([]);
});

test("two concurrent sends of one upload: one wins, the other CONFLICT", async () => {
  await seed("race");
  const r = await Promise.allSettled([send(["race"]), send(["race"])]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const lost = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
  expect(lost.reason).toMatchObject({ code: "CONFLICT" });
  expect(handled).toHaveLength(1);
  expect((await store.uploads.get("race"))?.state).toBe("used");
});

test("a failing handler removes the files rows and releases the upload", async () => {
  await seed("h");
  surface.onMessage(async () => {
    throw new Error("boom");
  });
  await expect(send(["h"])).rejects.toThrow("boom");
  expect(store.fileMap.size).toBe(0);
  expect((await store.uploads.get("h"))?.state).toBe("pending");
});
