import { expect, test } from "bun:test";
import { runRole } from "../src/orchestrator/engine/run-role";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { insertTurn } from "../src/storage/run-store";
import { initMsg, makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";
import { workersDone } from "./lead-harness";

/** A role invented in the test: data only, no engine code behind it (read-only, foreground). */
const PROBE: RoleDefinition = {
  name: "probe-reviewer",
  whenToUse: "test only",
  background: false,
  limits: { maxAsk: 3 },
  sideEffects: "none",
  approvalRequired: false,
  capabilityVersion: "1",
  capabilities: ["read"],
  model: "haiku",
  budgetUsd: 0.4,
  promptSections: () => ["probe contract"],
};

/** Run PROBE (registered for the call); the fake query records the options it was given. */
async function runProbe(role: RoleDefinition) {
  const env = makeEnv();
  const roles = ROLES as Record<string, RoleDefinition>;
  roles[role.name] = role;
  const seen: any[] = [];
  try {
    insertTurn(env.db, {
      id: "t1",
      threadId: "th",
      source: "test",
      location: "location",
      role: "lead",
    });
    const res = await runRole(
      {
        db: env.db,
        config: env.config,
        approvals: stubGateway(),
        queryFn: ((a: { options: unknown }) => {
          seen.push(a.options);
          return (async function* () {
            yield resultMsg({ result: "looks fine" });
          })();
        }) as never,
      },
      {
        turnId: "t1",
        threadId: "th",
        text: "review it",
        role: role.name,
        workspace: "main",
        locations: [{ name: "location", path: env.location } as never],
        ac: new AbortController(),
      },
    );
    return { env, res, seen };
  } finally {
    delete roles[role.name];
  }
}

test("a role that is only data runs through the role runner: one agent run, its own model, budget and prompt", async () => {
  const { env, res, seen } = await runProbe(PROBE);
  expect(res.outcome).toBe("success");
  expect(res.text).toBe("looks fine");
  expect(seen).toHaveLength(1);
  expect(seen[0].maxBudgetUsd).toBe(0.4);
  expect(seen[0].systemPrompt.append).toContain("probe contract");
  // No permission layer gateway for a role without the ask capability: a question is a deny.
  expect(env.db.query("SELECT model, outcome FROM runs").all()).toEqual([
    { model: env.config.models.haiku, outcome: "success" },
  ]);
});

test("a role whose data the engine cannot run fails closed, nothing is run", async () => {
  const { res, seen, env } = await runProbe({ ...PROBE, budgetUsd: 0 });
  expect(res.outcome).toBe("error");
  expect(res.text).toContain("budget");
  expect(seen).toHaveLength(0);
  expect(env.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
});

test("a dev worker is a role run by the same engine: its turn leaves a runs row", async () => {
  const env = makeEnv();
  const queryFn = (_a: unknown) =>
    (async function* () {
      yield initMsg;
      yield resultMsg();
    })();
  await createTurnHandler({ db: env.db, config: env.config, queryFn: queryFn as never })({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th-dev",
    text: "[dev] where is x?",
  });
  await workersDone(env.db);
  const task = env.db
    .query<{ id: string; role: string }, [string]>("SELECT id, role FROM turns WHERE thread_id = ?")
    .get("th-dev");
  expect(task?.role).toBe("developer");
  expect(env.db.query("SELECT outcome FROM runs WHERE turn_id = ?").all(task?.id ?? "")).toEqual([
    { outcome: "success" },
  ]);
});
