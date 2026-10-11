import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Spike Q18: the real Agent tool input schema, resume mechanism, hook usage fields and a custom `general-purpose`
// agent, in ONE run. OPT-IN: SPIKE_AUTO_MODE=1 (local Claude login, Haiku, budget 0.15 USD, 120 s). Facts are
// recorded to stdout and test/fixtures/sdk-hooks/q18-*.json; nothing is asserted beyond "the run produced hooks".
const RUN = process.env.SPIKE_AUTO_MODE === "1";
const MODEL = "claude-haiku-4-5";
const T = 120_000;
const FIXTURES = join(import.meta.dir, "fixtures", "sdk-hooks");

const tmpDirs: string[] = [];

/** Truncates values and strips absolute paths so a hook input can be stored as a fixture. */
function scrub(v: unknown, cwd: string): unknown {
  if (typeof v === "string") {
    return v.split(cwd).join("<CWD>").split(homedir()).join("<HOME>").slice(0, 300);
  }
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => scrub(x, cwd));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, cwd)]));
  }
  return v;
}

describe.skipIf(!RUN)("live Q18 spike: Agent input, resume, usage, general-purpose", () => {
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test(
    "Q18 (a)-(d) in one run",
    async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "friday-q18-")));
      tmpDirs.push(cwd);
      const hooks: Record<string, unknown>[] = [];
      const assistantModels: string[] = [];
      const log = (i: any) => {
        hooks.push(scrub(i, cwd) as Record<string, unknown>);
        return { continue: true } as any;
      };
      let init: any = null;
      let result: any = null;
      let error: string | undefined;
      const env: Record<string, string | undefined> = {};
      for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR"]) env[k] = process.env[k];
      const prompt = [
        "Follow these steps in order, tersely.",
        "1. Call the Agent tool ONCE with subagent_type 'general-purpose', model 'haiku', run_in_background false, description 'secret keeper',",
        "and prompt: \"The secret word is PINEAPPLE. Reply with: the marker word from your system prompt, the names of all your tools, and the word 'remembered'.\"",
        "2. Resume that SAME subagent (keep its context, do not spawn a new one): use SendMessage to its agent id (or the Agent tool resume key if it exists) asking it to repeat the secret word.",
        "3. Final answer: print (a) the exact parameter names of YOUR Agent tool schema, (b) the agent id string from the step-1 result, (c) how you resumed and what it replied.",
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
            maxBudgetUsd: 0.15,
            env,
            // Same name as the built-in: does it override it? (d) The marker is in its prompt, tools limited to Read.
            agents: {
              "general-purpose": {
                description: "Custom general purpose agent (Q18).",
                prompt: "You are CUSTOMGP. The marker word is ZEBRA42. Answer tersely.",
                tools: ["Read"],
              },
            },
            hooks: {
              PreToolUse: [{ hooks: [async (i: any) => log(i)] }],
              PostToolUse: [{ hooks: [async (i: any) => log(i)] }],
              SubagentStart: [{ hooks: [async (i: any) => log(i)] }],
              SubagentStop: [{ hooks: [async (i: any) => log(i)] }],
            },
          },
        }) as AsyncIterable<any>) {
          if (m.type === "system" && m.subtype === "init") init = m;
          if (m.type === "assistant" && m.message?.model) assistantModels.push(m.message.model);
          if (m.type === "result") result = m;
        }
      } catch (e) {
        error = String(e).slice(0, 200);
      }
      const keys = hooks.map((h) => ({
        event: h.hook_event_name,
        tool: h.tool_name ?? null,
        keys: Object.keys(h),
        input_keys: h.tool_input ? Object.keys(h.tool_input as object) : null,
        response_keys:
          h.tool_response && typeof h.tool_response === "object"
            ? Object.keys(h.tool_response as object)
            : null,
        agent_id: h.agent_id ?? null,
        agent_type: h.agent_type ?? null,
      }));
      const summary = {
        error,
        mainTools: init?.tools,
        assistantModels,
        subtype: result?.subtype,
        total_cost_usd: result?.total_cost_usd,
        modelUsage: result?.modelUsage,
        resultText: scrub(result?.result, cwd),
        num_turns: result?.num_turns,
      };
      writeFileSync(join(FIXTURES, "q18-hook-inputs.json"), `${JSON.stringify(hooks, null, 2)}\n`);
      writeFileSync(join(FIXTURES, "q18-hook-keys.json"), `${JSON.stringify(keys, null, 2)}\n`);
      writeFileSync(
        join(FIXTURES, "q18-run-summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      console.log("[spike q18 keys]", JSON.stringify(keys));
      console.log("[spike q18 summary]", JSON.stringify(summary));
      expect(hooks.length).toBeGreaterThan(0);
    },
    T,
  );
});
