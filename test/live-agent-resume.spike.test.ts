import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Spike Q19: resume of a NAMED subagent via SendMessage (context kept? ids? hook inputs?), ONE run.
// OPT-IN: SPIKE_AUTO_MODE=1 (local Claude login, Haiku, budget 0.40 USD, 180 s). Facts go to stdout and
// test/fixtures/sdk-hooks/q19-*.json; only "the run produced hooks" is asserted.
const RUN = process.env.SPIKE_AUTO_MODE === "1";
const MODEL = "claude-haiku-4-5";
const T = 180_000;
const FIXTURES = join(import.meta.dir, "fixtures", "sdk-hooks");

const tmpDirs: string[] = [];

/** Truncates values and strips absolute paths so a hook input can be stored as a fixture. */
function scrub(v: unknown, cwd: string): unknown {
  if (typeof v === "string") {
    return v.split(cwd).join("<CWD>").split(homedir()).join("<HOME>").slice(0, 400);
  }
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => scrub(x, cwd));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, cwd)]));
  }
  return v;
}

describe.skipIf(!RUN)("live Q19 spike: named subagent resume via SendMessage", () => {
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test(
    "Q19 resume",
    async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "friday-q19-")));
      tmpDirs.push(cwd);
      const hooks: Record<string, unknown>[] = [];
      const log = (i: any) => {
        hooks.push(scrub(i, cwd) as Record<string, unknown>);
        return { continue: true } as any;
      };
      let result: any = null;
      let error: string | undefined;
      const env: Record<string, string | undefined> = {};
      for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR"]) env[k] = process.env[k];
      const prompt = [
        "Step 1: call the Agent tool once with name 'worker', model 'haiku', run_in_background false, subagent_type 'general-purpose',",
        "description 'keep word', prompt 'Remember the secret word PINEAPPLE. Reply only: OK.'",
        "Step 2: call SendMessage with to 'worker' and message 'What was the secret word? Reply with it only.'",
        "If SendMessage errors, retry once with to set to the agentId from step 1.",
        "Final answer: the agentId, the SendMessage result text, and any error text. Be terse.",
      ].join(" ");
      try {
        for await (const m of query({
          prompt,
          options: {
            cwd,
            model: MODEL,
            settingSources: [],
            tools: ["Agent", "SendMessage"],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            systemPrompt: "You are a test driver. Follow the steps exactly. Be terse.",
            maxTurns: 8,
            maxBudgetUsd: 0.4,
            env,
            hooks: {
              PreToolUse: [{ hooks: [async (i: any) => log(i)] }],
              PostToolUse: [{ hooks: [async (i: any) => log(i)] }],
              SubagentStart: [{ hooks: [async (i: any) => log(i)] }],
              SubagentStop: [{ hooks: [async (i: any) => log(i)] }],
            },
          },
        }) as AsyncIterable<any>) {
          if (m.type === "result") result = m;
        }
      } catch (e) {
        error = String(e).slice(0, 200);
      }
      const summary = {
        error,
        subtype: result?.subtype,
        total_cost_usd: result?.total_cost_usd,
        num_turns: result?.num_turns,
        resultText: scrub(result?.result, cwd),
      };
      writeFileSync(join(FIXTURES, "q19-hook-inputs.json"), `${JSON.stringify(hooks, null, 2)}\n`);
      writeFileSync(
        join(FIXTURES, "q19-run-summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      console.log("[spike q19 summary]", JSON.stringify(summary));
      console.log(
        "[spike q19 hooks]",
        JSON.stringify(
          hooks.map((h: any) => ({
            e: h.hook_event_name,
            tool: h.tool_name,
            agent_id: h.agent_id,
            agent_type: h.agent_type,
            input: h.tool_input,
            resp: h.tool_response,
            last: h.last_assistant_message,
          })),
        ).slice(0, 7000),
      );
      expect(hooks.length).toBeGreaterThan(0);
    },
    T,
  );
});
