import { describe, expect, test } from "bun:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RunRecorder } from "../src/observability/record-run";
import { createSteerRegistry } from "../src/orchestrator/turns/steer-registry";
import { MAX_STEER_HOLDS } from "../src/runtime/run-input-channel";
import type { QueryFn } from "../src/runtime/run-stream";
import { consumeSteered } from "../src/runtime/steered-stream";
import { listRunMessages } from "../src/storage/run-message-store";
import { initMsg, makeEnv, resultMsg } from "./helpers";

/* Step 7 of the agent loop (Rev 11) with a fake CLI: echo tracking, the wait for an unread steer at `result`
   (bounded), the silence timer, the undelivered notice and the resume of a message that arrived after the input
   ended. The fake consumes the input iterable like the SDK does and echoes what it consumed. */

const TH = { threadId: "th" };
type Iter = AsyncIterator<{ message: { content: unknown } }>;

/** The CLI's echo of a consumed user message (`replay-user-messages`). */
const echo = (text: string) =>
  ({
    type: "user",
    isReplay: true,
    message: { role: "user", content: text },
  }) as unknown as SDKMessage;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `script` as the CLI of one stream; every call of the fake query is recorded in `calls`. */
function setup(
  scripts: ((it: Iter, text: string) => AsyncGenerator<SDKMessage>)[],
  o: { budget?: number } = {},
) {
  const env = makeEnv();
  const reg = createSteerRegistry(env.db);
  const calls: { first: string; options: Options }[] = [];
  const run: QueryFn = (a) =>
    (async function* () {
      const it = (a.prompt as AsyncIterable<never>)[Symbol.asyncIterator]() as Iter;
      const first = (await it.next()).value?.message.content as string;
      const n = calls.push({ first, options: a.options as Options }) - 1;
      yield* (scripts[n] ?? scripts.at(-1)!)(it, first);
    })();
  const go = (graceMs = 20) =>
    consumeSteered({
      run,
      first: "task prompt",
      options: { ...(o.budget !== undefined && { maxBudgetUsd: o.budget }) } as Options,
      recorder: new RunRecorder(env.db, "run-1", "t1", "m", env.paths.taskLog("t1")),
      ac: new AbortController(),
      timedOut: () => false,
      db: env.db,
      turnId: "t1",
      cwd: env.home,
      requireGit: false,
      hook: reg.hook("th"),
      runId: "run-1",
      graceMs,
    });
  return { env, reg, calls, go };
}

describe("step 7: keep the input open while a pushed steer was not echoed", () => {
  test("a steer pushed before `result` (not echoed yet): the stream waits for the next result, the steer is delivered, then the input ends", async () => {
    let ended: boolean | undefined;
    const s = setup([
      async function* (it) {
        yield initMsg;
        expect(s.reg.steer(TH, "late one").result).toBe("queued"); // after the last turn, before the result
        yield resultMsg({ result: "first answer" });
        const m = await it.next(); // the CLI keeps reading the open input
        expect(m.value?.message.content).toBe("late one");
        yield echo("late one");
        yield resultMsg({ result: "second answer" });
        ended = (await it.next()).done;
      },
    ]);
    const res = await s.go();
    expect(res.text).toBe("second answer"); // the last result is the run's
    expect(res.outcome).toBe("success");
    expect(ended).toBe(true); // everything echoed at the 2nd result: the input was closed
    expect(listRunMessages(s.env.db, "th")[0]).toMatchObject({
      kind: "steer",
      status: "delivered",
    });
    expect(s.reg.undeliveredNotice("th")).toBe("");
    expect(s.reg.canSteer("th")).toBe(false);
  });

  test("nothing pending at `result`: the input closes at once (no wait)", async () => {
    let ended: boolean | undefined;
    const s = setup([
      async function* (it) {
        yield initMsg;
        yield resultMsg();
        ended = (await it.next()).done;
      },
    ]);
    await s.go();
    expect(ended).toBe(true);
  });

  test("bound: MAX_STEER_HOLDS results are waited for, the next one closes; the unread steer is dropped and the owner is told", async () => {
    expect(MAX_STEER_HOLDS).toBe(2);
    let resultsSent = 0;
    let closedAfter = -1;
    const s = setup([
      async function* (it) {
        yield initMsg;
        s.reg.steer(TH, "never echoed").result;
        yield resultMsg({ result: "r1" }); // held (1)
        await it.next(); // pulls the steer; the CLI never echoes it
        const open = it.next(); // blocks while the input is open
        void open.then(() => {
          closedAfter = resultsSent;
        });
        resultsSent = 2;
        yield resultMsg({ result: "r2" }); // held (2)
        resultsSent = 3;
        yield resultMsg({ result: "r3" }); // bound reached: closes
        await open;
      },
    ]);
    const res = await s.go();
    expect(closedAfter).toBe(3); // not at result 1 or 2
    expect(res.text).toBe("r3");
    expect(listRunMessages(s.env.db, "th")[0]).toMatchObject({ status: "dropped" });
    const notice = s.reg.undeliveredNotice("th");
    expect(notice).toContain("Not delivered");
    expect(notice).toContain("never echoed");
    expect(s.reg.undeliveredNotice("th")).toBe(""); // told once
  });

  test("silence: a held result whose echo never comes does not hang the run (the input ends after the grace time)", async () => {
    let ended: boolean | undefined;
    const s = setup([
      async function* (it) {
        yield initMsg;
        s.reg.steer(TH, "lost echo").result;
        yield resultMsg({ result: "only result" });
        await it.next(); // the steer
        ended = (await it.next()).done; // nothing more is said: the grace timer ends the input
      },
    ]);
    const t0 = Date.now();
    const res = await s.go(30);
    expect(ended).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.text).toBe("only result");
    expect(listRunMessages(s.env.db, "th")[0]?.status).toBe("dropped");
  });

  test("a message that arrives after the input ended resumes the SAME session (once), cost is not double counted", async () => {
    const s = setup([
      async function* () {
        yield initMsg;
        yield resultMsg({ result: "done 1", session_id: "sess-A" }); // nothing pending: input closes
        expect(s.reg.steer(TH, "after the end").result).toBe("queued"); // the stream is still open: kept as late
      },
      async function* (_it, first) {
        yield { ...(initMsg as object), session_id: "sess-A" } as SDKMessage;
        expect(first).toBe("after the end");
        expect(s.reg.canSteer("th")).toBe(true); // the resumed round takes steers too
        yield resultMsg({ result: "done 2", session_id: "sess-A" });
      },
    ]);
    const res = await s.go();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.options.resume).toBe("sess-A");
    expect(res.text).toBe("done 2");
    // cost is cumulative per the SDK (a resumed session continues from the saved total): the larger one, not a sum
    expect(res.usage.costUsd).toBeCloseTo(0.0012, 6);
    expect(res.usage.turns).toBe(4); // turns are per result (the fake reports 2 each): summed
    expect(listRunMessages(s.env.db, "th")[0]).toMatchObject({
      kind: "steer",
      status: "delivered",
    });
    expect(s.reg.undeliveredNotice("th")).toBe("");
    expect(s.reg.canSteer("th")).toBe(false);
  });

  test("M-f: late messages are delivered only once the resumed run succeeded; a failed resume tells the owner", async () => {
    const s = setup([
      async function* () {
        yield initMsg;
        yield resultMsg({ result: "done 1", session_id: "sess-A" });
        s.reg.steer(TH, "after the end");
      },
      async function* () {
        yield { ...(initMsg as object), session_id: "sess-A" } as SDKMessage;
        // while the resumed run works the row is NOT delivered yet
        expect(listRunMessages(s.env.db, "th")[0]?.status).toBe("pending");
        yield resultMsg({ subtype: "error_during_execution", is_error: true, errors: ["boom"] });
      },
    ]);
    await s.go();
    expect(s.calls).toHaveLength(2);
    expect(listRunMessages(s.env.db, "th")[0]?.status).toBe("dropped");
    expect(s.reg.undeliveredNotice("th")).toContain("after the end");
  });

  test("a late resume happens once: a message that arrives during the resumed round is not resumed again, the owner is told", async () => {
    const s = setup([
      async function* () {
        yield initMsg;
        yield resultMsg({ result: "done 1", session_id: "sess-A" });
        s.reg.steer(TH, "late one");
      },
      async function* () {
        yield { ...(initMsg as object), session_id: "sess-A" } as SDKMessage;
        yield resultMsg({ result: "done 2", session_id: "sess-A" });
        s.reg.steer(TH, "late two"); // arrives after the resumed round's input ended too
      },
    ]);
    await s.go();
    expect(s.calls).toHaveLength(2); // MAX_LATE_RESUMES = 1: no third round
    expect(listRunMessages(s.env.db, "th").map((r) => r.status)).toEqual(["delivered", "dropped"]);
    expect(s.reg.undeliveredNotice("th")).toContain("late two");
  });

  test("the silence timer is re-armed by a stream message: a CLI that talks and then stops does not hang the run", async () => {
    let ended: boolean | undefined;
    const s = setup([
      async function* (it) {
        yield initMsg;
        s.reg.steer(TH, "x");
        yield resultMsg({ result: "r1" }); // held: the timer runs
        await it.next(); // the steer
        await sleep(15);
        yield { type: "system", subtype: "status" } as unknown as SDKMessage; // any message cleared the old timer
        ended = (await it.next()).done; // then silence: the re-armed timer must end the input
      },
    ]);
    await s.go(40);
    expect(ended).toBe(true);
  });

  test("M-g usage over several results: cost is cumulative (the last), turns / tokens / duration are per result (summed)", async () => {
    const s = setup([
      async function* () {
        yield initMsg;
        yield resultMsg({ result: "r1", total_cost_usd: 0.01, num_turns: 1, duration_ms: 100 });
        yield resultMsg({ result: "r2", total_cost_usd: 0.03, num_turns: 1, duration_ms: 200 });
      },
    ]);
    const res = await s.go();
    expect(res.usage).toMatchObject({
      costUsd: 0.03,
      turns: 2,
      durationMs: 300,
      inputTokens: 20,
      outputTokens: 40,
    });
  });

  test("late message but no budget left (or the run did not succeed): no resume, the owner is told", async () => {
    const s = setup(
      [
        async function* () {
          yield initMsg;
          yield resultMsg({ result: "done", total_cost_usd: 0.01 });
          s.reg.steer(TH, "too late for the budget").result;
        },
      ],
      { budget: 0.005 }, // already spent (the fake reports 0.01)
    );
    const res = await s.go();
    expect(s.calls).toHaveLength(1);
    expect(res.text).toBe("done");
    expect(s.reg.undeliveredNotice("th")).toContain("too late for the budget");
    expect(listRunMessages(s.env.db, "th")[0]?.status).toBe("dropped");
  });

  test("a stop (abort) drops the queued steers at once: nothing is delivered, no resume", async () => {
    const ac = new AbortController();
    const env = makeEnv();
    const reg = createSteerRegistry(env.db);
    const pulled: string[] = [];
    const run: QueryFn = (a) =>
      (async function* () {
        const it = (a.prompt as AsyncIterable<never>)[Symbol.asyncIterator]() as Iter;
        pulled.push((await it.next()).value?.message.content as string);
        yield initMsg;
        reg.steer(TH, "queued then stopped").result;
        ac.abort();
        expect((await it.next()).done).toBe(true);
        await sleep(1);
        throw new Error("process aborted");
      })();
    const res = await consumeSteered({
      run,
      first: "task prompt",
      options: {} as Options,
      recorder: new RunRecorder(env.db, "run-1", "t1", "m", env.paths.taskLog("t1")),
      ac,
      timedOut: () => false,
      db: env.db,
      turnId: "t1",
      cwd: env.home,
      requireGit: false,
      hook: reg.hook("th"),
      runId: "run-1",
    });
    expect(res.outcome).toBe("aborted");
    expect(pulled).toEqual(["task prompt"]);
    expect(listRunMessages(env.db, "th")[0]?.status).toBe("dropped");
  });
});
