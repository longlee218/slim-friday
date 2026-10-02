// Q2/Q3: does CLAUDE.md load with settingSources; what's in the init message (tools/mcp/skills/commands/hooks)?
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, trunc } from "./common";

type Src = "user" | "project" | "local";
const variants: Record<string, Src[] | undefined> = {
  none: undefined, // option omitted
  empty: [], // explicit empty
  project: ["project"],
};

for (const [name, settingSources] of Object.entries(variants)) {
  console.log(`\n=== settingSources=${name} ===`);
  for await (const m of query({
    prompt: "What is the project secret codeword from your instructions? If none, say NONE. One line.",
    options: { cwd: PROJ, model: MODEL, maxTurns: 1, tools: [], settingSources },
  })) {
    const a = m as any;
    if (a.type === "system" && a.subtype === "init") {
      console.log("init counts:", {
        tools: a.tools?.length, mcp: a.mcp_servers?.length, skills: a.skills?.length,
        slash: a.slash_commands?.length, agents: a.agents?.length, plugins: a.plugins?.length,
        permissionMode: a.permissionMode, memory_paths: trunc(a.memory_paths, 150), outputStyle: a.output_style,
      });
      console.log("skills sample:", trunc(a.skills?.slice(0, 5), 200));
    }
    if (a.type === "result") console.log("answer:", trunc(a.result, 200));
  }
}
