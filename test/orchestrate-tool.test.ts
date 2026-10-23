import { expect, test } from "bun:test";
import { ORCHESTRATE_ACTIONS } from "../src/mcp/orchestration/tools/OrchestrateTool/orchestrate-actions";
import { createOrchestrateTool } from "../src/mcp/orchestration/tools/OrchestrateTool/orchestrate-tool";

/* The teammate's Orchestrate action table: examples stay valid, a bad call is answered with the params and an example. */

const tool = () => createOrchestrateTool({ teammate: {} as never, titleCalls: { n: 0 } });

test("every action's example passes its own schema", () => {
  for (const a of ORCHESTRATE_ACTIONS)
    expect([a.name, a.schema.safeParse(a.example).success]).toEqual([a.name, true]);
});

test("the description lists the 10 actions a run without a rename port gets, and not set_title", () => {
  const d = tool().description;
  for (const a of ORCHESTRATE_ACTIONS.filter((x) => x.name !== "set_title"))
    expect(d).toContain(`- ${a.name}:`);
  expect(d).not.toContain("set_title");
});

test("bad params: BAD_PARAMS names the params and one example; the handler is not reached", async () => {
  const r = await tool().handler({ action: "retry", params: { taskId: "t" } } as never, {});
  const reply = JSON.parse((r.content[0] as { text: string }).text);
  expect(r.isError).toBe(true);
  expect(reply.code).toBe("BAD_PARAMS");
  expect(reply.message).toContain("taskId:string, note:string");
  expect(reply.message).toContain('"action":"retry"');
});
