import { workspacePaths } from "../../config/workspace-paths";
import { messageLanguage } from "../../ingress/user-copy";
import { logEvent, logger } from "../../observability/logger";
import { goalLocations, loadEnvelope } from "../../policy/load-envelope";
import { getRole } from "../../roles/role-registry";
import { recordRunCwd } from "../../storage/effect-log-store";
import { clearQuestionLinks } from "../../storage/item-question-store";
import {
  bumpDispatch,
  getItem,
  type ItemRow,
  type ResultKind,
} from "../../storage/owned-item-store";
import { getOwnedTask } from "../../storage/owned-task-store";
import { markStartDelivered } from "../../storage/thread-event-store";
import { goalRoute } from "../budget/task-budget";
import type { LeadRuntime, LeadThreadCtx } from "../lead/lead-runtime";
import { afterVerify } from "../plan/goal-verify";
import type { RoleRunInput } from "../run/role-run-types";
import { runTurn } from "../run/run-turn";
import { expectedDelivery } from "../turns/completion";
import { type FailureVerdict, workerFailurePolicy } from "./failure-policy";
import { cancelDependents, settleGoal } from "./goal-settle";
import type { ReportSink } from "./report-sink";
import { startInput } from "./resume-prompt";
import { workerAppCtx } from "./worker-app-ctx";
import { earlierSteps, emitEndEvent } from "./worker-end-event";

/** Logger of this module. */
const log = logger.child({ module: "worker-run" });

/**
 * Start one item as a detached worker run: count the dispatch, close its `start` work order, open the turn (the owned
 * task goes `running`) and run with its MCP tools (`Report`...), no subagents, the question relay and a neutral
 * message (a worker never posts to Discord). `after` runs when the run ended: end event, goal settle, next item.
 * Takes its global run slot first: returns false (nothing touched, the item stays ready) when the cap is reached.
 */
export async function startWorker(
  rt: LeadRuntime,
  ctx: LeadThreadCtx,
  threadId: string,
  item: ItemRow,
  after: (announce?: boolean, delayMs?: number) => void,
): Promise<boolean> {
  const { db } = rt.deps;
  // The slot is taken before any row changes: a full cap defers the item, it never fails it.
  const slot = rt.deps.limiter ? rt.deps.limiter.tryAcquire() : () => {};
  if (!slot) return false;
  try {
    // The pass read the item before awaiting: a hold (age limit, stop) may have moved it since. Only `ready` starts;
    // a held or ended item is skipped (true = nothing to retry later), only Orchestrate retry can release a hold.
    const current = getItem(db, item.id);
    if (current?.status !== "ready") {
      slot();
      logEvent(log, "dispatch.skipped", { itemId: item.id, status: current?.status }, "warn");
      return true;
    }
    const goalId = item.parentId ?? item.id;
    const role = getRole(getOwnedTask(db, item.id)?.ownerAgentId ?? "");
    // A first start or a lead retry sends the brief (or the resume prompt); an automatic resume and an answer to the
    // item's own question are no new dispatch (neither can loop: the owner or the lead paced them).
    const start = startInput(db, item);
    if (!start.auto && !start.answer) bumpDispatch(db, item.id);
    clearQuestionLinks(db, item.id); // a new run: question messages of the earlier run no longer answer it
    markStartDelivered(db, item.id);
    const turnId = crypto.randomUUID();
    const location = item.location ?? "*";
    const pinned = ctx.locations.find((l) => l.name === item.location);
    runTurn("worker", rt.deps, {
      begin: {
        log,
        context: { taskId: turnId, workspace: ctx.workspace }, // log schema keys
        ids: {
          turnId,
          threadId,
          source: ctx.message.source,
          single: ctx.locations.length === 1 ? ctx.locations[0]?.name : undefined, // an unpinned task logs under the only location
        },
        turn: { location, brief: item.brief ?? "", role: role.name, hop: 1, ownedTaskId: item.id },
      },
      // Built after the turn row exists (as before): a throw here gives the slot back, the row stays.
      build: () => {
        const sink: ReportSink = {};
        const verdict: { current?: FailureVerdict } = {}; // what the failure policy did, for the end event
        const resultKind = () => sink.report?.status as ResultKind | undefined;
        // The envelope is rebuilt from the db at every start (approved plan, dispatch grants or the default): never kept only in memory.
        const language = messageLanguage(ctx.message);
        const envelope = loadEnvelope(
          db,
          goalId,
          // Only the goal's own locations: any other channel location asks the owner at every delete.
          goalLocations(
            db,
            goalId,
            item.location,
            ctx.locations.map((l) => l.name),
          ),
          workspacePaths(rt.deps.config.agentHome).workspace(ctx.workspace).task(turnId).root,
        );
        const input: RoleRunInput = {
          turnId,
          threadId,
          text: start.text,
          ...(start.resume && { resume: start.resume }), // same SDK session, same cwd as its first run
          onCwd: (cwd) => recordRunCwd(db, { turnId, threadId, goalId, itemId: item.id, cwd }),
          language,
          role: role.name,
          workspace: ctx.workspace,
          channel: ctx.channel,
          channelMode: ctx.channelMode,
          channelId: ctx.channelId,
          locations: ctx.locations,
          ac: new AbortController(), // the run's own controller: /stop aborts it, the thread is not held
          pinned,
          ledger: earlierSteps(db, item),
          route: goalRoute(db, goalId), // the run never spends past what the goal has left
          envelope,
          appCtx: workerAppCtx(rt, ctx, {
            threadId,
            goalId,
            itemId: item.id,
            turnId,
            role: role.name,
            language,
            envelope,
            sink,
            pinned,
          }),
          askRelay: role.capabilities.includes("ask")
            ? rt.relay.forWorker({ threadId, goalId, itemId: item.id, turnId })
            : undefined,
        };
        return {
          input,
          detached: {
            language,
            taskId: item.id,
            location,
            writer: role.sideEffects === "location",
            artifactScope: {
              workspace: ctx.workspace,
              ...(ctx.channel && { channel: ctx.channel }),
            },
            delivery: expectedDelivery(db, role, goalId),
            slot,
            resultKind, // the schema enum is RESULT_KINDS
            resultTitle: () => sink.report?.title,
            failurePolicy: workerFailurePolicy({
              db,
              itemId: item.id,
              turnId,
              resultKind,
              stopping: rt.deps.stopping,
              verdict,
            }),
            onSettled: (crash, ownerStopped) => {
              rt.relay.release(turnId); // a wait left by an aborted or crashed run must not outlive it
              afterVerify(db, item.id, verdict.current, ctx.locations); // fix loop, before the end event
              emitEndEvent(
                db,
                threadId,
                item.id,
                turnId,
                sink.report,
                verdict.current,
                sink.artifactIds,
                crash,
                sink.blocker,
              );
              // A held item (blocked) keeps its dependents waiting for the lead; only an item that truly failed
              // (a crash of the run itself, no retry possible) cancels them: they can never start.
              if (getItem(db, item.id)?.status === "failed") cancelDependents(db, item.id);
              settleGoal(db, goalId);
              // `/stop` ended it: the result is recorded, the lead is not woken. A blocker wakes the lead now, not after the batch window.
              after(!ownerStopped, sink.blocker ? 0 : undefined);
            },
          },
        };
      },
    });
    return true;
  } catch (err) {
    slot(); // nothing started: give the slot back
    throw err;
  }
}
