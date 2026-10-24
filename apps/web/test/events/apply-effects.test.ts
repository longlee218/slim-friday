import type { ConversationDto, MessageDto } from "@friday/contracts";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { applyEffects, resetStatusDebounce } from "../../src/events/apply-effects";
import { messagesKey } from "../../src/events/apply-messages";
import { type LiveRun, liveRunKey, type Receipt, receiptsKey } from "../../src/events/client-keys";
import type { CacheEffect } from "../../src/events/event-reducer";
import { approvalCard, botMsg, step } from "./fixtures";

const noop = () => {};
let qc: QueryClient;
const append = (id: number): CacheEffect => ({ op: "appendMessage", message: botMsg("dev", id) });
const page0 = () => qc.getQueryData<InfiniteData<MessageDto[]>>(messagesKey("bot:dev"))!.pages[0]!;

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData<InfiniteData<MessageDto[]>>(messagesKey("bot:dev"), {
    pages: [[botMsg("dev", 6), botMsg("dev", 5)]],
    pageParams: [undefined],
  });
  const conv: ConversationDto = {
    id: "bot:dev",
    kind: "direct",
    botId: "dev",
    title: "Dev",
    unread: 0,
  };
  qc.setQueryData(orpc.conversations.list.queryKey(), [conv]);
});
afterEach(() => {
  resetStatusDebounce(qc);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("applyEffects", () => {
  test("ignores a message already in the page", () => {
    applyEffects(qc, [append(7), append(7)], noop);
    expect(page0().map((m) => m.id)).toEqual([7, 6, 5]);
  });

  test("appendMessage sets lastMessage on the conversation", () => {
    applyEffects(qc, [append(7)], noop);
    const list = qc.getQueryData<ConversationDto[]>(orpc.conversations.list.queryKey())!;
    expect(list[0]!.lastMessage?.id).toBe(7);
  });

  test("runStep replaces a running step by id", () => {
    const fx = (state: "running" | "done"): CacheEffect => ({
      op: "runStep",
      conversationId: "bot:dev",
      botId: "dev",
      step: step("tool", state),
    });
    applyEffects(qc, [fx("running"), fx("done")], noop);
    const run = qc.getQueryData<Record<string, LiveRun>>(liveRunKey("bot:dev"))!.dev!;
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]!.state).toBe("done");
    expect(run.startedAt).toBe(500);
  });

  test("endRun with * clears the bot in every conversation", () => {
    applyEffects(qc, [{ op: "startRun", conversationId: "bot:dev", botId: "dev", at: 1 }], noop);
    applyEffects(qc, [{ op: "endRun", conversationId: "*", botId: "dev" }], noop);
    expect(qc.getQueryData(liveRunKey("bot:dev"))).toEqual({});
  });

  test("closeApproval moves the card to receipts", () => {
    applyEffects(qc, [{ op: "openApproval", card: approvalCard() }], noop);
    applyEffects(qc, [{ op: "closeApproval", cardId: "c1", answer: "deny" }], noop);
    expect(qc.getQueryData(orpc.approvals.pending.queryKey())).toEqual([]);
    expect(qc.getQueryData<Record<string, Receipt>>(receiptsKey())!.c1!.answer).toBe("deny");
  });

  test("setUnread patches the conversation list", () => {
    applyEffects(qc, [{ op: "setUnread", conversationId: "bot:dev", unread: 3 }], noop);
    const list = qc.getQueryData<ConversationDto[]>(orpc.conversations.list.queryKey())!;
    expect(list[0]!.unread).toBe(3);
  });

  test("notify goes to the callback", () => {
    const n = vi.fn();
    const e: CacheEffect = { op: "notify", conversationId: "bot:dev", title: "t", text: "x" };
    applyEffects(qc, [e], n);
    expect(n).toHaveBeenCalledWith(e);
  });

  test("refetchStatus is debounced to one control.status call per second", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        json: [{ botId: "dev", name: "Dev", working: false, tasks: [], spendToday: 0 }],
      }),
    );
    applyEffects(qc, [{ op: "startRun", conversationId: "bot:dev", botId: "dev", at: 1 }], noop);
    const r: CacheEffect = { op: "refetchStatus" };
    applyEffects(qc, [r, r, r], noop);
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(liveRunKey("bot:dev"))).toEqual({});
  });

  test("resync invalidates everything", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyEffects(qc, [{ op: "invalidate", scope: "all" }], noop);
    expect(spy).toHaveBeenCalledWith();
  });
});
