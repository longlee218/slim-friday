import { expect, test } from "bun:test";
import { contract, listProcedurePaths } from "@friday/contracts";
import { createRouterClient } from "@orpc/server";
import type { ApiDeps } from "../src/index";
import { appRouter, stubbedProcedures } from "../src/index";

const deps = {} as ApiDeps;
const client = createRouterClient(appRouter, {
  context: { session: { user: { email: "owner@example.com" } } as never, deps },
});

test("every procedure is still a stub (later plans remove theirs from this list)", () =>
  expect(stubbedProcedures()).toEqual(listProcedurePaths(contract).sort()));

test("55 procedures", () => expect(stubbedProcedures()).toHaveLength(55));

test("a stub throws the typed NOT_IMPLEMENTED error", async () => {
  await expect(client.control.purge()).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
    status: 501,
  });
  await expect(client.conversations.list()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
});

test("input is validated before the stub", async () =>
  await expect(
    client.chat.send({ conversationId: "nope", text: "x" } as never),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" }));

test("no session in context -> UNAUTHORIZED", async () =>
  await expect(
    createRouterClient(appRouter, { context: { deps } as never }).control.purge(),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" }));
