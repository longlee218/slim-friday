import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { ORCHESTRATION_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { REPORT_TOOL } from "../src/mcp/orchestration/tools/ReportTool/constants";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { EDIT_TOOL_NAME, WRITE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { until, workersDone } from "./lead-harness";

// Live test: needs a real OAuth token (a dummy gives 401 and retries forever).
// Note: bun auto-loads .env, so a placeholder there must be treated as missing.
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const live = !!token && token !== PLACEHOLDER;
if (!live) {
  process.stderr.write("SKIP live-agent smoke: CLAUDE_CODE_OAUTH_TOKEN missing or REPLACE_ME\n");
}

describe.skipIf(!live)("live agent smoke (lead -> scout, Haiku)", () => {
  test("answers on a temp location; no write tools exposed; rows recorded", async () => {
    const env = makeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: token!,
      MAX_TURNS: "6",
      MAX_BUDGET_USD: "0.2",
      TIMEOUT_MS: "90000",
    });
    const location = env.location;
    mkdirSync(location, { recursive: true });
    writeFileSync(join(location, "a.txt"), "the secret word is alpha\n");
    const cfg = env.config;

    const tools: string[][] = [];
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // Wrap the real query to capture the system init tool list of the WORKER runs (the lead has its own tools).
    const queryFn = (a: Parameters<typeof query>[0]) => {
      // A worker run is the one whose orchestration server holds Report (the lead's holds the lead tools).
      const orchestration = (a.options?.mcpServers as any)?.[ORCHESTRATION_MCP_SERVER];
      const isWorker = !!orchestration?.instance?._registeredTools?.[REPORT_TOOL];
      return (async function* () {
        for await (const m of query(a)) {
          if (isWorker && m.type === "system" && (m as any).subtype === "init")
            tools.push((m as any).tools);
          yield m;
        }
      })();
    };

    // Plain text: the lead decides and dispatches a read-only scout; the scout's typed result lands on its item row.
    await createTurnHandler({ db: env.db, config: cfg, queryFn: queryFn as never })({
      source: "test",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "live1",
      text: "What is the secret word in a.txt? Answer in one word.",
    });
    await workersDone(env.db, 110_000);
    // The turn closes before its result file and excerpt are written: wait for them.
    const itemSql = "FROM owned_tasks WHERE parent_id IS NOT NULL AND result_excerpt IS NOT NULL";
    await until(() => !!env.db.query(`SELECT 1 ${itemSql}`).get(), 5000);
    const task = env.db
      .query<{ result_excerpt: string | null }, []>(`SELECT result_excerpt ${itemSql}`)
      .get();
    expect(task?.result_excerpt?.toLowerCase()).toContain("alpha");
    expect(tools[0]!.some((t) => [WRITE_TOOL_NAME, EDIT_TOOL_NAME].includes(t))).toBe(false); // strictMcpConfig leak check
    expect(
      env.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) n FROM runs r JOIN turns t ON t.id = r.turn_id WHERE t.role != 'lead'",
        )
        .get()!.n,
    ).toBe(1); // one worker run (the lead's own runs are not counted)
    expect(
      env.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tool_calls").get()!.n,
    ).toBeGreaterThan(0);
  }, 120_000);
});
