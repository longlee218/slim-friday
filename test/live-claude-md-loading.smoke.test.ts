import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { guardFor } from "../src/guardrails/check-tool-call";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { makeEnv } from "./helpers";

// Live check: with settingSources [] the SDK must load NONE of the CLAUDE.md / CLAUDE.local.md files around a
// managed-clone cwd (`p/ws/location`). Canaries: A=p/CLAUDE.md B=p/ws/CLAUDE.md C=p/ws/CLAUDE.local.md
// D=location/CLAUDE.md E=location/CLAUDE.local.md F=location/.claude/CLAUDE.md. Expected result: "none loaded".
// OPT-IN: runs only with RUN_CANARY=1 AND a real CLAUDE_CODE_OAUTH_TOKEN (the owner's Claude login, like
// test/intent-eval.live.test.ts), so a plain `bun test` skips it. Command:
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
      MODEL_DEV: process.env.CANARY_MODEL ?? "claude-sonnet-5-5",
      MODEL_ASSISTANT: process.env.CANARY_MODEL ?? "claude-sonnet-5-5",
      MAX_TURNS: "3",
      TIMEOUT_MS: "90000",
    });
    const root = mkdtempSync(join(tmpdir(), "friday-canary-"));
    const ws = join(root, "ws");
    const location = join(ws, "location");
    mkdirSync(location, { recursive: true });
    const files: Record<string, string> = {
      A: join(root, "CLAUDE.md"),
      B: join(ws, "CLAUDE.md"),
      C: join(ws, "CLAUDE.local.md"),
      D: join(location, "CLAUDE.md"),
      E: join(location, "CLAUDE.local.md"),
      F: join(location, ".claude", "CLAUDE.md"),
    };
    mkdirSync(join(location, ".claude"));
    for (const [k, f] of Object.entries(files)) writeFileSync(f, `Canary token: CANARY_${k}_7f3\n`);
    const res = await runAgent({
      prompt:
        "List every token of the form CANARY_<letter>_7f3 that appears in your instructions. Reply with only the tokens, comma separated, or NONE. Do not use tools.",
      turnId: "canary1",
      role: getRole("assistant"),
      cwd: location,
      guard: guardFor(getRole("assistant"), { readPaths: [location], gitReadPaths: [] }),
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
