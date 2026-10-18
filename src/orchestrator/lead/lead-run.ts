import { messageLanguage } from "../../ingress/user-copy";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { OWNER_MESSAGE_LABEL } from "../../roles/prompts/first-prompt-prefix";
import { buildTeamMd } from "../../roles/prompts/team-md";
import { dispatchableWorkers, getRole } from "../../roles/role-registry";
import { getSession } from "../../storage/session-store";
import { createDbEffectPort } from "../goal/effect-port-db";
import { registerRun } from "../run/live-runs";
import { type LeadTurnResult, runTurn } from "../run/run-turn";
import { buildLeadContextBlock } from "../strategy/lead-context-block";
import { dispatchReady } from "../worker/dispatch-ready";
import { announceBlock, pendingNews, settleLeadEvents } from "./lead-events";
import { failed, forgetBatch } from "./lead-failure";
import { createLeadIo } from "./lead-io";
import type { LeadInput } from "./lead-queue";
import { type LeadRuntime, type LeadThreadCtx, postTo } from "./lead-runtime";
import { artifactCtx } from "./thread-tool-ctx";

/** Logger of this module. */
const log = logger.child({ module: "lead-run" });

/** Run the lead model once on `text`: one turn row, the lead's tools over a fresh port, the session stored as the lead's. */
function leadOnce(
  rt: LeadRuntime,
  ctx: LeadThreadCtx,
  o: {
    threadId: string;
    inputId: string;
    text: string;
    ac: AbortController;
    /** What woke the lead and, for an owner run, the owner's raw text (RegisterLocation's guard). */
    trigger: "owner" | "announce";
    ownerText?: string;
  },
): Promise<LeadTurnResult> {
  const { deps } = rt;
  const { db } = deps;
  const { threadId, ac } = o;
  const turnId = crypto.randomUUID();
  return runTurn("lead", deps, {
    begin: {
      log,
      context: { taskId: turnId, mode: "lead" },
      ids: { turnId, threadId, source: ctx.message.source },
      turn: { location: "*", role: "lead", brief: o.text },
    },
    // Built after the turn row exists: tools over a fresh port, the stored session, the run input.
    build: () => {
      const port = createDbEffectPort({
        db,
        threadId,
        env: {
          workerRoles: dispatchableWorkers().map((r) => r.name),
          // Getter on the thread's NEWEST ctx: `RegisterLocation` and a second owner message replace the captured one.
          get locations() {
            return (rt.ctxOf(threadId) ?? ctx).locations.map((l) => l.name);
          },
        },
        io: createLeadIo(rt, ctx, threadId, turnId, ac.signal),
      });
      const toolCtx = {
        port,
        threadId,
        leadTurnId: turnId,
        inputId: o.inputId,
        run: { dispatched: 0, registered: 0 },
        place: {
          home: deps.config.agentHome,
          workspace: ctx.workspace,
          channel: ctx.channel,
          channelId: ctx.channelId,
          trigger: o.trigger,
          ...(o.ownerText && { ownerText: o.ownerText }),
          refresh: () => rt.refresh(threadId),
        },
      };
      const model = getRole("lead").model;
      const language = messageLanguage(ctx.message);
      const stored = getSession(db, threadId);
      return {
        input: {
          turnId,
          threadId,
          text: `${buildLeadContextBlock(port.snapshot() ?? { items: [] })}\n\n${o.text}`,
          role: "lead",
          workspace: ctx.workspace,
          channel: ctx.channel,
          channelMode: ctx.channelMode,
          channelId: ctx.channelId,
          locations: [], // neutral cwd: the lead routes, it reads no location
          ac,
          language,
          recent: ctx.message.recent, // seeds a fresh session after a rollover
          existing: stored?.kind === "lead" ? stored : null,
          team: buildTeamMd({ locations: ctx.locations }),
          appCtx: () => ({
            lead: toolCtx,
            artifacts: artifactCtx(rt, ctx, threadId, "lead"), // the lead reads and saves in its own channel
          }),
        },
        close: (res, t0) => ({
          res: { ...res, sessionKind: "lead", model: res.model ?? model },
          opts: { language, stopping: deps.stopping(), t0, location: "*" },
        }),
      };
    },
  });
}

/**
 * One lead input end to end: wait for the thread's rollover, run the lead, post the reply, close the consumed events,
 * start the queued workers, then let the rollover start (after the reply). A failed run posts a fixed notice and
 * starts nothing; a failed announce is retried once, then dropped with one notice. Never throws.
 */
export async function runLead(rt: LeadRuntime, input: LeadInput): Promise<void> {
  const { threadId } = input;
  const ctx = rt.ctxOf(threadId);
  if (!ctx) {
    logEvent(log, "lead.no_context", { threadId, kind: input.kind }, "warn");
    return;
  }
  const { db } = rt.deps;
  await rt.hold?.(threadId); // a rollover of the previous run may delete the session: never resume it meanwhile
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
  let consumed = false; // news counts as read only on success (a `max_budget` stop leaves it pending)
  let retry = false;
  try {
    const news = input.kind === "announce" ? pendingNews(db, threadId) : [];
    if (input.kind === "announce" && !news.length) return; // nothing new (another run already read it)
    announced = news.map((e) => e.id);
    const inputId = crypto.randomUUID();
    const out = await leadOnce(rt, ctx, {
      threadId,
      inputId,
      text:
        input.kind === "announce"
          ? announceBlock(news)
          : `${OWNER_MESSAGE_LABEL}\n${input.text ?? ""}`,
      ac,
      trigger: input.kind,
      ...(input.kind === "owner" && input.text && { ownerText: input.text }),
    });
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
    if (consumed) forgetBatch(announced);
    for (const turnId of turns) rt.afterRun?.(ctx.message, turnId, ctx.workspace); // only now: the reply is out
    if (input.kind === "owner" && !posted) await ctx.message.visible?.().catch(() => {}); // no silent message
    if (retry) rt.announce(threadId);
  }
}
