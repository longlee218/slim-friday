import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";

// Spike: SDK permissionMode "auto" and "bypassPermissions" with our hook + canUseTool wiring (owner decisions
// 2026-10-11). OPT-IN: SPIKE_AUTO_MODE=1 (local Claude login, Haiku, budget 0.10 USD per case, 120 s per test).
// Tests RECORD facts to stdout; only the hard-deny cases assert. Never run in CI.
const RUN = process.env.SPIKE_AUTO_MODE === "1";
const MODEL = "claude-haiku-4-5";

/** Per-test timeout: a live run takes tens of seconds (the 5 s default aborted the first spike). */
const T = 120_000;

/** Temp repos of the cases; removed in afterAll. */
const tmpDirs: string[] = [];

interface Seen {
  cwd: string;
  hookCalls: string[];
  canUseToolCalls: string[];
  toolResults: string[];
  error?: string;
}

/** Hook that hard-denies a write into the repo's git dir (what our guard does) and lets everything else continue. */
const denyGitDir = (_tool: string, input: any) =>
  String(input?.file_path ?? "").includes("/.git/")
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "guard: the git dir is not writable",
        },
      }
    : { continue: true };

/** One run: `hook` is the PreToolUse decision (what our guard would return); canUseTool calls are recorded and denied. */
async function runCase(
  prompt: string,
  hook: (tool: string, input: any) => object,
  mode: "auto" | "bypassPermissions" = "auto",
  /** Per-case overrides of the options (tools, canUseTool). */
  extra: Partial<Options> = {},
): Promise<Seen> {
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
    permissionMode: mode,
    // The SDK requires the explicit opt-in for bypassPermissions.
    ...(mode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
    systemPrompt: "You are a test driver. Do exactly what is asked with one tool call. Be terse.",
    maxTurns: 6,
    maxBudgetUsd: 0.1,
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
  Object.assign(options, extra);
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

describe.skipIf(!RUN)("live permission-mode spike (Haiku, gated by SPIKE_AUTO_MODE=1)", () => {
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test(
    "(a)+(b) auto: options accepted; hook deny blocks a write into the git dir",
    async () => {
      const s = await runCase(
        "Use the Write tool to write 'x' to .git/spike-marker in the cwd.",
        denyGitDir,
      );
      console.log("[spike auto (a,b,d)]", JSON.stringify(s));
      expect(s.error).toBeUndefined(); // (a) permissionMode "auto" accepted
      expect(existsSync(join(s.cwd, ".git", "spike-marker"))).toBe(false); // (b) denied
    },
    T,
  );

  test(
    "(c)+(d) auto: hook without decision, classifier decides a harmless ls; record canUseTool",
    async () => {
      const s = await runCase("Run `ls` with the Bash tool.", () => ({ continue: true }));
      console.log("[spike auto (c,d)]", JSON.stringify(s));
      // (c) expected: hook saw Bash, canUseTool empty, a tool_result exists. Recorded, not asserted.
      expect(s.error).toBeUndefined();
    },
    T,
  );

  test(
    "(e) auto: guard-SOFT-ask command (mkdir) without hook decision: classifier or canUseTool?",
    async () => {
      const s = await runCase("Run `mkdir spike-dir` with the Bash tool.", () => ({
        continue: true,
      }));
      // Recorded, not asserted: was canUseTool called (owner would be asked), and did the dir get created.
      console.log(
        "[spike auto (e)]",
        JSON.stringify({ ...s, dirExists: existsSync(join(s.cwd, "spike-dir")) }),
      );
      expect(s.error).toBeUndefined();
    },
    T,
  );

  test(
    "(f) bypassPermissions: hook deny on a Write into the git dir still blocks (file absent)",
    async () => {
      const s = await runCase(
        "Use the Write tool to write 'x' to .git/spike-marker in the cwd.",
        denyGitDir,
        "bypassPermissions",
      );
      console.log("[spike bypass (f)]", JSON.stringify(s));
      expect(s.error).toBeUndefined(); // option pair accepted
      expect(existsSync(join(s.cwd, ".git", "spike-marker"))).toBe(false); // hook deny honoured under bypass
    },
    T,
  );

  test(
    "(g) bypassPermissions: hook continue on mkdir runs without canUseTool",
    async () => {
      const s = await runCase(
        "Run `mkdir spike-dir` with the Bash tool.",
        () => ({ continue: true }),
        "bypassPermissions",
      );
      // Recorded, not asserted: expected canUseToolCalls = [] and dirExists = true.
      console.log(
        "[spike bypass (g)]",
        JSON.stringify({ ...s, dirExists: existsSync(join(s.cwd, "spike-dir")) }),
      );
      expect(s.error).toBeUndefined();
    },
    T,
  );

  test(
    "(h) bypassPermissions: AskUserQuestion still reaches canUseTool? (recorded, not asserted)",
    async () => {
      const asked: string[] = [];
      const s = await runCase(
        "Call the AskUserQuestion tool once with one question (header 'Pick', two options A and B), then stop.",
        () => ({ continue: true }),
        "bypassPermissions",
        {
          tools: ["AskUserQuestion", "Bash"],
          // Answer like the app does: allow with the first option label as the answer.
          canUseTool: async (tool, input: any) => {
            asked.push(tool);
            const q = input?.questions?.[0];
            return {
              behavior: "allow",
              updatedInput: {
                ...input,
                answers: { [q?.question ?? ""]: q?.options?.[0]?.label ?? "" },
              },
            };
          },
        },
      );
      // Expected to learn: canUseTool called for AskUserQuestion under bypass (yes/no) and what the tool returned.
      console.log("[spike bypass (h)]", JSON.stringify({ ...s, askedViaCanUseTool: asked }));
      expect(s.error).toBeUndefined();
    },
    T,
  );
});
