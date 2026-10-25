import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec, QuestionAnswer, QuestionCard } from "@friday/core";
import { answerAsk, cardsFromAsk, PARKED_RESULT } from "../src/session/ask-question";
import { buildOptions } from "../src/session/build-options";
import { ASK_INPUT_MULTI, ASK_INPUT_SINGLE } from "./fixtures/sdk-shapes";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-")));
const home = join(base, "home");
const scratch = join(home, "runs", "b1");
mkdirSync(scratch, { recursive: true });
const bot: Bot = {
  id: "b1",
  name: "Ann",
  title: "Dev",
  instructions: "x",
  model: "sonnet",
  tools: ["AskUserQuestion"],
  skills: [],
  subagents: [],
  workspaces: [],
};
/** An `AskUserQuestion` input with two questions. */
const TWO = {
  questions: [
    { question: "Colors?", multiSelect: true, options: [{ label: "Red" }, { label: "Blue" }] },
    { question: "Size?", multiSelect: false, options: [{ label: "Small" }, { label: "Big" }] },
  ],
};
const opts = { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" };
function canUse(ask?: BotRuntimeSpec["ask"], b: Bot = bot) {
  const spec: BotRuntimeSpec = {
    bot: b,
    runKind: "owner",
    // `decide` denies everything: a question must reach `ask` before it.
    decide: async () => ({ behavior: "deny", reason: "no" }),
    ...(ask && { ask }),
  };
  const o = buildOptions({
    spec,
    config: { agentHome: home, scratchRoot: join(home, "runs") },
    abort: new AbortController(),
    scratchDir: scratch,
  });
  return (input: Record<string, unknown>) => o.canUseTool?.("AskUserQuestion", input, opts);
}

test("AskUserQuestion is refused without ask, before the MCP grant check", async () => {
  expect(await canUse()(ASK_INPUT_SINGLE)).toEqual({
    behavior: "deny",
    message: "No one can answer questions here.",
  });
});

test("a malformed input is denied with the reason", async () => {
  const r = await canUse(async () => ({ behavior: "answered", answers: [{ choices: ["x"] }] }))({
    questions: "x",
  });
  expect(r?.behavior).toBe("deny");
});

test("the owner's answer reaches the tool input; cards name the bot", async () => {
  const seen: QuestionCard[] = [];
  const r = await canUse(async (c) => {
    seen.push(...c);
    return { behavior: "answered", answers: [{ choices: ["Blue"] }] };
  })(ASK_INPUT_SINGLE);
  expect(seen[0]).toMatchObject({ botId: "b1", botName: "Ann", kind: "single", allowText: true });
  expect(r).toMatchObject({
    behavior: "allow",
    updatedInput: { answers: { [ASK_INPUT_SINGLE.questions[0].question]: "Blue" } },
  });
});

test("a refused question (e.g. withdrawn) is a deny with its reason and the session goes on", async () => {
  const reason = 'Your question "x" was withdrawn because the owner wrote something else instead.';
  expect(await canUse(async () => ({ behavior: "refused", reason }))(ASK_INPUT_SINGLE)).toEqual({
    behavior: "deny",
    message: reason,
  });
});

test("every question of one call goes to ask at once and every answer reaches the tool input", async () => {
  let n = 0;
  const r = await canUse(async (c) => {
    n = c.length;
    return {
      behavior: "answered",
      answers: [{ choices: ["Red", "Blue"] }, { choices: ["Small"] }],
    };
  })(TWO);
  expect(n).toBe(2);
  expect(r).toMatchObject({
    behavior: "allow",
    updatedInput: { answers: { "Colors?": "Red, Blue", "Size?": "Small" } },
  });
});

test("a throwing ask is a deny", async () => {
  expect(
    await canUse(async () => {
      throw new Error("boom");
    })(ASK_INPUT_SINGLE),
  ).toEqual({ behavior: "deny", message: "question failed" });
});

test("single, multi and free-text answers fill answers by question", () => {
  const q = ASK_INPUT_SINGLE.questions[0].question;
  expect(answerAsk(ASK_INPUT_SINGLE, [{ choices: ["Blue"] }])).toMatchObject({
    behavior: "allow",
    updatedInput: { answers: { [q]: "Blue" } },
  });
  const multi = answerAsk(ASK_INPUT_MULTI, [{ choices: ["Red", "Blue"] }]);
  expect(multi.behavior === "allow" && multi.updatedInput.answers).toEqual({
    [ASK_INPUT_MULTI.questions[0].question]: "Red, Blue",
  });
  const free = answerAsk(ASK_INPUT_SINGLE, [{ choices: [], text: "Green please" }]);
  expect(
    free.behavior === "allow" && (free.updatedInput.answers as Record<string, string>)[q],
  ).toBe("Green please");
  const both = answerAsk(ASK_INPUT_SINGLE, [{ choices: ["Red"], text: "but warm" }]);
  expect(both).toMatchObject({
    updatedInput: { answers: { [q]: "Red" }, annotations: { [q]: { notes: "but warm" } } },
  });
  expect(answerAsk(ASK_INPUT_SINGLE, [null as QuestionAnswer | null])).toEqual({
    behavior: "deny",
    message: "The owner gave no answer.",
  });
});

test("cardsFromAsk refuses a malformed input and detects confirm", () => {
  expect(typeof cardsFromAsk({ questions: "x" }, "a", "A")).toBe("string");
  expect(typeof cardsFromAsk({ questions: [{ question: "Q" }] }, "a", "A")).toBe("string");
  expect(typeof cardsFromAsk({ questions: [] }, "a", "A")).toBe("string");
  const yn = {
    question: "Go?",
    header: "h",
    multiSelect: false,
    options: [
      { label: "Yes", description: "" },
      { label: "no", description: "" },
    ],
  };
  expect((cardsFromAsk({ questions: [yn] }, "a", "A") as QuestionCard[])[0]).toMatchObject({
    kind: "confirm",
  });
  expect((cardsFromAsk(ASK_INPUT_MULTI, "a", "A") as QuestionCard[])[0].kind).toBe("multi");
  expect((cardsFromAsk(ASK_INPUT_SINGLE, "a", "A") as QuestionCard[])[0].options[0]).toMatchObject({
    value: "Red",
    label: "Red",
  });
});

test("AskUserQuestion reaches ask before the grant check and decide, even with no tools", async () => {
  let asked = 0;
  const r = await canUse(
    async () => {
      asked++;
      return { behavior: "answered", answers: [{ choices: ["Blue"] }] };
    },
    { ...bot, tools: [] },
  )(ASK_INPUT_SINGLE);
  expect(asked).toBe(1);
  expect(r?.behavior).toBe("allow");
});

test("model-supplied answers and annotations are dropped; empty answers are denied", () => {
  const q = ASK_INPUT_SINGLE.questions[0].question;
  const r = answerAsk(
    { ...ASK_INPUT_SINGLE, answers: { [q]: "fake" }, annotations: { [q]: { notes: "fake" } } },
    [{ choices: ["Red"] }],
  );
  expect(r).toMatchObject({ behavior: "allow", updatedInput: { answers: { [q]: "Red" } } });
  expect(r.behavior === "allow" && "annotations" in r.updatedInput).toBe(false);
  expect(answerAsk(ASK_INPUT_SINGLE, [{ choices: [] }])).toEqual({
    behavior: "deny",
    message: "The owner gave no answer.",
  });
});

test("a question that parks the run ends the turn with an interrupting deny", async () => {
  const r = await canUse(async () => ({ behavior: "park", cardId: "c1" }))(ASK_INPUT_SINGLE);
  expect(r).toEqual(PARKED_RESULT);
  expect(r).toMatchObject({ behavior: "deny", interrupt: true });
});
