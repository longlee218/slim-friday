import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { guardFor } from "../src/guardrails/check-tool-call";
import { getStage } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { makeEnv } from "./helpers";

// Live check: with settingSources [] the SDK must load NONE of the CLAUDE.md / CLAUDE.local.md files around a
// managed-clone cwd (`p/ws/repo`). Canaries: A=p/CLAUDE.md B=p/ws/CLAUDE.md C=p/ws/CLAUDE.local.md
// D=repo/CLAUDE.md E=repo/CLAUDE.local.md F=repo/.claude/CLAUDE.md. Expected result: "none loaded".
// OPT-IN: runs only with RUN_CANARY=1 AND a real CLAUDE_CODE_OAUTH_TOKEN (the owner's Claude login, like
// test/delegate-eval.live.test.ts), so a plain `bun test` skips it. Command:
//   RUN_CANARY=1 CLAUDE_CODE_OAUTH_TOKEN=<token> bun test test/live-claude-md-loading.smoke.test.ts
// Model: CANARY_MODEL, else claude-sonnet-5-5.
const key = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const live = process.env.RUN_CANARY === "1" && !!key && key !== PLACEHOLDER;
if (!live) {
  process.stderr.write(
    "SKIP live-claude-md-loading smoke: needs RUN_CANARY=1 and a real CLAUDE_CODE_OAUTH_TOKEN\n",
  );
}

describe.skipIf(!live)("live CLAUDE.md loading canaries (Claude login)", () => {
  test("reports which canary tokens reach the agent", async () => {
    const env = makeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: key!,
      LLM_PROVIDER: "anthropic",
      MODEL: process.env.CANARY_MODEL ?? "claude-sonnet-5-5",
      MAX_TURNS: "3",
      TIMEOUT_MS: "90000",
    });
    const root = mkdtempSync(join(tmpdir(), "friday-canary-"));
    const ws = join(root, "ws");
    const repo = join(ws, "repo");
    mkdirSync(repo, { recursive: true });
    const files: Record<string, string> = {
      A: join(root, "CLAUDE.md"),
      B: join(ws, "CLAUDE.md"),
      C: join(ws, "CLAUDE.local.md"),
      D: join(repo, "CLAUDE.md"),
      E: join(repo, "CLAUDE.local.md"),
      F: join(repo, ".claude", "CLAUDE.md"),
    };
    mkdirSync(join(repo, ".claude"));
    for (const [k, f] of Object.entries(files)) writeFileSync(f, `Canary token: CANARY_${k}_7f3\n`);
    const res = await runAgent({
      prompt:
        "List every token of the form CANARY_<letter>_7f3 that appears in your instructions. Reply with only the tokens, comma separated, or NONE. Do not use tools.",
      taskId: "canary1",
      stage: getStage("assistant", "qa"),
      cwd: repo,
      guard: guardFor("qa", { readPaths: [repo], gitReadRepos: [] }),
      config: env.config,
      db: env.db,
      abortController: new AbortController(),
    });
    const loaded = Object.keys(files).filter((k) => res.text.includes(`CANARY_${k}_7f3`));
    process.stderr.write(
      `CANARY LOADED: ${loaded.join(",") || "none"} | reply=${res.text.slice(0, 200)}\n`,
    );
    expect(res.outcome).toBe("success");
    expect(loaded).toEqual([]); // none loaded
  }, 120_000);
});
