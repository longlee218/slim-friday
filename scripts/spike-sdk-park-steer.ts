/* Owner-approved live spike (a few cents, NOT part of `bun test`):
   bun --env-file=<path to .env> scripts/spike-sdk-park-steer.ts
   Case A: is a message pushed mid-turn (while a tool_use is in flight) answered inside the same turn?
   Case B: after abort() inside canUseTool, does `resume` + an approval message re-issue the tool call?
   Writes compact event lists to scripts/spike-out/park-steer.json. Never prints the token. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { createInputQueue } from "../packages/runtime-claude/src/session/input-queue";

if (!Bun.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN missing");
  process.exit(1);
}
const cwd = mkdtempSync(join(tmpdir(), "spike-park-"));
const TIMEOUT_MS = 90_000;

type Log = Record<string, unknown>[];
const t0 = Date.now();
const stamp = () => Date.now() - t0;

/** Compact view of one SDK message: type, subtype, session id, tool_use ids and short text. */
function brief(m: SDKMessage): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: spike reads loosely typed SDK fields
  const any = m as any;
  const out: Record<string, unknown> = { type: m.type };
  if (any.subtype) out.subtype = any.subtype;
  if (any.session_id) out.session = String(any.session_id).slice(0, 8);
  const blocks = any.message?.content;
  if (Array.isArray(blocks)) {
    // biome-ignore lint/suspicious/noExplicitAny: content blocks
    out.blocks = blocks.map((b: any) => {
      if (b.type === "text") return { text: String(b.text).slice(0, 200) };
      if (b.type === "tool_use")
        return { tool_use: b.id, name: b.name, input: JSON.stringify(b.input).slice(0, 120) };
      if (b.type === "tool_result")
        return {
          tool_result: b.tool_use_id,
          is_error: b.is_error,
          content: JSON.stringify(b.content).slice(0, 160),
        };
      return { block: b.type };
    });
  } else if (typeof blocks === "string") out.text = blocks.slice(0, 200);
  if (m.type === "result") out.result = String(any.result ?? "").slice(0, 200);
  return out;
}

const base = (extra: Partial<Options>): Options => ({
  model: "haiku",
  tools: ["Bash"],
  settingSources: [],
  permissionMode: "default",
  cwd,
  env: { ...process.env },
  ...extra,
});

/** Case A: push B while A's first tool_use is in flight (the tool is held open in canUseTool). */
async function caseA(): Promise<Log> {
  const log: Log = [];
  const input = createInputQueue();
  const ac = new AbortController();
  const timer = setTimeout(() => (log.push({ ev: "TIMEOUT" }), ac.abort()), TIMEOUT_MS);
  let pushedB = false;
  const q = query({
    prompt: input.iterable,
    options: base({
      abortController: ac,
      canUseTool: async (tool, i) => {
        log.push({ ev: "canUseTool", tool, t: stamp() });
        if (!pushedB) {
          pushedB = true;
          input.push("Also say the word PINEAPPLE in your final reply.");
          log.push({ ev: "pushed-B", t: stamp() });
          await new Promise((r) => setTimeout(r, 1500));
        }
        return { behavior: "allow", updatedInput: i };
      },
    }),
  });
  input.push(
    "Count the files in /tmp with exactly one Bash call (ls /tmp | wc -l), then reply with the number.",
  );
  let results = 0;
  try {
    for await (const m of q) {
      log.push({ t: stamp(), ...brief(m) });
      if (m.type === "result") {
        results++;
        if (results >= 2) break;
        // No second result within 12 s after the first: B was answered inline or lost.
        setTimeout(() => (log.push({ ev: "close-12s-after-first-result" }), input.close()), 12_000);
      }
    }
  } catch (e) {
    log.push({ ev: "threw", error: String(e).slice(0, 200) });
  }
  clearTimeout(timer);
  input.close();
  log.push({ ev: "summary", results });
  return log;
}

/** Case B: abort inside canUseTool (promise left unresolved), then resume with an approval message. */
async function caseB(): Promise<Log> {
  const log: Log = [];
  let sessionId = "";
  const input1 = createInputQueue();
  const ac1 = new AbortController();
  const timer = setTimeout(() => (log.push({ ev: "TIMEOUT-1" }), ac1.abort()), TIMEOUT_MS);
  const q1 = query({
    prompt: input1.iterable,
    options: base({
      abortController: ac1,
      canUseTool: (tool, i, opts) => {
        log.push({
          ev: "q1.canUseTool",
          tool,
          input: JSON.stringify(i).slice(0, 120),
          toolUseID: opts.toolUseID,
        });
        ac1.abort(); // park: abort, leave the promise unresolved
        return new Promise(() => {});
      },
    }),
  });
  input1.push("Run exactly this Bash command: ls /tmp . Then say done.");
  try {
    for await (const m of q1) {
      // biome-ignore lint/suspicious/noExplicitAny: session_id on every message
      const s = (m as any).session_id;
      if (s) sessionId = s;
      log.push({ phase: "q1", t: stamp(), ...brief(m) });
    }
  } catch (e) {
    log.push({ ev: "q1.threw", error: String(e).slice(0, 200) });
  }
  clearTimeout(timer);
  log.push({ ev: "q1.ended", sessionId: sessionId.slice(0, 8) });
  if (!sessionId) return log;

  const input2 = createInputQueue();
  const ac2 = new AbortController();
  const timer2 = setTimeout(() => (log.push({ ev: "TIMEOUT-2" }), ac2.abort()), TIMEOUT_MS);
  let reissued = false;
  const q2 = query({
    prompt: input2.iterable,
    options: base({
      resume: sessionId,
      abortController: ac2,
      canUseTool: async (tool, i, opts) => {
        reissued = true;
        log.push({
          ev: "q2.canUseTool",
          tool,
          input: JSON.stringify(i).slice(0, 120),
          toolUseID: opts.toolUseID,
        });
        return { behavior: "allow", updatedInput: i };
      },
    }),
  });
  input2.push(
    "The owner approved: Bash `ls /tmp`. Your earlier request did not run. Call exactly this request again now (Bash, command `ls /tmp`), then say done.",
  );
  try {
    for await (const m of q2) {
      log.push({ phase: "q2", t: stamp(), ...brief(m) });
      if (m.type === "result") break;
    }
  } catch (e) {
    log.push({ ev: "q2.threw", error: String(e).slice(0, 200) });
  }
  clearTimeout(timer2);
  input2.close();
  log.push({ ev: "summary", reissued });
  return log;
}

const outDir = join(import.meta.dir, "spike-out");
mkdirSync(outDir, { recursive: true });
const A = await caseA();
const B = await caseB();
writeFileSync(join(outDir, "park-steer.json"), JSON.stringify({ A, B }, null, 2));
for (const [n, l] of [
  ["A", A],
  ["B", B],
] as const) {
  console.log(`--- case ${n}`);
  for (const e of l) console.log(JSON.stringify(e));
}
process.exit(0);
