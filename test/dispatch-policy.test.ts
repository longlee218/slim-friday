import { expect, test } from "bun:test";
import type { Caps, GoalState, PolicyEnv } from "../src/orchestrator/strategy/caps";
import {
  type Assignment,
  checkDispatch,
  type DispatchReq,
  depsShape,
} from "../src/orchestrator/strategy/dispatch-policy";

const ENV: PolicyEnv = { workerRoles: ["developer", "scout"], locations: ["repo"] };
const CAPS: Caps = { chainCount: 0, dispatchedThisRun: 0 };
const IDLE: GoalState = { items: [] };
const a = (key: string, dependsOn: string[] = [], over: Partial<Assignment> = {}): Assignment => ({
  key,
  role: "developer",
  brief: "b",
  dependsOn,
  ...over,
});
const direct = (over: Partial<DispatchReq> = {}): DispatchReq => ({
  strategy: "DIRECT",
  assignments: [a("main")],
  ...over,
});
const delegate = (assignments: Assignment[]): DispatchReq => ({
  strategy: "DELEGATE",
  assignments,
});

/** Code of a refusal, or "ok". */
const run = (req: DispatchReq, caps: Partial<Caps> = {}, state: GoalState = IDLE) => {
  const r = checkDispatch(state, req, { ...CAPS, ...caps }, ENV);
  return r.ok ? "ok" : r.code;
};

test("every refusal code and the accepted shapes", () => {
  const table: [string, string, DispatchReq, Partial<Caps>, GoalState][] = [
    ["ok", "ok", direct(), {}, IDLE],
    ["one per run", "ONE_PER_RUN", direct(), { dispatchedThisRun: 1 }, IDLE],
    ["chain cap, full", "CHAIN_CAP", direct(), { chainCount: 3 }, IDLE],
    ["chain 2 used + 1 ok", "ok", direct(), { chainCount: 2 }, IDLE],
    [
      "chain 2 used + delegate of 3",
      "CHAIN_CAP",
      delegate([a("x"), a("y"), a("z")]),
      { chainCount: 2 },
      IDLE,
    ],
    [
      "chain 1 used + delegate of 3",
      "CHAIN_CAP",
      delegate([a("x"), a("y"), a("z")]),
      { chainCount: 1 },
      IDLE,
    ],
    ["goal open", "GOAL_OPEN", direct(), {}, { openGoalId: "g1", items: [] }],
    [
      "goal open, wrong supersedes",
      "GOAL_OPEN",
      direct({ supersedes: "g2" }),
      {},
      { openGoalId: "g1", items: [] },
    ],
    [
      "supersedes the open goal",
      "ok",
      direct({ supersedes: "g1" }),
      {},
      { openGoalId: "g1", items: [] },
    ],
    [
      "direct with two",
      "TOO_MANY",
      { strategy: "DIRECT", assignments: [a("x"), a("y")] },
      {},
      IDLE,
    ],
    [
      "unknown role",
      "NOT_WORKER",
      direct({ assignments: [a("main", [], { role: "lead" })] }),
      {},
      IDLE,
    ],
    [
      "bad location",
      "BAD_LOCATION",
      direct({ assignments: [a("main", [], { location: "/etc" })] }),
      {},
      IDLE,
    ],
    [
      "good location",
      "ok",
      direct({ assignments: [a("main", [], { location: "repo" })] }),
      {},
      IDLE,
    ],
    ["cycle", "CYCLE", delegate([a("x", ["y"]), a("y", ["x"])]), {}, IDLE],
    ["self dependency", "CYCLE", delegate([a("x", ["x"])]), {}, IDLE],
    ["unknown dependency", "CYCLE", delegate([a("x", ["nope"])]), {}, IDLE],
    ["duplicate key", "CYCLE", delegate([a("x"), a("x")]), {}, IDLE],
    ["duplicate keys among 4", "CYCLE", delegate([a("x"), a("x"), a("y"), a("z")]), {}, IDLE],
    ["supersedes with no open goal", "BAD_TASK", direct({ supersedes: "g9" }), {}, IDLE],
    ["4 assignments", "NEEDS_PLAN", delegate([a("a"), a("b"), a("c"), a("d")]), {}, IDLE],
    ["branching", "NEEDS_PLAN", delegate([a("x"), a("y", ["x"]), a("z", ["x"])]), {}, IDLE],
    ["join", "NEEDS_PLAN", delegate([a("x"), a("y"), a("z", ["x", "y"])]), {}, IDLE],
    ["chain of 3", "ok", delegate([a("x"), a("y", ["x"]), a("z", ["y"])]), {}, IDLE],
    ["3 independent", "ok", delegate([a("x"), a("y"), a("z")]), {}, IDLE],
  ];
  for (const [name, want, req, caps, state] of table)
    expect([name, run(req, caps, state)]).toEqual([name, want]);
});

test("rule order: one-per-run, goal open, then chain cap last (after the shape rules)", () => {
  const open: GoalState = { openGoalId: "g1", items: [] };
  const all = { dispatchedThisRun: 1, chainCount: 9 };
  expect(run(direct(), all, open)).toBe("ONE_PER_RUN");
  expect(run(direct(), { ...all, dispatchedThisRun: 0 }, open)).toBe("GOAL_OPEN");
  expect(run(direct(), { chainCount: 9 })).toBe("CHAIN_CAP");
  // a too-big request answers NEEDS_PLAN even when the chain is also full
  expect(run(delegate([a("a"), a("b"), a("c"), a("d")]), { chainCount: 9 })).toBe("NEEDS_PLAN");
});

test("accepted items: no dependency = ready, otherwise pending", () => {
  const r = checkDispatch(IDLE, delegate([a("x"), a("y", ["x"])]), CAPS, ENV);
  expect(r.ok && r.items.map((i) => [i.key, i.status])).toEqual([
    ["x", "ready"],
    ["y", "pending"],
  ]);
});

test("depsShape: chain, branching, bad", () => {
  expect(depsShape([a("x"), a("y", ["x"])])).toBe("chain");
  expect(depsShape([a("x", ["y"]), a("y", ["x"])])).toBe("bad");
  expect(depsShape([a("x"), a("y", ["x"]), a("z", ["x"])])).toBe("branching");
});
