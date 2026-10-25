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
  "ops.",
  "config.bots.list",
  "config.bots.get",
  "config.bots.save",
  "config.bots.delete",
  "config.bots.setAvatar",
  "config.bots.scratchpad",
  "config.avatars.",
  "config.groups.list",
  "config.groups.get",
  "config.groups.save",
  "config.groups.delete",
  "config.groups.setAvatar",
  "config.skills.",
  "config.mcp.",
  "config.owner.",
  "config.approvalRules.",
  "config.permissions.",
  "memory.",
];
const expected = listProcedurePaths(contract)
  .filter((p) => !implemented.some((i) => p.startsWith(i)))
  .sort();

test("every procedure but the implemented ones is still a stub", () =>
  expect(stubbedProcedures()).toEqual(expected));

test("no procedure is a stub any more", () => expect(stubbedProcedures()).toEqual([]));

test("input is validated before the stub", async () =>
  await expect(
    client.chat.send({ conversationId: "nope", text: "x" } as never),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" }));

test("no session in context -> UNAUTHORIZED", async () =>
  await expect(
    createRouterClient(appRouter, { context: { deps } as never }).ops.sessions(),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" }));
