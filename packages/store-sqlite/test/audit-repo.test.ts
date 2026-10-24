import { expect, test } from "bun:test";
import { openEngineStore } from "../src/engine-store";

const row = { botId: "b1", outcome: "allow", reason: "r" } as const;

test("prefix is exact, not a LIKE pattern", async () => {
  const s = openEngineStore(":memory:");
  for (const tool of ["mcp__gh__search", "mcpXXgh__search", "mcp__ghx__a"]) {
    await s.audit.append({ ...row, at: 1, tool });
  }
  const got = await s.audit.recent({ toolPrefix: "mcp__gh__", limit: 10 });
  expect(got.map((r) => r.tool)).toEqual(["mcp__gh__search"]);
});

test("recent is newest first and clamps limit to 1..100", async () => {
  const s = openEngineStore(":memory:");
  for (let at = 1; at <= 120; at++) await s.audit.append({ ...row, at, tool: "mcp__a__t" });
  const got = await s.audit.recent({ toolPrefix: "mcp__a__", limit: 500 });
  expect(got).toHaveLength(100);
  expect(got[0].at).toBe(120);
  expect(got[99].at).toBe(21);
  expect(await s.audit.recent({ toolPrefix: "mcp__a__", limit: 0 })).toHaveLength(1);
});

test("recent returns the stored fields", async () => {
  const s = openEngineStore(":memory:");
  await s.audit.append({ ...row, at: 5, tool: "mcp__a__t", answer: "once" });
  expect(await s.audit.recent({ toolPrefix: "mcp__a__", limit: 5 })).toEqual([
    { at: 5, botId: "b1", tool: "mcp__a__t", outcome: "allow", answer: "once", reason: "r" },
  ]);
});

test("a non-finite limit uses 1", async () => {
  const s = openEngineStore(":memory:");
  for (let at = 1; at <= 3; at++) await s.audit.append({ ...row, at, tool: "mcp__a__t" });
  expect(await s.audit.recent({ toolPrefix: "mcp__a__", limit: Number.NaN })).toHaveLength(1);
});
