import { expect, test } from "bun:test";
import type { Author } from "../../src";
import type { HubContext } from "../../src/hub/hub-context";
import type { WakeOpts } from "../../src/hub/hub-types";
import { taintAskOf } from "../../src/permission/taint-policy";
import { createRun } from "../../src/runs/run-create";
import { flush, makeHub } from "../bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;
const ctxOf = (h: Hub) => (h.hub as unknown as { ctx: HubContext }).ctx;
const CREATE = "mcp__schedules__ScheduleCreate";
const LIST = "mcp__schedules__ScheduleList";

/** A hub whose catalog marks the schedule tools read-only, as the shipped `tools.yaml` does. */
function hub(): Hub {
  const h = makeHub();
  h.catalog.tools = ["ScheduleCreate", "ScheduleUpdate", "ScheduleDelete", "ScheduleList"].map(
    (t) => ({ name: `mcp__schedules__${t}`, annotations: { readOnlyHint: true } }),
  );
  return h;
}

/** Start one run for editor in its direct chat: an owner message, or a run created with `sender` and `opts`. */
async function start(h: Hub, sender?: Author, opts?: WakeOpts) {
  if (!sender) h.surface.deliver({ conversationId: "dc", text: "every morning, brief me" });
  else
    await createRun(ctxOf(h), {
      botId: "editor",
      conversationId: "dc",
      sender,
      text: "x",
      hop: 1,
      opts,
    });
  await flush();
  return h.runtime.last();
}

const decideOf = async (h: Hub, tool: string, sender?: Author, opts?: WakeOpts) =>
  (await (await start(h, sender, opts)).spec.decide({ tool, input: {} })).behavior;

test("an owner-assigned ticket run (clean) asks before it changes a schedule", async () => {
  for (const tool of ["ScheduleCreate", "ScheduleUpdate", "ScheduleDelete"])
    expect(
      await decideOf(hub(), `mcp__schedules__${tool}`, { kind: "user" }, { ticketId: "T1" }),
    ).toBe("park");
});

test("a bot-to-bot run asks before it changes a schedule", async () => {
  expect(await decideOf(hub(), CREATE, { kind: "bot", botId: "writer" })).toBe("park");
});

test("a clean owner run changes a schedule with no card", async () => {
  expect(await decideOf(hub(), CREATE)).toBe("allow");
});

test("ScheduleList needs no card in a ticket run", async () => {
  expect(await decideOf(hub(), LIST, { kind: "user" }, { ticketId: "T1" })).toBe("allow");
});

test("policy: a clean run not started by the owner asks only for the schedule writes", () => {
  const run = {
    tainted: false,
    notOwnerRun: true,
    sites: new Set<string>(),
    approvedSites: new Set<string>(),
    usedMcpServers: new Set<string>(),
  };
  expect(taintAskOf({ tool: CREATE, input: {} }, run)?.mandatory).toBe(true);
  for (const tool of [LIST, "mcp__design__BotDesign", "mcp__chat__UpdateProfile", "WebFetch"])
    expect(taintAskOf({ tool, input: {} }, run)).toBeUndefined();
});
