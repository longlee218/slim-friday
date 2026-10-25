import { expect, test } from "bun:test";
import { MAX_AVATAR_BYTES } from "@friday/contracts";
import { ctx, JPG, keyOf, PNG, upload, useAvatarHarness, WEBP } from "./helpers/avatar-harness";

useAvatarHarness();

test("declared size over 2 MB refused before presign", async () => {
  await expect(
    ctx.h.client.config.avatars.create({
      kind: "bot",
      id: "dev",
      size: MAX_AVATAR_BYTES + 1,
      type: "image/webp",
    }),
  ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  expect(ctx.h.store.uploadMap.size).toBe(0);
});

test("create for an unknown bot or group is NOT_FOUND", async () => {
  await expect(
    ctx.h.client.config.avatars.create({ kind: "bot", id: "nobody", size: 10, type: "image/webp" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    ctx.h.client.config.avatars.create({ kind: "group", id: "dev", size: 10, type: "image/webp" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("create makes the key and a pending avatar row; jpeg gets .jpg", async () => {
  const a = await ctx.h.client.config.avatars.create({
    kind: "bot",
    id: "dev",
    size: 10,
    type: "image/webp",
  });
  const b = await ctx.h.client.config.avatars.create({
    kind: "group",
    id: "team",
    size: 10,
    type: "image/jpeg",
  });
  expect(await ctx.h.store.uploads.get(a.uploadId)).toMatchObject({
    purpose: "avatar",
    conversationId: null,
    state: "pending",
    key: `avatars/bots/dev/${a.uploadId}.webp`,
  });
  expect((await ctx.h.store.uploads.get(b.uploadId))?.key).toBe(
    `avatars/groups/team/${b.uploadId}.jpg`,
  );
  expect(a.putUrl).toContain("exp=600");
  expect(b.putUrl).toContain("type=image/jpeg");
});

test("stored object over 2 MB: deleted and refused", async () => {
  const u = await upload("dev", new Uint8Array(3 * 1024 * 1024));
  const key = await keyOf(u);
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u }),
  ).rejects.toMatchObject({
    code: "PAYLOAD_TOO_LARGE",
  });
  expect(await ctx.h.files.stat(key)).toBeUndefined();
  expect(await ctx.h.store.uploads.get(u)).toBeUndefined();
  expect(ctx.h.settings.config.lastAvatar).toBeUndefined();
});

test("PNG bytes behind a .webp key refused and deleted", async () => {
  const u = await upload("dev", PNG);
  const key = await keyOf(u);
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(await ctx.h.files.stat(key)).toBeUndefined();
  expect(await ctx.h.store.uploads.get(u)).toBeUndefined();
});

test("JPEG bytes behind a .webp key refused; WebP bytes behind a .jpg key refused", async () => {
  const a = await upload("dev", JPG, "image/webp");
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: a }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  const b = await upload("dev", WEBP, "image/jpeg");
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: b }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("nothing was uploaded: BAD_REQUEST", async () => {
  const { uploadId } = await ctx.h.client.config.avatars.create({
    kind: "bot",
    id: "dev",
    size: 10,
    type: "image/webp",
  });
  await expect(ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("foreign id: an upload made for bot tess cannot be set on dev", async () => {
  const u = await upload("tess", WEBP);
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "upload belongs to something else",
  });
  expect(await ctx.h.files.stat(await keyOf(u))).toBeDefined();
});

test("a bot upload cannot be set on a group of the same id kind", async () => {
  const u = await upload("dev", WEBP);
  await expect(
    ctx.h.client.config.groups.setAvatar({ id: "dev", uploadId: u }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("a chat upload cannot become an avatar", async () => {
  await ctx.h.store.uploads.insert({
    id: "c0a80101-0000-4000-8000-000000000001",
    key: "avatars/bots/dev/c0a80101-0000-4000-8000-000000000001.webp",
    conversationId: "x",
    purpose: "chat",
    name: "n",
    mimeType: "image/webp",
    size: 5,
    state: "pending",
    at: 1,
  });
  await ctx.h.files.put(
    "avatars/bots/dev/c0a80101-0000-4000-8000-000000000001.webp",
    WEBP,
    "image/webp",
  );
  await expect(
    ctx.h.client.config.bots.setAvatar({
      id: "dev",
      uploadId: "c0a80101-0000-4000-8000-000000000001",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("an unknown upload is NOT_FOUND", async () => {
  await expect(
    ctx.h.client.config.bots.setAvatar({
      id: "dev",
      uploadId: "c0a80101-0000-4000-8000-0000000000ff",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a used upload cannot be reused (its original is gone)", async () => {
  const u = await upload("dev", WEBP);
  await ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u });
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: u }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  // The avatar's own (used) row cannot be set again either.
  const copy = (ctx.h.settings.config.lastAvatar as string).replace("upload:", "");
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", uploadId: copy }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("preset must be a shipped one", async () => {
  await expect(
    ctx.h.client.config.bots.setAvatar({ id: "dev", preset: "../x" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(ctx.h.settings.config.lastAvatar).toBeUndefined();
});
