import { expect, test } from "bun:test";
import pino, { type Logger } from "pino";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { JevAnswers } from "../src/intent/jev/jev-answer-schema";
import { decideBands } from "../src/intent/jev/jev-bands";
import { buildJevQuestions } from "../src/intent/jev/jev-questions";
import { entryRole, ROLES } from "../src/roles/role-registry";
import { decisionOfProposal } from "../src/routing/route-proposal-decision";
import type { RouteProposal, RouteProposer } from "../src/routing/route-proposer";
import { decideRoute } from "../src/routing/routing-policy";
import { makeEnv } from "./helpers";
import {
  BG,
  FG,
  haiku,
  input,
  pipeline,
  proposer,
  verdict,
  waitingTask,
} from "./routing-policy-fixtures";

const ENTRY = entryRole().name;
const roles = new Map(
  Object.values(ROLES)
    .filter((r) => r.whenToUse)
    .map((r) => [r.name, r] as const),
);
/** Answers: the entry-less role pick is irrelevant; Noul values drive the bands. */
const ans = (o: { multi?: number; cont?: number; ask?: number }): JevAnswers => ({
  role: { choice: FG, probabilities: { [FG]: 0.5, [BG]: 0.4, unclear: 0.1 }, confidence: 0.9 },
  multi_intent: { noul: o.multi ?? 0 },
  ...(o.cont !== undefined && { continues_task: { noul: o.cont } }),
  ...(o.ask !== undefined && { asks_about_task: { noul: o.ask } }),
});
const QUESTION: RouteProposal = { kind: "question", scores: { band: "question" } };

/** Logger that keeps the records instead of writing them. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = pino(
    { level: "info" },
    { write: (s: string) => void lines.push(JSON.parse(s)) },
  ) as unknown as Logger;
  return { log, shadow: () => lines.filter((l) => l.event === "routing.jev_shadow") };
}

test("bands: multi > question > continue; question carries questionP", () => {
  expect(decideBands(ans({ multi: 0.9, ask: 0.95, cont: 0.9 }), roles).kind).toBe("multi");
  const q = decideBands(ans({ ask: 0.85, cont: 0.95 }), roles);
  expect(q).toMatchObject({ kind: "question", scores: { questionP: 0.85, band: "question" } });
  expect(decideBands(ans({ ask: 0.79, cont: 0.95 }), roles).kind).toBe("continue");
});

test("questions: asks_about_task only with a task; continues_task excludes progress questions", () => {
  expect(Object.keys(buildJevQuestions(Object.values(ROLES), { hasTask: false }))).not.toContain(
    "asks_about_task",
  );
  const q = buildJevQuestions(Object.values(ROLES), { hasTask: true });
  expect(q.asks_about_task).toBeDefined();
  expect(q.continues_task?.instructions).toContain("NOT a question about its progress");
});

test("question proposal -> entry role decision with question (never the owner's role)", () => {
  expect(decisionOfProposal(QUESTION, undefined)).toEqual({
    kind: "role",
    role: ENTRY,
    scope: "new",
    question: true,
  });
});

test("policy: idle + waiting owned task + question -> entry role run, no continuation", async () => {
  const env = waitingTask();
  const deps: IntentDeps = {
    pipeline,
    classifier: haiku().classifier,
    engine: "jev",
    proposer: proposer(QUESTION).impl,
  };
  const plan = await decideRoute(input(env, "đang làm tới đâu rồi"), deps);
  expect(plan.decision).toMatchObject({ kind: "role", role: ENTRY, question: true });
  expect(plan.continueTask).toBeUndefined();
});

/** A busy, steerable thread; Haiku says dev-like `FG`/new unless told otherwise. */
const busyInput = (env: ReturnType<typeof makeEnv>, log: Logger) =>
  input(env, "how far along are you", {
    log,
    busy: true,
    steerable: true,
    state: "running",
    hasTask: true,
    scopeFromModel: true,
    controlFromModel: true,
  });
const busyDeps = (px?: RouteProposer, engine: "jev" | "haiku" = "jev"): IntentDeps => ({
  pipeline,
  classifier: haiku(verdict({ scope: "active" })).classifier,
  engine,
  ...(px && { proposer: px }),
});

test("shadow: route is identical with and without the proposer; logs agree / band, no text", async () => {
  const env = makeEnv();
  const c = capture();
  const without = await decideRoute(busyInput(env, c.log), busyDeps());
  const p = proposer(QUESTION);
  const withJev = await decideRoute(busyInput(env, c.log), busyDeps(p.impl));
  expect(withJev.decision).toEqual(without.decision);
  expect({ ...withJev.routing, timestamp: 0 }).toEqual({ ...without.routing, timestamp: 0 });
  expect(withJev.continueTask).toBe(without.continueTask);
  expect(p.calls).toHaveLength(1);
  expect(p.calls[0]).toMatchObject({ state: "running", task: { status: "running" } });
  const [rec] = c.shadow();
  expect(rec).toMatchObject({
    busy: true,
    jevKind: "question",
    band: "question",
    agree: false,
    haikuAction: { kind: "role", scope: "active", question: false },
  });
  expect(JSON.stringify(rec)).not.toContain("how far");
});

test("shadow: a late answer is logged with late, the route does not wait for it", async () => {
  const env = makeEnv();
  const c = capture();
  let release!: (p: RouteProposal) => void;
  const slow: RouteProposer = { propose: () => new Promise((r) => (release = r)) };
  const plan = await decideRoute(busyInput(env, c.log), busyDeps(slow));
  expect(plan.decision.kind).toBe("role");
  expect(c.shadow()).toHaveLength(0);
  release({ kind: "pick", role: FG, alternatives: [], scores: { band: "pick" } });
  for (let n = 0; n < 5; n++) await Promise.resolve();
  expect(c.shadow()).toMatchObject([{ jevKind: "pick", late: true }]);
});

test("shadow: a throwing proposer and an aborted signal never affect the route", async () => {
  const env = makeEnv();
  const c = capture();
  const ac = new AbortController();
  ac.abort();
  const boom = proposer(new Error("aborted"));
  const base = await decideRoute(busyInput(env, c.log), busyDeps());
  const plan = await decideRoute(
    { ...busyInput(env, c.log), signal: ac.signal },
    busyDeps(boom.impl),
  );
  expect(plan.decision).toEqual(base.decision);
  expect(c.shadow()).toMatchObject([{ jevKind: "undecided" }]);
});

test("shadow: off under engine haiku, when idle and when not steerable", async () => {
  const env = makeEnv();
  const c = capture();
  const p = proposer(QUESTION);
  await decideRoute(busyInput(env, c.log), busyDeps(p.impl, "haiku"));
  await decideRoute({ ...busyInput(env, c.log), steerable: false }, busyDeps(p.impl));
  expect(c.shadow()).toHaveLength(0);
});
