import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAction } from "../src/mcp/action-tool/action-types";
import { createActionTool } from "../src/mcp/action-tool/create-action-tool";
import { REPORT_ACTIONS } from "../src/mcp/orchestration/tools/ReportTool/report-actions";
import { PLAN_ACTIONS } from "../src/mcp/plan/tools/PlanTool/plan-actions";

/* The shared action-tool helper: one table in, one `{ action, params }` MCP tool out. */

const ADD = "add";
const PING = "ping";
const calls: unknown[] = [];
const table = [
  defineAction<{ base: number }, { a: z.ZodNumber; tags: z.ZodOptional<z.ZodArray<z.ZodString>> }>({
    name: ADD,
    schema: z.object({ a: z.number().int(), tags: z.array(z.string()).optional() }),
    example: { a: 1 },
    run: (c, p) => {
      calls.push(p);
      return { ok: true, sum: c.base + p.a };
    },
  }),
  defineAction<{ base: number }, Record<string, never>>({
    name: PING,
    schema: z.object({}),
    example: {},
    run: () => ({ ok: true }),
  }),
];
const tool = createActionTool({ name: "T", intro: "Head.", ctx: { base: 10 }, actions: table });

/** Call the tool handler directly (the SDK validates the outer shape before it, tests skip that). */
async function call(args: object) {
  const r = await tool.handler(args as never, {});
  return { ...JSON.parse((r.content[0] as { text: string }).text), isError: r.isError };
}

test("happy path: params are parsed by the action's schema and the handler runs with the ctx", async () => {
  expect(await call({ action: ADD, params: { a: 5 } })).toMatchObject({ ok: true, sum: 15 });
  expect(await call({ action: PING })).toMatchObject({ ok: true }); // params omitted = {}
});

test("BAD_PARAMS names the action's params and gives one example; the handler does not run", async () => {
  calls.length = 0;
  const r = await call({ action: ADD, params: { a: "x" } });
  expect(r).toMatchObject({ ok: false, code: "BAD_PARAMS", isError: true });
  expect(r.message).toContain("a:integer");
  expect(r.message).toContain("tags?:string[]");
  expect(r.message).toContain(JSON.stringify({ action: ADD, params: { a: 1 } }));
  expect(calls).toEqual([]);
});

test("BAD_ACTION lists the actions", async () => {
  const r = await call({ action: "nope", params: {} });
  expect(r).toMatchObject({ ok: false, code: "BAD_ACTION" });
  expect(r.message).toContain(`${ADD}, ${PING}`);
});

test("the definition is loose: action enum + params record, no per-action schema in it", () => {
  const json = z.toJSONSchema(z.object(tool.inputSchema as never)) as {
    properties: Record<string, { enum?: string[]; type?: string }>;
    required: string[];
  };
  expect(json.properties.action?.enum).toEqual([ADD, PING]);
  expect(json.properties.params?.type).toBe("object");
  expect(JSON.stringify(json)).not.toContain("tags");
  expect(json.required).toEqual(["action"]);
});

test("the description is the intro and one line per action with compact param types", () => {
  expect(tool.description.split("\n")).toEqual([
    "Head.",
    `- ${ADD}: a:integer, tags?:string[]`,
    `- ${PING}: (no params)`,
  ]);
});

test("every action of the Plan and Report tables has a valid example for its own schema", () => {
  for (const a of [...PLAN_ACTIONS, ...REPORT_ACTIONS])
    expect([a.name, a.schema.safeParse(a.example).success]).toEqual([a.name, true]);
});

test("a handler that throws becomes one coded INTERNAL error", async () => {
  const boom = createActionTool({
    name: "B",
    intro: "x",
    ctx: {},
    actions: [
      defineAction<object, Record<string, never>>({
        name: PING,
        schema: z.object({}),
        example: {},
        run: () => {
          throw new Error("secret detail");
        },
      }),
    ],
  });
  const r = await boom.handler({ action: PING } as never, {});
  const text = (r.content[0] as { text: string }).text;
  expect(JSON.parse(text).code).toBe("INTERNAL");
  expect(text).not.toContain("secret detail");
});
