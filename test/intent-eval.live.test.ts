import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { decideIntent, type IntentDecision } from "../src/intent/decide-intent";
import { buildIntentDeps } from "../src/intent/intent-deps";
import type { IntentClassifier, IntentInput } from "../src/intent/intent-types";
import { runIntentPipeline } from "../src/intent/run-intent-pipeline";
import { intentRoles } from "../src/roles/role-registry";
import { makeEnv } from "./helpers";
import { GOLDEN, type GoldenCase } from "./intent-eval-cases";

// Golden set of the intent layer (LIVE: real Haiku through the owner's Claude login; non-deterministic).
// It runs the production path (`buildIntentDeps` + `decideIntent`: L1 gate answer, L3 alias, then L4 Haiku),
// so a case decided by a rule never costs a call; the table says which layer decided each case.
//
// Gate: >= 9/10 (0.9) on role, scope and class, and 0 code requests routed to a non-dev role while idle.
// OPT-IN (costs quota, ~40 sequential calls, a few minutes). Run it TWICE and compare both scores:
//   INTENT_EVAL=1 bun test test/intent-eval.live.test.ts
//   INTENT_EVAL=1 bun test test/intent-eval.live.test.ts      # second run
// Optional: INTENT_EVAL_OUT=<file> also writes the table; MODEL_INTENT=sonnet re-runs on another model
// (the fallback if Haiku misses the gate: a model switch, NOT a new layer). Needs a Claude login on this
// machine (or CLAUDE_CODE_OAUTH_TOKEN). Without INTENT_EVAL=1 the whole file is skipped.
const live = process.env.INTENT_EVAL === "1";
if (!live) process.stderr.write("SKIP intent golden set: needs INTENT_EVAL=1 (Claude login)\n");

/** Minimum pass rate per dimension. */
const GATE = 0.9;

/** Result of one case. */
interface Row {
  c: GoldenCase;
  layer: "L1" | "L3" | "L4" | "fallback" | "none";
  decision: IntentDecision;
  ms: number;
  /** Pass flag per scored dimension (absent = not scored for this case). */
  role?: boolean;
  scope?: boolean;
  cls?: boolean;
  /** A change request that reached a non-dev role (or no role) on an idle thread. */
  codeLeak: boolean;
}

/** Short text of a decision for the table. */
const show = (d: IntentDecision) =>
  d.kind === "role"
    ? `${d.role}/${d.scope}${d.cls ? `/${d.cls}` : ""}`
    : d.kind === "ask"
      ? `ask(${d.reason})`
      : `gate-answer(${d.answer})`;

/** Score one decision against the expectation. */
function score(c: GoldenCase, d: IntentDecision): Pick<Row, "role" | "scope" | "cls" | "codeLeak"> {
  const e = c.expect;
  const role = d.kind === "role" ? d.role : undefined;
  const out: Pick<Row, "role" | "scope" | "cls" | "codeLeak"> = {
    codeLeak: !!c.codeRequest && c.thread.state === "idle" && role !== undefined && role !== "dev",
  };
  if (e.role) out.role = role === e.role;
  if (e.ask) out.role = d.kind === "ask";
  if (e.anyRegistryRoleOrAsk) out.role = d.kind === "ask" || role === "assistant" || role === "dev";
  if (e.scope) out.scope = d.kind === "role" && d.scope === e.scope;
  if (e.cls) out.cls = d.kind === "role" && d.cls === e.cls;
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
    // The production deps; the engine is wrapped only to tell "L4 decided" from "L4 failed".
    const prod = buildIntentDeps(env.config);
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
    for (const c of GOLDEN) {
      const t = c.thread;
      const input = {
        text: c.text,
        state: t.state,
        pendingAsk: false,
        hasTask: t.hasTask ?? (t.state !== "idle" && t.state !== "done"),
      };
      const l4Input = (): IntentInput => ({
        text: c.text,
        thread: {
          state: t.state,
          ...(t.activeRole && { activeRole: t.activeRole }),
          ...(t.activeStage && { activeStage: t.activeStage }),
          ...(t.gate && { gate: t.gate }),
        },
        ledger: t.ledger ?? [],
        roles: intentRoles(),
      });
      called = false;
      failed = false;
      const t0 = Date.now();
      const { decision } = await decideIntent({ ...input, l4Input }, deps);
      const layer = called
        ? failed
          ? "fallback"
          : "L4"
        : (runIntentPipeline(input, deps.pipeline).decidedBy as Row["layer"]);
      rows.push({ c, layer, decision, ms: Date.now() - t0, ...score(c, decision) });
    }

    const rate = (k: "role" | "scope" | "cls") => {
      const scored = rows.filter((r) => r[k] !== undefined);
      const pass = scored.filter((r) => r[k]).length;
      return { pass, total: scored.length, ratio: scored.length ? pass / scored.length : 1 };
    };
    const [role, scope, cls] = [rate("role"), rate("scope"), rate("cls")];
    const leaks = rows.filter((r) => r.codeLeak);
    const byLayer: Record<string, number> = {};
    for (const r of rows) byLayer[r.layer] = (byLayer[r.layer] ?? 0) + 1;
    const fmt = (r: { pass: number; total: number }) => `${r.pass}/${r.total}`;
    const table = [
      "| # | state | message | expected | actual | layer | ms | role | scope | class |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...rows.map((r, i) => {
        const e = r.c.expect;
        const exp = e.ask
          ? "ask"
          : e.anyRegistryRoleOrAsk
            ? "any|ask"
            : `${e.role ?? "-"}/${e.scope ?? "-"}/${e.cls ?? "-"}`;
        const mark = (v?: boolean) => (v === undefined ? "." : v ? "ok" : "MISS");
        return `| ${i + 1} | ${r.c.thread.state} | ${r.c.text.replace(/\|/g, "/").slice(0, 60)} | ${exp} | ${show(r.decision)} | ${r.layer} | ${r.ms} | ${mark(r.role)} | ${mark(r.scope)} | ${mark(r.cls)} |`;
      }),
    ].join("\n");
    const summary = `role ${fmt(role)}, scope ${fmt(scope)}, class ${fmt(cls)}; code requests leaked to a non-dev role while idle: ${leaks.length}; layers ${JSON.stringify(byLayer)}; model ${env.config.intent.model}`;
    process.stderr.write(`INTENT GOLDEN SET\n${table}\n${summary}\n`);
    if (process.env.INTENT_EVAL_OUT)
      writeFileSync(process.env.INTENT_EVAL_OUT, `${summary}\n\n${table}\n`);

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
