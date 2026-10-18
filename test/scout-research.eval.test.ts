import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { sleep, until, workersDone } from "./lead-harness";
import {
  forceText,
  loadScoutCases,
  outcomeOf,
  summarize,
  urlsOf,
  type Verdict,
  verdictOf,
} from "./scout-eval-support";

/*
 * PAID opt-in eval of scout research: runs only with SCOUT_EVAL=1 and a real CLAUDE_CODE_OAUTH_TOKEN (never by default).
 * Each case sends one research question to a fresh db, the REAL lead and the REAL scout (web calls included). Scored per
 * case: the scout completed, its report cites at least one URL, and each cited URL resolves (HTTP < 400). Cost and
 * latency are printed. A report, not a gate: `SCOUT_EVAL_MIN` (default 0.7) is the pass rate of cases that completed
 * with at least one resolving URL, over the DISPATCHED cases; `SCOUT_EVAL_ONLY` (a case id prefix, e.g. `quick`) limits
 * the run. A lead answer without a scout is `routed-direct` (fine for an `expect: "either"` case) or MISS (a case with
 * `expect: "dispatch"`); the dispatch rate is reported apart from the pass rate. `SCOUT_EVAL_FORCE=1` makes the first
 * message ask the lead for a research worker, so scout quality is measured independently of routing.
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
    const rows: { verdict: Verdict; dispatched: boolean }[] = [];
    const force = process.env.SCOUT_EVAL_FORCE === "1";
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
        text: force ? forceText(c.text) : c.text,
      });
      // The lead may answer alone (no dispatch): give a dispatch 60 s to appear, else skip the worker wait.
      const dispatched = await until(
        () => !!env.db.query("SELECT 1 FROM turns WHERE role != 'lead'").get(),
        60_000,
      ).then(
        () => true,
        () => false,
      );
      // The scout starts after the lead's run: wait for it, then for every run to end.
      if (dispatched) await workersDone(env.db, 600_000).catch(() => {});
      await until(
        () => !env.db.query("SELECT 1 FROM turns WHERE status = 'running'").get(),
        300_000,
      ).catch(() => {});
      await sleep(1000); // result row and artifact writes settle
      const out = outcomeOf(env.db, (p) => readFileSync(p, "utf8"));
      const urls = urlsOf(out.text);
      const ok = (await Promise.all(urls.map(resolves))).filter(Boolean).length;
      const pass = out.completed && ok > 0;
      const verdict = verdictOf(c, dispatched, pass);
      rows.push({ verdict, dispatched });
      cost += out.costUsd;
      const line = `${verdict} ${c.id}: dispatched=${dispatched} completed=${out.completed} urls=${ok}/${urls.length} $${out.costUsd.toFixed(3)} ${Math.round(out.durationMs / 1000)}s`;
      lines.push(line);
      process.stderr.write(`${line}\n`); // streamed per case: a long run shows progress
      // No db.close(): the lead's announcer timers of this handler may still fire and read the db ("closed database"
      // would fail the whole file). The temp home is removed after the file by the preload.
    }
    const s = summarize(rows);
    process.stderr.write(
      `scout research: dispatched ${s.dispatched}/${cases.length}, pass ${s.ok}/${s.dispatched} of dispatched, routed-direct ${s.direct}, MISS ${s.miss}, total $${cost.toFixed(2)}${force ? " (forced)" : ""}\n${lines.join("\n")}\n`,
    );
    // Gate: MISS (a failed dispatched case or a must-dispatch case answered directly) stays under 1 - SCOUT_EVAL_MIN.
    expect(s.miss / Math.max(cases.length, 1)).toBeLessThanOrEqual(
      1 - Number(process.env.SCOUT_EVAL_MIN ?? 0.7),
    );
  }, 7_200_000);
});
