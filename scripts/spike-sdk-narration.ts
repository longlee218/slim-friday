/* Owner-approved live spike (a few cents, NOT part of `bun test`):
   bun --env-file=<path to .env> scripts/spike-sdk-narration.ts
   Case A: does an assistant text and its tool_use arrive in one SDK assistant message, or alone?
   Case B: does a PostToolUse `updatedMCPToolOutput` replace what the model sees of an MCP result?
   Case C: with 40 in-process MCP tools (one alwaysLoad), are definitions deferred and found by search?
   Writes compact event lists to scripts/spike-out/narration.json. Never prints the token. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Options,
  type SDKMessage,
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createInputQueue } from "../packages/runtime-claude/src/session/input-queue";

if (!Bun.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN missing");
  process.exit(1);
}
const cwd = mkdtempSync(join(tmpdir(), "spike-narr-"));
const TIMEOUT_MS = 90_000;

type Log = Record<string, unknown>[];
const t0 = Date.now();
const stamp = () => Date.now() - t0;

/** Compact view of one SDK message: type, message id, content blocks (text/tool_use/tool_result). */
function brief(m: SDKMessage): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: spike reads loosely typed SDK fields
  const any = m as any;
  const out: Record<string, unknown> = { t: stamp(), type: m.type };
  if (any.subtype) out.subtype = any.subtype;
  if (m.type === "assistant") out.msgId = String(any.message?.id ?? "").slice(0, 14);
  if (m.type === "system" && any.subtype === "init") {
    const tools: string[] = any.tools ?? [];
    out.toolCount = tools.length;
    out.tools = tools.filter((n) => !/__t\d\d$/.test(n));
    out.hasT01T17 = [tools.some((n) => n.endsWith("__t01")), tools.some((n) => n.endsWith("__t17"))];
  }
  const blocks = any.message?.content;
  if (Array.isArray(blocks)) {
    // biome-ignore lint/suspicious/noExplicitAny: content blocks
    out.blocks = blocks.map((b: any) => {
      if (b.type === "text") return { text: String(b.text).slice(0, 200) };
      if (b.type === "tool_use")
        return { tool_use: b.name, input: JSON.stringify(b.input).slice(0, 120) };
      if (b.type === "tool_result")
        return { tool_result: b.tool_use_id?.slice(0, 12), len: JSON.stringify(b.content).length, content: JSON.stringify(b.content).slice(0, 120) };
      return { block: b.type };
    });
  }
  if (m.type === "result") out.result = String(any.result ?? "").slice(0, 300);
  return out;
}

/** Run one single-turn query with streaming input; returns the compact log. */
async function run(prompt: string, extra: Partial<Options>): Promise<Log> {
  const log: Log = [];
  const input = createInputQueue();
  const ac = new AbortController();
  const timer = setTimeout(() => (log.push({ ev: "TIMEOUT" }), ac.abort()), TIMEOUT_MS);
  const q = query({
    prompt: input.iterable,
    options: {
      model: "haiku",
      settingSources: [],
      permissionMode: "default",
      cwd,
      env: { ...process.env },
      abortController: ac,
      ...extra,
    },
  });
  input.push(prompt);
  try {
    for await (const m of q) {
      log.push(brief(m));
      if (m.type === "result") break;
    }
  } catch (e) {
    log.push({ ev: "threw", error: String(e).slice(0, 200) });
  }
  clearTimeout(timer);
  input.close();
  return log;
}

/** Case A: text then tool_use; compare blocks per assistant message. */
const caseA = () =>
  run(
    "First write one short sentence telling me what you are about to do. Then run `ls /tmp` with Bash. Then answer in one sentence.",
    { tools: ["Bash"], allowedTools: ["Bash"] },
  );

/** Case B: a 20 000-char MCP result trimmed to 10 chars by a PostToolUse hook. */
async function caseB(): Promise<Log> {
  const big = tool("big", "Returns a very long report", {}, async () => ({
    content: [{ type: "text", text: `START-${"x".repeat(19_990)}-END` }],
  }));
  const server = createSdkMcpServer({ name: "spike", tools: [big] });
  const hookCalls: Log = [];
  const log = await run(
    "Call the mcp__spike__big tool once. Then tell me, quoted exactly, the full text the tool returned if it is under 40 chars; otherwise say the first 20 chars and the approximate length.",
    {
      tools: [],
      mcpServers: { spike: server },
      allowedTools: ["mcp__spike__big"],
      hooks: {
        PostToolUse: [
          {
            hooks: [
              async (input) => {
                hookCalls.push({ ev: "hook", tool: (input as { tool_name?: string }).tool_name });
                return {
                  hookSpecificOutput: {
                    hookEventName: "PostToolUse",
                    updatedMCPToolOutput: "TRIMMED-OK!",
                  },
                };
              },
            ],
          },
        ],
      },
    },
  );
  return [...hookCalls, ...log];
}

/** Case C: 40 in-process tools, `t01` marked alwaysLoad, one deferred tool does the real job. */
/** `task` picks the tool needed; `env` overrides ENABLE_TOOL_SEARCH (undefined = SDK default). */
function caseC(task: string, env?: string): Promise<Log> {
  const tools = Array.from({ length: 40 }, (_, i) => {
    const name = `t${String(i + 1).padStart(2, "0")}`;
    const code = name === "t17"; // t17 is the only tool that can do the task
    return tool(
      name,
      code ? "Returns the secret zebra code of the stable" : `Utility number ${i + 1}: returns the number ${i + 1}`,
      {},
      async () => ({ content: [{ type: "text", text: code ? "ZEBRA-7731" : String(i + 1) }] }),
      { alwaysLoad: name === "t01" },
    );
  });
  const server = createSdkMcpServer({ name: "spike", tools });
  return run(task, {
    tools: ["ToolSearch"],
    mcpServers: { spike: server },
    allowedTools: ["mcp__spike__*", "ToolSearch"],
    env: { ...process.env, ...(env ? { ENABLE_TOOL_SEARCH: env } : {}) },
  });
}

const outDir = join(import.meta.dir, "spike-out");
mkdirSync(outDir, { recursive: true });
const A = await caseA();
const B = await caseB();
const ZEBRA = "Get me the secret zebra code of the stable using the available tools, and reply with it.";
const C = await caseC(ZEBRA); // default env
const C2 = await caseC(ZEBRA, "true"); // tool search forced on
const C3 = await caseC("Call the tool named t01 and tell me what it returned.", "true"); // alwaysLoad tool
writeFileSync(join(outDir, "narration.json"), JSON.stringify({ A, B, C, C2, C3 }, null, 2));
for (const [n, l] of [
  ["A", A],
  ["B", B],
  ["C", C],
  ["C2", C2],
  ["C3", C3],
] as const) {
  console.log(`--- case ${n}`);
  for (const e of l) console.log(JSON.stringify(e));
}
process.exit(0);
