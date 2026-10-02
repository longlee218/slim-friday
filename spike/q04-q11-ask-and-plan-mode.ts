// Q4: AskUserQuestion via canUseTool (input shape + answer shape).  Q11: plan mode / ExitPlanMode / EnterPlanMode.
// Usage: bun q04-q11-ask-and-plan-mode.ts ask | plan | enter
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, trunc } from "./common";

const mode = process.argv[2] ?? "ask";
let exitPlanCalls = 0;
const log = (s: string) => console.log(s);

const cfg: Record<string, { prompt: string; options: object }> = {
  ask: {
    prompt: "Use the AskUserQuestion tool to ask me whether I prefer red or blue (2 options). Then tell me my answer in one line.",
    options: { tools: ["AskUserQuestion"] },
  },
  plan: {
    prompt: "Plan how to append a line 'delta' to a.txt (read it first). When ready, present the plan via ExitPlanMode. Do not edit anything yet.",
    options: { tools: ["Read", "Write", "Edit", "ExitPlanMode"], permissionMode: "plan" },
  },
  enter: {
    prompt: "This is a big refactor. First call EnterPlanMode, then plan, then present with ExitPlanMode. Do not edit files.",
    options: { tools: ["Read", "EnterPlanMode", "ExitPlanMode", "Write"] },
  },
};

for await (const m of query({
  prompt: cfg[mode]!.prompt,
  options: {
    cwd: PROJ, model: MODEL, maxTurns: 8, settingSources: [],
    ...cfg[mode]!.options,
    canUseTool: async (tool, input, opts) => {
      log(`canUseTool tool=${tool} input=${trunc(input, 700)}`);
      log(`  opts keys=${Object.keys(opts).join(",")} title=${trunc((opts as any).title, 80)}`);
      if (tool === "AskUserQuestion") {
        // Answer shape per docs: updatedInput = original input + answers map {questionText: chosenLabel}.
        const qs = (input as any).questions ?? [];
        const answers = Object.fromEntries(qs.map((q: any) => [q.question, q.options?.[1]?.label ?? "blue"]));
        return { behavior: "allow", updatedInput: { ...input, answers } };
      }
      if (tool === "ExitPlanMode") {
        exitPlanCalls++;
        // 1st time: reject with feedback to see whether agent stays in plan mode; 2nd: approve.
        if (exitPlanCalls === 1) return { behavior: "deny", message: "Revise: also mention a backup step. Then call ExitPlanMode again." };
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "allow", updatedInput: input };
    },
  },
})) {
  const a = m as any;
  if (a.type === "system" && a.subtype === "init") log(`init permissionMode=${a.permissionMode}`);
  if (a.type === "system" && a.subtype === "status") log(`status ${trunc(a, 200)}`);
  if (a.type === "assistant") for (const b of a.message.content) if (b.type === "tool_use") log(`tool_use ${b.name}`);
  if (a.type === "result") log(`RESULT ${a.subtype} err=${a.is_error} text=${trunc(a.result, 200)}`);
}
