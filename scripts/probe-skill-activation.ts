/**
 * PAID probe (real SDK `query()`): does a role load its method skills before it plans or changes anything?
 * Builds the role's real system prompt, tool set (SDK built-ins only, no MCP) and skills plugin, runs a tiny task in a
 * throwaway git repo N times and prints, per run, the order of Skill / AskUserQuestion / Write / Edit calls and the cost.
 * A run ends at its first Write or Edit (denied with interrupt, nothing is written), at the end of the task, or at the turn/budget cap.
 * AskUserQuestion is answered with its first option. Bash is limited to read-only commands. No OS sandbox, no Report
 * MCP, no secrets beyond the OAuth token in `.env`. Not part of the app: run by hand, costs real money.
 *
 *   bun scripts/probe-skill-activation.ts --role developer --task "Build a CLI ..." [--runs 3] [--out runs.json]
 *   bun scripts/probe-skill-activation.ts --role chief-of-staff --task "Call the Skill tool with skill friday:using-skills"
 *     (leak canary: a skill outside the role's list must come back as an error)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getRole } from "../src/roles/role-registry";
import { buildRoleSkills } from "../src/runtime/skills-plugin/role-skills";
import { buildSystemPrompt } from "../src/runtime/system-prompt";
import { toolOptions } from "../src/tools/tool-catalog";

const { values: a } = parseArgs({
  options: {
    role: { type: "string" },
    task: { type: "string" },
    runs: { type: "string", default: "3" },
    out: { type: "string" },
    turns: { type: "string", default: "25" },
    budget: { type: "string", default: "0.5" },
  },
});
if (!a.role || !a.task) {
  process.stderr.write("usage: --role <name> --task <text|@file> [--runs 3] [--out file.json]\n");
  process.exit(2);
}
const role = getRole(a.role);
const task = a.task.startsWith("@") ? await Bun.file(a.task.slice(1)).text() : a.task;

/** Read-only shell: a plain command from this list, no chaining, redirection or substitution. */
const READ_ONLY = /^(ls|cat|head|tail|pwd|which|rg|grep|find|wc|git (log|status|diff|show)|bun --version)\b/;
const SHELL_META = /[;&|<>`$()]/;

interface RunResult {
  run: number;
  seq: string[];
  stop: string;
  cost: number;
}

/** One run in a fresh home + git repo; returns the call sequence. */
async function probeOnce(run: number): Promise<RunResult> {
  const home = mkdtempSync(join(tmpdir(), "probe-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "probe-repo-"));
  const sk = buildRoleSkills(role, undefined, home);
  const seq: string[] = [];
  const names = new Map<string, string>(); // tool_use id -> label, to tag a Skill result as ERR
  let stop = "end";
  let cost = 0;
  try {
    writeFileSync(join(cwd, "package.json"), '{"name":"probe","type":"module"}\n');
    writeFileSync(join(cwd, "README.md"), "# probe\n");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["-c", "user.name=p", "-c", "user.email=p@x", "commit", "-qm", "init"], {
      cwd,
    });
    const { tools, ...rest } = toolOptions(role);
    const options = {
      ...rest,
      cwd,
      model: role.model,
      systemPrompt: buildSystemPrompt("", role),
      tools: (tools as string[]).filter((t) => !t.startsWith("mcp__")),
      skills: sk.skills,
      plugins: sk.plugins,
      additionalDirectories: sk.dirs,
      settingSources: [],
      permissionMode: "default",
      maxTurns: Number(a.turns),
      maxBudgetUsd: Number(a.budget),
      // First option answers a question; the first Write/Edit ends the run; the shell is read-only.
      canUseTool: async (name: string, input: Record<string, any>) => {
        if (name === "AskUserQuestion") {
          const answers: Record<string, string> = {};
          for (const q of input.questions ?? []) answers[q.question] = q.options?.[0]?.label ?? "ok";
          return { behavior: "allow", updatedInput: { ...input, answers } };
        }
        if (name === "Write" || name === "Edit") {
          seq.push(`${name}(${String(input.file_path).split("/").pop()}) <- END`);
          stop = "edit";
          return { behavior: "deny", message: "probe ends here", interrupt: true };
        }
        if (name === "Bash") {
          const cmd = String(input.command ?? "");
          if (READ_ONLY.test(cmd) && !SHELL_META.test(cmd)) return { behavior: "allow", updatedInput: input };
          return { behavior: "deny", message: "probe: shell is read-only" };
        }
        if (["Skill", "Read", "Glob", "Grep", "LSP", "TodoWrite"].includes(name))
          return { behavior: "allow", updatedInput: input };
        return { behavior: "deny", message: "probe: tool not available" };
      },
    };
    for await (const m of query({ prompt: task, options: options as never }) as AsyncIterable<any>) {
      if (m.type === "assistant")
        for (const b of m.message.content ?? [])
          if (b.type === "tool_use" && ["Skill", "AskUserQuestion", "Bash"].includes(b.name)) {
            const label =
              b.name === "Skill"
                ? `Skill(${b.input?.skill})`
                : b.name === "Bash"
                  ? `Bash(${String(b.input?.command).slice(0, 40)})`
                  : `Ask(${String(b.input?.questions?.[0]?.header ?? "")})`;
            names.set(b.id, label);
            seq.push(label);
          }
      // A Skill call the SDK refused (unknown / not listed) comes back as an error result.
      if (m.type === "user" && Array.isArray(m.message?.content))
        for (const b of m.message.content)
          if (b.type === "tool_result" && b.is_error && names.get(b.tool_use_id)?.startsWith("Skill"))
            seq[seq.indexOf(names.get(b.tool_use_id)!)] += " ERR";
      if (m.type === "result") {
        cost = m.total_cost_usd ?? 0;
        if (stop === "end" && m.subtype !== "success") stop = m.subtype;
      }
    }
  } catch (err) {
    if (stop !== "edit") stop = `error: ${String(err).slice(0, 80)}`; // the interrupt after the first edit may throw
  } finally {
    sk.cleanup();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
  return { run, seq, stop, cost };
}

const results: RunResult[] = [];
for (let i = 1; i <= Number(a.runs); i++) {
  const r = await probeOnce(i);
  results.push(r);
  process.stdout.write(`run ${i}: $${r.cost.toFixed(3)} stop=${r.stop}\n  ${r.seq.join("\n  ")}\n`);
}
const skillRuns = results.filter((r) => r.seq.some((s) => s.startsWith("Skill(") && !s.endsWith("ERR")));
const total = results.reduce((s, r) => s + r.cost, 0);
process.stdout.write(
  `role=${role.name} runs=${results.length} with-a-skill=${skillRuns.length}/${results.length} cost=$${total.toFixed(3)} (avg $${(total / results.length).toFixed(3)})\n`,
);
if (a.out) writeFileSync(a.out, JSON.stringify({ role: role.name, task, results }, null, 2));
