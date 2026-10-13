import { expect, test } from "bun:test";
import { createLogger, runWithLogContext } from "../src/observability/logger";
import { logRouteDecision, withSpan } from "../src/observability/trace-spans";
import { turnLogContext } from "../src/orchestrator/turns/turn-tracker";
import { directRoutingDecision } from "../src/routing/route-decision-of";
import { ROUTING_VERSION } from "../src/routing/routing-contracts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  return { log: createLogger({ write: (l: string) => lines.push(JSON.parse(l)) }), lines };
}

test("withSpan logs one span line with name, duration and ok, and returns the result", async () => {
  const { log, lines } = capture();
  expect(await withSpan(log, "classify", async () => 7)).toBe(7);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ event: "span", span: "classify", ok: true });
  expect(typeof lines[0].durationMs).toBe("number");
});

test("withSpan logs ok:false once and rethrows", async () => {
  const { log, lines } = capture();
  await expect(
    withSpan(log, "execute", () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ span: "execute", ok: false });
});

test("turnLogContext mints a fresh traceId that every line inside carries", async () => {
  const a = turnLogContext({ threadId: "t", channelId: "c" });
  const b = turnLogContext({ threadId: "t", channelId: "c" });
  expect(a.traceId).not.toBe(b.traceId);
  const { log, lines } = capture();
  await runWithLogContext(a, () => withSpan(log, "validate", () => 1));
  expect(lines[0].traceId).toBe(a.traceId);
});

test("logRouteDecision logs contract fields only, ownedTaskId instead of taskId, no taskId clash", () => {
  const { log, lines } = capture();
  const d = {
    ...directRoutingDecision({ messageId: "m1", threadId: "th", resume: true, role: "r" }),
    taskId: "OT1",
  };
  runWithLogContext({ taskId: "TURN" }, () => logRouteDecision(log, d));
  expect(lines[0]).toMatchObject({
    event: "route.decision",
    messageId: "m1",
    conversationId: "th",
    ownedTaskId: "OT1",
    taskId: "TURN",
    source: "owner",
    rationaleCode: "RESUME",
    candidateAgentId: "r",
    routingVersion: ROUTING_VERSION,
  });
});
