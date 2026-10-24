import { expect, test } from "bun:test";
import { AdminError } from "@friday/core";
import { engineHarness } from "./helpers/engine-deps";
import { skill } from "./helpers/settings-fakes";

test("skills.lookup refuses a non-https source before the admin", async () => {
  const h = engineHarness();
  await expect(
    h.client.config.skills.lookup({ source: "http://example.com/x" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(h.settings.skills.calls).toEqual([]);
});

test("skills.lookup returns what the admin found", async () => {
  const h = engineHarness();
  const out = await h.client.config.skills.lookup({ source: "https://github.com/a/b" });
  expect(out).toMatchObject({ lookupId: "l1", sha: "abc" });
});

test("skills.install maps 'not confirmed' to its AdminError code", async () => {
  const h = engineHarness();
  h.settings.skills.failWith = new AdminError("BAD_REQUEST", "not confirmed", "lookupId");
  await expect(h.client.config.skills.install({ lookupId: "l1", name: "s" })).rejects.toMatchObject(
    { code: "BAD_REQUEST", data: { field: "lookupId" } },
  );
});

test("skills.list turns installedAt into epoch ms", async () => {
  const h = engineHarness();
  h.settings.skills.skills.set("s", skill("s", { installedAt: "2026-10-24T00:00:00.000Z" }));
  h.settings.skills.skills.set("t", skill("t"));
  const [s, t] = await h.client.config.skills.list();
  expect(s?.installedAt).toBe(Date.parse("2026-10-24T00:00:00.000Z"));
  expect(t?.installedAt).toBeUndefined();
});

test("install, checkUpdate, update, remove and setUsedBy pass through", async () => {
  const h = engineHarness();
  expect((await h.client.config.skills.install({ lookupId: "l1", name: "s" })).name).toBe("s");
  expect(await h.client.config.skills.checkUpdate({ name: "s" })).toEqual({
    latestSha: "b",
    updateAvailable: true,
  });
  expect((await h.client.config.skills.update({ lookupId: "l1", name: "s" })).name).toBe("s");
  expect(await h.client.config.skills.setUsedBy({ name: "s", botIds: ["a"] })).toMatchObject({
    usedBy: ["a"],
  });
  expect(await h.client.config.skills.remove({ name: "s" })).toEqual({ botIds: ["a"] });
});

test("skills.remove NOT_FOUND passes through", async () => {
  const h = engineHarness();
  h.settings.skills.failWith = new AdminError("NOT_FOUND", "no skill");
  await expect(h.client.config.skills.remove({ name: "s" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
