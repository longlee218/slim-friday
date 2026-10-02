// Q8b: maxTurns, maxBudgetUsd, abortController behaviour (result subtype / thrown error).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, trunc } from "./common";

const base = { cwd: PROJ, model: MODEL, settingSources: [] as ("project")[], tools: ["Read", "Glob"] };
const longPrompt = "Read a.txt, then b.txt, then c.txt, one tool call per turn, then summarize.";

async function run(name: string, options: any, abortAfterMs?: number) {
  const ac = new AbortController();
  if (abortAfterMs) setTimeout(() => ac.abort(), abortAfterMs);
  const t0 = Date.now();
  try {
    for await (const m of query({ prompt: longPrompt, options: { ...base, ...options, abortController: ac } })) {
      const a = m as any;
      if (a.type === "result")
        console.log(`[${name}] result subtype=${a.subtype} is_error=${a.is_error} turns=${a.num_turns} cost=${a.total_cost_usd} terminal=${a.terminal_reason} errors=${trunc(a.errors, 200)} text=${trunc(a.result, 100)}`);
    }
    console.log(`[${name}] loop ended normally in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`[${name}] THROWN after ${Date.now() - t0}ms: ${String(e).slice(0, 200)}`);
  }
}

await run("maxTurns=1", { maxTurns: 1 });
await run("maxBudgetUsd=0.001", { maxTurns: 6, maxBudgetUsd: 0.001 });
await run("abort@4s", { maxTurns: 6 }, 4000);
