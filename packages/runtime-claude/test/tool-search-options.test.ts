import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec, RunKind } from "@friday/core";
import { buildOptions } from "../src/session/build-options";
import { systemPromptOf } from "../src/session/system-prompt";

const base = realpathSync(mkdtempSync(join(tmpdir(), "optts-")));
const home = join(base, "home");
const scratch = join(home, "runs", "b1");
mkdirSync(scratch, { recursive: true });

const bot: Bot = {
  id: "b1",
  name: "Ann",
  title: "Dev",
  instructions: "x",
  model: "sonnet",
  tools: ["Read", "mcp__chat"],
  skills: [],
  subagents: [],
  workspaces: [],
};

/** A spec of one run kind with the given tool search mode (unset = the default). */
function specOf(runKind: RunKind, toolSearch?: string): BotRuntimeSpec {
  return { bot, runKind, toolSearch, decide: async () => ({ behavior: "allow" }) };
}

/** Options of a session; the owner's shell sets ENABLE_TOOL_SEARCH to prove the app owns the value. */
function build(runKind: RunKind, toolSearch?: string) {
  const config = {
    agentHome: home,
    scratchRoot: join(home, "runs"),
    oauthToken: "tok",
    env: { ENABLE_TOOL_SEARCH: "true" },
  };
  return buildOptions({
    spec: specOf(runKind, toolSearch),
    config,
    abort: new AbortController(),
    scratchDir: scratch,
  });
}

test("on leaves ENABLE_TOOL_SEARCH unset (the SDK default is on)", () => {
  for (const mode of [undefined, "on"]) {
    expect(build("owner", mode).env?.ENABLE_TOOL_SEARCH).toBeUndefined();
  }
});

test("off sets ENABLE_TOOL_SEARCH to false; auto:5 passes through", () => {
  expect(build("owner", "off").env?.ENABLE_TOOL_SEARCH).toBe("false");
  expect(build("owner", "auto:5").env?.ENABLE_TOOL_SEARCH).toBe("auto:5");
});

test("ToolSearch is a built-in tool of owner, bot and ticket runs unless search is off", () => {
  for (const k of ["owner", "bot", "ticket"] as const) {
    expect(build(k, "on").tools).toContain("ToolSearch");
    expect(build(k, "auto:5").tools).toContain("ToolSearch");
    expect(build(k, "off").tools).not.toContain("ToolSearch");
  }
});

test("an intro run never gets ToolSearch", () => {
  expect(build("intro", "on").tools).toEqual(["AskUserQuestion"]);
});

test("the system prompt has the search line when search is on, none when off, same for every run kind", () => {
  const prompt = (k: RunKind, m?: string) => systemPromptOf(specOf(k, m), scratch);
  expect(prompt("owner", "on")).toContain("ToolSearch");
  expect(prompt("owner")).toContain("ToolSearch");
  expect(prompt("owner", "off")).not.toContain("ToolSearch");
  expect(prompt("bot", "on")).toBe(prompt("owner", "on"));
  expect(prompt("ticket", "on")).toBe(prompt("owner", "on"));
});
