import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/run-agent";
import { PLACEHOLDER } from "../src/config/agent-config";
import { guardFor } from "../src/guardrails/check-tool-call";
import { makeEnv } from "./helpers";

// Live measurement (no fix): which CLAUDE.md / CLAUDE.local.md files does the SDK load for a managed-clone
// cwd (`p/ws/repo`)? Canaries: A=p/CLAUDE.md B=p/ws/CLAUDE.md C=p/ws/CLAUDE.local.md D=repo/CLAUDE.md E=repo/CLAUDE.local.md.
// Needs a real OPENROUTER_API_KEY (bun auto-loads .env; a placeholder counts as missing).
const key = process.env.OPENROUTER_API_KEY;
const live = !!key && key !== PLACEHOLDER;
if (!live) {
  process.stderr.write(
    "SKIP live-claude-md-loading smoke: OPENROUTER_API_KEY missing or REPLACE_ME\n",
  );
}

describe.skipIf(!live)("live CLAUDE.md loading canaries (OpenRouter)", () => {
  test("reports which canary tokens reach the agent", async () => {
    const env = makeEnv({
      OPENROUTER_API_KEY: key!,
      LLM_PROVIDER: "openrouter",
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
    };
    for (const [k, f] of Object.entries(files)) writeFileSync(f, `Canary token: CANARY_${k}_7f3\n`);
    const res = await runAgent({
      prompt:
        "List every token of the form CANARY_<letter>_7f3 that appears in your instructions. Reply with only the tokens, comma separated, or NONE. Do not use tools.",
      taskId: "canary1",
      cwd: repo,
      guard: guardFor("qa", { readPaths: [repo], gitReadRepos: [] }),
      config: env.config,
      db: env.db,
      abortController: new AbortController(),
    });
    const loaded = ["A", "B", "C", "D", "E"].filter((k) => res.text.includes(`CANARY_${k}_7f3`));
    process.stderr.write(
      `CANARY LOADED: ${loaded.join(",") || "none"} | reply=${res.text.slice(0, 200)}\n`,
    );
    expect(res.outcome).toBe("success");
  }, 120_000);
});
