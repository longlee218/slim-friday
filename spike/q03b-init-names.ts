// Q3b: list tool/mcp/plugin names (not skills) in init with settingSources ["project"], tools [] to see what leaks from ~/.claude / account.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ } from "./common";
for await (const m of query({ prompt: "hi", options: { cwd: PROJ, model: MODEL, maxTurns: 1, tools: [], settingSources: ["project"] } })) {
  const a = m as any;
  if (a.type === "system" && a.subtype === "init") {
    console.log("tools:", a.tools);
    console.log("mcp:", a.mcp_servers?.map((s: any) => `${s.name}:${s.status}`));
    console.log("plugins:", a.plugins?.map((p: any) => p.name ?? p));
    console.log("agents:", a.agents);
    console.log("hooks key present:", "hooks" in a);
  }
}
