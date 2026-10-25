import { expect, test } from "bun:test";
import {
  backoffMs,
  CORE_DEFAULTS,
  type Conversation,
  classifyFailure,
  isConversational,
  priorityOf,
  SetupError,
  scopeKeyOf,
  sessionScope,
} from "../src";

const bot = { id: "ann", workspaces: [] } as never;

test("owner message without ticket is conversational", () => {
  expect(isConversational({ sender: { kind: "user" } })).toBe(true);
  expect(isConversational({ sender: { kind: "user" }, ticketId: "FRI-1" })).toBe(false);
  expect(isConversational({ sender: { kind: "bot", botId: "bob" as never } })).toBe(false);
});

test("ticket wake is background", () => {
  expect(priorityOf({ kind: "user" }, false)).toBe("interactive");
  expect(priorityOf({ kind: "user" }, true)).toBe("background");
  expect(priorityOf({ kind: "bot", botId: "bob" as never }, false)).toBe("interactive");
});

test("scopeKeyOf matches sessionScope keys", () => {
  const direct = { kind: "direct" } as unknown as Conversation;
  const grp = { kind: "group", groupId: "g1" } as unknown as Conversation;
  const group = { id: "g1", members: ["ann"], workspaces: [] } as never;
  expect(scopeKeyOf("ann" as never)).toBe(sessionScope(bot, direct, undefined)?.key as string);
  expect(scopeKeyOf("ann" as never, "g1" as never)).toBe(
    sessionScope(bot, grp, group)?.key as string,
  );
});

test("ECONNRESET is transient", () => {
  expect(classifyFailure(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("transient");
  expect(classifyFailure(new Error("connect ETIMEDOUT 1.2.3.4"))).toBe("transient");
  expect(classifyFailure(new Error("getaddrinfo ENOTFOUND api"))).toBe("transient");
  expect(classifyFailure(new TypeError("fetch failed"))).toBe("transient");
  expect(classifyFailure(new Error("API is Overloaded"))).toBe("transient");
});

test("429 is transient", () => {
  for (const status of [429, 500, 502, 503, 529]) {
    expect(classifyFailure(Object.assign(new Error("x"), { status }))).toBe("transient");
  }
  expect(classifyFailure(Object.assign(new Error("x"), { statusCode: 503 }))).toBe("transient");
  expect(classifyFailure(new Error("request failed with 529"))).toBe("transient");
  expect(classifyFailure(new Error("API Error: 500 internal"))).toBe("transient");
  expect(classifyFailure(new Error("wrote 500 files then broke"))).toBe("fatal");
  expect(classifyFailure(Object.assign(new Error("x"), { status: 400 }))).toBe("fatal");
});

test("setup errors", () => {
  expect(classifyFailure(new SetupError("mcp start failed"))).toBe("setup");
  expect(classifyFailure(new Error("workspace /x is inside the agent home"))).toBe("setup");
  expect(classifyFailure(new Error("session s1 not found"))).toBe("setup");
});

test("everything else is fatal", () => {
  expect(classifyFailure(new Error("boom"))).toBe("fatal");
  expect(classifyFailure("string")).toBe("fatal");
  expect(classifyFailure(undefined)).toBe("fatal");
});

test("backoffMs(1) is 2000 and caps at 60000", () => {
  expect(backoffMs(1)).toBe(2000);
  expect(backoffMs(2)).toBe(4000);
  expect(backoffMs(5)).toBe(32_000);
  expect(backoffMs(6)).toBe(60_000);
  expect(backoffMs(50)).toBe(60_000);
});

test("run limits have the spec values", () => {
  expect(CORE_DEFAULTS).toMatchObject({
    workers: 2,
    runsPerWorker: 4,
    leaseMs: 300_000,
    heartbeatMs: 60_000,
    fenceCheckMs: 1_000,
    scanMs: 5_000,
    queueDelayWarnMs: 30_000,
    streamIdleMs: 180_000,
    transientRetries: 5,
    setupFailures: 8,
    cutAttempts: 3,
    cardReminderMs: 14_400_000,
    reconcileMs: 30_000,
    minFreeMemoryMb: 512,
  });
});
