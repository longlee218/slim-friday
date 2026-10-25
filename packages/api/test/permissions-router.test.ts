import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { appRouter } from "../src/index";
import { engineHarness } from "./helpers/engine-deps";

test("Auto Review is read and switched through the permissions admin", async () => {
  const h = engineHarness();
  expect(await h.client.config.permissions.get()).toEqual({ autoReview: false });
  expect(await h.client.config.permissions.setAutoReview({ autoReview: true })).toEqual({
    ok: true,
  });
  expect(await h.client.config.permissions.get()).toEqual({ autoReview: true });
});

test("permissions routes refuse a bad input and a call without a session", async () => {
  const h = engineHarness();
  await expect(
    h.client.config.permissions.setAutoReview({ autoReview: "yes" } as never),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const anon = createRouterClient(appRouter, { context: { deps: h.deps } as never });
  await expect(anon.config.permissions.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(anon.config.permissions.setAutoReview({ autoReview: true })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
