// Q8: which option combination truly restricts tools? canUseTool ALLOWS everything and records calls,
// so any Bash/Write call that shows up means the option did NOT restrict. Writes only inside scratch dir.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, trunc } from "./common";

const variants: Record<string, object> = {
  A_tools_list: { tools: ["Read", "Glob", "Grep"] },
  B_allowedTools_only: { allowedTools: ["Read", "Glob", "Grep"] },
  C_disallowed_only: { disallowedTools: ["Bash", "Write", "Edit"] },
  D_tools_plus_allowed: { tools: ["Read", "Glob", "Grep"], allowedTools: ["Read", "Glob", "Grep"] },
};
const only = process.argv[2];

for (const [name, extra] of Object.entries(variants)) {
  if (only && only !== name) continue;
  const asked: string[] = [];
  const used: string[] = [];
  let initTools: string[] = [];
  let result = "";
  try {
    for await (const m of query({
      prompt: "Do both: (1) run the shell command `echo hi` using the Bash tool, (2) create file out.txt containing 'x' using the Write tool. If a tool is unavailable, say UNAVAILABLE. Be brief.",
      options: {
        cwd: PROJ, model: MODEL, maxTurns: 4, settingSources: [], ...extra,
        // Records every permission request and allows it (so real restriction is visible).
        canUseTool: async (tool, input) => { asked.push(tool); return { behavior: "allow", updatedInput: input }; },
      },
    })) {
      const a = m as any;
      if (a.type === "system" && a.subtype === "init") initTools = a.tools.filter((t: string) => !t.startsWith("mcp__"));
      if (a.type === "assistant") for (const b of a.message.content) if (b.type === "tool_use") used.push(b.name);
      if (a.type === "result") result = trunc(a.result, 200);
    }
  } catch (e) { result = "THROWN " + String(e).slice(0, 150); }
  console.log(`\n== ${name} ==\n init tools(non-mcp): ${initTools.join(",")}\n tool_use attempted: ${used.join(",") || "none"}\n canUseTool asked: ${asked.join(",") || "none"}\n result: ${result}`);
}
