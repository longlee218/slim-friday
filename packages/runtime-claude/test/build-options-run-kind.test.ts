import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, BotRuntimeSpec, RunKind } from "@friday/core";
import { buildOptions } from "../src/session/build-options";

const base = realpathSync(mkdtempSync(join(tmpdir(), "optsk-")));
const home = join(base, "home");
const scratch = join(home, "runs", "b1");
mkdirSync(scratch, { recursive: true });

const bot: Bot = {
  id: "b1",
  name: "Ann",
  title: "Dev",
  instructions: "x",
  model: "sonnet",
  tools: ["Read", "Bash", "mcp__memory", "mcp__chat"],
  skills: [],
  subagents: [{ name: "helper", description: "d", prompt: "p", tools: ["Read"] }],
  workspaces: [],
};
const server = { type: "sdk", name: "s", instance: {} } as unknown as McpServerConfig;

/** Options of a session of one run kind; `decide` records what reached it. */
function build(runKind: RunKind) {
  const decided: string[] = [];
  const spec: BotRuntimeSpec = {
    bot,
    runKind,
    async decide(call) {
      decided.push(call.tool);
      return { behavior: "allow" };
    },
  };
  const config = {
    agentHome: home,
    scratchRoot: join(home, "runs"),
    oauthToken: "tok",
    mcpServersFor: () => ({ chat: server, memory: server }),
  };
  const o = buildOptions({ spec, config, abort: new AbortController(), scratchDir: scratch });
  return { o, decided };
}
const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

test("owner, bot and ticket runs keep the configured tools and servers", () => {
  for (const k of ["owner", "bot", "ticket"] as const) {
    const { o } = build(k);
    expect(o.tools).toEqual(["Read", "Bash"]);
    expect(Object.keys(o.mcpServers ?? {}).sort()).toEqual(["chat", "memory"]);
    expect(Object.keys(o.agents ?? {})).toEqual(["helper"]);
  }
});

test("intro run: only AskUserQuestion and UpdateProfile, no subagents, no other server", async () => {
  const { o, decided } = build("intro");
  expect(o.tools).toEqual(["AskUserQuestion"]);
  expect(Object.keys(o.mcpServers ?? {})).toEqual(["chat"]);
  expect(o.agents).toEqual({});
  const can = o.canUseTool;
  if (!can) throw new Error("no canUseTool");
  for (const tool of ["Bash", "Read", "mcp__memory__MemorySearch", "mcp__chat__PostFile"]) {
    expect((await can(tool, {}, opts))?.behavior).toBe("deny");
  }
  expect((await can("mcp__chat__UpdateProfile", {}, opts))?.behavior).toBe("allow");
  expect(decided).toEqual(["mcp__chat__UpdateProfile"]);
});
