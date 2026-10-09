import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { BASH_TOOL_NAME, EDIT_TOOL_NAME, WRITE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv, TEST_CHANNEL } from "./helpers";

// Live test: needs a real OAuth token (a dummy gives 401 and retries forever).
// Note: bun auto-loads .env, so a placeholder there must be treated as missing.
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const live = !!token && token !== PLACEHOLDER;
if (!live) {
  process.stderr.write("SKIP live-agent smoke: CLAUDE_CODE_OAUTH_TOKEN missing or REPLACE_ME\n");
}

describe.skipIf(!live)("live agent smoke (Haiku)", () => {
  test("answers on a temp repo; only Read/Glob/Grep exposed; rows recorded", async () => {
    const env = makeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: token!,
      MAX_TURNS: "6",
      MAX_BUDGET_USD: "0.2",
      TIMEOUT_MS: "90000",
    });
    const repo = env.repo;
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "a.txt"), "the secret word is alpha\n");
    const cfg = env.config;

    const tools: string[][] = [];
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // Wrap the real query to capture the system init tool list.
    const queryFn = (a: Parameters<typeof query>[0]) =>
      (async function* () {
        for await (const m of query(a)) {
          if (m.type === "system" && (m as any).subtype === "init") tools.push((m as any).tools);
          yield m;
        }
      })();

    const reply = await createTaskHandler({ db: env.db, config: cfg, queryFn: queryFn as never })({
      source: "test",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "live1",
      text: "What is the secret word in a.txt? Answer in one word.",
    });
    expect(reply.toLowerCase()).toContain("alpha");
    expect(
      tools[0]!.some((t) => [BASH_TOOL_NAME, WRITE_TOOL_NAME, EDIT_TOOL_NAME].includes(t)),
    ).toBe(false); // strictMcpConfig leak check
    expect(env.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM runs").get()!.n).toBe(1);
    expect(
      env.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tool_calls").get()!.n,
    ).toBeGreaterThan(0);
  }, 120_000);
});
