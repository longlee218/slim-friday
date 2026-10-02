// Q5: resume across processes. Usage: bun q05-resume.ts store | recall | othercwd <session_id>
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, PROJ2, trunc } from "./common";

const [mode, sid] = process.argv.slice(2);
const cwd = mode === "othercwd" ? PROJ2 : PROJ;
const prompt = mode === "store" ? "Remember this fact: my favourite number is 7391. Reply 'stored'." : "What is my favourite number? One line.";
try {
  for await (const m of query({
    prompt,
    options: { cwd, model: MODEL, maxTurns: 1, tools: [], settingSources: [], ...(sid ? { resume: sid } : {}) },
  })) {
    const a = m as any;
    if (a.type === "system" && a.subtype === "init") console.log("init session_id:", a.session_id, "cwd:", a.cwd);
    if (a.type === "result") console.log(`[${mode}] result: ${trunc(a.result)} is_error=${a.is_error} subtype=${a.subtype} session_id=${a.session_id} errors=${trunc(a.errors)}`);
  }
} catch (e) {
  console.log(`[${mode}] THROWN:`, String(e).slice(0, 300));
}
