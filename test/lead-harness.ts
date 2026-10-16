import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DISPATCH_AGENT_TOOL } from "../src/mcp/orchestration/tools/DispatchAgentTool/constants";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import type { ApprovalGateway } from "../src/owner-approval/approval-types";
import { OWNER_MESSAGE_LABEL } from "../src/roles/prompts/first-prompt-prefix";
import { initMsg, makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";
import { isLeadRun, isPlannerRun, isWorkerRun, toolOf } from "./mcp-run-probe";

/* Harness of the lead tests: the real handler, queue, lead runner and dispatch-ready over a fake `query` that plays the
   lead model and the workers. The fake calls the real MCP tool handlers of the run (the same code the SDK would call). */

/** One model call as the fake sees it. */
export interface Call {
  kind: "lead" | "worker" | "planner" | "other";
  prompt: string;
  options: any;
  /** Call a tool of the run's lead / worker server; returns the parsed JSON reply. */
  tool: (name: string, args: object) => Promise<any>;
}

/** What the script returns: the final text of the run and an optional cost. */
export type Script = (c: Call) => Promise<string | { text: string; cost?: number }> | string;

/** Sleep helper. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds (or fail after `ms`). */
export async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (let t = 0; t < ms; t += 20) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error("condition not reached in time");
}

/** Prompt text of a query (string or the first streamed item). */
async function promptOf(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const first = await (prompt as AsyncIterable<{ message: { content: string } }>)
    [Symbol.asyncIterator]()
    .next();
  return first.value?.message.content ?? "";
}

/** A fake `query` that plays the lead model and the workers from `script`; every model call is recorded in `calls`. */
export function scriptedQuery(script: Script, calls: Call[]) {
  return ((a: { prompt: unknown; options: any }) =>
    (async function* (): AsyncGenerator<SDKMessage> {
      const kind: Call["kind"] = isLeadRun(a.options)
        ? "lead"
        : isPlannerRun(a.options)
          ? "planner"
          : isWorkerRun(a.options)
            ? "worker"
            : "other";
      const call: Call = {
        kind,
        prompt: await promptOf(a.prompt),
        options: a.options,
        tool: async (name, args) => {
          // The tool lives on whichever server of the run holds it (orchestration, plan, effects).
          const r = await toolOf(a.options, name)!.handler(args, {});
          return JSON.parse(r.content[0].text);
        },
      };
      calls.push(call);
      yield initMsg;
      const out = await script(call);
      const o = typeof out === "string" ? { text: out } : out;
      yield resultMsg({
        result: o.text,
        session_id: `sess-${kind}-${calls.length}`,
        total_cost_usd: o.cost ?? 0.001,
      });
    })()) as never;
}

/** Fixed lead reply of `devLeadQuery` (the owner sees it as the start notice of the worker). */
const DEV_START_NOTICE = "I’m starting on your request.";

/**
 * Wrap a fake `query` for tests that need a developer worker to start from a plain owner message: a lead run (the run
 * holding the lead tools) dispatches the message text to the developer through the real `DispatchAgent` tool (an optional
 * leading `location:<name>` becomes the assignment's location; an open goal is superseded) and replies `DEV_START_NOTICE`; an announce run just
 * replies; every other run (the worker) goes to `inner`.
 */
export function devLeadQuery(inner: unknown) {
  return ((a: { prompt: unknown; options: any }) => {
    const dispatchTool = toolOf(a.options, DISPATCH_AGENT_TOOL);
    if (!dispatchTool) return (inner as (a: unknown) => AsyncIterable<SDKMessage>)(a);
    return (async function* (): AsyncGenerator<SDKMessage> {
      const prompt = await promptOf(a.prompt);
      const at = prompt.lastIndexOf(`${OWNER_MESSAGE_LABEL}\n`);
      if (at >= 0) {
        let brief = prompt.slice(at + OWNER_MESSAGE_LABEL.length + 1).trim();
        const pin = /^location:(\S+)\s*/.exec(brief);
        if (pin) brief = brief.slice(pin[0].length);
        const dispatch = async (supersedes?: string) =>
          JSON.parse(
            (
              await dispatchTool.handler(
                {
                  strategy: "DIRECT",
                  intent: "work",
                  reason: "test",
                  ...(supersedes && { supersedes }),
                  assignments: [
                    { key: "main", role: "developer", brief, location: pin?.[1], dependsOn: [] },
                  ],
                },
                {},
              )
            ).content[0].text,
          );
        const first = await dispatch();
        // An open goal of the thread is replaced, like the owner starting new work.
        const open = first.code === "GOAL_OPEN" && /Goal (\S+) is open/.exec(first.message);
        if (open) await dispatch(open[1]);
      }
      yield resultMsg({ result: DEV_START_NOTICE, session_id: undefined }); // no lead session is stored
    })();
  }) as never;
}

/** Build the handler and a fake query driven by `script`. */
export function leadHarness(
  script: Script,
  env = makeEnv(),
  approvals: Partial<ApprovalGateway> = {},
) {
  const calls: Call[] = [];
  const posts: string[] = [];
  const queryFn = scriptedQuery(script, calls);
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(approvals),
    limiter: createRunLimiter(10),
    queryFn,
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
    // Boot wakes post by thread id (no owner message to answer through): same sink as the owner's replies.
    post: async (_threadId, text) => void posts.push(text),
  });
  /** Send an owner message; the lead (not the handler) posts the reply. */
  const send = async (text: string, threadId = "t1") => {
    const out = await handle({
      source: "discord",
      userId: "owner",
      threadId,
      channelId: TEST_CHANNEL,
      messageId: `m-${crypto.randomUUID()}`,
      text,
      language: "en",
      notify: async (m: string) => void posts.push(m),
    });
    return out;
  };
  const ofKind = (k: Call["kind"]) => calls.filter((c) => c.kind === k);
  return { env, handle, send, calls, posts, ofKind };
}

/** A `notify` sink for a message sent straight to `handle`: `first()` waits for the first thing the app posted (the start notice of a dispatch). */
export function noticeSink() {
  const posts: string[] = [];
  return {
    posts,
    notify: async (m: string) => void posts.push(m),
    first: async (ms = 4000): Promise<string> => {
      await until(() => posts.length > 0, ms);
      return posts[0] as string;
    },
  };
}

/** Wait until at least one worker task turn exists and no turn is running any more (a detached worker has finished). */
export async function workersDone(db: import("bun:sqlite").Database, ms = 8000): Promise<void> {
  const n = (sql: string) => (db.query(sql).get() as { n: number }).n;
  await until(
    () =>
      n("SELECT COUNT(*) AS n FROM turns WHERE role != 'lead'") > 0 &&
      n(
        "SELECT COUNT(*) AS n FROM turns WHERE role != 'lead' AND status IN ('running','waiting_approval')",
      ) === 0,
    ms,
  );
}
