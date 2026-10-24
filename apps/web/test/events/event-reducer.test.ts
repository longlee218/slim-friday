import { describe, expect, test } from "vitest";
import { reduceEvent } from "../../src/events/event-reducer";
import { approvalCard, botMsg, msgEvt, step } from "./fixtures";

const view = { activeConversationId: "bot:dev", visible: true, now: 1000 };

describe("reduceEvent", () => {
  test("bot message in the open conversation appends and ends the run, no toast", () => {
    const fx = reduceEvent(
      { type: "message", conversationId: "bot:dev", message: botMsg("dev", 7) },
      view,
    );
    expect(fx.map((e) => e.op)).toEqual(["appendMessage", "endRun", "refetchStatus"]);
  });

  test("message elsewhere also notifies", () => {
    const fx = reduceEvent(
      { type: "message", conversationId: "bot:pia", message: botMsg("pia", 8) },
      view,
    );
    expect(fx.at(-1)).toMatchObject({ op: "notify", conversationId: "bot:pia" });
  });

  test("hidden tab notifies even for the open conversation", () => {
    const fx = reduceEvent(msgEvt("bot:dev"), { ...view, visible: false });
    expect(fx.some((e) => e.op === "notify")).toBe(true);
  });

  test("approval.opened opens and notifies with the summary", () => {
    const card = { ...approvalCard(), conversationId: "bot:pia" };
    const fx = reduceEvent({ type: "approval.opened", card }, view);
    expect(fx[0]).toMatchObject({ op: "openApproval" });
    expect(fx[1]).toMatchObject({ op: "notify", title: "Dev", text: "run ls" });
  });

  test("status with an idle bot ends its run in every conversation", () => {
    const bots = [
      { botId: "dev", name: "Dev", working: false, tasks: [], spendToday: 0 },
      { botId: "pia", name: "Pia", working: true, tasks: [], spendToday: 0 },
    ];
    const fx = reduceEvent({ type: "status", bots }, view);
    expect(fx).toEqual([
      { op: "setStatus", bots },
      { op: "endRun", conversationId: "*", botId: "dev" },
    ]);
  });

  test("activity, a bot message and a subagent step ask for a status refetch; a tool step does not", () => {
    const ops = (e: Parameters<typeof reduceEvent>[0]) => reduceEvent(e, view).map((x) => x.op);
    expect(
      ops({ type: "activity", conversationId: "bot:dev", botId: "dev", kind: "typing" }),
    ).toEqual(expect.arrayContaining(["refetchStatus", "startRun"]));
    expect(
      ops({
        type: "activity",
        conversationId: "bot:dev",
        botId: "dev",
        kind: "subagent",
        label: "x",
      }),
    ).toContain("runTail");
    expect(
      ops({
        type: "run",
        conversationId: "bot:dev",
        botId: "dev",
        step: step("subagent", "running"),
      }),
    ).toContain("refetchStatus");
    expect(
      ops({ type: "run", conversationId: "bot:dev", botId: "dev", step: step("tool", "running") }),
    ).not.toContain("refetchStatus");
  });

  test("resync invalidates everything", () => {
    expect(reduceEvent({ type: "resync" }, view)).toEqual([{ op: "invalidate", scope: "all" }]);
  });
});
