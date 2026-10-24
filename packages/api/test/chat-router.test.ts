import { expect, test } from "bun:test";
import { engineHarness } from "./helpers/engine-deps";

const MB = 1024 * 1024;

/** A harness with a direct conversation with bot a. */
function setup() {
  const h = engineHarness();
  h.addBot("a", "Ann");
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  return h;
}

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

const ID = "11111111-1111-4111-8111-111111111111";

test("file of an unknown id is NOT_FOUND and presigns nothing", async () => {
  const h = setup();
  await expect(h.client.chat.file({ id: ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("uploadCreate over the cap is PAYLOAD_TOO_LARGE", async () => {
  const h = setup();
  await expect(
    h.client.chat.uploadCreate({
      conversationId: "bot:a",
      name: "big.bin",
      type: "application/octet-stream",
      size: 20 * MB + 1,
    }),
  ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
});

test("uploadCreate of an unknown conversation is NOT_FOUND", async () => {
  const h = setup();
  await expect(
    h.client.chat.uploadCreate({
      conversationId: "bot:x",
      name: "a.txt",
      type: "text/plain",
      size: 1,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("uploadCreate returns an id and a put url", async () => {
  const h = setup();
  const t = await h.client.chat.uploadCreate({
    conversationId: "bot:a",
    name: "a.txt",
    type: "text/plain",
    size: 5,
  });
  expect(t.uploadId).toMatch(/^[0-9a-f-]{36}$/);
  expect(t.putUrl).toContain(`uploads/bot:a/${t.uploadId}/a.txt`);
});

test("send of an unknown upload id maps the surface error, replyTo of another conversation is BAD_REQUEST", async () => {
  const h = setup();
  h.store.convMap.set("bot:b", { id: "bot:b", kind: "direct", botId: "b" });
  const other = await h.store.messages.append({
    conversationId: "bot:b",
    author: { kind: "user" },
    text: "x",
    at: 1,
  });
  await expect(
    h.client.chat.send({ conversationId: "bot:a", text: "hi", replyTo: other }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("send returns the id of the stored owner message", async () => {
  const h = setup();
  let seen = "";
  h.surface.onMessage(async (m) => {
    seen = m.text;
    return await h.store.messages.append({
      conversationId: m.conversationId,
      author: { kind: "user" },
      text: m.text,
      at: 1,
    });
  });
  const { messageId } = await h.client.chat.send({ conversationId: "bot:a", text: "hello" });
  expect(seen).toBe("hello");
  expect((await h.store.messages.get(messageId))?.text).toBe("hello");
});

test("file: an image has no dl, a pdf has dl=report.pdf, both exp=900", async () => {
  const h = setup();
  await seedFile(h, ID, "pic.png", "image/png");
  const pdf = "22222222-2222-4222-8222-222222222222";
  await seedFile(h, pdf, "report.pdf", "application/pdf");
  const img = await h.client.chat.file({ id: ID });
  expect(img.url).toContain("exp=900");
  expect(img.url).not.toContain("dl=");
  const doc = await h.client.chat.file({ id: pdf });
  expect(doc.url).toContain("exp=900");
  expect(doc.url).toContain("dl=report.pdf");
});

const CDN = "https://img.example.com";

test("file: an image with cdnUrl is served from the CDN, nothing presigned", async () => {
  const h = setup();
  h.deps.cdnUrl = CDN;
  await seedFile(h, ID, "pic.png", "image/png");
  const res = await h.client.chat.file({ id: ID });
  expect(res.url).toBe(`${CDN}/files/bot%3Aa/${ID}/pic.png`);
});

test("file: a key with a space or colon is encoded per segment", async () => {
  const h = setup();
  h.deps.cdnUrl = CDN;
  await h.store.files.insert({
    id: ID,
    key: "files/bot:a/x y/p:q.png",
    conversationId: "bot:a",
    name: "p:q.png",
    mimeType: "image/png",
    size: 3,
    source: "bot",
    at: 1,
  });
  expect((await h.client.chat.file({ id: ID })).url).toBe(`${CDN}/files/bot%3Aa/x%20y/p%3Aq.png`);
});

test("file: a pdf with cdnUrl is still presigned with dl=", async () => {
  const h = setup();
  h.deps.cdnUrl = CDN;
  await seedFile(h, ID, "report.pdf", "application/pdf");
  const res = await h.client.chat.file({ id: ID });
  expect(res.url).not.toContain(CDN);
  expect(res.url).toContain("dl=report.pdf");
});

test("file: an image without cdnUrl is presigned", async () => {
  const h = setup();
  await seedFile(h, ID, "pic.png", "image/png");
  expect((await h.client.chat.file({ id: ID })).url).toContain("exp=900");
});
