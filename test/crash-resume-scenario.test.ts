import { expect, test } from "bun:test";
import { runOfTask } from "../src/orchestrator/run/live-runs";
import { recoverInFlight } from "../src/orchestrator/worker/recover-in-flight";
import { RESUME_PROMPT } from "../src/orchestrator/worker/resume-prompt";
import { appendEffect } from "../src/storage/effect-log-store";
import { getItem } from "../src/storage/owned-item-store";
import { recordBotThread } from "../src/storage/thread-store";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { type Call, leadHarness, until } from "./lead-harness";
import { isWorkerRun } from "./mcp-run-probe";

/* Crash-resume scenario: a developer worker records its session and one effect row, then the process "crashes" (the handler is
   dropped without a drain, the run hangs forever). Boot recovery + a new handler + wake must resume the SAME session with
   the resume prompt and the effect list, finish the item, and never ask the owner. The fake `query` supports resume: a run with
   `options.resume` gets that session back. */

const EFFECT_TOOL = "GitPush";

/** Sessions: a resumed run keeps its session, a fresh run gets a new one (`worker-<iter>` for the worker's first run). */
const sessionOf = (iter: number) => (options: any, n: number) =>
  options?.resume ?? (isWorkerRun(options) ? `worker-${iter}` : `lead-${iter}-${n}`);

/** One crash scenario: `crashes` crashes of the worker, then a final handler that lets it finish. */
async function crashScenario(iter: number, crashes: number) {
  const env = makeEnv();
  const thread = `th-${iter}-${crashes}`;
  recordBotThread(env.db, thread, TEST_CHANNEL, "main", "⏳ 10-15 10:00");
  const itemId = () =>
    (
      env.db.query("SELECT id FROM owned_tasks WHERE parent_id IS NOT NULL").get() as {
        id: string;
      } | null
    )?.id;
  const workerCalls: Call[] = [];
  const harnesses: ReturnType<typeof leadHarness>[] = [];
  let hung = 0;
  /** Releases of the hung (crashed) runs: at the end they settle, so no dead run stays in the global live-run registry. */
  const release: (() => void)[] = [];
  /** A handler over the shared db: its worker hangs (crash) or finishes. */
  const phase = (hang: boolean) => {
    const h = leadHarness(
      async (c) => {
        if (c.kind === "worker") {
          workerCalls.push(c);
          const first = !c.prompt.includes(RESUME_PROMPT);
          // The effect row is written once: a resumed run sees it in its prompt and does not repeat the step.
          if (first)
            appendEffect(env.db, {
              id: `fx-${iter}-${crashes}`,
              threadId: thread,
              itemId: itemId() as string,
              tool: EFFECT_TOOL,
              scope: "repo main",
              grantedBy: "plan",
              result: "pushed",
            });
          if (hang) {
            hung++;
            await new Promise<void>((r) => release.push(r)); // the process dies here (until the test ends)
            return "late";
          }
          await c.report("result", { title: "T", status: "COMPLETED", summary: "done" });
          return "worker done";
        }
        if (c.prompt.includes("Owner message:")) {
          await c.orchestrate("dispatch", {
            strategy: "DIRECT",
            intent: "work",
            reason: "one specialist",
            assignments: [
              { key: "main", subject: "task", role: "developer", brief: "do it", dependsOn: [] },
            ],
          });
          return "On it.";
        }
        return ""; // announce runs say nothing to the owner
      },
      env,
      {},
      sessionOf(iter),
    );
    harnesses.push(h);
    return h;
  };
  let h = phase(crashes > 0);
  await h.send("do it", thread);
  await until(() => h.posts.length > 0, 8000); // the lead's start reply
  if (crashes > 0) await until(() => hung === 1, 8000);
  for (let c = 1; c <= crashes; c++) {
    const report = recoverInFlight(env.db); // boot after the crash
    const last = c === crashes;
    h = phase(!last);
    h.handle.wake(report);
    if (!last) await until(() => hung === c + 1, 8000);
    else if (crashes <= 2)
      await until(() => getItem(env.db, itemId() as string)?.status === "completed", 8000);
    else await until(() => getItem(env.db, itemId() as string)?.status === "blocked", 8000);
  }
  await new Promise((r) => setTimeout(r, 150)); // let any announce run finish
  // The "dead" runs end now: their closing finds the item already moved on and changes nothing.
  for (const r of release) r();
  await until(() => !runOfTask(itemId() as string), 8000); // this item's dead runs are gone from the registry
  return {
    env,
    item: () => getItem(env.db, itemId() as string)!,
    workerCalls,
    posts: harnesses.flatMap((x) => x.posts),
    itemId: itemId() as string,
  };
}

test("crash x10: every item resumes its own session with the resume prompt + effect list and finishes, 0 owner prompts", async () => {
  let finished = 0;
  for (let i = 0; i < 10; i++) {
    const s = await crashScenario(i, 1);
    expect(s.workerCalls).toHaveLength(2);
    const [first, resumed] = s.workerCalls as [Call, Call];
    expect(first.options.resume).toBeUndefined();
    expect(resumed.options.resume).toBe(`worker-${i}`); // the first run's session
    expect(resumed.prompt).toContain(RESUME_PROMPT);
    expect(resumed.prompt).toContain(`- ${EFFECT_TOOL} repo main: pushed`);
    // No owner prompt but the lead's own start reply, no duplicate effect row.
    expect(s.posts).toEqual(["On it."]);
    expect(
      (
        s.env.db
          .query("SELECT COUNT(*) AS n FROM effect_log WHERE tool = ?")
          .get(EFFECT_TOOL) as any
      ).n,
    ).toBe(1);
    // An automatic resume is not a new dispatch (the breaker counts the first start only).
    expect(s.item()).toMatchObject({ status: "completed", attempt: 1, dispatchCount: 1 });
    if (s.item().status === "completed") finished++;
  }
  expect(finished).toBe(10);
}, 120_000);

test("two crashes in a row still resume; the third crash holds the item (cap 2) for the lead", async () => {
  const two = await crashScenario(100, 2);
  expect(two.item()).toMatchObject({ status: "completed", attempt: 2 });
  expect(two.workerCalls).toHaveLength(3);
  const three = await crashScenario(101, 3);
  expect(three.item()).toMatchObject({ status: "blocked", resultKind: "FAILED", attempt: 2 });
  expect(three.workerCalls).toHaveLength(3); // no 4th run
  const failure = three.env.db
    .query("SELECT payload FROM thread_events WHERE kind = 'failure'")
    .get() as { payload: string };
  expect(JSON.parse(failure.payload)).toMatchObject({ class: "real", cause: "resume_cap:crash" });
}, 60_000);
