import { expect, test } from "bun:test";
import { guardFor } from "../src/guardrails/check-tool-call";
import { getRole } from "../src/roles/role-registry";
import { newAskLimit } from "../src/runtime/ask-limit";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { stubGateway } from "./helpers";

/** Ask cap of the dev role (the engine passes it to the guard; direct permission layers below get it explicitly). */
const MAX_ASK = getRole("dev").limits.maxAsk;

/** One batched AskUserQuestion input. */
const QUESTIONS = {
  questions: [
    { question: "Drop the column?", options: [{ label: "keep (default)" }, { label: "drop" }] },
  ],
};

test("guard: AskUserQuestion calls beyond the cap are denied and never reach the owner", async () => {
  const asked: string[] = [];
  const perms = buildToolPermissions({
    askLimit: newAskLimit(MAX_ASK),
    turnId: "t",
    threadId: "th",
    guard: guardFor(getRole("dev"), { writePaths: [], readPaths: [] }),
    gateway: stubGateway({
      askChoice: async (a) => {
        asked.push(a.question);
        return a.options[0];
      },
    }),
  });
  for (let n = 0; n < MAX_ASK; n++) {
    const r = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {} as never);
    expect(r).toMatchObject({ behavior: "allow" });
  }
  const over = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {} as never);
  expect(over).toMatchObject({ behavior: "deny" });
  expect((over as { message: string }).message).toContain("Already asked");
  expect((over as { message: string }).message).toContain("use the defaults");
  expect(asked).toHaveLength(MAX_ASK);
});

test("one AskUserQuestion call with 2 questions: both reach the owner, all answered, one call of the budget used", async () => {
  const asked: string[] = [];
  const perms = buildToolPermissions({
    askLimit: newAskLimit(MAX_ASK),
    turnId: "t",
    threadId: "th",
    guard: guardFor(getRole("dev"), { writePaths: [], readPaths: [] }),
    gateway: stubGateway({
      askChoice: async (a) => {
        asked.push(a.question);
        return a.options[1];
      },
    }),
  });
  const two = {
    questions: [
      { question: "Q1?", options: [{ label: "a (default)" }, { label: "b" }] },
      { question: "Q2?", options: [{ label: "c (default)" }, { label: "d" }] },
    ],
  };
  const r = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, two, {} as never);
  expect(r).toMatchObject({
    behavior: "allow",
    updatedInput: { answers: { "Q1?": "b", "Q2?": "d" } },
  });
  expect(asked).toEqual(["Q1?", "Q2?"]);
  for (let n = 1; n < MAX_ASK; n++)
    expect(await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, two, {} as never)).toMatchObject({
      behavior: "allow",
    });
  const again = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, two, {} as never);
  expect(again).toMatchObject({ behavior: "deny" });
});
