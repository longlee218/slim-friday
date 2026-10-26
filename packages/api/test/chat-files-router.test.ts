import { expect, test } from "bun:test";
import { engineHarness } from "./helpers/engine-deps";

/** A harness with a direct conversation with bot a. */
function setup() {
  const h = engineHarness();
  h.addBot("a", "Ann");
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  return h;
}

const ID = "11111111-1111-4111-8111-111111111111";

/** Seed a stored file row. */
async function seedFile(h: ReturnType<typeof setup>, id: string, name: string, mimeType: string) {
  await h.store.files.insert({
    id,
    key: `files/bot:a/${id}/${name}`,
    conversationId: "bot:a",
    name,
    mimeType,
    size: 3,
    source: "bot",
    at: 1,
  });
}

/** Seed an owner upload row. */
async function seedUpload(h: ReturnType<typeof setup>, id: string, at: number, mimeType: string) {
  await h.store.files.insert({
    id,
    key: `files/bot:a/${id}/x`,
    conversationId: "bot:a",
    name: "x",
    mimeType,
    size: 3,
    source: "upload",
    at,
  });
}

test("files: a garbage cursor is BAD_REQUEST", async () => {
  const h = setup();
  await expect(h.client.chat.files({ cursor: "not-a-cursor" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  const wrongShape = Buffer.from(JSON.stringify({ at: "x" })).toString("base64url");
  await expect(h.client.chat.files({ cursor: wrongShape })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("files: limit 0 or above the page cap is rejected", async () => {
  const h = setup();
  await expect(h.client.chat.files({ limit: 0 })).rejects.toBeDefined();
  await expect(h.client.chat.files({ limit: 101 })).rejects.toBeDefined();
});

test("files: no uploads gives an empty list and no cursor", async () => {
  const h = setup();
  expect(await h.client.chat.files({})).toEqual({ items: [] });
});

test("files: bot rows are not listed", async () => {
  const h = setup();
  await seedFile(h, ID, "pic.png", "image/png");
  expect((await h.client.chat.files({})).items).toEqual([]);
});

test("files: pages with an opaque cursor, last page has none, dto has kind, conversationId, at", async () => {
  const h = setup();
  await seedUpload(h, "a", 7, "image/png");
  await seedUpload(h, "b", 7, "application/pdf");
  await seedUpload(h, "c", 7, "text/plain");
  const p1 = await h.client.chat.files({ limit: 2 });
  expect(p1.items.map((i) => i.id)).toEqual(["c", "b"]);
  expect(p1.items[0]).toMatchObject({ kind: "file", conversationId: "bot:a", at: 7 });
  expect(p1.nextCursor).toBeString();
  const p2 = await h.client.chat.files({ limit: 2, cursor: p1.nextCursor });
  expect(p2.items.map((i) => i.id)).toEqual(["a"]);
  expect(p2.items[0]?.kind).toBe("image");
  expect(p2.nextCursor).toBeUndefined();
});

test("files: kind filter", async () => {
  const h = setup();
  await seedUpload(h, "a", 1, "image/png");
  await seedUpload(h, "b", 2, "application/pdf");
  expect((await h.client.chat.files({ kind: "pdf" })).items.map((i) => i.id)).toEqual(["b"]);
});

test("files: a cursor over 256 characters is rejected", async () => {
  const h = setup();
  const long = Buffer.from(JSON.stringify({ at: 1, id: "a".repeat(300) })).toString("base64url");
  await expect(h.client.chat.files({ cursor: long })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});
