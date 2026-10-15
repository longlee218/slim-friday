import { expect, test } from "bun:test";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ROLES } from "../src/roles/role-registry";
import { getProposal, insertProposal } from "../src/storage/proposal-store";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  answering,
  clearWorkspaces,
  defaultLocationPath,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/** Env with one managed clone `real` (dev tasks need it). */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.location, clone);
  return env;
}

const verdict = answering({ role: "dev", scope: "new", confidence: "high", reason: "r" });
const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});
const rows = (env: { db: any }, sql: string) => env.db.query(sql).all() as any[];

/** First run (assistant) blocks; a `[dev]` request is queued behind it and starts when it ends. Returns what the plan run saw. */
async function queueThenStart(devText: string) {
  const env = await setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const plan: any[] = [];
  let first = true;
  let started!: () => void;
  const startedLatch = new Promise<void>((r) => (started = r));
  const query = (a: any) =>
    (async function* () {
      if (first) {
        first = false;
        started();
        await gate;
      } else plan.push(a.options);
      yield resultMsg({ result: "ok" });
    })();
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: query as never,
    intent: {
      pipeline: {
        lexicon: loadLexicon(env.home),
        tagRouter: createRoleTagRouter(Object.values(ROLES)),
      },
      classifier: { classify: async (i: any) => verdict(i) } as any,
    },
  });
  const running = handle(msg("[ask] explain the location"));
  await startedLatch; // the first run is inside `query`, so the next message queues behind it
  await handle(msg(devText));
  const stored = rows(env, "SELECT effort FROM proposals")[0].effort;
  await handle(msg("yes"));
  release();
  await running;
  // The queued task starts after the first run ends: poll until its `query` call was seen.
  for (let i = 0; i < 200 && plan.length === 0; i++) await Bun.sleep(25);
  return { env, plan, stored };
}

test("queue -> start keeps the effort resolved when the request was queued", async () => {
  const { plan, stored, env } = await queueThenStart("[dev] analyze why add fails in a.ts");
  expect(stored).toBe("high"); // `analyze` -> at least high, stored with the proposal
  expect(plan.length).toBeGreaterThan(0);
  expect(plan[0].thinking).toMatchObject({ type: "enabled" }); // started at high: effort knobs applied
  expect(rows(env, "SELECT status FROM proposals")).toEqual([{ status: "dispatched" }]);
}, 15_000);

test("no effort signal: nothing stored, the started task keeps the stage defaults", async () => {
  const { plan, stored } = await queueThenStart("[dev] please add b.txt with two");
  expect(stored).toBeNull();
  expect(plan[0].thinking).toBeUndefined();
}, 15_000);

test("a stored effort round-trips through the proposal store", async () => {
  const { db } = makeEnv();
  const base = { threadId: "th", workspace: "main", role: "dev", brief: "do the thing please" };
  expect(getProposal(db, insertProposal(db, { ...base, effort: "medium" }))?.effort).toBe("medium");
  expect(getProposal(db, insertProposal(db, base))?.effort).toBeNull();
});
