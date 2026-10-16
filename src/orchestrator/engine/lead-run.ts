import { messageLanguage } from "../../ingress/user-copy";
import { logEvent, logger, setLogContext } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { dispatchableWorkers, getRole } from "../../roles/role-registry";
import { getSession } from "../../storage/session-store";
import { registerRun } from "../run/live-runs";
import { buildLeadContextBlock } from "../strategy/lead-context-block";
import { buildLeadMd } from "../strategy/lead-md";
import { closeTurn } from "../turns/turn-result";
import { beginTurn, failTurn } from "../turns/turn-tracker";
import { dispatchReady } from "./dispatch-ready";
import { createDbEffectPort } from "./effect-port-db";
import { OWNER_MESSAGE_LABEL } from "./first-prompt-prefix";
import { LEAD_BUDGET_NOTICE, LEAD_FAILED_NOTICE, leadOverBudget } from "./lead-budget";
import { announceBlock, pendingNews, settleLeadEvents } from "./lead-events";
import { createLeadIo } from "./lead-io";
import type { LeadInput } from "./lead-queue";
import { type LeadRuntime, type LeadThreadCtx, postTo } from "./lead-runtime";
import { runRole } from "./run-role";

/** Logger of this module. */
const log = logger.child({ module: "lead-run" });

/** What one lead model run gives back. */
interface LeadOnce {
  /** Turn row of the run. */
  turnId: string;
  reply: string;
  outcome: string;
}

/** Run the lead model once on `text`: one turn row, the lead's tools over a fresh port, the session stored as the lead's. */
async function leadOnce(
  rt: LeadRuntime,
  ctx: LeadThreadCtx,
  o: { threadId: string; inputId: string; text: string; ac: AbortController },
): Promise<LeadOnce> {
  const { deps } = rt;
  const { db } = deps;
  const { threadId } = o;
  const turnId = crypto.randomUUID();
  setLogContext({ taskId: turnId, mode: "lead" });
  beginTurn(
    db,
    log,
    { turnId, threadId, source: ctx.message.source },
    { location: "*", role: "lead", brief: o.text },
  );
  const port = createDbEffectPort({
    db,
    threadId,
    env: {
      workerRoles: dispatchableWorkers().map((r) => r.name),
      locations: ctx.locations.map((l) => l.name),
    },
    io: createLeadIo(rt, ctx, threadId, turnId, o.ac.signal),
  });
  const toolCtx = {
    port,
    threadId,
    leadTurnId: turnId,
    inputId: o.inputId,
    run: { dispatched: 0 },
  };
  const role = getRole("lead");
  const language = messageLanguage(ctx.message);
  const stored = getSession(db, threadId);
  const t0 = Date.now();
  try {
    const res = await runRole(deps, {
      turnId,
      threadId,
      text: `${buildLeadContextBlock(port.snapshot() ?? { items: [] })}\n\n${o.text}`,
      role: "lead",
      workspace: ctx.workspace,
      channel: ctx.channel,
      channelMode: ctx.channelMode,
      channelId: ctx.channelId,
      locations: [], // neutral cwd: the lead routes, it reads no location
      ac: o.ac,
      language,
      recent: ctx.message.recent, // seeds a fresh session after a rollover
      existing: stored?.kind === "lead" ? stored : null,
      extraSystem: [buildLeadMd()],
      appCtx: () => ({ lead: toolCtx }),
    });
    const reply = closeTurn(
      db,
      { turnId, threadId },
      { ...res, sessionKind: "lead", model: res.model ?? role.model },
      { language, stopping: deps.stopping(), t0, location: "*" },
    );
    return { turnId, reply, outcome: res.outcome };
  } catch (err) {
    failTurn(db, log, turnId);
    throw err;
  }
}

/** Failed runs allowed per announce batch (key = its event ids): past it the news is dropped and the owner told once. */
const ANNOUNCE_ATTEMPTS = 2;
const failedBatches = new Map<string, number>();

/**
 * One lead input end to end: wait for the thread's rollover, budget guard, the lead run, post the reply, close the
 * events it consumed, start the workers it queued, then let the rollover start (after the reply, never before). A failed run posts a fixed notice and starts nothing; a failed announce is retried once, then dropped with
 * one notice. Never throws (the queue logs a throw, but a post must not hide it).
 */
export async function runLead(rt: LeadRuntime, input: LeadInput): Promise<void> {
  const { threadId } = input;
  const ctx = rt.ctxOf(threadId);
  if (!ctx) {
    logEvent(log, "lead.no_context", { threadId, kind: input.kind }, "warn");
    return;
  }
  const { db } = rt.deps;
  await rt.hold?.(threadId); // a rollover of the previous run flushes / deletes the session: never resume it meanwhile
  let posted = false; // the owner saw something from this run
  const post = (text: string) => {
    posted = true;
    return postTo(ctx, text).catch((err: unknown) =>
      logEvent(log, "lead.post_failed", { threadId, err: errText(err) }, "warn"),
    );
  };
  const turns: string[] = []; // turn rows of this input: their rollover starts after the reply
  const ac = new AbortController();
  const settleActive = registerRun({ kind: "lead", threadId, role: "lead", ac });
  let announced: string[] = [];
  let consumed = false; // the news counts as read only when the lead run succeeded
  let retry = false;
  try {
    const news = input.kind === "announce" ? pendingNews(db, threadId) : [];
    if (input.kind === "announce" && !news.length) return; // nothing new (another run already read it)
    announced = news.map((e) => e.id);
    if (leadOverBudget(db, threadId)) {
      logEvent(log, "lead.budget_exceeded", { threadId, kind: input.kind }, "warn");
      await post(LEAD_BUDGET_NOTICE);
      consumed = true;
      return; // no model run, no dispatch
    }
    const inputId = crypto.randomUUID();
    const text =
      input.kind === "announce"
        ? announceBlock(news)
        : `${OWNER_MESSAGE_LABEL}\n${input.text ?? ""}`;
    const out = await leadOnce(rt, ctx, { threadId, inputId, text, ac });
    turns.push(out.turnId);
    if (out.outcome === "aborted") return; // `/stop`: the owner knows
    if (out.outcome === "error") retry = await failed(post, input, announced);
    else if (out.reply.trim()) await post(out.reply);
    consumed = out.outcome === "success" || (out.outcome === "error" && !retry);
    if (out.outcome === "success") await dispatchReady(rt, threadId);
  } catch (err) {
    logEvent(log, "lead.run_crashed", { threadId, err: errText(err) }, "error");
    retry = await failed(post, input, announced);
    consumed = !retry;
  } finally {
    settleActive();
    settleLeadEvents(db, threadId, consumed ? announced : []);
    if (consumed) failedBatches.delete(announced.join(","));
    for (const turnId of turns) rt.afterRun?.(ctx.message, turnId, ctx.workspace); // only now: the reply is out
    if (input.kind === "owner" && !posted) await ctx.message.visible?.().catch(() => {}); // no silent message
    if (retry) rt.announce(threadId);
  }
}

/** A lead run failed: an owner input gets the notice at once; an announce batch is retried (true) until the cap, then the notice once (false). */
async function failed(
  post: (text: string) => Promise<void>,
  input: LeadInput,
  announced: string[],
): Promise<boolean> {
  if (input.kind === "announce") {
    const key = announced.join(",");
    const n = (failedBatches.get(key) ?? 0) + 1;
    if (n < ANNOUNCE_ATTEMPTS) {
      failedBatches.set(key, n);
      return true;
    }
  }
  await post(LEAD_FAILED_NOTICE);
  return false;
}
