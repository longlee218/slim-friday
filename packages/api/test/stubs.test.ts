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
const implemented = [
  "conversations.",
  "chat.",
  "approvals.",
  "questions.",
  "control.",
  "events.",
  "tickets.",
  "config.bots.list",
  "config.groups.list",
];
const expected = listProcedurePaths(contract)
  .filter((p) => !implemented.some((i) => p.startsWith(i)))
  .sort();

test("every procedure but the implemented ones is still a stub", () =>
  expect(stubbedProcedures()).toEqual(expected));

test("34 stubs left (55 procedures; conversations, chat, cards, control, events, tickets and the two config reads are real)", () =>
  expect(stubbedProcedures()).toHaveLength(34));

test("a stub throws the typed NOT_IMPLEMENTED error", async () => {
  await expect(client.ops.sessions()).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
    status: 501,
  });
  await expect(client.config.bots.get({ id: "a" })).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
  });
});

test("input is validated before the stub", async () =>
  await expect(
    client.chat.send({ conversationId: "nope", text: "x" } as never),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" }));

test("no session in context -> UNAUTHORIZED", async () =>
  await expect(
    createRouterClient(appRouter, { context: { deps } as never }).ops.sessions(),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" }));
