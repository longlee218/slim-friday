import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { decideIntent, type IntentDecision } from "../src/intent/decide-intent";
import { buildIntentDeps } from "../src/intent/intent-deps";
import type { IntentClassifier, IntentInput } from "../src/intent/intent-types";
import { runIntentPipeline } from "../src/intent/run-intent-pipeline";
import { intentRoles } from "../src/roles/role-registry";
import { makeEnv } from "./helpers";
import { GOLDEN, type GoldenCase } from "./intent-eval-cases";
import { createCostQuery, parseMaxUsd } from "./intent-eval-cost";
import { costLine, type Row, rate, renderSummary, renderTable } from "./intent-eval-report";
import { roleMatches, scoreClass } from "./intent-eval-score";

// Golden set of the intent layer (LIVE: real Haiku through the owner's Claude login; non-deterministic).
// It runs the production path (`buildIntentDeps` + `decideIntent`: L1 explicit leading tag, then L3 Haiku with the
// recent messages and any pending question), so a case decided by the tag never costs a call; the table says which layer decided each case.
//
// Gate: >= 9/10 (0.9) on role, scope and class, and 0 code requests routed to a non-dev role while idle.
// L3 class rubric: mechanical only for rename/typo/format/docs/one-line config, standard for tests/bugs/features,
// design for architecture/UX/migration; code guard: a model `mechanical` without `high` confidence becomes `standard`.
// Cases with group "holdout" are never used to tune the prompt. TUNE with INTENT_EVAL_GROUP=tuning; run
// INTENT_EVAL_GROUP=holdout ONCE at the end. The DEFAULT group (unset) includes the holdout: do not tune with it.
// Scores are printed per group.
// OPT-IN (costs quota; tuning group ~85 cases, holdout ~35, sequential, a few minutes; a case decided by an L1 tag costs no call). Run it TWICE and compare both scores:
//   INTENT_EVAL=1 INTENT_EVAL_MAX_USD=<cap> INTENT_EVAL_GROUP=tuning bun test test/intent-eval.live.test.ts
// COST: INTENT_EVAL_MAX_USD=<usd> is REQUIRED (unset, 0 or malformed throws: every live run needs the owner's
// approved cap). The run prints total USD and the per-call average (sum of the SDK result `total_cost_usd`, see
// intent-eval-cost.ts; on a subscription login it is a list-price estimate, not billing). The cap is checked after
// each case, so the overshoot is at most one call; past the cap the run stops and the test fails.
// Optional: INTENT_EVAL_OUT=<file> also writes the table; MODEL_INTENT=sonnet re-runs on another model
// (the fallback if Haiku misses the gate: a model switch, NOT a new layer). Needs a Claude login on this
// machine (or CLAUDE_CODE_OAUTH_TOKEN). Without INTENT_EVAL=1 the whole file is skipped.
const live = process.env.INTENT_EVAL === "1";
if (!live) process.stderr.write("SKIP intent golden set: needs INTENT_EVAL=1 (Claude login)\n");

/** INTENT_EVAL_GROUP: `tuning` (all but holdout), `holdout` (only holdout), default all. */
const inGroup = (c: GoldenCase) =>
  process.env.INTENT_EVAL_GROUP === "holdout"
    ? c.group === "holdout"
    : process.env.INTENT_EVAL_GROUP === "tuning"
      ? c.group !== "holdout"
      : true;

/** Minimum pass rate per dimension. */
const GATE = 0.9;

/** Score one decision against the expectation. */
function score(
  c: GoldenCase,
  d: IntentDecision,
): Pick<Row, "role" | "scope" | "cls" | "clsRaw" | "codeLeak"> {
  const e = c.expect;
  const role = d.kind === "role" ? d.role : undefined;
  const out: Pick<Row, "role" | "scope" | "cls" | "clsRaw" | "codeLeak"> = {
    codeLeak: !!c.codeRequest && c.thread.state === "idle" && role !== undefined && role !== "dev",
  };
  if (e.role) out.role = roleMatches(d, { role: e.role });
  if (e.ask) out.role = d.kind === "ask";
  if (e.pendingAnswer) out.role = d.kind === "gate-answer" && d.answer === e.pendingAnswer;
  if (e.anyRegistryRoleOrAsk) out.role = d.kind === "ask" || role === "assistant" || role === "dev";
  if (e.scope) out.scope = d.kind === "role" && d.scope === e.scope;
  if (e.cls) {
    const c = scoreClass(d, e.cls);
    out.cls = c.effective;
    out.clsRaw = c.raw;
  }
  return out;
}

describe.skipIf(!live)("intent golden set (live, Haiku)", () => {
  test("role, scope and class meet the gate; no change request leaks to a non-dev role", async () => {
    const env = makeEnv({
      LLM_PROVIDER: "anthropic",
      ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      }),
      ...(process.env.MODEL_INTENT && { MODEL_INTENT: process.env.MODEL_INTENT }),
      INTENT_ENGINE: "haiku",
      INTENT_TIMEOUT_MS: "30000",
    });
    // The production deps; the engine is wrapped only to tell "L3 decided" from "L3 failed".
    const maxUsd = parseMaxUsd(process.env.INTENT_EVAL_MAX_USD); // throws before any call when unset
    const cost = createCostQuery();
    const prod = buildIntentDeps(env.config, cost.query);
    let called = false;
    let failed = false;
    const classifier: IntentClassifier = {
      classify: async (i) => {
        called = true;
        try {
          return await (prod.classifier as IntentClassifier).classify(i);
        } catch (err) {
          failed = true;
          throw err;
        }
      },
    };
    const deps = { ...prod, classifier };

    const rows: Row[] = [];
    let capped = false;
    for (const c of GOLDEN.filter(inGroup)) {
      const t = c.thread;
      const input = {
        text: c.text,
        state: t.state,
        pendingQuestion: c.pending,
        hasTask: t.hasTask ?? (t.state !== "idle" && t.state !== "done"),
      };
      const l3Input = (): IntentInput => ({
        text: c.text,
        thread: {
          state: t.state,
          ...(t.activeRole && { activeRole: t.activeRole }),
          ...(t.lastTurn && { lastTurn: t.lastTurn }),
        },
        ledger: t.ledger ?? [],
        recent: c.recent ?? [],
        ...(c.pending && { pendingQuestion: c.pending }),
        roles: intentRoles(),
      });
      called = false;
      failed = false;
      const t0 = Date.now();
      const { decision } = await decideIntent({ ...input, l3Input }, deps);
      const layer = called
        ? failed
          ? "fallback"
          : "L3"
        : (runIntentPipeline(input, deps.pipeline).decidedBy as Row["layer"]);
      rows.push({ c, layer, decision, ms: Date.now() - t0, ...score(c, decision) });
      // After each case: the overshoot of the cap is at most one call.
      if (cost.totals().usd > maxUsd) {
        capped = true;
        break;
      }
    }

    const [role, scope, cls] = [rate("role", rows), rate("scope", rows), rate("cls", rows)];
    const leaks = rows.filter((r) => r.codeLeak);
    const table = renderTable(rows);
    const summary = renderSummary(
      rows,
      costLine(cost.totals(), maxUsd, capped),
      env.config.intent.model,
    );
    process.stderr.write(`INTENT GOLDEN SET\n${table}\n${summary}\n`);
    if (process.env.INTENT_EVAL_OUT)
      writeFileSync(process.env.INTENT_EVAL_OUT, `${summary}\n\n${table}\n`);

    expect(capped ? `cap $${maxUsd} exceeded` : "within cap").toBe("within cap");
    expect(rows.some((r) => r.layer === "fallback")).toBe(false); // an engine failure is not a score
    expect(leaks.map((r) => r.c.text)).toEqual([]);
    for (const [name, r] of [
      ["role", role],
      ["scope", scope],
      ["class", cls],
    ] as const)
      expect(`${name} ${r.ratio >= GATE}`).toBe(`${name} true`);
  }, 1_200_000);
});
