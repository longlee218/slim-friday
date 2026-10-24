import { expect, test } from "bun:test";
import { engineHarness } from "./helpers/engine-deps";

/** Open an approval card on the desk and return its id plus the bot's pending answer. */
function openApproval(h: ReturnType<typeof engineHarness>) {
  const answer = h.surface.cards.askApproval("bot:a", {
    botId: "a",
    botName: "Ann",
    tool: "Bash",
    summary: "ls",
    scope: {},
    offerAlways: false,
  });
  const cardId = h.surface.cards.pendingApprovals()[0]?.cardId ?? "";
  return { answer, cardId };
}

test("two concurrent approvals.answer: one ok, one CONFLICT, the bot sees the first", async () => {
  const h = engineHarness();
  const { answer, cardId } = openApproval(h);
  const results = await Promise.allSettled([
    h.client.approvals.answer({ cardId, answer: "once" }),
    h.client.approvals.answer({ cardId, answer: "deny" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(lost.reason).toMatchObject({ code: "CONFLICT" });
  expect(await answer).toBe("once");
});

test("approvals.answer of an unknown card is NOT_FOUND; pending lists the open card", async () => {
  const h = engineHarness();
  await expect(h.client.approvals.answer({ cardId: "nope", answer: "once" })).rejects.toMatchObject(
    { code: "NOT_FOUND" },
  );
  const { cardId } = openApproval(h);
  expect((await h.client.approvals.pending()).map((c) => c.cardId)).toEqual([cardId]);
});

test("questions.answer with a choice outside the options is BAD_REQUEST and the card stays open", async () => {
  const h = engineHarness();
  const answer = h.surface.cards.askQuestion("bot:a", {
    botId: "a",
    botName: "Ann",
    question: "Which?",
    kind: "single",
    options: [{ value: "x", label: "X" }],
    allowText: false,
  });
  const cardId = h.surface.cards.pendingQuestions()[0]?.cardId ?? "";
  await expect(h.client.questions.answer({ cardId, choices: ["y"] })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(await h.client.questions.pending()).toHaveLength(1);
  expect(await h.client.questions.answer({ cardId, choices: ["x"] })).toEqual({ ok: true });
  expect(await answer).toEqual({ choices: ["x"] });
});

test("an answer logs approval.answered with ids and latency, no text", async () => {
  const h = engineHarness();
  const logs: Record<string, unknown>[] = [];
  const rec = (o: object) => void logs.push(o as Record<string, unknown>);
  h.deps.log = { info: rec, warn: rec, error: rec };
  const { cardId } = openApproval(h);
  await h.client.approvals.answer({ cardId, answer: "once" });
  expect(logs).toEqual([
    { event: "approval.answered", cardId, kind: "approval", answer: "once", ms: 0 },
  ]);
});
