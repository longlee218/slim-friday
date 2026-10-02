// Q13: modes: "pending" | "pending-killall" (canUseTool never resolves -> self SIGKILL) | "resume <sid> [allow|deny]".
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, trunc } from "./common";

const [mode, sid, decision = "allow"] = process.argv.slice(2);
const base = { cwd: PROJ, model: MODEL, maxTurns: 4, settingSources: [] as "project"[], tools: ["Write"] };

if (mode === "pending" || mode === "pending-killall") {
  let session = "";
  for await (const m of query({
    prompt: "Create file killed.txt containing 'ok' with the Write tool. Then say done.",
    options: {
      ...base,
      canUseTool: async (tool) => {
        console.log(`PENDING tool=${tool} session=${session}; SIGKILL self in 1s`);
        setTimeout(() => {
          // killall: also SIGKILL the claude child so the transcript really ends mid-tool_use.
          if (mode === "pending-killall") Bun.spawnSync(["pkill", "-9", "-P", String(process.pid)]);
          process.kill(process.pid, "SIGKILL");
        }, 1000);
        return new Promise(() => {}); // never resolves
      },
    },
  })) {
    if ((m as any).session_id) session = (m as any).session_id;
  }
} else {
  const seen: string[] = [];
  try {
    for await (const m of query({
      prompt: "Continue where you left off.",
      options: {
        ...base, resume: sid,
        canUseTool: async (tool, input) => { seen.push(`canUseTool:${tool}`); return decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "no" }; },
      },
    })) {
      const a = m as any;
      if (a.type === "assistant") for (const b of a.message.content) seen.push(`${b.type}:${trunc(b.text ?? b.name, 80)}`);
      if (a.type === "user") for (const b of a.message.content ?? []) if (b.type === "tool_result") seen.push(`tool_result:${trunc(b.content, 120)}`);
      if (a.type === "result") seen.push(`RESULT ${a.subtype} err=${a.is_error} ${trunc(a.result ?? a.errors, 200)}`);
    }
  } catch (e) { seen.push("THROWN " + String(e).slice(0, 200)); }
  console.log(seen.join("\n"));
}
