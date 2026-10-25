import { expect, test } from "bun:test";
import { ctx, JPG, keyOf, upload, useAvatarHarness, WEBP } from "./helpers/avatar-harness";

useAvatarHarness();

const CHAT_ID = "c0a80101-0000-4000-8000-0000000000aa";
const avatarId = () => (ctx.h.settings.config.lastAvatar as string).replace("upload:", "");

test("the avatar is a server-owned copy: new id, new key, server-set type, original deleted", async () => {
  const u = await upload("dev", WEBP);
  const original = await keyOf(u);
  await ctx.h.files.put(original, WEBP, "text/html"); // the client chose the type
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u });
  expect(avatarId()).not.toBe(u);
  const row = await ctx.h.store.uploads.get(avatarId());
  expect(row).toMatchObject({ purpose: "avatar", state: "used", conversationId: null });
  expect(row?.key).toBe(`avatars/bots/dev/${avatarId()}.webp`);
  expect((await ctx.h.files.stat(row?.key as string))?.contentType).toBe("image/webp");
  expect(await ctx.h.files.stat(original)).toBeUndefined();
  expect(await ctx.h.store.uploads.get(u)).toBeUndefined();
});

test("a jpeg copy gets the jpeg type and .jpg", async () => {
  const u = await upload("dev", JPG, "image/jpeg");
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u });
  const row = await ctx.h.store.uploads.get(avatarId());
  expect(row?.key.endsWith(".jpg")).toBe(true);
  expect((await ctx.h.files.stat(row?.key as string))?.contentType).toBe("image/jpeg");
});

test("a later PUT to the original key does not change the avatar", async () => {
  const u = await upload("dev", WEBP);
  const original = await keyOf(u);
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u });
  await ctx.h.files.put(original, new TextEncoder().encode("<script>x</script>"), "text/html");
  const copy = await ctx.h.files.read((await ctx.h.store.uploads.get(avatarId()))?.key as string);
  expect(Array.from(copy)).toEqual(Array.from(WEBP));
});

test("a failed config write removes the copy and rethrows", async () => {
  const u = await upload("dev", WEBP);
  ctx.h.settings.config.failWith = new (await import("@friday/core")).AdminError("NOT_FOUND", "x");
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const keys = [...ctx.h.files.objects.keys()].filter(
    (k) => k !== ctx.h.store.uploadMap.get(u)?.key,
  );
  expect(keys).toEqual([]);
  expect([...ctx.h.store.uploadMap.keys()]).toEqual([u]);
});

/** A chat upload row (not an avatar) and a file under `uploads/`. */
async function chatUpload() {
  const key = `uploads/c1/${CHAT_ID}/a.png`;
  await ctx.h.files.put(key, WEBP, "image/png");
  await ctx.h.store.uploads.insert({
    id: CHAT_ID,
    key,
    conversationId: "c1",
    purpose: "chat",
    name: "a.png",
    mimeType: "image/png",
    size: 5,
    state: "used",
    at: 1,
  });
  return key;
}

test("previous = a chat upload id deletes nothing", async () => {
  const key = await chatUpload();
  const dev = ctx.h.settings.config.bots.get("dev");
  if (dev) dev.avatar = `upload:${CHAT_ID}`;
  await ctx.h.client.config.bots.setAvatar({ id: "dev", preset: "designer" });
  expect(await ctx.h.files.stat(key)).toBeDefined();
  expect(await ctx.h.store.uploads.get(CHAT_ID)).toBeDefined();
});

test("previous = another bot's avatar upload deletes nothing", async () => {
  const u = await upload("tess", WEBP);
  await ctx.h.client.config.bots.setAvatar({ id: "tess", uploadId: u });
  const tessId = avatarId();
  const dev = ctx.h.settings.config.bots.get("dev");
  if (dev) dev.avatar = `upload:${tessId}`;
  await ctx.h.client.config.bots.setAvatar({ id: "dev", preset: "designer" });
  expect(await ctx.h.store.uploads.get(tessId)).toBeDefined();
});

test("the list gives no url for a chat upload id", async () => {
  await chatUpload();
  const dev = ctx.h.settings.config.bots.get("dev");
  if (dev) dev.avatar = `upload:${CHAT_ID}`;
  const list = await ctx.h.client.config.bots.list();
  expect(list.find((b) => b.id === "dev")?.avatarUrl).toBeUndefined();
});

test("the list gives no url for another bot's avatar", async () => {
  const u = await upload("tess", WEBP);
  await ctx.h.client.config.bots.setAvatar({ id: "tess", uploadId: u });
  const dev = ctx.h.settings.config.bots.get("dev");
  if (dev) dev.avatar = ctx.h.settings.config.lastAvatar as string;
  const list = await ctx.h.client.config.bots.list();
  expect(list.find((b) => b.id === "dev")?.avatarUrl).toBeUndefined();
});
