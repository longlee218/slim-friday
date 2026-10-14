import { expect, test } from "bun:test";
import { logger } from "../src/observability/logger";
import { routeAndRun } from "../src/orchestrator/route-and-run";
import { EffortFloors } from "../src/orchestrator/thread/effort-floor";
import { makeEnv, TEST_CHANNEL } from "./helpers";

/* M-e: a crash must not swallow the notice about steers the run never read. */

test("a crash posts the undelivered notice into the thread, then is re-thrown", async () => {
  const env = makeEnv();
  const posted: string[] = [];
  let asked = 0;
  const steer = {
    // the registry hands the notice out once (it forgets it)
    undeliveredNotice: () => (++asked === 1 ? "Not delivered to the agent: x" : ""),
  };
  const ac = new AbortController();
  const rc = {
    deps: { db: env.db, config: env.config, steer, stopping: () => false },
    log: logger,
    message: {
      source: "t",
      userId: "u",
      threadId: "th",
      channelId: TEST_CHANNEL,
      text: "hello",
      notify: async (t: string) => void posted.push(t),
    },
    taskId: "t1",
    t0: Date.now(),
    workspace: "main",
    locations: [],
    ac,
    begin: () => {},
    turnLocation: () => "*",
  };
  await expect(
    routeAndRun({
      rc: rc as never,
      parsed: { kind: "message", text: "hello" },
      stored: null,
      floors: new EffortFloors(),
      // a broken intent layer: the turn throws before any run
      intent: { pipeline: null as never },
      hasApprovals: false,
      renewAc: () => new AbortController(),
    }),
  ).rejects.toThrow();
  expect(posted).toEqual(["Not delivered to the agent: x"]);
});
