import { describe, expect, test } from "bun:test";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { initMsg, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { decisionOf, loadGolden } from "./lead-golden-support";
import { sleep, until } from "./lead-harness";
import { isLeadRun } from "./mcp-run-probe";

/*
 * PAID opt-in eval of the lead: runs only with LEAD_EVAL=1 and a real CLAUDE_CODE_OAUTH_TOKEN (never by default).
 * Each case sends one owner message to a fresh db and the REAL lead; worker and planner runs are faked (no paid worker
 * run). The lead's recorded decision (effect_log + owned_tasks) is scored against the expected strategy and roles.
 * A report, not a gate: the owner runs it after a lead prompt or model change. `LEAD_EVAL_MIN` (default 0.8) is the pass rate; `LEAD_EVAL_ONLY` (a case id prefix, e.g. `research`) limits the run.
 */
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const live = process.env.LEAD_EVAL === "1" && !!token && token !== PLACEHOLDER;
if (!live)
  process.stderr.write(
    "SKIP lead golden eval: needs LEAD_EVAL=1 and a real CLAUDE_CODE_OAUTH_TOKEN\n",
  );

describe.skipIf(!live)("lead golden set (real lead, fake workers)", () => {
  test("the lead's decisions match the expected strategy and roles", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const misses: string[] = [];
    const only = process.env.LEAD_EVAL_ONLY ?? "";
    const cases = loadGolden().filter((c) => c.id.startsWith(only));
    for (const c of cases) {
      const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: token!, TIMEOUT_MS: "90000" });
      // Lead runs go to the real SDK; any other run (worker, planner) is a stub that ends at once.
      const queryFn = (a: { prompt: unknown; options?: { mcpServers?: object } }) =>
        isLeadRun(a.options)
          ? query(a as never)
          : (async function* () {
              yield initMsg;
              yield resultMsg({ result: "stub", total_cost_usd: 0 });
            })();
      const handle = createTurnHandler({
        db: env.db,
        config: env.config,
        queryFn: queryFn as never,
        // No announce wake: a stub worker's end must not start a second paid lead run.
        leadTiming: { announceWindowMs: 3_600_000 },
        post: async () => {},
      });
      await handle({
        source: "test",
        channelId: TEST_CHANNEL,
        userId: "owner",
        threadId: `eval-${c.id}`,
        text: c.text,
      });
      // The lead run starts after the queue's debounce: wait for its turn row, then for it to end.
      await until(() => !!env.db.query("SELECT 1 FROM turns WHERE role = 'lead'").get(), 30_000);
      await until(
        () => !env.db.query("SELECT 1 FROM turns WHERE role = 'lead' AND status = 'running'").get(),
        120_000,
      );
      await sleep(500); // writes of the last tool call settle
      const got = decisionOf(env.db);
      if (got.strategy !== c.strategy || got.roles.join() !== c.roles.join())
        misses.push(
          `${c.id}: expected ${c.strategy}[${c.roles}] got ${got.strategy}[${got.roles}]`,
        );
      env.db.close();
    }
    process.stderr.write(
      `lead golden: ${cases.length - misses.length}/${cases.length}\n${misses.join("\n")}\n`,
    );
    expect(1 - misses.length / cases.length).toBeGreaterThanOrEqual(
      Number(process.env.LEAD_EVAL_MIN ?? 0.8),
    );
  }, 3_600_000);
});
