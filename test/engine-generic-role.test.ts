import { expect, test } from "bun:test";
import { runStages } from "../src/orchestrator/engine/stage-runner";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { insertTurn } from "../src/storage/run-store";
import { listStages } from "../src/storage/stage-store";
import { initMsg, makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";

/** A role invented in the test: data only, no engine code behind it (read-only, one stage, no gate). */
const PROBE: RoleDefinition = {
  name: "probe-reviewer",
  whenToUse: "test only",
  output: "answer",
  maxAsk: 3,
  countsTowardCap: false,
  stages: [
    {
      name: "review",
      capabilities: ["read"],
      gitGroups: ["read"],
      model: "haiku",
      budgetUsd: 0.4,
      promptSections: () => ["probe contract"],
    },
  ],
};

test("a role that is only data runs through the stage runner and gets its stage row", async () => {
  const env = makeEnv();
  const roles = ROLES as Record<string, RoleDefinition>;
  roles[PROBE.name] = PROBE;
  try {
    insertTurn(env.db, {
      id: "t1",
      threadId: "th",
      source: "test",
      repo: "repo",
      role: "assistant",
    });
    const res = await runStages(
      {
        db: env.db,
        config: env.config,
        approvals: stubGateway(),
        queryFn: ((_a: unknown) =>
          (async function* () {
            yield resultMsg({ result: "looks fine" });
          })()) as never,
      },
      {
        turnId: "t1",
        threadId: "th",
        text: "review it",
        role: PROBE.name,
        workspace: "main",
        repos: [{ name: "repo", path: env.repo } as never],
        ac: new AbortController(),
      },
    );
    expect(res.outcome).toBe("success");
    expect(res.text).toBe("looks fine");
    const rows = listStages(env.db, "t1");
    expect(rows.map((r) => [r.name, r.status])).toEqual([["review", "done"]]);
  } finally {
    delete roles[PROBE.name];
  }
});

test("a stage with a gate the engine cannot run fails closed, nothing is run", async () => {
  const env = makeEnv();
  const roles = ROLES as Record<string, RoleDefinition>;
  const first = PROBE.stages[0];
  if (!first) throw new Error("probe has a stage");
  roles[PROBE.name] = { ...PROBE, stages: [{ ...first, gate: "owner-confirm" }] };
  let ran = false;
  try {
    const res = await runStages(
      {
        db: env.db,
        config: env.config,
        approvals: stubGateway(),
        queryFn: ((_a: unknown) => {
          ran = true;
          return (async function* () {})();
        }) as never,
      },
      {
        turnId: "t2",
        threadId: "th",
        text: "x",
        role: PROBE.name,
        workspace: "main",
        repos: [],
        ac: new AbortController(),
      },
    );
    expect(res.outcome).toBe("error");
    expect(res.text).toContain("cannot run");
    expect(ran).toBe(false);
  } finally {
    delete roles[PROBE.name];
  }
});

test("Q&A is the 1-stage assistant role run by the engine: its turn leaves a qa stage row", async () => {
  const env = makeEnv();
  const queryFn = (_a: unknown) =>
    (async function* () {
      yield initMsg;
      yield resultMsg();
    })();
  const reply = await createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: queryFn as never,
  })({ source: "t", channelId: TEST_CHANNEL, userId: "u", threadId: "th-qa", text: "where is x?" });
  expect(reply).toContain("alpha is in a.txt:1");
  const task = env.db
    .query<{ id: string; role: string }, [string]>("SELECT id, role FROM turns WHERE thread_id = ?")
    .get("th-qa");
  expect(task?.role).toBe("assistant");
  const rows = listStages(env.db, task?.id ?? "");
  expect(rows.map((r) => [r.name, r.status])).toEqual([["qa", "done"]]);
});
