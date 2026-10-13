import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createJevClient } from "../src/intent/jev/jev-client";
import { createJevProposer } from "../src/intent/jev/jev-proposer";
import { percentile } from "../src/observability/routing-metrics";
import { GOLDEN } from "./intent-eval-cases";

/*
 * PAID live Jev calibration over the idle golden cases (TypeSafe System One). OWNER-APPROVED RUNS ONLY. Opt-in needs ALL of:
 *   a real JEV_API_KEY, JEV_LIVE=1, INTENT_EVAL=1, JEV_EVAL_MAX_CALLS=<n> (hard cap on requests; unset / 0 throws),
 *   AGENT_HOME (the dump goes to <AGENT_HOME>/eval/jev-calibration.jsonl, or JEV_EVAL_OUT=<file>).
 *   JEV_LIVE=1 INTENT_EVAL=1 JEV_EVAL_MAX_CALLS=120 AGENT_HOME=... bun test test/jev-calibration.live.test.ts
 * It dumps per-case numbers (case index + label + top / ratio / confidence / continueP / multiP / fitsLastP / band;
 * NO message text) and prints act-band coverage and misroutes. Choose the band constants (src/intent/jev/jev-constants.ts)
 * so that misroutes = 0, then maximise coverage. Compare the role accuracy with the Haiku-only run of
 * test/intent-eval.live.test.ts (same cases) before the default flip; see the owner steps in the phase report.
 */
const key = process.env.JEV_API_KEY;
const live =
  !!key &&
  key !== PLACEHOLDER &&
  key !== "sk_" &&
  process.env.JEV_LIVE === "1" &&
  process.env.INTENT_EVAL === "1";
if (!live)
  process.stderr.write(
    "SKIP jev calibration: needs real JEV_API_KEY + JEV_LIVE=1 + INTENT_EVAL=1\n",
  );

describe.skipIf(!live)("live Jev calibration (paid)", () => {
  test("act-band picks never contradict the label; numbers dumped for band tuning", async () => {
    const max = Number(process.env.JEV_EVAL_MAX_CALLS);
    if (!Number.isInteger(max) || max <= 0) throw new Error("JEV_EVAL_MAX_CALLS is required");
    const out =
      process.env.JEV_EVAL_OUT ??
      join(process.env.AGENT_HOME ?? "", "eval", "jev-calibration.jsonl");
    if (!process.env.JEV_EVAL_OUT && !process.env.AGENT_HOME)
      throw new Error("AGENT_HOME or JEV_EVAL_OUT is required");
    mkdirSync(dirname(out), { recursive: true });
    rmSync(out, { force: true });

    const proposer = createJevProposer(createJevClient(key!));
    const cases = GOLDEN.map((c, i) => ({ c, i })).filter(
      ({ c }) => c.thread.state === "idle" && c.expect.role && !c.pending,
    );
    const ms: number[] = [];
    let acted = 0;
    const misroutes: number[] = [];
    let calls = 0;
    for (const { c, i } of cases) {
      if (calls >= max) break;
      calls++;
      const p = await proposer.propose({
        text: c.text,
        threadId: `cal-${i}`,
        state: "idle",
        ...(c.thread.lastTurn && { lastRole: c.thread.lastTurn.role }),
        recent: c.recent ?? [],
      });
      const s = p.scores ?? {};
      if (s.ms) ms.push(s.ms);
      const pick = p.kind === "pick" ? p.role : undefined;
      if (pick) {
        acted++;
        if (pick !== c.expect.role) misroutes.push(i);
      }
      // Numbers only: never the message text.
      appendFileSync(
        out,
        `${JSON.stringify({ case: i, label: c.expect.role, kind: p.kind, pick, ...s, ranking: undefined })}\n`,
      );
    }
    process.stderr.write(
      `JEV CALIBRATION: ${calls} case(s), act-band coverage ${acted}/${calls}, misroutes ${misroutes.length} (cases ${misroutes.join(",") || "-"}), latency p95 ${percentile(ms, 0.95)} ms, dump ${out}\n`,
    );
    expect(misroutes).toEqual([]);
  }, 1_800_000);
});
