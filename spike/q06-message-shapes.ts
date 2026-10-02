// Q6: capture message shapes: assistant.usage, result fields, tool_use/tool_result blocks.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, trunc } from "./common";

const seen = new Set<string>();
for await (const m of query({
  prompt: "Read a.txt with the Read tool and tell me its content in one word.",
  options: { cwd: PROJ, model: MODEL, maxTurns: 4, tools: ["Read"], allowedTools: ["Read"], settingSources: [], includePartialMessages: false },
})) {
  const a = m as any;
  const kind = `${a.type}/${a.subtype ?? ""}`;
  console.log("MSG", kind);
  if (a.type === "assistant" && !seen.has("assistant")) {
    seen.add("assistant");
    console.log(" assistant.message keys:", Object.keys(a.message));
    console.log(" assistant.message.usage:", trunc(a.message.usage, 500));
    console.log(" assistant.message.stop_reason:", a.message.stop_reason, "model:", a.message.model);
  }
  for (const b of a.message?.content ?? []) {
    if ((b.type === "tool_use" || b.type === "tool_result") && !seen.has(b.type)) {
      seen.add(b.type);
      console.log(` ${b.type} block keys:`, Object.keys(b), trunc(b, 400));
    }
  }
  if (a.type === "result") {
    console.log(" result keys:", Object.keys(a));
    console.log(" result.usage:", trunc(a.usage, 500));
    console.log(" result.modelUsage:", trunc(a.modelUsage, 500));
    console.log(" result scalars:", trunc({ cost: a.total_cost_usd, turns: a.num_turns, dur: a.duration_ms, stop: a.stop_reason, terminal: a.terminal_reason, denials: a.permission_denials }, 300));
  }
}
