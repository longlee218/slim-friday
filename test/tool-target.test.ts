import { expect, test } from "bun:test";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import { describeTool } from "../src/observability/tool-target";
import {
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../src/tools/sdk-tool-names";

const roots = ["/ws/location", "/ws/other"];

test("Read inside a root is relative, with the line range", () => {
  const d = describeTool(
    READ_TOOL_NAME,
    { file_path: "/ws/location/src/a.ts", offset: 70, limit: 90 },
    roots,
  );
  expect(d).toMatchObject({ kind: "read", target: "src/a.ts:70-159", short: "a.ts" });
});

test("Read outside every root shows only the basename", () => {
  expect(describeTool(READ_TOOL_NAME, { file_path: "/etc/secret/passwd" }, roots).target).toBe(
    "…/passwd",
  );
});

test("Grep and Glob: quoted pattern in a relative dir; long pattern clipped", () => {
  expect(
    describeTool(GREP_TOOL_NAME, { pattern: "foo", path: "/ws/location/src" }, roots),
  ).toMatchObject({
    kind: "search",
    target: '"foo" in src',
  });
  const long = describeTool(GLOB_TOOL_NAME, { pattern: "a".repeat(300) }, roots);
  expect(long.target.length).toBeLessThan(100);
  expect(long.short.length).toBeLessThanOrEqual(40);
});

test("Edit: relative path, kind edit", () => {
  expect(describeTool(EDIT_TOOL_NAME, { file_path: "/ws/other/x.ts" }, roots)).toMatchObject({
    kind: "edit",
    target: "x.ts",
  });
});

test("Bash: first 80 chars on one line, secrets masked, short clipped to 40", () => {
  const d = describeTool(
    BASH_TOOL_NAME,
    { command: `echo password: hunter2\n${"y".repeat(200)}` },
    roots,
  );
  expect(d.kind).toBe("command");
  expect(d.target).not.toContain("hunter2");
  expect(d.target).not.toContain("\n");
  expect(d.target.length).toBeLessThanOrEqual(90);
  expect(d.short.length).toBeLessThanOrEqual(45);
});

test("git MCP tool: name + relative path, kind git", () => {
  const d = describeTool(
    mcpToolName(GIT_MCP_SERVER, GIT_TOOL.LOG),
    { path: "/ws/location/lib" },
    roots,
  );
  expect(d).toMatchObject({ kind: "git", target: "git_log lib" });
});

test("WebFetch: host only (no path/query secrets)", () => {
  const d = describeTool(WEB_FETCH_TOOL_NAME, { url: "https://a.io/p?token=abc" }, roots);
  expect(d).toMatchObject({ kind: "web", target: "a.io" });
});

test("Skill: skill name; unknown tool: empty target, kind other", () => {
  expect(describeTool(SKILL_TOOL_NAME, { skill: "main:deploy" }).target).toBe("main:deploy");
  expect(describeTool("Whatever", { x: 1 })).toEqual({ kind: "other", target: "", short: "" });
});

test("non-object input does not throw", () => {
  expect(describeTool(READ_TOOL_NAME, null).target).toBe("");
});

const GHP = `ghp_${"A".repeat(30)}`;

test("secret straddling the clip boundary never leaks (Bash, Grep, WebSearch): redact before clip", () => {
  for (const [tool, input] of [
    [BASH_TOOL_NAME, { command: `${"x".repeat(60)} ${GHP} tail` }],
    [BASH_TOOL_NAME, { command: `${"x".repeat(30)} Authorization: Bearer ${GHP}` }],
    [GREP_TOOL_NAME, { pattern: `${"x".repeat(60)}${GHP}` }],
    [WEB_SEARCH_TOOL_NAME, { query: `${"x".repeat(70)}${GHP}` }],
  ] as const) {
    const d = describeTool(tool, input, roots);
    for (const text of [d.target, d.short]) {
      expect(text).not.toContain("ghp_A");
      expect(text).not.toContain("AAAA");
      expect(text).not.toMatch(/ghp_?$|ghp_…|Bearer…/);
    }
  }
});

test("a token prefix left at the cut is dropped", () => {
  // 79 filler chars + "ghp_AB": the clip (80) would leave "ghp_A" if the secret were short enough to survive redaction.
  const d = describeTool(BASH_TOOL_NAME, { command: `${"x".repeat(33)} ghp_ABC` }, roots);
  expect(d.short).not.toContain("ghp_");
});

test("a dir named ..foo inside the root is inside; a relative path escaping the root is not shown", () => {
  expect(describeTool(READ_TOOL_NAME, { file_path: "/ws/location/..foo/a.ts" }, roots).target).toBe(
    "..foo/a.ts",
  );
  expect(describeTool(READ_TOOL_NAME, { file_path: "../../etc/passwd" }, roots).target).toBe(
    "…/passwd",
  );
  expect(describeTool(READ_TOOL_NAME, { file_path: "src/./a.ts" }, roots).target).toBe("src/a.ts");
});

test("clipping never splits a surrogate pair", () => {
  const d = describeTool(BASH_TOOL_NAME, { command: "😀".repeat(100) }, roots);
  expect(d.target).not.toMatch(/[\ud800-\udbff]…?$/);
  expect(d.short).not.toMatch(/[\ud800-\udbff]…?$/);
});

test("Read with offset only prints :70+, limit only :1-N", () => {
  expect(
    describeTool(READ_TOOL_NAME, { file_path: "/ws/location/x.ts", offset: 70 }, roots).target,
  ).toBe("x.ts:70+");
  expect(
    describeTool(READ_TOOL_NAME, { file_path: "/ws/location/x.ts", limit: 50 }, roots).target,
  ).toBe("x.ts:1-50");
});
