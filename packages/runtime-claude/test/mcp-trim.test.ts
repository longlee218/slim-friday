import { expect, test } from "bun:test";
import { postToolUseHook } from "../src/session/post-tool-use-hook";

/** Run the hook for one finished tool call. */
async function run(tool_name: string, tool_response: unknown, source?: string) {
  const hook = postToolUseHook();
  const input = {
    hook_event_name: "PostToolUse",
    tool_name,
    tool_input: {},
    tool_response,
    tool_use_id: "t1",
    ...(source && { mcp_server: { name: tool_name.split("__")[1], source } }),
  };
  return (await hook(input as any, "t1", { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { updatedMCPToolOutput?: string };
  };
}

const big = { content: [{ type: "text", text: "z".repeat(20_000) }] };

test("an external MCP result over the limit is replaced by the clipped text", async () => {
  const out = await run("mcp__github__list", big, "user");
  const text = out.hookSpecificOutput?.updatedMCPToolOutput ?? "";
  expect(text.startsWith("z".repeat(12_000))).toBe(true);
  expect(text).toContain("8000 more characters");
});

test("an error result and a plain string result are clipped too", async () => {
  const err = await run("mcp__github__list", { ...big, isError: true }, "user");
  expect(err.hookSpecificOutput?.updatedMCPToolOutput).toContain("output cut");
  const str = await run("mcp__github__list", "q".repeat(13_000), "user");
  expect(str.hookSpecificOutput?.updatedMCPToolOutput).toContain("1000 more characters");
});

test("a short external result and a non-MCP tool are untouched", async () => {
  expect((await run("mcp__github__list", "short", "user")).hookSpecificOutput).toBeUndefined();
  expect((await run("Bash", "x".repeat(20_000))).hookSpecificOutput).toBeUndefined();
});

test("a Friday-own server is untouched (by provenance and by name)", async () => {
  expect((await run("mcp__memory__MemorySearch", big, "sdk")).hookSpecificOutput).toBeUndefined();
  expect((await run("mcp__tickets__Ticket", big)).hookSpecificOutput).toBeUndefined();
});

test("a result with an image part is left alone", async () => {
  const mixed = {
    content: [
      { type: "text", text: "z".repeat(20_000) },
      { type: "image", data: "" },
    ],
  };
  expect((await run("mcp__github__shot", mixed, "user")).hookSpecificOutput).toBeUndefined();
});
