import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";

// Spike: SDK permissionMode "auto" with our hook + canUseTool wiring (owner decision 2026-10-11).
// OPT-IN: SPIKE_AUTO_MODE=1 (local Claude login, Haiku, budget 0.05 USD per case). Tests RECORD facts to stdout;
// only the hard-deny case asserts. Never run in CI.
const RUN = process.env.SPIKE_AUTO_MODE === "1";
const MODEL = "claude-haiku-4-5";

/** Temp repos of the cases; removed in afterAll. */
const tmpDirs: string[] = [];

interface Seen {
  cwd: string;
  hookCalls: string[];
  canUseToolCalls: string[];
  toolResults: string[];
  error?: string;
}

/** One run: `hook` is the PreToolUse decision (what our guard would return); canUseTool calls are recorded and denied. */
async function runCase(prompt: string, hook: (tool: string, input: any) => object): Promise<Seen> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "friday-auto-")));
  tmpDirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  const seen: Seen = { cwd, hookCalls: [], canUseToolCalls: [], toolResults: [] };
  const env: Record<string, string | undefined> = {};
  for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR"]) env[k] = process.env[k];
  const options: Options = {
    cwd,
    model: MODEL,
    settingSources: [],
    tools: ["Bash", "Write"],
    permissionMode: "auto",
    systemPrompt: "You are a test driver. Do exactly what is asked with one tool call. Be terse.",
    maxTurns: 4,
    maxBudgetUsd: 0.05,
    env,
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (i: any) => {
              seen.hookCalls.push(`${i.tool_name}:${JSON.stringify(i.tool_input).slice(0, 80)}`);
              return hook(i.tool_name, i.tool_input);
            },
          ],
        },
      ],
    },
    canUseTool: async (tool) => {
      seen.canUseToolCalls.push(tool);
      return { behavior: "deny", message: "spike: no owner available" };
    },
  };
  try {
    for await (const m of query({ prompt, options }) as AsyncIterable<any>) {
      const c = Array.isArray(m.message?.content) ? m.message.content : [];
      for (const b of c)
        if (b.type === "tool_result")
          seen.toolResults.push(JSON.stringify(b.content).slice(0, 120));
    }
  } catch (e) {
    seen.error = String(e).slice(0, 200);
  }
  return seen;
}

describe.skipIf(!RUN)("live auto-mode spike (Haiku, gated by SPIKE_AUTO_MODE=1)", () => {
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test("(a)+(b) options accepted; hook deny blocks a write to a .git path", async () => {
    const denyGit = (tool: string, input: any) =>
      String(input?.file_path ?? "").includes("/.git/")
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "guard: .git is not writable",
            },
          }
        : { continue: true };
    const s = await runCase(
      "Use the Write tool to write 'x' to .git/spike-marker in the cwd.",
      denyGit,
    );
    console.log("[spike auto (a,b,d)]", JSON.stringify(s));
    expect(s.error).toBeUndefined(); // (a) permissionMode "auto" accepted
    expect(existsSync(join(s.cwd, ".git", "spike-marker"))).toBe(false); // (b) denied
  });

  test("(c)+(d) hook without decision: classifier decides a harmless ls; record canUseTool", async () => {
    const s = await runCase("Run `ls` with the Bash tool.", () => ({ continue: true }));
    console.log("[spike auto (c,d)]", JSON.stringify(s));
    // (c) expected: hook saw Bash, canUseTool empty, a tool_result exists. Recorded, not asserted.
    expect(s.error).toBeUndefined();
  });

  test("(e) hook without decision for a guard-SOFT-ask command (mkdir): classifier or canUseTool?", async () => {
    const s = await runCase("Run `mkdir spike-dir` with the Bash tool.", () => ({
      continue: true,
    }));
    // Recorded, not asserted: was canUseTool called (owner would be asked), and did the dir get created.
    console.log(
      "[spike auto (e)]",
      JSON.stringify({ ...s, dirExists: existsSync(join(s.cwd, "spike-dir")) }),
    );
    expect(s.error).toBeUndefined();
  });
});
