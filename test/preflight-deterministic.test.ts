import { expect, test } from "bun:test";
import { MAX_CAPPED_TASKS } from "../src/orchestrator/dispatch/task-repo";
import {
  deterministicPreflight,
  PREFLIGHT_CHECKS,
  type PreflightCtx,
} from "../src/routing/preflight/deterministic-preflight";
import { insertTurn } from "../src/storage/run-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { makeEnv } from "./helpers";
import { BG, FG } from "./routing-policy-fixtures";

function setup(over: Partial<PreflightCtx> = {}) {
  const env = makeEnv();
  const repos = loadWorkspaces(env.home).workspaces[0]!.repos;
  const ctx: PreflightCtx = {
    role: BG,
    text: "do it",
    repos,
    hasApprovals: true,
    db: env.db,
    ...over,
  };
  return { env, ctx };
}

test("accept: a background and a foreground candidate pass every check", () => {
  for (const role of [BG, FG]) {
    const { ctx } = setup({ role });
    const out = deterministicPreflight(ctx);
    expect(out.refusal).toBeUndefined();
    expect(out.result).toMatchObject({ decision: "accept", safeToExecute: true });
  }
});

test("unknown repo hint -> need_clarification, legacy reason unknown_repo", () => {
  const { ctx } = setup({ repoHint: "nope" });
  const out = deterministicPreflight(ctx);
  expect(out.result).toMatchObject({
    decision: "need_clarification",
    reasonCode: "MISSING_INFORMATION",
    suggestedAgents: [],
    evidence: ["unknown_repo"],
    safeToExecute: false,
  });
  expect(out.refusal?.reason).toBe("unknown_repo");
});

test("repo hint without text -> empty_text; background role without text -> empty_text", () => {
  const withRepo = setup({ repoHint: "repo", text: "" }).ctx;
  expect(deterministicPreflight(withRepo).refusal).toMatchObject({
    reason: "empty_text",
    reply: 'Send your question after "repo:repo".',
  });
  const bare = deterministicPreflight(setup({ text: "" }).ctx);
  expect(bare.result.decision).toBe("need_clarification");
  expect(bare.refusal).toMatchObject({
    reason: "empty_text",
    reply: "Send a message with the task.",
  });
  // A foreground role may get an empty text (nothing to refuse before the run).
  expect(deterministicPreflight(setup({ role: FG, text: "" }).ctx).result.decision).toBe("accept");
});

test("unknown role -> reject, suggestions ranked by the router probabilities", () => {
  const plain = deterministicPreflight(setup({ role: "nope" }).ctx);
  expect(plain.result).toMatchObject({ decision: "reject", reasonCode: "CAPABILITY_UNAVAILABLE" });
  expect(plain.refusal?.reason).toBe("unknown_role");
  const ranked = deterministicPreflight(
    setup({ role: "nope", ranking: { [BG]: 0.1, [FG]: 0.9 } }).ctx,
  );
  expect(ranked.result.suggestedAgents[0]).toBe(FG);
  expect(ranked.result.suggestedAgents).not.toContain("nope");
});

test("approvalRequired without approvals -> reject, only authorized roles suggested", () => {
  const out = deterministicPreflight(setup({ hasApprovals: false }).ctx);
  expect(out.result).toMatchObject({
    decision: "reject",
    reasonCode: "AUTHORIZATION_REQUIRED",
    suggestedAgents: [FG],
  });
  expect(out.refusal?.reason).toBe("no_approvals");
});

test("capped task limit -> reject, not reroutable, legacy event task.busy", () => {
  const { ctx, env } = setup();
  for (const id of Array.from({ length: MAX_CAPPED_TASKS }, (_, n) => `cap${n}`))
    insertTurn(env.db, { id, threadId: id, source: "t", repo: "repo", role: BG });
  const out = deterministicPreflight(ctx);
  expect(out.result).toMatchObject({
    decision: "reject",
    reasonCode: "CAPABILITY_UNAVAILABLE",
    suggestedAgents: [],
  });
  expect(out.refusal).toMatchObject({ reason: "code_task_limit", event: "task.busy" });
});

test("first hit wins: unknown repo beats no approvals and an empty text", () => {
  const out = deterministicPreflight(
    setup({ repoHint: "nope", hasApprovals: false, text: "" }).ctx,
  );
  expect(out.result.evidence).toEqual(["unknown_repo"]);
  expect(PREFLIGHT_CHECKS.map((c) => c.id)).toEqual([
    "unknown_repo",
    "empty_text_repo",
    "unknown_role",
    "no_approvals",
    "empty_text",
    "code_task_limit",
  ]);
});

test("no side effects: every table keeps its row count", () => {
  const { ctx, env } = setup();
  const tables = env.db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((t) => t.name);
  const counts = () =>
    tables.map((t) => env.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t}"`).get()!.n);
  const before = counts();
  for (const c of [ctx, { ...ctx, hasApprovals: false }, { ...ctx, repoHint: "nope" }])
    deterministicPreflight(c);
  expect(counts()).toEqual(before);
});
