import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec, RuntimeToolCall, ToolDecision } from "@friday/core";
import { MEMORY_LABEL } from "@friday/core";
import { buildOptions } from "../src/session/build-options";

const base = realpathSync(mkdtempSync(join(tmpdir(), "opts-")));
const ws1 = join(base, "ws1");
const ws2 = join(base, "ws2");
const home = join(base, "home");
const scratch = join(home, "runs", "b1");
for (const d of [ws1, ws2, scratch]) mkdirSync(d, { recursive: true });

const bot = (over: Partial<Bot> = {}): Bot => ({
  id: "b1",
  name: "Ann",
  title: "Dev",
  instructions: "Be brief.",
  model: "sonnet",
  tools: ["Read", "Bash"],
  skills: [],
  subagents: [],
  workspaces: [ws1, ws2],
  ...over,
});

/** A spec whose `decide` records its calls and answers `answer`. */
function spec(b: Bot, answer: ToolDecision | Error = { behavior: "allow" }) {
  const calls: RuntimeToolCall[] = [];
  const s: BotRuntimeSpec = {
    bot: b,
    async decide(call) {
      calls.push(call);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { s, calls };
}

const config = { agentHome: home, scratchRoot: join(home, "runs"), oauthToken: "tok" };
const build = (s: BotRuntimeSpec, resume?: string) =>
  buildOptions({ spec: s, config, resume, abort: new AbortController(), scratchDir: scratch });
const opts = { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" };

test("options carry the bot's model, dirs, tools and safe defaults", () => {
  const o = build(spec(bot()).s);
  expect(o.model).toBe("sonnet");
  expect(o.cwd).toBe(ws1);
  expect(o.additionalDirectories).toEqual([ws2]);
  expect(o.tools).toEqual(["Read", "Bash"]);
  expect(o.settingSources).toEqual([]);
  expect(o.permissionMode).toBe("default");
  expect(o.systemPrompt).toBe("You are Ann, Dev.\n\nBe brief.");
  expect(build(spec(bot()).s, "abc").resume).toBe("abc");
});

test("subagents are background agents; the env allows background tasks and hides secrets", () => {
  const sub = { name: "helper", description: "d", prompt: "p", tools: ["Read"], model: "haiku" };
  const o = build(spec(bot({ subagents: [sub] })).s);
  expect(o.agents?.helper).toMatchObject({
    description: "d",
    prompt: "p",
    tools: ["Read"],
    background: true,
  });
  expect(o.env && "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" in o.env).toBe(false);
  expect(o.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  expect(o.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
});

test("a bot with no workspaces runs in the scratch dir and the sandbox writes only there", () => {
  const o = build(spec(bot({ workspaces: [] })).s);
  expect(o.cwd).toBe(scratch);
  expect(o.sandbox?.filesystem?.allowWrite).toEqual([scratch]);
});

test("the floor denies a file outside the workspaces and decide is not called", async () => {
  const { s, calls } = spec(bot());
  const r = await build(s).canUseTool?.("Read", { file_path: "/etc/hosts" }, opts);
  expect(r?.behavior).toBe("deny");
  expect(calls).toEqual([]);
});

test("Bash goes to decide with the subagent's task id and the answer is mapped", async () => {
  const allow = spec(bot());
  const r = await build(allow.s).canUseTool?.(
    "Bash",
    { command: "ls" },
    { ...opts, agentID: "task-9" },
  );
  expect(r).toMatchObject({ behavior: "allow", updatedInput: { command: "ls" } });
  expect(allow.calls).toEqual([{ tool: "Bash", input: { command: "ls" }, taskId: "task-9" }]);
  const deny = spec(bot(), { behavior: "deny", reason: "no" });
  expect(await build(deny.s).canUseTool?.("Bash", { command: "ls" }, opts)).toMatchObject({
    behavior: "deny",
    message: "no",
  });
});

test("a park ends the turn with an interrupting deny and the tool does not run", async () => {
  const { s } = spec(bot(), { behavior: "park", cardId: "c1" });
  expect(await build(s).canUseTool?.("Bash", { command: "ls" }, opts)).toMatchObject({
    behavior: "deny",
    interrupt: true,
  });
});

test("a decide that throws is a deny", async () => {
  const { s } = spec(bot(), new Error("boom"));
  expect((await build(s).canUseTool?.("Bash", { command: "ls" }, opts))?.behavior).toBe("deny");
});

/** Run the PreToolUse hook of the options like the SDK does (it runs even for calls the CLI auto-allows). */
async function preToolUse(tool: string, toolInput: Record<string, unknown>) {
  const hook = build(spec(bot()).s).hooks?.PreToolUse?.[0]?.hooks[0];
  return hook?.(
    {
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id: "t1",
    } as never,
    "t1",
    { signal: new AbortController().signal },
  );
}

test("a PreToolUse hook applies the floor to calls the CLI auto-allows", async () => {
  const denied = await preToolUse("Read", { file_path: join(ws1, ".env") });
  expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  const agentHome = await preToolUse("Grep", { pattern: "x", path: home });
  expect(agentHome).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(await preToolUse("Read", { file_path: join(ws1, "a.ts") })).toEqual({ continue: true });
  expect(await preToolUse("Bash", { command: "ls" })).toEqual({ continue: true });
});

// Extra dirs the app grants to one bot (the Friday bot edits the config dir, reads the templates).
const cfgDir = join(home, "config");
const tplDir = join(base, "templates");
mkdirSync(join(cfgDir, "bots"), { recursive: true });
mkdirSync(join(tplDir, "code"), { recursive: true });
const extraConfig = {
  ...config,
  extraDirsFor: (b: Bot) =>
    b.id === "friday" ? { write: [cfgDir], read: [tplDir] } : { write: [], read: [] },
};
const buildFor = (b: Bot) =>
  buildOptions({
    spec: spec(b).s,
    config: extraConfig,
    abort: new AbortController(),
    scratchDir: scratch,
  });

test("extra dirs: the granted bot reaches them, the rest of agentHome and others stay denied", async () => {
  const f = buildFor(bot({ id: "friday", workspaces: [] }));
  const allow = (t: string, i: Record<string, unknown>) => f.canUseTool?.(t, i, opts);
  expect(
    (await allow("Write", { file_path: join(cfgDir, "bots", "x.md"), content: "" }))?.behavior,
  ).toBe("allow");
  expect((await allow("Read", { file_path: join(tplDir, "code", "group.yaml") }))?.behavior).toBe(
    "allow",
  );
  expect((await allow("Read", { file_path: join(home, "data", "engine.db") }))?.behavior).toBe(
    "deny",
  );
  expect((await allow("Write", { file_path: join(tplDir, "x"), content: "" }))?.behavior).toBe(
    "deny",
  );
  expect(f.additionalDirectories).toEqual([cfgDir, tplDir]);
  expect(f.sandbox?.filesystem?.allowWrite).toContain(cfgDir);
  const other = buildFor(bot({ workspaces: [] }));
  expect(
    (
      await other.canUseTool?.(
        "Write",
        { file_path: join(cfgDir, "bots", "x.md"), content: "" },
        opts,
      )
    )?.behavior,
  ).toBe("deny");
  expect(other.additionalDirectories).toEqual([]);
});

test("extraDirsFor gets the group id of a group spec, none for a direct spec", () => {
  const seen: (string | undefined)[] = [];
  const cfg = {
    ...config,
    extraDirsFor: (_b: Bot, groupId?: string) => {
      seen.push(groupId);
      return { write: [], read: [] };
    },
  };
  const s = spec(bot()).s;
  const run = (x: BotRuntimeSpec) =>
    buildOptions({ spec: x, config: cfg, abort: new AbortController(), scratchDir: scratch });
  run(s);
  run({ ...s, groupId: "reelme", sessionKey: "b1@reelme" });
  expect(seen).toEqual([undefined, "reelme"]);
});

test("a workspace inside the agent home is refused", () => {
  const inside = join(home, "data");
  expect(() => build(spec(bot({ workspaces: [inside] })).s)).toThrow("agent home");
});

test("a workspace that reaches the agent home by `..` or a symlink is refused", () => {
  mkdirSync(join(home, "data"), { recursive: true });
  const link = join(base, "link-to-home");
  symlinkSync(home, link);
  for (const w of [join(base, "x", "..", "home", "data"), join(link, "data"), link])
    expect(() => build(spec(bot({ workspaces: [w] })).s)).toThrow("agent home");
});

// MCP: built-in names go to `tools`, `mcp__` names pick servers; per-session servers come from the app.
const mcpConfig = {
  ...config,
  mcpServers: {
    playwright: { type: "stdio" as const, command: "npx" },
    other: { type: "stdio" as const, command: "x" },
  },
  mcpServersFor: () => ({ memory: { type: "stdio" as const, command: "mem" } }),
};
const buildMcp = (tools: string[], s = spec(bot({ tools }))) =>
  buildOptions({ spec: s.s, config: mcpConfig, abort: new AbortController(), scratchDir: scratch });

test("mcp names pick servers and never reach the built-in tools list; an unknown server is ignored", () => {
  const o = buildMcp(["Read", "mcp__playwright__browser_navigate", "mcp__ghost"]);
  expect(o.tools).toEqual(["Read"]);
  expect(Object.keys(o.mcpServers ?? {}).sort()).toEqual(["memory", "playwright"]);
});

test("an MCP tool the bot did not name is denied before decide; a named or per-session one reaches decide", async () => {
  const s = spec(bot({ tools: ["mcp__playwright__browser_navigate"] }));
  const o = buildMcp([], s);
  const r = await o.canUseTool?.("mcp__playwright__browser_click", {}, opts);
  expect(r?.behavior).toBe("deny");
  expect(s.calls).toEqual([]);
  await o.canUseTool?.("mcp__playwright__browser_navigate", {}, opts);
  await o.canUseTool?.("mcp__memory__MemorySave", {}, opts);
  expect(s.calls.map((c) => c.tool)).toEqual([
    "mcp__playwright__browser_navigate",
    "mcp__memory__MemorySave",
  ]);
});

test("the bot's memory ends the system prompt", () => {
  const s = spec(bot());
  const o = buildOptions({
    spec: { ...s.s, memory: "## Facts\n- likes tea" },
    config,
    abort: new AbortController(),
    scratchDir: scratch,
  });
  expect(o.systemPrompt).toBe(
    `You are Ann, Dev.\n\nBe brief.\n\n## Your memory\n${MEMORY_LABEL}\n\n## Facts\n- likes tea`,
  );
});

test("a group session's context and group memory follow the bot memory in the system prompt", () => {
  const s = spec(bot());
  const o = buildOptions({
    spec: { ...s.s, memory: "B", groupContext: "X", groupMemory: "M" },
    config,
    abort: new AbortController(),
    scratchDir: scratch,
  });
  expect(o.systemPrompt).toBe(
    `You are Ann, Dev.\n\nBe brief.\n\n## Your memory\n${MEMORY_LABEL}\n\nB\n\n## Group context\nX\n\n## Group memory\n${MEMORY_LABEL}\n\nM`,
  );
});

/** Run the PostCompact hook of the options like the SDK does. */
function postCompact(onCompact: (s: BotRuntimeSpec, summary: string) => void, agentId?: string) {
  const s = spec(bot()).s;
  const o = buildOptions({
    spec: s,
    config: { ...config, onCompact },
    abort: new AbortController(),
    scratchDir: scratch,
  });
  const hook = o.hooks?.PostCompact?.[0]?.hooks[0];
  return hook?.(
    {
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "we chose bun",
      ...(agentId && { agent_id: agentId }),
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
}

test("the PostCompact hook hands the main thread's summary to onCompact without waiting", async () => {
  const got: string[] = [];
  const r = await postCompact((_s, summary) => {
    got.push(summary);
  });
  expect(r).toEqual({ continue: true });
  expect(got).toEqual(["we chose bun"]);
  const sub: string[] = [];
  await postCompact((_s, summary) => {
    sub.push(summary);
  }, "agent-1");
  expect(sub).toEqual([]);
});

test("mcpServers may be a function, read at every session build", () => {
  let servers: Record<string, { type: "stdio"; command: string }> = {};
  const live = { ...config, mcpServers: () => servers };
  const make = () =>
    buildOptions({
      spec: spec(bot({ tools: ["mcp__web__fetch"] })).s,
      config: live,
      abort: new AbortController(),
      scratchDir: scratch,
    });
  expect(make().mcpServers).toBeUndefined();
  servers = { web: { type: "stdio", command: "w" } };
  expect(Object.keys(make().mcpServers ?? {})).toEqual(["web"]);
});
