import { expect, test } from "bun:test";
import type { CardRow } from "@friday/core";
import { engineHarness } from "./helpers/engine-deps";

/** A stored open card of bot a, shown on the web desk the way the engine shows it. */
async function stored(h: ReturnType<typeof engineHarness>, card: Partial<CardRow> = {}) {
  const row: CardRow = {
    id: "c1",
    kind: "approval",
    wakeId: "w1",
    botId: "a",
    conversationId: "bot:a",
    scopeKey: "a",
    approval: {
      tool: "Bash",
      input: {},
      inputHash: "h",
      summary: "ls",
      scope: {},
      offerAlways: false,
    },
    status: "open",
    createdAt: 1,
    ...card,
  };
  await h.store.cards.insert(row);
  h.surface.showCard(row, "Ann");
  return row;
}

/** Open an approval card and return its id. */
async function openApproval(h: ReturnType<typeof engineHarness>) {
  return { cardId: (await stored(h)).id };
}

test("two concurrent approvals.answer: one ok, one CONFLICT, the card keeps the first", async () => {
  const h = engineHarness();
  const { cardId } = await openApproval(h);
  const results = await Promise.allSettled([
    h.client.approvals.answer({ cardId, answer: "once" }),
    h.client.approvals.answer({ cardId, answer: "deny" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(lost.reason).toMatchObject({ code: "CONFLICT" });
  // The winner is whichever reached the stored card first; the card keeps that answer.
  const winner = results.findIndex((r) => r.status === "fulfilled") === 0 ? "once" : "deny";
  expect(h.store.cardMap.get(cardId)?.answer).toBe(winner);
  expect(await h.client.approvals.pending()).toEqual([]);
});

test("approvals.answer of an unknown card is NOT_FOUND; pending lists the open card", async () => {
  const h = engineHarness();
  await expect(h.client.approvals.answer({ cardId: "nope", answer: "once" })).rejects.toMatchObject(
    { code: "NOT_FOUND" },
  );
  const { cardId } = await openApproval(h);
  expect((await h.client.approvals.pending()).map((c) => c.cardId)).toEqual([cardId]);
});

test("questions.answer with a choice outside the options is BAD_REQUEST and the card stays open", async () => {
  const h = engineHarness();
  const { id: cardId } = await stored(h, {
    kind: "question",
    approval: undefined,
    question: {
      botId: "a",
      botName: "Ann",
      question: "Which?",
      kind: "single",
      options: [{ value: "x", label: "X" }],
      allowText: false,
    },
  });
  await expect(h.client.questions.answer({ cardId, choices: ["y"] })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(await h.client.questions.pending()).toHaveLength(1);
  expect(await h.client.questions.answer({ cardId, choices: ["x"] })).toEqual({ ok: true });
  expect(h.store.cardMap.get(cardId)?.answer).toEqual({ choices: ["x"] });
});

test("an answer logs approval.answered with ids and latency, no text", async () => {
  const h = engineHarness();
  const logs: Record<string, unknown>[] = [];
  const rec = (o: object) => void logs.push(o as Record<string, unknown>);
  h.deps.log = { info: rec, warn: rec, error: rec };
  const { id: cardId } = await stored(h, { createdAt: 5000 });
  await h.client.approvals.answer({ cardId, answer: "once" });
  expect(logs).toEqual([
    { event: "approval.answered", cardId, kind: "approval", answer: "once", ms: 0 },
  ]);
});

test("approvals.answer refuses once and always on a card whose input is cut; deny goes through", async () => {
  const h = engineHarness();
  const { id: cardId } = await stored(h, {
    approval: {
      tool: "Bash",
      input: { command: "x".repeat(30000) },
      inputHash: "h",
      summary: "long",
      scope: {},
      offerAlways: true,
    },
  });
  expect((await h.client.approvals.pending())[0]?.inputCut).toBe(true);
  for (const answer of ["once", "always"] as const)
    await expect(h.client.approvals.answer({ cardId, answer })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  expect(h.store.cardMap.get(cardId)?.status).toBe("open");
  expect(await h.client.approvals.answer({ cardId, answer: "deny" })).toEqual({ ok: true });
});
