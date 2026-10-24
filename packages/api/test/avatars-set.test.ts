import { expect, test } from "bun:test";
import { ctx, JPG, keyOf, upload, useAvatarHarness, WEBP } from "./helpers/avatar-harness";

useAvatarHarness();

test("avatars.list gives presets with the web bundle url", async () => {
  expect(await ctx.h.client.config.avatars.list()).toEqual([
    { name: "designer", url: "/avatars/designer.webp" },
    { name: "developer", url: "/avatars/developer.webp" },
  ]);
});

test("a preset is saved by name and shows as a local url", async () => {
  const out = await ctx.h.client.config.bots.setAvatar({ id: "dev", preset: "designer" });
  expect(ctx.h.settings.config.lastAvatar).toBe("designer");
  expect(out).toMatchObject({ avatar: "designer", avatarUrl: "/avatars/designer.webp" });
});

test("an upload is saved as upload:<id>, marked used, and shown by its url", async () => {
  const u = await upload("dev", WEBP);
  const out = await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u });
  expect(ctx.h.settings.config.lastAvatar).toBe(`upload:${u}`);
  expect((await ctx.h.store.uploads.get(u))?.state).toBe("used");
  expect(out.avatarUrl).toContain(`avatars/bots/dev/${u}.webp`);
});

test("with a CDN the avatar url is the CDN url", async () => {
  ctx.h.deps.cdnUrl = "https://cdn.example.com";
  const u = await upload("dev", WEBP);
  const out = await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u });
  expect(out.avatarUrl).toBe(`https://cdn.example.com/avatars/bots/dev/${u}.webp`);
});

test("replacing an uploaded avatar deletes the old object and row", async () => {
  const u1 = await upload("dev", WEBP);
  const k1 = await keyOf(u1);
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u1 });
  const u2 = await upload("dev", JPG, "image/jpeg");
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u2 });
  expect(await ctx.h.files.stat(k1)).toBeUndefined();
  expect(await ctx.h.store.uploads.get(u1)).toBeUndefined();
  expect(ctx.h.settings.config.lastAvatar).toBe(`upload:${u2}`);
  expect(await ctx.h.files.stat(await keyOf(u2))).toBeDefined();
});

test("switching to a preset deletes the old upload", async () => {
  const u1 = await upload("dev", WEBP);
  const k1 = await keyOf(u1);
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u1 });
  await ctx.h.client.config.bots.setAvatar({ id: "dev", preset: "developer" });
  expect(await ctx.h.files.stat(k1)).toBeUndefined();
});

test("a failed delete of the old object is logged, not thrown", async () => {
  const logged: object[] = [];
  (ctx.h.deps as { log: unknown }).log = {
    info() {},
    warn: (o: object) => logged.push(o),
    error: (o: object) => logged.push(o),
  };
  const u1 = await upload("dev", WEBP);
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u1 });
  const u2 = await upload("dev", WEBP);
  ctx.h.files.failNext("delete");
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u2 });
  expect(ctx.h.settings.config.lastAvatar).toBe(`upload:${u2}`);
  expect(logged.length).toBe(1);
});

test("group none removes the avatar and deletes the old upload", async () => {
  const u = await upload("team", WEBP, "image/webp", "group");
  await ctx.h.client.config.groups.setAvatar({ id: "team", uploadId: u });
  const out = await ctx.h.client.config.groups.setAvatar({ id: "team", none: true });
  expect(ctx.h.settings.config.lastAvatar).toBeNull();
  expect(out.avatar).toBeUndefined();
  expect(out.avatarUrl).toBeUndefined();
  expect(await ctx.h.files.stat(await keyOf(u))).toBeUndefined();
});

test("lists and conversations carry the avatar url", async () => {
  const u = await upload("dev", WEBP);
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u });
  await ctx.h.client.config.bots.setAvatar({ id: "tess", preset: "designer" });
  // The store's bot carries the avatar value too (the engine reads the same file).
  ctx.h.store.botMap.set("dev", {
    ...(ctx.h.store.botMap.get("dev") as object),
    avatar: `upload:${u}`,
  } as never);
  const list = await ctx.h.client.config.bots.list();
  expect(list.find((b) => b.id === "dev")?.avatarUrl).toContain(`${u}.webp`);
  expect(list.find((b) => b.id === "tess")?.avatarUrl).toBe("/avatars/designer.webp");
  expect((await ctx.h.client.config.bots.get({ id: "tess" })).avatarUrl).toBe(
    "/avatars/designer.webp",
  );
});

test("conversations.list carries the avatar url of the bot or group", async () => {
  ctx.h.store.botMap.set("dev", {
    ...(ctx.h.store.botMap.get("dev") as object),
    avatar: "designer",
  } as never);
  ctx.h.store.convMap.set("bot:dev", { id: "bot:dev", kind: "direct", botId: "dev" } as never);
  const [c] = await ctx.h.client.conversations.list();
  expect(c?.avatarUrl).toBe("/avatars/designer.webp");
});
