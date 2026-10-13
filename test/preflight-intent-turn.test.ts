import { expect, test } from "bun:test";
import pino from "pino";
import type { DispatchDeps } from "../src/orchestrator/dispatch/dispatch-role";
import { intentTurn } from "../src/orchestrator/intent-turn";
import { EffortFloors } from "../src/orchestrator/thread/effort-floor";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { makeEnv } from "./helpers";
import { BG, failing, tagOf } from "./routing-policy-fixtures";

/** One tagged message through `intentTurn`; the log lines are captured. */
async function turn(text: string, approvals?: unknown) {
  const env = makeEnv();
  const lines: Record<string, unknown>[] = [];
  const log = pino({ level: "debug" }, {
    write: (s: string) => void lines.push(JSON.parse(s)),
  } as never);
  const out = await intentTurn({
    deps: { db: env.db, approvals } as unknown as DispatchDeps,
    log,
    message: { threadId: "th", messageId: "m1", recent: [] } as never,
    workspace: "ws",
    repos: loadWorkspaces(env.home).workspaces[0]!.repos,
    ac: new AbortController(),
    intent: failing,
    floors: new EffortFloors(),
    stored: null,
    busy: false,
    cmd: { text },
  });
  return { out, lines };
}

test("a refused background role replies with the legacy text and logs preflight.result", async () => {
  const { out, lines } = await turn(`${tagOf(BG)} fix the bug`, undefined);
  expect(out).toEqual({ kind: "reply", text: "This task needs the Discord approval flow." });
  expect(lines.find((l) => l.event === "preflight.result")).toMatchObject({
    candidate: BG,
    decision: "reject",
    reasonCode: "AUTHORIZATION_REQUIRED",
    evidence: ["no_approvals"],
  });
  expect(lines.find((l) => l.event === "task.refused")).toMatchObject({ reason: "no_approvals" });
});
