import { expect, test } from "bun:test";
import { guardFor } from "../src/policy/check-tool-call";
import { getRole } from "../src/roles/role-registry";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { stubGateway } from "./helpers";

/* The `ask` capability is the only switch for owner questions: there is no per-run count. */

/** One batched AskUserQuestion input. */
const QUESTIONS = {
  questions: [
    { question: "Drop the column?", options: [{ label: "keep (default)" }, { label: "drop" }] },
  ],
};

const permsFor = (asked: string[], pick: number) =>
  buildToolPermissions({
    turnId: "t",
    threadId: "th",
    guard: guardFor(getRole("developer"), { writePaths: [], readPaths: [] }),
    gateway: stubGateway({
      askChoice: async (a) => {
        asked.push(a.question);
        return a.options[pick];
      },
    }),
  });

test("guard: repeated AskUserQuestion calls all reach the owner (no per-run cap)", async () => {
  const asked: string[] = [];
  const perms = permsFor(asked, 0);
  for (let n = 0; n < 10; n++) {
    const r = await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, QUESTIONS, {} as never);
    expect(r).toMatchObject({ behavior: "allow" });
  }
  expect(asked).toHaveLength(10);
});

test("one AskUserQuestion call with 2 questions: both reach the owner and all are answered", async () => {
  const asked: string[] = [];
  const perms = permsFor(asked, 1);
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
});
