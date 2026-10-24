/* Owner-run live spike (costs a few cents, NOT part of `bun test`): bun scripts/spike-sdk-shapes.ts
   Pins what the Claude Agent SDK sends for AskUserQuestion (via canUseTool), tool_use / tool_result blocks, thinking
   and subagent task_started. Every SDK message and canUseTool call goes to scripts/spike-out/sdk-shapes.jsonl and one
   verdict line per question is printed. Never prints the token. */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";

if (!Bun.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN missing (put it in .env)");
  process.exit(1);
}

const outDir = join(import.meta.dir, "spike-out");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "sdk-shapes.jsonl");
writeFileSync(outFile, "");
const cwd = mkdtempSync(join(tmpdir(), "spike-sdk-"));
writeFileSync(join(cwd, "note.txt"), "hello from note.txt\n");

/** One jsonl row: which run, what kind (msg or permission call) and the raw payload. */
const log = (run: string, kind: string, data: unknown) =>
  appendFileSync(outFile, `${JSON.stringify({ run, kind, data })}\n`);

/** Runs one one-turn query; `answer` builds the `answers` map for an AskUserQuestion call. */
async function run(
  label: string,
  prompt: string,
  answer: (q: { question: string }) => string,
  extra: Partial<Options> = {},
): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = [];
  const q = query({
    prompt,
    options: {
      model: "claude-sonnet-4-5",
      effort: "high",
      tools: ["AskUserQuestion", "Read", "Bash"],
      settingSources: [],
      permissionMode: "default",
      cwd,
      env: { ...process.env },
      canUseTool: async (tool, input) => {
        log(label, "canUseTool", { tool, input });
        if (tool !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
        const qs = (input.questions ?? []) as { question: string }[];
        const answers = Object.fromEntries(qs.map((x) => [x.question, answer(x)]));
        return { behavior: "allow", updatedInput: { ...input, answers } };
      },
      ...extra,
    },
  });
  for await (const m of q) {
    msgs.push(m);
    log(label, "msg", m);
  }
  return msgs;
}

const base = "Then Read note.txt, then run `echo hi`, then tell me my answer.";
const single = await run(
  "single",
  `Use AskUserQuestion to ask me which color I prefer: Red or Blue. ${base}`,
  () => "Blue",
);
const multi = await run(
  "multi",
  `Use AskUserQuestion with multiSelect true to ask me which colors I like: Red, Blue. ${base}`,
  () => "Red, Blue",
);
const free = await run(
  "free",
  `Use AskUserQuestion to ask me which color I prefer: Red or Blue. ${base}`,
  () => "Green please",
);
const sub = await run("subagent", "Start a background subagent that says hi.", () => "", {
  tools: ["Agent"],
  agents: {
    helper: { description: "Says hi.", prompt: "Say hi in one word.", tools: [], background: true },
  },
});

// ---- verdicts ----
/* biome-ignore lint/suspicious/noExplicitAny: raw SDK frames are inspected by shape */
type Any = any;
const blocks = (ms: SDKMessage[], type: string, kind: "assistant" | "user"): Any[] =>
  (ms as Any[])
    .filter((m) => m.type === kind && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content.filter((c: Any) => c.type === type));
const askResult = (ms: SDKMessage[]) => {
  const use = blocks(ms, "tool_use", "assistant").find((b) => b.name === "AskUserQuestion");
  const res = blocks(ms, "tool_result", "user").find((b) => b.tool_use_id === use?.id);
  return JSON.stringify(res?.content ?? null);
};
const asked = (ms: SDKMessage[]) => blocks(ms, "tool_use", "assistant").some((b) => b.name === "AskUserQuestion");
const a =
  asked(single) &&
  askResult(single).includes("Blue") &&
  askResult(multi).includes("Red, Blue") &&
  askResult(free).includes("Green please");
const mainUse = blocks(single, "tool_use", "assistant").find((b) => b.name === "Read");
const mainMsg = (single as Any[]).find((m) => m.type === "assistant" && m.message.content.some((c: Any) => c.id === mainUse?.id));
const b = !!mainUse && typeof mainUse.id === "string" && !!mainUse.input && mainMsg.parent_tool_use_id === null;
const results = blocks(single, "tool_result", "user");
const c = results.length > 0 && results.every((r) => typeof r.tool_use_id === "string");
const all = [...single, ...multi, ...free, ...sub] as Any[];
const thinkBlock = all.some((m) => m.type === "assistant" && m.message?.content?.some((x: Any) => x.type === "thinking" || x.type === "redacted_thinking"));
const thinkTokens = all.some((m) => m.type === "system" && m.subtype === "thinking_tokens");
const started = (sub as Any[]).find((m) => m.type === "system" && m.subtype === "task_started");
console.log(`(a) askViaCanUseTool: ${a}`);
console.log(`(b) main-thread tool_use id/name/input, parent null: ${b}`);
console.log(`(c) tool_result tool_use_id (is_error optional): ${c}`);
console.log(`(d) thinking: ${thinkBlock ? "block" : thinkTokens ? "thinking_tokens" : "none"}`);
console.log(`taskStartedHasToolUseId: ${started ? typeof started.tool_use_id === "string" : "no task_started seen"}`);
console.log(`raw log: ${outFile}`);
