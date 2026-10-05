// Phase 3 open checks, run through the real stack (OpenRouter env + configured model):
//   hook  : does PreToolUse fire for read-only Bash, and can it deny?
//   plan  : does permissionMode "plan" block Write before ExitPlanMode?
//   wait  : does canUseTool survive a long wait? (arg: seconds, default 600)
// Usage: bun spike/q14-phase3-checks.ts <hook|plan|wait> [seconds]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { sdkEnv } from "../src/agent/sdk-env";
import { loadConfig } from "../src/config/agent-config";
import { trunc } from "./common";

const mode = process.argv[2] ?? "hook";
const config = loadConfig({ ...process.env, AGENT_HOME: "/tmp/unused" });
const cwd = mkdtempSync(join(tmpdir(), "friday-q14-"));
const t0 = Date.now();
const at = () => `+${Date.now() - t0}ms`;

/** Base options shared by all checks. */
const base = { cwd, model: config.model, maxTurns: 4, settingSources: [] as [], env: sdkEnv(config) };

/** Print the interesting parts of the stream. */
function show(m: any): void {
  if (m.type === "result")
    console.log(`result ${m.subtype} is_error=${m.is_error} ${at()} text=${trunc(m.result, 160)}`);
}

if (mode === "hook") {
  // Read-only Bash is auto-allowed without canUseTool; does a PreToolUse hook still see and deny it?
  const seen: string[] = [];
  for await (const m of query({
    prompt: "Run the bash command `echo hello` and tell me the output.",
    options: {
      ...base,
      tools: ["Bash"],
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (i: any) => {
                seen.push(`${i.tool_name}:${trunc(i.tool_input, 80)}`);
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: "blocked by spike hook",
                  },
                } as any;
              },
            ],
          },
        ],
      },
    },
  }))
    show(m);
  console.log("HOOK saw:", seen);
} else if (mode === "plan") {
  // Plan mode: Write must be blocked until ExitPlanMode is approved.
  const calls: string[] = [];
  for await (const m of query({
    prompt: "Create a file notes.txt containing 'x', then say done.",
    options: {
      ...base,
      tools: ["Write"],
      permissionMode: "plan",
      canUseTool: async (tool: string, input: any) => {
        calls.push(`canUseTool:${tool}`);
        return { behavior: "deny", message: "spike: denied" } as any;
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (i: any) => {
                calls.push(`PreToolUse:${i.tool_name}`);
                return { continue: true };
              },
            ],
          },
        ],
      },
    },
  }))
    show(m);
  const exists = await Bun.file(join(cwd, "notes.txt")).exists();
  console.log("PLAN calls:", calls, "notes.txt exists:", exists);
} else {
  // Long canUseTool wait with a tool that normally asks (Write in default mode).
  const waitMs = Number(process.argv[3] ?? 600) * 1000;
  for await (const m of query({
    prompt: "Create file waited.txt containing 'ok' with the Write tool. Then say done.",
    options: {
      ...base,
      tools: ["Write"],
      canUseTool: async (tool: string, input: any, opts: any) => {
        console.log(`canUseTool(${tool}) ${at()} waiting ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        console.log(`resolving ${at()} aborted=${opts.signal.aborted}`);
        return { behavior: "allow", updatedInput: input } as any;
      },
    },
  }))
    show(m);
  console.log("WAIT file written:", await Bun.file(join(cwd, "waited.txt")).exists());
}
