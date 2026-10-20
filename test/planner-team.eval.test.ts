import { describe, expect, test } from "bun:test";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { docOfRow } from "../src/orchestrator/plan/plan-doc";
import { latestPlan } from "../src/storage/work-plan-store";
import { addLocation, makeEnv, TEST_CHANNEL } from "./helpers";
import { sleep, until, workersDone } from "./lead-harness";
import { loadPlannerCases, planMisses } from "./planner-team-support";

/*
 * PAID opt-in eval of the planner's team staffing: runs only with PLANNER_EVAL=1 and a real CLAUDE_CODE_OAUTH_TOKEN
 * (never by default). Each case sends one owner request to a fresh db and the REAL lead; the lead requests a plan and the
 * REAL planner stores it (no approval, so no item runs). The stored plan is scored by planMisses: project cases need
 * >= 3 roles (developer, a research or architecture step, a designer when a UI is named), a small request <= 2 items,
 * 1..cap criteria. A report, not a gate: `PLANNER_EVAL_MIN` (default 0.75) is the pass rate; `PLANNER_EVAL_ONLY` is a
 * case id prefix; `PLANNER_EVAL_REPEAT=N` (default 1) runs every case N times.
 */
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const live = process.env.PLANNER_EVAL === "1" && !!token && token !== PLACEHOLDER;
if (!live)
  process.stderr.write(
    "SKIP planner team eval: needs PLANNER_EVAL=1 and a real CLAUDE_CODE_OAUTH_TOKEN\n",
  );

describe.skipIf(!live)("planner team staffing (real lead and planner)", () => {
  test("plans for projects are teams, a small request stays small", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const only = process.env.PLANNER_EVAL_ONLY ?? "";
    const cases = loadPlannerCases().filter((c) => c.id.startsWith(only));
    const repeat = Math.max(1, Number(process.env.PLANNER_EVAL_REPEAT ?? 1));
    const misses: string[] = [];
    let total = 0;
    for (const c of cases) {
      for (let r = 0; r < repeat; r++) {
        total++;
        const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: token!, TIMEOUT_MS: "600000" });
        addLocation(env.home, "app", { description: "the app" });
        const handle = createTurnHandler({
          db: env.db,
          config: env.config,
          queryFn: query as never,
          post: async () => {},
        });
        await handle({
          source: "test",
          channelId: TEST_CHANNEL,
          userId: "owner",
          threadId: `planner-eval-${c.id}-${r}`,
          text: c.text,
        });
        // The plan row appears when the planner's create call is accepted; then the runs settle.
        const planId = () =>
          env.db.query<{ id: string }, []>("SELECT id FROM work_plans LIMIT 1").get()?.id;
        await until(() => !!planId(), 600_000).catch(() => {});
        await workersDone(env.db, 600_000).catch(() => {});
        await sleep(1000);
        const id = planId();
        const stored = id ? latestPlan(env.db, id) : undefined;
        if (!stored) misses.push(`${c.id}#${r}: no plan stored`);
        else {
          const m = planMisses(c, docOfRow(stored));
          if (m.length) misses.push(`${c.id}#${r}: ${m.join("; ")}`);
        }
        env.db.close();
      }
    }
    process.stderr.write(`planner eval: ${total - misses.length}/${total}\n${misses.join("\n")}\n`);
    expect(1 - misses.length / total).toBeGreaterThanOrEqual(
      Number(process.env.PLANNER_EVAL_MIN ?? 0.75),
    );
  }, 3_600_000);
});
