import { afterAll, expect, test } from "bun:test";
import { workspacePaths } from "../src/config/workspace-paths";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { createGitMcp } from "../src/mcp/git-mcp";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ROLES } from "../src/roles/role-registry";
import { getProposal, insertProposal } from "../src/storage/proposal-store";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  answering,
  clearWorkspaces,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

const git = createGitMcp();
afterAll(() => git.close());

/** Env with one managed clone `real` (dev tasks need it). */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const clone = workspacePaths(env.home).workspace("main").repo("real").clone;
  addRepo(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.repo, clone);
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
  const query = (a: any) =>
    (async function* () {
      if (first) {
        first = false;
        await gate;
      } else plan.push(a.options);
      yield resultMsg({ result: "ok" });
    })();
  const handle = createTurnHandler({
    git,
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
  const running = handle(msg("[ask] explain the repo"));
  await Bun.sleep(50);
  await handle(msg(devText));
  const stored = rows(env, "SELECT effort FROM proposals")[0].effort;
  await handle(msg("yes"));
  release();
  await running;
  return { env, plan, stored };
}

test("queue -> start keeps the effort resolved when the request was queued", async () => {
  const { plan, stored, env } = await queueThenStart("[dev] analyze why add fails in a.ts");
  expect(stored).toBe("high"); // `analyze` -> at least high, stored with the proposal
  expect(plan.length).toBeGreaterThan(0);
  expect(plan[0].thinking).toMatchObject({ type: "enabled" }); // started at high: effort knobs applied
  expect(rows(env, "SELECT status FROM proposals")).toEqual([{ status: "dispatched" }]);
});

test("no effort signal: nothing stored, the started task keeps the stage defaults", async () => {
  const { plan, stored } = await queueThenStart("[dev] please add b.txt with two");
  expect(stored).toBeNull();
  expect(plan[0].thinking).toBeUndefined();
});

test("a stored effort round-trips through the proposal store", async () => {
  const { db } = makeEnv();
  const base = { threadId: "th", workspace: "main", role: "dev", brief: "do the thing please" };
  expect(getProposal(db, insertProposal(db, { ...base, effort: "medium" }))?.effort).toBe("medium");
  expect(getProposal(db, insertProposal(db, base))?.effort).toBeNull();
});
