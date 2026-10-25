import { expect, test } from "bun:test";
import type { ToolAnnotations } from "../../src/domain/tool";
import { classifyTool } from "../../src/permission/classify-tool";

/** A spec of an external MCP tool `mcp__ext__<name>` with the server's hints. */
const ext = (name: string, annotations?: ToolAnnotations) => ({
  name: `mcp__ext__${name}`,
  annotations,
});

test("external consequential name: write, or external with an open-world hint", () => {
  expect(classifyTool(ext("send_email", {}))).toBe("write");
  expect(classifyTool(ext("send_email", { openWorldHint: true, destructiveHint: false }))).toBe(
    "external",
  );
  // No spec at all: the name still decides.
  expect(classifyTool(undefined, "mcp__ext__delete_file")).toBe("write");
});

test("a readOnlyHint never lifts a consequential name", () => {
  expect(classifyTool(ext("post_message", { readOnlyHint: true }))).toBe("write");
  expect(classifyTool(ext("get_and_delete", { readOnlyHint: true }))).toBe("write");
});

test("external read name: read unless destructive or readOnlyHint false", () => {
  expect(classifyTool(ext("list_issues"))).toBe("read");
  expect(classifyTool(ext("search_docs", { readOnlyHint: true }))).toBe("read");
  expect(classifyTool(ext("list_issues", { destructiveHint: true }))).toBe("destructive");
  expect(classifyTool(ext("list_issues", { readOnlyHint: false }))).toBe("write");
  expect(classifyTool(ext("list_issues", { readOnlyHint: false, openWorldHint: true }))).toBe(
    "external",
  );
});

test("external unknown name keeps the hint logic", () => {
  expect(classifyTool(ext("frobnicate"))).toBe("unknown");
  expect(classifyTool(ext("frobnicate", { readOnlyHint: true }))).toBe("read");
  expect(classifyTool(ext("frobnicate", { destructiveHint: false }))).toBe("write");
  expect(classifyTool(ext("frobnicate", {}))).toBe("destructive");
});

test("substring verbs do not count: postgres_query is read", () => {
  expect(classifyTool(ext("postgres_query"))).toBe("read");
});

test("Friday's own tools and built-ins keep their tools.yaml class", () => {
  expect(
    classifyTool({ name: "mcp__memory__ListNotesAndDelete", annotations: { readOnlyHint: true } }),
  ).toBe("read");
  expect(
    classifyTool({ name: "mcp__tickets__TicketUpdate", annotations: { readOnlyHint: true } }),
  ).toBe("read");
  expect(classifyTool({ name: "Write", annotations: { destructiveHint: false } })).toBe("write");
  expect(classifyTool({ name: "WebFetch", annotations: { readOnlyHint: true } })).toBe("read");
});
