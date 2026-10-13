import { expect, test } from "bun:test";
import pino from "pino";
import type { DispatchDeps } from "../src/orchestrator/dispatch/dispatch-role";
import { MAX_CAPPED_TASKS } from "../src/orchestrator/dispatch/task-repo";
import { intentTurn } from "../src/orchestrator/intent-turn";
import { followTask } from "../src/orchestrator/recover-route";
import { EffortFloors } from "../src/orchestrator/thread/effort-floor";
import { entryRole } from "../src/roles/role-registry";
import { MAX_REROUTES_PER_TURN, nextStep } from "../src/routing/recovery-controller";
import { routeWithRecovery } from "../src/routing/route-with-recovery";
import type { AgentPreflightResult } from "../src/routing/routing-contracts";
import { activeOwnedTask } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { makeEnv } from "./helpers";
import { BG, FG, pipeline, proposer, tagOf, waitingTask } from "./routing-policy-fixtures";

const reject = (suggestedAgents: string[]): AgentPreflightResult => ({
  decision: "reject",
  reasonCode: "CAPABILITY_UNAVAILABLE",
  suggestedAgents,
  evidence: ["x"],
  safeToExecute: false,
});
const ctx = { entryRole: "entry", reroutable: true, allowReroute: true, reply: "legacy" };
const fresh = (visited: string[]) => ({ rerouted: false, visited });

test("nextStep: accept executes; clarification keeps the legacy text", () => {
  expect(nextStep({ ...reject([]), decision: "accept" }, fresh(["a"]), ctx)).toEqual({
    kind: "execute",
  });
  expect(nextStep({ ...reject([]), decision: "need_clarification" }, fresh(["a"]), ctx)).toEqual({
    kind: "clarify",
    text: "legacy",
    reasonCode: "CAPABILITY_UNAVAILABLE",
  });
});

test("nextStep: needs_collaboration asks one question naming the roles", () => {
  const s = nextStep({ ...reject(["a", "b"]), decision: "needs_collaboration" }, fresh(["a"]), ctx);
  expect(s).toMatchObject({ kind: "clarify" });
  expect(s.kind === "clarify" && s.text).toContain("a, b");
});

test("nextStep: reject -> first ranked unvisited candidate, in the order given", () => {
  expect(nextStep(reject(["b", "c"]), fresh(["a"]), ctx)).toEqual({ kind: "reroute", role: "b" });
  // A visited role is never chosen again.
  expect(nextStep(reject(["a", "c"]), fresh(["a"]), ctx)).toEqual({ kind: "reroute", role: "c" });
});

test("nextStep: no candidate -> the entry role, unless visited (then clarify)", () => {
  expect(nextStep(reject([]), fresh(["a"]), ctx)).toEqual({ kind: "reroute", role: "entry" });
  expect(nextStep(reject([]), fresh(["entry"]), ctx)).toMatchObject({
    kind: "clarify",
    text: "legacy",
  });
});

test("nextStep: second reject, tag or unfixable failure -> safe fail with the legacy text", () => {
  const after = { rerouted: true, visited: ["a", "b"] };
  expect(nextStep(reject(["c"]), after, ctx)).toMatchObject({ kind: "safe_fail", text: "legacy" });
  expect(nextStep(reject(["c"]), fresh(["a"]), { ...ctx, allowReroute: false }).kind).toBe(
    "safe_fail",
  );
  expect(nextStep(reject([]), fresh(["a"]), { ...ctx, reroutable: false }).kind).toBe("safe_fail");
});

test("ping-pong: A and B reject and suggest each other -> exactly 1 reroute, then safe fail, 2 preflights", () => {
  const roles: Record<string, string> = { A: "B", B: "A" };
  const state = fresh(["A"]);
  let role = "A";
  let preflights = 1;
  let reroutes = 0;
  for (let i = 0; i < 5; i++) {
    const step = nextStep(reject([roles[role]!]), state, ctx);
    if (step.kind !== "reroute") {
      expect(step.kind).toBe("safe_fail");
      break;
    }
    reroutes++;
    preflights++;
    role = step.role;
    state.rerouted = true;
    state.visited.push(role);
  }
  expect([reroutes, preflights, MAX_REROUTES_PER_TURN]).toEqual([1, 2, 1]);
});

function setup() {
  const env = makeEnv();
  const lines: Record<string, unknown>[] = [];
  const log = pino({ level: "debug" }, {
    write: (s: string) => void lines.push(JSON.parse(s)),
  } as never);
  const repos = loadWorkspaces(env.home).workspaces[0]!.repos;
  return { env, lines, log, repos };
}

test("driver: a background role without approvals is rerouted once to a foreground role", async () => {
  const { env, lines, log, repos } = setup();
  const out = await routeWithRecovery(
    log,
    { role: BG, text: "do it", repos, hasApprovals: false, db: env.db },
    { allowReroute: true },
  );
  expect(out).toMatchObject({
    kind: "execute",
    initial: BG,
    rerouted: true,
    rerouteReason: "AUTHORIZATION_REQUIRED",
  });
  expect(out.visited).toEqual([BG, out.role]);
  expect(out.refusal).toBeUndefined();
  expect(lines.filter((l) => l.event === "preflight.result")).toHaveLength(2);
  expect(lines.filter((l) => l.span === "recover")).toHaveLength(1);
});

test("driver: explicit tag (allowReroute false) keeps the legacy refusal, one preflight", async () => {
  const { env, lines, log, repos } = setup();
  const out = await routeWithRecovery(
    log,
    { role: BG, text: "do it", repos, hasApprovals: false, db: env.db },
    { allowReroute: false },
  );
  expect(out).toMatchObject({ kind: "safe_fail", rerouted: false });
  expect(out.reply).toBe("This task needs the Discord approval flow.");
  expect(lines.filter((l) => l.event === "preflight.result")).toHaveLength(1);
});

test("driver: unknown repo is a clarification (no reroute); task cap is a safe fail", async () => {
  const { env, log, repos } = setup();
  const unknown = await routeWithRecovery(
    log,
    { role: BG, text: "x", repoHint: "nope", repos, hasApprovals: true, db: env.db },
    { allowReroute: true },
  );
  expect(unknown).toMatchObject({ kind: "clarify", rerouted: false });
  expect(unknown.refusal?.reason).toBe("unknown_repo");
  for (let n = 0; n < MAX_CAPPED_TASKS; n++)
    insertTurn(env.db, { id: `c${n}`, threadId: `c${n}`, source: "t", repo: "repo", role: BG });
  const capped = await routeWithRecovery(
    log,
    { role: BG, text: "x", repos, hasApprovals: true, db: env.db },
    { allowReroute: true },
  );
  expect(capped).toMatchObject({ kind: "safe_fail", rerouted: false });
  expect(capped.refusal?.reason).toBe("code_task_limit");
});

test("driver: the entry role is the entry (sanity of the no-candidate exit)", () => {
  expect(entryRole().name).toBe(FG);
});

/** One message through `intentTurn` with a proposer that picks BG. */
async function pickTurn(env: ReturnType<typeof makeEnv>, lines: unknown[], text: string) {
  const log = pino({ level: "debug" }, {
    write: (s: string) => void lines.push(JSON.parse(s)),
  } as never);
  const { impl } = proposer({
    kind: "pick",
    role: BG,
    alternatives: [],
    scores: { ranking: { [BG]: 0.9, [FG]: 0.1 } },
  });
  return intentTurn({
    deps: { db: env.db } as unknown as DispatchDeps,
    log,
    message: { threadId: "th", messageId: "m1", recent: [] } as never,
    workspace: "ws",
    repos: loadWorkspaces(env.home).workspaces[0]!.repos,
    ac: new AbortController(),
    intent: { pipeline, engine: "jev", proposer: impl },
    floors: new EffortFloors(),
    stored: null,
    busy: false,
    cmd: { text },
  });
}

test("intentTurn: a Jev pick rejected by preflight is rerouted; no task.refused, one route.decision", async () => {
  const env = makeEnv();
  const lines: Record<string, unknown>[] = [];
  const out = await pickTurn(env, lines, "implement the login feature");
  expect(out).toMatchObject({ kind: "run", role: FG });
  expect(lines.some((l) => l.event === "task.refused")).toBe(false);
  const d = lines.filter((l) => l.event === "route.decision");
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({
    candidateAgentId: FG,
    initialCandidate: BG,
    rerouted: true,
    rationaleCode: "AUTHORIZATION_REQUIRED",
    preflight: "accept",
  });
});

test("intentTurn: a tagged background role is never rerouted (legacy reply, task.refused once)", async () => {
  const env = makeEnv();
  const lines: Record<string, unknown>[] = [];
  const out = await pickTurn(env, lines, `${tagOf(BG)} fix it`);
  expect(out).toEqual({ kind: "reply", text: "This task needs the Discord approval flow." });
  expect(lines.filter((l) => l.event === "task.refused")).toHaveLength(1);
});

test("intentTurn: reroute from a waiting task's owner to a foreground role leaves the task untouched", async () => {
  const env = waitingTask();
  const before = env.task;
  const lines: Record<string, unknown>[] = [];
  const { impl } = proposer({ kind: "continue", scores: { ranking: { [BG]: 0.9, [FG]: 0.1 } } });
  const log = pino({ level: "debug" }, {
    write: (s: string) => void lines.push(JSON.parse(s)),
  } as never);
  const out = await intentTurn({
    deps: { db: env.db } as unknown as DispatchDeps,
    log,
    message: { threadId: "th", messageId: "m2", recent: [] } as never,
    workspace: "ws",
    repos: loadWorkspaces(env.home).workspaces[0]!.repos,
    ac: new AbortController(),
    intent: { pipeline, engine: "jev", proposer: impl },
    floors: new EffortFloors(),
    stored: null,
    busy: false,
    cmd: { text: "keep going" },
  });
  expect(out).toMatchObject({ kind: "run", role: FG });
  expect(out.kind === "run" && out.continueTask).toBeUndefined();
  expect(lines.some((l) => l.event === "task.owner_changed")).toBe(false);
  expect(activeOwnedTask(env.db, "th")).toEqual(before);
});

test("followTask: a failed owner change does not link the run to the old task", () => {
  const env = waitingTask();
  expect(followTask(env.db, env.task, BG, "CAPABILITY_UNAVAILABLE", () => true)).toBe(
    env.task.taskId,
  );
  expect(followTask(env.db, env.task, BG, "CAPABILITY_UNAVAILABLE", () => false)).toBeUndefined();
});
