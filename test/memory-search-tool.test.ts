import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadBudget } from "../src/mcp/memory/memory-read-shared";
import type { MemoryToolContext } from "../src/mcp/memory/memory-tool-context";
import { createMemorySearchTool } from "../src/mcp/memory/tools/MemorySearchTool/memory-search-tool";
import {
  formatTrustedToolIssue,
  TRUSTED_TOOL_ISSUE_CODES,
} from "../src/runtime/trusted-tool-issue";
import { openDb } from "../src/storage/db";

function setup(over: Partial<MemoryToolContext> = {}, max?: number) {
  const issues: { tool: string; code: string }[] = [];
  const ctx: MemoryToolContext = {
    db: openDb(":memory:"),
    home: mkdtempSync(join(tmpdir(), "msearch-")),
    workspace: "a",
    locationNames: () => [],
    threadLabel: "t",
    onIssue: (e) => issues.push(e),
    ...over,
  };
  const tool = createMemorySearchTool(ctx, createReadBudget(max));
  const call = async (args: Record<string, unknown>) => {
    const r = await tool.handler(args as never, {});
    return { text: (r.content[0] as { text: string }).text, isError: !!r.isError };
  };
  return { call, issues };
}

test("formatTrustedToolIssue: a known code and one feasible next step; detail is optional", () => {
  expect(formatTrustedToolIssue("invalid_input", "since must be YYYY-MM-DD")).toMatch(
    /^invalid_input: since must be YYYY-MM-DD\. \S/,
  );
  for (const code of TRUSTED_TOOL_ISSUE_CODES)
    expect(formatTrustedToolIssue(code)).toStartWith(code);
});

test("known search errors return a code plus guidance and report the issue", async () => {
  const s = setup();
  const bad = await s.call({ query: "x", since: "yesterday" });
  expect(bad.isError).toBe(true);
  expect(bad.text).toStartWith("invalid_input: since must be YYYY-MM-DD");
  const none = await s.call({ query: "!!!" });
  expect(none.text).toStartWith("invalid_input: query has no searchable words");
  expect(s.issues).toEqual([
    { tool: "MemorySearch", code: "invalid_input" },
    { tool: "MemorySearch", code: "invalid_input" },
  ]);
  const capped = setup({}, 1);
  await capped.call({ query: "x" });
  const over = await capped.call({ query: "x" });
  expect(over.text).toStartWith("limit:");
  expect(capped.issues.at(-1)).toEqual({ tool: "MemorySearch", code: "limit" });
});

test("an unknown exception withholds its raw text and is only `unavailable`; a 'permission denied' string is not a known issue", async () => {
  const s = setup({
    locationNames: () => {
      throw new Error("permission denied: /secret/path hunter2");
    },
  });
  const r = await s.call({ query: "common words" });
  expect(r.isError).toBe(true);
  expect(r.text).toStartWith("unavailable");
  expect(r.text).not.toMatch(/permission|secret|hunter2/i);
  expect(s.issues).toEqual([]); // an unknown failure is not a trusted issue: the supervisor must not count it
  expect(TRUSTED_TOOL_ISSUE_CODES).not.toContain("permission_denied" as never);
});
