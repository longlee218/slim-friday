import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTaskHandler } from "../src/tasks/handle-task";
import { BASH_TOOL_NAME, EDIT_TOOL_NAME, WRITE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv } from "./helpers";

// Live test: needs a real OPENROUTER_API_KEY (bun auto-loads .env; a placeholder counts as missing).
const key = process.env.OPENROUTER_API_KEY;
const live = !!key && key !== PLACEHOLDER;
if (!live) {
  process.stderr.write("SKIP live-openrouter smoke: OPENROUTER_API_KEY missing or REPLACE_ME\n");
}

describe.skipIf(!live)("live agent smoke (OpenRouter)", () => {
  test("answers on a temp repo; Read/Glob/Grep only; init model matches; rows recorded", async () => {
    const env = makeEnv({
      OPENROUTER_API_KEY: key!,
      LLM_PROVIDER: "openrouter",
      MAX_TURNS: "6",
      TIMEOUT_MS: "90000",
    });
    const repo = env.repo;
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "a.txt"), "the secret word is alpha\n");
    const cfg = env.config;

    const inits: { tools: string[]; model: string }[] = [];
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // Wrap the real query to capture the system init tool list and model.
    const queryFn = (a: Parameters<typeof query>[0]) =>
      (async function* () {
        for await (const m of query(a)) {
          if (m.type === "system" && (m as any).subtype === "init") inits.push(m as any);
          yield m;
        }
      })();

    const reply = await createTaskHandler({ db: env.db, config: cfg, queryFn: queryFn as never })({
      source: "test",
      userId: "u",
      threadId: "live-or1",
      text: "What is the secret word in a.txt? Answer in one word.",
    });
    const row = env.db
      .query<{ outcome: string; cost_usd: number; turns: number }, []>(
        "SELECT outcome, cost_usd, turns FROM runs",
      )
      .get();
    expect(row?.outcome).toBe("success");
    expect(reply.length).toBeGreaterThan(0);
    expect(inits.length).toBeGreaterThan(0);
    expect(
      inits[0]!.tools.some((t) => [BASH_TOOL_NAME, WRITE_TOOL_NAME, EDIT_TOOL_NAME].includes(t)),
    ).toBe(false);
    expect(env.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM runs").get()!.n).toBe(1);
    expect(
      env.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tool_calls").get()!.n,
    ).toBeGreaterThan(0);

    // Behavior differences vs Anthropic, surfaced via the reporter (not console.*).
    // init.model is recorded, not asserted: OpenRouter may echo a different id string.
    const run = row;
    process.stderr.write(
      `OPENROUTER NOTES: model=${cfg.model} init_model=${inits[0]?.model} reply_has_alpha=${reply.toLowerCase().includes("alpha")} ` +
        `cost_usd=${run?.cost_usd} (SDK prices from Anthropic tables, unreliable) turns=${run?.turns}\n`,
    );
  }, 120_000);
});
