import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { addLocation, makeEnv, TEST_CHANNEL } from "./helpers";
import { outcomeOf, summarize, type Verdict, verdictOf } from "./researcher-eval-support";
import {
  CODE_LOCATION,
  citesExpected,
  loadCodeCases,
  pathLineRefs,
  REPO_ROOT,
} from "./scout-codebase-eval-support";
import { sleep, until, workersDone } from "./teammate-harness";

/*
 * PAID opt-in eval of the scout (codebase reference search): runs only with SCOUT_CODE_EVAL=1 and a real
 * CLAUDE_CODE_OAUTH_TOKEN (never by default). This repository is registered as the location `friday` of a fresh db; each
 * case sends one "where / how" question to the REAL teammate and the REAL scout (Haiku, cheap). Scored per case: the scout
 * completed and its result excerpt or saved report cites `path:line` for one expected path. Every case must dispatch (a
 * direct teammate answer is a MISS). Cost and latency are printed. `SCOUT_CODE_EVAL_ONLY` (a case id prefix) limits the run;
 * gate: MISS rate <= 1 - `SCOUT_CODE_EVAL_MIN` (default 0.7).
 */
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const live = process.env.SCOUT_CODE_EVAL === "1" && !!token && token !== PLACEHOLDER;
if (!live)
  process.stderr.write(
    "SKIP scout codebase eval: needs SCOUT_CODE_EVAL=1 and a real CLAUDE_CODE_OAUTH_TOKEN\n",
  );

describe.skipIf(!live)("scout codebase set (real teammate and scout on this repo)", () => {
  test("scouts complete and cite the expected path:line", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const only = process.env.SCOUT_CODE_EVAL_ONLY ?? "";
    const cases = loadCodeCases().filter((c) => c.id.startsWith(only));
    const lines: string[] = [];
    const rows: { verdict: Verdict; dispatched: boolean }[] = [];
    let cost = 0;
    for (const c of cases) {
      const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: token!, TIMEOUT_MS: "600000" });
      // The repository itself is the location (read-only for the scout: its sandbox has no write grant).
      addLocation(
        env.home,
        CODE_LOCATION,
        { description: "this agent's own source code" },
        { path: REPO_ROOT },
      );
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
        threadId: `code-eval-${c.id}`,
        text: c.text,
      });
      // Give a dispatch 60 s to appear; a teammate that answers alone is a MISS (every case must dispatch).
      const dispatched = await until(
        () => !!env.db.query("SELECT 1 FROM turns WHERE role != 'chief-of-staff'").get(),
        60_000,
      ).then(
        () => true,
        () => false,
      );
      if (dispatched) await workersDone(env.db, 600_000).catch(() => {});
      await until(
        () => !env.db.query("SELECT 1 FROM turns WHERE status = 'running'").get(),
        300_000,
      ).catch(() => {});
      await sleep(1000); // result row and artifact writes settle
      const out = outcomeOf(env.db, (p) => readFileSync(p, "utf8"), "scout");
      const pass = out.completed && citesExpected(out.text, c.expect);
      const verdict = verdictOf({ expect: "dispatch" }, dispatched, pass);
      rows.push({ verdict, dispatched });
      cost += out.costUsd;
      const line = `${verdict} ${c.id}: dispatched=${dispatched} completed=${out.completed} refs=${pathLineRefs(out.text).length} $${out.costUsd.toFixed(3)} ${Math.round(out.durationMs / 1000)}s`;
      lines.push(line);
      process.stderr.write(`${line}\n`);
      // No db.close(): announcer timers may still read the db; the preload removes the temp home after the file.
    }
    const s = summarize(rows);
    process.stderr.write(
      `scout codebase: dispatched ${s.dispatched}/${cases.length}, pass ${s.ok}/${s.dispatched} of dispatched, MISS ${s.miss}, total $${cost.toFixed(2)}\n${lines.join("\n")}\n`,
    );
    expect(s.miss / Math.max(cases.length, 1)).toBeLessThanOrEqual(
      1 - Number(process.env.SCOUT_CODE_EVAL_MIN ?? 0.7),
    );
  }, 3_600_000);
});
