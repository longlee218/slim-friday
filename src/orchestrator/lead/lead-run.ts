import { messageLanguage } from "../../ingress/user-copy";
import { relatedEpisodesBlock } from "../../memory/related-episodes";
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
import { announceBlock, capNews, pendingNews, settleLeadEvents } from "./lead-events";
import { failed, forgetBatch, rearm } from "./lead-failure";
import { createLeadIo } from "./lead-io";
import { ownerEventIds } from "./lead-owner-events";
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
    /** What woke the lead and, for an owner run, the owner's raw text (Orchestrate register_location's guard). */
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
          // Getter on the thread's NEWEST ctx: `Orchestrate register_location` and a second owner message replace the captured one.
          get locations() {
            return (rt.ctxOf(threadId) ?? ctx).locations.map((l) => l.name);
          },
        },
        io: createLeadIo(rt, ctx, threadId, turnId, ac.signal),
      });
      const language = messageLanguage(ctx.message);
      const toolCtx = {
        port,
        language,
        threadId,
        leadTurnId: turnId,
        inputId: o.inputId,
        run: { dispatched: 0 },
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
      const stored = getSession(db, threadId);
      // Owner messages only (not wake-ups): earlier episodes of this channel that match the text, as data. Lead only.
      const related =
        o.trigger === "owner" && o.ownerText
          ? relatedEpisodesBlock(db, {
              workspace: ctx.workspace,
              channel: ctx.channel,
              threadId,
              text: o.ownerText,
            })
          : "";
      return {
        input: {
          turnId,
          threadId,
          text: [related, buildLeadContextBlock(port.snapshot() ?? { items: [] }), o.text]
            .filter(Boolean)
            .join("\n\n"),
          role: "lead",
          workspace: ctx.workspace,
          channel: ctx.channel,
          channelMode: ctx.channelMode,
          channelId: ctx.channelId,
          locations: [], // neutral cwd: the lead routes, it reads no location
          ac,
          language,
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
 * One lead input end to end: run the lead, post the reply, close the consumed events and start the queued
 * workers. A failed run posts a fixed notice and
 * starts nothing; a failed announce is retried once, then dropped with one notice. Never throws.
 */
export async function runLead(rt: LeadRuntime, input: LeadInput): Promise<void> {
  const { threadId } = input;
  const ctx = rt.ctxOf(threadId);
  if (!ctx) {
    logEvent(log, "lead.no_context", { threadId, kind: input.kind }, "warn");
    // Nobody can answer: close the owner's events or the boot replay would try again at every start.
    if (input.kind === "owner")
      settleLeadEvents(rt.deps.db, threadId, [], ownerEventIds(input.messageIds));
    return;
  }
  const { db } = rt.deps;
  let posted = false; // the owner saw something from this run
  const post = (text: string) => {
    posted = true;
    return postTo(ctx, text).catch((err: unknown) =>
      logEvent(log, "lead.post_failed", { threadId, err: errText(err) }, "warn"),
    );
  };
  const ac = new AbortController();
  const settleActive = registerRun({ kind: "lead", threadId, role: "lead", ac });
  let announced: string[] = [];
  let consumed = false; // news counts as read only on success (a `max_budget` stop leaves it pending)
  let retry = false;
  let overflow = false; // the announce batch was capped: more news waits
  let stopped = false; // `/stop`: start nothing, re-arm nothing
  try {
    const news = input.kind === "announce" ? pendingNews(db, threadId) : [];
    if (input.kind === "announce" && !news.length) return; // nothing new (another run already read it)
    const batch = capNews(news);
    announced = [...batch.shown.map((e) => e.id), ...batch.coalesced];
    overflow = batch.more > 0;
    const inputId = crypto.randomUUID();
    const out = await leadOnce(rt, ctx, {
      threadId,
      inputId,
      text:
        input.kind === "announce"
          ? announceBlock(batch.shown, batch.more)
          : `${OWNER_MESSAGE_LABEL}\n${input.text ?? ""}`,
      ac,
      trigger: input.kind,
      ...(input.kind === "owner" && input.text && { ownerText: input.text }),
    });
    if (out.outcome === "aborted") {
      stopped = true;
      return; // `/stop`: the owner knows
    }
    if (out.outcome === "error") retry = await failed(post, input, announced);
    else if (out.reply.trim()) await post(out.reply);
    consumed = out.outcome === "success" || (out.outcome === "error" && !retry);
  } catch (err) {
    logEvent(log, "lead.run_crashed", { threadId, err: errText(err) }, "error");
    retry = await failed(post, input, announced);
    consumed = !retry;
  } finally {
    settleActive();
    const ownerIds = input.kind === "owner" ? ownerEventIds(input.messageIds) : [];
    settleLeadEvents(db, threadId, consumed ? announced : [], ownerIds);
    if (consumed) forgetBatch(announced);
    // Whatever the outcome, a dispatch the run committed has `ready` items nothing else would start (idempotent pass).
    if (!stopped)
      await dispatchReady(rt, threadId).catch((err: unknown) =>
        logEvent(log, "lead.dispatch_failed", { threadId, err: errText(err) }, "error"),
      );
    if (input.kind === "owner" && !posted) await ctx.message.visible?.().catch(() => {}); // no silent message
    // Re-announce: a failed batch, capped overflow, or news a limit stop left unread (bounded by `rearm`).
    if (
      !stopped &&
      (retry || (consumed && overflow) || (!consumed && announced.length && rearm(announced)))
    )
      rt.announce(threadId);
  }
}
