import { describe, expect, test } from "bun:test";
import type { ApprovalGateway } from "../src/approvals/approval-types";
import { budgetHitMessage } from "../src/orchestrator/engine/budget";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { parseMessageCommand } from "../src/orchestrator/message-commands";
import { escalationAction, parseEscalation } from "../src/orchestrator/outputs/answer-output";
import { fakeQuery, makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";

describe("parseEscalation (fail closed)", () => {
  test("last line `ESCALATE: sonnet|opus` is parsed and stripped", () => {
    expect(parseEscalation("unsure.\nESCALATE: sonnet")).toEqual({
      text: "unsure.",
      tier: "sonnet",
    });
    expect(parseEscalation("x\n\n escalate:  OPUS \n")).toEqual({ text: "x", tier: "opus" });
  });
  test("anything else is no escalation and the text is kept", () => {
    for (const t of [
      "ESCALATE: gpt",
      "ESCALATE: sonnet please",
      "ESCALATE: sonnet\nmore text",
      "see ESCALATE: opus",
      "",
      "ESCALATE:",
    ])
      expect(parseEscalation(t)).toEqual({ text: t });
  });
  test("action: sonnet re-runs, opus asks the owner, max once", () => {
    expect(escalationAction("sonnet", false)).toBe("rerun");
    expect(escalationAction("opus", false)).toBe("ask-owner");
    expect(escalationAction("sonnet", true)).toBe("none");
    expect(escalationAction(undefined, false)).toBe("none");
  });
});

describe("Q&A escalation through the handler", () => {
  async function ask(
    answers: string[],
    extra: Record<string, string> = {},
    approvals?: ApprovalGateway,
  ) {
    const env = makeEnv(extra);
    const calls: {
      model?: string;
      resume?: string;
      budget?: number;
      prompt?: string;
      system?: string;
    }[] = [];
    const queryFn = (a: {
      prompt: string;
      options: { model?: string; resume?: string; maxBudgetUsd?: number; systemPrompt?: unknown };
    }) => {
      calls.push({
        model: a.options.model,
        resume: a.options.resume,
        budget: a.options.maxBudgetUsd,
        prompt: a.prompt,
        system: JSON.stringify(a.options.systemPrompt ?? ""),
      });
      const n = calls.length - 1;
      return fakeQuery([resultMsg({ result: answers[n] ?? "extra", session_id: `s${n}` })])(a);
    };
    const reply = await createTurnHandler({
      db: env.db,
      config: env.config,
      queryFn: queryFn as never,
      approvals,
    })({
      source: "t",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "t1",
      text: "hard question",
    });
    return { reply, calls, db: env.db };
  }
  test("ESCALATE: sonnet re-runs once on sonnet, same session and message, escalated budget, with a notice", async () => {
    const { reply, calls } = await ask([
      "no idea\nESCALATE: sonnet",
      "real answer\nESCALATE: opus",
    ]);
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ model: "claude-haiku-4-5-20251001", budget: 1 });
    expect(calls[1]).toMatchObject({
      model: "claude-sonnet-5-5",
      budget: 2.5,
      resume: "s0",
      prompt: "hard question",
    });
    expect(reply).toBe("Escalated to Sonnet.\n\nreal answer");
  });
  test("the runs rows record each run's model: the first run's, then the escalated re-run's", async () => {
    const models = (db: Awaited<ReturnType<typeof ask>>["db"]) =>
      db
        .query<{ model: string }, []>("SELECT model FROM runs ORDER BY rowid")
        .all()
        .map((r) => r.model);
    const esc = await ask(["no idea\nESCALATE: sonnet", "real answer"]);
    expect(models(esc.db)).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5-5"]);
    const plain = await ask(["fine"]);
    expect(models(plain.db)).toEqual(["claude-haiku-4-5-20251001"]);
  });
  test("rerun that fails: no 'Escalated' prefix", async () => {
    const env = makeEnv();
    let n = 0;
    const queryFn = (a: unknown) =>
      fakeQuery([
        n++ === 0
          ? resultMsg({ result: "no idea\nESCALATE: sonnet", session_id: "s0" })
          : resultMsg({ subtype: "error_during_execution", is_error: true, errors: ["boom"] }),
      ])(a as never);
    const reply = await createTurnHandler({
      db: env.db,
      config: env.config,
      queryFn: queryFn as never,
    })({ source: "t", channelId: TEST_CHANNEL, userId: "u", threadId: "t1", text: "q" });
    expect(n).toBe(2);
    expect(reply).not.toContain("Escalated to");
  });
  test("normal case offers the ESCALATE rule on the first run", async () => {
    const { calls } = await ask(["fine"]);
    expect(calls[0]?.system).toContain("ESCALATE:");
  });
  test("pinned qa model: no re-run, no 'Escalated', one owner line", async () => {
    const { reply, calls } = await ask(["no idea\nESCALATE: sonnet"], {
      MODEL_ASSISTANT: "claude-haiku-4-5-20251001",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.system).not.toContain("ESCALATE:");
    expect(reply).not.toContain("Escalated to");
    expect(reply).not.toContain("ESCALATE");
    expect(reply).toContain("not available");
  });
  test("OpenRouter: tier ignored, so no re-run and no 'Escalated'", async () => {
    const { reply, calls } = await ask(["no idea\nESCALATE: sonnet"], {
      OPENROUTER_API_KEY: `sk-or-v1-${"a1b2c3d4".repeat(8)}`,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.system).not.toContain("ESCALATE:");
    expect(reply).not.toContain("Escalated to");
    expect(reply).toContain("not available");
  });
  test("ESCALATE: opus without the button flow is not run (fails closed)", async () => {
    const { reply, calls } = await ask(["hmm\nESCALATE: opus"]);
    expect(calls.length).toBe(1);
    expect(reply).toContain("Not run on Opus");
    expect(reply).not.toContain("ESCALATE");
  });
  test("ESCALATE: opus, owner says no or times out: cheaper answer, one line", async () => {
    const gw = stubGateway({ confirm: async () => ({ approved: false, reason: "timeout" }) });
    const { reply, calls } = await ask(["hmm\nESCALATE: opus"], {}, gw);
    expect(calls.length).toBe(1);
    expect(reply).toBe("hmm\n\nNot run on Opus (not confirmed); this is the cheaper answer.");
  });
  test("ESCALATE: opus, owner says yes: ONE re-run on Opus, same session, with a notice", async () => {
    const asked: string[] = [];
    const gw = stubGateway({
      confirm: async (r, labels) => {
        asked.push(`${r.tool}|${labels.join("/")}`);
        return { approved: true };
      },
    });
    const { reply, calls } = await ask(
      ["hmm\nESCALATE: opus", "deep answer\nESCALATE: opus"],
      {},
      gw,
    );
    expect(asked).toEqual(["OwnerConfirm|Yes, run it/No"]);
    expect(calls.length).toBe(2);
    expect(calls[1]).toMatchObject({
      model: "claude-opus-5-5",
      resume: "s0",
      prompt: "hard question",
    });
    expect(reply).toBe("Escalated to Opus.\n\ndeep answer");
  });
  test("malformed line: one run, text unchanged", async () => {
    const { reply, calls } = await ask(["hmm\nESCALATE: gpt"]);
    expect(calls.length).toBe(1);
    expect(reply).toBe("hmm\nESCALATE: gpt");
  });
});

describe("class prefix", () => {
  test("leading [mechanical|standard|design] sets cls and is stripped; either order with location:", () => {
    expect(parseMessageCommand("[Design] rethink the cache")).toEqual({
      kind: "message",
      location: undefined,
      text: "rethink the cache",
      cls: "design",
    });
    expect(parseMessageCommand("[mechanical] location:api rename x")).toMatchObject({
      cls: "mechanical",
      location: "api",
      text: "rename x",
    });
    expect(parseMessageCommand("location:api [standard] fix y")).toMatchObject({
      cls: "standard",
      location: "api",
      text: "fix y",
    });
  });
  test("unknown prefix is ignored (kept in the text)", () => {
    const c = parseMessageCommand("[urgent] fix y");
    expect(c).toMatchObject({ text: "[urgent] fix y" });
    expect("cls" in c).toBe(false);
  });
});

describe("budget hit message", () => {
  test("states spent/limit, overshoot note, summary; go +usd only when offered", () => {
    const m = budgetHitMessage(
      {
        spentUsd: 1.52,
        limitUsd: 1.5,
        summary: "did A",
      },
      "en",
    );
    expect(m).toContain("allowed spending limit was reached");
    expect(m).toContain("did A");
    expect(m).not.toContain("go +");
    expect(budgetHitMessage({ goPlusUsd: 1.5 }, "en")).toContain("`/go +1.5`");
    expect(budgetHitMessage({}, "en")).toContain("did not finish");
  });
  test("a max_budget run replies with the message, keeps the session, logs the stop", async () => {
    // Model pinned: no cheap-tier fallback, so the first run's stop is the reply (the fallback has its own tests).
    const env = makeEnv({ MODEL_ASSISTANT: "claude-haiku-4-5-20251001" });
    const queryFn = fakeQuery(
      [
        resultMsg({
          subtype: "error_max_budget_usd",
          is_error: true,
          errors: ["budget"],
          total_cost_usd: 0.52,
          session_id: "sb",
        }),
      ],
      new Error("x"),
    );
    const reply = await createTurnHandler({
      db: env.db,
      config: env.config,
      queryFn: queryFn as never,
    })({
      source: "t",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "t1",
      text: "q",
    });
    expect(reply).toContain("Việc chưa hoàn tất vì đã chạm giới hạn chi phí");
    const row = env.db.query("SELECT session_id FROM sessions WHERE thread_id = 't1'").get() as {
      session_id: string;
    };
    expect(row.session_id).toBe("sb");
  });
});
