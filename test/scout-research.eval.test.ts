import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { sleep, until, workersDone } from "./lead-harness";
import { loadScoutCases, outcomeOf, urlsOf } from "./scout-eval-support";

/*
 * PAID opt-in eval of scout research: runs only with SCOUT_EVAL=1 and a real CLAUDE_CODE_OAUTH_TOKEN (never by default).
 * Each case sends one research question to a fresh db, the REAL lead and the REAL scout (web calls included). Scored per
 * case: the scout completed, its report cites at least one URL, and each cited URL resolves (HTTP < 400). Cost and
 * latency are printed. A report, not a gate: `SCOUT_EVAL_MIN` (default 0.7) is the pass rate of cases that completed
 * with at least one resolving URL; `SCOUT_EVAL_ONLY` (a case id prefix, e.g. `quick`) limits the run.
 * Compare search setups by running twice: with and without the hosted search key in the environment.
 */
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const live = process.env.SCOUT_EVAL === "1" && !!token && token !== PLACEHOLDER;
if (!live)
  process.stderr.write(
    "SKIP scout research eval: needs SCOUT_EVAL=1 and a real CLAUDE_CODE_OAUTH_TOKEN\n",
  );

/** True when the URL answers with a status below 400 within 15 s (GET: some hosts refuse HEAD). */
async function resolves(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
    return r.status < 400;
  } catch {
    return false;
  }
}

describe.skipIf(!live)("scout research set (real lead and scout)", () => {
  test("scouts complete, cite resolving URLs, within cost and time", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const only = process.env.SCOUT_EVAL_ONLY ?? "";
    const cases = loadScoutCases().filter((c) => c.id.startsWith(only));
    const lines: string[] = [];
    let good = 0;
    let cost = 0;
    for (const c of cases) {
      const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: token!, TIMEOUT_MS: "600000" });
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
        threadId: `eval-${c.id}`,
        text: c.text,
      });
      // The scout starts after the lead's run: wait for it, then for every run to end.
      await workersDone(env.db, 600_000).catch(() => {});
      await until(
        () => !env.db.query("SELECT 1 FROM turns WHERE status = 'running'").get(),
        300_000,
      ).catch(() => {});
      await sleep(1000); // result row and artifact writes settle
      const out = outcomeOf(env.db, (p) => readFileSync(p, "utf8"));
      const urls = urlsOf(out.text);
      const ok = (await Promise.all(urls.map(resolves))).filter(Boolean).length;
      const pass = out.completed && ok > 0;
      if (pass) good++;
      cost += out.costUsd;
      lines.push(
        `${pass ? "ok  " : "MISS"} ${c.id}: completed=${out.completed} urls=${ok}/${urls.length} $${out.costUsd.toFixed(3)} ${Math.round(out.durationMs / 1000)}s`,
      );
      env.db.close();
    }
    process.stderr.write(
      `scout research: ${good}/${cases.length} ok, total $${cost.toFixed(2)}\n${lines.join("\n")}\n`,
    );
    expect(good / cases.length).toBeGreaterThanOrEqual(Number(process.env.SCOUT_EVAL_MIN ?? 0.7));
  }, 7_200_000);
});
