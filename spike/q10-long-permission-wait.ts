// Q10: canUseTool awaits N seconds (arg, default 90) then allows. Any SDK timeout/error would show.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, trunc } from "./common";

const waitMs = Number(process.argv[2] ?? 90) * 1000;
const t0 = Date.now();
for await (const m of query({
  prompt: "Create file waited.txt containing 'ok' with the Write tool. Then say done.",
  options: {
    cwd: PROJ, model: MODEL, maxTurns: 3, settingSources: [], tools: ["Write"],
    canUseTool: async (tool, input, opts) => {
      console.log(`canUseTool(${tool}) called at +${Date.now() - t0}ms; waiting ${waitMs}ms; signal.aborted=${opts.signal.aborted}`);
      await new Promise((r) => setTimeout(r, waitMs)); // simulates human click latency
      console.log(`resolving at +${Date.now() - t0}ms; signal.aborted=${opts.signal.aborted}`);
      return { behavior: "allow", updatedInput: input };
    },
  },
})) {
  const a = m as any;
  if (a.type === "result") console.log(`result subtype=${a.subtype} is_error=${a.is_error} at +${Date.now() - t0}ms text=${trunc(a.result, 100)}`);
}
