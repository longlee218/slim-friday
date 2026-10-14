import { describe, expect, test } from "bun:test";
import pino from "pino";
import type { IntentDeps } from "../src/intent/decide-intent";
import { type JevClient, JevError, type JevRaw } from "../src/intent/jev/jev-client";
import { createJevProposer } from "../src/intent/jev/jev-proposer";
import { routeWithRecovery } from "../src/routing/route-with-recovery";
import { decideRoute } from "../src/routing/routing-policy";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { makeEnv } from "./helpers";
import { ROUTING_CASES, type RoutingCase, type Sym } from "./intent-eval-cases-routing";
import {
  afterTurn,
  BG,
  FG,
  haiku,
  input,
  pipeline,
  tagOf,
  verdict,
  waitingTask,
} from "./routing-policy-fixtures";

/* Deterministic routing golden set: every case runs `decideRoute` with a FAKE Jev client and a FAKE Haiku (no paid call). */

const NAME: Record<Sym, string> = { bg: BG, fg: FG };

/** Scripted Jev wire answers of a case (or the failure the client throws). */
function scripted(s: NonNullable<RoutingCase["jev"]>): JevRaw["answers"] | JevError {
  if ("fail" in s)
    return s.fail === "invalid" ? { role: "garbage" } : new JevError(s.fail, "scripted");
  const probabilities = Object.fromEntries(
    Object.entries(s.p).map(([k, v]) => [k === "unclear" ? k : NAME[k as Sym], v]),
  );
  const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  const noul = (n: number) => ({ type: "noul", noul: n });
  return {
    role: { type: "choice", choice, probabilities, confidence: 0.9 },
    multi_intent: noul(s.multi ?? 0.05),
    ...(s.cont !== undefined && { continues_task: noul(s.cont) }),
    ...(s.fits !== undefined && { fits_last_role: noul(s.fits) }),
  };
}

/** Run one case; returns the plan and the call counts. */
async function run(c: RoutingCase) {
  const env =
    c.setup === "waiting"
      ? waitingTask()
      : c.setup === "afterFg"
        ? afterTurn(FG)
        : c.setup === "afterBg"
          ? afterTurn(BG)
          : makeEnv();
  const h =
    c.haiku === "fail"
      ? haiku(new Error("down"))
      : haiku(verdict({ role: NAME[c.haiku ?? "fg"], scope: "new" }));
  let jevCalls = 0;
  const reply = c.jev ? scripted(c.jev) : undefined;
  const client: JevClient = {
    ask: async () => {
      jevCalls++;
      if (reply instanceof Error) throw reply;
      return { answers: reply!, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const engine = c.engine ?? "jev";
  const deps: IntentDeps = {
    pipeline,
    classifier: h.classifier,
    engine,
    ...(engine === "jev" && reply && { proposer: createJevProposer(client) }),
  };
  const text = c.text.replace(/\{(bg|fg)\}/g, (_, k: Sym) => tagOf(NAME[k]));
  const plan = await decideRoute(
    input(env, text, { state: c.setup.startsWith("after") ? "done" : "idle" }),
    deps,
  );
  return { plan, haikuCalls: h.inputs.length, jevCalls };
}

describe("routing golden set (fake Jev + fake Haiku)", () => {
  test("case ids are unique and labels name an expected owner when they pin continuity", () => {
    const ids = ROUTING_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ROUTING_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ROUTING_CASES.map((c) => c.lang))).toEqual(new Set(["en", "vi"]));
  });

  for (const c of ROUTING_CASES)
    test(c.id, async () => {
      const { plan, haikuCalls, jevCalls } = await run(c);
      const e = c.expect;
      const got = plan.decision.kind === "ask" ? "ask" : (plan.decision as { role: string }).role;
      expect(got).toBe(e.role === "ask" ? "ask" : NAME[e.role]);
      expect(plan.routing.source).toBe(e.source);
      if (e.rationale) expect(plan.routing.rationaleCode).toBe(e.rationale);
      expect(!!plan.continueTask).toBe(!!e.continues);
      if (e.haikuCalls !== undefined) expect(haikuCalls).toBe(e.haikuCalls);
      if (e.jevCalls !== undefined) expect(jevCalls).toBe(e.jevCalls);
      // A Jev act-band pick must carry its expected owner label and match it (the calibration invariant).
      if (plan.routing.source === "jev") {
        expect(c.labels.expectedOwner).toBeDefined();
        expect(got).toBe(NAME[c.labels.expectedOwner!]);
      }
    });
});

/** Preflight + bounded recovery cases (deterministic: no model). */
describe("preflight and recovery golden cases", () => {
  const setup = () => {
    const env = makeEnv();
    const lines: Record<string, unknown>[] = [];
    const log = pino({ level: "debug" }, {
      write: (s: string) => void lines.push(JSON.parse(s)),
    } as never);
    return { env, lines, log, locations: loadWorkspaces(env.home).workspaces[0]!.locations };
  };
  const count = (lines: Record<string, unknown>[], event: string) =>
    lines.filter((l) => l.event === event).length;

  test("background role without approvals -> rerouted once, 2 preflights", async () => {
    const { env, lines, log, locations } = setup();
    const out = await routeWithRecovery(
      log,
      { role: BG, text: "do it", locations, hasApprovals: false, db: env.db },
      { allowReroute: true },
    );
    expect(out).toMatchObject({ kind: "execute", rerouted: true, initial: BG });
    expect(count(lines, "preflight.result")).toBe(2);
  });

  test("explicit tag is never rerouted: safe fail, 1 preflight", async () => {
    const { env, lines, log, locations } = setup();
    const out = await routeWithRecovery(
      log,
      { role: BG, text: "do it", locations, hasApprovals: false, db: env.db },
      { allowReroute: false },
    );
    expect(out).toMatchObject({ kind: "safe_fail", rerouted: false });
    expect(count(lines, "preflight.result")).toBe(1);
  });

  test("unknown location -> clarification, no reroute", async () => {
    const { env, log, locations } = setup();
    const out = await routeWithRecovery(
      log,
      { role: BG, text: "x", locationHint: "nope", locations, hasApprovals: true, db: env.db },
      { allowReroute: true },
    );
    expect(out).toMatchObject({ kind: "clarify", rerouted: false });
  });

  test("a foreground candidate passes preflight untouched", async () => {
    const { env, log, locations } = setup();
    const out = await routeWithRecovery(
      log,
      { role: FG, text: "what is alpha", locations, hasApprovals: false, db: env.db },
      { allowReroute: true },
    );
    expect(out).toMatchObject({ kind: "execute", rerouted: false, preflight: "accept" });
  });
});
