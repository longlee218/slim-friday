import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalGateway } from "../src/approvals/approval-types";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { type makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";
import { devLeadQuery, leadHarness, workersDone } from "./lead-harness";

/** What a dev worker run exposes to a test: its SDK options and the owner's reply of the start message (the lead's). */
export interface DevRun {
  /** SDK options of every worker run, in start order. */
  runs: any[];
  /** The lead's reply to the start message (a worker's own text is never posted). */
  reply: string | undefined;
}

/**
 * Send `text` through the real handler over a fake `query` (a fake lead dispatches it to the developer) and wait until the detached worker
 * ended. `probe` runs inside the worker (options alive: plugin dirs exist), before its result.
 */
export async function runDevWorker(
  env: { db: any; config: any },
  text: string,
  opts: { gw?: ApprovalGateway; probe?: (o: any) => Promise<void>; threadId?: string } = {},
): Promise<DevRun> {
  const runs: any[] = [];
  const inner = ((a: { options: any }) =>
    (async function* (): AsyncGenerator<SDKMessage> {
      const isWorker = Boolean(a.options?.mcpServers?.worker);
      if (isWorker) runs.push(a.options);
      if (isWorker) await opts.probe?.(a.options);
      yield resultMsg({ result: "done" });
    })()) as never;
  const queryFn = devLeadQuery(inner);
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: opts.gw ?? stubGateway(),
    limiter: createRunLimiter(10),
    queryFn,
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
  });
  const posts: string[] = [];
  const out = await handle({
    source: "discord",
    userId: "owner",
    threadId: opts.threadId ?? "t1",
    channelId: TEST_CHANNEL,
    messageId: `m-${crypto.randomUUID()}`,
    text,
    language: "en",
    notify: async (m: string) => void posts.push(m),
  });
  await workersDone(env.db);
  return { runs, reply: out ?? posts[0] };
}

/**
 * Start a worker of `role` through the lead (any role, e.g. the scout): the fake lead
 * dispatches it once, the worker runs `probe` with its options (alive: plugin dirs exist) and throws when `fail`.
 */
export async function runWorkerViaLead(
  env: ReturnType<typeof makeEnv>,
  role: string,
  opts: { probe?: (o: any) => Promise<void>; fail?: boolean } = {},
): Promise<any[]> {
  const runs: any[] = [];
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      runs.push(c.options);
      await opts.probe?.(c.options);
      if (opts.fail) throw new Error("boom");
      return "done";
    }
    if (c.prompt.includes("Owner message:")) {
      await c.tool("DispatchAgent", {
        strategy: "DIRECT",
        intent: "work",
        reason: "test",
        assignments: [{ key: "main", role, brief: "where is x?", dependsOn: [] }],
      });
    }
    return "ok";
  }, env);
  await h.send("where is x?");
  await workersDone(env.db);
  return runs;
}
