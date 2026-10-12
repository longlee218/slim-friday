import { afterAll, expect, test } from "bun:test";
import { createGitMcp } from "../src/mcp/git-mcp";
import { runStages } from "../src/orchestrator/engine/stage-runner";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { DEV_ROLE } from "../src/roles/builtin/dev-role";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition, StageDefinition } from "../src/roles/role-types";
import { insertTurn } from "../src/storage/run-store";
import { listStages } from "../src/storage/stage-store";
import { initMsg, makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";

const git = createGitMcp();
afterAll(() => git.close());

const S: StageDefinition = {
  name: "s",
  capabilities: ["read"],
  gitGroups: ["read"],
  model: "haiku",
  budgetUsd: 0.4,
  promptSections: () => [],
};
const probe = (o: Partial<RoleDefinition>): RoleDefinition => ({
  name: "probe-x",
  whenToUse: "test only",
  output: "answer",
  maxAsk: 3,
  countsTowardCap: false,
  stages: [S],
  ...o,
});

/** Run `role` (registered for the call) with a query that counts its calls. */
async function runProbe(role: RoleDefinition, extra: { worktree?: never } = {}) {
  const env = makeEnv();
  const roles = ROLES as Record<string, RoleDefinition>;
  roles[role.name] = role;
  let calls = 0;
  try {
    insertTurn(env.db, { id: "t1", threadId: "th", source: "t", repo: "repo", role: "assistant" });
    const res = await runStages(
      {
        git,
        db: env.db,
        config: env.config,
        approvals: stubGateway(),
        queryFn: ((_a: unknown) => {
          calls++;
          return (async function* () {
            yield resultMsg({ result: "ok" });
          })();
        }) as never,
      },
      {
        turnId: "t1",
        threadId: "th",
        text: "x",
        role: role.name,
        workspace: "main",
        repos: [{ name: "repo", path: env.repo } as never],
        ac: new AbortController(),
        ...extra,
      },
    );
    return { res, calls, rows: listStages(env.db, "t1") };
  } finally {
    delete roles[role.name];
  }
}

test("a plain stage with an output that has no handler fails closed before any run", async () => {
  for (const output of ["verdict", "plan", "pr"] as const) {
    const r = await runProbe(probe({ output }));
    expect(r.res.outcome).toBe("error");
    expect(r.res.text).toContain("no handler");
    expect([r.calls, r.rows.length]).toEqual([0, 0]);
  }
});

test("all stages are validated before the first one runs (no side effect)", async () => {
  const bad = { ...S, name: "late", gate: "owner-confirm" as const };
  const r = await runProbe(probe({ stages: [S, bad] }));
  expect(r.res.text).toContain("cannot run");
  expect([r.calls, r.rows.length]).toEqual([0, 0]);
  const plan = { ...S, name: "p", gate: "plan-approval" as const };
  const r2 = await runProbe(probe({ stages: [plan, S] }));
  expect(r2.res.text).toContain("must run in a clone");
  expect([r2.calls, r2.rows.length]).toEqual([0, 0]);
});

test("a role with an isolated stage and no followUp refuses a follow-up in a clone", async () => {
  const clone = { ...S, name: "c", isolation: "clone" as const };
  const wt = { path: "/nowhere", repo: "repo" } as never;
  const noFollow = await runProbe(probe({ stages: [clone] }), { worktree: wt });
  expect(noFollow.res.text).toContain("no follow-up");
  expect([noFollow.calls, noFollow.rows.length]).toEqual([0, 0]);
  // dev declares its follow-up start stage: not refused by the rule
  expect(DEV_ROLE.followUp?.startAtStage).toBeTruthy();
});

test("a thrown stage run marks the row failed, not running", async () => {
  const env = makeEnv();
  insertTurn(env.db, { id: "t1", threadId: "th", source: "t", repo: "repo", role: "assistant" });
  const run = runStages(
    {
      git,
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      queryFn: (() => {
        throw new Error("boom");
      }) as never,
    },
    {
      turnId: "t1",
      threadId: "th",
      text: "x",
      role: "assistant",
      workspace: "main",
      repos: [{ name: "repo", path: env.repo } as never],
      ac: new AbortController(),
    },
  );
  await run.catch(() => undefined);
  expect(listStages(env.db, "t1").map((r) => r.status)).toEqual(["failed"]);
});

test("`go +5` that falls back to a plain message does not carry the raise into Q&A", async () => {
  const env = makeEnv();
  const budgets: unknown[] = [];
  const handler = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: ((a: { options: { maxBudgetUsd?: number } }) => {
      budgets.push(a.options.maxBudgetUsd);
      return (async function* () {
        yield initMsg;
        yield resultMsg();
      })();
    }) as never,
  });
  const send = (threadId: string, text: string) =>
    handler({ source: "t", channelId: TEST_CHANNEL, userId: "u", threadId, text });
  await send("th-a", "where is x?");
  await send("th-b", "go +5");
  expect(budgets).toHaveLength(2);
  expect(budgets[1]).toBe(budgets[0]);
});
