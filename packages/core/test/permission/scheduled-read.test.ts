import { expect, test } from "bun:test";
import type { PermissionSettings, ToolCall, ToolSpec } from "../../src";
import { PermissionGate } from "../../src/permission/permission-gate";
import { isScheduledRead } from "../../src/permission/scheduled-read";
import { type TaintRun, taintAskOf, taints } from "../../src/permission/taint-policy";
import { FakeClock } from "../fakes/fake-clock";
import { FakeStore } from "../fakes/fake-store";
import { FakeSurface } from "../fakes/fake-surface";
import { FakeToolCatalog } from "../fakes/fake-tool-catalog";

const SEARCH: ToolSpec = { name: "mcp__notion__search_pages", annotations: { readOnlyHint: true } };
const CREATE: ToolSpec = {
  name: "mcp__notion__create_page",
  annotations: { destructiveHint: false, openWorldHint: false },
};
const FETCH: ToolSpec = { name: "WebFetch", annotations: { readOnlyHint: true } };
const BASH: ToolSpec = { name: "Bash", annotations: { destructiveHint: false } };
const DESIGN: ToolSpec = {
  name: "mcp__design__BotDesign",
  annotations: { destructiveHint: false, openWorldHint: false },
};
const SCHED: ToolSpec = {
  name: "mcp__schedules__ScheduleCreate",
  annotations: { destructiveHint: false, openWorldHint: false },
};
const SPECS = [SEARCH, CREATE, FETCH, BASH, DESIGN, SCHED];

const call = (tool: string, input: Record<string, unknown> = {}): ToolCall => ({
  botId: "b1",
  conversationId: "c1",
  tool,
  input,
});

test("isScheduledRead: WebFetch and read-classified external MCP tools only", () => {
  expect(isScheduledRead(call("WebFetch"), FETCH)).toBe(true);
  expect(isScheduledRead(call("WebFetch"), undefined)).toBe(true);
  expect(isScheduledRead(call(SEARCH.name), SEARCH)).toBe(true);
  expect(isScheduledRead(call(CREATE.name), CREATE)).toBe(false);
  expect(isScheduledRead(call("Bash"), BASH)).toBe(false);
  // A read-only built-in or one of Friday's own servers is not an external MCP read.
  expect(isScheduledRead(call("Read"), { name: "Read", annotations: { readOnlyHint: true } })).toBe(
    false,
  );
  expect(
    isScheduledRead(call("mcp__tickets__TicketList"), {
      name: "mcp__tickets__TicketList",
      annotations: { readOnlyHint: true },
    }),
  ).toBe(false);
});

test("schedule tools: write ones are mandatory taint asks, own-state for the taint", () => {
  const run: TaintRun = {
    tainted: true,
    sites: new Set(),
    approvedSites: new Set(),
    usedMcpServers: new Set(),
  };
  for (const t of ["ScheduleCreate", "ScheduleUpdate", "ScheduleDelete"])
    expect(taintAskOf({ tool: `mcp__schedules__${t}`, input: {} }, run)?.mandatory).toBe(true);
  expect(taintAskOf({ tool: "mcp__schedules__ScheduleList", input: {} }, run)).toBeUndefined();
  expect(taints("mcp__schedules__ScheduleList")).toBe(false);
});

/** A gate over `SPECS` with a `require_approval` rule on every tool the test uses. */
async function gateWith(level: PermissionSettings["level"]) {
  const store = new FakeStore();
  for (const tool of [SEARCH.name, CREATE.name, "WebFetch", "Bash"])
    await store.grants.add({
      id: `r-${tool}`,
      botId: "*",
      effect: "require_approval",
      match: "tool",
      tool,
      scope: {},
      createdAt: 0,
    });
  const gate = new PermissionGate({
    store,
    surface: new FakeSurface(),
    clock: new FakeClock(1000),
    catalog: new FakeToolCatalog(SPECS),
    settings: () => ({ level }),
  });
  return gate;
}
const ctx = (over: { scheduled?: boolean; tainted?: boolean }) => ({
  wakeId: "w1",
  scopeKey: "b1",
  tainted: false,
  ...over,
});

test("gate: a scheduled run reads over a require rule, tainted or not", async () => {
  const gate = await gateWith("careful");
  for (const tainted of [false, true]) {
    const c = ctx({ scheduled: true, tainted });
    expect(await gate.decide(call("WebFetch", { url: "https://a.example.com" }), "B", c)).toEqual({
      behavior: "allow",
    });
    expect(await gate.decide(call(SEARCH.name), "B", c)).toEqual({ behavior: "allow" });
  }
});

test("gate: a non-scheduled run is unchanged (same calls ask)", async () => {
  const gate = await gateWith("careful");
  for (const scheduled of [undefined, false]) {
    // A distinct run each time: one open card per run denies the next ask.
    const c = { ...ctx({ ...(scheduled === false && { scheduled }) }), wakeId: `w-${scheduled}` };
    expect((await gate.decide(call(SEARCH.name), "B", c)).behavior).toBe("park");
  }
});

test("gate: a scheduled run keeps asking for writes, Bash, BotDesign and schedule tools when tainted", async () => {
  const gate = await gateWith("autonomous");
  const c = ctx({ scheduled: true });
  expect((await gate.decide(call(CREATE.name), "B", c)).behavior).toBe("park");
  expect((await gate.decide(call("Bash"), "B", { ...c, wakeId: "w2" })).behavior).toBe("park");
  const t = ctx({ scheduled: true, tainted: true });
  expect((await gate.decide(call(DESIGN.name), "B", { ...t, wakeId: "w3" })).behavior).toBe("park");
  expect((await gate.decide(call(SCHED.name), "B", { ...t, wakeId: "w4" })).behavior).toBe("park");
});
