import {
  TEAMMATE_OWNER_RUN_BUDGET_USD,
  TEAMMATE_OWNER_RUN_MAX_TURNS,
} from "../../config/teammate-caps";
import { workspacePaths } from "../../config/workspace-paths";
import { messageLanguage } from "../../ingress/user-copy";
import type { AppCtx } from "../../mcp/manifest-types";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { realOrSame } from "../../policy/paths";
import { buildTeamMd } from "../../roles/prompts/team-md";
import { titlePortFor } from "../../roles/prompts/thread-title-note";
import { dispatchableWorkers } from "../../roles/role-registry";
import { getSession } from "../../storage/session-store";
import { resolveTeammate, type TeammateResolution } from "../../teammates/resolve-teammate";
import { policyOf } from "../../tools/role-policy";
import { createDbEffectPort } from "../goal/effect-port-db";
import { planSideEffects } from "../plan/plan-side-effects";
import { registerRun } from "../run/live-runs";
import { runTurn, type TeammateTurnResult } from "../run/run-turn";
import { dispatchReady } from "../worker/dispatch-ready";
import { teammateEffectsCtx } from "./teammate-effects-ctx";
import {
  announceBlock,
  capNews,
  peerHopOf,
  pendingNews,
  settleTeammateEvents,
} from "./teammate-events";
import { failed, forgetBatch, rearm } from "./teammate-failure";
import { createTeammateIo } from "./teammate-io";
import { markTeammateMemorySent, type TeammateMemoryTurn } from "./teammate-memory";
import { ownerEventIds } from "./teammate-owner-events";
import type { TeammateInput } from "./teammate-queue";
import { postTo, type TeammateRuntime, type TeammateThreadCtx } from "./teammate-runtime";
import { buildTeammateUserTurn, ownerMessageBlock } from "./teammate-user-turn";
import { artifactCtx, locationRefs } from "./thread-tool-ctx";

/** Logger of this module. */
const log = logger.child({ module: "teammate-run" });

/**
 * Run the teammate model once on `text` (the `<events>` or `<owner_message>` block): one turn row, the teammate's tools over a
 * fresh port, the session stored as the teammate's. The user turn carries the per-turn data (memory when changed, goal
 * state, title note); a memory block counts as seen by the session only when the run saved it.
 */
function teammateOnce(
  rt: TeammateRuntime,
  ctx: TeammateThreadCtx,
  o: {
    threadId: string;
    inputId: string;
    text: string;
    ac: AbortController;
    /** What woke the teammate and, for an owner run, the owner's raw text (Orchestrate register_location's guard). */
    trigger: "owner" | "announce";
    ownerText?: string;
    /** The channel's resolved teammate (a valid one: a refused row never reaches the run). */
    resolved: Extract<TeammateResolution, { ok: true }>;
    /** Peer hops behind this run (0 = the owner started it); a message it sends is hop + 1. */
    hop: number;
  },
): Promise<TeammateTurnResult> {
  const { deps } = rt;
  const { db } = deps;
  const { threadId, ac } = o;
  const turnId = crypto.randomUUID();
  let memory: TeammateMemoryTurn | undefined; // set by `build`, read after the run
  const row = "teammate" in o.resolved ? o.resolved.teammate : undefined;
  const mark = "configMark" in o.resolved ? o.resolved.configMark : null;
  return runTurn("teammate", deps, {
    begin: {
      log,
      context: { taskId: turnId, mode: "teammate" },
      ids: { turnId, threadId, source: ctx.message.source },
      turn: {
        location: "*",
        role: "chief-of-staff",
        brief: o.text,
        teammateId: row?.id,
        hop: o.hop,
      },
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
        io: createTeammateIo(rt, ctx, threadId, turnId, ac.signal),
        artifacts: artifactCtx(rt, ctx, threadId, "chief-of-staff"), // `forward` makes the artifacts of a result in the thread's channel
      });
      const language = messageLanguage(ctx.message);
      const toolCtx = {
        port,
        language,
        threadId,
        teammateTurnId: turnId,
        inputId: o.inputId,
        run: { dispatched: 0 },
        plan: planSideEffects(rt, ctx, threadId),
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
      const role = o.resolved.role;
      const policy = policyOf(role);
      const model = role.model;
      const stored = getSession(db, threadId);
      // A session resumes only under the config it was made with (model, tools, skills, preset): else a fresh one.
      const sameKind = stored?.kind === "teammate" ? stored : null;
      const existing = sameKind && (sameKind.config_mark ?? null) === mark ? sameKind : null;
      if (sameKind && !existing)
        logEvent(log, "teammate.session_rollover", { threadId, reason: "config" });
      const turn = buildTeammateUserTurn(db, {
        agentHome: deps.config.agentHome,
        ctx,
        threadId,
        existing,
        trigger: o.trigger,
        ownerText: o.ownerText,
        body: o.text,
        snapshot: port.snapshot() ?? { items: [] },
        hasTitlePort: !!titlePortFor({ threadId, channelId: ctx.channelId }, deps.threadTitle),
      });
      memory = turn.memory;
      return {
        input: {
          turnId,
          threadId,
          text: turn.text,
          role,
          workspace: ctx.workspace,
          channel: ctx.channel,
          channelMode: ctx.channelMode,
          channelId: ctx.channelId,
          // Neutral cwd unless the role works in the channel's locations (write or shell). Read tools alone keep the
          // neutral dir: the default teammate routes and reads locations through a scout.
          locations: policy.write || policy.shell ? ctx.locations : [],
          // An owner message may start a plan (spec, plan, create_plan, approve_plan): more room than an announce run.
          ...(o.trigger === "owner" && {
            limitsOverride: {
              maxTurns: row?.maxTurns ?? TEAMMATE_OWNER_RUN_MAX_TURNS,
              budgetUsd: row?.budgetUsd ?? TEAMMATE_OWNER_RUN_BUDGET_USD,
            },
          }),
          ...("promptBlock" in o.resolved && { teammatePrompt: o.resolved.promptBlock }),
          ac,
          language,
          existing,
          team: buildTeamMd({ locations: ctx.locations }),
          appCtx: (): AppCtx => {
            // The run's own dir (made by `roleScope` before the servers are built): effect deletes and browser output live there.
            const scratchDir = realOrSame(workspacePaths(deps.config.agentHome).run(turnId));
            return {
              teammate: toolCtx,
              taskBoard: { db, threadId },
              // MessageTeammate: the sender is this run (its thread, teammate, hop and turn).
              peer: {
                deliver: (m) =>
                  rt.peerSend?.(
                    { thread: threadId, teammate: row?.name ?? null, hop: o.hop, turnId },
                    m,
                  ) ??
                  Promise.resolve({
                    ok: false,
                    code: "UNAVAILABLE",
                    message: "peer messages are off",
                  }),
              },
              artifacts: artifactCtx(rt, ctx, threadId, "chief-of-staff"), // the teammate reads and saves in its own channel
              ...(policy.scratch && { scratchDir }),
              // Effect tools ask the owner at every act (`ownerPerAct`): no goal envelope backs a teammate run.
              ...(policy.effects && {
                effects: teammateEffectsCtx({
                  db,
                  approvals: deps.approvals,
                  agentHome: deps.config.agentHome,
                  threadId,
                  turnId,
                  language,
                  scratchDir,
                  locations: locationRefs(ctx),
                  signal: ac.signal,
                }),
              }),
            };
          },
        },
        close: (res, t0) => ({
          res: {
            ...res,
            sessionKind: "teammate",
            model: res.model ?? model,
            ...(mark && { configMark: mark }),
          },
          opts: { language, stopping: deps.stopping(), t0, location: "*" },
        }),
      };
    },
  }).then((out) => {
    markTeammateMemorySent(db, threadId, memory, out);
    return out;
  });
}

/**
 * One teammate input end to end: run the teammate, post the reply, close the consumed events and start the queued
 * workers. A failed run posts a fixed notice and
 * starts nothing; a failed announce is retried once, then dropped with one notice. Never throws.
 */
export async function runTeammate(rt: TeammateRuntime, input: TeammateInput): Promise<void> {
  const { threadId } = input;
  const ctx = rt.ctxOf(threadId);
  if (!ctx) {
    logEvent(log, "teammate.no_context", { threadId, kind: input.kind }, "warn");
    // Nobody can answer: close the owner's events or the boot replay would try again at every start.
    if (input.kind === "owner")
      settleTeammateEvents(rt.deps.db, threadId, [], ownerEventIds(input.messageIds));
    return;
  }
  const { db } = rt.deps;
  let posted = false; // the owner saw something from this run
  const post = (text: string) => {
    posted = true;
    return postTo(ctx, text).catch((err: unknown) =>
      logEvent(log, "teammate.post_failed", { threadId, err: errText(err) }, "warn"),
    );
  };
  const ac = new AbortController();
  const settleActive = registerRun({ kind: "teammate", threadId, role: "chief-of-staff", ac });
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
    const resolved = resolveTeammate(db, ctx.channelId);
    if (!resolved.ok) {
      // Fail closed: a row that cannot run never falls back to the default teammate.
      logEvent(
        log,
        "teammate.refused",
        { threadId, teammate: resolved.teammate.name, reason: resolved.reason },
        "warn",
      );
      if (input.kind === "owner") {
        await post(`Teammate ${resolved.teammate.name} cannot run: ${resolved.reason}.`);
        consumed = true;
      } else stopped = true; // worker news stays pending for the fixed row: no notice, no re-arm
      return;
    }
    const inputId = crypto.randomUUID();
    const out = await teammateOnce(rt, ctx, {
      threadId,
      inputId,
      text:
        input.kind === "announce"
          ? announceBlock(batch.shown, batch.more)
          : ownerMessageBlock(input.text ?? ""),
      ac,
      trigger: input.kind,
      resolved,
      hop: Math.max(0, ...batch.shown.map(peerHopOf)),
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
    logEvent(log, "teammate.run_crashed", { threadId, err: errText(err) }, "error");
    retry = await failed(post, input, announced);
    consumed = !retry;
  } finally {
    settleActive();
    const ownerIds = input.kind === "owner" ? ownerEventIds(input.messageIds) : [];
    settleTeammateEvents(db, threadId, consumed ? announced : [], ownerIds);
    if (consumed) forgetBatch(announced);
    // Whatever the outcome, a dispatch the run committed has `ready` items nothing else would start (idempotent pass).
    if (!stopped)
      await dispatchReady(rt, threadId).catch((err: unknown) =>
        logEvent(log, "teammate.dispatch_failed", { threadId, err: errText(err) }, "error"),
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
