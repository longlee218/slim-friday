import { expect, test } from "bun:test";
import { contract, listProcedurePaths } from "@friday/contracts";
import { createRouterClient } from "@orpc/server";
import type { ApiDeps } from "../src/index";
import { appRouter, stubbedProcedures } from "../src/index";

const deps = {} as ApiDeps;
const client = createRouterClient(appRouter, {
  context: { session: { user: { email: "owner@example.com" } } as never, deps },
});

/** Subtrees with a real handler (plan 2 adds its own as it goes). */
const implemented = ["conversations.", "chat."];
const expected = listProcedurePaths(contract)
  .filter((p) => !implemented.some((i) => p.startsWith(i)))
  .sort();

test("every procedure but the implemented ones is still a stub", () =>
  expect(stubbedProcedures()).toEqual(expected));

test("49 stubs left (55 procedures, 3 conversations and 3 chat are real)", () =>
  expect(stubbedProcedures()).toHaveLength(49));

test("a stub throws the typed NOT_IMPLEMENTED error", async () => {
  await expect(client.control.purge()).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
    status: 501,
  });
  await expect(client.tickets.list({} as never)).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
  });
});

test("input is validated before the stub", async () =>
  await expect(
    client.chat.send({ conversationId: "nope", text: "x" } as never),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" }));

test("no session in context -> UNAUTHORIZED", async () =>
  await expect(
    createRouterClient(appRouter, { context: { deps } as never }).control.purge(),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" }));
